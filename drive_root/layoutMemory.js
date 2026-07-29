// layoutMemory.js — centralized server-side storage for custom form layouts.
//
// Allows storing layout configurations for uniListForm / uniRecordForm indexed by
// (appName, tableName, role[]).  Before generating the standard auto-layout those
// apps look up a stored layout here.
//
// Public API:
//   saveLayout({ appName, tableName, roles, layout, events, clientScript })
//     — saves layout, optional event handlers, and optional clientScript UID.
//       Pass roles: '*'  to match any role.
//       events: { onBeforeSave: { serverScript, fn } } — server-side event bindings.
//       clientScript: UID клиентского скрипта (loadScript), используется как дефолт
//       для всех events в лейауте (чтобы не дублировать clientScript в каждом binding).
//
//   getLayoutForUser(appName, tableName, userRole)
//     — returns { layout, events, clientScript } or null if not found.
//       First tries exact role match, then falls back to wildcard '*'.
//
//   getUserRoleBySession(sessionID)
//     — utility: resolves role string from session ID (async).
//
// Example (call from any server-side code):
//   const layoutMemory = require('./drive_root/layoutMemory');
//   await layoutMemory.saveLayout({
//       appName: 'uniRecordForm',
//       tableName: 'hotels',
//       roles: ['admin', 'manager'],
//       layout: [ /* your layout JSON */ ]
//   });

'use strict';

const memoryStore = require('./memory_store');

const NAMESPACE = 'layouts';

// Local registry of appName+tableName pairs that have ANY layout stored.
// Checked synchronously before any async DB/HTTP work — zero overhead when
// no custom layout is registered for the given table.
const _registeredPrefixes = new Set();

// Table-level icon registry: tableName → iconPath.
// Populated automatically by saveLayout when formIcon is provided.
// Any app can query getTableIcon(tableName) without needing its own layout.
const _tableIcons = new Map();

// Table-level caption registry: tableName → string | { i18n: 'key' }.
// Populated automatically by saveLayout when appCaption is provided.
// _tableCaptions       — заголовок СПИСКА (множественное число, напр. «Бронирования»).
// _tableRecordCaptions — заголовок ЗАПИСИ  (единственное число, напр. «Бронирование»),
//                        к нему добавляется представление (name) записи.
const _tableCaptions = new Map();
const _tableRecordCaptions = new Map();

// Table-level icon registry для режима списка: tableName → iconPath.
// Иконка записи (формы) хранится в _tableIcons (formIcon); иконка списка — здесь (listIcon).
const _tableListIcons = new Map();

// Table-level сортировка списка по умолчанию: tableName → [{ field, order }].
// Регистрируется приложением через registerListSort(); читается дефолтным списком
// uniForm (DynamicTable) как initialSort. Если не задана — список сортируется по name.
const _tableListSort = new Map();

// 5.2 — кэш ПЕРЕВЕДЁННОГО лейаута по ключу `storageKey|language`.
// getLayoutForUser при наличии sessionID делал на КАЖДОЕ открытие формы
// JSON.parse(JSON.stringify(result)) (глубокий клон) + рекурсивный перевод
// всех { i18n: key } captions. Результат детерминирован по (matchedKey, language),
// поэтому кэшируется. Возврат по ссылке безопасен: все потребители uniForm
// (apps/uniForm/server.js) обращаются с результатом как с read-only — поля events/
// clientScript/иконки/captions только читаются, а .layout перед мутацией повторно
// клонируется (строки 164, 739) → закэшированный объект не мутируется (анти-паттерн №19
// не нарушается). Кэш ограничен по смыслу (число лейаутов × число языков),
// инвалидируется целиком в saveLayout. Выключатель: LAYOUT_TRANSLATE_CACHE_DISABLE=1.
const _translatedCache = new Map();
const _TRANSLATE_CACHE_DISABLED = process.env.LAYOUT_TRANSLATE_CACHE_DISABLE === '1';



