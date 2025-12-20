// deleteDB.js
// Script to drop PostgreSQL database

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// 1. Load basic settings (dialect selector)
let baseDbSettings = { dialect: 'sqlite' };
const projectRoot = process.env.PROJECT_ROOT;

if (projectRoot) {
  const projectBaseDbSettingsPath = path.join(projectRoot, 'dbSettings.json');
  if (fs.existsSync(projectBaseDbSettingsPath)) {
    try {
      baseDbSettings = JSON.parse(fs.readFileSync(projectBaseDbSettingsPath, 'utf8'));
    } catch (e) { }
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
    console.log(`[deleteDB] Using ${dialect} settings from project root: ${projectConfigPath}`);
    try {
      dbSettings = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
    } catch (e) { }
  }
}

async function dropDatabase() {
  if (dbSettings.dialect === 'sqlite') {
    const dbPath = dbSettings.storage || path.join(projectRoot || __dirname, 'database.sqlite');
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      console.log(`SQLite database file ${dbPath} deleted.`);
    } else {
      console.log(`SQLite database file ${dbPath} not found.`);
    }
    return;
  }

  const adminClient = new Client({
    user: dbSettings.username,
    password: dbSettings.password,
    host: dbSettings.host,
    port: dbSettings.port,
    database: 'postgres', // Connect to system database
  });
  await adminClient.connect();
  const dbName = dbSettings.database;
  // Disconnect all users from database
  await adminClient.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [dbName]);
  // Drop database
  await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  console.log(`Database ${dbName} dropped.`);
  await adminClient.end();
}

dropDatabase().catch(e => {
  console.error('Error dropping DB:', e);
  process.exit(1);
});
