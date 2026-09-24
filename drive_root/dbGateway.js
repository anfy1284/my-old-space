/**
 * dbGateway — единая точка входа для всех операций с базой данных.
 * 
 * Запрос проходит каскадно через middleware трёх уровней:
 *   APP → DRIVE_FORMS → DRIVE_ROOT → EXECUTOR (Sequelize)
 * Результат возвращается обратно снизу вверх.
 *
 * Каждый middleware: async (request, next) => result
 *   - может изменить request перед вызовом next()
 *   - может заблокировать запрос (не вызвать next, бросить ошибку)
 *   - может изменить result после получения от next()
 */

const LEVELS = ['app', 'forms', 'root'];

// Пустые значения по типам (NULL только у ссылок) — единая реализация,
// та же, что применяется к схеме до sequelize.define.
const emptyValues = require('./db/emptyValues');

/**
 * Нормализация значений перед записью (create/update). Мутирует data in-place.
 *
 * ПРАВИЛО: NULL в базе допустим ТОЛЬКО у полей-ссылок. У каждого остального
 * типа своё пустое значение — число 0, строка "", булево false, дата
 * 0001-01-01. Обоснование и константы — `drive_root/db/emptyValues.js`.
 *
 * Это вторая половина механизма: схема задаёт умолчание для НОВЫХ строк
 * (инъекция в `events_handler.js#onModelsPostCollect`), а здесь ловятся
 * значения, пришедшие с формы, из скрипта или из внешнего вызова — там
 * пустое поле приезжает как "" либо как null и до умолчания схемы не
 * доходит, потому что ключ в объекте присутствует.
 *
 * Ссылки: "" → null. Postgres не принимает пустую строку в FK-колонке, а
 * «ссылки нет» — это и есть NULL, единственный законный случай.
 */
function sanitizeData(Model, data) {
    if (!Model || !Model.rawAttributes || !data) return;
    Object.keys(data).forEach(k => {
        const attr = Model.rawAttributes[k];
        if (!attr) return;
        const v = data[k];
        if (!emptyValues.isEmptyValue(v)) return;

        // Поле-ссылка — единственное место, где NULL законен.
        if (emptyValues.isReferenceField(attr)) {
            if (v === '') data[k] = null;
            return;
        }

        const empty = emptyValues.emptyValueFor(attr);
        // Тип не распознан — не трогаем: лучше оставить как есть, чем
        // записать выдуманное значение в поле, устройства которого мы
        // не поняли.
        if (empty === undefined) return;

        // defaultValue из схемы важнее общего пустого значения типа: если
        // автор поля объявил своё умолчание, оно и есть «пусто» для него.
        // Но только когда значение вообще не передали (undefined). Пустая
        // строка и null — это осознанная очистка поля пользователем, и она
        // обязана давать пустое значение типа, а не умолчание автора.
        if (v === undefined && attr.defaultValue !== undefined && attr.defaultValue !== null) {
            data[k] = attr.defaultValue;
            return;
        }
        data[k] = empty;
    });
}

// Хранилище middleware по уровням
// Каждый уровень — массив функций (request, next) => result
const middlewareRegistry = {
    app: [],
    forms: [],
    root: []
};

/**
 * Регистрация middleware на определённом уровне.
 * @param {'app'|'forms'|'root'} level — уровень
 * @param {Function} fn — async (request, next) => result
 */
function use(level, fn) {
    if (!LEVELS.includes(level)) {
        throw new Error(`[dbGateway] Unknown level: "${level}". Allowed: ${LEVELS.join(', ')}`);
    }
    if (typeof fn !== 'function') {
        throw new Error('[dbGateway] Middleware must be a function');
    }
    middlewareRegistry[level].push(fn);
    _cachedChain = null; // 5.1: состав middleware изменился — пересоберём цепочку лениво
    console.log(`[dbGateway] Registered middleware at level "${level}" (total: ${middlewareRegistry[level].length})`);
}

/**
 * Executor — конечная точка, выполняющая реальный запрос к Sequelize.
 * @param {Object} request — объект запроса
 * @returns {Promise<any>} — результат операции
 */
