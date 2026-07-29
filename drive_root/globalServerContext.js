const fs = require('fs');
const path = require('path');
const { Sequelize, DataTypes, Op } = require('sequelize');
const sequelize = require('./db/sequelize_instance');
const eventBus = require('./eventBus');
const util = require('util');
const crypto = require('crypto');

// Reserved session ID for internal system calls that bypass access control.
// Search for this constant to audit all access control bypasses.
const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';

// Store project root path (set by framework.start)
let projectRoot = null;

// Store for edit sessions: Map<editSessionId, { userId, tableName, changes }>
// changes is Map<rowId, Map<fieldName, newValue>>
// 1.2: раньше new Map() без очистки — getDynamicTableData создаёт edit-сессию на
// КАЖДЫЙ запрос данных (в т.ч. на каждый шаг скролла), удаление только при commit →
// утечка. BoundedTTLMap (TTL 60 мин, max 5000) ограничивает рост; протухшие
// несохранённые edit-сессии подчищает общий sweeper memory_store. API set/get/delete
// совместим с Map — остальной код не меняется.
const { BoundedTTLMap } = require('./memory_store');
const editSessions = new BoundedTTLMap({ ttl: 60 * 60 * 1000, max: 5000 });

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
                options: { ...def.options },
                entityConfig: def.entityConfig || null
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
    
    // Inject UID systematically into all models for the runtime (if missing)
    for (const def of mergedDefs.values()) {
        if (!def.fields) def.fields = {};
        
        // Remove old primary keys
        for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
            if (fieldName !== 'UID' && fieldDef.primaryKey) {
                delete fieldDef.primaryKey;
            }
        }
        
        // Inject UID as the sole primary key
        if (!def.fields.UID) {
            def.fields.UID = {
                type: "STRING",
                allowNull: false,
                primaryKey: true,
                defaultValue: "GENERATE_UID"
            };
        } else {
            def.fields.UID.primaryKey = true;
            def.fields.UID.allowNull = false;
            def.fields.UID.type = "STRING";
            if (!def.fields.UID.defaultValue) {
                def.fields.UID.defaultValue = "GENERATE_UID";
            }
        }
    }

    // Second pass: create Sequelize models
    for (const def of mergedDefs.values()) {
        try {
            const fields = Object.fromEntries(
                Object.entries(def.fields).map(([k, v]) => {
                    const fieldDef = { ...v, type: DataTypes[v.type] };
                    if (fieldDef.defaultValue === 'GENERATE_UID') {
                        fieldDef.defaultValue = () => require('./db/utilites').generateUID(def.name);
                    }
                    return [k, fieldDef];
                })
            );

            models[def.name] = sequelize.define(
                def.name,
                fields,
                { ...def.options, tableName: def.tableName }
            );
            // Attach entityConfig for use by entityHooks middleware
            models[def.name].entityConfig = def.entityConfig || null;
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

    // Системно: реквизит `number` + автонумерация для сущностей (документы/справочники)
    // и реквизит `date` для документов.
    // Здесь — единый источник определений: используется и для построения моделей
    // (generateModelsFromDefs), и для метаданных/подписей (getTableMetadata → _cachedModelDefs).
    // require-кэш отдаёт одни и те же объекты, поэтому мутация попадает во все потребители.
    try {
        const { injectEntityNumber } = require('./db/entityNumber');
        const { injectEntityDate } = require('./db/entityDate');
        // `name` (представление) — тоже системное поле модели. Без него
        // перестройка таблицы при миграции теряет представления всех
        // записей: колонку раньше навешивали отдельно, уже после переноса
        // данных. Подробности — drive_root/db/entityName.js.
        const { injectEntityName } = require('./db/entityName');
        for (const def of defs) { injectEntityNumber(def); injectEntityDate(def); injectEntityName(def); }

        // Умолчания пустых значений (число 0, строка "", булево false, дата
        // 0001-01-01; NULL только у ссылок) нужны и в РАНТАЙМЕ, а не только
        // при миграции: иначе запись, созданная напрямую через модель (напр.
        // сессия при входе), уходит в базу с NULL в обход правила.
        const { injectEmptyDefaults } = require('./db/emptyValues');
        injectEmptyDefaults(defs, { enforceNotNull: false });
    } catch (e) {
        console.error('[globalModels] entity number/date/name injection failed:', e && e.message || e);
    }

    return { models: defs, associations };
}

// Global variable with models
let modelsDB = {};
let _tableNameLookup = null; // 5.3: кэш tableName/modelName(lower) → modelName

function initModelsDB() {
    console.log('[globalModels] initModelsDB called, projectRoot:', projectRoot);
    const { models: allDefs, associations: allAssoc } = collectAllModelDefs();
    console.log(`[globalModels] Collected ${allDefs.length} model definitions`);
    modelsDB = generateModelsFromDefs(allDefs);
    _tableNameLookup = null; // 5.3: инвалидация кэша tableName→modelName при переинициализации
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

// Register translation middleware (deferred to avoid circular require at module load)
process.nextTick(function() {
    try { require('./translationMiddleware').install(); } catch (e) {
        console.error('[globalServerContext] Failed to install translation middleware:', e.message);
    }
});

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
const _memoryStore = require('./memory_store');
const _SESSION_USER_NS = 'session_users';

async function getUserBySessionID(sessionID) {
    if (!sessionID) {
        console.log('[getUserBySessionID] No sessionID provided');
        return null;
    }
    // L1: same-process Map (synchronous)
    const cachedL1 = _memoryStore.getSync(_SESSION_USER_NS, sessionID);
    if (cachedL1 !== null && cachedL1 !== undefined) return cachedL1;
    // L2: shared memory_store service (cross-process)
    const cachedL2 = await _memoryStore.get(_SESSION_USER_NS, sessionID);
    if (cachedL2 !== null && cachedL2 !== undefined) return cachedL2;

    // L3: DB
    const session = await Session.findOne({ where: { sessionId: sessionID } });
    if (!session) {
        console.log(`[getUserBySessionID] Session not found for ID: ${sessionID}`);
        return null;
    }
    if (!session.userId) {
        console.log(`[getUserBySessionID] Session found but no userId. SessionID: ${sessionID}`);
        return null;
    }
    const user = await User.findOne({ where: { UID: session.userId } });
    if (!user) {
        console.log(`[getUserBySessionID] User not found for userId: ${session.userId}`);
        return null;
    }
    console.log(`[getUserBySessionID] Found user: ${user.name} (${user.UID})`);
    const plain = user.get({ plain: true });
    await _memoryStore.set(_SESSION_USER_NS, sessionID, plain);
    return plain;
}

// Сбрасывает кэш пользователя для сессии (L1 + L2). Звать после изменения полей
// пользователя, влияющих на доступ (роль, mustChangePassword), иначе getUserBySessionID
// продолжит отдавать устаревшую копию (напр. mustChangePassword:true после смены пароля).
async function invalidateSessionUser(sessionID) {
    if (!sessionID) return;
    try { await _memoryStore.del(_SESSION_USER_NS, sessionID); } catch (e) {}
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
            const recordId = record.UID;
            if (recordId !== undefined) {
                if (allIds.has(recordId)) {
                    console.log(`[defaultValues] INFO: Duplicate recordId=${recordId} in table "${entity}" (UID must be unique within level "${level}") - skipping duplication check`);
                }
                allIds.add(recordId);
            } else {
                console.warn(`[defaultValues] WARNING: Record in "${entity}" has no UID field`);
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

        // 3.5: группируем default'ы по таблице и читаем ОДНИМ запросом
        // WHERE UID IN (...) на таблицу вместо findOne на каждую запись (N+1
        // на cold-start, что критично на free-хостинге с auto-sleep).
        const byTable = new Map(); // tableName -> { modelDef, ids:Set, entries:[{level,defaultValueId,recordId}] }
        for (const defValue of allDefaults) {
            const { level, tableName, defaultValueId, recordId } = defValue;
            const modelDef = Object.values(modelsDB).find(m => m.tableName === tableName);
            if (!modelDef) {
                console.warn(`[defaultValues] Model for table ${tableName} not found`);
                continue;
            }
            if (!byTable.has(tableName)) byTable.set(tableName, { modelDef, ids: new Set(), entries: [] });
            const g = byTable.get(tableName);
            g.ids.add(recordId);
            g.entries.push({ level, defaultValueId, recordId });
        }

        const { Op } = require('sequelize');
        for (const [tableName, g] of byTable) {
            const records = await g.modelDef.findAll({ where: { UID: { [Op.in]: Array.from(g.ids) } } });
            const byUid = new Map();
            for (const r of records) byUid.set(r.UID, r);

            for (const { level, defaultValueId, recordId } of g.entries) {
                const record = byUid.get(recordId);
                if (!record) {
                    console.warn(`[defaultValues] Record ${tableName}[${recordId}] not found (level=${level}, defaultValueId=${defaultValueId})`);
                    continue;
                }
                if (!cache[level]) cache[level] = {};
                if (!cache[level][tableName]) cache[level][tableName] = {};
                cache[level][tableName][defaultValueId] = record;
            }
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

// Add getter for modelsDB to ensure we always get the current value
Object.defineProperty(module.exports, 'modelsDB', {
    get: function() { return modelsDB; }
});

module.exports.getServerTime = getServerTime;
module.exports.helloFromGlobal = helloFromGlobal;
module.exports.getUserBySessionID = getUserBySessionID;
module.exports.invalidateSessionUser = invalidateSessionUser;
module.exports.initModelsDB = initModelsDB;
module.exports.getContentType = getContentType;
module.exports.processDefaultValues = processDefaultValues;
module.exports.loadDefaultValuesFromDB = loadDefaultValuesFromDB;
module.exports.getDefaultValue = getDefaultValue;
module.exports.getDefaultValues = getDefaultValues;
module.exports.reloadDefaultValues = reloadDefaultValues;
module.exports.collectAllModelDefs = collectAllModelDefs;  // Export for createDB.js

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

        console.log('[createNewUser] User created with UID:', user.UID);

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
                await modelsDB.UserSystems.create({ userId: user.UID, roleId: roleRec.UID, systemId: systemRec.UID }, { transaction: t });
            }
        }

        if (sessionID) {
            let session = await modelsDB.Sessions.findOne({ where: { sessionId: sessionID }, transaction: t });
            if (!session) {
                await modelsDB.Sessions.create({ sessionId: sessionID, userId: user.UID }, { transaction: t });
            } else {
                await session.update({ userId: user.UID }, { transaction: t });
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
        order: [['UID', 'DESC']],
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

/**
 * Find a model name by its table name (or by model name), case-insensitive.
 * Returns the model name (as present in modelsDB) or null if not found.
 *
 * 5.3: раньше — линейный перебор всех моделей с `.toLowerCase()` на КАЖДЫЙ вызов
 * (а это горячий путь — резолв модели на многих DB-операциях). Теперь строится один
 * раз Map `tableNameLower → modelName` (и `modelNameLower → modelName`), инвалидируется
 * в initModelsDB. Точное совпадение по имени модели — сразу, без Map.
 */
function _buildTableNameLookup() {
    const map = new Map();
    for (const m of Object.keys(modelsDB)) {
        try {
            const model = modelsDB[m];
            if (!model) continue;
            map.set(m.toLowerCase(), m);
            const tname = (model.tableName || '').toString().toLowerCase();
            if (tname) map.set(tname, m); // tableName имеет приоритет — ставится после
        } catch (e) { continue; }
    }
    return map;
}

module.exports.getModelNameForTable = function (tableName) {
    if (!tableName) return null;
    // Exact match by model name
    if (modelsDB[tableName]) return tableName;

    if (!_tableNameLookup) _tableNameLookup = _buildTableNameLookup();
    return _tableNameLookup.get(tableName.toLowerCase()) || null;
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

    // Поля, скрытые defaultScope модели (напр. users.password_hash), не читаются обычными
    // запросами — их нельзя показывать ни колонкой списка, ни полем автоформы: значение
    // всегда пустое, а редактировать хэш пароля вручную недопустимо.
    const hiddenByScope = new Set();
    try {
        const scopeExclude = modelDef && modelDef.options && modelDef.options.defaultScope
            && modelDef.options.defaultScope.attributes && modelDef.options.defaultScope.attributes.exclude;
        if (Array.isArray(scopeExclude)) scopeExclude.forEach(f => hiddenByScope.add(f));
    } catch (e) { /* нет defaultScope — скрывать нечего */ }

    for (const [fieldName, attr] of Object.entries(attributes)) {
        // Skip Sequelize internal fields
        if (['createdAt', 'updatedAt', 'deletedAt'].includes(fieldName)) continue;
        if (hiddenByScope.has(fieldName)) continue;

        // Get caption from db.json or use field name
        let caption = fieldName;
        if (modelDef && modelDef.fields && modelDef.fields[fieldName] && modelDef.fields[fieldName].caption) {
            caption = modelDef.fields[fieldName].caption;
        }
        // If caption is an i18n object { i18n: key }, use the key string for width estimation
        const captionStr = (caption && typeof caption === 'object' && caption.i18n)
            ? caption.i18n
            : String(caption || fieldName);

        // Determine type
        const typeKey = attr.type.key || attr.type.constructor.key;

        // Calculate column width based on type and caption
        let width = 100;
        if (typeKey === 'INTEGER' && fieldName === 'UID') width = 80;
        else if (typeKey === 'INTEGER') width = 100;
        else if (typeKey === 'STRING') width = Math.max(150, Math.min(300, captionStr.length * 10 + 100));
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
                    }) || 'UID';
                }

                foreignKey = {
                    table: attr.references.model,
                    field: attr.references.key || 'UID',
                    displayField: displayField
                };
            }
        }

        // Явный inputType из db.json (как isAddress) — позволяет полю задать кастомный
        // контрол (напр. "color" для пикера цвета), не завязываясь на тип Sequelize.
        const explicitInputType = (modelDef && modelDef.fields && modelDef.fields[fieldName] && modelDef.fields[fieldName].inputType) || null;

        // Набор допустимых значений поля (`options: [{ value, caption }]` в db.json) —
        // свойство САМОГО поля, а не одной конкретной формы. Раньше список жил только
        // в ручном лейауте формы записи: форма счёта показывала «Ausgestellt», а любой
        // список той же таблицы (вкладка «Счета» брони, журнал) печатал сырое «issued».
        // Метаданные несут его всем потребителям — колонкам списков и автоформам.
        const explicitOptions = (modelDef && modelDef.fields && modelDef.fields[fieldName]
            && Array.isArray(modelDef.fields[fieldName].options))
            ? JSON.parse(JSON.stringify(modelDef.fields[fieldName].options))
            : null;

        fields.push({
            name: fieldName,
            caption: caption,
            type: typeKey,
            width: width,
            foreignKey: foreignKey,
            isPrimary: !!attr.primaryKey,
            isUID: fieldName === 'UID',
            editable: false,  // All fields readonly for now
            isAddress: !!(modelDef && modelDef.fields && modelDef.fields[fieldName] && modelDef.fields[fieldName].isAddress),
            inputType: explicitInputType,
            options: explicitOptions
        });
    }

    return fields;
}

