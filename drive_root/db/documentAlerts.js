'use strict';

/**
 * documentAlerts — ОПОВЕЩЕНИЯ ПО ДОКУМЕНТАМ (ТЗ `tmp/ТЗ_ОПОВЕЩЕНИЯ_ПО_ДОКУМЕНТАМ.md`).
 *
 * ── Зачем ────────────────────────────────────────────────────────────────────
 * Программа регулярно знает про документ что-то важное, а сказать это некому и
 * негде: «выставлено больше, чем заказано» (нужна корректировка), «гость уехал,
 * а счёта нет» (потеря денег), «цена не найдена» (показалось один раз при
 * заполнении и исчезло вместе с окном). Механизм даёт этому одно место:
 * документ несёт свои оповещения, они видны там, где человек и так смотрит, у
 * каждого есть действие в один клик, и они ИСЧЕЗАЮТ САМИ, когда причина
 * устранена.
 *
 * ── Главное решение, из которого следует всё остальное ───────────────────────
 * **Оповещение — это ДВИЖЕНИЕ документа, адресованное человеку.** Оно помечено
 * регистратором (`documentTable` + `documentUID`), старые строки снимает ЯДРО, а
 * приложение пишет только «сформировать». Ровно как с движениями регистров — и
 * ровно поэтому актуальность получается ПО ПОСТРОЕНИЮ: состояния, в котором
 * движения новые, а оповещения старые, не существует, потому что и то и другое
 * пишется в одной транзакции.
 *
 * ── Область переписывания — ПРАВИЛО, а не документ ───────────────────────────
 * Переписываются строки ЭТОГО правила по ЭТОМУ документу. Иначе заполнение счёта
 * затёрло бы то, что записало проведение, — два механизма, пишущих про один
 * документ, молча отменяли бы друг друга.
 *
 * ── Сопоставление при перезаписи — ПО ПОРЯДКУ (§7) ───────────────────────────
 * В пределах (документ + правило): первые `min(старых, новых)` перезаписываются
 * НА МЕСТЕ, лишние старые удаляются, недостающие создаются. Ключа позиции здесь
 * нет намеренно: у правила «счёт не создан» позиции не существует вовсе.
 * Перезапись на месте сохраняет `pushSentAt` — отсюда правильное поведение
 * пушей без единой дополнительной проверки:
 *
 *   [A] → [A]        A перезаписана            пуш повторно НЕ шлётся
 *   [A] → [A, B]     A перезаписана, B создана пуш уходит по B
 *   [A, B] → [B]     B перезаписана поверх A   не шлётся: про B уже говорили
 *   [A] → [] → [A]   удалена, создана заново   уходит: причина вернулась
 *
 * Отсюда требование к правилу: порядок строк обязан быть ДЕТЕРМИНИРОВАННЫМ,
 * иначе перезапись будет тасовать тексты и отметки об отправке случайно.
 *
 * ── Язык: ключ, а не готовый текст ───────────────────────────────────────────
 * ТЗ §4 разрешает выбрать при реализации, и выбран КЛЮЧ + подстановки. Причина:
 * оповещение адресовано человеку, а один документ читают несколько людей с
 * разными языками. Готовая строка означала бы, что язык оповещения принадлежит
 * тому, кто последним вызвал пересчёт, — это та же ошибка, что уже была поймана
 * на уведомлениях очереди проведения (русскоязычный пользователь получал текст
 * на языке владельца задания). Перевод делается в момент ПОКАЗА, на языке
 * читателя; пуш — на языке получателя.
 *
 * ── Запись и чтение идут разными сессиями, и это важно ───────────────────────
 * ПИШЕТ механизм — системной сессией (`__SYS_INTERNAL__`): это его собственная
 * служебная таблица, как `posting_queue` и `notifications`, и оповещение
 * адресовано не тому, кто вызвал пересчёт. ЧИТАЕТ человек — своей сессией, то
 * есть под обычными RLS: чужих оповещений он не увидит тем же кодом, каким не
 * видит чужих документов.
 */

