'use strict';

/**
 * alertsRunner — СУТОЧНЫЙ ПРОХОД ПО ОПОВЕЩЕНИЯМ (ТЗ «Оповещения по документам», §6, §14).
 *
 * ── Зачем нужен второй повод пересчёта ───────────────────────────────────────
 * Правило «гость уехал, а счёта нет» зависит от СЕГОДНЯШНЕЙ ДАТЫ, а не от
 * данных: вчера оповещения не было, сегодня есть, хотя в базе за ночь ничего не
 * менялось. Время событием в базе не является, и заметить его больше нечем —
 * поэтому такие правила объявляют `timeDependent: true`, а здесь живёт проход,
 * который их пересчитывает.
 *
 * Гонять по времени ВСЕ правила подряд — лишняя работа и лишняя нагрузка; не
 * гонять вовсе — значит никогда не заметить забытый счёт. Отсюда разделение: по
 * времени идут только объявленные правила и только по тем документам, которые
 * правило само и отбирает (`select`): кто попадает под правило, знает только
 * оно — «гость выехал» отбирается по дате выезда, которой ядро не знает.
 *
 * ── Сводка ───────────────────────────────────────────────────────────────────
 * Второе дело прохода — одна сводка в сутки, и у неё два условия: есть
 * актуальные оповещения уровня `warning` и выше И обработку «Проверка
 * документов» давно не открывали. Второе условие важнее, чем кажется: если
 * человек зашёл и всё посмотрел, напоминать не о чем, даже если он ничего не
 * исправил — он уже знает.
 *
 * Два правила текста: НЕ ПУГАТЬ и НАЗЫВАТЬ ЧИСЛО. «Ошибки» — слишком сильно:
 * счёт, который забыли выставить, не ошибка, а забытое дело. Число отличает
 * «загляни когда-нибудь» от «накопилось».
 *
 * Проход выполняется ЗАДАЧЕЙ ПЛАНИРОВЩИКА (`core.documentAlerts`), то есть в
 * форкнутом воркере и под служебной сессией владельца задания: RLS применяется
 * тем же кодом, что к живому пользователю, и `__SYS_INTERNAL__` внутри правил
 * запрещён.
 */

const documentAlerts = require('./documentAlerts');
const alertRules = require('./alertRules');

/** Приложение-обработка и её форма — адрес, по которому зовёт сводка. */
const CHECK_APP = 'documentCheck';
const CHECK_FORM = 'documentCheck';

/** Ключ служебной настройки «когда последний раз смотрели». */
const STATE_APP = 'documentCheck';
const STATE_LAST_OPENED = 'lastOpenedAt';

/** Настройка порога «давно не открывали», в часах. */
const SETTING_IDLE_HOURS = 'alertSummaryIdleHours';

/**
 * Отметить, что человек открыл обработку.
 *
 * Пишет СЕРВЕР, из метода формы, а не клиент: от этой отметки зависит, уйдёт ли
 * сводка, а значит присланному с клиента значению здесь верить нельзя (общее
 * правило служебных настроек: в них не кладут ничего, от чего что-то зависит).
 *
 * @param {string} userId
 */
async function markChecked(userId) {
    if (!userId) return;
    try {
        await require('../settings/state').set(userId, STATE_APP, STATE_LAST_OPENED, new Date().toISOString());
    } catch (e) {
        console.error('[alertsRunner] отметка об открытии обработки не записана:', e && e.message || e);
    }
}

/** Когда этот человек последний раз открывал обработку (или `null`). */
async function lastChecked(userId) {
    if (!userId) return null;
    try {
        const v = await require('../settings/state').get(userId, STATE_APP, STATE_LAST_OPENED);
        if (!v) return null;
        const d = new Date(v);
        return isNaN(d.getTime()) ? null : d;
    } catch (e) {
        return null;
    }
}

async function idleHours() {
    try {
        const v = await require('../settings').getSystemSetting('core', SETTING_IDLE_HOURS);
        const n = Number(v);
        return isFinite(n) && n > 0 ? n : 24;
    } catch (e) {
        return 24;
    }
}