async function executor(request) {
    const { operation, table, where, data, options = {}, context = {} } = request;

    // Получить модель из globalServerContext (lazy require чтобы избежать circular dependency)
    const globalCtx = require('./globalServerContext');
    const modelName = globalCtx.getModelNameForTable(table);
    if (!modelName) {
        throw new Error(`[dbGateway] Model not found for table: "${table}"`);
    }
    const Model = globalCtx.modelsDB[modelName];
    if (!Model) {
        throw new Error(`[dbGateway] Model "${modelName}" not found in modelsDB`);
    }

    switch (operation) {
        case 'read': {
            const queryOpts = { ...options };
            if (where) queryOpts.where = where;
            return await Model.findAll(queryOpts);
        }

        case 'findByPk': {
            const id = (where && where.UID) || data;
            if (id == null) throw new Error('[dbGateway] findByPk requires where.UID or data');
            const queryOpts = { ...options };

            // Only use UID for findByPk replacement
            return await Model.findOne({ where: { UID: id }, ...queryOpts });
        }

        case 'findOne': {
            const queryOpts = { ...options };
            if (where) queryOpts.where = where;
            return await Model.findOne(queryOpts);
        }

        case 'count': {
            const queryOpts = { ...options };
            if (where) queryOpts.where = where;
            return await Model.count(queryOpts);
        }

        case 'create': {
            if (!data) throw new Error('[dbGateway] create requires data');

            // Нормализация пустых строк: "" → null (FK/валидаторы) либо "" → 0 (числа).
            sanitizeData(Model, data);

            if (!data.UID) {
                try {
                    const util = require('./db/utilites');
                    // Используем каноничное имя модели Model.name, чтобы хэш совпадал 
                    // независимо от того, как было передано имя таблицы (users или Users).
                    data.UID = util.generateUID(Model.name);
                } catch(e) {
                    const time = Date.now().toString(36).padStart(9, '0').slice(-9);
                    const hash = '0000000';
                    const random = require('crypto').randomBytes(6).readUIntBE(0, 6).toString(36).padStart(7, '0').slice(-7);
                    data.UID = `${time}-${hash}-${random}`;
                }
            }
            const createResult = await Model.create(data, options);
            // Invalidate FK display cache for this table (display values may have changed)
            try { require('./globalServerContext').invalidateFkCache(Model.tableName); } catch(e) {}
            return createResult;
        }

        case 'update': {
            if (!data) throw new Error('[dbGateway] update requires data');
            if (!where) throw new Error('[dbGateway] update requires where');

            // Нормализация пустых строк (см. ветку 'create' и sanitizeData).
            sanitizeData(Model, data);

            const updateResult = await Model.update(data, { where, ...options });
            // Invalidate FK display cache for this table
            try { require('./globalServerContext').invalidateFkCache(Model.tableName); } catch(e) {}
            return updateResult;
        }

        case 'delete': {
            if (!where) throw new Error('[dbGateway] delete requires where');
            const deleteResult = await Model.destroy({ where, ...options });
            // Invalidate FK display cache for this table
            try { require('./globalServerContext').invalidateFkCache(Model.tableName); } catch(e) {}
            return deleteResult;
        }

        default:
            throw new Error(`[dbGateway] Unknown operation: "${operation}"`);
    }
}

/**
 * Собирает цепочку middleware и executor в единый pipeline.
 * Порядок: app[0], app[1], ..., forms[0], forms[1], ..., root[0], root[1], ..., executor
 */
// 5.1: цепочка middleware пересобиралась на КАЖДЫЙ execute() (замыкания на каждую
// DB-операцию, а их десятки на отрисовку формы). Состав middleware меняется только
// в use()/clearMiddleware() → кэшируем и инвалидируем там.
let _cachedChain = null;

function buildChain() {
    const allMiddleware = [
        ...middlewareRegistry.app,
        ...middlewareRegistry.forms,
        ...middlewareRegistry.root
    ];

    // Строим цепочку от конца к началу (executor → last middleware → ... → first middleware)
    let current = executor;

    for (let i = allMiddleware.length - 1; i >= 0; i--) {
        const mw = allMiddleware[i];
        const nextFn = current;
        current = (request) => mw(request, nextFn);
    }

    return current;
}