const alertRules = require('./alertRules');
const deletionMark = require('./deletionMark');
const emptyValues = require('./emptyValues');

const TABLE = 'document_alerts';
const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';

/** Важность — ПЕРЕЧИСЛЕНИЕ ЯДРА (§9): от неё зависят цвет, порядок и пуш. */
const SEVERITY = { INFO: 'info', WARNING: 'warning', ERROR: 'error' };

/** Порядок важности. Сортировка оповещений — от самого важного. */
const RANK = { info: 1, warning: 2, error: 3 };

/** Цвет — ИМЯ ПАЛИТРЫ ядра (как `rowTones`), а не код цвета. */
const TONES = { info: 'blue', warning: 'yellow', error: 'red' };

/**
 * Значки уровней. Один и тот же разноцветный восклицательный знак — и в строке
 * оповещения, и на кнопке свёртывания панели, и в колонке журнала: человек
 * запоминает ОДИН значок, а не три разных для одного смысла.
 * Файлы существуют в коллекции general (D:\wohnunger_icons, ICONS_CATALOG.txt) —
 * ссылка на несуществующую иконку не падает, а молча рисует пустой квадрат.
 */
const ICONS = {
    info:    '/apps/general_icons/resources/public/16x16/alert_info.png',
    warning: '/apps/general_icons/resources/public/16x16/alert_warning.png',
    error:   '/apps/general_icons/resources/public/16x16/alert_error.png',
    none:    '/apps/general_icons/resources/public/16x16/alert_none.png'
};

/** Виды действия-гиперссылки (§8). */
const ACTION = {
    OPEN_RECORD: 'openRecord',   // открыть существующий документ
    OPEN_NEW:    'openNew',      // открыть НЕСОХРАНЁННУЮ форму с предзаполнением
    OPEN_FORM:   'openForm',     // открыть именованную форму приложения
    CALL:        'call'          // вызвать метод приложения (переспрос обязателен)
};

/** Пуш по умолчанию — от важности (§9): info молчит, остальные говорят. */
function pushByDefault(severity) {
    return severity === SEVERITY.ERROR || severity === SEVERITY.WARNING;
}

function severityRank(s) {
    return RANK[s] || 0;
}

/** Самая важная важность в наборе строк (или `null`). */
function topSeverity(rows) {
    let top = null;
    for (const r of (rows || [])) {
        const s = r && r.severity;
        if (!s) continue;
        if (!top || severityRank(s) > severityRank(top)) top = s;
    }
    return top;
}

/** Значок по важности; `null` — нейтральный (оповещений нет). */
function iconFor(severity) {
    return ICONS[severity] || ICONS.none;
}

// ── Чтение ───────────────────────────────────────────────────────────────────

function gateway() {
    return require('../dbGateway');
}

/** Строки как они лежат в базе. Сессия решает, что видно (RLS). */
async function rowsOf(p) {
    const where = { documentTable: p.table, documentUID: p.uid };
    if (p.ruleCode) where.ruleCode = p.ruleCode;
    const rows = await gateway().execute({
        operation: 'read',
        table: TABLE,
        where,
        options: Object.assign({ raw: true, order: [['ruleCode', 'ASC'], ['sortOrder', 'ASC']] },
            p.transaction ? { transaction: p.transaction } : {}),
        context: Object.assign({ sessionID: p.sessionID || SYSTEM_SESSION_ID },
            p.transaction ? { transaction: p.transaction } : {})
    });
    return rows || [];
}

/**
 * Перевести строку для ЧИТАТЕЛЯ и собрать её действие.
 *
 * @param {object} row
 * @param {string} sessionID — чья сессия смотрит (её язык и берём)
 */
