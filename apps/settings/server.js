'use strict';

/**
 * Серверная часть приложения «Настройки» — персональное, чего нет в бандле:
 * служебные настройки (состояние интерфейса) и список приложений, выключенных
 * у этого пользователя.
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
const settingsApi = require('../../drive_root/settings');
const registry = require('../../drive_root/settings/registry');
const appAvailability = require('../../drive_root/appAvailability');
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
     * Приложения, выключенные у текущего пользователя (см. drive_root/appAvailability).
     * По этому списку трей не рисует значок, а `MySpace.open` отказывает.
     * Без пользователя (экран входа) выключено всё, у чего есть выключатель.
     */
    disabledApps: async (params, sessionID) => {
        const user = await currentUser(sessionID);
        return appAvailability.disabledAppsForUser(user ? user.UID : null);
    },

    /**
     * Личные настройки, которые нужны КЛИЕНТСКОМУ коду: { приложение: { ключ: значение } }.
     *
     * Есть приложения, у которых поведение на экране задаётся настройкой, а окна нет
     * вовсе (экранная лупа `magnifier`): спросить сервер во время нажатия клавиши
     * нельзя, а в бандл `/app/loadApps` личное не кладут — он кэшируется по ключу
     * «роль|язык». Поэтому снимок приезжает отдельным запросом при загрузке страницы,
     * ровно как состояние интерфейса и список выключенных приложений.
     *
     * Отдаётся только уровень `user` и только `visibility: "user"`: это настройки
     * САМОГО человека, которые он и правит в форме. Значения уровня `system`, ключи
     * поставщиков и всё, что объявлено админским, на клиент не уезжают — клиенту они
     * не нужны, а утечка ключа настройкой не лечится.
     */
    mySettings: async (params, sessionID) => {
        const user = await currentUser(sessionID);
        if (!user) return {};
        registry.ensureLoaded();
        const out = {};
        for (const entry of registry.listByScope('user')) {
            const visible = entry.settings.filter(d => d.visibility === 'user');
            if (!visible.length) continue;
            try {
                const values = await settingsApi.getAppSettings('user', user.UID, entry.app.name);
                const appValues = {};
                for (const decl of visible) appValues[decl.key] = values[decl.key];
                out[entry.app.name] = appValues;
            } catch (e) {
                log.error('[settings] личные настройки', entry.app.name, e && e.message);
            }
        }
        return out;
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
