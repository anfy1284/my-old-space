'use strict';

/**
 * posting — ПРОВЕДЕНИЕ ДОКУМЕНТА (ТЗ «Проведение документов», §5, §6, §9).
 *
 * Проведение — момент, когда документ перестаёт быть бумажкой и начинает что-то
 * значить для учёта: он кладёт ДВИЖЕНИЯ в регистры. До этого механизма всё, что
 * документ «делает», приложение писало руками в своих серверных функциях, и рядом
 * обязано было написать отмену этого — вторую функцию, которая рано или поздно
 * разошлась бы с первой.
 *
 * ГЛАВНОЕ РЕШЕНИЕ, из которого следует остальное: **движения принадлежат документу**.
 * Ядро само удаляет всё, что документ создал, по метке регистратора. Поэтому
 * приложение пишет ТОЛЬКО проведение; обработчика распроведения не существует как
 * понятия, и разойтись с проведением ему негде.
 *
 * ОБЪЯВЛЕНИЕ — `entityConfig.posting` в `db.json` документа. Блока нет — документ не
 * проводится вообще, и ничего лишнего ему не добавляется (ни поля, ни команд):
 *
 *     "posting": {
 *       "mode": "manual",            // manual — есть команды; auto — очередь при каждом сохранении
 *       "handler": "cash.post",      // именованная функция, entityHooks.register
 *       "unpost": ["draft"],         // из каких состояний разрешено распроведение; [] — запрещено
 *       "captions": { "post": {...}, "unpost": {...}, "postAndClose": {...}, "state": {...} },
 *       "writes":  ["reg_cash"],     // в какие регистры пишет
 *       "writesTables": [],          // какие ещё таблицы создаёт (метятся регистратором)
 *       "depends": [ { "register": "reg_cash", "dimensions": { "cashboxId": "cashboxId" } } ],
 *       "statusOnPost": null, "statusOnUnpost": null
 *     }
 *
 * ПРОВЕДЕНИЕ ВСЕГДА ОТЛОЖЕННОЕ. Синхронного нет ни в одном режиме: единственный
 * исполнитель — очередь (`postingQueue.js`), и она же единственное место, откуда
 * зовётся `runOne` этого модуля. Режим `auto` прячет только команды и слово
 * «провести»; всё остальное — очередь, возможность остаться непроведённым,
 * уведомление о неудаче — работает одинаково, иначе пользователь, которому спрятали
 * кнопку, никак не узнал бы, что документ не в порядке.
 *
 * СОСТОЯНИЕ (`postingState`) впрыскивается ядром ТОЛЬКО в таблицы, объявившие
 * `posting`, и пишется ТОЛЬКО на переходах. Первая неудача ставит `error` один раз —
 * дальше документ не трогается вообще. Именно это делает бесконечные повторы
 * безвредными для замка неизменности и для журнала изменений.
 */

const serviceFields = require('./serviceFields');
const coreWrite = require('./coreWrite');
const registers = require('./registers');
const entityMoment = require('./entityMoment');

/** Состояния проведения документа. */
const STATE = {
    NOT_POSTED: 'notPosted',
    QUEUED: 'queued',
    POSTED: 'posted',
    ERROR: 'error'
};

/** Имя служебного реквизита состояния. */
const STATE_FIELD = 'postingState';

/** Действия очереди. */
const ACTION = { POST: 'post', UNPOST: 'unpost' };

// ── Объявление ───────────────────────────────────────────────────────────────

/**
 * Нормализованная конфигурация проведения модели (или `null`, если документ не
 * проводится). Одно место чтения объявления: разбирать `entityConfig.posting` в
 * пяти местах — верный способ получить пять слегка разных пониманий одного ключа.
 *
 * @param {object} ModelOrDef — модель Sequelize с `entityConfig` либо определение модели
 * @returns {object|null}
 */
function readConfig(ModelOrDef) {
    const ec = ModelOrDef && ModelOrDef.entityConfig;
    const cfg = ec && ec.posting;
    if (!cfg) return null;
    return {
        mode: cfg.mode === 'auto' ? 'auto' : 'manual',
        handler: cfg.handler || null,
        unpost: Array.isArray(cfg.unpost) ? cfg.unpost : [],
        captions: cfg.captions || {},
        writes: Array.isArray(cfg.writes) ? cfg.writes : [],
        writesTables: Array.isArray(cfg.writesTables) ? cfg.writesTables : [],
        depends: Array.isArray(cfg.depends) ? cfg.depends : [],
        statusOnPost: cfg.statusOnPost || null,
        statusOnUnpost: cfg.statusOnUnpost || null,
        statusField: (ec.immutable && ec.immutable.field) || 'status',
        // Поле состояния документа СОВПАДАЕТ с состоянием проведения? Так у
        // документа, у которого нет деловой жизни помимо проведения (денежный):
        // замок неизменности стоит прямо на `postingState`. Тогда список `unpost`
        // сравнивать НЕ С ЧЕМ: он перечисляет деловые состояния, а тут их нет.
        statusIsPostingState: ((ec.immutable && ec.immutable.field) || 'status') === STATE_FIELD
    };
}

