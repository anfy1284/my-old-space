'use strict';

/**
 * serverScriptStore.js — серверные скрипты, адресуемые ИМЕНЕМ.
 *
 * Первый потребитель ядра `methodStore.js`. Своего хранилища больше не держит:
 * общее вынесено в ядро, сюда осталась только адресация — «скрипт по имени».
 * Так зовут методы клиентские скрипты через роут `/server-call`.
 *
 * ВАЖНО: name — стабильный строковый ключ, задаётся явно разработчиком.
 * Это гарантирует, что все воркеры используют одинаковый UID в лейаутах.
 *
 * Для НОВОГО кода предпочтительны методы формы и приложения (`drive_root/formMethods.js`):
 * у них есть владелец, они находятся по адресу формы, и события формы — это они же.
 * Скрипты по имени остаются для вызовов, у которых формы нет вовсе (логин, boot).
 *
 * Публичный API:
 *   loadServerScript(name, scriptObj, role)  → name
 *   getServerScript(name, userRole)          → { scriptObj } | null
 */

const methodStore = require('./methodStore');

/** Область хранения скрипта по имени. */
function scopeOf(name) {
    return 'script:' + name;
}

/**
 * Регистрирует объект с серверными функциями.
 *
 * @param {string}          name       - Уникальное имя скрипта ('booking.actions')
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
    methodStore.register(scopeOf(name), scriptObj, role);
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
    const entry = methodStore.get(scopeOf(name), userRole);
    if (!entry) return null;
    return { scriptObj: entry.methods };
}

module.exports = { loadServerScript, getServerScript };
