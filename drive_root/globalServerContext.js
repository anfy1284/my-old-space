const fs = require('fs');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');
const sequelize = require('./db/sequelize_instance');
const eventBus = require('./eventBus');
const util = require('util');

// Store project root path (set by framework.start)
let projectRoot = null;

// Override console.error to print messages in red for easier spotting in terminal
// Uses ANSI escape codes; falls back to original if formatting fails.
try {
    const _origConsoleError = console.error.bind(console);
    console.error = function (...args) {
        try {
            const red = '\x1b[31m';
            const reset = '\x1b[0m';
            _origConsoleError(red + util.format(...args) + reset);
        } catch (e) {
            _origConsoleError(...args);
        }
    };
} catch (e) {
    // ignore if we can't patch console
}

// Generate models from array of definitions
function generateModelsFromDefs(modelDefs) {
    const models = {};
    for (const def of modelDefs) {
        try {
            models[def.name] = sequelize.define(
                def.name,
                Object.fromEntries(
                    Object.entries(def.fields).map(([k, v]) => [k, { ...v, type: DataTypes[v.type] }])
                ),
                { ...def.options, tableName: def.tableName }
            );
        } catch (e) {
            console.error(`Error defining model ${def.name}:`, e.message);
            throw e;
        }
    }
    return models;
}

// Collect all db.js (drive_root, appDir, ...)
function collectAllModelDefs() {
    const defs = [];
    const associations = [];

    // 1. drive_root/db/db.json
    const rootDbPath = path.join(__dirname, 'db', 'db.json');
    if (fs.existsSync(rootDbPath)) {
        const rootExport = require(rootDbPath);
        const rootModels = rootExport.models || rootExport;
        const rootAssoc = rootExport.associations || [];
        defs.push(...(Array.isArray(rootModels) ? rootModels : []));
        associations.push(...rootAssoc);
    }
    // 2. appDir/db/db.js (e.g. drive_forms)
    const config = require(path.join(__dirname, '..', 'server.config.json'));
    const appDir = path.join(__dirname, '..', config.appDir);
    const appDbPath = path.join(appDir, 'db', 'db.json');
    if (fs.existsSync(appDbPath)) {
        const appExport = require(appDbPath);
        const appModels = appExport.models || appExport;
        const appAssoc = appExport.associations || [];
        defs.push(...(Array.isArray(appModels) ? appModels : []));
        associations.push(...appAssoc);
    }
    // 3. App models from apps.json
    try {
        const localAppsJsonPath = path.join(appDir, 'apps.json');
        const rootAppsJsonPath = path.join(__dirname, '..', 'apps.json');

        let allApps = [];
        let appsBasePath = "apps"; // Default if not specified

        const loadAppsFromPath = (p) => {
            if (fs.existsSync(p)) {
                try {
                    const appsConfig = JSON.parse(fs.readFileSync(p, 'utf8'));
                    if (typeof appsConfig.path === 'string' && appsConfig.path.length > 0) {
                        appsBasePath = appsConfig.path;
                    }
                    if (Array.isArray(appsConfig.apps)) {
                        appsConfig.apps.forEach(app => {
                            if (app.name && !allApps.find(a => a.name === app.name)) {
                                allApps.push(app);
                            }
                        });
                    }
                } catch (e) {
                    console.error(`[globalModels] Error reading apps.json at ${p}:`, e.message);
                }
            }
        };

        loadAppsFromPath(localAppsJsonPath);
        loadAppsFromPath(rootAppsJsonPath);

        const appsPathCfg = appsBasePath.replace(/^[/\\]+/, '');
        const appsBaseDir = path.join(__dirname, '..', appsPathCfg);

        for (const app of allApps) {
            const appDirPath = path.join(appsBaseDir, app.name);
            const appDbDefPath = path.join(appDirPath, 'db', 'db.json');
            if (fs.existsSync(appDbDefPath)) {
                try {
                    const appExport = require(appDbDefPath);
                    const appModels = appExport.models || appExport;
                    const appAssoc = appExport.associations || [];
                    defs.push(...(Array.isArray(appModels) ? appModels : []));
                    associations.push(...appAssoc);
                } catch (e) {
                    console.error(`[globalModels] Error loading models for app ${app.name}:`, e.message);
                }
            }
        }
    } catch (e) {
        console.error('[globalModels] Unexpected error processing apps.json:', e.message);
    }
    return { models: defs, associations };
}

// Global variable with models
let modelsDB = {};

function initModelsDB() {
    const { models: allDefs, associations: allAssoc } = collectAllModelDefs();
    modelsDB = generateModelsFromDefs(allDefs);

    // Apply associations after creating all models
    for (const assoc of allAssoc) {
        const sourceModel = modelsDB[assoc.source];
        const targetModel = modelsDB[assoc.target];

        if (!sourceModel) {
            console.warn(`[globalModels] Model ${assoc.source} not found for association`);
            continue;
        }
        if (!targetModel) {
            console.warn(`[globalModels] Model ${assoc.target} not found for association`);
            continue;
        }

        try {
            sourceModel[assoc.type](targetModel, assoc.options);
        } catch (e) {
            console.error(`[globalModels] Error creating association ${assoc.source}.${assoc.type}(${assoc.target}):`, e.message);
        }
    }
}