async function renderRow(row, sessionID) {
    const { tfForSession, tForSession } = require('../../drive_forms/globalServerContext');
    let text = row.textKey;
    try {
        const vars = await translateVars(parseJson(row.textVars),
            (key) => tForSession(key, sessionID));
        const t = await tfForSession(row.textKey, sessionID, vars);
        if (t) text = t;
    } catch (e) { /* нет перевода — покажем ключ, это видно и чинится */ }

    let caption = null;
    if (row.actionCaption) {
        try { caption = await tfForSession(row.actionCaption, sessionID); }
        catch (e) { caption = row.actionCaption; }
    }

    return {
        UID: row.UID,
        documentTable: row.documentTable,
        documentUID: row.documentUID,
        ruleCode: row.ruleCode,
        severity: row.severity,
        tone: TONES[row.severity] || null,
        icon: iconFor(row.severity),
        sortOrder: row.sortOrder,
        text,
        action: row.actionKind ? {
            kind: row.actionKind,
            app: row.actionApp || null,
            params: parseJson(row.actionParams) || {},
            caption: caption || null
        } : null
    };
}

/**
 * ПОДСТАНОВКИ, КОТОРЫЕ САМИ ЯВЛЯЮТСЯ ПЕРЕВОДОМ.
 *
 * Правило вправе подставить в текст не только данные, но и СЛОВО интерфейса:
 * предупреждение расчёта счёта говорит, ГДЕ лежит правило («у услуги не
 * заполнено "Формула количества"»), и названия справочника и реквизита берёт из
 * тех же ключей, что и сам экран, — иначе подсказка однажды начнёт называть поле
 * не так, как оно подписано.
 *
 * Положить в подстановку уже переведённое слово нельзя: оповещение переводится в
 * момент ПОКАЗА, на языке читателя, а слово осталось бы на языке того, кто вызвал
 * пересчёт — текст вышел бы двуязычным. Поэтому значение вида `{ i18n: ключ }`
 * переводится здесь же, тем же языком, что и сама строка.
 *
 * @param {object|null} vars
 * @param {Function} translate — `(ключ) => Promise<строка>`
 */
async function translateVars(vars, translate) {
    if (!vars || typeof vars !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(vars)) {
        if (v && typeof v === 'object' && v.i18n) {
            try { out[k] = await translate(v.i18n); }
            catch (e) { out[k] = v.i18n; }
            continue;
        }
        out[k] = v;
    }
    return out;
}

function parseJson(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(String(v)); } catch (e) { return null; }
}

/** Сравнение для показа: сначала важные, потом по правилу и порядку. */
function compareForDisplay(a, b) {
    const d = severityRank(b.severity) - severityRank(a.severity);
    if (d) return d;
    const r = String(a.ruleCode).localeCompare(String(b.ruleCode));
    if (r) return r;
    return (a.sortOrder || 0) - (b.sortOrder || 0);
}

/**
 * Оповещения ОДНОГО документа, готовые к показу (панель формы, §10).
 * @returns {Promise<Array<object>>}
 */
async function forDocument(p) {
    const rows = await rowsOf(p);
    const out = [];
    for (const r of rows) out.push(await renderRow(r, p.sessionID));
    out.sort(compareForDisplay);
    return out;
}

/**
 * Оповещения СТРАНИЦЫ строк журнала — ОДНИМ запросом (§11).
 *
 * Запрос на строку здесь недопустим: журнал открывает сотню строк, и сотня
 * запросов — это не «медленнее», а другой порядок времени открытия окна (та же
 * причина, по которой вычисляемые реквизиты журнала считаются пачкой).
 *
 * @returns {Promise<Object<string, {severity: string, texts: string[]}>>}
 */
async function forDocuments(p) {
    const uids = [...new Set((p.uids || []).filter(Boolean))];
    const out = {};
    if (!uids.length) return out;

    const rows = await gateway().execute({
        operation: 'read',
        table: TABLE,
        where: { documentTable: p.table, documentUID: uids },
        options: { raw: true },
        context: { sessionID: p.sessionID || SYSTEM_SESSION_ID }
    }) || [];

    for (const r of rows) {
        const acc = out[r.documentUID] || (out[r.documentUID] = { severity: null, texts: [] });
        if (!acc.severity || severityRank(r.severity) > severityRank(acc.severity)) acc.severity = r.severity;
        acc.texts.push(await renderThen(r, p.sessionID));
    }
    return out;
}