/** Документ объявил проведение? */
function isPostable(ModelOrDef) {
    return !!readConfig(ModelOrDef);
}

/**
 * Впрыснуть реквизит состояния проведения. Только документам, объявившим `posting`:
 * документу без проведения это поле не значит ничего, и его присутствие сбивало бы
 * с толку — в журнале появилась бы вечно пустая колонка «проведён».
 *
 * Вызывается из тех же двух точек, что `entityMoment` (миграция + рантайм).
 * Идемпотентно.
 *
 * @param {object} def — определение модели (мутируется in-place)
 * @returns {boolean}
 */
function injectPostingState(def) {
    if (!readConfig(def)) return false;
    if (!def.fields) def.fields = {};
    def.fields[STATE_FIELD] = {
        type: 'STRING',
        allowNull: false,
        // Пустое состояние — «не проведён», а не NULL: как и у прочих типов, у
        // состояния есть собственное пустое значение (drive_root/db/emptyValues.js).
        defaultValue: STATE.NOT_POSTED,
        service: true,
        caption: { i18n: 'posting_state_field' },
        // Без `inputType` ячейка списка печатает СЫРОЕ значение: «notPosted»
        // вместо «Nicht gebucht». Набор значений сам по себе расшифровку не
        // включает — её делает контрол, а контрол выбирается по этому ключу
        // (так же объявлено поле состояния документа в прикладных моделях).
        inputType: 'emunList',
        // Расшифровка едет вместе с полем — и в колонку журнала, и в автоформу
        // (см. globalServerContext.getTableMetadata → explicitOptions).
        options: [
            { value: STATE.NOT_POSTED, caption: { i18n: 'posting_state_not_posted' } },
            { value: STATE.QUEUED, caption: { i18n: 'posting_state_queued' } },
            { value: STATE.POSTED, caption: { i18n: 'posting_state_posted' } },
            { value: STATE.ERROR, caption: { i18n: 'posting_state_error' } }
        ]
    };
    serviceFields.markService(def.fields[STATE_FIELD]);

    // Индекс по состоянию: каскад ищет «проведённые документы позже момента», и без
    // него этот поиск пойдёт сканом по каждой документной таблице.
    def.options = def.options || {};
    const indexes = Array.isArray(def.options.indexes) ? def.options.indexes : [];
    const already = indexes.some(i => Array.isArray(i.fields) && i.fields.length === 3
        && i.fields[0] === STATE_FIELD);
    def.options.indexes = indexes;
    if (!already) def.options.indexes.push({ fields: [STATE_FIELD, 'date', 'seq'] });
    return true;
}

/** Применить ко всему массиву определений. @returns {number} */
function injectPostingStates(defs) {
    if (!Array.isArray(defs)) return 0;
    let n = 0;
    for (const def of defs) if (injectPostingState(def)) n++;
    return n;
}

/** Документные таблицы, объявившие проведение: `[{ table, config }]`. */
function postableTables(defs) {
    const out = [];
    for (const def of defs || []) {
        const cfg = readConfig(def);
        if (cfg && def.tableName) out.push({ table: def.tableName, name: def.name, config: cfg });
    }
    return out;
}

/** То же по определениям текущего процесса. */
function postableTablesOfProcess() {
    try {
        const globalCtx = require('../globalServerContext');
        return postableTables(globalCtx.collectMergedModelDefs().models);
    } catch (e) {
        console.error('[posting] Список проводимых таблиц недоступен:', e && e.message || e);
        return [];
    }
}

// ── Состояние ────────────────────────────────────────────────────────────────

/**
 * Записать состояние проведения.
 *
 * Пишется ТОЛЬКО на переходе (вызывающий обязан сравнить) и ТОЛЬКО этим путём: право
 * на запись служебного поля закрытого документа выдаётся узким токеном ядра, а не
 * системной сессией — системная сессия открыла бы весь замок целиком.
 *
 * @param {object} p — `{ table, uid, state, sessionID, transaction }`
 */
