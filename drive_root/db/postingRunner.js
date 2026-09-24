'use strict';

/**
 * postingRunner — ПРОХОД ПО ОЧЕРЕДИ ПРОВЕДЕНИЯ (ТЗ «Проведение документов», §10.3).
 *
 * Один проход берёт строки очереди по одной, строго по моменту времени документа, и
 * проводит их. Единственный вызывающий — тип регламентной задачи `core.postingQueue`
 * (`apps/scheduler/scheduler.handlers.js`): исполнитель очереди сделан задачей
 * планировщика, а не вторым механизмом, и берёт у него даром форкнутый воркер,
 * служебные сессии, захват задачи (два прохода одновременно невозможны), журнал
 * прогонов, отмену и таймаут.
 *
 * ПОРЯДОК И ПРОПУСКИ. Порядок строго по `(date, seq)`. Документ, до которого ещё не
 * дошёл `nextAttemptAt`, пропускается — очередь НЕ встаёт: решение владельца, что
 * непроводящийся документ не блокирует независимые. Строка, упавшая в ЭТОМ проходе,
 * тоже исключается до конца прохода: иначе цикл вечно выбирал бы её же.
 *
 * СЛУЖЕБНАЯ СЕССИЯ НА КАЖДЫЙ ДОКУМЕНТ. Проведение идёт от имени `requestedBy` —
 * настоящей сессией (`kind='service'`), чтобы RLS применилась тем же кодом, что к
 * живому пользователю. `__SYS_INTERNAL__` внутри проведения запрещён: он открыл бы
 * доступ ко всему, а не «к тому, что видит этот человек».
 *
 * УВЕДОМЛЕНИЯ — только тогда, когда попытку вызвал ЧЕЛОВЕК (`byHuman`). Фоновые
 * проходы молчат всегда, даже если ошибка изменилась. Это и есть защита от
 * «миллиарда сообщений»: первая неудача всегда вызвана человеком (он только что
 * сохранил или нажал команду), поэтому одно сообщение он получит; повторы — тишина.
 */

const posting = require('./posting');
const postingQueue = require('./postingQueue');
const postingCascade = require('./postingCascade');

const APP_NAME = 'uniForm';
const ICONS = {
    posted: '/apps/general_icons/resources/public/16x16/ok.png',
    error: '/apps/general_icons/resources/public/16x16/error.png'
};
// Оба файла существуют в коллекции general (D:\wohnunger_icons, ICONS_CATALOG.txt).
// Ссылка на несуществующую иконку не падает, а молча рисует пустой квадрат —
// проверять наличие файла обязательно при добавлении новой.

/** Сколько документов проводим за один проход, прежде чем уступить. */
const MAX_PER_PASS = 500;

// ── Уведомления ──────────────────────────────────────────────────────────────

async function notifications() {
    try { return require('../../apps/notifications/server'); } catch (e) { return null; }
}

/**
 * Перевод для сессии. Порядок аргументов у `tfForSession` — `(key, sessionID, vars)`;
 * перепутанный порядок не падает, а молча возвращает КЛЮЧ, и в уведомлении у
 * пользователя оказывается «posting_notify_error_title» вместо текста.
 */
async function tf(key, vars, sessionID) {
    try {
        const forms = require('../../drive_forms/globalServerContext');
        const out = await forms.tfForSession(key, sessionID, vars || {});
        return (out && out !== key) ? out : key;
    } catch (e) {
        return key;
    }
}

/**
 * Обрезать текст для уведомления.
 *
 * Причина неудачи бывает длинной — ответ внешнего сервиса, текст исключения со
 * стеком. Уведомление — не место для неё: оно всплывает поверх работы и должно
 * читаться за секунду, а развёрнутое на пол-экрана оно закрывает то, ради чего
 * человек сидит за программой. Поэтому здесь — первые строки и многоточие, а
 * полный текст ждёт на форме документа, за кнопкой «Показать причину».
 *
 * @param {string} text
 * @param {number} maxLines — сколько строк оставить
 * @param {number} maxChars — потолок по длине (длинная одна строка тоже бывает)
 */
function clampLines(text, maxLines, maxChars) {
    let out = String(text == null ? '' : text);
    const lines = out.split(/\r?\n/);
    let cut = lines.length > maxLines;
    if (cut) out = lines.slice(0, maxLines).join('\n');
    if (out.length > maxChars) { out = out.slice(0, maxChars); cut = true; }
    return cut ? (out.replace(/\s+$/, '') + ' …') : out;
}

