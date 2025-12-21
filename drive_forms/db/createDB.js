// createDB.js for drive_forms
// This file collects models from drive_forms level and all apps
const fs = require('fs');
const path = require('path');
const dbConfig = require('./db.json');
const modelsDef = dbConfig.models || [];
const { processDefaultValues } = require('../../drive_root/globalServerContext');

// Load configuration and data
const formsConfig = require('../server_config.json');
const LEVEL = formsConfig.level;
const defaultValuesData = require('./defaultValues.json');
const defaultValues = processDefaultValues(defaultValuesData, LEVEL);

/**
 * Collects model definitions from drive_forms and all apps
 * Returns: { models: [...], defaultValuesByLevel: { level: defaultValues } }
 */
function collectModels() {
  // Start with drive_forms models
  let allModels = [...modelsDef];
  const defaultValuesByLevel = { [LEVEL]: defaultValues };

  // Get list of apps from multiple possible apps.json locations:
  // 1) drive_forms/apps.json (framework-local)
  // 2) my-old-space package root apps.json
  // 3) project root apps.json (process.cwd())
  const sources = [];
  const localAppsJsonPath = path.resolve(__dirname, '../apps.json'); // drive_forms/apps.json
  const packageAppsJsonPath = path.resolve(__dirname, '../../apps.json'); // my-old-space/apps.json
  const projectAppsJsonPath = path.resolve(process.cwd(), 'apps.json'); // project-level apps.json

  try {
    if (fs.existsSync(localAppsJsonPath)) {
      const cfg = JSON.parse(fs.readFileSync(localAppsJsonPath, 'utf8'));
      sources.push({ cfg, baseDir: path.resolve(__dirname, '..') });
    }
  } catch (e) { console.error('[COLLECT] Error reading', localAppsJsonPath, e.message); }

  try {
    if (fs.existsSync(packageAppsJsonPath)) {
      const cfg = JSON.parse(fs.readFileSync(packageAppsJsonPath, 'utf8'));
      sources.push({ cfg, baseDir: path.resolve(__dirname, '../../') });
    }
  } catch (e) { console.error('[COLLECT] Error reading', packageAppsJsonPath, e.message); }

  try {
    if (fs.existsSync(projectAppsJsonPath)) {
      const cfg = JSON.parse(fs.readFileSync(projectAppsJsonPath, 'utf8'));
      sources.push({ cfg, baseDir: process.cwd() });
    }
  } catch (e) { console.error('[COLLECT] Error reading', projectAppsJsonPath, e.message); }

  // Merge apps with priority: project -> package -> framework (later sources override earlier)
  const appsMap = new Map();
  for (const src of sources) {
    const cfg = src.cfg || {};
    const apps = cfg.apps || [];
    const appsPath = (cfg.path || 'apps').replace(/^[/\\]+/, '');
    for (const app of apps) {
      // prefer later sources (project) to override earlier entries
      appsMap.set(app.name, Object.assign({}, app, { __appsBaseDir: src.baseDir, __appsPath: appsPath }));
    }
  }

  const appsList = Array.from(appsMap.values());

  // Collect models and defaultValues from each app
  for (const app of appsList) {
    // Determine app directory based on source that provided this app
    const baseDir = app.__appsBaseDir || path.resolve(__dirname, '../../');
    const appsBasePath = app.__appsPath || 'apps';
    const cleanAppPath = (app.path || `/${app.name}`).replace(/^[/\\]+/, '');

    // Load models from app's db/db.json
    const dbPath = path.resolve(baseDir, `${appsBasePath}`, cleanAppPath, 'db', 'db.json');
    if (fs.existsSync(dbPath)) {
      try {
        const appExport = require(dbPath);
        const appModels = appExport.models || (Array.isArray(appExport) ? appExport : []);
        if (Array.isArray(appModels) && appModels.length > 0) {
          allModels = allModels.concat(appModels);
          console.log(`[COLLECT] Added ${appModels.length} models from app: ${app.name}`);
        }
      } catch (e) {
        console.error(`[COLLECT] Error loading models from ${dbPath}:`, e.message);
      }
    }

    // Load defaultValues from app's db/defaultValues.json
    const appDefPath = path.resolve(baseDir, `${appsBasePath}`, cleanAppPath, 'db', 'defaultValues.json');
    if (fs.existsSync(appDefPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(appDefPath, 'utf8'));
        defaultValuesByLevel[app.name] = processDefaultValues(raw, app.name);
        console.log(`[COLLECT] Added defaultValues for app: ${app.name}`);
      } catch (e) {
        console.error(`[COLLECT] Error loading defaultValues for app ${app.name}:`, e.message);
      }
    }
  }

  // Collect dynamic data from apps (systems, access_roles)
  const systemSet = new Set();
  const accessSet = new Set();

  for (const app of appsList) {
    const baseDir = app.__appsBaseDir || path.resolve(__dirname, '../../');
    const appsBasePath = app.__appsPath || 'apps';
    const cleanAppPath = (app.path || `/${app.name}`).replace(/^[/\\]+/, '');
    const configPath = path.resolve(baseDir, `${appsBasePath}`, cleanAppPath, 'config.json');
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (Array.isArray(config.system)) {
        config.system.forEach(s => systemSet.add(s));
      }
      if (Array.isArray(config.access)) {
        config.access.forEach(a => accessSet.add(a));
      }
    } catch (e) {
      // ignore missing config files for some apps, log other errors
      if (e.code !== 'ENOENT') {
        console.error(`[COLLECT] Error reading ${configPath}:`, e.message);
      }
    }
  }

  // Add dynamic data to drive_forms level defaultValues
  if (systemSet.size > 0 || accessSet.size > 0) {
    // Find max ID from existing defaultValues to avoid collisions
    let maxId = 0;
    for (const [entity, records] of Object.entries(defaultValuesByLevel[LEVEL] || {})) {
      if (Array.isArray(records)) {
        records.forEach(r => {
          if (r.id > maxId) maxId = r.id;
        });
      }
    }

    let nextId = maxId + 1;
    const formsDynamic = {
      systems: Array.from(systemSet).map(name => ({ id: nextId++, name, _level: LEVEL })),
      access_roles: Array.from(accessSet).map(name => ({ id: nextId++, name, _level: LEVEL }))
    };

    // Merge dynamic data with existing defaultValues for drive_forms level
    for (const [entity, records] of Object.entries(formsDynamic)) {
      if (Array.isArray(records) && records.length > 0) {
        if (!defaultValuesByLevel[LEVEL][entity]) {
          defaultValuesByLevel[LEVEL][entity] = [];
        }
        defaultValuesByLevel[LEVEL][entity] = [
          ...defaultValuesByLevel[LEVEL][entity],
          ...records
        ];
      }
    }
  }

  console.log(`[COLLECT] Total models collected from drive_forms and apps: ${allModels.length}`);
  console.log(`[COLLECT] Levels with defaultValues: ${Object.keys(defaultValuesByLevel).join(', ')}`);

  return { models: allModels, defaultValuesByLevel };
}

// Export collectModels function
module.exports = { collectModels };

