'use strict';

/**
 * documentCommands.js — КОМАНДЫ ДОКУМЕНТА «Сторнировать», «Скорректировать»,
 * «Признать недействительным». Механизм ЯДРА: приложение получает их вместе с
 * объявлением в `entityConfig`, не написав ни серверной функции, ни обработчика
 * на клиенте.
 *
 * Регистрируются один раз как серверный скрипт `document.actions`; кнопка формы
 * зовёт их декларацией в лейауте, без клиентского кода:
 *
 *   { "name": "btnStorno",     "command": "storno",     "icon": …, "caption": … }
 *   { "name": "btnCorrect",    "command": "correct",    "icon": …, "caption": … }
 *   { "name": "btnInvalidate", "command": "invalidate", "icon": …, "caption": … }
 *
 * Сторно и коррекция НИЧЕГО НЕ ПИШУТ (13.09.2026): команда собирает встречный
 * документ в памяти (`storno.prepareCounter`) и отдаёт форме `openNew` — клиент
 * открывает НЕСОХРАНЁННУЮ форму. Передумал — закрыл окно, в базе ничего не осталось.
 * Документ создаёт сохранение формы, выставляет — обычная кнопка «Выставить»
 * приложения, а исходный документ сторно отменяется в момент выставления
 * (middleware `dbGateway` → `storno.issuingStornos`/`cancelSourcesOf`).
 *
 * «Недействителен» встречного документа не создаёт и меняет только состояние
 * (`invalidate.js`) — ему открывать нечего.
 */

const storno = require('./storno');

/** Локализованный текст для ответа пользователю. */
async function say(sessionID, key, fallback) {
    try {
        const { tForSession } = require('../../drive_forms/globalServerContext');
        const v = await tForSession(key, sessionID);
        if (v && v !== key) return v;
    } catch (e) { /* перевода нет */ }
    return fallback;
}

/** Оповестить открытые списки: документ изменился. */
function notify(table, op, uid) {
    try {
        require('../../apps/uniForm/server').notifyTableChange(table, op, uid);
    } catch (e) { /* списков может не быть */ }
}

/**
 * Собрать встречный документ вида `kind` и вернуть данные несохранённой формы.
 * Отказы («уже сторнирован», «не выставлен» …) — здесь же, до открытия окна.
 */
async function prepareCounterCommand(kind, { table, uid }, ctx) {
    const sessionID = ctx && ctx.sessionID;
    if (!table || !uid) return { error: await say(sessionID, 'storno_refuse_no_target', 'Документ не найден') };
    try {
        const prep = await storno.prepareCounter({
            table, UID: uid, kind, context: { sessionID }, t: (key) => say(sessionID, key, key)
        });
        return {
            ok: true, table,
            // Параметры открытия формы записи: `prefill`/`prefillTabular` — как у
            // «создать на основании», `counterOf` — природа документа, которую при
            // сохранении проверит и запишет ядро (storno.verifyCounter/stampCounter).
            openNew: { prefill: prep.prefill, prefillTabular: prep.prefillTabular, counterOf: prep.counterOf }
        };
    } catch (e) {
        return { error: (e && e.userMessage) || (e && e.message) || String(e) };
    }
}

/** «Сторнировать»: полная отмена. */
async function stornoDocument(params, ctx) {
    return await prepareCounterCommand('storno', params || {}, ctx);
}

/** «Скорректировать»: частичное изменение, исходный документ остаётся действующим. */
async function correctDocument(params, ctx) {
    return await prepareCounterCommand('correction', params || {}, ctx);
}

/**
 * «Признать недействительным» (Ungültig): встречного документа нет, меняется только
 * состояние (`invalidate.js`). Форме возвращается новое состояние — она покажет его
 * сразу; открывать нечего, поэтому ответ несёт сообщение.
 */
async function invalidateCommand({ table, uid }, ctx) {
    const sessionID = ctx && ctx.sessionID;
    if (!table || !uid) return { error: await say(sessionID, 'storno_refuse_no_target', 'Документ не найден') };
    try {
        const res = await require('./invalidate').invalidateDocument({
            table, UID: uid, context: { sessionID }, t: (key) => say(sessionID, key, key)
        });
        notify(table, 'update', uid);
        return {
            ok: true, table, documentUID: uid,
            number: res.number,
            sourceState: res.status,
            stateField: res.field,
            message: await say(sessionID, 'invalidate_done', 'Документ признан недействительным:')
        };
    } catch (e) {
        return { error: (e && e.userMessage) || (e && e.message) || String(e) };
    }
}