async function renderThen(row, sessionID) {
    const r = await renderRow(row, sessionID);
    return r.text;
}

/**
 * Все актуальные оповещения, видимые этой сессии (обработка «Проверка
 * документов», §13). Отбор — по уровню и виду документа; порядок — по важности,
 * затем по дате документа, которую подставляет сама обработка.
 */
async function listVisible(p) {
    const where = {};
    if (p && p.severity) where.severity = p.severity;
    if (p && p.documentTable) where.documentTable = p.documentTable;
    const rows = await gateway().execute({
        operation: 'read',
        table: TABLE,
        where,
        options: { raw: true, limit: (p && p.limit) || 500 },
        context: { sessionID: p.sessionID }
    }) || [];
    const out = [];
    for (const r of rows) out.push(await renderRow(r, p.sessionID));
    out.sort(compareForDisplay);
    return out;
}

/** Сколько видимых оповещений уровня `warning` и выше (сводка, §14). */
async function countImportant(p) {
    const rows = await gateway().execute({
        operation: 'read',
        table: TABLE,
        where: { severity: [SEVERITY.WARNING, SEVERITY.ERROR] },
        options: { raw: true, attributes: ['UID'] },
        context: { sessionID: p.sessionID }
    }) || [];
    return rows.length;
}

// ── Пересчёт ─────────────────────────────────────────────────────────────────

/**
 * Нормализовать то, что вернуло правило, в строку таблицы.
 *
 * Правило возвращает понятия («текст», «действие», «нужен ли пуш»), а не поля
 * таблицы: иначе каждое приложение знало бы её схему, и переименование колонки
 * стало бы правкой во всех приложениях.
 */
function normalize(item, rule, doc, index) {
    const action = item.action || null;
    const row = {
        documentTable: rule.table,
        documentUID: doc.UID,
        organizationId: doc.organizationId || null,
        ruleCode: rule.code,
        severity: rule.severity,
        sortOrder: index + 1,
        textKey: item.text || item.textKey || null,
        textVars: item.vars || item.textVars || null,
        actionApp: action ? (action.app || rule.appName || null) : null,
        actionKind: action ? action.kind : null,
        actionParams: action ? (action.params || {}) : null,
        actionCaption: action ? (action.caption || null) : null,
        pushWanted: (item.push === undefined || item.push === null)
            ? pushByDefault(rule.severity) : !!item.push
    };
    if (!row.textKey) {
        throw new Error(`[documentAlerts] правило "${rule.code}": у оповещения нет текста (ключа перевода)`);
    }
    if (row.actionKind && !Object.values(ACTION).includes(row.actionKind)) {
        throw new Error(`[documentAlerts] правило "${rule.code}": неизвестный вид действия "${row.actionKind}"`);
    }
    return row;
}

/** Поля, которые перезапись переносит в существующую строку. `pushSentAt` — НЕТ. */
const REWRITABLE = ['organizationId', 'severity', 'sortOrder', 'textKey', 'textVars',
    'actionApp', 'actionKind', 'actionParams', 'actionCaption', 'pushWanted'];

/**
 * Записать строки ОДНОГО правила по одному документу, сопоставив по порядку (§7).
 *
 * @returns {Promise<{created: Array, kept: Array, removed: number}>}
 */
