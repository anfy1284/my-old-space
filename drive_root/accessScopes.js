'use strict';

/**
 * accessScopes — области доступа пользователя в терминах ЯДРА.
 *
 * Ядру иногда нужно знать не «что можно прочитать» (это решает RLS в `dbGateway`), а
 * «с кем этот человек в одной лодке»: кому заводить переписку, кого показывать
 * коллегой, кого считать своим. Ответ на это даёт РЕШЕНИЕ, а не фреймворк: в одном
 * проекте граница — организация, в другом — отель, подразделение или площадка.
 *
 * Поэтому здесь только точка расширения. Проект регистрирует именованный резолвер —
 * обычно там же, где живёт его слой доступа (`<PROJECT_ROOT>/dbGateway.js`):
 *
 *     const accessScopes = require('my-old-space/drive_root/accessScopes');
 *     accessScopes.registerResolver('project', resolveUserScopes);
 *
 * Резолвер возвращает МАССИВ СТРОК — непрозрачные для ядра идентификаторы областей
 * (у нас это UID организаций). Ядро их только сравнивает: пересеклись — люди в одной
 * области, нет — в разных.
 *
 * ── Почему не «спросить RLS, видит ли А запись Б» ────────────────────────────
 * Это была первая мысль, и она неверна. RLS отвечает на вопрос о ВИДИМОСТИ ЗАПИСИ, а
 * видимость строки `users` в этом проекте идёт по `users.organizationId`, который у
 * сотрудников часто пуст: фактическая принадлежность описана связями
 * (`user_organizations`). Ответ RLS был бы «никто никого не видит», и переписка не
 * завелась бы ни у кого. Принадлежность и видимость — разные вопросы, и у них разные
 * источники (то же различение сделано в `drive_root/backup/scope.js`, правило 2).
 *
 * ── Без резолвера ────────────────────────────────────────────────────────────
 * Областей нет ни у кого, и пересечений нет тоже. Это осознанно: решение, не
 * объявившее своих границ, не должно молча получать границу, придуманную
 * фреймворком.
 *
 * @module drive_root/accessScopes
 */

const log = require('./log');

/** имя → функция (userId) => Promise<string[]> */
const _resolvers = new Map();

/**
 * Зарегистрировать резолвер областей доступа.
 *
 * Имя нужно для повторной регистрации (перезагрузка модуля проекта не должна
 * плодить копии) и для внятного лога.
 *
 * @param {string} name — кто регистрирует (`'project'`, имя приложения)
 * @param {function(string): Promise<string[]>} resolver
 */
function registerResolver(name, resolver) {
    if (!name || typeof resolver !== 'function') {
        throw new Error('[accessScopes] registerResolver: нужны имя и функция');
    }
    _resolvers.set(String(name), resolver);
    log.debug(`[accessScopes] резолвер "${name}" зарегистрирован`);
}

/** Объявлена ли граница хоть кем-нибудь. */
function hasResolvers() {
    return _resolvers.size > 0;
}

/** Убрать все резолверы (тесты). */
function reset() {
    _resolvers.clear();
}

/**
 * Области доступа одного пользователя.
 * @param {string} userId
 * @returns {Promise<string[]>}
 */
async function scopesOf(userId) {
    if (!userId) return [];
    const out = new Set();
    for (const [name, resolver] of _resolvers) {
        try {
            const scopes = await resolver(userId);
            for (const s of (scopes || [])) if (s) out.add(String(s));
        } catch (e) {
            log.error(`[accessScopes] резолвер "${name}" не ответил для ${userId}:`, e && e.message);
        }
    }
    return Array.from(out);
}

/**
 * Области доступа пачки пользователей.
 * @param {string[]} userIds
 * @returns {Promise<Map<string, string[]>>}
 */
async function scopesOfMany(userIds) {
    const out = new Map();
    for (const id of Array.from(new Set((userIds || []).filter(Boolean).map(String)))) {
        out.set(id, await scopesOf(id));
    }
    return out;
}

/**
 * Есть ли у двух наборов областей общая.
 * Пустой набор не пересекается ни с чем — в том числе сам с собой: «области не
 * заданы» не означает «все в одной области».
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function share(a, b) {
    if (!a || !b || !a.length || !b.length) return false;
    const set = new Set(a);
    return b.some(s => set.has(s));
}

module.exports = { registerResolver, hasResolvers, reset, scopesOf, scopesOfMany, share };
