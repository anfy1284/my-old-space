'use strict';

/**
 * settings — чтение и запись настроек приложений (серверный API).
 *
 * Единый механизм вместо трёх копий EAV (`apps/UserSettings`, `apps/organizationSettings`,
 * `apps/systemSettings`). Объявления — в `settings.json` приложений (см. `./registry.js`),
 * значения — в одной таблице `settings_values`.
 *
 * ── Цепочка чтения ───────────────────────────────────────────────────────────
 *   значение записи → строка дефолтов (`__default`, правит админ) → `default` из файла.
 * Наследования между уровнями НЕТ: настройка живёт ровно на одном уровне (решение
 * владельца 09.09.2026). Дефолт не копируется в запись при её создании — иначе
 * «не задано» стало бы неотличимо от «задано и совпало», а настройка, добавленная в
 * новой версии, не досталась бы существующим записям вовсе.
 *
 * ── Почему нет кэша ──────────────────────────────────────────────────────────
 * Кэш настроек уже стрелял: у воркера планировщика свой процесс и свой кэш, наполненный
 * при старте, и задача неделями работала по настройкам, которые администратор давно
 * поменял (`backup.settings.load`). Настройки читаются редко — запрос дешевле этого
 * класса ошибок.
 *
 * ── Права ────────────────────────────────────────────────────────────────────
 * Этот модуль прав НЕ проверяет: его зовёт серверный прикладной код, которому уже можно.
 * Проверка «кому можно править чужое» живёт в RPC формы настроек — там, где появляется
 * пришедший с клиента `userId`.
 *
 * @module drive_root/settings
 */

const log = require('../log');
const registry = require('./registry');
const types = require('./types');

/** Модели рантайма. В процессе миграции их нет — там работает `./seed.js`. */
function models() {
    return require('../globalServerContext').modelsDB || null;
}

/** Модель по имени таблицы (`hotels` → модель Hotels). */
function modelByTable(tableName) {
    const all = models();
    if (!all) return null;
    for (const name of Object.keys(all)) {
        const m = all[name];
        if (m && m.tableName === tableName) return m;
    }
    return null;
}

function valuesModel() {
    const all = models();
    return all ? all.SettingsValues : null;
}

/**
 * Адрес уровня в таблице значений.
 * @returns {{scopeTable: string, scopeId: string, scope: Object}}
 */
function scopeAddress(scopeName, recordId) {
    registry.ensureLoaded();
    const scope = registry.getScope(scopeName);
    if (!scope) throw new Error(`[settings] уровень "${scopeName}" не объявлен`);
    if (scope.ownerless) return { scopeTable: scope.scopeTable, scopeId: scope.scopeTable, scope };
    if (!recordId) throw new Error(`[settings] уровень "${scopeName}" требует запись-владельца`);
    return { scopeTable: scope.scopeTable, scopeId: String(recordId), scope };
}

/** Объявление настройки или внятная ошибка: молчаливый null здесь недопустим. */
function declarationOf(appName, key, expectedScope) {
    registry.ensureLoaded();
    const decl = registry.getSetting(appName, key);
    if (!decl) throw new Error(`[settings] настройка "${appName}.${key}" не объявлена`);
    if (expectedScope && decl.scope !== expectedScope) {
        throw new Error(`[settings] настройка "${appName}.${key}" объявлена на уровне "${decl.scope}", а прочитана на "${expectedScope}"`);
    }
    return decl;
}

// ── Строки значений ──────────────────────────────────────────────────────────

/**
 * Содержимое строки значений (или `{}`, если строки нет).
 *
 * Читаем напрямую через модель, а не через `dbGateway`: строки уровней `__system` и
 * `__default` не принадлежат ни пользователю, ни организации, и RLS их не отдаст —
 * так же поступает нынешний `apps/systemSettings/lib`.
 */
async function loadData(scopeTable, scopeId, appName, kind) {
    const SettingsValues = valuesModel();
    if (!SettingsValues) return {};
    try {
        const row = await SettingsValues.findOne({ where: { scopeTable, scopeId, appName, kind }, raw: true });
        return types.parseData(row && row.data);
    } catch (e) {
        log.error(`[settings] чтение ${appName}/${scopeTable}/${scopeId}:`, e && e.message);
        return {};
    }
}

