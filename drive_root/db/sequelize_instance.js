const { Sequelize } = require('sequelize');
const fs = require('fs');
const path = require('path');



// Читаем настройки из dbSettings.json
// 1. Если production и есть DATABASE_URL — используем только её
// 2. Если DB_SETTINGS_PATH задана — используем её
// 3. Иначе ищем dbSettings.json сначала в корне процесса, потом в пакете
const projectRoot = process.cwd();
let baseSettings = { dialect: 'sqlite' };
const baseSettingsPath = path.join(projectRoot, 'dbSettings.json');

if (fs.existsSync(baseSettingsPath)) {
  try {
    baseSettings = JSON.parse(fs.readFileSync(baseSettingsPath, 'utf8'));
  } catch (e) {
    console.error('Ошибка парсинга dbSettings.json:', e.message);
  }
}

// 2. Load dialect-specific settings
const dialect = baseSettings.dialect || 'sqlite';
const configFileName = `dbSettings.${dialect}.json`;
const configPath = path.join(projectRoot, configFileName);

let settings = dialect === 'sqlite'
  ? { dialect: 'sqlite', storage: path.join(projectRoot, 'database.sqlite') }
  : {};

if (fs.existsSync(configPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`Ошибка чтения ${configFileName}:`, e.message);
    if (dialect === 'postgres') throw e; // Postgres requires config
  }
} else if (dialect === 'postgres') {
  console.error(`Критическая ошибка: ${configFileName} не найден для PostgreSQL`);
  throw new Error(`Configuration file ${configFileName} missing`);
}

let sequelize;
const isProduction = process.env.NODE_ENV === 'production';

// ТЗ «Оптимизация фреймворка», п. 3.2 — пул соединений.
// По умолчанию Sequelize держит max=5/idle=10s без keepAlive: при RLS-амплификации
// (3-4 SQL на одну логическую операцию) 5 коннектов забиваются мгновенно и запросы
// встают в очередь, а на удалённом Postgres переустановка коннекта после idle —
// лишние ms на каждый «холодный» запрос. Значения берём из dbSettings.<dialect>.json
// (ключ "pool"), чтобы согласовать max с лимитом коннектов бесплатного тарифа.
const poolDefaults = { max: 10, min: 1, idle: 30000, acquire: 30000 };
const poolConfig = Object.assign({}, poolDefaults, settings.pool || {});

if (isProduction && process.env.DATABASE_URL) {
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    // Диагностика: SQL_LOG=1 включает печать всех запросов. Нужен, когда
    // надо понять, кто и что делает с данными при старте (напр. поиск
    // источника перезаписи `updatedAt`/`name` — бэклог B1).
    logging: process.env.SQL_LOG === '1' ? console.log : false,
    pool: poolConfig,
    dialectOptions: {
      keepAlive: true,
      ssl: {
        require: true,
        rejectUnauthorized: false
      }
    }
  });
} else if (settings.dialect === 'sqlite') {
  // SQLite — однофайловая БД, пул соединений неприменим.
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: settings.storage || path.join(process.cwd(), 'database.sqlite'),
    // Диагностика: SQL_LOG=1 включает печать всех запросов. Нужен, когда
    // надо понять, кто и что делает с данными при старте (напр. поиск
    // источника перезаписи `updatedAt`/`name` — бэклог B1).
    logging: process.env.SQL_LOG === '1' ? console.log : false,
  });
} else {
  sequelize = new Sequelize(settings.database, settings.username, settings.password, {
    host: settings.host,
    port: settings.port,
    dialect: settings.dialect,
    // Диагностика: SQL_LOG=1 включает печать всех запросов. Нужен, когда
    // надо понять, кто и что делает с данными при старте (напр. поиск
    // источника перезаписи `updatedAt`/`name` — бэклог B1).
    logging: process.env.SQL_LOG === '1' ? console.log : false,
    pool: poolConfig,
    dialectOptions: {
      charset: 'utf8',
      keepAlive: true,
    },
  });
}

module.exports = sequelize;