// ── Проведение (ТЗ «Проведение документов», §14.1) ───────────────────────────
//
// Три команды устроены одинаково и одинаково же коротки: КОМАНДА НИЧЕГО НЕ ПРОВОДИТ.
// Она ставит документ в очередь и будит исполнителя. Синхронного проведения нет ни в
// одном режиме — решение владельца: единая очередь снимает взаимные блокировки при
// массовой работе, а цена в том, что ответ приходит уведомлением.
//
// Отсюда же двойное и тройное нажатие «Провести» даёт ОДИН результат: постановка
// идемпотентна (в очереди лежит только ссылка на документ), а исполнитель захватывает
// задачу, и двух проходов одновременно не бывает.

/** Кто нажал. Проведение исполняется от его имени — служебной сессией. */
async function actorOf(sessionID) {
    try {
        const user = await require('../globalServerContext').getUserBySessionID(sessionID);
        // ВСЕГДА user.UID: user.id вернёт undefined и обезличит исполнение.
        return (user && user.UID) || null;
    } catch (e) {
        return null;
    }
}

async function enqueueCommand(action, { table, uid }, ctx) {
    const sessionID = ctx && ctx.sessionID;
    if (!table || !uid) return { error: await say(sessionID, 'storno_refuse_no_target', 'Документ не найден') };

    const posting = require('./posting');
    const globalCtx = require('../globalServerContext');
    const modelName = globalCtx.getModelNameForTable(table);
    const Model = modelName ? globalCtx.modelsDB[modelName] : null;
    const cfg = Model && posting.readConfig(Model);
    if (!cfg) return { error: await say(sessionID, 'posting_refuse_not_postable', 'Документ не проводится') };

    // Отказ в распроведении выдаём СРАЗУ, а не уведомлением через полминуты:
    // пользователь нажал кнопку и ждёт ответа, а «нельзя» — это ответ.
    if (action === posting.ACTION.UNPOST && !cfg.unpost.length) {
        return { error: await say(sessionID, 'posting_refuse_unpost_denied', 'Распроведение запрещено') };
    }

    const postingQueue = require('./postingQueue');
    try {
        const row = await postingQueue.enqueue({
            table, uid, action,
            requestedBy: await actorOf(sessionID),
            byHuman: true,
            sessionID
        });
        if (!row) return { error: await say(sessionID, 'posting_refuse_not_postable', 'Документ не проводится') };
    } catch (e) {
        return { error: (e && e.userMessage) || (e && e.message) || String(e) };
    }

    // Толчок — чтобы проход начался сейчас, а не на ближайшем страхующем тике.
    // Не получилось (проход уже идёт, мы не в главном процессе) — не беда:
    // строка записана, её подберут.
    try { await postingQueue.kick(); } catch (e) { /* подберёт страхующий тик */ }

    notify(table, 'update', uid);
    return {
        ok: true, table, documentUID: uid,
        queued: true,
        stateField: posting.STATE_FIELD,
        sourceState: posting.STATE.QUEUED
    };
}

/** «Провести» — поставить в очередь. */
async function postDocument(params, ctx) {
    return await enqueueCommand(require('./posting').ACTION.POST, params || {}, ctx);
}

/**
 * «Отменить проведение» — ТОЛЬКО распроведение, и ничего больше.
 *
 * Раньше под этой кнопкой жили два действия: снять с очереди, если документ ещё
 * стоит, и распровести, если уже проведён. Выглядело удобно, а означало ложь в
 * одном частом случае (решение владельца 22.09.2026). Проведённый документ,
 * поставленный в очередь на ПОВТОРНОЕ проведение, находится в состоянии
 * `queued` — и кнопка сняла бы его с очереди, вернув в `posted`. Пользователь
 * при этом нажал «отменить проведение» и остался с ПРОВЕДЁННЫМ документом. Хуже
 * того, снятие с очереди доступно любому, а распроведение — нет: тот, кому
 * распроведение запрещено, получал бы вид действия, которого не имеет права
 * сделать.
 *
 * Поэтому снятие с очереди — отдельная команда (`cancelQueue`) и отдельное место
 * в интерфейсе: строка «документ в очереди …» с кнопкой рядом. Она говорит, что
 * именно стоит в очереди — проведение или его отмена, — и снимает ровно это.
 */
async function unpostDocument(params, ctx) {
    return await enqueueCommand(require('./posting').ACTION.UNPOST, params || {}, ctx);
}