/**
 * Get table data with server-side paging, sorting, filtering
 * @param {Object} options - { modelName, firstRow, visibleRows, sort[], filters[], fieldConfig, userId }
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
    
    let { modelName, firstRow, visibleRows, sort, filters, fieldConfig, userId, sessionID } = options;
    // Prefer sessionID for access control; fall back to userId for legacy callers
    const dbContext = sessionID ? { sessionID } : { userId };

    // Язык сессии — для перевода display-значений FK-колонок (справочные данные,
    // напр. статусы броней). Резолвится один раз и пробрасывается в resolveTableForeignKeys.
    let _sessionLang = 'en';
    if (sessionID) {
        try {
            const _sc = await require('../drive_forms/globalServerContext').getSessionContext(sessionID);
            _sessionLang = (_sc && _sc.language) || 'en';
        } catch (e) { /* fallback en */ }
    }
    
    // Apply server-side limits to prevent abuse
    visibleRows = Math.min(visibleRows || 20, config.maxVisibleRows);

    const Model = modelsDB[modelName];
    if (!Model) {
        throw new Error(`Model ${modelName} not found in modelsDB`);
    }

    // Get field metadata
    const t1 = Date.now();
    let fields;
    let allFieldsWithMeta = null;
    
    if (fieldConfig) {
        // Use custom config, filter out computed fields for query
        fields = fieldConfig.filter(f => f.source === 'field' || !f.source);
        // Get full metadata from model to get foreign key info
        allFieldsWithMeta = await getTableMetadata(modelName);
        
        // Enrich fieldConfig with foreignKey info from model metadata
        fields = fields.map(configField => {
            const metaField = allFieldsWithMeta.find(mf => mf.name === configField.name);
            return {
                ...configField,
                foreignKey: metaField?.foreignKey || configField.foreignKey || null
            };
        });
    } else {
        // Auto-generate from model
        fields = await getTableMetadata(modelName);
    }
    // Build WHERE clause from filters
    const where = {};
    if (filters && Array.isArray(filters)) {
        for (const filter of filters) {
            const { field, operator, value } = filter;
            const Op = require('sequelize').Op;

            if      (operator === '=')          where[field] = value;
            else if (operator === '!=')         where[field] = { [Op.ne]: value };
            else if (operator === '>')          where[field] = { [Op.gt]: value };
            else if (operator === '<')          where[field] = { [Op.lt]: value };
            else if (operator === '>=')         where[field] = { [Op.gte]: value };
            else if (operator === '<=')         where[field] = { [Op.lte]: value };
            else if (operator === 'contains')   where[field] = { [Op.like]: `%${value}%` };
            else if (operator === 'startsWith') where[field] = { [Op.like]: `${value}%` };
            else if (operator === 'endsWith')   where[field] = { [Op.like]: `%${value}` };
            else if (operator === 'isNull')     where[field] = null;
            else if (operator === 'isNotNull')  where[field] = { [Op.ne]: null };
            else if (operator === 'in')         where[field] = { [Op.in]: Array.isArray(value) ? value : [value] };
            else if (operator === 'inRelated') {
                // «Список связанных записей» через таблицу-связку (аналог подзапроса):
                //   value = { table, select, where } → field IN (SELECT select FROM table WHERE where)
                // Связка читается через dbGateway с ТЕМ ЖЕ контекстом (RLS применяется).
                // Пример (relatedList счетов брони): field='UID', value={ table:'invoice_bookings',
                // select:'invoiceId', where:{ bookingId: <UID брони> } }.
                let ids = [];
                try {
                    const linkRows = await require('./dbGateway').execute({
                        operation: 'read',
                        table: value && value.table,
                        where: (value && value.where) || {},
                        options: { raw: true },
                        context: dbContext
                    });
                    const sel = value && value.select;
                    ids = (Array.isArray(linkRows) ? linkRows : [])
                        .map(r => r && r[sel])
                        .filter(v => v !== null && v !== undefined);
                } catch (e) {
                    console.error('[getDynamicTableData] inRelated subquery failed:', e && e.message || e);
                }
                where[field] = { [Op.in]: ids };
            }
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

    // Count total rows (3.3: кэш на короткий TTL по table+identity+filters,
    // чтобы не гонять COUNT через всю RLS-цепочку на каждый шаг скролла)
    const t2 = Date.now();
    const dbGW = require('./dbGateway');
    const _countKey = _countCacheKey(Model.tableName, (dbContext.sessionID || dbContext.userId), filters);
    let totalRows = _countCacheGet(_countKey);
    if (totalRows === undefined) {
        totalRows = await dbGW.execute({ operation: 'count', table: Model.tableName, where, context: dbContext });
        _countCacheSet(_countKey, totalRows);
    }


    // Calculate range with buffer (limited by server config)
    const bufferSize = Math.min(config.defaultBufferRows || 10, config.maxBufferRows);
    const requestFirstRow = Math.max(0, firstRow - bufferSize);
    const requestLastRow = Math.min(totalRows - 1, firstRow + visibleRows + bufferSize);
    let requestCount = requestLastRow - requestFirstRow + 1;
    
    // Final safety limit
    requestCount = Math.min(requestCount, config.maxRowsPerRequest);

    // Fetch data
    const t3 = Date.now();
    const data = await dbGW.execute({
        operation: 'read',
        table: Model.tableName,
        where,
        options: {
            order: order.length > 0 ? order : [['UID', 'ASC']],
            offset: requestFirstRow,
            limit: requestCount,
            raw: true
        },
        context: dbContext
    });


    // Resolve foreign keys
    const t4 = Date.now();
    const resolvedData = await resolveTableForeignKeys(modelName, data, fields, _sessionLang);

    
    // Add computed fields if fieldConfig is provided
    if (fieldConfig) {
        const computedFields = fieldConfig.filter(f => f.source === 'computed' && f.compute);
        if (computedFields.length > 0) {
            resolvedData.forEach(row => {
                computedFields.forEach(field => {
                    row[field.name] = field.compute(row);
                });
            });
        }
        // Add computed field definitions to fields array
        fields = [...fields, ...computedFields];
    }
    


    // Generate edit session ID for editable tables
    const editSessionId = crypto.randomBytes(16).toString('hex');
    editSessions.set(editSessionId, {
        userId: userId,
        tableName: modelName,
        changes: new Map()
    });

    return {
        totalRows,
        fields: fields,  // Return enriched fields with foreignKey metadata
        data: resolvedData,
        editSessionId: editSessionId,
        range: {
            from: requestFirstRow,
            to: requestFirstRow + resolvedData.length - 1
        }
    };
}

// In-memory LRU cache for FK display values: key = "table::UID" → displayValue
const _fkDisplayCache = new Map();
const _FK_CACHE_MAX = 2000;
const _FK_CACHE_TTL = 60000; // 60 seconds

// 3.3: краткоживущий кэш COUNT(*) для getDynamicTableData. При скролле длинного
// журнала клиент шлёт десятки запросов порций с ОДНИМ и тем же фильтром — COUNT
// каждый раз гонялся через всю RLS-цепочку. Ключ: table::identity::filtersHash.
// TTL короткий (на время серии скролл-запросов); инвалидация — при любой мутации
// таблицы через тот же хук invalidateFkCache (вызывается в dbGateway executor).
const _countCache = new Map(); // key → { val, ts }
const _COUNT_CACHE_TTL = 5000; // 5с
const _COUNT_CACHE_MAX = 1000;

function _countCacheKey(table, identity, filters) {
    return `${table}::${identity || ''}::${JSON.stringify(filters || [])}`;
}
function _countCacheGet(key) {
    const e = _countCache.get(key);
    if (!e) return undefined;
    if (Date.now() - e.ts > _COUNT_CACHE_TTL) { _countCache.delete(key); return undefined; }
    return e.val;
}
function _countCacheSet(key, val) {
    if (_countCache.size >= _COUNT_CACHE_MAX) {
        const first = _countCache.keys().next().value;
        _countCache.delete(first);
    }
    _countCache.set(key, { val, ts: Date.now() });
}
function _countCacheInvalidate(table) {
    if (!table) { _countCache.clear(); return; }
    for (const k of _countCache.keys()) {
        if (k.startsWith(table + '::')) _countCache.delete(k);
    }
}

// Краткоживущий кэш результатов getLookupList (COUNT + первые N строк через RLS).
// Открытие формы запрашивает lookup для КАЖДОЙ FK-таблицы лейаута (clients, hotels,
// rooms, …) — повторные открытия и параллельные формы переиспользуют результат.
// Ключ включает identity (sessionID/userId): RLS-фильтр у разных пользователей разный.
// Инвалидация — тот же хук invalidateFkCache (зовётся в dbGateway на каждую мутацию).
const _lookupCache = new Map(); // key → { val, ts }
const _LOOKUP_CACHE_TTL = 30000; // 30с
const _LOOKUP_CACHE_MAX = 500;

function _lookupCacheGet(key) {
    const e = _lookupCache.get(key);
    if (!e) return undefined;
    if (Date.now() - e.ts > _LOOKUP_CACHE_TTL) { _lookupCache.delete(key); return undefined; }
    // Глубокая копия: закэшированный оригинал нельзя отдавать по ссылке —
    // вызывающие могут мутировать структуру (анти-паттерн «мутация кэша»).
    return JSON.parse(JSON.stringify(e.val));
}
function _lookupCacheSet(key, val) {
    if (_lookupCache.size >= _LOOKUP_CACHE_MAX) {
        const first = _lookupCache.keys().next().value;
        _lookupCache.delete(first);
    }
    _lookupCache.set(key, { val: JSON.parse(JSON.stringify(val)), ts: Date.now() });
}
function _lookupCacheInvalidate(table) {
    if (!table) { _lookupCache.clear(); return; }
    for (const k of _lookupCache.keys()) {
        if (k.startsWith(table + '::')) _lookupCache.delete(k);
    }
}

function _fkCacheGet(table, uid) {
    const key = `${table}::${uid}`;
    const entry = _fkDisplayCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > _FK_CACHE_TTL) {
        _fkDisplayCache.delete(key);
        return undefined;
    }
    return entry.val;
}

