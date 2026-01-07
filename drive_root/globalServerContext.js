const fs = require('fs');
const path = require('path');
const { Sequelize, DataTypes, Op } = require('sequelize');
const sequelize = require('./db/sequelize_instance');
const eventBus = require('./eventBus');
const util = require('util');

// Store project root path (set by framework.start)
let projectRoot = null;

// Cache for model definitions (avoid re-reading files on each request)
// Store in global to survive require.cache deletion during hot-reload
if (!global._cachedModelDefs) {
    global._cachedModelDefs = null;
}

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
    
    // First pass: merge definitions with same name
    const mergedDefs = new Map();
    for (const def of modelDefs) {
        if (!mergedDefs.has(def.name)) {
            // First definition - just add it
            mergedDefs.set(def.name, {
                name: def.name,
                tableName: def.tableName,
                fields: { ...def.fields },
                options: { ...def.options }
            });
        } else {
            // Merge with existing definition
            const existing = mergedDefs.get(def.name);
            // Merge fields
            Object.assign(existing.fields, def.fields);
            // Merge options
            if (def.options) {
                Object.assign(existing.options, def.options);
            }
            console.log(`[globalModels] Merged model ${def.name}: added ${Object.keys(def.fields).length} fields`);
        }
    }
    
    // Second pass: create Sequelize models
    for (const def of mergedDefs.values()) {
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
        
        // Also check PROJECT_ROOT for apps.json
        const projectAppsJsonPath = projectRoot ? path.join(projectRoot, 'apps.json') : null;

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
                    console.log(`[globalModels] Loaded apps.json from ${p}: ${appsConfig.apps ? appsConfig.apps.length : 0} apps`);
                } catch (e) {
                    console.error(`[globalModels] Error reading apps.json at ${p}:`, e.message);
                }
            }
        };

        // Load from PROJECT_ROOT first (highest priority)
        if (projectAppsJsonPath) {
            loadAppsFromPath(projectAppsJsonPath);
        }
        loadAppsFromPath(localAppsJsonPath);
        loadAppsFromPath(rootAppsJsonPath);

        const appsPathCfg = appsBasePath.replace(/^[/\\]+/, '');
        
        // Try PROJECT_ROOT first for apps, then framework location
        const possibleAppsDirs = [];
        if (projectRoot) {
            possibleAppsDirs.push(path.join(projectRoot, appsPathCfg));
        }
        possibleAppsDirs.push(path.join(__dirname, '..', appsPathCfg));

        for (const app of allApps) {
            let appDbDefPath = null;
            
            // Find the first existing path
            for (const baseDir of possibleAppsDirs) {
                const testPath = path.join(baseDir, app.name, 'db', 'db.json');
                if (fs.existsSync(testPath)) {
                    appDbDefPath = testPath;
                    break;
                }
            }
            
            if (appDbDefPath) {
                try {
                    const appExport = require(appDbDefPath);
                    const appModels = appExport.models || appExport;
                    const appAssoc = appExport.associations || [];
                    defs.push(...(Array.isArray(appModels) ? appModels : []));
                    associations.push(...appAssoc);
                    console.log(`[globalModels] Loaded models from ${app.name}: ${appModels.length} models`);
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
    console.log('[globalModels] initModelsDB called, projectRoot:', projectRoot);
    const { models: allDefs, associations: allAssoc } = collectAllModelDefs();
    console.log(`[globalModels] Collected ${allDefs.length} model definitions`);
    modelsDB = generateModelsFromDefs(allDefs);
    console.log(`[globalModels] Generated models:`, Object.keys(modelsDB));
    
    // Clear cached model definitions
    global._cachedModelDefs = null;

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
            const options = {};
            if (assoc.foreignKey) {
                options.foreignKey = { name: assoc.foreignKey, field: assoc.foreignKey };
            }
            if (assoc.options) {
                Object.assign(options, assoc.options);
            }
            sourceModel[assoc.type](targetModel, options);
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
    collectAllModelDefs,  // Export for createDB.js
};

// --- User management moved to drive_root level ---
async function createNewUser(sessionID, name, systems, roles, isGuest = false, guestEmail = null) {
    console.log('[createNewUser] === START ===');
    console.log('[createNewUser] sessionID:', sessionID);
    console.log('[createNewUser] name:', name, 'type:', typeof name);
    console.log('[createNewUser] systems:', systems);
    console.log('[createNewUser] roles:', roles);
    console.log('[createNewUser] isGuest:', isGuest);
    console.log('[createNewUser] guestEmail:', guestEmail);
    
    if (!name) {
        console.error('[createNewUser] ERROR: name is empty!');
        throw new Error('User name is required');
    }
    
    const sequelizeInstance = modelsDB.Users.sequelize;
    const user = await sequelizeInstance.transaction(async (t) => {
        const userData = {
            isGuest,
            name,
            email: guestEmail || `${name.replace(/\s+/g, '_').toLowerCase()}@user.local`,
            password_hash: '',
        };
        
        console.log('[createNewUser] Creating user with data:', userData);
        
        const user = await modelsDB.Users.create(userData, { transaction: t });

        console.log('[createNewUser] User created with ID:', user.id);

        const roleRecords = [];
        for (const roleName of Array.isArray(roles) ? roles : [roles]) {
            let roleRec = await modelsDB.AccessRoles.findOne({ where: { name: roleName }, transaction: t });
            if (!roleRec) {
                roleRec = await modelsDB.AccessRoles.create({ name: roleName }, { transaction: t });
            }
            roleRecords.push(roleRec);
        }

        // If systems is empty or not provided, use a default system
        const systemsToUse = (Array.isArray(systems) && systems.length > 0) ? systems : ['mySpace'];
        
        const systemRecords = [];
        for (const systemName of systemsToUse) {
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

    console.log('[createNewUser] Transaction completed, user:', user.name);
    
    // Emit event AFTER transaction completes, when user is already in DB
    await eventBus.emit('userCreated', user, { systems, roles, sessionID });
    return user;
}

async function createGuestUser(sessionID, systems, roles) {
    console.log('[createGuestUser] Starting with sessionID:', sessionID, 'systems:', systems, 'roles:', roles);
    
    // Find last guest user using Sequelize
    const lastGuest = await modelsDB.Users.findOne({
        where: {
            isGuest: true,
            name: {
                [Op.like]: 'Guest_%'
            }
        },
        order: [['id', 'DESC']],
        raw: true
    });

    let nextNum = 1;
    if (lastGuest && lastGuest.name) {
        console.log('[createGuestUser] Last guest found:', lastGuest.name);
        const match = lastGuest.name.match(/^Guest_(\d+)$/);
        if (match) {
            nextNum = parseInt(match[1], 10) + 1;
        }
    }

    const name = `Guest_${nextNum}`;
    const guestEmail = `guest_${nextNum}@guest.local`;

    console.log('[createGuestUser] Creating guest with name:', name, 'email:', guestEmail);
    
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
    
    // Re-initialize models DB to load project apps
    console.log('[globalContext] Re-initializing models with project root...');
    initModelsDB();
};

module.exports.getProjectRoot = function () {
    return projectRoot;
};

// --- Dynamic Table Support Functions ---

/**
 * Get table metadata including captions from db.json definitions
 * @param {string} modelName - Name of the Sequelize model
 * @returns {Promise<Array>} - Array of field metadata
 */
async function getTableMetadata(modelName) {
    const Model = modelsDB[modelName];
    if (!Model) {
        throw new Error(`Model ${modelName} not found in modelsDB`);
    }

    // Use cached model definitions
    if (!global._cachedModelDefs) {
        const { models: allDefs } = collectAllModelDefs();
        global._cachedModelDefs = allDefs;
    }
    const modelDef = global._cachedModelDefs.find(def => def.name === modelName);

    const fields = [];
    const attributes = Model.rawAttributes;

    for (const [fieldName, attr] of Object.entries(attributes)) {
        // Skip Sequelize internal fields
        if (['createdAt', 'updatedAt', 'deletedAt'].includes(fieldName)) continue;

        // Get caption from db.json or use field name
        let caption = fieldName;
        if (modelDef && modelDef.fields && modelDef.fields[fieldName] && modelDef.fields[fieldName].caption) {
            caption = modelDef.fields[fieldName].caption;
        }

        // Determine type
        const typeKey = attr.type.key || attr.type.constructor.key;

        // Calculate column width based on type and caption
        let width = 100;
        if (typeKey === 'INTEGER' && fieldName === 'id') width = 80;
        else if (typeKey === 'INTEGER') width = 100;
        else if (typeKey === 'STRING') width = Math.max(150, Math.min(300, caption.length * 10 + 100));
        else if (typeKey === 'BOOLEAN') width = 80;
        else if (typeKey === 'DATE' || typeKey === 'DATEONLY') width = 120;

        // Check for foreign key
        let foreignKey = null;
        if (attr.references) {
            // Find the target model
            const targetModel = Object.values(modelsDB).find(m => m.tableName === attr.references.model);
            if (targetModel) {
                // Determine display field (prefer 'name', fallback to first string field)
                let displayField = 'name';
                const targetAttrs = targetModel.rawAttributes;
                if (!targetAttrs['name']) {
                    displayField = Object.keys(targetAttrs).find(k => {
                        const t = targetAttrs[k].type.key || targetAttrs[k].type.constructor.key;
                        return t === 'STRING';
                    }) || 'id';
                }

                foreignKey = {
                    table: attr.references.model,
                    field: attr.references.key || 'id',
                    displayField: displayField
                };
            }
        }

        fields.push({
            name: fieldName,
            caption: caption,
            type: typeKey,
            width: width,
            foreignKey: foreignKey,
            editable: false  // All fields readonly for now
        });
    }

    return fields;
}

/**
 * Get table data with server-side paging, sorting, filtering
 * @param {Object} options - { modelName, firstRow, visibleRows, sort[], filters[] }
 * @returns {Promise<Object>} - { totalRows, fields, data, range }
 */
async function getDynamicTableData(options) {
    const startTime = Date.now();
    
    // Load server-side config for security limits
    const serverConfig = require(path.join(__dirname, '..', 'server.config.json'));
    const config = serverConfig.dynamicTable || { 
        maxRowsPerRequest: 50, 
        maxBufferRows: 30, 
        maxVisibleRows: 100,
        defaultBufferRows: 10
    };
    
    let { modelName, firstRow, visibleRows, sort, filters } = options;
    
    // Apply server-side limits to prevent abuse
    visibleRows = Math.min(visibleRows || 20, config.maxVisibleRows);

    const Model = modelsDB[modelName];
    if (!Model) {
        throw new Error(`Model ${modelName} not found in modelsDB`);
    }

    // Get field metadata
    const t1 = Date.now();
    const fields = await getTableMetadata(modelName);
    console.log(`[PERF] getTableMetadata: ${Date.now() - t1}ms`);

    // Build WHERE clause from filters
    const where = {};
    if (filters && Array.isArray(filters)) {
        for (const filter of filters) {
            const { field, operator, value } = filter;

            if (operator === '=') where[field] = value;
            else if (operator === '!=') where[field] = { [require('sequelize').Op.ne]: value };
            else if (operator === '>') where[field] = { [require('sequelize').Op.gt]: value };
            else if (operator === '<') where[field] = { [require('sequelize').Op.lt]: value };
            else if (operator === '>=') where[field] = { [require('sequelize').Op.gte]: value };
            else if (operator === '<=') where[field] = { [require('sequelize').Op.lte]: value };
            else if (operator === 'contains') where[field] = { [require('sequelize').Op.like]: `%${value}%` };
            else if (operator === 'startsWith') where[field] = { [require('sequelize').Op.like]: `${value}%` };
            else if (operator === 'endsWith') where[field] = { [require('sequelize').Op.like]: `%${value}` };
        }
    }

    // Build ORDER BY clause from sort
    const order = [];
    if (sort && Array.isArray(sort)) {
        for (const sortItem of sort) {
            const { field, order: sortOrder } = sortItem;
            order.push([field, sortOrder.toUpperCase()]);
        }
    }

    // Count total rows
    const t2 = Date.now();
    const totalRows = await Model.count({ where });
    console.log(`[PERF] Model.count: ${Date.now() - t2}ms`);

    // Calculate range with buffer (limited by server config)
    const bufferSize = Math.min(config.defaultBufferRows || 10, config.maxBufferRows);
    const requestFirstRow = Math.max(0, firstRow - bufferSize);
    const requestLastRow = Math.min(totalRows - 1, firstRow + visibleRows + bufferSize);
    let requestCount = requestLastRow - requestFirstRow + 1;
    
    // Final safety limit
    requestCount = Math.min(requestCount, config.maxRowsPerRequest);

    // Fetch data
    const t3 = Date.now();
    const data = await Model.findAll({
        where,
        order: order.length > 0 ? order : [['id', 'ASC']],
        offset: requestFirstRow,
        limit: requestCount,
        raw: true
    });
    console.log(`[PERF] Model.findAll: ${Date.now() - t3}ms`);

    // Resolve foreign keys
    const t4 = Date.now();
    const resolvedData = await resolveTableForeignKeys(modelName, data, fields);
    console.log(`[PERF] resolveTableForeignKeys: ${Date.now() - t4}ms`);
    
    console.log(`[PERF] TOTAL getDynamicTableData: ${Date.now() - startTime}ms`);

    return {
        totalRows,
        fields,
        data: resolvedData,
        range: {
            from: requestFirstRow,
            to: requestFirstRow + resolvedData.length - 1
        }
    };
}

/**
 * Resolve foreign key display values
 * @param {string} modelName - Source model name
 * @param {Array} dataArray - Array of data rows
 * @param {Array} fields - Field metadata from getTableMetadata
 * @returns {Promise<Array>} - Data with __<field>_display properties added
 */
async function resolveTableForeignKeys(modelName, dataArray, fields) {
    const fkFields = fields.filter(f => f.foreignKey !== null);

    if (fkFields.length === 0) {
        return dataArray;
    }

    const result = [];
    for (const row of dataArray) {
        const resolvedRow = { ...row };

        for (const fkField of fkFields) {
            const fkValue = row[fkField.name];

            if (fkValue === null || fkValue === undefined) {
                resolvedRow[`__${fkField.name}_display`] = '';
                continue;
            }

            // Find target model
            const targetModel = Object.values(modelsDB).find(m => m.tableName === fkField.foreignKey.table);
            if (!targetModel) {
                resolvedRow[`__${fkField.name}_display`] = `(unknown: ${fkValue})`;
                continue;
            }

            // Fetch display value
            try {
                const targetRow = await targetModel.findByPk(fkValue, { raw: true });
                if (targetRow) {
                    resolvedRow[`__${fkField.name}_display`] = targetRow[fkField.foreignKey.displayField] || targetRow.id.toString();
                } else {
                    resolvedRow[`__${fkField.name}_display`] = `(not found: ${fkValue})`;
                }
            } catch (e) {
                console.error(`[resolveTableForeignKeys] Error resolving FK ${fkField.name}:`, e.message);
                resolvedRow[`__${fkField.name}_display`] = `(error: ${fkValue})`;
            }
        }

        result.push(resolvedRow);
    }

    return result;
}

/**
 * Save client state (stub for future implementation)
 * @param {Object} user - User object
 * @param {Object} stateData - State data to save
 */
async function saveClientState(user, stateData) {
    console.log('[saveClientState] Saving state for user:', user ? user.name : 'unknown');
    console.log('[saveClientState] State data:', JSON.stringify(stateData, null, 2));
    // TODO: Implement saving to database
    // Table structure: user_states (userId, window, component, data JSON)
}

// Export Dynamic Table functions
module.exports.getTableMetadata = getTableMetadata;
module.exports.getDynamicTableData = getDynamicTableData;
module.exports.resolveTableForeignKeys = resolveTableForeignKeys;
module.exports.saveClientState = saveClientState;