/**
 * Служебные колонки строки — по ним фильтрует RLS. Заполняет ядро, прикладной код о
 * них не знает: уровень объявляет таблицу, принадлежность организации выводится из
 * самой записи-владельца (у `hotels` есть `organizationId`, значит настройки гостиницы
 * видны только своей организации).
 */
async function accessColumns(scope, scopeId) {
    const out = { userId: null, organizationId: null };
    if (scope.ownerless) return out;
    if (scope.table === 'users') { out.userId = scopeId; return out; }
    if (scope.table === 'organizations') { out.organizationId = scopeId; return out; }

    const model = modelByTable(scope.table);
    if (!model || !model.rawAttributes || !model.rawAttributes.organizationId) return out;
    try {
        const owner = await model.findByPk(scopeId, { raw: true });
        if (owner && owner.organizationId) out.organizationId = owner.organizationId;
    } catch (e) {
        log.warn(`[settings] организация записи ${scope.table}/${scopeId} не определена:`, e && e.message);
    }
    return out;
}

/** Записать набор значений строки (создать или обновить). */
async function saveData(scope, scopeTable, scopeId, appName, kind, data) {
    const SettingsValues = valuesModel();
    if (!SettingsValues) throw new Error('[settings] модель SettingsValues недоступна');

    const access = await accessColumns(scope, scopeId);
    const row = await SettingsValues.findOne({ where: { scopeTable, scopeId, appName, kind } });
    if (row) {
        await row.update({ data, userId: access.userId, organizationId: access.organizationId });
    } else {
        await SettingsValues.create({
            scopeTable, scopeId, appName, kind, data,
            userId: access.userId, organizationId: access.organizationId
        });
    }
}

// ── Разрешение значения ──────────────────────────────────────────────────────

/**
 * Значение → дефолт из строки дефолтов → `default` из файла.
 * Для ссылок дополнительно проверяется, что запись справочника ещё существует.
 */
async function resolveValue(decl, raw, defaults) {
    let value = raw;
    // «Не задано» — это и пустая строка тоже. Форма пустое поле пишет как null
    // (`types.serialize`), но пустая строка приезжает из переноса старых настроек и из
    // прикладного кода; если считать её значением, запись молча теряет умолчание.
    if (types.isBlank(value)) {
        const fromDefaults = defaults ? defaults[decl.key] : undefined;
        value = (fromDefaults === undefined) ? decl.default : fromDefaults;
    }

    if (decl.type === 'reference' && value) {
        const model = modelByTable(decl.reference.table);
        if (model) {
            try {
                const found = await model.findByPk(String(value), { raw: true });
                if (!found) {
                    log.warn(`[settings] ${decl.app}.${decl.key}: записи ${decl.reference.table}/${value} больше нет — берётся значение по умолчанию`);
                    value = decl.default;
                }
            } catch (e) {
                log.warn(`[settings] ${decl.app}.${decl.key}: проверка ссылки не удалась:`, e && e.message);
            }
        }
    }

    return types.coerce(decl, value);
}

// ── Чтение ───────────────────────────────────────────────────────────────────

/**
 * Значение настройки на уровне записи.
 * @param {string} scopeName — имя уровня (`organization`, `hotel`, …)
 * @param {string} recordId — UID записи-владельца
 */
async function getRecordSetting(scopeName, recordId, appName, key) {
    const decl = declarationOf(appName, key, scopeName);
    const { scopeTable, scopeId } = scopeAddress(scopeName, recordId);
    const data = await loadData(scopeTable, scopeId, appName, registry.KIND_SETTING);
    const defaults = await loadDefaults(appName);
    return resolveValue(decl, data[key], defaults);
}

/** Значение настройки пользователя. */
function getUserSetting(userId, appName, key) {
    return getRecordSetting('user', userId, appName, key);
}

/** Значение системной настройки (одна на инсталляцию). */
async function getSystemSetting(appName, key) {
    const decl = declarationOf(appName, key, 'system');
    const { scopeTable, scopeId } = scopeAddress('system');
    const data = await loadData(scopeTable, scopeId, appName, registry.KIND_SETTING);
    const defaults = await loadDefaults(appName);
    return resolveValue(decl, data[key], defaults);
}

/** Строка дефолтов приложения (значения, которые правит администратор). */
function loadDefaults(appName) {
    return loadData(registry.DEFAULT_SCOPE_TABLE, registry.DEFAULT_SCOPE_TABLE, appName, registry.KIND_SETTING);
}

