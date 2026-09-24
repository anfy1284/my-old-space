'use strict';

/**
 * postingQueue — ОЧЕРЕДЬ ПРОВЕДЕНИЯ (ТЗ «Проведение документов», §8, §10).
 *
 * Проведение всегда отложенное и всегда через очередь — синхронного нет ни в одном
 * режиме (решение владельца): единая очередь снимает взаимные блокировки при массовой
 * работе. Цена — ответ приходит уведомлением, а не возвратом функции.
 *
 * ОЧЕРЕДЬ — ОТДЕЛЬНАЯ ТАБЛИЦА, а не поля в документе. Две причины, и обе тяжёлые:
 * запись числа попыток в документ пробивала бы замок неизменности на каждой неудаче,
 * а выборка «следующий по всем видам документов» превратилась бы в опрос всех
 * документных таблиц подряд.
 *
 * ПОСТАНОВКА ИДЕМПОТЕНТНА. Строка уже есть — ничего не делаем: в очереди лежит только
 * ССЫЛКА, и когда до неё дойдёт черёд, прочитаются актуальные данные документа.
 * Двойное нажатие, тройное сохранение, каскад поверх ручного проведения — один и тот
 * же результат. Единственное исключение: действие ЧЕЛОВЕКА сбрасывает разрежение
 * (`attempts`, `nextAttemptAt`), чтобы исправленный документ пробовался сразу.
 *
 * НЕПРОВОДЯЩИЙСЯ ДОКУМЕНТ ОСТАЁТСЯ В ОЧЕРЕДИ НАВСЕГДА и пробуется снова — очередь при
 * этом НЕ встаёт: строка, до которой не дошло `nextAttemptAt`, просто пропускается, а
 * независимые документы идут дальше. Потолка попыток нет: сдаваться нельзя, потому что
 * непроведённый документ — это проблема, которую надо решить, а не обойти.
 */

const TABLE = 'posting_queue';
const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';

const posting = require('./posting');
const entityMoment = require('./entityMoment');
const emptyValues = require('./emptyValues');

/** Значения настроек разрежения повторов (ТЗ §15). */
const SETTINGS = {
    app: 'core',
    retryThreshold: 'postingRetryThreshold',
    retryDelayMinutes: 'postingRetryDelayMinutes',
    sweepMinutes: 'postingSweepMinutes',
    successNotifyTtl: 'postingSuccessNotifyTtl'
};

async function setting(key, fallback) {
    try {
        const v = await require('../settings').getSystemSetting(SETTINGS.app, key);
        if (v === null || v === undefined || v === '') return fallback;
        const n = Number(v);
        return isFinite(n) ? n : fallback;
    } catch (e) {
        return fallback;
    }
}

// ── Постановка в очередь ─────────────────────────────────────────────────────

/**
 * Поставить документ в очередь.
 *
 * Очередь — собственная бухгалтерия механизма, поэтому пишется системной сессией:
 * это ровно тот случай, для которого `__SYS_INTERNAL__` и заведён (своя служебная
 * таблица, а не чужие учётные данные). Исполнение же пойдёт под служебной сессией
 * `requestedBy` — там обход прав был бы уже подменой правил.
 *
 * @param {object} p — `{ table, uid, action, requestedBy, byHuman, sessionID }`
 * @returns {Promise<object|null>} строка очереди или `null`, если документ не проводится
 */
