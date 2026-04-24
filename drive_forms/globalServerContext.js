const global = require('../drive_root/globalServerContext');
const eventBus = require('../drive_root/eventBus');
const fs = require('fs');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');
const sequelize = require('../drive_root/db/sequelize_instance');
async function loadApps(user) {
  const accessRole = await getUserAccessRole(user);
  console.log(`[loadApps] Loading apps for user: ${user ? user.name : 'null'}, role: ${accessRole}`);
  const localAppsPath = path.join(__dirname, 'apps.json');
  const packageAppsPath = path.join(__dirname, '..', 'apps.json');
  const projectAppsPath = path.resolve(process.cwd(), 'apps.json');

  // Collect sources in order: framework (drive_forms), package root, project root
  const sources = [];
  try {
    if (fs.existsSync(localAppsPath)) {
      // apps.json inside drive_forms references apps located in package root 'apps/'
      sources.push({ cfg: JSON.parse(fs.readFileSync(localAppsPath, 'utf8')), baseDir: path.resolve(__dirname, '..') });
    }
  } catch (e) { console.error('[loadApps] Error reading', localAppsPath, e.message); }
  try {
    if (fs.existsSync(packageAppsPath)) {
      sources.push({ cfg: JSON.parse(fs.readFileSync(packageAppsPath, 'utf8')), baseDir: path.resolve(__dirname, '..') });
    }
  } catch (e) { console.error('[loadApps] Error reading', packageAppsPath, e.message); }
  try {
    if (fs.existsSync(projectAppsPath)) {
      sources.push({ cfg: JSON.parse(fs.readFileSync(projectAppsPath, 'utf8')), baseDir: process.cwd() });
    }
  } catch (e) { console.error('[loadApps] Error reading', projectAppsPath, e.message); }

  // Merge apps with priority: project -> package -> framework (later sources override earlier)
  const appsMap = new Map();
  let finalPath = '/apps';
  for (const src of sources) {
    const cfg = src.cfg || {};
    const apps = cfg.apps || [];
    const appsPath = (cfg.path || '/apps').replace(/^[/\\]+/, '');
    if (cfg.path) finalPath = cfg.path;
    for (const app of apps) {
      appsMap.set(app.name, Object.assign({}, app, { __appsBaseDir: src.baseDir, __appsPath: appsPath }));
    }
  }

  const appsList = Array.from(appsMap.values());
  let allCode = '';
  
  // Don't convert nologged to public - keep as is to load login app
  const effectiveRole = accessRole || 'nologged';
  
  console.log('[loadApps] effectiveRole:', effectiveRole);
  
  for (const app of appsList) {
    const baseDir = app.__appsBaseDir || path.resolve(__dirname, '..');
    const appsBasePath = app.__appsPath || 'apps';
    const cleanAppPath = (app.path || `/${app.name}`).replace(/^[/\\]+/, '');
    const configPath = path.resolve(baseDir, appsBasePath, cleanAppPath, 'config.json');
    if (!fs.existsSync(configPath)) {
      console.log(`[loadApps] Config not found for ${app.name}: ${configPath}`);
      continue;
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (Array.isArray(config.access) && config.access.includes(effectiveRole)) {
      console.log(`[loadApps] Loading app: ${app.name}, autoStart: ${config.autoStart}`);
      // Only load apps marked with autoStart: true
      if (config.autoStart === true) {
        const clientPath = path.resolve(baseDir, appsBasePath, cleanAppPath, 'resources', 'public', 'client.js');
        if (fs.existsSync(clientPath)) {
          allCode += fs.readFileSync(clientPath, 'utf8') + '\n\n';
        }
      }
    } else {
      console.log(`[loadApps] Skipping app: ${app.name}, access: ${JSON.stringify(config.access)}, effectiveRole: ${effectiveRole}`);
    }
  }
  return allCode;
}
// Global functions for drive_forms server modules

const dbConfig = require('./db/db.json');
const modelsDef = dbConfig.models;

const accessRoleDef = modelsDef.find(m => m.name === 'AccessRoles');
const userSystemDef = modelsDef.find(m => m.name === 'UserSystems');

const AccessRole = sequelize.define(accessRoleDef.name, Object.fromEntries(
  Object.entries(accessRoleDef.fields).map(([k, v]) => [k, { ...v, type: DataTypes[v.type] }])
), { ...accessRoleDef.options, tableName: accessRoleDef.tableName });

const UserSystem = sequelize.define(userSystemDef.name, Object.fromEntries(
  Object.entries(userSystemDef.fields).map(([k, v]) => [k, { ...v, type: DataTypes[v.type] }])
), { ...userSystemDef.options, tableName: userSystemDef.tableName });

const _memStoreForRoles = require('../drive_root/memory_store');
const _USER_ROLE_NS = 'user_roles';

// Get AccessRole for user object
async function getUserAccessRole(user) {
  if (!user) return 'nologged';
  const userId = user.UID;
  // L1: same-process Map (synchronous)
  const cachedL1 = _memStoreForRoles.getSync(_USER_ROLE_NS, userId);
  if (cachedL1 !== null && cachedL1 !== undefined) return cachedL1;
  // L2: shared memory_store service (cross-process)
  const cachedL2 = await _memStoreForRoles.get(_USER_ROLE_NS, userId);
  if (cachedL2 !== null && cachedL2 !== undefined) return cachedL2;

  // L3: DB
  const userSystem = await UserSystem.findOne({ where: { userId }, order: [['UID', 'ASC']] });
  if (!userSystem || !userSystem.roleId) {
    console.log(`[getUserAccessRole] No userSystem or roleId found for user ${userId}`);
    return null;
  }
  const role = await AccessRole.findOne({ where: { UID: userSystem.roleId } });
  const result = role ? role.name : null;
  await _memStoreForRoles.set(_USER_ROLE_NS, userId, result);
  return result;
}

// Session context cache namespace
const _SESSION_CTX_NS = 'session_context';
const _SYSTEM_SESSION_ID = '__SYS_INTERNAL__';

/**
 * Returns unified session context for the current user.
 * Cached per sessionID; invalidate via invalidateSessionContext() on settings change.
 *
 * Returned object: { userId, name, role, language }
 *   - userId:   user UID string
 *   - name:     display name
 *   - role:     access role ('admin', 'user', 'nologged', ...)
 *   - language: ISO 639-1 code from user's Language setting ('en' by default)
 */
async function getSessionContext(sessionID) {
    if (!sessionID || sessionID === _SYSTEM_SESSION_ID) {
        return { userId: null, name: null, role: null, language: 'en' };
    }

    // L1: same-process Map
    const cachedL1 = _memStoreForRoles.getSync(_SESSION_CTX_NS, sessionID);
    if (cachedL1 !== null && cachedL1 !== undefined) return cachedL1;

    // L2: cross-process shared store
    const cachedL2 = await _memStoreForRoles.get(_SESSION_CTX_NS, sessionID);
    if (cachedL2 !== null && cachedL2 !== undefined) return cachedL2;

    // L3: build from DB
    const user = await global.getUserBySessionID(sessionID);
    if (!user) return { userId: null, name: null, role: null, language: 'en' };

    const role = await getUserAccessRole(user);

    // Resolve user's language preference from settings
    let language = 'en';
    try {
        const mdb = global.modelsDB;
        if (mdb && mdb.UserSettingsFields && mdb.UserSettingsStringValues && mdb.Languages) {
            const langField = await mdb.UserSettingsFields.findOne({ where: { name: 'Language' } });
            if (langField) {
                const val = await mdb.UserSettingsStringValues.findOne({
                    where: { userId: user.UID, settingsFieldId: langField.UID }
                });
                if (val && val.value) {
                    const langRecord = await mdb.Languages.findByPk(val.value);
                    if (langRecord) language = langRecord.code;
                }
            }
        }
    } catch (e) {
        console.error('[getSessionContext] Error resolving language:', e.message);
    }

    const ctx = { userId: user.UID, name: user.name, role, language };
    await _memStoreForRoles.set(_SESSION_CTX_NS, sessionID, ctx);
    return ctx;
}

/**
 * Invalidate session context cache for a user (call after settings change).
 * @param {string} sessionID
 */
function invalidateSessionContext(sessionID) {
    if (!sessionID) return;
    _memStoreForRoles.del(_SESSION_CTX_NS, sessionID).catch(() => {});
}

/**
 * Translate a key using the language from the session context.
 * Async convenience wrapper around drive_root/i18n.t().
 * @param {string} key - translation key
 * @param {string} sessionID
 * @returns {Promise<string>}
 */
async function tForSession(key, sessionID) {
    const { language } = await getSessionContext(sessionID);
    const i18n = require('../drive_root/i18n');
    return i18n.t(key, language);
}

/**
 * Translate a key with named placeholder substitution {{varName}}.
 * @param {string} key
 * @param {string} sessionID
 * @param {Object} [vars={}]
 * @returns {Promise<string>}
 */
async function tfForSession(key, sessionID, vars = {}) {
    const { language } = await getSessionContext(sessionID);
    const i18n = require('../drive_root/i18n');
    return i18n.tf(key, language, vars);
}

module.exports = {
    getUserAccessRole,
    loadApps,
    getSessionContext,
    invalidateSessionContext,
    tForSession,
    tfForSession,
};
