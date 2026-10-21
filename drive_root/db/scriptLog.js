'use strict';

/**
 * scriptLog — журнал выполненных разовых скриптов (16.10.2026).
 *
 * Зачем. Разовые скрипты (`tmp/<дата>_<имя>.lib.js` + обёртки для localhost и
 * прода) чинят данные при обновлении. Раньше нигде не оставалось следа, какие из
 * них уже прошли на данной базе, — и по копии прода нельзя было сказать, что ей
 * ещё нужно. Теперь скрипт, выполненный с `--apply`, записывает себя в
 * `db_scripts` вместе с версией кода (`drive_root/buildInfo.js`) и итогом.
 *
 * Осмотр (без `--apply`) не записывается: он ничего не менял.
 *
 * Таблица создаётся и здесь (`CREATE TABLE IF NOT EXISTS`), а не только миграцией:
 * скрипт бывает нужен ДО первого старта новой версии (подготовить данные, на
 * которых иначе упадёт миграция). Колонки — те же, что у модели `DbScripts` в
 * `drive_root/db/db.json` плюс представление `name`, которое ядро добавляет
 * каждой модели само; разойдутся — миграция перестроит таблицу.
 *
 * Использование в обёртке скрипта:
 *
 *   const scriptLog = require('../node_modules/my-old-space/drive_root/db/scriptLog'); // пакет закрывает внутренние пути (exports)
 *   scriptLog.run(sequelize, '2026-10-16_rechnungszeilen_zimmerbezug',
 *       { apply: process.argv.includes('--apply') },
 *       (opts) => repair(sequelize, opts));
 *
 * Функция скрипта может вернуть строку или объект — это итог, он попадёт в журнал.
 */

const { QueryTypes } = require('sequelize');
const buildInfo = require('../buildInfo');

const TABLE = 'db_scripts';

async function ensureTable(sequelize) {
    await sequelize.query(`CREATE TABLE IF NOT EXISTS "${TABLE}" (
        "UID" VARCHAR(255) PRIMARY KEY,
        "organizationId" VARCHAR(255),
        "name" VARCHAR(255) DEFAULT '',
        "scriptName" VARCHAR(255) NOT NULL DEFAULT '',
        "appliedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "appVersion" VARCHAR(255) NOT NULL DEFAULT '',
        "frameworkVersion" VARCHAR(255) NOT NULL DEFAULT '',
        "summary" TEXT,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL
    )`);
}

function summaryText(result) {
    if (result === undefined || result === null) return null;
    if (typeof result === 'string') return result;
    try { return JSON.stringify(result); } catch (_) { return String(result); }
}

/** Записать, что скрипт выполнен. */
async function record(sequelize, scriptName, { summary = null } = {}) {
    await ensureTable(sequelize);
    const now = new Date();
    const v = buildInfo.get();
    await sequelize.query(
        `INSERT INTO "${TABLE}" ("UID","organizationId","name","scriptName","appliedAt","appVersion","frameworkVersion","summary","createdAt","updatedAt")
         VALUES (:uid, NULL, :name, :name, :now, :app, :fw, :summary, :now, :now)`,
        { replacements: {
            uid: require('./utilites').generateUID('DbScripts'),
            name: String(scriptName), now, app: v.appVersion, fw: v.frameworkVersion,
            summary: summaryText(summary)
        } }
    );
}

/** Все выполнения, старые сверху. */
async function list(sequelize) {
    await ensureTable(sequelize);
    return sequelize.query(
        `SELECT "scriptName","appliedAt","appVersion","frameworkVersion","summary" FROM "${TABLE}" ORDER BY "appliedAt"`,
        { type: QueryTypes.SELECT }
    );
}

/** Выполнялся ли скрипт на этой базе. */
async function wasApplied(sequelize, scriptName) {
    await ensureTable(sequelize);
    const rows = await sequelize.query(
        `SELECT 1 FROM "${TABLE}" WHERE "scriptName" = :name LIMIT 1`,
        { replacements: { name: String(scriptName) }, type: QueryTypes.SELECT }
    );
    return rows.length > 0;
}

/**
 * Выполнить скрипт и, если это была правка (`apply`) и она прошла без ошибки,
 * записать его в журнал. Повторный запуск не запрещается — скрипты обязаны быть
 * повторяемыми, — но о прошлом выполнении говорится заранее.
 */
async function run(sequelize, scriptName, { apply = false } = {}, fn) {
    try {
        if (await wasApplied(sequelize, scriptName)) {
            console.log(`[scriptLog] ${scriptName}: на этой базе уже выполнялся (см. таблицу ${TABLE}).`);
        }
    } catch (e) {
        console.warn(`[scriptLog] Журнал недоступен: ${e.message}`);
    }
    const result = await fn({ apply });
    if (apply) {
        await record(sequelize, scriptName, { summary: result });
        console.log(`[scriptLog] ${scriptName}: записан в ${TABLE}.`);
    }
    return result;
}

module.exports = { run, record, list, wasApplied, ensureTable, TABLE };