/**
 * Главная функция — выполнить запрос к БД через всю цепочку middleware.
 *
 * @param {Object} request
 * @param {string} request.operation — 'read'|'findByPk'|'findOne'|'count'|'create'|'update'|'delete'
 * @param {string} request.table — имя таблицы (как в БД, например 'organizations')
 * @param {Object} [request.where] — условия (для read/findByPk/findOne/count/update/delete)
 * @param {Object} [request.data] — данные (для create/update; для findByPk — id)
 * @param {Object} [request.options] — дополнительные опции Sequelize (sort, limit, offset, raw, transaction...)
 * @param {Object} [request.context] — контекст вызова (sessionID, userId, appName)
 * @returns {Promise<any>}
 */
async function execute(request) {
    if (!request || !request.operation || !request.table) {
        throw new Error('[dbGateway] execute requires {operation, table} at minimum');
    }
    const chain = _cachedChain || (_cachedChain = buildChain());
    const perfMetrics = require('./perfMetrics');
    const perfStartNs = perfMetrics.dbEnter();
    try {
        return await chain(request);
    } finally {
        perfMetrics.dbExit(request.table, request.operation, perfStartNs);
    }
}

/**
 * ВЫПОЛНИТЬ БЛОК В ОДНОЙ ТРАНЗАКЦИИ (ТЗ §9.3).
 *
 * До этого `options.transaction` только пропускался насквозь: каждый вызов обязан был
 * тащить транзакцию за собой руками, и стоило пропустить один — атомарность исчезала
 * молча. Проведение документа этого не переживёт: движения и состояние документа
 * обязаны лечь вместе или не лечь вовсе.
 *
 * Транзакция кладётся и в `options.transaction` (её ждёт Sequelize), и в `context` —
 * из контекста её берут middleware и прикладной код, которым нужно выполнить
 * вложенный запрос в той же транзакции, не получая её параметром через пять этажей.
 *
 * ВЛОЖЕННОСТЬ: если транзакция уже идёт (`ctx.transaction`), новая НЕ открывается —
 * блок выполняется в существующей. Иначе вложенный вызов коммитил бы кусок работы
 * внешнего, и «одна транзакция — один документ» перестало бы быть правдой.
 *
 * @param {Function} fn — async (tx) => result; внутри зовите `execute` с
 *   `options.transaction: tx` (или пользуйтесь `withTransaction` ниже)
 * @param {Object} [outerContext] — контекст вызова; если в нём уже есть транзакция,
 *   используется она
 * @returns {Promise<any>} результат `fn`
 */
async function transaction(fn, outerContext) {
    if (typeof fn !== 'function') throw new Error('[dbGateway] transaction(fn) requires a function');
    if (outerContext && outerContext.transaction) {
        return await fn(outerContext.transaction);
    }
    const sequelize = require('./db/sequelize_instance');
    const tx = await sequelize.transaction();
    try {
        const result = await fn(tx);
        await tx.commit();
        return result;
    } catch (e) {
        try { await tx.rollback(); } catch (e2) { /* уже откатилась */ }
        throw e;
    }
}

/**
 * Запрос, выполняемый в транзакции `tx`. Мелкая, но обязательная вещь: без неё
 * каждый вызов внутри блока повторял бы одну и ту же раскладку `options`/`context`,
 * и однажды кто-нибудь её не повторил бы.
 * @param {Object} tx — транзакция Sequelize
 * @param {Object} request — обычный запрос `execute`
 * @returns {Promise<any>}
 */
async function executeIn(tx, request) {
    return await execute(Object.assign({}, request, {
        options: Object.assign({}, request.options, { transaction: tx }),
        context: Object.assign({}, request.context, { transaction: tx })
    }));
}

/**
 * Очистить все middleware (для тестов или перезагрузки).
 */
function clearMiddleware(level) {
    if (level) {
        if (middlewareRegistry[level]) middlewareRegistry[level] = [];
    } else {
        for (const l of LEVELS) middlewareRegistry[l] = [];
    }
    _cachedChain = null; // 5.1
}

// ── Регистр пишет только проведение ──────────────────────────────────────────
// Движение принадлежит документу-регистратору, и снимает его ядро одним DELETE по
// регистратору. Строка, положенная в регистр мимо проведения, регистратора не имеет —
// удалить её будет нечем и некому, а в остатке она останется навсегда. Поэтому запрет
// не договорённость в инструкции, а проверка: право выдаётся токеном, который живёт
// в памяти механизма проведения и наружу не уезжает (drive_root/db/registers.js).
use('root', async function registerWriteGuard(request, next) {
    const { operation, table } = request;
    if (operation !== 'create' && operation !== 'update' && operation !== 'delete') {
        return await next(request);
    }
    const registers = require('./db/registers');
    if (!registers.isRegisterTable(table)) return await next(request);
    if (registers.mayWrite(request)) return await next(request);

    const e = new Error(`[dbGateway] Прямая запись в регистр "${table}" запрещена:`
        + ' движения пишет только проведение документа.');
    e.errorKey = 'register_direct_write_denied';
    throw e;
});