async function setState(p) {
    const dbGateway = require('../dbGateway');
    await dbGateway.execute({
        operation: 'update',
        table: p.table,
        where: { UID: p.uid },
        data: { [STATE_FIELD]: p.state },
        options: p.transaction ? { transaction: p.transaction } : {},
        context: {
            sessionID: p.sessionID,
            transaction: p.transaction,
            coreWrite: coreWrite.grant([STATE_FIELD])
        }
    });
}

/**
 * КОНТЕКСТ ЗАПИСИ ВНУТРИ ПРОВЕДЕНИЯ.
 *
 * Любая запись, сделанная проведением, обязана быть УЗНАВАЕМОЙ — иначе она
 * возвращается в механизм через чёрный ход: middleware `postingEnqueueMiddleware`
 * видит обычное сохранение документа и ставит его в очередь ЗАНОВО. Документ,
 * проведение которого меняет его же реквизит (связка `statusOnPost`, проверочный
 * документ каскада), проводился бы бесконечно.
 *
 * Метка — пустое право ядра (`coreWrite.grant([])`): узнаваемость есть, а замок
 * неизменности и дата запрета при этом остаются в полной силе. Ни одного поля
 * такое право не открывает — оно только отвечает на вопрос «кто пишет».
 *
 * @param {object} tx — транзакция проведения
 * @param {string} sessionID — служебная сессия инициатора
 * @returns {object} контекст для `dbGateway.execute`
 */
function postingContext(tx, sessionID) {
    return { sessionID, transaction: tx, coreWrite: coreWrite.grant([]) };
}

/**
 * Шлюз, выдаваемый обработчику приложения.
 *
 * Обработчик обязан писать через него, а не через `require('dbGateway')` напрямую:
 * иначе его записи выпадут из транзакции проведения и вернутся в очередь как
 * обычное сохранение. Ничего, кроме подстановки транзакции и метки, он не делает —
 * это тот же `dbGateway`, и все правила к нему применяются те же.
 */
function postingGateway(tx, sessionID) {
    const dbGateway = require('../dbGateway');
    return {
        execute: async function executeInPosting(request) {
            return await dbGateway.execute(Object.assign({}, request, {
                options: Object.assign({}, request.options, { transaction: tx }),
                context: Object.assign({}, postingContext(tx, sessionID), request.context || {},
                    { transaction: tx, coreWrite: coreWrite.grant([]) })
            }));
        },
        transaction: dbGateway.transaction
    };
}

// ── Движения ─────────────────────────────────────────────────────────────────

/**
 * API записи движений, выдаваемое обработчику приложения.
 *
 * Обработчик не знает ни о регистраторе, ни о моменте времени, ни о нумерации строк —
 * их проставляет ядро. Это не забота об удобстве: метка регистратора и есть то, чем
 * ядро потом снимет движения, и если её проставление оставить приложению, однажды
 * появится движение-сирота, которое нечем удалить.
 *
 * @param {object} p — `{ table, uid, doc, config, transaction, sessionID }`
 */