// Initialization on startup
initModelsDB();


function getServerTime() {
    return new Date().toISOString();
}

function helloFromGlobal(name) {
    return `Hello, ${name}! (from globalServerContext)`;
}

// Universal function to determine Content-Type for files
function getContentType(fileName) {
    const ext = require('path').extname(fileName).toLowerCase();
    switch (ext) {
        case '.html':
            return 'text/html; charset=utf-8';
        case '.js':
            return 'application/javascript; charset=utf-8';
        case '.css':
            return 'text/css; charset=utf-8';
        case '.json':
            return 'application/json; charset=utf-8';
        case '.png':
            return 'image/png';
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.svg':
            return 'image/svg+xml';
        case '.wasm':
            return 'application/wasm';
        default:
            return 'application/octet-stream';
    }
}

// Get user by sessionID (async)
const dbConfig = require('./db/db.json');
const modelsDef = dbConfig.models;
const sessionDef = modelsDef.find(m => m.name === 'Sessions');
const userDef = modelsDef.find(m => m.name === 'Users');
const Session = sequelize.define(sessionDef.name, Object.fromEntries(
    Object.entries(sessionDef.fields).map(([k, v]) => [k, { ...v, type: DataTypes[v.type] }])
), { ...sessionDef.options, tableName: sessionDef.tableName });
const User = sequelize.define(userDef.name, Object.fromEntries(
    Object.entries(userDef.fields).map(([k, v]) => [k, { ...v, type: DataTypes[v.type] }])
), { ...userDef.options, tableName: userDef.tableName });
async function getUserBySessionID(sessionID) {
    if (!sessionID) {
        console.log('[getUserBySessionID] No sessionID provided');
        return null;
    }
    const session = await Session.findOne({ where: { sessionId: sessionID } });
    if (!session) {
        console.log(`[getUserBySessionID] Session not found for ID: ${sessionID}`);
        return null;
    }
    if (!session.userId) {
        console.log(`[getUserBySessionID] Session found but no userId. SessionID: ${sessionID}`);
        return null;
    }
    const user = await User.findOne({ where: { id: session.userId } });
    if (!user) {
        console.log(`[getUserBySessionID] User not found for userId: ${session.userId}`);
        return null; // return null if user not found
    }
    console.log(`[getUserBySessionID] Found user: ${user.name} (${user.id})`);
    return user.get({ plain: true });
}

// Process default values
// Adds _level to each record and checks id uniqueness within the level
function processDefaultValues(data, level) {
    const result = {};
    const allIds = new Set();

    for (const [entity, records] of Object.entries(data)) {
        if (!Array.isArray(records)) {
            result[entity] = records;
            continue;
        }

        // Check id uniqueness within the level (all tables)
        for (const record of records) {
            if (record.id !== undefined) {
                if (allIds.has(record.id)) {
                    console.log(`[defaultValues] INFO: Duplicate id=${record.id} in table "${entity}" (id must be unique within level "${level}") - skipping duplication check`);
                }
                allIds.add(record.id);
            } else {
                console.warn(`[defaultValues] WARNING: Record in "${entity}" has no id field`);
            }
        }

        result[entity] = records.map(record => ({
            ...record,
            _level: level
        }));
    }
    return result;
}

// Default values storage: { level: { tableName: { defaultValueId: recordInstance } } }
let defaultValuesCache = {};

/**
 * Loads all default values from the default_values table
 * and caches Sequelize instances of records for quick access
 * Returns structure: { level: { tableName: { defaultValueId: recordInstance } } }
 */
async function loadDefaultValuesFromDB() {
    const DefaultValuesModel = modelsDB.DefaultValues;
    if (!DefaultValuesModel) {
        console.error('[defaultValues] Model DefaultValues not found in modelsDB');
        return {};
    }

    const cache = {};

    try {
        // Load all records from default_values
        const allDefaults = await DefaultValuesModel.findAll();

        // Group by level and table
        for (const defValue of allDefaults) {
            const { level, tableName, defaultValueId, recordId } = defValue;

            // Find model for the table
            const modelDef = Object.values(modelsDB).find(m => m.tableName === tableName);
            if (!modelDef) {
                console.warn(`[defaultValues] Model for table ${tableName} not found`);
                continue;
            }

            // Load record from DB
            const record = await modelDef.findByPk(recordId);
            if (!record) {
                console.warn(`[defaultValues] Record ${tableName}[${recordId}] not found (level=${level}, defaultValueId=${defaultValueId})`);
                continue;
            }

            // Cache
            if (!cache[level]) cache[level] = {};
            if (!cache[level][tableName]) cache[level][tableName] = {};
            cache[level][tableName][defaultValueId] = record;
        }

        console.log(`[defaultValues] Loaded ${allDefaults.length} default records from DB`);
    } catch (error) {
        console.error('[defaultValues] Error loading from DB:', error.message);
    }

    defaultValuesCache = cache;
    return cache;
}

