
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
const modelsDef = dbConfig.models;
const { DEFAULT_VALUES_TABLE } = dbConfig;
const { hashPassword } = require('./utilites');
const globalServerContext = require('../globalServerContext');
const { processDefaultValues } = globalServerContext;
const { normalizeType, compareSchemas, syncUniqueConstraints } = require('./migrationUtils');

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
    await adminClient.query(`CREATE DATABASE "${dbName}" WITH ENCODING 'UTF8' LC_COLLATE='C.UTF-8' LC_CTYPE='C.UTF-8'`);
    console.log(`Database ${dbName} created.`);
  } else {
    console.log(`Database ${dbName} already exists.`);
  }
  await adminClient.end();
}

function getSequelizeInstance() {
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && process.env.DATABASE_URL) {
    return new Sequelize(process.env.DATABASE_URL, {
      dialect: 'postgres',
      logging: false,
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
      logging: false,
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

async function createAll() {
  await ensureDatabase();
  const sequelize = getSequelizeInstance();

  // 1. Collect all models from all levels (drive_root -> drive_forms -> apps)
  const { models: allModelsDef, defaultValuesByLevel } = collectAllModels();
  const { associations: allAssociations } = globalServerContext.collectAllModelDefs();

  // 2. Merge model definitions (handle models declared on multiple levels)
  const mergedModelsDef = mergeModelDefinitions(allModelsDef);
  console.log(`[MIGRATION] Total models after merge: ${mergedModelsDef.length}`);

  // Build dependency graph based on fields.references to determine create order
  function computeCreateOrder(modelsDefs) {
    const nameByTable = new Map(); // tableName -> def
    for (const def of modelsDefs) {
      nameByTable.set(def.tableName, def);
    }

    // Build adjacency: from parent -> set(children)
    const adj = new Map();
    const indeg = new Map();

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
          if (nameByTable.has(referenced)) {
            // edge: referenced -> table (parent -> child)
            adj.get(referenced).add(table);
            indeg.set(table, (indeg.get(table) || 0) + 1);
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
    }
    models[def.name] = sequelize.define(def.name, fields, { ...def.options, tableName: def.tableName });
  }
  
  // Apply associations
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
          await sequelize.query(`CREATE TABLE "${tempTableName}" AS SELECT * FROM "${def.tableName}"`);
        } else {
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
      for (const def of createOrderDefs) {
        if (isSqlite) {
          await models[def.name].sync();
          await syncUniqueConstraints(sequelize, null, def.tableName, def.fields);
        } else {
          await models[def.name].sync({ transaction });
          await syncUniqueConstraints(sequelize, transaction, def.tableName, def.fields);
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
              await models[def.name].bulkCreate(dataToInsert, {
                transaction,
                ignoreDuplicates: true,
                validate: false,
                hooks: false
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
                  await models[def.name].create(data, { transaction, hooks: false });
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
      for (const def of createOrderDefs) {
        await models[def.name].sync({ transaction });
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
            const defaultValueId = record.id;
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
              const newRecord = await Model.create(data, { transaction });
              await DefaultValuesModel.create({
                level: lvlName,
                defaultValueId: defaultValueId,
                tableName: entity,
                recordId: newRecord.id
              }, { transaction });
              await sequelize.query('RELEASE SAVEPOINT fill_default', { transaction });
              console.log(`[MIGRATION] Added: ${entity}[${newRecord.id}] (defaultValueId=${defaultValueId}, level=${lvlName})`);
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
            if (record.id !== undefined) {
              currentLevelIds.add(record.id);
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
              where: { id: defValue.recordId },
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
          const defaultValueId = record.id;
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
          if (data.id) {
            existingRecord = await Model.findOne({
              where: { id: data.id },
              transaction
            });
          }

          try {
            await sequelize.query('SAVEPOINT update_default', { transaction });
            if (existingRecord) {
              // Record exists - update ONLY fields from defaultValues config
              const updateData = { ...data };
              delete updateData.id; // Don't update ID

              await existingRecord.update(updateData, { transaction });
              console.log(`[MIGRATION] Updated predefined fields in: ${entity}[${existingRecord.id}] (defaultValueId=${defaultValueId}, level=${lvlName})`);

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
                  recordId: existingRecord.id
                }, { transaction });
              }
            } else {
              // Record doesn't exist - create new
              const newRecord = await Model.create(data, { transaction });
              console.log(`[MIGRATION] Created new predefined record: ${entity}[${newRecord.id}] (defaultValueId=${defaultValueId}, level=${lvlName})`);

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
                  recordId: newRecord.id
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