function _fkCacheSet(table, uid, displayValue) {
    const key = `${table}::${uid}`;
    if (_fkDisplayCache.size >= _FK_CACHE_MAX) {
        // Evict oldest entry
        const firstKey = _fkDisplayCache.keys().next().value;
        _fkDisplayCache.delete(firstKey);
    }
    _fkDisplayCache.set(key, { val: displayValue, ts: Date.now() });
}

/**
 * Resolve foreign key display values (batched + cached)
 * @param {string} modelName - Source model name
 * @param {Array} dataArray - Array of data rows
 * @param {Array} fields - Field metadata from getTableMetadata
 * @returns {Promise<Array>} - Data with __<field>_display properties added
 */
async function resolveTableForeignKeys(modelName, dataArray, fields, language) {
    const fkFields = fields.filter(f => f.foreignKey !== null);

    if (fkFields.length === 0) {
        return dataArray;
    }

    const fkDbGW = require('./dbGateway');
    const { Op } = require('sequelize');
    const tmw = require('./translationMiddleware');
    // 'en' — базовый язык, переводы не нужны (см. translationMiddleware).
    const useTransl = !!language && language !== 'en';

    // Phase 0: per-target-table info. displayField, признак translatable (поле справочных
    // данных переводится таблицей translations) и предзагруженный lookup переводов.
    // Map: fkTableName -> { displayField, translatable, lookup, uids: Set }
    const tableBatches = new Map();
    for (const fkField of fkFields) {
        const fkTableName = fkField.foreignKey.table;
        const displayField = fkField.foreignKey.displayField;
        if (!tableBatches.has(fkTableName)) {
            let translatable = false;
            if (useTransl) {
                const tf = tmw.getTranslatableFields(fkTableName);
                translatable = !!(tf && tf.includes(displayField));
            }
            tableBatches.set(fkTableName, { displayField, translatable, lookup: null, uids: new Set() });
        }
    }
    // Предзагрузка lookup'ов переводов для translatable display-полей (1 запрос на таблицу/язык,
    // кэшируется внутри translationMiddleware).
    if (useTransl) {
        for (const [fkTableName, batch] of tableBatches) {
            if (batch.translatable) {
                try { batch.lookup = await tmw.getTranslationLookup(fkTableName, language); } catch (e) {}
            }
        }
    }
    // Ключ FK-кэша включает язык ТОЛЬКО для translatable display (иначе разные языки
    // конфликтовали бы); для 'en'/непереводимых — прежний ключ (uid), кэш совместим.
    // Язык кладём в uid-часть ключа (а не в table-часть), чтобы invalidateFkCache(table)
    // продолжал чистить записи по префиксу `table::`.
    const cacheUid = (fkTableName, uid) =>
        tableBatches.get(fkTableName).translatable ? `${language}|${uid}` : uid;

    // Phase 1: Collect unique uncached FK values per target table
    for (const fkField of fkFields) {
        const fkTableName = fkField.foreignKey.table;
        const batch = tableBatches.get(fkTableName);
        for (const row of dataArray) {
            const fkValue = row[fkField.name];
            if (fkValue === null || fkValue === undefined) continue;
            if (_fkCacheGet(fkTableName, cacheUid(fkTableName, fkValue)) === undefined) {
                batch.uids.add(fkValue);
            }
        }
    }

    // Phase 2: Batch-fetch all uncached FK values (1 query per FK table)
    const fetchPromises = [];
    for (const [fkTableName, batch] of tableBatches) {
        if (batch.uids.size === 0) continue;
        const uidsArray = Array.from(batch.uids);
        fetchPromises.push(
            fkDbGW.execute({
                operation: 'read',
                table: fkTableName,
                where: { UID: { [Op.in]: uidsArray } },
                options: { raw: true, attributes: ['UID', batch.displayField] },
                context: { sessionID: SYSTEM_SESSION_ID }
            }).then(rows => {
                // Populate cache from results
                const found = new Set();
                if (Array.isArray(rows)) {
                    for (const r of rows) {
                        let displayValue = r[batch.displayField] || r.UID.toString();
                        // Перевод справочного значения (таблица translations) на язык сессии.
                        // Запрос идёт под SYSTEM_SESSION_ID (минуя RLS и translationMiddleware),
                        // поэтому перевод применяем здесь явно.
                        if (batch.translatable && batch.lookup) {
                            const tv = batch.lookup.get(`${r.UID}|${batch.displayField}`);
                            if (tv !== undefined) displayValue = tv;
                        }
                        _fkCacheSet(fkTableName, cacheUid(fkTableName, r.UID), displayValue);
                        found.add(r.UID);
                    }
                }
                // Mark UIDs not found in DB as "(not found)"
                for (const uid of uidsArray) {
                    if (!found.has(uid)) {
                        _fkCacheSet(fkTableName, cacheUid(fkTableName, uid), `(not found: ${uid})`);
                    }
                }
            }).catch(e => {
                console.error(`[resolveTableForeignKeys] Batch FK error for ${fkTableName}:`, e.message);
                // Cache error results so we don't retry immediately
                for (const uid of uidsArray) {
                    _fkCacheSet(fkTableName, cacheUid(fkTableName, uid), `(error: ${uid})`);
                }
            })
        );
    }
    await Promise.all(fetchPromises);

    // Phase 3: Assign display values from cache
    const result = [];
    for (const row of dataArray) {
        const resolvedRow = { ...row };
        for (const fkField of fkFields) {
            const fkValue = row[fkField.name];
            if (fkValue === null || fkValue === undefined) {
                resolvedRow[`__${fkField.name}_display`] = '';
                continue;
            }
            const fkTableName = fkField.foreignKey.table;
            const cached = _fkCacheGet(fkTableName, cacheUid(fkTableName, fkValue));
            resolvedRow[`__${fkField.name}_display`] = cached !== undefined ? cached : '';
        }
        result.push(resolvedRow);
    }

    return result;
}