async function writeRuleRows(p) {
    const dbGateway = gateway();
    const ctx = Object.assign({ sessionID: SYSTEM_SESSION_ID },
        p.transaction ? { transaction: p.transaction } : {});
    const options = p.transaction ? { transaction: p.transaction } : {};

    const existing = (await dbGateway.execute({
        operation: 'read', table: TABLE,
        where: { documentTable: p.table, documentUID: p.uid, ruleCode: p.ruleCode },
        options: Object.assign({ raw: true, order: [['sortOrder', 'ASC']] }, options),
        context: ctx
    })) || [];

    const created = [];
    const kept = [];
    const gone = [];          // удалённые строки, о которых уже ушёл пуш
    let removed = 0;
    const n = Math.max(existing.length, p.rows.length);

    for (let i = 0; i < n; i++) {
        const next = p.rows[i];
        const prev = existing[i];

        if (next && prev) {
            const data = {};
            for (const f of REWRITABLE) data[f] = next[f];
            await dbGateway.execute({
                operation: 'update', table: TABLE, where: { UID: prev.UID },
                data, options, context: ctx
            });
            // Отметка об отправке осталась в строке — значит про это уже говорили.
            kept.push(Object.assign({}, prev, data));
            continue;
        }
        if (next) {
            const row = await dbGateway.execute({
                operation: 'create', table: TABLE, data: next, options, context: ctx
            });
            const plain = (row && row.get) ? row.get({ plain: true }) : row;
            created.push(plain);
            continue;
        }
        // Лишняя старая строка: причина устранена — оповещение УДАЛЯЕТСЯ физически,
        // а не помечается. Помеченные через год стали бы самой большой таблицей
        // в базе при нулевой пользе (решение ТЗ §2).
        await dbGateway.execute({
            operation: 'delete', table: TABLE, where: { UID: prev.UID },
            options, context: ctx
        });
        removed++;
        if (!emptyValues.isEmptyDate(prev.pushSentAt)) gone.push(prev.UID);
    }

    retractPushes(gone, p.transaction);
    return { created, kept, removed };
}

/** Тег уведомления, отправленного по строке оповещения. */
function pushTag(alertUID) {
    return 'documentAlert:' + alertUID;
}

/**
 * Снять уведомления по исчезнувшим оповещениям — ПОСЛЕ коммита, по тому же
 * правилу, что и отправка: откатившееся удаление не должно уносить уведомление
 * о том, что осталось правдой.
 */
function retractPushes(alertUIDs, transaction) {
    if (!alertUIDs || !alertUIDs.length) return;
    const run = async () => {
        let notifications = null;
        try { notifications = require('../../apps/notifications/server'); } catch (e) { return; }
        if (!notifications || typeof notifications.removeByTag !== 'function') return;
        for (const uid of alertUIDs) {
            try { await notifications.removeByTag(pushTag(uid)); }
            catch (e) { console.error('[documentAlerts] уведомление не снято:', e && e.message || e); }
        }
    };
    if (transaction && typeof transaction.afterCommit === 'function') transaction.afterCommit(() => { run(); });
    else run();
}

/**
 * Снять оповещения документа — все или одного правила.
 *
 * Зовётся, когда документа больше нет и когда он помечен на удаление: у
 * приговорённого объекта оповещения показывать незачем (приёмка §17.14).
 */
async function clear(p) {
    const where = { documentTable: p.table, documentUID: p.uid };
    if (p.ruleCode) where.ruleCode = p.ruleCode;
    const options = p.transaction ? { transaction: p.transaction } : {};
    const ctx = Object.assign({ sessionID: SYSTEM_SESSION_ID },
        p.transaction ? { transaction: p.transaction } : {});
    let sent = [];
    try {
        const rows = (await gateway().execute({
            operation: 'read', table: TABLE, where,
            options: Object.assign({ raw: true, attributes: ['UID', 'pushSentAt'] }, options),
            context: ctx
        })) || [];
        sent = rows.filter(r => !emptyValues.isEmptyDate(r.pushSentAt)).map(r => r.UID);
    } catch (e) { sent = []; }
    await gateway().execute({
        operation: 'delete', table: TABLE, where, options, context: ctx
    });
    retractPushes(sent, p.transaction);
}

