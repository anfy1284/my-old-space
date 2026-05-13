/**
 * entityHooks — реестр обработчиков событий уровня таблицы.
 *
 * Позволяет навешивать серверную логику на события жизненного цикла записей
 * (beforeCreate, beforeUpdate и т.д.) декларативно через db.json → entityConfig.
 *
 * Встроенные обработчики живут в ./default/ и имеют префикс "default.".
 * Пользовательские регистрируются через entityHooks.register(name, fn).
 *
 * Подключение в init.js приложения:
 *   const entityHooks = require('.../drive_root/entityHooks');
 *   entityHooks.register('booking.checkAvailability', require('./hooks/checkAvailability'));
 *
 * Формат entityConfig в db.json:
 *   "entityConfig": {
 *     "entityType": "document",  // "document" | "directory"
 *     "hooks": {
 *       "beforeCreate": [
 *         { "handler": "default.autoNumber", "params": { "field": "name", "length": 5 } },
 *         { "handler": "booking.checkAvailability" }
 *       ]
 *     }
 *   }
 *
 * Сигнатура обработчика:
 *   async function handler(request, params, context)
 *     request  — объект dbGateway request (можно мутировать request.data)
 *     params   — объект params из entityConfig.hooks[event][n].params (или {})
 *     context  — { modelsDB, dbGateway }
 */

'use strict';

const registry = new Map();

// ── Автозагрузка встроенных обработчиков ─────────────────────────────────────
const builtins = {
    'default.autoNumber': require('./default/autoNumber'),
};

for (const [name, fn] of Object.entries(builtins)) {
    registry.set(name, fn);
}

/**
 * Зарегистрировать пользовательский обработчик.
 * @param {string} name — уникальное имя, например "booking.checkAvailability"
 * @param {Function} fn — async (request, params, context) => void
 */
function register(name, fn) {
    if (typeof fn !== 'function') {
        throw new Error(`[entityHooks] Handler "${name}" must be a function`);
    }
    registry.set(name, fn);
    console.log(`[entityHooks] Registered handler: "${name}"`);
}

/**
 * Получить обработчик по имени. Бросает ошибку если не найден.
 * @param {string} name
 * @returns {Function}
 */
function resolve(name) {
    const fn = registry.get(name);
    if (!fn) {
        throw new Error(`[entityHooks] Handler "${name}" is not registered`);
    }
    return fn;
}

/**
 * Выполнить все хуки для заданного события.
 * Ничего не делает если entityConfig или hooks не заданы.
 *
 * @param {string} event       — имя события: 'beforeCreate', 'beforeUpdate', ...
 * @param {Object} Model       — Sequelize Model с .entityConfig
 * @param {Object} request     — объект dbGateway request
 * @param {Object} context     — { modelsDB, dbGateway }
 */
async function runHooks(event, Model, request, context) {
    const cfg = Model && Model.entityConfig;
    if (!cfg || !cfg.hooks || !Array.isArray(cfg.hooks[event])) return;

    for (const hookDef of cfg.hooks[event]) {
        const handlerName = hookDef.handler;
        const params = hookDef.params || {};

        let fn;
        try {
            fn = resolve(handlerName);
        } catch (e) {
            console.error(`[entityHooks] ${e.message} — skipping hook for event "${event}"`);
            continue;
        }

        try {
            await fn(request, params, context);
        } catch (e) {
            console.error(`[entityHooks] Error in handler "${handlerName}" (event "${event}"):`, e.message);
            throw e; // прерываем: если хук упал — операция не должна продолжаться
        }
    }
}

module.exports = { register, resolve, runHooks };