// ── Неизменность проведённого документа (GoBD) ───────────────────────────────
// Регистрируется ПЕРВЫМ на уровне 'root': отказ должен случиться до того, как
// хуки сущности начнут править данные (номер, представление) и до executor'а.
// Системная сессия (__SYS_INTERNAL__) исключением НЕ является — неизменность
// выставленного документа не про права доступа, а про требование закона.
use('root', async function immutableMiddleware(request, next) {
    const { operation } = request;
    if (operation === 'update' || operation === 'delete' || operation === 'create') {
        const globalCtx = require('./globalServerContext');
        const immutable = require('./db/immutable');
        const sessionID = request.context && request.context.sessionID;

        // Переводчик языка сессии: ключей может не быть — тогда модуль возьмёт
        // собственный запасной текст.
        const t = async (key) => {
            try {
                const forms = require('../drive_forms/globalServerContext');
                return await forms.tForSession(key, sessionID);
            } catch (e) { return null; }
        };

        if (operation === 'create') {
            await immutable.checkInsert(request, globalCtx, t);
        } else {
            await immutable.check(request, globalCtx, t);
        }
    }
    return await next(request);
});

// ── Дата запрета редактирования (GoBD-Festschreibung) ────────────────────────
// Стоит рядом с неизменностью и сразу ПОСЛЕ неё: оба отказа про «этот документ
// трогать нельзя», и порядок между ними неважен, но оба обязаны случиться ДО
// журнала и хуков. Проверяется ДАТА ДОКУМЕНТА, а не дата правки.
use('root', async function closingDateMiddleware(request, next) {
    const { operation } = request;
    if (operation === 'update' || operation === 'delete' || operation === 'create') {
        const globalCtx = require('./globalServerContext');
        const closingDate = require('./db/closingDate');
        const sessionID = request.context && request.context.sessionID;
        const t = async (key) => {
            try {
                const forms = require('../drive_forms/globalServerContext');
                return await forms.tForSession(key, sessionID);
            } catch (e) { return null; }
        };
        await closingDate.check(request, globalCtx, t);
    }
    return await next(request);
});

// ── Журнал изменений документов (GoBD) ───────────────────────────────────────
// Пишет только по таблицам с пометкой `entityConfig.auditLog`. Стоит ПОСЛЕ
// проверки неизменности (отказ журналировать нечего) и ПЕРЕД хуками сущности:
// снимок «после» снимается уже после их работы, когда `data` содержит номер и
// представление, — потому что хуки правят `request.data` по ссылке.
use('root', async function auditLogMiddleware(request, next) {
    const { operation } = request;
    if (operation !== 'create' && operation !== 'update' && operation !== 'delete') {
        return await next(request);
    }

    const globalCtx = require('./globalServerContext');
    const auditLog = require('./db/auditLog');

    const before = await auditLog.snapshotBefore(request, globalCtx);
    const result = await next(request);

    // Сбой журналирования не должен отменять уже выполненную операцию, но и
    // молчать о нём нельзя: незаписанная строка журнала — дыра в цепочке.
    try {
        await auditLog.record(request, globalCtx, before, result);
    } catch (e) {
        console.error('[auditLog] Failed to record change:', e && e.message || e);
    }
    return result;
});

