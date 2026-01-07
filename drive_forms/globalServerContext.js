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
    if (!fs.existsSync(configPath)) continue;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (Array.isArray(config.access) && config.access.includes(effectiveRole)) {
      console.log(`[loadApps] Loading app: ${app.name}`);
      // Only load apps marked with autoStart: true
      if (config.autoStart === true) {
        const clientPath = path.resolve(baseDir, appsBasePath, cleanAppPath, 'resources', 'public', 'client.js');
        if (fs.existsSync(clientPath)) {
          allCode += fs.readFileSync(clientPath, 'utf8') + '\n\n';
        }
      }
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

// Get AccessRole for user object
async function getUserAccessRole(user) {
  if (!user) return 'nologged';
  // Find first user_systems record for user
  const userSystem = await UserSystem.findOne({ where: { userId: user.id }, order: [['id', 'ASC']] });
  if (!userSystem || !userSystem.roleId) {
    console.log(`[getUserAccessRole] No userSystem or roleId found for user ${user.id}`);
    return null;
  }
  const role = await AccessRole.findOne({ where: { id: userSystem.roleId } });
  if (!role) {
    console.log(`[getUserAccessRole] Role not found for roleId ${userSystem.roleId}`);
    return null;
  }
  return role ? role.name : null;
}

module.exports = {
  getUserAccessRole,
  loadApps,
  // User management is no longer at this level
};