/**
 * ПЕРЕСЧИТАТЬ правила документа и переписать их оповещения.
 *
 * Единственная точка записи оповещений во всей системе. Приложение зовёт её
 * только чтобы сказать «пересчитай» — никогда чтобы удалить.
 *
 * @param {object} p
 * @param {string} p.table            — документная таблица
 * @param {string} p.uid              — документ
 * @param {string[]} [p.ruleCodes]    — какие правила; не заданы — все правила
 *                                      таблицы с `onMovements`
 * @param {object} [p.input]          — данные инициатора пересчёта (например,
 *                                      список пропущенных услуг от заполнения счёта)
 * @param {string} p.sessionID        — под какой сессией правило читает данные
 * @param {object} [p.transaction]    — транзакция, если пересчёт идёт внутри неё
 * @param {string} [p.requestedBy]    — кому адресовать пуши
 * @returns {Promise<{pushes: Array, created: number, removed: number}>}
 */
async function rebuild(p) {
    const rules = p.ruleCodes
        ? p.ruleCodes.map(c => alertRules.get(c)).filter(Boolean)
        : alertRules.forTable(p.table, { onMovements: true });
    if (!rules.length) return { pushes: [], created: 0, removed: 0 };

    const dbGateway = gateway();
    const readCtx = Object.assign({ sessionID: p.sessionID || SYSTEM_SESSION_ID },
        p.transaction ? { transaction: p.transaction } : {});
    const docRows = await dbGateway.execute({
        operation: 'read', table: p.table, where: { UID: p.uid },
        options: Object.assign({ raw: true, limit: 1 }, p.transaction ? { transaction: p.transaction } : {}),
        context: readCtx
    });
    const doc = docRows && docRows[0];

    // Документа нет — говорить о нём больше нечего и некому.
    if (!doc) {
        await clear({ table: p.table, uid: p.uid, transaction: p.transaction });
        return { pushes: [], created: 0, removed: 0 };
    }
    // Помеченный на удаление документ своих оповещений не показывает: объект
    // приговорён, и требовать по нему действий значит звать к работе над тем,
    // чего не будет.
    if (doc[deletionMark.FIELD]) {
        await clear({ table: p.table, uid: p.uid, transaction: p.transaction });
        return { pushes: [], created: 0, removed: 0 };
    }

    const pushes = [];
    let created = 0, removed = 0;

    for (const rule of rules) {
        let items;
        try {
            items = await rule.build(doc, {
                table: p.table,
                uid: p.uid,
                rule,
                sessionID: p.sessionID || SYSTEM_SESSION_ID,
                transaction: p.transaction || null,
                requestedBy: p.requestedBy || null,
                input: p.input || null
            });
        } catch (e) {
            // Упавшее правило НЕ СНИМАЕТ своих прежних строк: «не смог
            // посчитать» и «причина устранена» — разные ответы, и путать их
            // значит гасить красную пометку из-за сбоя в запросе.
            console.error(`[documentAlerts] правило "${rule.code}" не посчитано для `
                + `${p.table}[${p.uid}]: ${e && e.message || e}`);
            continue;
        }

        let rows;
        try {
            rows = (Array.isArray(items) ? items : []).map((it, i) => normalize(it, rule, doc, i));
        } catch (e) {
            console.error(`[documentAlerts] ${e && e.message || e}`);
            continue;
        }

        const res = await writeRuleRows({
            table: p.table, uid: p.uid, ruleCode: rule.code,
            rows, transaction: p.transaction
        });
        created += res.created.length;
        removed += res.removed;

        // ПУШ уходит по строке, которой о нём ещё не говорили: созданной заново
        // либо созданной когда-то и так и не отправленной (процесс мог упасть
        // между записью и отправкой).
        for (const row of res.created.concat(res.kept)) {
            if (!row.pushWanted) continue;
            if (!emptyValues.isEmptyDate(row.pushSentAt)) continue;
            pushes.push(row);
        }
    }

    return { pushes, created, removed };
}