/**
 * Build the storage key.
 * @param {string} appName
 * @param {string} mode     — 'record' | 'list'
 * @param {string} tableName
 * @param {string} role
 * @returns {string}
 */
function makeKey(appName, mode, tableName, role) {
    return `${appName}|${mode || 'record'}|${tableName}|${role}`;
}

function makePrefix(appName, mode, tableName) {
    return `${appName}|${mode || 'record'}|${tableName}`;
}

/**
 * Save a custom layout to server memory.
 *
 * @param {object} opts
 * @param {string}          opts.appName   — 'uniForm'
 * @param {string}          [opts.mode]    — 'record' (default) | 'list'
 * @param {string}          opts.tableName — DB table name (e.g. 'hotels')
 * @param {string|string[]} opts.roles     — role name(s) or '*' for any role
 * @param {Array}           [opts.layout]  — layout JSON array. Можно НЕ передавать, если
 *   задан `extraButtons`: тогда форма остаётся автогенерируемой (uniForm строит её из
 *   модели), а регистрация добавляет к ней только прикладные кнопки. Это единственный
 *   способ дополнить автоформу таблицы, состав полей которой дописывают другие слои
 *   (напр. `users`: фреймворк + `organizationId` из проекта) — ручной лейаут их потерял бы.
 * @param {Array}           [opts.extraButtons] — прикладные кнопки для `commandBar`
 *   автогенерируемой формы записи (формат — как `commandBar.extraButtons` в лейауте).
 * @param {object}          [opts.events]  — server-side event handlers, e.g.:
 *   { onBeforeSave: { serverScript: 'myScript', fn: 'onBeforeSave' } }
 * @param {string}          [opts.clientScript] — UID клиентского скрипта (loadScript).
 *   Используется как дефолт для всех events в лейауте, чтобы не дублировать clientScript в каждом binding.
 * @param {string}          [opts.formIcon] — URL иконки формы для заголовка и таскбара.
 * @param {string|object}   [opts.appCaption] — Человекочитаемое имя формы/приложения.
 *   Строка или объект { i18n: 'key' } — резолвится сервером при выдаче.
 */
async function saveLayout({ appName, mode, tableName, roles, layout, extraButtons, events, clientScript, formIcon, appCaption, recordCaption, listIcon, windowState }) {
    if (!appName || !tableName || (!Array.isArray(layout) && !Array.isArray(extraButtons))) {
        throw new Error('[layoutMemory.saveLayout] appName, tableName and layout (Array) are required (or extraButtons for an auto-generated form)');
    }
    const effectiveMode = mode || 'record';
    const roleList = Array.isArray(roles) ? roles : (roles ? [String(roles)] : ['*']);
    // layout всегда пишем массивом (потребители различают «нет кастомного лейаута» по
    // пустому массиву, а `undefined` сломал бы разбор записи в getLayoutForUser).
    const storedLayout = Array.isArray(layout) ? layout : [];
    for (const role of roleList) {
        await memoryStore.set(NAMESPACE, makeKey(appName, effectiveMode, tableName, role), { layout: storedLayout, extraButtons: Array.isArray(extraButtons) ? extraButtons : null, events: events || null, clientScript: clientScript || null, formIcon: formIcon || null, appCaption: appCaption || null, recordCaption: recordCaption || null, listIcon: listIcon || null, windowState: windowState || null });
    }
    // Register prefix so hot-path can skip tables with no layouts at all
    _registeredPrefixes.add(makePrefix(appName, effectiveMode, tableName));
    // 5.2 — лейаут пересохранён → переведённые клоны для его ключей устарели.
    // saveLayout вызывается на старте (и редко в рантайме), поэтому чистим целиком.
    _translatedCache.clear();
    // Auto-register table-level icon записи (formIcon) и списка (listIcon)
    if (formIcon) _tableIcons.set(tableName, formIcon);
    if (listIcon) _tableListIcons.set(tableName, listIcon);
    // Auto-register table-level caption списка (appCaption) и записи (recordCaption)
    if (appCaption) _tableCaptions.set(tableName, appCaption);
    if (recordCaption) _tableRecordCaptions.set(tableName, recordCaption);
    console.log(`[layoutMemory] saved layout for ${appName}/${effectiveMode}/${tableName} roles=[${roleList.join(',')}]`);
}

