'use strict';

/**
 * settings — инсталляционные настройки резервного копирования.
 *
 * Живут в ФАЙЛЕ, а не в БД (ТЗ §2.1). Причина принципиальная: каталог хранения,
 * публичный ключ и хэш API-ключа относятся к ЭТОЙ машине, а не к данным. Лежали бы
 * они в базе — восстановление годичного дампа молча откатило бы их к прежнему
 * состоянию: отозвало действующий API-ключ, подменило публичный ключ, вернуло
 * несуществующий путь. В бэкап этот файл не входит.
 *
 * Запись атомарна и с сохранением чужих ключей: файл читают и правят разные
 * механизмы, а прерывание записи не должно оставить огрызок.
 */

const fs = require('fs');
const path = require('path');
const log = require('../log');

const FILE_NAME = 'backupSettings.json';

/** Значения по умолчанию. Публичного ключа среди них нет намеренно — см. §3.0. */
const DEFAULTS = {
    storageDir: 'backups',          // относительный путь разрешается от корня проекта
    keepScheduled: 7,               // ретеншн плановых копий (§1)
    keepManual: 3,                  // ретеншн ручных копий — считается ОТДЕЛЬНО
    publicKeyPem: '',
    keyFingerprint: '',
    apiKeyHash: ''                  // SHA-256 ключа внешнего приложения (этап 2.3)
};

function projectRoot() {
    if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
    try {
        const r = require('../globalServerContext').getProjectRoot();
        if (r) return r;
    } catch (e) { /* контекст может быть ещё не поднят — воркер */ }
    return process.cwd();
}

function filePath() {
    return path.join(projectRoot(), FILE_NAME);
}

/**
 * Прочитать настройки. Файла нет — вернуть умолчания (это нормальное состояние
 * свежей инсталляции, а не ошибка).
 * @returns {Object}
 */
function read() {
    const p = filePath();
    let raw = {};
    if (fs.existsSync(p)) {
        try {
            raw = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
        } catch (e) {
            // Битый файл настроек — это не повод молча работать на умолчаниях:
            // каталог хранения и ключ могли быть заданы, и «умолчания» уведут
            // бэкап в другое место либо остановят его без объяснения.
            throw new Error(`Файл настроек ${FILE_NAME} повреждён: ${e.message}`);
        }
    }
    return Object.assign({}, DEFAULTS, raw);
}

/**
 * Записать переданные ключи, сохранив все остальные.
 *
 * Read-modify-write + запись во временный файл + переименование: `rename` в пределах
 * одной ФС атомарен, поэтому прерывание не оставляет полуфайла.
 * @param {Object} patch — только изменяемые ключи
 * @returns {Object} итоговые настройки
 */
function write(patch) {
    const p = filePath();
    let current = {};
    if (fs.existsSync(p)) {
        try { current = JSON.parse(fs.readFileSync(p, 'utf8')) || {}; }
        catch (e) { throw new Error(`Файл настроек ${FILE_NAME} повреждён, запись отменена: ${e.message}`); }
    }

    const next = Object.assign({}, current, patch);
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    try {
        fs.renameSync(tmp, p);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* уборка мусора не важнее исходной ошибки */ }
        throw e;
    }
    return Object.assign({}, DEFAULTS, next);
}

/** Абсолютный путь каталога хранения (относительный разрешается от корня проекта). */
function storagePath(settings) {
    const s = settings || read();
    const dir = String(s.storageDir || DEFAULTS.storageDir);
    return path.isAbsolute(dir) ? dir : path.join(projectRoot(), dir);
}

/**
 * Создать каталог хранения, если его нет.
 * @returns {string} абсолютный путь
 */
function ensureStorage(settings) {
    const dir = storagePath(settings);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log.info(`[backup] Создан каталог хранения: ${dir}`);
    }
    return dir;
}

module.exports = { read, write, storagePath, ensureStorage, filePath, FILE_NAME, DEFAULTS };