/**
 * ЧЬИ ОПОВЕЩЕНИЯ УСТАРЕЛИ ОТ ЭТИХ ДВИЖЕНИЙ.
 *
 * ── Задача, которой ТЗ не предусмотрело, а приёмка требует ───────────────────
 * Приёмка §17.2: «Выпустили корректировку — оповещение исчезло САМО». Но
 * расхождение висит на БРОНИ, а корректировку выпускает СЧЁТ: пересчёт правил
 * проводимого документа его не касается. Суточного прохода тоже мало — пометка
 * про деньги не должна жить сутки после того, как её причина устранена.
 *
 * ── Почему это выводится, а не объявляется ───────────────────────────────────
 * Каскад проведения для этого не годится принципиально: он идёт ВПЕРЁД ПО
 * ВРЕМЕНИ (на этом и только на этом держится его завершаемость), а бронь старше
 * своего счёта — назад каскад не ходит и ходить не должен.
 *
 * Зато ответ уже лежит в объявлениях, и второго списка заводить не нужно:
 * движение написано В РАЗРЕЗЕ измерений, а измерение, ссылающееся на документ,
 * объявляет это само (`references` в `db.json`). Значит «кого задели мои
 * движения» = «какие документы стоят в измерениях моих движений». Из них берём
 * только те, у кого ВООБЩЕ объявлены правила: остальные ссылки (организация,
 * услуга, вид гостя) не документы, и спрашивать по ним нечего.
 *
 * Признак того, что здесь появился бы лишний флаг: «список связанных таблиц» в
 * `entityConfig` — то есть второй список рядом с измерениями регистра, который
 * разъедется с ним при первой же правке разреза.
 *
 * @param {Array<object>} movements — строки движений (с полем `__register`)
 * @param {object} [exclude] — `{ table, uid }` сам регистратор
 * @returns {Array<{table: string, uid: string}>}
 */
function relatedFromMovements(movements, exclude) {
    const out = new Map();
    if (!Array.isArray(movements) || !movements.length) return [];

    let globalCtx = null;
    try { globalCtx = require('../globalServerContext'); } catch (e) { return []; }
    const registers = require('./registers');

    // Таблица → ссылающиеся на неё измерения этого регистра. Считается один раз
    // на регистр, а не на строку: движений бывают сотни.
    const refsCache = new Map();
    const refsOf = (register) => {
        if (refsCache.has(register)) return refsCache.get(register);
        const pairs = [];
        try {
            const cfg = registers.get(register);
            const modelName = globalCtx.getModelNameForTable(register);
            const Model = modelName ? globalCtx.modelsDB[modelName] : null;
            const attrs = (Model && Model.rawAttributes) || {};
            for (const dim of ((cfg && cfg.dimensions) || [])) {
                const ref = attrs[dim] && attrs[dim].references;
                const target = ref && (typeof ref.model === 'string' ? ref.model
                    : (ref.model && ref.model.tableName) || null);
                if (!target) continue;
                if (!alertRules.forTable(target).length) continue;
                pairs.push({ dim, table: target });
            }
        } catch (e) {
            console.error(`[documentAlerts] разрез регистра "${register}" не разобран:`, e && e.message || e);
        }
        refsCache.set(register, pairs);
        return pairs;
    };

    for (const row of movements) {
        if (!row || !row.__register) continue;
        for (const { dim, table } of refsOf(row.__register)) {
            const uid = row[dim];
            if (!uid) continue;
            if (exclude && exclude.table === table && exclude.uid === uid) continue;
            out.set(table + '|' + uid, { table, uid });
        }
    }
    return Array.from(out.values());
}

// ── Пуши (§12) ───────────────────────────────────────────────────────────────