async function enqueue(p) {
    const dbGateway = require('../dbGateway');
    const globalCtx = require('../globalServerContext');

    const table = p.table;
    const uid = p.uid;
    const action = p.action === posting.ACTION.UNPOST ? posting.ACTION.UNPOST : posting.ACTION.POST;

    const modelName = globalCtx.getModelNameForTable(table);
    const Model = modelName ? globalCtx.modelsDB[modelName] : null;
    if (!Model || !posting.isPostable(Model)) return null;

    // Момент времени документа копируется в строку очереди: сортировать очередь
    // придётся на каждом проходе, и join к пяти документным таблицам ради двух
    // чисел — ровно та цена, которую механизм не должен платить.
    const docRows = await dbGateway.execute({
        operation: 'read', table, where: { UID: uid },
        options: { raw: true, limit: 1 },
        context: { sessionID: SYSTEM_SESSION_ID }
    });
    const doc = docRows && docRows[0];
    if (!doc) return null;

    const existing = await dbGateway.execute({
        operation: 'read', table: TABLE,
        where: { documentTable: table, documentUID: uid },
        options: { raw: true, limit: 1 },
        context: { sessionID: SYSTEM_SESSION_ID }
    });

    // Состояние ДО постановки. Нужно для отмены: снятие с очереди обязано вернуть
    // документ туда, где он был, — проведённый остаётся проведённым (движения-то
    // никуда не делись), непроведённый непроведённым. Без этого отмена превращала
    // бы проведённый документ в непроведённый при живых движениях, то есть врала
    // бы об учёте.
    const wasState = doc[posting.STATE_FIELD] || posting.STATE.NOT_POSTED;
    const prevState = (wasState === posting.STATE.QUEUED)
        ? ((existing && existing[0] && existing[0].prevState) || posting.STATE.NOT_POSTED)
        : wasState;

    const base = {
        documentTable: table,
        documentUID: uid,
        date: doc[entityMoment.DATE_FIELD] || null,
        seq: doc[entityMoment.FIELD] || 0,
        action,
        requestedBy: p.requestedBy || null,
        organizationId: doc.organizationId || null,
        byHuman: !!p.byHuman,
        prevState,
        // Что сделать ПОСЛЕ распроведения. Сейчас такое одно — поставить пометку
        // на удаление: помеченным может быть только тот, кого можно удалить, а
        // проведённого удалять нельзя. Флаг едет в строке очереди, потому что
        // между нажатием и снятием движений проходит время, и намерение человека
        // обязано дожить до него (drive_root/db/deletionMark.js).
        thenMark: !!p.thenMark
    };

    if (existing && existing.length) {
        const row = existing[0];
        // Уже стоит. Пересчитываем только то, что могло измениться со времени
        // постановки, и сбрасываем разрежение, если пришёл ЧЕЛОВЕК: иначе
        // исправленный документ ждал бы пять минут вместо ближайшего прохода.
        const data = {
            date: base.date, seq: base.seq, action,
            // «Кто-то ждёт ответа» не снимается фоновой постановкой поверх ручной.
            byHuman: row.byHuman || base.byHuman,
            // Как и `byHuman`: намерение пометить, однажды высказанное, фоновой
            // перепостановкой не отменяется.
            thenMark: row.thenMark || base.thenMark
        };
        if (p.byHuman) {
            data.attempts = 0;
            data.nextAttemptAt = null;
            data.requestedBy = base.requestedBy || row.requestedBy;
        }
        await dbGateway.execute({
            operation: 'update', table: TABLE, where: { UID: row.UID }, data,
            context: { sessionID: SYSTEM_SESSION_ID }
        });
        await markQueued(table, uid, p.sessionID);
        return Object.assign({}, row, data);
    }

    const created = await dbGateway.execute({
        operation: 'create', table: TABLE,
        data: Object.assign({ attempts: 0, nextAttemptAt: null }, base),
        context: { sessionID: SYSTEM_SESSION_ID }
    });
    await markQueued(table, uid, p.sessionID);
    return created && created.get ? created.get({ plain: true }) : created;
}

/**
 * Пометить документ как стоящий в очереди — только если он ещё не помечен.
 * Состояние пишется ТОЛЬКО на переходах: иначе каждая постановка трогала бы документ,
 * а это запись в закрытый документ и строка в журнале изменений на каждый чих.
 */
async function markQueued(table, uid, sessionID) {
    const dbGateway = require('../dbGateway');
    const rows = await dbGateway.execute({
        operation: 'read', table, where: { UID: uid },
        options: { raw: true, limit: 1, attributes: ['UID', posting.STATE_FIELD] },
        context: { sessionID: SYSTEM_SESSION_ID }
    });
    const cur = rows && rows[0] && rows[0][posting.STATE_FIELD];
    if (cur === posting.STATE.QUEUED) return;
    try {
        await posting.setState({ table, uid, state: posting.STATE.QUEUED, sessionID: sessionID || SYSTEM_SESSION_ID });
    } catch (e) {
        console.error(`[postingQueue] ${table}[${uid}]: состояние "в очереди" не записано: ${e.message}`);
    }
}

