'use strict';

/**
 * methodStore.js — ЯДРО хранилища серверных методов.
 *
 * Выделено из `serverScriptStore.js`: там лежал плоский общий реестр имён на всю
 * систему, без принадлежности приложению и без разделения «методы формы» / «методы
 * приложения». Механизм работал, и второй такой рядом не строится — общее вынесено
 * сюда, а прежний `serverScriptStore` стал его первым потребителем (скрипты по имени),
 * `formMethods` — вторым (методы формы и приложения).
 *
 * Хранилище in-process (обычный Map): функции нельзя сериализовать в memoryStore L2,
 * и каждый процесс регистрирует свои методы сам, через `init.js` приложения.
 *
 * ОБЛАСТЬ (`scope`) — непрозрачная строка, которую собирает потребитель:
 *   'script:booking.actions'        — скрипт по имени (serverScriptStore)
 *   'form:booking|record:bookings'  — методы формы (formMethods)
 *   'app:booking'                   — общие методы приложения (formMethods)
 *
 * Публичный API:
 *   register(scope, methods, roles) → scope
 *   get(scope, userRole)            → { methods } | null
 *   hasRoleAccess(userRole, requiredRole) → boolean
 *   scopes()                        → [scope, …]   (диагностика)
 */

// Map<scope, { methods: Object, roles: string|string[] }>
const _store = new Map();

/**
 * Проверка доступа: есть ли у пользователя требуемая роль.
 * userRole может быть строкой или массивом строк. admin имеет доступ всегда —
 * его права сквозные везде (подбор лейаута и RLS устроены так же).
 *
 * ВНИМАНИЕ: `'*'` здесь НЕ означает «любая роль». Роль доступа к методам и роль
 * подбора лейаута — разные вопросы, и объединять их нельзя: лейаут, объявленный
 * как `roles: '*'`, показывается всем, но это не повод отдавать всем его методы.
 * Кто угодно объявляется явным списком ролей.
 *
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
 * Регистрирует объект с серверными функциями под областью `scope`.
 * Повторная регистрация той же области перезаписывает предыдущую.
 *
 * @param {string}          scope
 * @param {Object}          methods
 * @param {string|string[]} roles
 * @returns {string} scope
 */
function register(scope, methods, roles) {
    if (!scope || typeof scope !== 'string') {
        throw new Error('methodStore.register: scope (string) required');
    }
    if (!methods || typeof methods !== 'object') {
        throw new Error(`methodStore.register: methods (object) required for scope "${scope}"`);
    }
    _store.set(scope, { methods, roles });
    return scope;
}

/**
 * Возвращает набор методов области с проверкой роли.
 * @param {string}          scope
 * @param {string|string[]} userRole
 * @returns {{ methods: Object } | null}
 */
function get(scope, userRole) {
    const entry = _store.get(scope);
    if (!entry) return null;
    if (!hasRoleAccess(userRole, entry.roles)) return null;
    return { methods: entry.methods };
}

/** Зарегистрирована ли область (без проверки роли). Для диагностики и сообщений. */
function has(scope) {
    return _store.has(scope);
}

/** Все зарегистрированные области — для внятных сообщений об ошибке. */
function scopes() {
    return Array.from(_store.keys());
}

module.exports = { register, get, has, scopes, hasRoleAccess };
