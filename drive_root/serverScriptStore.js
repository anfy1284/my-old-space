'use strict';

/**
 * serverScriptStore.js — хранилище серверных скриптов.
 *
 * Хранит объекты с функциями в памяти процесса (обычный Map).
 * Функции нельзя сериализовать в memoryStore L2, поэтому хранилище
 * in-process. Каждый воркер регистрирует скрипты сам при старте
 * через init.js своего приложения.
 *
 * ВАЖНО: name — стабильный строковый ключ, задаётся явно разработчиком.
 * Это гарантирует, что все воркеры используют одинаковый UID в лейаутах.
 *
 * Публичный API:
 *   loadServerScript(name, scriptObj, role)  → name
 *   getServerScript(name, userRole)          → { scriptObj } | null
 */

// Map<name, { scriptObj: Object, role: string|string[] }>
const _store = new Map();

/**
 * Проверка доступа: есть ли у пользователя требуемая роль.
 * userRole может быть строкой или массивом строк.
 * admin всегда имеет доступ.
 * @param {string|string[]} userRole
 * @param {string|string[]} requiredRole
 * @returns {boolean}
 */
function hasRoleAccess(userRole, requiredRole) {
    const userRoles     = Array.isArray(userRole)     ? userRole     : [userRole];
    const requiredRoles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
    if (userRoles.includes('admin')) return true;
    return requiredRoles.some(r => userRoles.includes(r));
}

/**
 * Регистрирует объект с серверными функциями.
 *
 * name — стабильный идентификатор (например 'organizations.bookingActions').
 * Один и тот же name перезапишет предыдущую регистрацию.
 *
 * @param {string}          name       - Уникальное имя скрипта
 * @param {Object}          scriptObj  - Объект с async/sync функциями
 * @param {string|string[]} role       - Роль(и), которым разрешён вызов
 * @returns {string}                   - Возвращает name (используется как UID в лейауте)
 */
function loadServerScript(name, scriptObj, role) {
    if (!name || typeof name !== 'string') {
        throw new Error('loadServerScript: name (string) required');
    }
    if (!scriptObj || typeof scriptObj !== 'object') {
        throw new Error('loadServerScript: scriptObj (object) required');
    }
    _store.set(name, { scriptObj, role });
    return name;
}

/**
 * Возвращает объект с функциями по имени, с проверкой роли.
 *
 * @param {string}          name
 * @param {string|string[]} userRole
 * @returns {{ scriptObj: Object } | null}
 */
function getServerScript(name, userRole) {
    const entry = _store.get(name);
    if (!entry) return null;
    if (!hasRoleAccess(userRole, entry.role)) return null;
    return { scriptObj: entry.scriptObj };
}

module.exports = { loadServerScript, getServerScript };