/**
 * КОПИЛКА ОТВЕТОВ ЧЕЛОВЕКУ.
 *
 * Уведомления не уходят по ходу прохода, а копятся и отправляются в конце — по
 * одному на инициатора. Причина — групповое проведение (§12.3): выделил в журнале
 * двадцать документов, нажал «Провести» — и получить двадцать сообщений вместо
 * одного «проведено 18, ошибок 2» значит не получить никакого. Один документ при
 * этом даёт ровно одно обычное сообщение: частный случай общего правила, а не
 * отдельная ветка кода.
 *
 * Пачка, не уместившаяся в один проход, даст два итога. Это честно: второй проход —
 * другое событие во времени, и склеивать их значило бы молчать неизвестно сколько.
 */
function tally() {
    const byUser = new Map();
    return {
        add(row, ok, error) {
            // Молчим всегда, когда попытку НЕ вызывал человек: фоновый проход и
            // каскад не отвечают никому (§12.2). Первая неудача всегда вызвана
            // человеком — он только что сохранил или нажал команду, — поэтому одно
            // сообщение он получит; повторы уже фоновые и молчат.
            if (!row.byHuman || !row.requestedBy) return;
            if (!byUser.has(row.requestedBy)) {
                byUser.set(row.requestedBy, { ok: 0, failed: 0, firstError: null, action: row.action });
            }
            const acc = byUser.get(row.requestedBy);
            if (ok) acc.ok++;
            else {
                acc.failed++;
                if (!acc.firstError) {
                    // Причину копим КЛЮЧОМ, а переводим при отправке: текст уходит
                    // человеку и обязан быть на его языке, а не на языке кода.
                    acc.firstError = String((error && error.message) || error || '');
                    acc.firstErrorKey = (error && error.errorKey) || null;
                    acc.firstErrorVars = (error && error.errorVars) || null;
                    // Уведомление без документа бесполезно: человек прочёл «не
                    // удалось провести» — и первое, что ему нужно, это сам
                    // документ. У групповой постановки открываем первый упавший:
                    // разбираться всё равно начинают с него.
                    acc.firstErrorDoc = { table: row.documentTable, uid: row.documentUID };
                }
            }
        },
        entries() { return Array.from(byUser.entries()); }
    };
}

/**
 * Отправить накопленные ответы.
 *
 * Правило асимметрии (§12.1): успех — ЭФЕМЕРНЫЙ и с тайм-аутом, ошибка — С ЗАПИСЬЮ
 * и без тайм-аута, до прочтения. Успехов тысячи в день; если писать их в таблицу,
 * единственное важное сообщение — об ошибке — в ней утонет. Если же и ошибку гасить
 * по таймеру, исчезнет единственный канал, которым о ней вообще сообщают.
 */
async function flushNotifications(acc, sessionID) {
    const n = await notifications();
    if (!n) return;
    const ttl = await postingQueue.setting(postingQueue.SETTINGS.successNotifyTtl, 10);

    for (const [userId, a] of acc.entries()) {
        const many = (a.ok + a.failed) > 1;
        if (a.failed === 0) {
            const key = many
                ? 'posting_notify_group_ok'
                : (a.action === posting.ACTION.UNPOST ? 'posting_notify_unposted' : 'posting_notify_posted');
            await n.notify({
                userId, appName: APP_NAME,
                title: await tf('posting_notify_title', {}, sessionID),
                text: await tf(key, { count: a.ok }, sessionID),
                icon: ICONS.posted,
                ttl, ephemeral: true
            });
            continue;
        }
        let single = a.firstError;
        if (a.firstErrorKey) {
            const translated = await tf(a.firstErrorKey, a.firstErrorVars || {}, sessionID);
            if (translated && translated !== a.firstErrorKey) single = translated;
        }
        const text = many
            ? await tf('posting_notify_group_result', { ok: a.ok, failed: a.failed }, sessionID)
            : (single || await tf('posting_notify_failed', {}, sessionID));
        await n.notify({
            userId, appName: APP_NAME,
            title: await tf('posting_notify_error_title', {}, sessionID),
            text: clampLines(text, 5, 1000),
            icon: ICONS.error,
            // Клик открывает документ. Имя функции, а не UID скрипта: UID живёт
            // один запуск процесса, а уведомление об ошибке — до прочтения.
            onClick: a.firstErrorDoc
                ? { fn: 'openDocument', fnParams: {
                        table: a.firstErrorDoc.table, uid: a.firstErrorDoc.uid } }
                : undefined
        });
    }
}

// ── Проход ───────────────────────────────────────────────────────────────────

/**
 * Выполнить проход по очереди.
 *
 * @param {object} ctx — контекст задачи планировщика: `{ sessionID, log, heartbeat, isCancelled }`
 * @returns {Promise<{posted:number, failed:number, skipped:number, cascaded:number}>}
 */
