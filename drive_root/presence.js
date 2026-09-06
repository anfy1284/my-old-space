'use strict';

/**
 * Присутствие пользователей: кто сейчас в системе и когда был в последний раз.
 *
 * ── Откуда берётся «в сети» ──────────────────────────────────────────────────
 * Из живых потоков событий (`/app/events`, реестр `global._sessionSseClients`).
 * Это самый честный признак из доступных: поток существует ровно пока открыта
 * вкладка. Наличие СЕССИИ таким признаком не является — сессия живёт часами
 * после закрытия браузера, и «в сети» превратилось бы в «заходил сегодня».
 *
 * ── Откуда берётся «был(а) в» ────────────────────────────────────────────────
 * Из `users.lastSeenAt`. Отметка ставится не на каждый запрос (это запись в базу
 * на каждое движение мыши), а в двух точках, где время известно точно:
 * при ПОДКЛЮЧЕНИИ потока и при его ОБРЫВЕ. Между ними пользователь и так
 * показывается как «в сети», а значение поля никого не интересует.
 *
 * ── Почему модуль в ядре, а не в мессенджере ─────────────────────────────────
 * Реестр потоков — часть ядра, и знать «кто сейчас работает» нужно не только
 * переписке: это же понадобится списку пользователей, журналу действий и любому
 * будущему совместному редактированию. Мессенджер здесь — первый потребитель,
 * а не владелец механизма.
 */

const log = require('./log');

// Пользователи, у которых прямо сейчас есть хотя бы один живой поток событий.
// Считаем по реестру SSE, а не своим счётчиком: реестр — источник правды, а
// параллельный счётчик разошёлся бы с ним на первом же оборванном соединении.
function onlineUserIds() {
    const ids = new Set();
    const registry = global._sessionSseClients;
    if (!registry) return ids;
    for (const set of registry.values()) {
        set.forEach(client => { if (client && client.userId) ids.add(client.userId); });
    }
    return ids;
}

/** Есть ли у пользователя живой поток событий. */
function isOnline(userId) {
    if (!userId) return false;
    return onlineUserIds().has(userId);
}

/**
 * Отметить, что пользователь был в системе в этот момент.
 * Вызывается при подключении и обрыве потока событий (drive_forms/server.js).
 * Ошибка записи не должна ломать поток — присутствие не критично.
 */
async function touch(userId) {
    if (!userId) return;
    try {
        const globalCtx = require('./globalServerContext');
        const Users = globalCtx.modelsDB && globalCtx.modelsDB.Users;
        if (!Users) return;
        // silent: отметка присутствия — не правка карточки пользователя, и
        // затирать ею `updatedAt` нельзя (это единственный след того, когда
        // запись действительно меняли).
        await Users.update({ lastSeenAt: new Date() }, { where: { UID: userId }, silent: true });
    } catch (e) {
        log.debug('[presence] не удалось отметить присутствие', userId, e && e.message);
    }
}

/**
 * Присутствие набора пользователей одним запросом.
 *
 * @param {string[]} userIds
 * @returns {Promise<Object>} { [userId]: { online: boolean, lastSeenAt: Date|null } }
 */
async function getPresence(userIds) {
    const out = {};
    if (!Array.isArray(userIds) || !userIds.length) return out;

    const online = onlineUserIds();
    let rows = [];
    try {
        const globalCtx = require('./globalServerContext');
        const Users = globalCtx.modelsDB && globalCtx.modelsDB.Users;
        if (Users) {
            rows = await Users.findAll({
                where: { UID: userIds },
                attributes: ['UID', 'lastSeenAt'],
                raw: true
            });
        }
    } catch (e) {
        log.debug('[presence] чтение lastSeenAt', e && e.message);
    }

    const seen = {};
    for (const r of rows) seen[r.UID] = r.lastSeenAt || null;

    for (const id of userIds) {
        out[id] = { online: online.has(id), lastSeenAt: seen[id] || null };
    }
    return out;
}

module.exports = { isOnline, onlineUserIds, touch, getPresence };
