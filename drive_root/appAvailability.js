'use strict';

/**
 * appAvailability — приложение, выключенное ДЛЯ ПОЛЬЗОВАТЕЛЯ.
 *
 * Роль закрывает приложение для всех, у кого эта роль (раздел 64 архитектуры:
 * `config.json` → `access` + обе регистрации скриптов). Здесь другое: приложение
 * есть у роли, но конкретный человек им не пользуется — и тогда его не должно быть
 * ни у него на экране, ни в списках у других.
 *
 * ── Объявление ───────────────────────────────────────────────────────────────
 * В манифесте приложения, рядом с `access` и `autoStart`:
 *
 *     "enabledBySetting": { "app": "messenger", "key": "useMessenger" }
 *
 * Ссылка на обычную настройку уровня `user` типа `boolean` (drive_root/settings).
 * Отдельного хранилища «включённых приложений» нет намеренно: выключатель — это
 * настройка, и он обязан жить там же, где все настройки, с теми же правами
 * (`visibility: "admin"` — значит правит только администратор) и в той же форме.
 *
 * ── Почему выключение не в бандле `/app/loadApps` ────────────────────────────
 * Бандл кэшируется по ключу «роль|язык» — персональное в него класть нельзя
 * (тот же запрет, что для состояния интерфейса). Поэтому список выключенных
 * приложений приезжает отдельным RPC (`settings.disabledApps`) и попадает на
 * клиент в `MySpace.appAvailability`; трей по нему не рисует значок, `MySpace.open`
 * отказывает.
 *
 * ── Серверная сторона ────────────────────────────────────────────────────────
 * Клиентский запрет — это про экран, а не про права: RPC остаётся вызываемым по
 * имени (серверные скрипты регистрируются ИМЕНЕМ и своего приложения не знают —
 * см. drive_root/serverScriptStore.js). Поэтому приложение закрывает свои вызовы
 * САМО, одной строкой на регистрацию:
 *
 *     loadServerScript(NAME, appAvailability.guard('messenger', serverFns), 'user');
 *
 * `guard` — именованный метод, а не анонимная обёртка по месту: выключатель должен
 * читаться в `init.js` глазами.
 *
 * @module drive_root/appAvailability
 */

const fs = require('fs');
const path = require('path');
const log = require('./log');
const { enumerateApps } = require('./appsRegistry');

/** appName → { app, key } — объявления `enabledBySetting` всех приложений. */
let _declarations = null;

/**
 * Собрать объявления из манифестов. Состав приложений в рантайме не меняется
 * (новое приложение появляется только с рестартом), поэтому обход один за процесс.
 * @returns {Map<string, {app: string, key: string}>}
 */
function declarations() {
    if (_declarations) return _declarations;
    _declarations = new Map();
    for (const app of enumerateApps()) {
        const configPath = path.join(app.dir, 'config.json');
        if (!fs.existsSync(configPath)) continue;
        let cfg;
        try {
            cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
            log.error(`[appAvailability] config.json приложения "${app.name}" не прочитан:`, e.message);
            continue;
        }
        const decl = cfg.enabledBySetting;
        if (!decl) continue;
        if (!decl.app || !decl.key) {
            log.error(`[appAvailability] "${app.name}": enabledBySetting без app/key — выключатель игнорируется`);
            continue;
        }
        _declarations.set(app.name, { app: String(decl.app), key: String(decl.key) });
    }
    return _declarations;
}

/** Объявление выключателя приложения или null (значит, приложение доступно всегда). */
function declarationFor(appName) {
    return declarations().get(appName) || null;
}

/** Сбросить собранные объявления (тесты, подмена проекта). */
function reset() {
    _declarations = null;
}

/**
 * Доступно ли приложение пользователю.
 *
 * Без пользователя (экран входа, анонимный запрос) приложение с выключателем
 * считается выключенным: настройка принадлежит человеку, а его нет.
 *
 * @param {string} userId
 * @param {string} appName
 * @returns {Promise<boolean>}
 */