function movementsApi(p) {
    const dbGateway = require('../dbGateway');
    const counters = new Map();

    function nextLineNo(target) {
        const n = (counters.get(target) || 0) + 1;
        counters.set(target, n);
        return n;
    }

    /** Момент времени регистратора — он же момент движения. */
    const period = p.doc ? p.doc[entityMoment.DATE_FIELD] : null;
    const seq = p.doc ? p.doc[entityMoment.FIELD] : 0;

    return {
        /**
         * Записать движения в регистр.
         * @param {string} register — имя таблицы регистра; обязан быть перечислен в `writes`
         * @param {Array<object>} rows — `{ sign, <измерения>, <ресурсы>, <реквизиты> }`
         */
        write: async function writeMovements(register, rows) {
            if (p.config.writes.indexOf(register) === -1) {
                throw new Error(`[posting] ${p.table}: регистр "${register}" не объявлен в posting.writes —`
                    + ' ядро не смогло бы снять эти движения при перепроведении');
            }
            const cfg = registers.get(register);
            if (!cfg) throw new Error(`[posting] Регистр "${register}" не объявлен`);

            for (const row of (rows || [])) {
                const sign = Number(row.sign) < 0 ? -1 : 1;
                const data = Object.assign({}, row, {
                    sign,
                    period,
                    seq,
                    recorderTable: p.table,
                    recorderUID: p.uid,
                    lineNo: nextLineNo(register)
                });
                await dbGateway.execute({
                    operation: 'create',
                    table: register,
                    data,
                    options: { transaction: p.transaction },
                    context: {
                        sessionID: p.sessionID,
                        transaction: p.transaction,
                        coreWrite: registers.writeGrant()
                    }
                });
            }
        },

        /**
         * Записать строки в произвольную таблицу, помеченные регистратором.
         * Таблица обязана быть перечислена в `posting.writesTables` — иначе ядро о ней
         * не знает и не снимет эти строки. Правило жёсткое: ВСЁ, что создано
         * проведением, помечено регистратором, и удаляет это ядро.
         */
        writeRows: async function writePostingRows(table, rows) {
            if (p.config.writesTables.indexOf(table) === -1) {
                throw new Error(`[posting] ${p.table}: таблица "${table}" не объявлена в`
                    + ' posting.writesTables — ядро не смогло бы снять эти строки');
            }
            for (const row of (rows || [])) {
                await dbGateway.execute({
                    operation: 'create',
                    table,
                    data: Object.assign({}, row, {
                        recorderTable: p.table,
                        recorderUID: p.uid
                    }),
                    options: { transaction: p.transaction },
                    context: {
                        sessionID: p.sessionID,
                        transaction: p.transaction,
                        coreWrite: coreWrite.grant(coreWrite.ALL)
                    }
                });
            }
        }
    };
}

/**
 * Снять ВСЁ, что документ когда-либо создал проведением.
 *
 * Зовётся и перед проведением, и при распроведении — одним и тем же кодом, потому что
 * это одно и то же действие. Именно здесь живёт гарантия «отмена снимет всё»: она не
 * зависит от того, что обработчик приложения помнит о своих прошлых движениях.
 *
 * @returns {Promise<Array<object>>} снятые движения (нужны каскаду: по ним видно,
 *   какие разрезы регистров документ затрагивал ДО правки)
 */
async function clearMovements(p) {
    const dbGateway = require('../dbGateway');
    const removed = [];

    for (const register of p.config.writes) {
        if (!registers.isRegisterTable(register)) continue;
        const rows = await dbGateway.execute({
            operation: 'read',
            table: register,
            where: { recorderTable: p.table, recorderUID: p.uid },
            options: { raw: true, transaction: p.transaction },
            context: { sessionID: p.sessionID, transaction: p.transaction }
        });
        for (const r of (rows || [])) removed.push(Object.assign({ __register: register }, r));

        await dbGateway.execute({
            operation: 'delete',
            table: register,
            where: { recorderTable: p.table, recorderUID: p.uid },
            options: { transaction: p.transaction },
            context: {
                sessionID: p.sessionID,
                transaction: p.transaction,
                coreWrite: registers.writeGrant()
            }
        });
    }

    for (const table of p.config.writesTables) {
        await dbGateway.execute({
            operation: 'delete',
            table,
            where: { recorderTable: p.table, recorderUID: p.uid },
            options: { transaction: p.transaction },
            context: {
                sessionID: p.sessionID,
                transaction: p.transaction,
                coreWrite: coreWrite.grant(coreWrite.ALL)
            }
        });
    }

    return removed;
}

// ── Проведение одного документа ──────────────────────────────────────────────

/** Ошибка проведения: текст доезжает до строки очереди и до подсказки в журнале. */
class PostingError extends Error {
    /**
     * @param {string} message  — технический текст; идёт в журнал сервера как есть.
     * @param {string} code     — машинный код отказа.
     * @param {string} errorKey — КЛЮЧ ПЕРЕВОДА причины. Причину видит пользователь
     *   (уведомление, пометка на форме, подсказка журнала), поэтому она обязана
     *   быть на его языке; `message` остаётся запасным вариантом.
     * @param {object} vars     — подстановки для этого ключа.
     */
    constructor(message, code, errorKey, vars) {
        super(message);
        this.name = 'PostingError';
        this.code = code || 'POSTING_FAILED';
        this.errorKey = errorKey || null;
        this.errorVars = vars || null;
    }
}

/**
 * Провести или распровести ОДИН документ. Единственный вызывающий — очередь.
 *
 * Всё, что ниже, — в одной транзакции (ТЗ §9.1). Сотня документов одной транзакцией
 * не пойдёт, поэтому граница именно здесь: один документ — одна транзакция.
 *
 * @param {object} p — `{ table, uid, action, sessionID, requestedBy }`
 * @returns {Promise<object>} `{ table, uid, action, state, movements, removed, moment }`
 */
