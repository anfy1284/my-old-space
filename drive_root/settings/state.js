'use strict';

/**
 * state — служебные настройки пользователя (состояние интерфейса).
 *
 * Это не настройки: у ключа нет ни типа, ни подписи, ни значения по умолчанию, и в форме
 * настроек он не показывается. Здесь живёт то, что помнит интерфейс между сеансами:
 * последний выбранный отбор в списке, размер и положение окна, «эту подсказку больше не
 * показывать», последний выбранный вид календаря.
 *
 * ── Почему отдельная строка, а не общий JSON с настройками ───────────────────
 *   1) кнопка администратора «Очистить всё» должна быть одним
 *      `DELETE … WHERE kind='state'` и не иметь ни единого шанса задеть настройки;
 *   2) состояние пишется часто (каждое перетаскивание окна), и незачем при этом
 *      переписывать строку, которую читает бизнес-логика.
 * Поэтому те же (`scopeTable`, `scopeId`, `appName`), но `kind='state'`.
 *
 * ── Почему ключи свободные ───────────────────────────────────────────────────
 * Они динамические по своей природе (`list.bookings.filter`, `window.invoices.size`):
 * объявлять каждый в `settings.json` невозможно и незачем. Ядро их не проверяет,
 * администратору показывает как есть.
 *
 * ── Чего здесь не хранят ─────────────────────────────────────────────────────
 * Ничего, от чего зависят права, деньги или расчёты. Ключи свободные, значение приходит
 * с клиента, и подделать его может кто угодно: это UI-мусор по определению.
 *
 * @module drive_root/settings/state
 */

const log = require('../log');
const registry = require('./registry');
const types = require('./types');

const USERS_TABLE = 'users';

function models() {
    return require('../globalServerContext').modelsDB || null;
}

function valuesModel() {
    const all = models();
    return all ? all.SettingsValues : null;
}

/** Строка состояния (userId, appName) или null. */
async function row(userId, appName, create) {
    const SettingsValues = valuesModel();
    if (!SettingsValues || !userId || !appName) return null;
    const where = {
        scopeTable: USERS_TABLE, scopeId: String(userId),
        appName: String(appName), kind: registry.KIND_STATE
    };
    let found = await SettingsValues.findOne({ where });
    if (!found && create) {
        found = await SettingsValues.create(Object.assign({}, where, {
            data: {}, userId: String(userId), organizationId: null
        }));
    }
    return found;
}

/** Значение одного ключа (или null). */
async function get(userId, appName, key) {
    const all = await getAll(userId, appName);
    return (key in all) ? all[key] : null;
}

/** Все ключи приложения: { ключ: значение }. */
async function getAll(userId, appName) {
    const SettingsValues = valuesModel();
    if (!SettingsValues || !userId || !appName) return {};
    try {
        const found = await SettingsValues.findOne({
            where: {
                scopeTable: USERS_TABLE, scopeId: String(userId),
                appName: String(appName), kind: registry.KIND_STATE
            },
            raw: true
        });
        return types.parseData(found && found.data);
    } catch (e) {
        log.error('[settings/state] чтение', appName, e && e.message);
        return {};
    }
}

/**
 * Всё состояние пользователя: { приложение: { ключ: значение } }.
 * Это и есть снимок, который клиент забирает один раз при загрузке страницы.
 */
async function getAllForUser(userId) {
    const SettingsValues = valuesModel();
    if (!SettingsValues || !userId) return {};
    try {
        const rows = await SettingsValues.findAll({
            where: { scopeTable: USERS_TABLE, scopeId: String(userId), kind: registry.KIND_STATE },
            raw: true
        });
        const out = {};
        for (const r of rows) out[r.appName] = types.parseData(r.data);
        return out;
    } catch (e) {
        log.error('[settings/state] снимок состояния', e && e.message);
        return {};
    }
}

/** Записать один ключ. Значение — любое, что переживёт JSON. */
async function set(userId, appName, key, value) {
    if (!key) return;
    return setMany(userId, appName, { [key]: value });
}

/**
 * Записать несколько ключей одного приложения за раз.
 * Клиент шлёт правки пачкой (дебаунс), поэтому пачка — основной путь.
 */
async function setMany(userId, appName, values) {
    const target = await row(userId, appName, true);
    if (!target) return;
    const data = Object.assign({}, types.parseData(target.data), values || {});
    await target.update({ data });
}

/** Убрать ключ. */
async function remove(userId, appName, key) {
    const target = await row(userId, appName, false);
    if (!target) return;
    const data = types.parseData(target.data);
    if (!(key in data)) return;
    delete data[key];
    await target.update({ data });
}

/**
 * Стереть всё состояние (кнопка администратора).
 * Настроек не касается: у них другой `kind`.
 * @param {string} [userId] — только этого пользователя; без аргумента — всех
 * @returns {Promise<number>} сколько строк удалено
 */
async function clearAll(userId) {
    const SettingsValues = valuesModel();
    if (!SettingsValues) return 0;
    const where = { kind: registry.KIND_STATE };
    if (userId) { where.scopeTable = USERS_TABLE; where.scopeId = String(userId); }
    const n = await SettingsValues.destroy({ where });
    log.info(`[settings/state] очищено строк состояния: ${n}${userId ? ' (пользователь ' + userId + ')' : ''}`);
    return n;
}

/**
 * Плоский список для админской таблицы: [{ userId, userName, appName, key, value }].
 * Единственное место, где настройки показываются таблицей, — и это именно состояние.
 */
async function listAll() {
    const SettingsValues = valuesModel();
    const all = models();
    if (!SettingsValues) return [];

    const rows = await SettingsValues.findAll({ where: { kind: registry.KIND_STATE }, raw: true });
    const names = new Map();
    if (all && all.Users) {
        try {
            const userPresentation = require('../userPresentation');
            for (const u of await all.Users.findAll({ attributes: userPresentation.ATTRIBUTES, raw: true })) {
                names.set(u.UID, userPresentation.presentationOf(u));
            }
        } catch (e) { /* без имён покажем UID */ }
    }

    const out = [];
    for (const r of rows) {
        const data = types.parseData(r.data);
        for (const key of Object.keys(data)) {
            const value = data[key];
            out.push({
                UID: `${r.UID}|${key}`,
                userId: r.scopeId,
                userName: names.get(r.scopeId) || r.scopeId,
                appName: r.appName,
                key,
                value: (value && typeof value === 'object') ? JSON.stringify(value) : String(value === null || value === undefined ? '' : value)
            });
        }
    }
    out.sort((a, b) => a.userName.localeCompare(b.userName) || a.appName.localeCompare(b.appName) || a.key.localeCompare(b.key));
    return out;
}

module.exports = { get, getAll, getAllForUser, set, setMany, remove, clearAll, listAll };