/**
 * «Снять с очереди» — отозвать невыполненную задачу очереди, какой бы она ни была.
 *
 * Это НЕ распроведение и не отмена его результата: документ возвращается в то
 * состояние, в котором был до постановки (`posting_queue.prevState`). Проведённый
 * документ, снятый с очереди повторного проведения, остаётся проведённым — и
 * строка интерфейса говорит об этом прямо.
 *
 * Строку, уже взятую в работу, не снимаем: транзакция проведения либо ляжет
 * целиком, либо откатится сама, и выдёргивать её на полпути было бы обманом.
 */
async function cancelQueueCommand(params, ctx) {
    const { table, uid } = params || {};
    const sessionID = ctx && ctx.sessionID;
    if (!table || !uid) return { error: await say(sessionID, 'storno_refuse_no_target', 'Документ не найден') };

    const posting = require('./posting');
    const postingQueue = require('./postingQueue');

    const cancelled = await postingQueue.cancelQueued({ table, uid, sessionID });
    if (cancelled.cancelled) {
        notify(table, 'update', uid);
        return {
            ok: true, table, documentUID: uid,
            cancelledQueue: true,
            stateField: posting.STATE_FIELD,
            sourceState: cancelled.state,
            message: await say(sessionID, 'posting_queue_cancelled', 'Документ снят с очереди')
        };
    }
    if (cancelled.reason === 'already_running') {
        return { error: await say(sessionID, 'posting_refuse_running',
            'Документ проводится прямо сейчас — дождитесь окончания') };
    }
    // Строки нет — значит задача уже выполнена. Это не ошибка: пользователь
    // нажал на секунду позже, чем исполнитель дошёл до документа.
    return { ok: true, table, documentUID: uid, cancelledQueue: false,
        stateField: posting.STATE_FIELD };
}

/** «Провести и закрыть» — то же, но форма закрывается: результат придёт уведомлением. */
async function postAndCloseDocument(params, ctx) {
    const res = await enqueueCommand(require('./posting').ACTION.POST, params || {}, ctx);
    if (res && res.ok) res.closeForm = true;
    return res;
}

/**
 * ГРУППОВОЕ проведение: выделение в журнале → одна постановка на список.
 * Итог придёт ОДНИМ уведомлением — его собирает проход очереди (postingRunner.tally).
 */
async function postMany({ table, uids }, ctx) {
    const sessionID = ctx && ctx.sessionID;
    if (!table || !Array.isArray(uids) || !uids.length) {
        return { error: await say(sessionID, 'posting_refuse_no_selection', 'Не выбрано ни одного документа') };
    }
    const postingQueue = require('./postingQueue');
    const rows = await postingQueue.enqueueMany({
        table, uids,
        action: require('./posting').ACTION.POST,
        requestedBy: await actorOf(sessionID),
        byHuman: true,
        sessionID
    });
    try { await postingQueue.kick(); } catch (e) { /* подберёт страхующий тик */ }
    for (const r of rows) notify(table, 'update', r.documentUID);
    return { ok: true, table, queued: rows.length, requested: uids.length };
}

/**
 * «Движения» — показать, что документ сделал с учётом.
 *
 * Команда ничего не считает и не пишет: она только ОТКРЫВАЕТ окно. Всё
 * содержимое строит форма движений из объявления документа и его регистров
 * (drive_root/db/movementsForm.js), а каждая вкладка внутри — обычный журнал
 * регистра с отбором по регистратору.
 *
 * Доступна ВСЕГДА, в том числе у непроведённого документа: «проведён, а движений
 * нет» — то, что человек обязан суметь увидеть, а не то, от чего его оберегают
 * погашенной кнопкой.
 */
async function movementsCommand(params, ctx) {
    const { table, uid } = params || {};
    const sessionID = ctx && ctx.sessionID;
    if (!table || !uid) {
        return { error: await say(sessionID, 'storno_refuse_no_target', 'Документ не найден') };
    }
    const movementsForm = require('./movementsForm');
    return {
        ok: true, table, documentUID: uid,
        open: {
            appName: 'uniForm',
            params: {
                mode: 'record',
                tableName: movementsForm.TABLE,
                sourceTable: table,
                sourceUID: uid
            }
        }
    };
}

/**
 * Причина неудачи проведения — по требованию, по `(table, uid)`.
 *
 * Текста ошибки в ДОКУМЕНТЕ нет намеренно (§6.2): он живёт в строке очереди.
 * Иначе каждая неудачная попытка писала бы в документ — то есть пробивала бы
 * замок неизменности и засоряла журнал изменений.
 */