/**
 * Get Sequelize instance of a default record
 * @param {string} level - Level (e.g., 'messenger', 'root', 'forms')
 * @param {string} tableName - Table name
 * @param {number} defaultValueId - ID of the default value
 * @returns {Object|null} - Sequelize instance of the record or null
 */
function getDefaultValue(level, tableName, defaultValueId) {
    if (!defaultValuesCache[level]) return null;
    if (!defaultValuesCache[level][tableName]) return null;
    return defaultValuesCache[level][tableName][defaultValueId] || null;
}

/**
 * Get all default records for a table by level
 * @param {string} level - Level
 * @param {string} tableName - Table name
 * @returns {Array} - Array of Sequelize instances
 */
function getDefaultValues(level, tableName) {
    if (!defaultValuesCache[level]) return [];
    if (!defaultValuesCache[level][tableName]) return [];
    return Object.values(defaultValuesCache[level][tableName]);
}

/**
 * Reload default values cache from DB
 * Useful after migrations or changes in default_values
 */
async function reloadDefaultValues() {
    return await loadDefaultValuesFromDB();
}

module.exports = {
    getServerTime,
    helloFromGlobal,
    getUserBySessionID,
    modelsDB,
    initModelsDB,
    getContentType,
    processDefaultValues,
    loadDefaultValuesFromDB,
    getDefaultValue,
    getDefaultValues,
    reloadDefaultValues,
};

// --- User management moved to drive_root level ---
async function createNewUser(sessionID, name, systems, roles, isGuest = false, guestEmail = null) {
    const sequelizeInstance = modelsDB.Users.sequelize;
    const user = await sequelizeInstance.transaction(async (t) => {
        const user = await modelsDB.Users.create({
            isGuest,
            name,
            email: guestEmail || `${name.replace(/\s+/g, '_').toLowerCase()}@user.local`,
            password_hash: '',
        }, { transaction: t });

        const roleRecords = [];
        for (const roleName of Array.isArray(roles) ? roles : [roles]) {
            let roleRec = await modelsDB.AccessRoles.findOne({ where: { name: roleName }, transaction: t });
            if (!roleRec) {
                roleRec = await modelsDB.AccessRoles.create({ name: roleName }, { transaction: t });
            }
            roleRecords.push(roleRec);
        }

        const systemRecords = [];
        for (const systemName of Array.isArray(systems) ? systems : [systems]) {
            let systemRec = await modelsDB.Systems.findOne({ where: { name: systemName }, transaction: t });
            if (!systemRec) {
                systemRec = await modelsDB.Systems.create({ name: systemName }, { transaction: t });
            }
            systemRecords.push(systemRec);
        }

        for (const roleRec of roleRecords) {
            for (const systemRec of systemRecords) {
                await modelsDB.UserSystems.create({ userId: user.id, roleId: roleRec.id, systemId: systemRec.id }, { transaction: t });
            }
        }

        if (sessionID) {
            let session = await modelsDB.Sessions.findOne({ where: { sessionId: sessionID }, transaction: t });
            if (!session) {
                await modelsDB.Sessions.create({ sessionId: sessionID, userId: user.id }, { transaction: t });
            } else {
                await session.update({ userId: user.id }, { transaction: t });
            }
        }

        return user;
    });

    // Emit event AFTER transaction completes, when user is already in DB
    await eventBus.emit('userCreated', user, { systems, roles, sessionID });
    return user;
}

async function createGuestUser(sessionID, systems, roles) {
    const sequelizeInstance = modelsDB.Users.sequelize;

    // Find last guest in transaction with FOR UPDATE
    const [result] = await sequelizeInstance.query(
        `SELECT name FROM users WHERE "isGuest"=true AND name LIKE 'Guest\\_%' ORDER BY id DESC LIMIT 1 FOR UPDATE`
    );

    let nextNum = 1;
    if (result.length > 0) {
        const lastName = result[0].name;
        const match = lastName && lastName.match(/^Guest_(\d+)$/);
        if (match) nextNum = parseInt(match[1], 10) + 1;
    }

    const name = `Guest_${nextNum}`;
    const guestEmail = `guest_${nextNum}@guest.local`;

    // Call createNewUser with isGuest=true flag
    return await createNewUser(sessionID, name, systems, roles, true, guestEmail);
}

// Export new functions to global context
module.exports.createNewUser = createNewUser;
module.exports.createGuestUser = createGuestUser;

// Project root path management
module.exports.setProjectRoot = function (rootPath) {
    projectRoot = rootPath;
    console.log(`[globalContext] Project root set to: ${rootPath}`);
};

module.exports.getProjectRoot = function () {
    return projectRoot;
};