/**
 * Recursively translate all { i18n: 'key' } caption objects in a layout node tree.
 * Mutates nodes in-place (call only on a deep-cloned layout).
 * @param {Array|object} nodes - layout array or single node
 * @param {Function} tFn - synchronous translate function: (key) => string
 */
function translateLayoutCaptions(nodes, tFn) {
    if (!nodes) return;
    const arr = Array.isArray(nodes) ? nodes : [nodes];
    for (const node of arr) {
        if (!node || typeof node !== 'object') continue;
        if (node.caption && typeof node.caption === 'object' && node.caption.i18n) {
            node.caption = tFn(node.caption.i18n);
        }
        // tooltip — та же природа, что и caption (подпись колонки-значка и т.п.).
        if (node.tooltip && typeof node.tooltip === 'object' && node.tooltip.i18n) {
            node.tooltip = tFn(node.tooltip.i18n);
        }
        if (Array.isArray(node.layout))       translateLayoutCaptions(node.layout, tFn);
        if (Array.isArray(node.columns))       translateLayoutCaptions(node.columns, tFn);
        if (Array.isArray(node.options))       translateLayoutCaptions(node.options, tFn);
        if (Array.isArray(node.extraButtons))  translateLayoutCaptions(node.extraButtons, tFn);
        // menu[] — пункты выпадающего меню (splitButton), у каждого свой caption.
        // При добавлении новой контейнерной ветви — обнови и uniForm.translateLayoutI18n!
        if (Array.isArray(node.menu))          translateLayoutCaptions(node.menu, tFn);
        // tabs[] hold their content in tab.layout / tab.caption — recurse so
        // captions inside tabs (groups, fields AND table columns) get translated.
        if (Array.isArray(node.tabs))          translateLayoutCaptions(node.tabs, tFn);
    }
}

/**
 * Retrieve a custom layout for the given user role.
 * Returns the layout array, or null if no custom layout was stored.
 *
 * Fast-path: if no layout has ever been saved for this appName+tableName,
 * returns null synchronously — no DB queries, no HTTP calls.
 *
 * @param {string} appName
 * @param {string} tableName
 * @param {string|null} userRole
 * @param {string} [sessionID] - when provided, captions with { i18n: 'key' } are translated
 * @param {string} [mode]      - 'record' (default) | 'list'
 * @returns {Promise<Array|null>}
 */
async function getLayoutForUser(appName, tableName, userRole, sessionID, mode) {
    if (!appName || !tableName) return null;
    const effectiveMode = mode || 'record';

    // Fast-path: nothing registered for this table — immediate return
    if (!_registeredPrefixes.has(makePrefix(appName, effectiveMode, tableName))) return null;

    let result = null;
    let matchedKey = null;

    // 1. Exact role match (in-memory Map → instant)
    if (userRole) {
        const k = makeKey(appName, effectiveMode, tableName, userRole);
        const stored = memoryStore.getSync(NAMESPACE, k);
        if (stored) {
            result = stored.layout !== undefined ? stored : { layout: stored, events: null, clientScript: null, formIcon: null, appCaption: null };
            matchedKey = k;
        }
    }

    // 2. Wildcard match (any role)
    if (!result) {
        const k = makeKey(appName, effectiveMode, tableName, '*');
        const fallback = memoryStore.getSync(NAMESPACE, k);
        if (!fallback) return null;
        result = fallback.layout !== undefined ? fallback : { layout: fallback, events: null, clientScript: null, formIcon: null, appCaption: null };
        matchedKey = k;
    }

    // 3. Translate { i18n: 'key' } captions when sessionID is provided
    if (result && sessionID) {
        try {
            const formsCtx = require('../drive_forms/globalServerContext');
            const { language } = await formsCtx.getSessionContext(sessionID);
            // 5.2 — переведённый результат детерминирован по (matchedKey, language) → кэш.
            const cacheKey = matchedKey + '|' + (language || '');
            if (!_TRANSLATE_CACHE_DISABLED) {
                const hit = _translatedCache.get(cacheKey);
                if (hit) return hit;
            }
            const i18n = require('./i18n');
            // Deep-clone to avoid mutating the cached original (anti-pattern: mutable memory_store object)
            const cloned = JSON.parse(JSON.stringify(result));
            translateLayoutCaptions(cloned.layout, (key) => i18n.t(key, language));
            if (!_TRANSLATE_CACHE_DISABLED) _translatedCache.set(cacheKey, cloned);
            return cloned;
        } catch (e) {
            console.error('[layoutMemory.getLayoutForUser] i18n translation error:', e && e.message || e);
        }
    }

    return result;
}