/** Поставить в очередь список документов одной таблицы (групповое проведение). */
async function enqueueMany(p) {
    const out = [];
    for (const uid of (p.uids || [])) {
        try {
            const row = await enqueue(Object.assign({}, p, { uid }));
            if (row) out.push(row);
        } catch (e) {
            console.error(`[postingQueue] ${p.table}[${uid}]: не поставлен в очередь: ${e.message}`);
        }
    }
    return out;
}

// ── Проход ───────────────────────────────────────────────────────────────────

/** Снять строку очереди (документ обработан). */
async function remove(uidOfRow) {
    const dbGateway = require('../dbGateway');
    await dbGateway.execute({
        operation: 'delete', table: TABLE, where: { UID: uidOfRow },
        context: { sessionID: SYSTEM_SESSION_ID }
    });
}

/**
 * Следующая строка очереди: строго по моменту времени документа, пропуская те, до
 * которых ещё не дошёл `nextAttemptAt`.
 */
async function next(excludeUIDs) {
    const dbGateway = require('../dbGateway');
    const { Op } = require('sequelize');
    const where = {
        [Op.or]: [{ nextAttemptAt: null }, { nextAttemptAt: { [Op.lte]: new Date() } }]
    };
    if (excludeUIDs && excludeUIDs.length) {
        where.UID = { [Op.notIn]: excludeUIDs };
    }
    const rows = await dbGateway.execute({
        operation: 'read', table: TABLE, where,
        options: { raw: true, limit: 1, order: [['date', 'ASC'], ['seq', 'ASC']] },
        context: { sessionID: SYSTEM_SESSION_ID }
    });
    return (rows && rows[0]) || null;
}

/** Сколько строк ждёт прямо сейчас (для «остался ли кто-то после прохода»). */
async function pending() {
    const dbGateway = require('../dbGateway');
    const { Op } = require('sequelize');
    return await dbGateway.execute({
        operation: 'count', table: TABLE,
        where: { [Op.or]: [{ nextAttemptAt: null }, { nextAttemptAt: { [Op.lte]: new Date() } }] },
        context: { sessionID: SYSTEM_SESSION_ID }
    });
}

/**
 * Записать неудачу.
 *
 * Строка очереди перезаписывается НА МЕСТЕ, новых записей в журнал и новых уведомлений
 * не появляется — даже если текст ошибки изменился. Это и есть то, что делает
 * бесконечные повторы безвредными.
 *
 * @returns {Promise<{attempts:number, delayed:boolean}>}
 */
async function fail(row, error) {
    const dbGateway = require('../dbGateway');
    const threshold = await setting(SETTINGS.retryThreshold, 3);
    const delayMin = await setting(SETTINGS.retryDelayMinutes, 5);

    const attempts = (Number(row.attempts) || 0) + 1;
    const delayed = attempts > threshold;
    const data = {
        attempts,
        lastError: String((error && error.message) || error || '').slice(0, 4000),
        // Ключ перевода и подстановки хранятся РЯДОМ с техническим текстом.
        // Перевести причину при записи нельзя: читать её будет не обязательно
        // тот, кто вызвал попытку, — подсказку в журнале смотрит любой, и на
        // своём языке. Поэтому храним, из чего собрать текст, а собираем при показе.
        lastErrorKey: (error && error.errorKey) || null,
        lastErrorVars: (error && error.errorVars) ? JSON.stringify(error.errorVars) : null,
        lastErrorAt: new Date(),
        nextAttemptAt: delayed ? new Date(Date.now() + delayMin * 60 * 1000) : null,
        // Ответ человеку уходит ОДИН раз — на той попытке, которую он вызвал.
        // Дальше строка живёт фоном, и молчание здесь не забывчивость, а правило.
        byHuman: false
    };
    await dbGateway.execute({
        operation: 'update', table: TABLE, where: { UID: row.UID }, data,
        context: { sessionID: SYSTEM_SESSION_ID }
    });
    return { attempts, delayed, delayMin };
}

