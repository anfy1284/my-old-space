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

// ── Реестр билдеров «представления» (поля name) ──────────────────────────────
// Билдер — это «специальный метод сущности», тело которого пишет прикладной
// программист. Вызывается ВСЕГДА при сохранении (create/update) через
// applyPresentation и заполняет поле `name` записи (наименование/представление).
// Если для таблицы билдер не зарегистрирован — ничего не делается.
//   Документ bookings: number + имя клиента + даты заезда/выезда.
//   Справочник может зарегистрировать свой билдер при необходимости.
const presentationRegistry = new Map();

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

/**
 * Зарегистрировать билдер представления (поля name) для таблицы.
 * Это «специальный метод сущности» — тело пишет прикладной программист в init.js.
 * @param {string} tableName — имя таблицы (например 'bookings')
 * @param {Function} fn — async (data, context) => string
 *   data    — полные данные записи (для update — БД-запись, смерженная с изменениями;
 *             для create — данные создаваемой записи, номер уже присвоен автонумерацией)
 *   context — { modelsDB, dbGateway, sessionID }
 */
function registerPresentation(tableName, fn) {
    if (typeof tableName !== 'string' || typeof fn !== 'function') {
        throw new Error('[entityHooks] registerPresentation(tableName: string, fn: function) required');
    }
    presentationRegistry.set(tableName, fn);
    console.log(`[entityHooks] Registered presentation builder for table: "${tableName}"`);
}

/**
 * Получить билдер представления для таблицы (или null).
 */
function getPresentation(tableName) {
    return presentationRegistry.get(tableName) || null;
}

/**
 * Вычислить и записать представление (поле name) записи.
 * Вызывается из dbGateway middleware ПОСЛЕ runHooks (т.е. после автонумерации),
 * для create и update. Без зарегистрированного билдера — no-op.
 *
 * @param {string} operation — 'create' | 'update'
 * @param {Object} Model     — Sequelize Model
 * @param {Object} request   — объект dbGateway request (мутируется request.data.name)
 * @param {Object} context   — { modelsDB, dbGateway, sessionID }
 */
async function applyPresentation(operation, Model, request, context) {
    if (operation !== 'create' && operation !== 'update') return;
    const tableName = (Model && Model.tableName) || (request && request.table);
    const builder = tableName ? presentationRegistry.get(tableName) : null;
    if (typeof builder !== 'function') return;

    // Собираем полные данные записи. На update в request.data только изменённые поля —
    // дочитываем текущую запись из БД и мерджим, чтобы билдер видел все реквизиты.
    let effective = Object.assign({}, (request && request.data) || {});
    if (operation === 'update') {
        const uid = request && request.where && (request.where.UID || request.where.uid);
        if (uid && Model && typeof Model.findByPk === 'function') {
            try {
                const cur = await Model.findByPk(uid, { raw: true });
                if (cur) effective = Object.assign({}, cur, (request && request.data) || {});
            } catch (e) { /* строим из изменений */ }
        }
    }

    try {
        const name = await builder(effective, context || {});
        if (name != null && String(name) !== '') {
            if (!request.data) request.data = {};
            request.data.name = String(name);
        }
    } catch (e) {
        console.error(`[entityHooks] presentation builder error for "${tableName}":`, e && e.message || e);
    }
}

module.exports = { register, resolve, runHooks, registerPresentation, getPresentation, applyPresentation };
