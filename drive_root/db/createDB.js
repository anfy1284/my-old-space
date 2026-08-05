
const Sequelize = require('sequelize');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// 0. Environment and paths
const projectRoot = process.env.PROJECT_ROOT;
console.log(`[createDB] Received PROJECT_ROOT from environment: ${projectRoot || 'NOT SET'}`);

// 1. Load basic settings (dialect selector)
let baseDbSettings = { dialect: 'sqlite' }; // Default to sqlite

if (projectRoot) {
  const projectBaseDbSettingsPath = path.join(projectRoot, 'dbSettings.json');
  if (fs.existsSync(projectBaseDbSettingsPath)) {
    try {
      baseDbSettings = JSON.parse(fs.readFileSync(projectBaseDbSettingsPath, 'utf8'));
    } catch (e) {
      console.warn(`[createDB] Error parsing project dbSettings.json: ${e.message}. Using default.`);
    }
  }
}

// 2. Load dialect-specific settings
const dialect = baseDbSettings.dialect || 'sqlite';
const configFileName = `dbSettings.${dialect}.json`;
let dbSettings = dialect === 'sqlite'
  ? { dialect: 'sqlite', storage: path.join(projectRoot || __dirname, 'database.sqlite') }
  : {};

if (projectRoot) {
  const projectConfigPath = path.join(projectRoot, configFileName);
  if (fs.existsSync(projectConfigPath)) {
    console.log(`[createDB] Using ${dialect} settings from project root: ${projectConfigPath}`);
    try {
      dbSettings = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
    } catch (e) {
      console.error(`[createDB] Error parsing ${configFileName}: ${e.message}`);
    }
  } else {
    console.log(`[createDB] Project ${configFileName} not found. Using defaults for ${dialect}.`);
  }
}

const dbConfig = require('./db.json');
const emptyValues = require('./emptyValues');

// Пересев defaultValues идёт напрямую через Sequelize, минуя dbGateway, —
// значит и мимо sanitizeData. Без этой нормализации сев возвращает в базу
// NULL-ы, только что вычищенные миграцией: правило «NULL только у ссылок»
// держится ровно до первой смены схемы.
function normalizeEmptyForModel(Model, data) {
  if (!Model || !Model.rawAttributes || !data) return data;
  for (const k of Object.keys(data)) {
    const attr = Model.rawAttributes[k];
    if (!attr) continue;
    if (!emptyValues.isEmptyValue(data[k])) continue;
    if (emptyValues.isReferenceField(attr)) {
      if (data[k] === '') data[k] = null;
      continue;
    }
    const empty = emptyValues.emptyValueFor(attr);
    if (empty !== undefined) data[k] = empty;
  }
  return data;
}

const modelsDef = dbConfig.models;
const { DEFAULT_VALUES_TABLE } = dbConfig;
const { hashPassword } = require('./utilites');
const globalServerContext = require('../globalServerContext');
const { processDefaultValues } = globalServerContext;
const { normalizeType, compareSchemas, syncUniqueConstraints } = require('./migrationUtils');

/**
 * Хук для вызова пользовательских обработчиков событий
 */
async function triggerProjectEvent(eventName, context = {}) {
  try {
    const projectRoot = process.env.PROJECT_ROOT;
    
    // 1. Сначала вызываем обработчики фреймворка
    const frameworkHandlerPath = path.resolve(__dirname, '../../events_handler.js');
    if (fs.existsSync(frameworkHandlerPath)) {
      const frameworkHandler = require(frameworkHandlerPath).default || require(frameworkHandlerPath);
      if (frameworkHandler && typeof frameworkHandler[eventName] === 'function') {
        await frameworkHandler[eventName](context);
      }
    }

    // 2. Затем вызываем обработчики проекта
    if (projectRoot) {
      const projectHandlerPath = path.join(projectRoot, 'events_handler.js');
      if (fs.existsSync(projectHandlerPath)) {
        const projectHandler = require(projectHandlerPath).default || require(projectHandlerPath);
        if (projectHandler && typeof projectHandler[eventName] === 'function') {
          await projectHandler[eventName](context);
        }
      }
    }
  } catch (e) {
    console.error(`[events_handler] Error triggering event "${eventName}":`, e.message);
  }
}

// Set projectRoot in globalServerContext for this process
if (projectRoot) {
  globalServerContext.setProjectRoot(projectRoot);
  console.log(`[createDB] Set projectRoot in globalServerContext: ${projectRoot}`);
}

// Load config and data
const rootConfig = require('../../server.config.json');
const LEVEL = rootConfig.level;
const defaultValuesData = require('./defaultValues.json');
const defaultValues = processDefaultValues(defaultValuesData, LEVEL);

/**
 * Collect models from all levels: drive_root -> drive_forms -> apps
 * Now uses globalServerContext.collectAllModelDefs() for consistency
 */