/**
 * Отметить строку «взята в работу» / «отпущена».
 *
 * Различие «в очереди» и «проводится» нужно ЧЕЛОВЕКУ: форма показывает сначала
 * одно, потом другое, и это единственный способ понять, ждёт документ своей
 * очереди или уже считается. Без отметки оба состояния выглядели бы одинаково, и
 * зависший обработчик был бы неотличим от длинной очереди.
 *
 * Отметка снимается при неудаче: следующий проход снова покажет «в очереди», а не
 * «проводится вечно».
 */
async function markStarted(uidOfRow, started) {
    const dbGateway = require('../dbGateway');
    await dbGateway.execute({
        operation: 'update', table: TABLE, where: { UID: uidOfRow },
        data: { startedAt: started ? new Date() : null },
        context: { sessionID: SYSTEM_SESSION_ID }
    });
}

/** Текст последней ошибки по документу — источник подсказки на крестике в журнале. */
async function errorOf(table, uid) {
    const dbGateway = require('../dbGateway');
    const rows = await dbGateway.execute({
        operation: 'read', table: TABLE,
        where: { documentTable: table, documentUID: uid },
        options: { raw: true, limit: 1 },
        context: { sessionID: SYSTEM_SESSION_ID }
    });
    const row = rows && rows[0];
    if (!row) return null;
    return {
        // Фаза, а не «состояние»: состояние живёт в документе (`postingState`),
        // а здесь — где именно документ находится в очереди прямо сейчас.
        // ПУСТАЯ ДАТА — `0001-01-01`, а не NULL (drive_root/db/emptyValues.js), и она
        // ИСТИННА в булевом смысле. Проверка `row.startedAt ? ...` объявляла бы
        // «проводится» всегда, даже у строки, которую никто не брал.
        phase: emptyValues.isEmptyDate(row.startedAt) ? 'queued' : 'posting',
        error: row.lastError || null,
        // Ключ и подстановки — чтобы причину перевёл ТОТ, КТО ПОКАЗЫВАЕТ, на
        // языке того, кто смотрит: подсказку в журнале читает не обязательно
        // инициатор попытки.
        errorKey: row.lastErrorKey || null,
        errorVars: (function () {
            try { return row.lastErrorVars ? JSON.parse(row.lastErrorVars) : null; }
            catch (e) { return null; }
        })(),
        at: row.lastErrorAt || null,
        attempts: row.attempts || 0,
        nextAttemptAt: row.nextAttemptAt || null,
        startedAt: row.startedAt || null,
        action: row.action
    };
}

/** Строка очереди по документу (или null). */
async function rowOf(table, uid) {
    const dbGateway = require('../dbGateway');
    const rows = await dbGateway.execute({
        operation: 'read', table: TABLE,
        where: { documentTable: table, documentUID: uid },
        options: { raw: true, limit: 1 },
        context: { sessionID: SYSTEM_SESSION_ID }
    });
    return (rows && rows[0]) || null;
}

/**
 * СНЯТЬ ДОКУМЕНТ С ОЧЕРЕДИ.
 *
 * Это НЕ распроведение: у документа, который ещё только стоит в очереди, снимать
 * нечего — движений он не делал. Путать их нельзя, поэтому «Отменить проведение»
 * сначала пробует снять с очереди и только потом, если снимать уже нечего,
 * распроводит по правилам документа.
 *
 * Строку, УЖЕ ВЗЯТУЮ в работу, не снимаем: проведение идёт в транзакции, и выдернуть
 * её на полпути значило бы соврать — она либо ляжет целиком, либо откатится сама.
 * Так же отвечаем на «нажал, а он только что провёлся»: кнопка на экране успела
 * соврать, и сервер обязан это увидеть, а не поверить ей.
 *
 * @returns {Promise<{cancelled: boolean, reason?: string, state?: string}>}
 */