/**
 * Отправить накопленные пуши и проставить отметку.
 *
 * ПОСЛЕ транзакции, а не внутри: уведомление — запись в чужую таблицу и событие
 * в открытые окна, и отправлять его из незакоммиченной транзакции значит обещать
 * то, что может откатиться. Отметка ставится ПОСЛЕ отправки: не отправленное и
 * не отмеченное уйдёт при следующем пересчёте, а отмеченное без отправки
 * потерялось бы навсегда.
 *
 * Текст пуша КОПИРУЕТ текст строки, действие — то же самое. Уровень решает
 * форму: `error` — с записью и без тайм-аута (до прочтения), `warning` — с
 * тайм-аутом, `info` — пуша нет вовсе.
 *
 * @param {Array<object>} rows — строки оповещений (как в базе)
 * @param {object} p — `{ userId }` — получатель
 */
async function flushPushes(rows, p) {
    const userId = p && p.userId;
    if (!userId || !rows || !rows.length) return 0;

    let notifications = null;
    try { notifications = require('../../apps/notifications/server'); } catch (e) { return 0; }
    const { tfForUser } = require('../../drive_forms/globalServerContext');
    const ttl = await summaryTtl();

    let sent = 0;
    for (const row of rows) {
        if (row.severity === SEVERITY.INFO) continue;
        let text = row.textKey;
        try {
            // Язык ПОЛУЧАТЕЛЯ, а не инициатора: порядок аргументов
            // `(ключ, кому, подстановки)` — перепутанный не падает, а молча
            // возвращает ключ.
            const vars = await translateVars(parseJson(row.textVars),
                (key) => tfForUser(key, userId, {}));
            const t = await tfForUser(row.textKey, userId, vars);
            if (t) text = t;
        } catch (e) { /* ключ в тексте виден и чинится */ }

        let title = row.severity === SEVERITY.ERROR ? 'alert_push_title_error' : 'alert_push_title';
        try { title = await tfForUser(title, userId, {}); } catch (e) { /* ключ */ }

        try {
            await notifications.notify({
                userId,
                appName: 'uniForm',
                title,
                text,
                icon: iconFor(row.severity),
                // Клик делает то же, что гиперссылка в панели формы: действие
                // объявлено приложением + именем метода, UID скрипта в базе не
                // лежит (он живёт один запуск процесса).
                onClick: { fn: 'runAlertAction', fnParams: actionOf(row) },
                // Асимметрия (§12): ошибка ждёт прочтения, предупреждение гаснет.
                ttl: row.severity === SEVERITY.ERROR ? 0 : ttl,
                ephemeral: false,
                // По тегу уведомление снимается, когда исчезло само оповещение
                // (`retractPushes`) — иначе оно висело после устранения причины.
                tag: pushTag(row.UID)
            });
            await markPushSent(row.UID);
            sent++;
        } catch (e) {
            console.error(`[documentAlerts] пуш не отправлен (${row.ruleCode}): ${e && e.message || e}`);
        }
    }
    return sent;
}

/** Описание действия для клиента — и для панели, и для пуша. */
function actionOf(row) {
    return {
        kind: row.actionKind || null,
        app: row.actionApp || null,
        params: parseJson(row.actionParams) || {},
        documentTable: row.documentTable,
        documentUID: row.documentUID
    };
}

async function markPushSent(uid) {
    await gateway().execute({
        operation: 'update', table: TABLE, where: { UID: uid },
        data: { pushSentAt: new Date() },
        context: { sessionID: SYSTEM_SESSION_ID }
    });
}

/** Тайм-аут уведомления-предупреждения — та же настройка, что у проведения. */
async function summaryTtl() {
    try {
        const v = await require('../settings').getSystemSetting('core', 'postingSuccessNotifyTtl');
        const n = Number(v);
        return isFinite(n) && n > 0 ? n : 10;
    } catch (e) {
        return 10;
    }
}

module.exports = {
    TABLE,
    SEVERITY,
    RANK,
    TONES,
    ICONS,
    ACTION,
    severityRank,
    topSeverity,
    iconFor,
    relatedFromMovements,
    pushByDefault,
    rowsOf,
    forDocument,
    forDocuments,
    listVisible,
    countImportant,
    rebuild,
    clear,
    flushPushes,
    actionOf
};