/**
 * Пересчитать правила, зависящие от времени.
 *
 * ── ФОНОВЫЙ ПРОХОД МОЛЧИТ (найдено живым прогоном 02.10.2026) ────────────────
 * Отдельных уведомлений этот проход НЕ шлёт — он говорит ОДНОЙ сводкой. Первый
 * же запуск на живых данных показал, почему: правило «гость выехал, а счёта
 * нет» нашло 37 броней за год, и владелец получил бы 37 всплывающих окон
 * подряд плюс сводку. Это ровно та «свалка», ради которой у проведения стоит
 * правило «фоновые проходы молчат всегда», — и здесь оно действует по той же
 * причине, хотя ТЗ §12 буквально называет адресатом владельца задания.
 *
 * Отметка `pushSentAt` при этом НЕ ставится, и это важно: оповещение остаётся
 * «несказанным», и первый же пересчёт, вызванный ЧЕЛОВЕКОМ (он сохранил эту
 * бронь), отправит сообщение ему — то есть тому, кто в этот момент и правда
 * работает с документом.
 *
 * @param {object} ctx — контекст задачи планировщика `{ sessionID, userId, log, heartbeat, isCancelled }`
 * @returns {Promise<{rules: number, documents: number, pending: number}>}
 */
async function timePass(ctx) {
    const rules = alertRules.timeDependent();
    const stats = { rules: rules.length, documents: 0, pending: 0 };
    if (!rules.length) return stats;

    const touched = new Set();
    for (const rule of rules) {
        if (ctx && typeof ctx.isCancelled === 'function' && ctx.isCancelled()) break;

        let targets = [];
        try {
            targets = await rule.select({
                rule,
                sessionID: ctx && ctx.sessionID,
                requestedBy: (ctx && ctx.userId) || null
            }) || [];
        } catch (e) {
            console.error(`[alertsRunner] правило "${rule.code}": отбор документов не выполнен: ${e && e.message || e}`);
            continue;
        }

        for (const t of targets) {
            if (ctx && typeof ctx.isCancelled === 'function' && ctx.isCancelled()) break;
            const table = (t && t.table) || rule.table;
            const uid = (t && t.uid) || (typeof t === 'string' ? t : null);
            if (!table || !uid) continue;
            try {
                const res = await documentAlerts.rebuild({
                    table, uid,
                    ruleCodes: [rule.code],
                    sessionID: ctx && ctx.sessionID,
                    requestedBy: (ctx && ctx.userId) || null
                });
                stats.documents++;
                stats.pending += (res.pushes || []).length;
                touched.add(table);
            } catch (e) {
                console.error(`[alertsRunner] ${table}[${uid}] (${rule.code}): ${e && e.message || e}`);
            }
            if (ctx && typeof ctx.heartbeat === 'function') ctx.heartbeat();
        }
    }

    if (touched.size) notifyAlerts();
    return stats;
}

/** Тег замены сводки: новая сводка встаёт на место непрочитанной прежней. */
const SUMMARY_TAG = 'core.documentAlerts.summary';

/**
 * КОМУ ИДЁТ СВОДКА (решение владельца 15.10.2026).
 *
 * Не владельцу задания: задачу заводит администратор, а «счёт не выставлен» —
 * забота тех, кто работает с бронями. Поэтому адресаты — все действующие
 * пользователи, КРОМЕ администраторов; кто из них что видит, решает тот же RLS,
 * что и везде: число считается под служебной сессией КАЖДОГО адресата, и
 * человек получает сводку только о своих документах (или не получает вовсе).
 *
 * Список людей читается под сессией владельца задания — его область задачи.
 */
