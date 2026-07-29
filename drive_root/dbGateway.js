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

module.exports = {
    use,
    execute,
    clearMiddleware,
    LEVELS
};