function collectAllModels() {
  console.log('[COLLECT] Starting model collection from all levels...');

  // Use globalServerContext to collect models (includes PROJECT_ROOT apps)
  const { models: allModels, associations } = globalServerContext.collectAllModelDefs();
  
  // Also collect defaultValues from levels
  let defaultValuesByLevel = { [LEVEL]: defaultValues };

  console.log(`[COLLECT] Collected ${allModels.length} model definitions via globalServerContext`);

  // Collect from drive_forms for defaultValues
  const formsCreateDBPath = path.resolve(__dirname, '../../drive_forms/db/createDB.js');
  if (fs.existsSync(formsCreateDBPath)) {
    try {
      const formsModule = require(formsCreateDBPath);
      if (typeof formsModule.collectModels === 'function') {
        const formsData = formsModule.collectModels();

        // Merge defaultValues by level
        if (formsData.defaultValuesByLevel) {
          defaultValuesByLevel = { ...defaultValuesByLevel, ...formsData.defaultValuesByLevel };
        }
      }
    } catch (e) {
      console.error('[COLLECT] Error loading defaultValues from drive_forms:', e.message);
    }
  }

  console.log(`[COLLECT] Levels with defaultValues: ${Object.keys(defaultValuesByLevel).join(', ')}`);

  // Collect from PROJECT_ROOT apps for defaultValues
  if (projectRoot) {
    try {
      const projectAppsJsonPath = path.join(projectRoot, 'apps.json');
      if (fs.existsSync(projectAppsJsonPath)) {
        const projectAppsConfig = JSON.parse(fs.readFileSync(projectAppsJsonPath, 'utf8'));
        const appsPath = projectAppsConfig.appsPath || 'apps';
        const appsList = projectAppsConfig.apps || [];
        for (const app of appsList) {
          const appDefaultValuesPath = path.join(projectRoot, appsPath, app.name, 'db', 'defaultValues.json');
          if (fs.existsSync(appDefaultValuesPath)) {
            const appDefaultValuesData = JSON.parse(fs.readFileSync(appDefaultValuesPath, 'utf8'));
            const processed = processDefaultValues(appDefaultValuesData, app.name);
            defaultValuesByLevel[app.name] = processed;
            console.log(`[COLLECT] Loaded defaultValues from project app: ${app.name}`);
          }
        }
      }
    } catch (e) {
      console.error('[COLLECT] Error loading defaultValues from project apps:', e.message);
    }
  }

  return { models: allModels, defaultValuesByLevel };
}


async function ensureDatabase() {
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && process.env.DATABASE_URL) {
    console.log('Using DATABASE_URL in production, skipping database creation check.');
    return;
  }

  if (dbSettings.dialect === 'sqlite') {
    const dbPath = dbSettings.storage || path.join(projectRoot || __dirname, 'database.sqlite');
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    console.log(`[createDB] SQLite database file: ${dbPath}`);
    return;
  }

  const adminClient = new Client({
    user: dbSettings.username,
    password: dbSettings.password,
    host: dbSettings.host,
    port: dbSettings.port,
    database: 'postgres',
  });
  await adminClient.connect();
  const dbName = dbSettings.database;
  const res = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (res.rowCount === 0) {
    await adminClient.query(`CREATE DATABASE "${dbName}"`);
    console.log(`Database ${dbName} created.`);
  } else {
    console.log(`Database ${dbName} already exists.`);
  }
  await adminClient.end();
}

// Диагностика: SQL_LOG=1 печатает запросы миграции. У createDB СВОЙ экземпляр
// Sequelize — при поиске «кто портит данные на старте» логировать только
// drive_root/db/sequelize_instance.js недостаточно: миграция пройдёт мимо лога
// незамеченной (на это уже потрачен один заход).
function getSequelizeInstance() {
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && process.env.DATABASE_URL) {
    return new Sequelize(process.env.DATABASE_URL, {
      dialect: 'postgres',
      logging: process.env.SQL_LOG === '1' ? console.log : false,
      dialectOptions: {
        ssl: {
          require: true,
          rejectUnauthorized: false
        }
      }
    });
  }

  if (dbSettings.dialect === 'sqlite') {
    const dbPath = dbSettings.storage || path.join(projectRoot || __dirname, 'database.sqlite');
    return new Sequelize({
      dialect: 'sqlite',
      storage: dbPath,
      logging: process.env.SQL_LOG === '1' ? console.log : false,
    });
  }

  return new Sequelize(dbSettings.database, dbSettings.username, dbSettings.password, {
    host: dbSettings.host,
    port: dbSettings.port,
    dialect: dbSettings.dialect,
    logging: false,
  });
}

function mergeModelDefinitions(allDefs) {
  const mergedMap = new Map();

  for (const def of allDefs) {
    if (!mergedMap.has(def.name)) {
      // Deep clone to start
      mergedMap.set(def.name, JSON.parse(JSON.stringify(def)));
    } else {
      const current = mergedMap.get(def.name);
      
      console.log(`[MIGRATION] Merging model ${def.name}: adding ${Object.keys(def.fields || {}).length} fields to existing ${Object.keys(current.fields || {}).length} fields`);

      // Merge fields: later definitions overwrite/extend earlier ones
      current.fields = { ...current.fields, ...def.fields };
      
      console.log(`[MIGRATION] After merge ${def.name}: total ${Object.keys(current.fields || {}).length} fields`);

      // Merge options
      if (def.options) {
        const oldIndexes = current.options.indexes || [];
        const newIndexes = def.options.indexes || [];

        current.options = { ...current.options, ...def.options };

        // Merge indexes intelligently: combine arrays
        if (oldIndexes.length || newIndexes.length) {
          current.options.indexes = [...oldIndexes, ...newIndexes];
        }
      }
    }
  }

  return Array.from(mergedMap.values());
}

/**
 * Ensure each table has a `name` column of string type.
 * Runs during DB init using the provided Sequelize instance and model definitions.
 */
