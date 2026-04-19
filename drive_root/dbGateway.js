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

            // Очистка пустых строк только для внешних ключей (чтобы избежать ошибок FK в Postgres)
            if (Model && Model.rawAttributes) {
                Object.keys(data).forEach(k => {
                    const attr = Model.rawAttributes[k];
                    if (data[k] === "" && attr && attr.references) {
                        data[k] = null;
                    }
                });
            }

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

            // Очистка пустых строк только для внешних ключей (чтобы избежать ошибок FK в Postgres)
            if (Model && Model.rawAttributes) {
                Object.keys(data).forEach(k => {
                    const attr = Model.rawAttributes[k];
                    if (data[k] === "" && attr && attr.references) {
                        data[k] = null;
                    }
                });
            }

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
    const chain = buildChain();
    return await chain(request);
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
}

module.exports = {
    use,
    execute,
    clearMiddleware,
    LEVELS
};