async function recipients(ctx) {
    const rows = await require('../dbGateway').execute({
        operation: 'read', table: 'users',
        where: { isGuest: false, disabled: false },
        options: { raw: true },
        context: { sessionID: ctx && ctx.sessionID }
    }) || [];
    const { getUserAccessRole } = require('../../drive_forms/globalServerContext');
    const out = [];
    for (const u of rows) {
        let role = null;
        try { role = await getUserAccessRole(u); } catch (e) { role = null; }
        if (!role || role === 'admin') continue;
        out.push(u);
    }
    return out;
}

/** Сколько важных оповещений видит этот человек — под его собственной сессией. */
async function countFor(userId) {
    const serviceSession = require('../serviceSession');
    const sid = await serviceSession.create({ userId, ttlSec: 600 });
    try {
        return await documentAlerts.countImportant({ sessionID: sid });
    } finally {
        await serviceSession.destroy(sid);
    }
}

/**
 * Отправить суточные сводки тем, кому они нужны.
 *
 * Сводка у человека ОДНА: новая заменяет прежнюю (тег замены уведомлений), иначе
 * они копятся стопкой, пока обработку не открыли, — а «37» рядом с «39» читается
 * как два разных дела.
 *
 * @returns {Promise<{sent: number, count: number, reason?: string}>}
 */
async function summary(ctx) {
    const people = await recipients(ctx);
    if (!people.length) return { sent: 0, count: 0, reason: 'адресатов нет' };

    let notifications = null;
    try { notifications = require('../../apps/notifications/server'); } catch (e) { return { sent: 0, count: 0 }; }
    const { tfForUser } = require('../../drive_forms/globalServerContext');
    const hours = await idleHours();

    let sent = 0, total = 0;
    for (const u of people) {
        let count = 0;
        try { count = await countFor(u.UID); } catch (e) {
            console.error(`[alertsRunner] сводка для ${u.UID} не посчитана: ${e && e.message || e}`);
            continue;
        }
        total += count;
        if (!count) continue;

        const last = await lastChecked(u.UID);
        if (last && (Date.now() - last.getTime()) < hours * 3600 * 1000) continue;

        let text = 'alert_summary_text';
        let title = 'alert_summary_title';
        try { text = await tfForUser('alert_summary_text', u.UID, { count }); } catch (e) { /* ключ виден */ }
        try { title = await tfForUser('alert_summary_title', u.UID, {}); } catch (e) { /* ключ виден */ }

        await notifications.notify({
            userId: u.UID,
            appName: 'uniForm',
            title,
            text,
            icon: documentAlerts.ICONS.warning,
            // Сводка ведёт в обработку: «3 документа требуют внимания» без способа
            // их увидеть — сообщение, после которого надо ещё догадаться, куда идти.
            onClick: {
                fn: 'runAlertAction',
                fnParams: { kind: documentAlerts.ACTION.OPEN_FORM, app: CHECK_APP, params: { form: CHECK_FORM } }
            },
            // Висит до прочтения, но не копится: следующая сводка встаёт на её место.
            ttl: 0,
            ephemeral: false,
            tag: SUMMARY_TAG
        });
        sent++;
    }
    return { sent, count: total, reason: sent ? undefined : (total ? 'обработку смотрели недавно' : 'оповещений нет') };
}

/** Открытые журналы и формы должны увидеть пересчитанные оповещения. */
function notifyAlerts() {
    try {
        require('../../apps/uniForm/server.js').notifyTableChange(documentAlerts.TABLE, 'update', null);
    } catch (e) { /* оповещение необязательно */ }
}

/** Один проход задачи: правила по времени + сводка. */
async function pass(ctx) {
    const stats = await timePass(ctx);
    let sum = { sent: 0, count: 0 };
    try {
        sum = await summary(ctx);
    } catch (e) {
        console.error('[alertsRunner] сводка не отправлена:', e && e.message || e);
    }
    return { stats, summary: sum };
}

module.exports = {
    CHECK_APP, CHECK_FORM,
    STATE_APP, STATE_LAST_OPENED, SETTING_IDLE_HOURS,
    markChecked, lastChecked, idleHours,
    timePass, summary, pass, notifyAlerts
};
