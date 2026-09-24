const { Sequelize } = require('sequelize');
const fs = require('fs');
const path = require('path');



// Настройки подключения решает ОДИН модуль — `drive_root/db/dbSettings.js`.
// Прежде их читали здесь и ещё раз в `createDB.js`, каждый по-своему: этот файл от
// рабочего каталога процесса, тот — от `PROJECT_ROOT`. Пока они совпадают, разницы
// не видно; стоит разойтись — миграция уходит в одну базу, а сервер работает с
// другой, и обе операции при этом «успешны». Второго места быть не должно.
const dbSettingsResolver = require('./dbSettings');
const isProduction = process.env.NODE_ENV === 'production';

let settings = {};
let dialect = 'sqlite';
if (!(isProduction && process.env.DATABASE_URL)) {
  const resolved = dbSettingsResolver.resolve();
  settings = resolved.settings;
  dialect = resolved.dialect;
}

let sequelize;

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
