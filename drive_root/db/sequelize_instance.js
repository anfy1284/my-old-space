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

if (isProduction && process.env.DATABASE_URL) {
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false
      }
    }
  });
} else if (settings.dialect === 'sqlite') {
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: settings.storage || path.join(process.cwd(), 'database.sqlite'),
    logging: false,
  });
} else {
  sequelize = new Sequelize(settings.database, settings.username, settings.password, {
    host: settings.host,
    port: settings.port,
    dialect: settings.dialect,
    logging: false,
    dialectOptions: {
      charset: 'utf8',
    },
  });
}

module.exports = sequelize;