/**
 * Utility: resolve the role name for a given session ID.
 * Caching is handled inside getUserBySessionID and getUserAccessRole themselves.
 *
 * @param {string} sessionID
 * @returns {Promise<string|null>}
 */
async function getUserRoleBySession(sessionID) {
    if (!sessionID) return null;
    try {
        const globalCtx = require('./globalServerContext');
        const formsCtx = require('../drive_forms/globalServerContext');
        const user = await globalCtx.getUserBySessionID(sessionID);
        if (!user) return null;
        return await formsCtx.getUserAccessRole(user);
    } catch (e) {
        console.error('[layoutMemory.getUserRoleBySession] error:', e && e.message || e);
        return null;
    }
}

/**
 * Synchronous check: has saveLayout ever been called for this app+table?
 * If false — no custom layouts exist, skip all async work entirely.
 *
 * @param {string} appName
 * @param {string} tableName
 * @returns {boolean}
 */
function hasRegistered(appName, tableName, mode) {
    return _registeredPrefixes.has(makePrefix(appName, mode || 'record', tableName));
}

/**
 * Get the icon registered for a table (set by any saveLayout with formIcon).
 * @param {string} tableName
 * @returns {string|null}
 */
function getTableIcon(tableName) {
    return _tableIcons.get(tableName) || null;
}

/**
 * Get the caption registered for a table (set by any saveLayout with appCaption).
 * Returns the raw value (string or { i18n: 'key' }) — caller must resolve i18n.
 * @param {string} tableName
 * @returns {string|object|null}
 */
function getTableCaption(tableName) {
    return _tableCaptions.get(tableName) || null;
}

/**
 * Get the singular record-caption registered for a table (saveLayout recordCaption).
 * Used as the record window title prefix (before the record's presentation/name).
 * Returns the raw value (string or { i18n: 'key' }).
 * @param {string} tableName
 * @returns {string|object|null}
 */
function getTableRecordCaption(tableName) {
    return _tableRecordCaptions.get(tableName) || null;
}

/**
 * Get the list-mode icon registered for a table (saveLayout listIcon).
 * @param {string} tableName
 * @returns {string|null}
 */
function getTableListIcon(tableName) {
    return _tableListIcons.get(tableName) || null;
}

/**
 * Register a default list sort for a table (used by the auto-generated DynamicTable list).
 * @param {string} tableName
 * @param {Array<{field:string, order:string}>} sort — e.g. [{ field: 'number', order: 'desc' }]
 */
function registerListSort(tableName, sort) {
    if (!tableName || !Array.isArray(sort)) return;
    _tableListSort.set(tableName, sort);
}

/**
 * Get the default list sort for a table, or null.
 * @param {string} tableName
 * @returns {Array<{field:string, order:string}>|null}
 */
function getListSort(tableName) {
    return _tableListSort.get(tableName) || null;
}

module.exports = { saveLayout, getLayoutForUser, getUserRoleBySession, hasRegistered, getTableIcon, getTableCaption, getTableRecordCaption, getTableListIcon, registerListSort, getListSort };