async function isEnabledForUser(userId, appName) {
    const decl = declarationFor(appName);
    if (!decl) return true;
    if (!userId) return false;
    try {
        const settings = require('./settings');
        return !!(await settings.getUserSetting(userId, decl.app, decl.key));
    } catch (e) {
        // Отказ чтения — это не «выключено»: иначе сбой настроек молча отнимал бы
        // у всех работающее приложение. Ошибка в лог, приложение остаётся.
        log.error(`[appAvailability] ${appName}: настройка ${decl.app}.${decl.key} не прочитана:`, e && e.message);
        return true;
    }
}

/**
 * Доступность приложения сразу у многих пользователей — одним запросом.
 * @param {string[]} userIds
 * @param {string} appName
 * @returns {Promise<Map<string, boolean>>} UID → доступно
 */
async function enabledMapForUsers(userIds, appName) {
    const ids = Array.from(new Set((userIds || []).filter(Boolean).map(String)));
    const out = new Map();
    const decl = declarationFor(appName);
    if (!decl) {
        for (const id of ids) out.set(id, true);
        return out;
    }
    if (!ids.length) return out;
    try {
        const settings = require('./settings');
        const values = await settings.getRecordSettingMany('user', ids, decl.app, decl.key);
        for (const id of ids) out.set(id, !!values.get(id));
    } catch (e) {
        log.error(`[appAvailability] ${appName}: пакетное чтение ${decl.app}.${decl.key}:`, e && e.message);
        for (const id of ids) out.set(id, true);
    }
    return out;
}

/**
 * Приложения, выключенные у пользователя (имена).
 * Это и есть ответ RPC `settings.disabledApps`.
 * @param {string} userId
 * @returns {Promise<string[]>}
 */
async function disabledAppsForUser(userId) {
    const out = [];
    for (const appName of declarations().keys()) {
        if (!(await isEnabledForUser(userId, appName))) out.push(appName);
    }
    return out;
}

/** Идентификатор пользователя из второго аргумента RPC: это либо ctx, либо sessionID. */
async function userIdFromCall(ctxOrSessionID) {
    const globalRoot = require('./globalServerContext');
    if (!ctxOrSessionID) return null;
    if (typeof ctxOrSessionID === 'string') {
        try {
            const user = await globalRoot.getUserBySessionID(ctxOrSessionID);
            return user ? user.UID : null;
        } catch (e) { return null; }
    }
    if (ctxOrSessionID.user && ctxOrSessionID.user.UID) return ctxOrSessionID.user.UID;
    if (ctxOrSessionID.sessionID) {
        try {
            const user = await globalRoot.getUserBySessionID(ctxOrSessionID.sessionID);
            return user ? user.UID : null;
        } catch (e) { return null; }
    }
    return null;
}

/**
 * Обернуть объект серверных функций проверкой доступности приложения.
 *
 * Возвращается объект с теми же именами функций: вызов у пользователя, которому
 * приложение выключено, до прикладного кода не доходит и падает внятной ошибкой.
 * Приложение без объявленного выключателя оборачивать бессмысленно — объект
 * возвращается как есть.
 *
 * @param {string} appName — имя приложения (как в apps.json)
 * @param {Object} scriptObj — объект с функциями `(params, ctx)` или `(params, sessionID)`
 * @returns {Object}
 */
function guard(appName, scriptObj) {
    if (!declarationFor(appName)) return scriptObj;
    const wrapped = {};
    for (const fnName of Object.keys(scriptObj || {})) {
        const fn = scriptObj[fnName];
        if (typeof fn !== 'function') { wrapped[fnName] = fn; continue; }
        wrapped[fnName] = async function (params, ctxOrSessionID) {
            const userId = await userIdFromCall(ctxOrSessionID);
            if (!(await isEnabledForUser(userId, appName))) {
                throw new Error(`app_disabled_for_user: ${appName}`);
            }
            return fn.apply(this, arguments);
        };
    }
    return wrapped;
}

module.exports = {
    declarations, declarationFor, reset,
    isEnabledForUser, enabledMapForUsers, disabledAppsForUser,
    guard
};