/**
 * Record a single cell edit in edit session
 * @param {string} editSessionId - Edit session ID
 * @param {number} rowId - Row ID (primary key)
 * @param {string} fieldName - Field name
 * @param {any} newValue - New value
 * @returns {object} - Success status
 */
async function recordTableEdit(editSessionId, rowId, fieldName, newValue) {
    const session = editSessions.get(editSessionId);
    if (!session) {
        throw new Error('Invalid or expired edit session');
    }

    // Get or create changes map for this row
    if (!session.changes.has(rowId)) {
        session.changes.set(rowId, new Map());
    }
    
    const rowChanges = session.changes.get(rowId);
    rowChanges.set(fieldName, newValue);

    console.log(`[recordTableEdit] Session ${editSessionId}, Row ${rowId}, Field ${fieldName} = ${newValue}`);
    console.log(`[recordTableEdit] Total changes in session: ${session.changes.size} rows`);

    return { success: true, changesCount: session.changes.size };
}

/**
 * Commit all edits from session to database
 * @param {string} editSessionId - Edit session ID
 * @returns {object} - { success, newEditSessionId, errors }
 */
async function commitTableEdits(editSessionId) {
    const session = editSessions.get(editSessionId);
    if (!session) {
        throw new Error('Invalid or expired edit session');
    }

    if (session.changes.size === 0) {
        return { success: true, message: 'No changes to commit' };
    }

    const model = modelsDB[session.tableName];
    if (!model) {
        throw new Error(`Model ${session.tableName} not found`);
    }

    const errors = [];
    let successCount = 0;

    // Use transaction
    const transaction = await sequelize.transaction();
    const commitDbGW = require('./dbGateway');

    try {
        for (const [rowId, fieldChanges] of session.changes.entries()) {
            try {
                const updateData = {};
                for (const [fieldName, value] of fieldChanges.entries()) {
                    updateData[fieldName] = value;
                }

                await commitDbGW.execute({
                    operation: 'update',
                    table: model.tableName,
                    data: updateData,
                    where: { UID: rowId },
                    options: { transaction },
                    context: { sessionID: SYSTEM_SESSION_ID }
                });

                successCount++;
            } catch (e) {
                errors.push({ rowId, error: e.message });
            }
        }

        if (errors.length > 0) {
            await transaction.rollback();
            throw new Error(`Failed to update ${errors.length} rows: ${errors.map(e => e.error).join(', ')}`);
        }

        await transaction.commit();

        // Clear old session
        editSessions.delete(editSessionId);

        // Generate new edit session ID
        const newEditSessionId = crypto.randomBytes(16).toString('hex');
        editSessions.set(newEditSessionId, {
            userId: session.userId,
            tableName: session.tableName,
            changes: new Map()
        });

        console.log(`[commitTableEdits] Committed ${successCount} rows, new session: ${newEditSessionId}`);

        return {
            success: true,
            updatedRows: successCount,
            newEditSessionId: newEditSessionId
        };

    } catch (e) {
        await transaction.rollback();
        throw e;
    }
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
module.exports.recordTableEdit = recordTableEdit;
module.exports.commitTableEdits = commitTableEdits;
module.exports.invalidateFkCache = function(tableName) {
    // Invalidate FK display cache entries for a specific table
    // Called by dbGateway after create/update/delete operations
    if (!tableName) { _fkDisplayCache.clear(); _countCache.clear(); return; }
    for (const key of _fkDisplayCache.keys()) {
        if (key.startsWith(tableName + '::')) _fkDisplayCache.delete(key);
    }
    // 3.3: тот же хук сбрасывает кэш COUNT для изменённой таблицы.
    _countCacheInvalidate(tableName);
    // Кэш lookup-списков (открытие форм) сбрасывается той же мутацией.
    _lookupCacheInvalidate(tableName);
};

/**
 * Lightweight lookup: return id and display field for a table (for dropdowns/lookups)
 * @param {Object} options - { tableName, modelName, firstRow, visibleRows, userId }
 * @returns {Promise<Object>} - { totalRows, fields, data, range }
 */
async function getLookupList(options) {
    let { tableName, modelName, firstRow, visibleRows, userId, sessionID } = options || {};
    const dbContext = sessionID ? { sessionID } : { userId };

    // Resolve modelName if tableName provided
    if (!modelName && tableName) {
        modelName = module.exports.getModelNameForTable(tableName);
    }

    if (!modelName) throw new Error('modelName or tableName is required');

    const Model = modelsDB[modelName];
    if (!Model) throw new Error(`Model ${modelName} not found in modelsDB`);

// Determine display field: prefer 'name', fallback to first STRING attribute, then 'UID' or 'id'
    const attrs = Model.rawAttributes || {};
    let displayField = 'name';
    if (!attrs[displayField]) {
        displayField = Object.keys(attrs).find(k => {
            try {
                const t = attrs[k].type ? (attrs[k].type.key || attrs[k].type.constructor.key) : '';
                return t === 'STRING';
            } catch (e) {
                return false;
            }
        }) || 'UID';
    }

    visibleRows = Math.max(0, Math.min(visibleRows || 20, 1000));
    firstRow = Math.max(0, firstRow || 0);

    // Кэш: COUNT + страница строк по (таблица, identity, ЯЗЫК, окно). RLS зависит от
    // пользователя — identity обязателен в ключе. Результат содержит УЖЕ ПЕРЕВЕДЁННЫЕ
    // display-значения (translationMiddleware переводит справочники по языку сессии),
    // поэтому ЯЗЫК тоже обязан входить в ключ — иначе при смене языка в той же сессии
    // вернётся закэшированный список на старом языке (баг: статусы/типы на чужом языке).
    const _lkTable = tableName || Model.tableName;
    const _lkIdentity = sessionID || userId || '';
    let _lkLang = '';
    if (sessionID) {
        try {
            const _sctx = await require('../drive_forms/globalServerContext').getSessionContext(sessionID);
            _lkLang = (_sctx && _sctx.language) || '';
        } catch (e) { /* язык не критичен для ключа — продолжаем без него */ }
    }
    const _lkKey = `${_lkTable}::${_lkIdentity}::${_lkLang}::${firstRow}::${visibleRows}`;
    const _lkCached = _lookupCacheGet(_lkKey);
    if (_lkCached !== undefined) return _lkCached;

    const lookupDbGW = require('./dbGateway');
    const totalRows = await lookupDbGW.execute({ operation: 'count', table: tableName || Model.tableName, context: dbContext });

    const keyField = 'UID';

    // Порядок строк выпадашки: если у справочника есть числовое поле displayOrder —
    // сортируем по нему (явный порядок, заданный данными; не зависит от языка, в отличие
    // от name, который переводится через translations). Иначе — по UID, как раньше.
    // keyField добавляем вторым ключом для детерминированности при равных displayOrder.
    const orderClause = attrs.displayOrder
        ? [['displayOrder', 'ASC'], [keyField, 'ASC']]
        : [[keyField, 'ASC']];

    const rows = await lookupDbGW.execute({
        operation: 'read',
        table: tableName || Model.tableName,
        options: {
            attributes: [keyField, displayField],
            offset: firstRow,
            limit: visibleRows,
            order: orderClause,
            raw: true
        },
        context: dbContext
    });

    // Normalize to simple objects with id and display
const data = rows.map(r => ({ UID: r[keyField], display: r[displayField] }));

    const _lkResult = {
        totalRows,
        fields: [ { name: 'UID' }, { name: displayField } ],
        data,
        range: { from: firstRow, to: firstRow + data.length - 1 }
    };
    _lookupCacheSet(_lkKey, _lkResult);
    return _lkResult;
}

module.exports.getLookupList = getLookupList;
