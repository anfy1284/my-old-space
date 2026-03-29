// layoutMemory.js — centralized server-side storage for custom form layouts.
//
// Allows storing layout configurations for uniListForm / uniRecordForm indexed by
// (appName, tableName, role[]).  Before generating the standard auto-layout those
// apps look up a stored layout here.
//
// Public API:
//   saveLayout({ appName, tableName, roles, layout })
//     — saves layout for one or more roles (roles can be string or array).
//       Pass roles: '*'  to match any role.
//
//   getLayoutForUser(appName, tableName, userRole)
//     — returns stored layout array or null if not found.
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
 */
async function saveLayout({ appName, tableName, roles, layout }) {
    if (!appName || !tableName || !Array.isArray(layout)) {
        throw new Error('[layoutMemory.saveLayout] appName, tableName and layout (Array) are required');
    }
    const roleList = Array.isArray(roles) ? roles : (roles ? [String(roles)] : ['*']);
    for (const role of roleList) {
        await memoryStore.set(NAMESPACE, makeKey(appName, tableName, role), layout);
    }
    // Register prefix so hot-path can skip tables with no layouts at all
    _registeredPrefixes.add(makePrefix(appName, tableName));
    console.log(`[layoutMemory] saved layout for ${appName}/${tableName} roles=[${roleList.join(',')}]`);
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
 * @returns {Promise<Array|null>}
 */
async function getLayoutForUser(appName, tableName, userRole) {
    if (!appName || !tableName) return null;

    // Fast-path: nothing registered for this table — immediate return
    if (!_registeredPrefixes.has(makePrefix(appName, tableName))) return null;

    // 1. Exact role match (in-memory Map → instant)
    if (userRole) {
        const layout = memoryStore.getSync(NAMESPACE, makeKey(appName, tableName, userRole));
        if (Array.isArray(layout)) return layout;
    }

    // 2. Wildcard match (any role)
    const fallback = memoryStore.getSync(NAMESPACE, makeKey(appName, tableName, '*'));
    return Array.isArray(fallback) ? fallback : null;
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

module.exports = { saveLayout, getLayoutForUser, getUserRoleBySession, hasRegistered };