async function cancelQueued(p) {
    const row = await rowOf(p.table, p.uid);
    if (!row) return { cancelled: false, reason: 'not_queued' };
    // Та же ловушка пустой даты, что и в `errorOf`: `if (row.startedAt)` отказывало
    // бы в снятии с очереди ВСЕГДА — строка «уже в работе» с самого создания.
    if (!emptyValues.isEmptyDate(row.startedAt)) return { cancelled: false, reason: 'already_running' };

    await remove(row.UID);
    const back = row.prevState || posting.STATE.NOT_POSTED;
    try {
        await posting.setState({
            table: p.table, uid: p.uid, state: back,
            sessionID: p.sessionID || SYSTEM_SESSION_ID
        });
    } catch (e) {
        console.error(`[postingQueue] ${p.table}[${p.uid}]: состояние после отмены не записано: ${e.message}`);
    }
    return { cancelled: true, state: back };
}

// ── Толчок: разбудить исполнителя вне тика планировщика (§10.2) ──────────────

/** Код типа регламентной задачи-исполнителя. */
const RUNNER_HANDLER = 'core.postingQueue';

/**
 * Разбудить исполнителя очереди.
 *
 * Без толчка документ ждал бы ближайшего тика страхующего задания — до пяти минут
 * после нажатия кнопки. С толчком проход начинается сразу.
 *
 * Три особенности, и все намеренные:
 *   1. **Проход уже идёт — толчок не пропадает, а ОТКЛАДЫВАЕТСЯ.** Сама по себе
 *      строка не потерялась бы (проход берёт их из таблицы), но строка, приехавшая
 *      в последнюю секунду прохода, ждала бы страхующего тика — до пяти минут после
 *      нажатия кнопки. Поэтому толчок при занятом исполнителе повторяется через
 *      несколько секунд, пока не пройдёт или пока очередь не опустеет. Это же
 *      закрывает §10.2.2 «конец прохода — сразу новый, если что-то осталось»:
 *      сам проход идёт в ФОРКНУТОМ ВОРКЕРЕ и разбудить оттуда некого.
 *   2. **Толчок работает только в главном процессе.** Планировщик живёт там;
 *      из воркера будить некого. Это не дыра: страхующее задание подберёт строку —
 *      оно и заведено ровно на случай, когда разбудить не вышло.
 *   3. **Неудача толчка не является ошибкой операции.** Документ уже в очереди;
 *      худшее, что может случиться, — он проведётся на несколько минут позже.
 *
 * @returns {Promise<boolean>} проход запущен этим вызовом
 */
const KICK_RETRY_MS = 3000;
let _kickTimer = null;

async function kick() {
    try {
        const dbGateway = require('../dbGateway');
        const rows = await dbGateway.execute({
            operation: 'read', table: 'scheduler_tasks',
            where: { handler: RUNNER_HANDLER, enabled: true },
            options: { raw: true, limit: 1 },
            context: { sessionID: SYSTEM_SESSION_ID }
        });
        const task = rows && rows[0];
        if (!task) return false;

        const engine = require('../scheduler/engine');
        const res = await engine.runNow(task.UID);
        if (res && res.ok) return true;

        // Занято. Повторим — но только один отложенный толчок на процесс: их цель
        // не «попасть точно», а «не забыть», и десять таймеров делают то же, что один.
        if (!_kickTimer) {
            _kickTimer = setTimeout(async () => {
                _kickTimer = null;
                try {
                    if (await pending() > 0) await kick();
                } catch (e) { /* подберёт страхующий тик */ }
            }, KICK_RETRY_MS);
            if (_kickTimer.unref) _kickTimer.unref();
        }
        return false;
    } catch (e) {
        // Планировщика в этом процессе может не быть вовсе (воркер) — это штатно.
        return false;
    }
}

module.exports = {
    TABLE,
    RUNNER_HANDLER,
    kick,
    SETTINGS,
    setting,
    enqueue,
    enqueueMany,
    next,
    pending,
    remove,
    cancelQueued,
    markStarted,
    fail,
    errorOf,
    rowOf
};