async function pass(ctx) {
    const serviceSession = require('../serviceSession');
    const stats = { posted: 0, failed: 0, cascaded: 0, seen: 0 };
    const failedThisPass = [];
    const acc = tally();
    let lastSessionID = (ctx && ctx.sessionID) || null;

    for (let i = 0; i < MAX_PER_PASS; i++) {
        if (ctx && typeof ctx.isCancelled === 'function' && ctx.isCancelled()) break;

        const row = await postingQueue.next(failedThisPass);
        if (!row) break;
        stats.seen++;

        // Служебная сессия инициатора. Нет инициатора (строка приехала из каскада
        // без автора) — работаем сессией самой задачи: её владелец и есть тот, от
        // чьего имени идёт фоновая работа.
        let sessionID = (ctx && ctx.sessionID) || null;
        let ownSession = null;
        if (row.requestedBy) {
            try {
                ownSession = await serviceSession.create({
                    userId: row.requestedBy,
                    scopeOrganizationId: row.organizationId || null
                });
                sessionID = ownSession;
            } catch (e) {
                console.error(`[postingRunner] Служебная сессия не создана: ${e.message}`);
            }
        }

        // «Взята в работу»: форма покажет «проводится» вместо «в очереди».
        // Отметка идёт ДО транзакции проведения: иначе она была бы невидима
        // ровно в те секунды, ради которых заведена.
        try { await postingQueue.markStarted(row.UID, true); } catch (e) { /* не критично */ }
        notifyTable(row.documentTable, row.documentUID);

        try {
            const result = await posting.runOne({
                table: row.documentTable,
                uid: row.documentUID,
                action: row.action,
                sessionID,
                requestedBy: row.requestedBy || null,
                thenMark: !!row.thenMark
            });

            // Документа больше нет — строку снимаем молча: его могли удалить, пока
            // он ждал очереди, и это не ошибка проведения.
            await postingQueue.remove(row.UID);

            if (!result.gone) {
                stats.posted++;
                notifyTable(row.documentTable, row.documentUID);
                acc.add(row, true, null);

                const casc = await postingCascade.run({
                    result, requestedBy: row.requestedBy || null, sessionID
                });
                stats.cascaded += casc.queued.length;
            }
        } catch (e) {
            stats.failed++;
            failedThisPass.push(row.UID);
            // Отпускаем строку: следующий проход снова покажет «в очереди», а не
            // «проводится вечно».
            try { await postingQueue.markStarted(row.UID, false); } catch (e2) { /* не критично */ }
            const info = await postingQueue.fail(row, e);

            // Состояние пишется ТОЛЬКО на переходе: первая неудача ставит `error`
            // один раз, дальше документ не трогается вообще. Именно это делает
            // бесконечные повторы безвредными для замка и для журнала изменений.
            try {
                const cur = await currentState(row.documentTable, row.documentUID);
                if (cur !== posting.STATE.ERROR) {
                    await posting.setState({
                        table: row.documentTable, uid: row.documentUID,
                        state: posting.STATE.ERROR, sessionID
                    });
                    notifyTable(row.documentTable, row.documentUID);
                }
            } catch (e2) {
                console.error(`[postingRunner] Состояние "ошибка" не записано: ${e2.message}`);
            }

            acc.add(row, false, e);
            if (ctx && typeof ctx.log === 'function') {
                ctx.log(`${row.documentTable}[${row.documentUID}]: ${e.message}`
                    + (info.delayed ? ` — следующая попытка через ${info.delayMin} мин.` : ''));
            }
        } finally {
            if (ownSession) {
                try { await serviceSession.destroy(ownSession); } catch (e) { /* уже нет */ }
            }
        }

        if (ctx && typeof ctx.heartbeat === 'function') ctx.heartbeat();
    }

    // Ответы человеку — одним махом в конце прохода (см. tally).
    try {
        await flushNotifications(acc, lastSessionID);
    } catch (e) {
        console.error('[postingRunner] Уведомления не отправлены:', e && e.message || e);
    }

    return stats;
}

async function currentState(table, uid) {
    const dbGateway = require('../dbGateway');
    const rows = await dbGateway.execute({
        operation: 'read', table, where: { UID: uid },
        options: { raw: true, limit: 1, attributes: ['UID', posting.STATE_FIELD] },
        context: { sessionID: '__SYS_INTERNAL__' }
    });
    return rows && rows[0] ? rows[0][posting.STATE_FIELD] : null;
}

/** Открытые журналы должны увидеть смену состояния без перезагрузки страницы. */
function notifyTable(table, uid) {
    try {
        require('../../apps/uniForm/server.js').notifyTableChange(table, 'update', uid);
    } catch (e) { /* оповещение необязательно */ }
}

module.exports = { pass, MAX_PER_PASS };