async function postingInfo({ table, uid }, ctx) {
    if (!table || !uid) return { error: 'no target' };
    const sessionID = ctx && ctx.sessionID;
    const posting = require('./posting');
    const info = await require('./postingQueue').errorOf(table, uid);

    // Причина переводится ЗДЕСЬ, на языке того, кто спросил: подсказку в журнале
    // и пометку на форме смотрит не обязательно тот, кто вызвал попытку.
    if (info && info.errorKey) {
        try {
            const forms = require('../../drive_forms/globalServerContext');
            const text = await forms.tfForSession(info.errorKey, sessionID, info.errorVars || {});
            if (text && text !== info.errorKey) info.error = text;
        } catch (e) { /* без перевода останется технический текст */ }
    }

    // Состояние самого документа читаем рядом: форма, ждущая окончания проведения,
    // обязана узнать об окончании, а строка очереди к этому моменту уже снята —
    // «строки нет» одинаково значит и «провелось», и «никогда не стояло».
    let state = null;
    let unpostAllowed = false;
    let statusField = null;
    let status = null;
    try {
        const globalCtx = require('../globalServerContext');
        const dbGateway = require('../dbGateway');
        const modelName = globalCtx.getModelNameForTable(table);
        const Model = modelName ? globalCtx.modelsDB[modelName] : null;
        const cfg = Model && posting.readConfig(Model);
        const rows = await dbGateway.execute({
            operation: 'read', table, where: { UID: uid },
            options: { raw: true, limit: 1 },
            context: { sessionID: ctx && ctx.sessionID }
        });
        const doc = rows && rows[0];
        if (doc) {
            state = doc[posting.STATE_FIELD] || posting.STATE.NOT_POSTED;
            // Состояние ДОКУМЕНТА (не проведения) нужно форме отдельно: проведение
            // могло его сменить (`statusOnPost`), и тогда постоянный замок
            // неизменности обязан защёлкнуться сразу, а не при следующем открытии.
            if (cfg) {
                statusField = cfg.statusField;
                status = doc[cfg.statusField] === undefined ? null : doc[cfg.statusField];
            }
            // Доступность «распровести» решает ОБЪЯВЛЕНИЕ документа, а не форма:
            // счёт распроведению не подлежит, денежный документ — из черновика.
            if (cfg && cfg.unpost.length) {
                // Та же проверка, что в `posting.runOne`: сравнивать `unpost` можно
                // только с ДЕЛОВЫМ состоянием. Его может не быть вовсе, а у
                // денежного документа оно и есть состояние проведения — тогда
                // ограничивать нечем, и распроведение разрешено.
                const hasStatus = !cfg.statusIsPostingState
                    && Object.prototype.hasOwnProperty.call(doc, cfg.statusField);
                unpostAllowed = !hasStatus || cfg.unpost.indexOf(doc[cfg.statusField]) !== -1;
            }
        }
    } catch (e) {
        console.error(`[documentCommands] postingInfo ${table}[${uid}]: ${e.message}`);
    }

    return {
        ok: true, table, documentUID: uid,
        info: info || null,
        // `phase` — то, что форма пишет в заголовок: «в очереди» → «проводится» →
        // ничего. Строки очереди нет — значит проведение закончилось.
        phase: info ? info.phase : null,
        // ЧТО именно стоит в очереди. Строка «документ в очереди …» обязана это
        // назвать: у проведения и у его отмены разные последствия, и человек,
        // снимающий задачу с очереди, должен видеть, какую именно он снимает.
        queueAction: info ? (info.action || null) : null,
        state,
        unpostAllowed,
        stateField: posting.STATE_FIELD,
        statusField,
        status
    };
}

/** Регистрация серверного скрипта команд. Зовётся один раз при старте. */
function register(loadServerScript) {
    return loadServerScript('document.actions', {
        storno: stornoDocument,
        correct: correctDocument,
        invalidate: invalidateCommand,
        post: postDocument,
        unpost: unpostDocument,
        cancelQueue: cancelQueueCommand,
        postAndClose: postAndCloseDocument,
        postMany: postMany,
        postingInfo: postingInfo,
        movements: movementsCommand
    }, 'user');
}

module.exports = {
    register, stornoDocument, correctDocument, invalidateCommand,
    postDocument, unpostDocument, cancelQueueCommand, postAndCloseDocument, postMany,
    postingInfo, movementsCommand
};
