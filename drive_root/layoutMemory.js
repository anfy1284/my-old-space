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



/**
 * Build the storage key.
 * @param {string} appName
 * @param {string} tableName
 * @param {string} role
 * @returns {string}
 */
function makeKey(appName, tableName, role) {
    return `${appName}|${tableName}|${role}`;
}

function makePrefix(appName, tableName) {
    return `${appName}|${tableName}`;
}

/**
 * Save a custom layout to server memory.
 *
 * @param {object} opts
 * @param {string}          opts.appName   — 'uniListForm' | 'uniRecordForm'
 * @param {string}          opts.tableName — DB table name (e.g. 'hotels')
 * @param {string|string[]} opts.roles     — role name(s) or '*' for any role
 * @param {Array}           opts.layout    — layout JSON array
 * @param {object}          [opts.events]  — server-side event handlers, e.g.:
 *   { onBeforeSave: { serverScript: 'myScript', fn: 'onBeforeSave' } }
 * @param {string}          [opts.clientScript] — UID клиентского скрипта (loadScript).
 *   Используется как дефолт для всех events в лейауте, чтобы не дублировать clientScript в каждом binding.
 * @param {string}          [opts.formIcon] — URL иконки формы для заголовка и таскбара.
 */
async function saveLayout({ appName, tableName, roles, layout, events, clientScript, formIcon, windowState }) {
    if (!appName || !tableName || !Array.isArray(layout)) {
        throw new Error('[layoutMemory.saveLayout] appName, tableName and layout (Array) are required');
    }
    const roleList = Array.isArray(roles) ? roles : (roles ? [String(roles)] : ['*']);
    for (const role of roleList) {
        await memoryStore.set(NAMESPACE, makeKey(appName, tableName, role), { layout, events: events || null, clientScript: clientScript || null, formIcon: formIcon || null, windowState: windowState || null });
    }
    // Register prefix so hot-path can skip tables with no layouts at all
    _registeredPrefixes.add(makePrefix(appName, tableName));
    // Auto-register table-level icon
    if (formIcon) _tableIcons.set(tableName, formIcon);
    console.log(`[layoutMemory] saved layout for ${appName}/${tableName} roles=[${roleList.join(',')}]`);
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
        if (Array.isArray(node.layout))       translateLayoutCaptions(node.layout, tFn);
        if (Array.isArray(node.columns))       translateLayoutCaptions(node.columns, tFn);
        if (Array.isArray(node.options))       translateLayoutCaptions(node.options, tFn);
        if (Array.isArray(node.extraButtons))  translateLayoutCaptions(node.extraButtons, tFn);
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
 * @returns {Promise<Array|null>}
 */
async function getLayoutForUser(appName, tableName, userRole, sessionID) {
    if (!appName || !tableName) return null;

    // Fast-path: nothing registered for this table — immediate return
    if (!_registeredPrefixes.has(makePrefix(appName, tableName))) return null;

    let result = null;

    // 1. Exact role match (in-memory Map → instant)
    if (userRole) {
        const stored = memoryStore.getSync(NAMESPACE, makeKey(appName, tableName, userRole));
        if (stored) result = stored.layout !== undefined ? stored : { layout: stored, events: null, clientScript: null, formIcon: null };
    }

    // 2. Wildcard match (any role)
    if (!result) {
        const fallback = memoryStore.getSync(NAMESPACE, makeKey(appName, tableName, '*'));
        if (!fallback) return null;
        result = fallback.layout !== undefined ? fallback : { layout: fallback, events: null, clientScript: null, formIcon: null };
    }

    // 3. Translate { i18n: 'key' } captions when sessionID is provided
    if (result && sessionID) {
        try {
            const formsCtx = require('../drive_forms/globalServerContext');
            const i18n = require('./i18n');
            const { language } = await formsCtx.getSessionContext(sessionID);
            // Deep-clone to avoid mutating the cached original (anti-pattern: mutable memory_store object)
            const cloned = JSON.parse(JSON.stringify(result));
            translateLayoutCaptions(cloned.layout, (key) => i18n.t(key, language));
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
function hasRegistered(appName, tableName) {
    return _registeredPrefixes.has(makePrefix(appName, tableName));
}

/**
 * Get the icon registered for a table (set by any saveLayout with formIcon).
 * @param {string} tableName
 * @returns {string|null}
 */
function getTableIcon(tableName) {
    return _tableIcons.get(tableName) || null;
}

module.exports = { saveLayout, getLayoutForUser, getUserRoleBySession, hasRegistered, getTableIcon };