async function runOne(p) {
    const dbGateway = require('../dbGateway');
    const globalCtx = require('../globalServerContext');
    const auditLog = require('./auditLog');

    const table = p.table;
    const uid = p.uid;
    const action = p.action === ACTION.UNPOST ? ACTION.UNPOST : ACTION.POST;

    const modelName = globalCtx.getModelNameForTable(table);
    const Model = modelName ? globalCtx.modelsDB[modelName] : null;
    if (!Model) throw new PostingError(`[posting] Таблица "${table}" неизвестна`, 'UNKNOWN_TABLE',
        'posting_err_unknown_table', { table });

    const config = readConfig(Model);
    if (!config) throw new PostingError(`[posting] Документ "${table}" не объявил проведение`, 'NOT_POSTABLE',
        'posting_refuse_not_postable');

    return await dbGateway.transaction(async (tx) => {
        // 1. Документ. Читаем через шлюз — RLS применяется так же, как к человеку:
        //    проведение идёт под служебной сессией владельца задания, а не в обход правил.
        const rows = await dbGateway.execute({
            operation: 'read',
            table,
            where: { UID: uid },
            options: { raw: true, limit: 1, transaction: tx },
            context: { sessionID: p.sessionID, transaction: tx }
        });
        const doc = rows && rows[0];
        if (!doc) {
            // Документа нет — проводить нечего. Это не ошибка: его могли удалить,
            // пока строка ждала в очереди.
            return { table, uid, action, state: null, gone: true, movements: [], removed: [] };
        }

        // 2. Допустимость действия.
        const currentState = doc[STATE_FIELD] || STATE.NOT_POSTED;
        if (action === ACTION.UNPOST) {
            if (!config.unpost.length) {
                throw new PostingError(`[posting] ${table}: распроведение запрещено`, 'UNPOST_DENIED',
                    'posting_refuse_unpost_denied');
            }
            // `unpost` перечисляет ДЕЛОВЫЕ состояния, из которых распроведение
            // разрешено. Сравнивать с ними можно только когда деловое состояние
            // существует и отличается от состояния проведения. Два случая, когда
            // сравнивать не с чем:
            //   - поля состояния у документа нет вовсе (`immutable` не объявлен);
            //   - оно И ЕСТЬ состояние проведения (денежный документ).
            // Во втором случае проверка не просто бессмысленна, а разрушительна:
            // постановка в очередь сама меняет `postingState` на `queued`, потом на
            // `error`, и «распроведение из состояния "error" запрещено» становится
            // вечным — документ остаётся в очереди навсегда и пробуется бесконечно.
            const hasStatus = !config.statusIsPostingState
                && Object.prototype.hasOwnProperty.call(doc, config.statusField);
            const docStatus = doc[config.statusField];
            if (hasStatus && config.unpost.indexOf(docStatus) === -1) {
                throw new PostingError(
                    `[posting] ${table}: распроведение из состояния "${docStatus}" запрещено`,
                    'UNPOST_DENIED', 'posting_err_unpost_from_state', { state: docStatus });
            }
        }

        // 3. Снять всё, что документ создал раньше. Делает ядро — обработчик об этом
        //    не знает и знать не должен.
        const removed = await clearMovements({ table, uid, config, transaction: tx, sessionID: p.sessionID });

        // 4. Проведение: вызвать обработчик приложения.
        let written = [];
        if (action === ACTION.POST) {
            if (!config.handler) {
                throw new PostingError(`[posting] ${table}: не объявлен обработчик проведения`, 'NO_HANDLER',
                    'posting_err_no_handler', { handler: '—' });
            }
            // Обработчик ищется в ФАЙЛОВОМ реестре (`posting.handlers.js`), а не
            // только в `entityHooks`: проведение выполняется в форкнутом воркере
            // планировщика, а `init.js` приложения выполняет лишь главный процесс.
            // Императивная регистрация в воркере не существует, и документ падал
            // с «обработчик не зарегистрирован» (drive_root/db/postingHandlers.js).
            const fn = require('./postingHandlers').resolve(config.handler);
            if (typeof fn !== 'function') {
                throw new PostingError(`[posting] ${table}: обработчик "${config.handler}" не зарегистрирован`
                    + ` (объявите его в apps/<app>/posting.handlers.js — файл грузят оба процесса)`,
                    'NO_HANDLER', 'posting_err_no_handler', { handler: config.handler });
            }
            const movements = movementsApi({ table, uid, doc, config, transaction: tx, sessionID: p.sessionID });
            await fn(doc, {
                table, uid,
                transaction: tx,
                sessionID: p.sessionID,
                requestedBy: p.requestedBy || null,
                movements,
                // Шлюз ПРОВЕДЕНИЯ, а не голый dbGateway: подставляет транзакцию и
                // метку «пишет проведение» (см. postingGateway).
                dbGateway: postingGateway(tx, p.sessionID),
                moment: { date: doc[entityMoment.DATE_FIELD], seq: doc[entityMoment.FIELD] }
            });
            // Что записалось — перечитываем, а не верим намерению: каскаду нужны
            // ФАКТИЧЕСКИЕ значения измерений, и брать их из памяти обработчика
            // значило бы завести второй источник правды о движениях.
            for (const register of config.writes) {
                if (!registers.isRegisterTable(register)) continue;
                const rowsR = await dbGateway.execute({
                    operation: 'read', table: register,
                    where: { recorderTable: table, recorderUID: uid },
                    options: { raw: true, transaction: tx },
                    context: { sessionID: p.sessionID, transaction: tx }
                });
                for (const r of (rowsR || [])) written.push(Object.assign({ __register: register }, r));
            }
        }

        // 5. Связка с состоянием документа, если объявлена.
        const nextStatus = action === ACTION.POST ? config.statusOnPost : config.statusOnUnpost;
        if (nextStatus && doc[config.statusField] !== nextStatus) {
            await dbGateway.execute({
                operation: 'update',
                table,
                where: { UID: uid },
                data: { [config.statusField]: nextStatus },
                options: { transaction: tx },
                // Метка «пишет проведение»: без неё связка statusOnPost вернула бы
                // документ в очередь, и он проводился бы бесконечно. Замок при
                // этом не снимается — переход проверяется как обычно.
                context: postingContext(tx, p.sessionID)
            });
        }

        // 6. Состояние проведения — только если оно изменилось.
        const nextState = action === ACTION.POST ? STATE.POSTED : STATE.NOT_POSTED;
        if (currentState !== nextState) {
            await setState({ table, uid, state: nextState, sessionID: p.sessionID, transaction: tx });
        }

        // 6а. Пометка на удаление, заказанная вместе с распроведением.
        //     Человек нажал «пометить» на проведённом документе; помеченным
        //     может быть только тот, кого можно удалить, поэтому сначала снимаем
        //     движения, а пометку ставим ЗДЕСЬ ЖЕ, в той же транзакции. Иначе
        //     между «распровёлся» и «пометился» остаётся щель, в которой документ
        //     не проведён и не помечен — и никто не знает, что с ним хотели
        //     сделать (drive_root/db/deletionMark.js).
        if (action === ACTION.UNPOST && p.thenMark) {
            const deletionMark = require('./deletionMark');
            await dbGateway.execute({
                operation: 'update',
                table,
                where: { UID: uid },
                data: { [deletionMark.FIELD]: true },
                options: { transaction: tx },
                // Пишет механизм — иначе документ снова уедет в очередь.
                context: postingContext(tx, p.sessionID)
            });
        }

        // 7. Журнал (GoBD: проведение и распроведение — учётные операции).
        const actor = p.requestedBy || null;
        try {
            await auditLog.append({
                documentTable: table,
                documentUID: uid,
                organizationId: doc.organizationId || null,
                operation: action === ACTION.POST ? 'post' : 'unpost',
                changedAt: new Date().toISOString(),
                userId: actor,
                userName: null,
                before: JSON.stringify({ postingState: currentState, movements: removed.length }),
                after: JSON.stringify({ postingState: nextState, movements: written.length })
            });
        } catch (e) {
            // Незаписанная строка журнала — дыра в цепочке, молчать нельзя; но и
            // откатывать уже выполненное проведение из-за журнала неверно.
            console.error('[posting] Запись в журнал не выполнена:', e && e.message || e);
        }

        return {
            table, uid, action,
            state: nextState,
            moment: { date: doc[entityMoment.DATE_FIELD], seq: doc[entityMoment.FIELD] },
            movements: written,
            removed
        };
    });
}

module.exports = {
    STATE,
    STATE_FIELD,
    ACTION,
    PostingError,
    readConfig,
    isPostable,
    injectPostingState,
    injectPostingStates,
    postableTables,
    postableTablesOfProcess,
    setState,
    clearMovements,
    postingContext,
    postingGateway,
    runOne
};
