'use strict';

/**
 * Серверная часть приложения «Настройки» — служебные настройки (состояние интерфейса).
 *
 * Отдельный RPC, а не бандл `/app/loadApps`: бандл кэшируется по ключу «роль|язык», и
 * персональное состояние утекло бы первому же пользователю с той же ролью и языком.
 * Поэтому снимок забирается один раз при загрузке страницы вот этим вызовом.
 *
 * Значения приходят с клиента и им НЕ доверяют: ключи свободные, ничего, от чего зависят
 * права или расчёты, здесь храниться не должно (см. drive_root/settings/state.js).
 * Пользователь правит только СВОЁ состояние — идентификатор берётся из сессии, а не из
 * параметров вызова.
 *
 * @module apps/settings/server
 */

const globalRoot = require('../../drive_root/globalServerContext');
const state = require('../../drive_root/settings/state');
const log = require('../../drive_root/log');

async function currentUser(sessionID) {
    if (!sessionID) return null;
    try { return await globalRoot.getUserBySessionID(sessionID); } catch (e) { return null; }
}

module.exports = {
    /** Снимок состояния текущего пользователя: { приложение: { ключ: значение } }. */
    stateSnapshot: async (params, sessionID) => {
        const user = await currentUser(sessionID);
        if (!user) return {};
        return state.getAllForUser(user.UID);
    },

    /**
     * Сохранить правки состояния пачкой: { приложение: { ключ: значение } }.
     * Клиент копит изменения и шлёт их с задержкой — перетаскивание окна не должно
     * бить в базу на каждый пиксель.
     */
    stateSave: async (params, sessionID) => {
        const user = await currentUser(sessionID);
        if (!user) return { ok: false };
        const changes = (params && params.changes) || {};
        for (const appName of Object.keys(changes)) {
            const values = changes[appName];
            if (!values || typeof values !== 'object') continue;
            try {
                await state.setMany(user.UID, appName, values);
            } catch (e) {
                log.error('[settings/state] запись состояния', appName, e && e.message);
                return { ok: false, error: e.message };
            }
        }
        return { ok: true };
    }
};