/** Значение по умолчанию (строка дефолтов, иначе объявление). */
async function getDefault(appName, key) {
    const decl = declarationOf(appName, key);
    const defaults = await loadDefaults(appName);
    const raw = defaults[key];
    return types.coerce(decl, raw === undefined ? decl.default : raw);
}

/**
 * Все настройки приложения на уровне — одним запросом.
 * @returns {Promise<Object>} { ключ: значение } (только настройки этого уровня)
 */
async function getAppSettings(scopeName, recordId, appName) {
    registry.ensureLoaded();
    const { scopeTable, scopeId } = scopeAddress(scopeName, recordId);
    const data = await loadData(scopeTable, scopeId, appName, registry.KIND_SETTING);
    const defaults = await loadDefaults(appName);

    const out = {};
    for (const decl of registry.getSettings(appName)) {
        if (decl.scope !== scopeName) continue;
        out[decl.key] = await resolveValue(decl, data[decl.key], defaults);
    }
    return out;
}

// ── Запись ───────────────────────────────────────────────────────────────────

/** Проверить значение по объявлению и вернуть готовое к записи. */
async function prepare(decl, value) {
    const checked = types.validate(decl, value);
    if (!checked.ok) throw new Error(`[settings] ${decl.app}.${decl.key}: ${checked.error}`);

    if (decl.type === 'reference' && checked.value) {
        const model = modelByTable(decl.reference.table);
        if (model) {
            const found = await model.findByPk(String(checked.value), { raw: true });
            if (!found) throw new Error(`[settings] ${decl.app}.${decl.key}: записи ${decl.reference.table}/${checked.value} не существует`);
        }
    }
    return checked.value;
}

/** Записать настройку на уровне записи. */
async function setRecordSetting(scopeName, recordId, appName, key, value) {
    const decl = declarationOf(appName, key, scopeName);
    const { scopeTable, scopeId, scope } = scopeAddress(scopeName, recordId);
    const prepared = await prepare(decl, value);

    const data = await loadData(scopeTable, scopeId, appName, registry.KIND_SETTING);
    data[key] = prepared;
    await saveData(scope, scopeTable, scopeId, appName, registry.KIND_SETTING, data);
    return prepared;
}

/** Записать настройку пользователя. */
function setUserSetting(userId, appName, key, value) {
    return setRecordSetting('user', userId, appName, key, value);
}

/** Записать системную настройку. */
async function setSystemSetting(appName, key, value) {
    const decl = declarationOf(appName, key, 'system');
    const { scopeTable, scopeId, scope } = scopeAddress('system');
    const prepared = await prepare(decl, value);

    const data = await loadData(scopeTable, scopeId, appName, registry.KIND_SETTING);
    data[key] = prepared;
    await saveData(scope, scopeTable, scopeId, appName, registry.KIND_SETTING, data);
    return prepared;
}

/** Изменить значение по умолчанию (действует на все записи, где значение не задано). */
async function setDefault(appName, key, value) {
    const decl = declarationOf(appName, key);
    const scope = registry.getScope('default');
    const prepared = await prepare(decl, value);

    const data = await loadDefaults(appName);
    data[key] = prepared;
    await saveData(scope, registry.DEFAULT_SCOPE_TABLE, registry.DEFAULT_SCOPE_TABLE, appName, registry.KIND_SETTING, data);
    return prepared;
}

/**
 * Убрать значение у записи — настройка снова работает по умолчанию.
 * Именно убрать, а не записать дефолт: «не задано» должно оставаться пустым.
 */
async function clearSetting(scopeName, recordId, appName, key) {
    const decl = declarationOf(appName, key, scopeName);
    const { scopeTable, scopeId, scope } = scopeAddress(scopeName, recordId);
    const data = await loadData(scopeTable, scopeId, appName, registry.KIND_SETTING);
    if (!(decl.key in data)) return;
    delete data[key];
    await saveData(scope, scopeTable, scopeId, appName, registry.KIND_SETTING, data);
}

module.exports = {
    // чтение
    getSystemSetting, getUserSetting, getRecordSetting, getAppSettings, getDefault,
    // запись
    setSystemSetting, setUserSetting, setRecordSetting, setDefault, clearSetting,
    // служебное
    registry, types, scopeAddress
};