async function ensureNameColumns(sequelize, modelsDefs) {
  const qi = sequelize.getQueryInterface();
  for (const def of modelsDefs) {
    const tableName = def.tableName;
    try {
      const desc = await qi.describeTable(tableName).catch(() => null);
      if (!desc) {
        console.warn(`[MIGRATION] Table ${tableName} not found when ensuring name column`);
        continue;
      }
      if (!desc.name) {
        await qi.addColumn(tableName, 'name', { type: Sequelize.DataTypes.STRING, allowNull: true });
        console.log(`[MIGRATION] Added 'name' column to table ${tableName}`);
      } else {
        const colType = (desc.name.type || '').toString().toLowerCase();
        if (colType && !colType.includes('char') && !colType.includes('text')) {
          try {
            await qi.changeColumn(tableName, 'name', { type: Sequelize.DataTypes.STRING, allowNull: true });
            console.log(`[MIGRATION] Changed 'name' column type to STRING in table ${tableName}`);
          } catch (e) {
            console.warn(`[MIGRATION] Could not change 'name' type for ${tableName}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      console.error(`[MIGRATION] Error ensuring 'name' for ${tableName}:`, e.message);
    }
  }
}

/**
 * 3.1: Автоматически создаёт индексы на горячих колонках, которых нет в схеме:
 *   - каждая FK-колонка (поле с `references`) — PostgreSQL НЕ индексирует FK сам;
 *   - колонки контроля доступа (required_access_fields проекта) — RLS-фильтры по
 *     ним выполняются на КАЖДУЮ операцию БД (см. dbGateway);
 *   - sessions.sessionId — поиск сессии на каждый кэш-промах.
 * `CREATE INDEX IF NOT EXISTS` идемпотентен (PostgreSQL/SQLite). Ошибки не фатальны
 * (как ensureNameColumns) — логируются и не валят миграцию.
 */
async function ensureIndexes(sequelize, modelsDefs) {
  const dialect = sequelize.getDialect();
  // CREATE INDEX IF NOT EXISTS поддержан в postgres и sqlite; для прочих — пропуск.
  if (dialect !== 'postgres' && dialect !== 'sqlite') {
    console.log(`[MIGRATION] ensureIndexes: dialect ${dialect} не поддержан, пропуск`);
    return;
  }

  // required_access_fields проекта (по умолчанию — стандартный набор RLS).
  let requiredAccessFields = ['organizationId', 'hotelId', 'userId'];
  try {
    const cfgRoot = process.env.PROJECT_ROOT || process.cwd();
    const cfgPath = path.join(cfgRoot, 'app.config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (Array.isArray(cfg.required_access_fields) && cfg.required_access_fields.length) {
        requiredAccessFields = cfg.required_access_fields;
      }
    }
  } catch (e) { /* остаётся дефолт */ }
  const accessSet = new Set(requiredAccessFields);

  const quote = (id) => `"${id}"`; // postgres/sqlite — двойные кавычки
  const indexName = (table, col) => {
    let n = `idx_${table}_${col}`;
    if (n.length > 60) { // защита от лимита идентификатора Postgres (63 байта)
      const crypto = require('crypto');
      const h = crypto.createHash('md5').update(`${table}_${col}`).digest('hex').slice(0, 8);
      n = `idx_${table.slice(0, 24)}_${col.slice(0, 20)}_${h}`;
    }
    return n;
  };

  let count = 0;
  for (const def of modelsDefs) {
    const table = def.tableName;
    if (!table || !def.fields) continue;
    const cols = new Set();
    for (const [field, opts] of Object.entries(def.fields)) {
      if (!opts) continue;
      if (opts.references || accessSet.has(field)) cols.add(field);
    }
    // sessions.sessionId — поиск сессии на каждый кэш-промах (не FK, не access-поле).
    if (table === 'sessions' && def.fields.sessionId) cols.add('sessionId');

    for (const col of cols) {
      const name = indexName(table, col);
      const sql = `CREATE INDEX IF NOT EXISTS ${quote(name)} ON ${quote(table)} (${quote(col)})`;
      try {
        await sequelize.query(sql);
        count++;
      } catch (e) {
        console.warn(`[MIGRATION] ensureIndexes: ${table}.${col} -> ${e.message}`);
      }
    }
  }
  console.log(`[MIGRATION] ensureIndexes: ensured ${count} index(es) on FK / access / session columns`);
}

/**
 * Разовое переименование индексов, чьё имя СУБД обрезала по пределу идентификатора.
 *
 * Раньше имя индекса не задавалось явно, Sequelize генерировал длинное, а PostgreSQL
 * обрезал его до 63 байт. С тех пор имя задаётся явно (drive_root/db/indexNames.js),
 * но в уже существующих базах лежит обрезанное — и `sync()` считал бы, что индекса
 * нет, и создавал бы рядом второй. Переименование, а не пересоздание: индекс на
 * месте, блокировок и перестроения нет.
 *
 * Строго ограничено: переименовываем только индекс, чьё имя ровно упёрлось в предел
 * (признак обрезки), лежит на тех же колонках и начинается с имени таблицы.
 */
async function renameTruncatedIndexes(sequelize, transaction, modelsDefs) {
  if (!sequelize.getDialect || sequelize.getDialect() !== 'postgres') return 0;
  const { MAX_IDENTIFIER_LEN } = require('./indexNames');

  let existing;
  try {
    existing = await sequelize.query(
      `SELECT t.relname AS table_name, i.relname AS index_name,
              string_agg(a.attname, ',' ORDER BY k.ord) AS cols
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class t ON t.oid = x.indrelid
         JOIN unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema() AND NOT x.indisprimary
        GROUP BY t.relname, i.relname`,
      { transaction, type: Sequelize.QueryTypes.SELECT }
    );
  } catch (e) {
    console.warn('[MIGRATION] renameTruncatedIndexes: не удалось прочитать индексы:', e.message);
    return 0;
  }

  const byTable = new Map();
  for (const row of existing) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, []);
    byTable.get(row.table_name).push(row);
  }
  const taken = new Set(existing.map(r => r.index_name));

  let renamed = 0;
  for (const def of modelsDefs) {
    const indexes = def && def.options && def.options.indexes;
    if (!Array.isArray(indexes)) continue;
    const rows = byTable.get(def.tableName) || [];

    for (const idx of indexes) {
      if (!idx || !idx.name || !Array.isArray(idx.fields)) continue;
      if (taken.has(idx.name)) continue;                     // уже под нужным именем
      const wantCols = idx.fields
        .map(f => (typeof f === 'string' ? f : (f && f.name) || ''))
        .filter(Boolean).join(',');

      const legacy = rows.find(r =>
        r.cols === wantCols &&
        r.index_name !== idx.name &&
        r.index_name.length === MAX_IDENTIFIER_LEN &&     // признак обрезки СУБД
        r.index_name.startsWith(def.tableName.slice(0, 20))
      );
      if (!legacy) continue;

      try {
        await sequelize.query(`ALTER INDEX "${legacy.index_name}" RENAME TO "${idx.name}"`, { transaction });
        taken.add(idx.name);
        renamed++;
        console.log(`[MIGRATION] Индекс переименован: ${legacy.index_name} → ${idx.name}`);
      } catch (e) {
        console.warn(`[MIGRATION] Не удалось переименовать индекс ${legacy.index_name}: ${e.message}`);
      }
    }
  }
  return renamed;
}

async function createAll() {
  await ensureDatabase();
  const sequelize = getSequelizeInstance();

  // 1. Collect all models from all levels (drive_root -> drive_forms -> apps)
  const { models: allModelsDef, defaultValuesByLevel } = collectAllModels();
  const { associations: allAssociations } = globalServerContext.collectAllModelDefs();

  // 2. Merge model definitions (handle models declared on multiple levels)
  const mergedModelsDef = mergeModelDefinitions(allModelsDef);
  console.log(`[MIGRATION] Total models after merge: ${mergedModelsDef.length}`);

  // Call user event handler to modify models before DB creation
  await triggerProjectEvent('onModelsPostCollect', {
      mergedModelsDef,
      allAssociations,
      sequelize,
      projectRoot: process.env.PROJECT_ROOT
  });

  // Build dependency graph based on fields.references to determine create order
  function computeCreateOrder(modelsDefs) {
    const nameByTable = new Map(); // tableName -> def
    for (const def of modelsDefs) {
      nameByTable.set(def.tableName, def);
    }

    // Build adjacency: from parent -> set(children)
    const adj = new Map();
    const indeg = new Map();
    // Track unique (parent, child) pairs to avoid double-counting indeg
    // when multiple FK fields in the same table reference the same parent table
    const countedEdges = new Set();

    for (const def of modelsDefs) {
      const table = def.tableName;
      if (!adj.has(table)) adj.set(table, new Set());
      if (!indeg.has(table)) indeg.set(table, 0);
    }

    for (const def of modelsDefs) {
      const table = def.tableName;
      for (const [field, opts] of Object.entries(def.fields || {})) {
        if (opts && opts.references && opts.references.model) {
          let referenced = opts.references.model;
          // referenced may be tableName or model name - try to resolve
          if (!nameByTable.has(referenced)) {
            const found = modelsDefs.find(d => d.name === referenced);
            if (found) referenced = found.tableName;
          }
          // Skip self-referential FKs and duplicate (parent→child) edges
          if (nameByTable.has(referenced) && referenced !== table) {
            const edgeKey = `${referenced}→${table}`;
            if (!countedEdges.has(edgeKey)) {
              countedEdges.add(edgeKey);
              adj.get(referenced).add(table);
              indeg.set(table, (indeg.get(table) || 0) + 1);
            }
          }
        }
      }
    }

    // Kahn's algorithm
    const queue = [];
    for (const [t, d] of indeg.entries()) {
      if (d === 0) queue.push(t);
    }

    const order = [];
    while (queue.length) {
      const t = queue.shift();
      order.push(t);
      const children = adj.get(t) || new Set();
      for (const c of children) {
        indeg.set(c, indeg.get(c) - 1);
        if (indeg.get(c) === 0) queue.push(c);
      }
    }

    if (order.length !== modelsDefs.length) {
      console.warn('[MIGRATION] Warning: cyclic or unresolved FK dependencies detected. Using default model order.');
      return modelsDefs.map(d => d.tableName);
    }

    return order;
  }

  const createOrderTableNames = computeCreateOrder(mergedModelsDef);
  const createOrderDefs = createOrderTableNames.map(tn => mergedModelsDef.find(d => d.tableName === tn)).filter(Boolean);

  // 3. Initialize Sequelize Models
  const models = {};
  for (const def of mergedModelsDef) {
    const fields = {};
    for (const [field, opts] of Object.entries(def.fields)) {
      const type = Sequelize.DataTypes[opts.type];
      fields[field] = { ...opts, type };
        if (fields[field].defaultValue === "GENERATE_UID" || (typeof fields[field].defaultValue === 'function' && fields[field].defaultValue.name === 'uidGenerator')) {
          fields[field].defaultValue = function() {
            const crypto = require('crypto');
            const time = Date.now().toString(36);
            const hash = crypto.createHash('md5').update(time + Math.random().toString()).digest('hex').substring(0, 8);
            const random = Math.random().toString(36).substring(2, 8);
            return `${time}-${hash}-${random}`;
          };
          }
    }
    models[def.name] = sequelize.define(def.name, fields, { ...def.options, tableName: def.tableName });
  }

  for (const assoc of allAssociations) {
    const sourceModel = models[assoc.source];
    const targetModel = models[assoc.target];
    
    if (!sourceModel || !targetModel) {
      console.warn(`[MIGRATION] Association ${assoc.source}.${assoc.type}(${assoc.target}) - model not found`);
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
      console.log(`[MIGRATION] Applied association: ${assoc.source}.${assoc.type}(${assoc.target})`);
    } catch (e) {
      console.error(`[MIGRATION] Error applying association ${assoc.source}.${assoc.type}(${assoc.target}):`, e.message);
    }
  }

  // Start transaction for all migration operations (skip global transaction for SQLite to avoid file locks)
  const isSqlite = sequelize.getDialect && sequelize.getDialect() === 'sqlite';
  const transaction = isSqlite ? null : await sequelize.transaction();

  try {
    console.log('[MIGRATION] Starting database schema check...');

    // Разовое лечение баз, где имя индекса было обрезано СУБД (см. renameTruncatedIndexes).
    // ДО фазы синхронизации: иначе sync() снова споткнётся об «уже существует».
    try {
      const renamed = await renameTruncatedIndexes(sequelize, transaction, mergedModelsDef);
      if (renamed) console.log(`[MIGRATION] Приведено к каноническим именам индексов: ${renamed}`);
    } catch (e) {
      console.warn('[MIGRATION] renameTruncatedIndexes failed:', e.message);
    }

    // 4. Analysis Phase: Identify tables that need migration
    const tablesToMigrate = [];

    for (const def of mergedModelsDef) {
      const tableName = def.tableName;

      const tableExists = await sequelize.getQueryInterface().describeTable(tableName, { transaction }).catch(() => null);

      if (!tableExists) {
        console.log(`[MIGRATION] New table detected (will be created): ${tableName}`);
        continue;
      }

      const currentSchema = tableExists;
      const desiredSchema = def.fields;
      
      if (tableName === 'users') {
        console.log(`[MIGRATION] Users table - current fields:`, Object.keys(currentSchema));
        console.log(`[MIGRATION] Users table - desired fields:`, Object.keys(desiredSchema));
      }

      const cmp = await compareSchemas(currentSchema, desiredSchema, sequelize.getDialect());

      if (cmp.needsMigration) {
        console.log(`[MIGRATION] Table ${tableName} needs migration. Diffs:`, cmp.differences);
        tablesToMigrate.push({
          def,
          differences: cmp.differences,
          currentSchema
        });
      } else {
        await syncUniqueConstraints(sequelize, transaction, tableName, desiredSchema);
      }
    }

    // 5. Execution Phase: Batch Migration
    if (tablesToMigrate.length > 0) {
      console.log(`[MIGRATION] Batch migration needed for ${tablesToMigrate.length} tables.`);

      // A. Backup Data
      for (const item of tablesToMigrate) {
        const { def } = item;
        const tempTableName = `${def.tableName}_temp_backup`;
        console.log(`[MIGRATION] Backing up ${def.tableName} to ${tempTableName}`);
        if (isSqlite) {
          try {
            await sequelize.query(`DROP TABLE IF EXISTS "${tempTableName}"`);
          } catch (e) {}
          await sequelize.query(`CREATE TABLE "${tempTableName}" AS SELECT * FROM "${def.tableName}"`);
        } else {
          try {
            await sequelize.query(`DROP TABLE IF EXISTS "${tempTableName}"`, { transaction });
          } catch (e) {}
          await sequelize.query(`CREATE TABLE "${tempTableName}" AS SELECT * FROM "${def.tableName}"`, { transaction });
        }
      }

      // B. Drop Old Tables (Cascade for Postgres; for SQLite temporarily disable FK checks)
      if (isSqlite) {
        try {
          await sequelize.query('PRAGMA foreign_keys = OFF');
        } catch (e) {
          console.warn('[MIGRATION] Warning: could not disable sqlite foreign_keys:', e.message);
        }
      }

      for (const item of tablesToMigrate) {
        console.log(`[MIGRATION] Dropping table ${item.def.tableName}`);
        const dropSql = sequelize.getDialect && sequelize.getDialect() === 'postgres'
          ? `DROP TABLE "${item.def.tableName}" CASCADE`
          : `DROP TABLE "${item.def.tableName}"`;
        if (isSqlite) {
          await sequelize.query(dropSql);
        } else {
          await sequelize.query(dropSql, { transaction });
        }
      }

      // C. Recreate/Sync ALL Tables 
      // Sync ALL models to ensure cascading drops are healed (FKs restored)
      console.log(`[MIGRATION] Re-syncing all tables structure...`);

      let pendingModels = [...createOrderDefs];
      let maxAttempts = createOrderDefs.length * 2;
      while (pendingModels.length > 0 && maxAttempts > 0) {
        maxAttempts--;
        const currentBatch = [...pendingModels];
        pendingModels = [];
        for (const def of currentBatch) {
          try {
            if (isSqlite) {
              await models[def.name].sync();
              await syncUniqueConstraints(sequelize, null, def.tableName, def.fields);
            } else {
              await sequelize.query(`SAVEPOINT sync_table_${def.tableName}`, { transaction });
              await models[def.name].sync({ transaction });
              await syncUniqueConstraints(sequelize, transaction, def.tableName, def.fields);
            }
          } catch (e) {
            if (!isSqlite) await sequelize.query(`ROLLBACK TO SAVEPOINT sync_table_${def.tableName}`, { transaction });
            pendingModels.push(def); // Skip and retry later
          }
        }
        if (pendingModels.length === currentBatch.length) {
          console.error(`[MIGRATION] Cyclic dependency or unresolvable error. Tables left: ${pendingModels.map(m => m.tableName).join(', ')}`);
          break;
        }
      }

      // D. Restore Data from backups FIRST
      if (isSqlite) {
        try {
          await sequelize.query('PRAGMA foreign_keys = ON');
        } catch (e) {
          console.warn('[MIGRATION] Warning: could not enable sqlite foreign_keys:', e.message);
        }
      }

      console.log('[MIGRATION] Restoring all data from backups...');

      // Restore in dependency order (parents first) to minimise FK conflicts
      const tablesToMigrateMap = new Map();
      for (const item of tablesToMigrate) tablesToMigrateMap.set(item.def.tableName, item);
      const orderedMigrateItems = createOrderTableNames.map(tn => tablesToMigrateMap.get(tn)).filter(Boolean);

      for (const item of orderedMigrateItems) {
        const { def, currentSchema } = item;
        const tempTableName = `${def.tableName}_temp_backup`;
        const desiredSchema = def.fields;

        console.log(`[MIGRATION] Restoring data for ${def.tableName}...`);

        const commonFields = Object.keys(desiredSchema).filter(field => currentSchema[field]);

        // Служебные отметки времени Sequelize добавляет сам и в `def.fields`
        // их нет — значит в commonFields они не попадали и при перестройке
        // таблицы ТЕРЯЛИСЬ: все восстановленные строки получали `createdAt` и
        // `updatedAt` равными моменту миграции. Для документов это уничтожало
        // единственный след происхождения записи («когда заведён», «когда
        // последний раз менялся») — журнала изменений в системе пока нет.
        // Переносим их наравне с прикладными полями.
        for (const ts of ['createdAt', 'updatedAt']) {
          if (currentSchema[ts] && !commonFields.includes(ts)) commonFields.push(ts);
        }

        if (commonFields.length > 0) {
          const totalRowsRes = await sequelize.query(`SELECT COUNT(*) as count FROM "${tempTableName}"`, {
            transaction,
            type: Sequelize.QueryTypes.SELECT
          });
          const totalRows = parseInt(totalRowsRes[0].count);
          console.log(`[MIGRATION] Total rows to restore for ${def.tableName}: ${totalRows}`);

          const CHUNK_SIZE = 1000;
          let successCount = 0;
          let failCount = 0;
          let offset = 0;

          // Определяем поле для сортировки (лучше всего PK)
          const sortField = Object.keys(desiredSchema).find(key => desiredSchema[key].primaryKey) || commonFields[0];

          while (offset < totalRows) {
            const rows = await sequelize.query(
              `SELECT * FROM "${tempTableName}" ORDER BY "${sortField}" LIMIT ${CHUNK_SIZE} OFFSET ${offset}`,
              { transaction, type: Sequelize.QueryTypes.SELECT }
            );

            if (rows.length === 0) break;

            try {
              // 1. Пытаемся вставить пачкой (быстро)
              await sequelize.query(`SAVEPOINT chunk_${offset}`, { transaction });
              const dataToInsert = rows.map(row => {
                const data = {};
                for (const field of commonFields) {
                  data[field] = row[field];
                }
                return data;
              });

              // ignoreDuplicates помогает с уникальными ключами, но не с FK
              for (const d of dataToInsert) normalizeEmptyForModel(models[def.name], d);
              await models[def.name].bulkCreate(dataToInsert, {
                transaction,
                ignoreDuplicates: true,
                validate: false,
                hooks: false,
                // silent: перенос строки при перестройке таблицы — не правка
                // пользователя. Без этого Sequelize подменил бы `updatedAt`
                // моментом миграции.
                silent: true
              });

              await sequelize.query(`RELEASE SAVEPOINT chunk_${offset}`, { transaction });
              successCount += rows.length;
            } catch (chunkErr) {
              // 2. Если пачка не прошла (например, из-за FK), откатываемся и вставляем по одной
              await sequelize.query(`ROLLBACK TO SAVEPOINT chunk_${offset}`, { transaction });

              for (const row of rows) {
                const data = {};
                for (const field of commonFields) {
                  data[field] = row[field];
                }

                try {
                  await sequelize.query('SAVEPOINT restore_row', { transaction });
                  normalizeEmptyForModel(models[def.name], data);
                  await models[def.name].create(data, { transaction, hooks: false, silent: true });
                  await sequelize.query('RELEASE SAVEPOINT restore_row', { transaction });
                  successCount++;
                } catch (rowErr) {
                  await sequelize.query('ROLLBACK TO SAVEPOINT restore_row', { transaction });
                  failCount++;
                  // Пропускаем ошибки FK - они поправятся дефолтными значениями позже
                  if (!rowErr.message.includes('внешнего ключа') && !rowErr.message.includes('foreign key')) {
                    console.log(`[MIGRATION] Warning: Failed to restore row in ${def.tableName}: ${rowErr.message}`);
                  }
                }
              }
            }

            offset += rows.length;
            if (totalRows > CHUNK_SIZE) {
              const progress = Math.round((offset / totalRows) * 100);
              console.log(`[MIGRATION] Progress for ${def.tableName}: ${progress}% (${offset}/${totalRows})`);
            }
          }

          if (failCount > 0) {
            console.log(`[MIGRATION] Restored ${successCount}/${totalRows} rows to ${def.tableName} (${failCount} failed - will be fixed by defaultValues)`);
          } else {
            console.log(`[MIGRATION] Restored ${successCount}/${totalRows} rows to ${def.tableName}`);
          }
        }

        // E. Drop Backup
        await sequelize.query(`DROP TABLE "${tempTableName}"`, { transaction });

        // F. Reset Sequences
        const pkField = Object.keys(desiredSchema).find(key => desiredSchema[key].primaryKey && desiredSchema[key].autoIncrement);
        if (pkField) {
          if (sequelize.getDialect() === 'postgres') {
            await sequelize.query(
              `SELECT setval(pg_get_serial_sequence('"${def.tableName}"', '${pkField}'), COALESCE(MAX("${pkField}"), 1)) FROM "${def.tableName}"`,
              { transaction }
            );
          } else if (sequelize.getDialect() === 'sqlite') {
            await sequelize.query(
              `DELETE FROM sqlite_sequence WHERE name='${def.tableName}'`,
              { transaction }
            );
            await sequelize.query(
              `INSERT INTO sqlite_sequence (name, seq) SELECT '${def.tableName}', COALESCE(MAX("${pkField}"), 0) FROM "${def.tableName}"`,
              { transaction }
            );
          }
        }
      }

      console.log(`[MIGRATION] Batch migration execution finished.`);

    } else {
      console.log('[MIGRATION] No schema changes requiring migration. Ensuring all tables exist...');
      
      let pendingModels = [...createOrderDefs];
      let maxAttempts = createOrderDefs.length * 2;
      while (pendingModels.length > 0 && maxAttempts > 0) {
        maxAttempts--;
        const currentBatch = [...pendingModels];
        pendingModels = [];
        for (const def of currentBatch) {
          try {
            if (isSqlite) {
              await models[def.name].sync();
            } else {
              await sequelize.query(`SAVEPOINT sync_table_no_mig_${def.tableName}`, { transaction });
              await models[def.name].sync({ transaction });
            }
          } catch (e) {
            if (!isSqlite) await sequelize.query(`ROLLBACK TO SAVEPOINT sync_table_no_mig_${def.tableName}`, { transaction });
            pendingModels.push(def);
          }
        }
        if (pendingModels.length === currentBatch.length) {
          console.error(`[MIGRATION] Cyclic dependency or unresolvable error. Tables left: ${pendingModels.map(m => m.tableName).join(', ')}`);
          for (const def of pendingModels) {
            try {
              await sequelize.query(`SAVEPOINT sync_force_${def.tableName}`, { transaction });
              await models[def.name].sync({ transaction });
              await sequelize.query(`RELEASE SAVEPOINT sync_force_${def.tableName}`, { transaction });
              console.log(`[MIGRATION] Force synced: ${def.tableName}`);
            } catch (e2) {
              await sequelize.query(`ROLLBACK TO SAVEPOINT sync_force_${def.tableName}`, { transaction });
              console.error(`[MIGRATION] FAILED to sync ${def.tableName}: ${e2.message}`);
            }
          }
          break;
        }
      }

      // Fill defaultValues for new installation
      console.log('[MIGRATION] Filling defaultValues for new installation...');
      const DefaultValuesModel = models.DefaultValues;

      for (const [lvlName, lvlValues] of Object.entries(defaultValuesByLevel)) {
        console.log(`[MIGRATION] Filling defaultValues for level: ${lvlName}`);

        for (const [entity, records] of Object.entries(lvlValues)) {
          const modelDef = mergedModelsDef.find(m => m.tableName === entity);
          if (!modelDef) continue;
          const Model = models[modelDef.name];
          if (!Model) continue;

          for (const record of records) {
            const defaultValueId = record.UID;
            if (defaultValueId === undefined) continue;

            let data = { ...record };
            delete data._level;

            // Specific handling for users
            if (entity === 'users') {
              if (data.username) {
                data.name = data.username;
                delete data.username;
              }
              if (data.password) {
                data.password_hash = await hashPassword(data.password);
                delete data.password;
              }
            }

            try {
              await sequelize.query('SAVEPOINT fill_default', { transaction });
              normalizeEmptyForModel(Model, data);
              const newRecord = await Model.create(data, { transaction });
              await DefaultValuesModel.create({
                level: lvlName,
                defaultValueId: defaultValueId,
                tableName: entity,
                recordId: newRecord.UID
              }, { transaction });
              await sequelize.query('RELEASE SAVEPOINT fill_default', { transaction });
              console.log(`[MIGRATION] Added: ${entity}[${newRecord.UID}] (defaultValueId=${defaultValueId}, level=${lvlName})`);
            } catch (err) {
              await sequelize.query('ROLLBACK TO SAVEPOINT fill_default', { transaction });
              // May already exist, skip
            }
          }
        }
      }
    }

    // 6. Update/cleanup default values - CASCADE through all levels
    console.log('[MIGRATION] Updating and cleaning up default values for all levels...');
    const DefaultValuesModel = models.DefaultValues;

    for (const [lvlName, lvlValues] of Object.entries(defaultValuesByLevel)) {
      console.log(`[MIGRATION] Updating defaultValues for level: ${lvlName}`);

      // Collect all defaultValueId for current level
      const currentLevelIds = new Set();
      for (const [entity, records] of Object.entries(lvlValues)) {
        if (Array.isArray(records)) {
          records.forEach(record => {
            if (record.UID !== undefined) {
              currentLevelIds.add(record.UID);
            }
          });
        }
      }

      // Remove records not present in current level
      const existingDefaults = await DefaultValuesModel.findAll({
        where: { level: lvlName },
        transaction
      });

      for (const defValue of existingDefaults) {
        if (!currentLevelIds.has(defValue.defaultValueId)) {
          // Remove record from main table
          const modelDef = mergedModelsDef.find(m => m.tableName === defValue.tableName);
          if (modelDef && models[modelDef.name]) {
            await models[modelDef.name].destroy({
              where: { UID: defValue.recordId },
              transaction
            });
            console.log(`[MIGRATION] Removed obsolete record: ${defValue.tableName}[${defValue.recordId}] (defaultValueId=${defValue.defaultValueId}, level=${lvlName})`);
          }
          // Remove record from DEFAULT_VALUES_TABLE
          await defValue.destroy({ transaction });
        }
      }

      // Add or update default values
      // If record with ID exists - update ONLY specified fields
      // If not exists - create new record
      for (const [entity, records] of Object.entries(lvlValues)) {
        const modelDef = mergedModelsDef.find(m => m.tableName === entity);
        if (!modelDef) continue;
        const Model = models[modelDef.name];
        if (!Model) continue;

        for (const record of records) {
          const defaultValueId = record.UID;
          if (defaultValueId === undefined) continue;

          let data = { ...record };
          delete data._level; // Remove service field

          // Specific handling for users
          if (entity === 'users') {
            if (data.username) {
              data.name = data.username;
              delete data.username;
            }
            if (data.password) {
              data.password_hash = await hashPassword(data.password);
              delete data.password;
            }
          }

          // Check if record with this ID already exists (from backup)
          let existingRecord = null;
          if (data.UID) {
            try {
              await sequelize.query('SAVEPOINT check_existing', { transaction });
              existingRecord = await Model.findOne({
                where: { UID: data.UID },
                transaction
              });
              await sequelize.query('RELEASE SAVEPOINT check_existing', { transaction });
            } catch (findErr) {
              await sequelize.query('ROLLBACK TO SAVEPOINT check_existing', { transaction });
              console.warn(`[MIGRATION] Warning: could not check existing record in ${entity}: ${findErr.message}. Will attempt create.`);
            }
          }

          try {
            await sequelize.query('SAVEPOINT update_default', { transaction });
            if (existingRecord) {
              // Record exists - update ONLY fields from defaultValues config
              const updateData = { ...data };
              delete updateData.UID; // Don't update ID
              normalizeEmptyForModel(Model, updateData);

              // silent: служебный пересев — НЕ действие пользователя, и он не
              // должен подменять `updatedAt`. Иначе «когда документ последний
              // раз менялся» затирается при каждой смене схемы, а это
              // единственный след происхождения записи (журнала изменений в
              // системе пока нет). Бэклог B1.
              await existingRecord.update(updateData, { transaction, silent: true });
              console.log(`[MIGRATION] Updated predefined fields in: ${entity}[${existingRecord.UID}] (defaultValueId=${defaultValueId}, level=${lvlName})`);

              // Register in DefaultValues table
              const defEntry = await DefaultValuesModel.findOne({
                where: { level: lvlName, defaultValueId, tableName: entity },
                transaction
              });
              if (!defEntry) {
                await DefaultValuesModel.create({
                  level: lvlName,
                  defaultValueId: defaultValueId,
                  tableName: entity,
                  recordId: existingRecord.UID
                }, { transaction });
              }
            } else {
              // Record doesn't exist - create new
              const newRecord = await Model.create(data, { transaction });
              console.log(`[MIGRATION] Created new predefined record: ${entity}[${newRecord.UID}] (defaultValueId=${defaultValueId}, level=${lvlName})`);

              // Register in DefaultValues table (check if not already registered)
              const defEntry = await DefaultValuesModel.findOne({
                where: { level: lvlName, defaultValueId, tableName: entity },
                transaction
              });
              if (!defEntry) {
                await DefaultValuesModel.create({
                  level: lvlName,
                  defaultValueId: defaultValueId,
                  tableName: entity,
                  recordId: newRecord.UID
                }, { transaction });
              }
            }
            await sequelize.query('RELEASE SAVEPOINT update_default', { transaction });
          } catch (err) {
            await sequelize.query('ROLLBACK TO SAVEPOINT update_default', { transaction });
            console.error(`[MIGRATION] Error processing default value for ${entity} (defaultValueId=${defaultValueId}):`, err.message);
          }
        }
      }
    }

    // 7. Reset sequences for all tables after default values
    for (const def of createOrderDefs) {
      const pkField = Object.keys(def.fields).find(key => def.fields[key].primaryKey && def.fields[key].autoIncrement);
      if (!pkField) continue;
      const tableName = def.tableName;
      try {
        if (sequelize.getDialect() === 'postgres') {
          await sequelize.query(
            `SELECT setval(pg_get_serial_sequence('"${tableName}"', '${pkField}'), COALESCE(MAX("${pkField}"), 1)) FROM "${tableName}"`,
            { transaction }
          );
        } else if (sequelize.getDialect() === 'sqlite') {
          await sequelize.query(`DELETE FROM sqlite_sequence WHERE name='${tableName}'`, { transaction });
          await sequelize.query(
            `INSERT INTO sqlite_sequence (name, seq) SELECT '${tableName}', COALESCE(MAX("${pkField}"), 0) FROM "${tableName}"`,
            { transaction }
          );
        }
      } catch (e) {
        console.error(`[MIGRATION] Error resetting sequence for ${tableName}.${pkField}:`, e.message);
      }
    }

    // Commit transaction (if created)
    if (transaction) {
      await transaction.commit();
    }
    console.log('[MIGRATION] Database migration completed successfully.');

    // Ensure each table has a `name` column of string type (run after commit to avoid lock conflicts)
    try {
      await ensureNameColumns(sequelize, mergedModelsDef);
    } catch (e) {
      console.error('[MIGRATION] ensureNameColumns failed:', e.message);
    }

    // 3.1: авто-индексы на FK / колонках доступа / sessions.sessionId (после commit).
    try {
      await ensureIndexes(sequelize, mergedModelsDef);
    } catch (e) {
      console.error('[MIGRATION] ensureIndexes failed:', e.message);
    }

    // Call user event handler after full database init
    await triggerProjectEvent('onDatabasePostInit', { 
        sequelize, 
        projectRoot: process.env.PROJECT_ROOT,
        level: LEVEL
    });

  } catch (error) {
    // Rollback transaction on error (if created)
    if (transaction) {
      await transaction.rollback();
    }
    console.error('[MIGRATION] ERROR: Migration cancelled, all changes rolled back.');
    console.error('[MIGRATION] Error details:', error.message);
    console.error(error.stack);
    throw error;
  }

  await sequelize.close();
}

createAll().catch(e => {
  console.error('Error creating database:', e);
  process.exit(1);
});