// ── Entity Hooks root-level middleware ───────────────────────────────────────
// Перехватывает create/update и запускает хуки из entityConfig модели.
// Регистрируется на уровне 'root' чтобы срабатывать для всех источников данных.
use('root', async function entityHooksMiddleware(request, next) {
    const { operation, table } = request;

    // Обрабатываем только create (beforeCreate) и update (beforeUpdate)
    if (operation !== 'create' && operation !== 'update') {
        return await next(request);
    }

    // Ленивый require чтобы избежать circular dependency при загрузке модуля
    const globalCtx = require('./globalServerContext');
    const entityHooks = require('./entityHooks');

    const modelName = globalCtx.getModelNameForTable(table);
    const Model = modelName ? globalCtx.modelsDB[modelName] : null;

    if (Model) {
        const event = operation === 'create' ? 'beforeCreate' : 'beforeUpdate';
        const context = {
            modelsDB: globalCtx.modelsDB,
            dbGateway: module.exports,
            sessionID: request.context && request.context.sessionID
        };
        // 1. Декларативные хуки сущности (entityConfig.hooks) — автонумерация и пр.
        if (Model.entityConfig) {
            await entityHooks.runHooks(event, Model, request, context);
        }
        // 2. Представление (поле name) — ПОСЛЕ хуков, чтобы номер уже был присвоен.
        await entityHooks.applyPresentation(operation, Model, request, context);
    }

    return await next(request);
});

// ── Сохранение документа → очередь проведения ────────────────────────────────
// Два разных следствия одного действия человека, и оба обязаны случиться ПОСЛЕ
// успешной записи (запись не прошла — проводить нечего):
//
//   1. режим `auto` — документ уходит в очередь при КАЖДОМ сохранении. Команд и
//      слова «провести» в интерфейсе нет, но всё остальное работает одинаково:
//      документ может остаться непроведённым, и об этом скажет та же галочка в
//      журнале и то же уведомление;
//   2. любой режим — сохранение СБРАСЫВАЕТ разрежение повторов. Исправил сбойный
//      документ — попытка происходит сразу, а не через пять минут. Это и есть
//      «действие человека сбрасывает разрежение» (§8).
//
// Служебная запись самого механизма (состояние проведения) сюда не попадает:
// иначе проведение ставило бы документ в очередь бесконечно.
use('root', async function postingEnqueueMiddleware(request, next) {
    const { operation, table } = request;
    if (operation !== 'create' && operation !== 'update') return await next(request);

    const result = await next(request);

    try {
        if (require('./db/coreWrite').isGranted(request)) return result;

        const globalCtx = require('./globalServerContext');
        const posting = require('./db/posting');
        const modelName = globalCtx.getModelNameForTable(table);
        const Model = modelName ? globalCtx.modelsDB[modelName] : null;
        const cfg = Model && posting.readConfig(Model);
        if (!cfg) return result;

        const uid = (request.data && request.data.UID)
            || (request.where && (request.where.UID || request.where.uid));
        if (!uid || typeof uid !== 'string') return result;

        const postingQueue = require('./db/postingQueue');
        const already = await postingQueue.rowOf(table, uid);
        if (cfg.mode !== 'auto' && !already) return result;   // ручной режим: ждём команды

        const user = await (async () => {
            try {
                const u = await globalCtx.getUserBySessionID(request.context && request.context.sessionID);
                return (u && u.UID) || null;
            } catch (e) { return null; }
        })();

        await postingQueue.enqueue({
            table, uid,
            action: already ? already.action : posting.ACTION.POST,
            requestedBy: user,
            byHuman: true,
            sessionID: request.context && request.context.sessionID
        });
        postingQueue.kick().catch(() => { /* подберёт страхующий тик */ });
    } catch (e) {
        // Сохранение уже состоялось. Не поставить документ в очередь — плохо, но
        // отменять из-за этого запись пользователя нельзя: документ подберёт
        // страхующий проход, как только очередь до него доберётся.
        console.error('[dbGateway] Постановка в очередь проведения не выполнена:', e && e.message || e);
    }
    return result;
});

// ── Сторно выставлен → исходный документ отменён ─────────────────────────────
// Сторно открывается несохранённой формой и живёт черновиком, пока его не
// выставят; исходный документ обязан оставаться действующим до этого момента и
// уйти в «отменён» ровно в нём — каким бы путём ни шло выставление (кнопка
// приложения, скрипт). Отмена идёт отдельной записью ПОСЛЕ успешной: сорвалось
// выставление — исходный документ не тронут (drive_root/db/storno.js).
use('root', async function stornoIssueMiddleware(request, next) {
    if (request.operation !== 'update') return await next(request);
    const storno = require('./db/storno');
    const issuing = await storno.issuingStornos(request);
    const result = await next(request);
    if (issuing && issuing.length) {
        await storno.cancelSourcesOf(request.table, issuing, request.context || {});
    }
    return result;
});

module.exports = {
    use,
    execute,
    executeIn,
    transaction,
    clearMiddleware,
    LEVELS
};
