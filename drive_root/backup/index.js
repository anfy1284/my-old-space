'use strict';

/**
 * backup — ядро резервного копирования.
 *
 * ЯДРО ОДНО, ПОВОДОВ МНОГО. Здесь нет ни расписания, ни кнопки: и плановый запуск, и
 * ручной приходят сюда одним путём — через обработчик `backup.create` планировщика.
 * Отдельной «ручной» ветки выгрузки в системе быть не должно (ТЗ, решение 0.0.1).
 *
 * Что делает: проверяет предусловия, открывает снимок, гонит NDJSON → gzip → шифратор
 * → файл, считает контрольные суммы и прореживает старые копии по двум независимым
 * лимитам.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const log = require('../log');
const settingsStore = require('./settings');
const keys = require('./keys');
const container = require('./container');
const dialect = require('./dialect');
const dump = require('./dump');

const FILE_EXT = '.mosbak';

/** Поток, считающий SHA-256 и размер проходящих байт (шифротекста). */
class TapStream extends Transform {
    constructor() { super(); this.hash = crypto.createHash('sha256'); this.size = 0; }
    _transform(c, _e, cb) { this.hash.update(c); this.size += c.length; this.push(c); cb(); }
    digest() { return this.hash.digest('hex'); }
}

/**
 * Метка времени в имени файла — с МИЛЛИСЕКУНДАМИ.
 *
 * Секундной точности мало: две копии, снятые подряд (ручная перед рискованной
 * операцией, следом плановая), попадали в одну секунду, получали одно имя, и вторая
 * молча ЗАТИРАЛА первую — на диске оставался один файл, а в журнале две записи, одна
 * из которых указывала в никуда. Поймано прогоном.
 */
const stamp = (d) => d.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23);

/**
 * Имя файла. Область и версия структуры видны прямо в имени — чтобы понять, что это
 * за копия, не читая файл (ТЗ §9 п. 12).
 */
function buildFileName(dbName, scope, dbVersion, now) {
    const kind = scope.type === 'organization' ? `org-${String(scope.organizationId).slice(0, 8)}` : 'full';
    const ver = dbVersion ? `-v${dbVersion}` : '';
    return `${dbName || 'db'}-${kind}-${stamp(now)}${ver}${FILE_EXT}`;
}

/**
 * Проверить предусловия ДО начала работы (ТЗ §3.0).
 *
 * Все до единого выясняются заранее и намеренно: задача не должна обнаружить нехватку
 * места или отсутствие ключа на середине, оставив недописанный файл.
 *
 * @returns {Promise<{ok: boolean, errorKey?: string, vars?: Object, settings?: Object, storageDir?: string}>}
 */
async function checkPreconditions(sequelize, opts = {}) {
    const settings = settingsStore.read();

    // Без публичного ключа бэкап не делается ВОВСЕ. Не «незашифрованный», не
    // «пропустим шифрование»: незашифрованный дамп с персональными данными клиентов —
    // это не половина результата, а новая проблема.
    const keyCheck = keys.validatePublicKey(settings.publicKeyPem);
    if (!keyCheck.ok) return { ok: false, errorKey: keyCheck.errorKey, vars: keyCheck.vars };

    const nb = await dialect.checkNonBlocking(sequelize);
    if (!nb.ok) return { ok: false, errorKey: nb.errorKey, vars: nb.vars };

    let storageDir;
    try {
        storageDir = settingsStore.ensureStorage(settings);
        fs.accessSync(storageDir, fs.constants.W_OK);
    } catch (e) {
        return { ok: false, errorKey: 'backup_err_storage_unwritable', vars: { dir: String(storageDir || settings.storageDir), message: e.message } };
    }

    // Оценка места: по размеру предыдущего дампа, а при первом запуске — по размеру
    // базы. Сжатие обычно даёт кратный выигрыш, но закладываться на него нельзя.
    const need = Number(opts.previousSize) > 0 ? Number(opts.previousSize) * 1.5 : await dialect.databaseSize(sequelize);
    const free = dialect.freeSpace(storageDir);
    if (free > 0 && need > 0 && free < need) {
        return { ok: false, errorKey: 'backup_err_no_space', vars: { need: String(Math.round(need / 1048576)), free: String(Math.round(free / 1048576)) } };
    }

    return { ok: true, settings, storageDir, keyFingerprint: keyCheck.fingerprint, nonBlocking: nb.note };
}

/**
 * Создать резервную копию.
 *
 * @param {Object} opts
 * @param {Object} opts.sequelize
 * @param {Array<Object>} opts.models — СЛИТЫЕ определения (`collectMergedModelDefs`)
 * @param {Object} [opts.scope] — `{type:'full'}` | `{type:'organization', organizationId, organizationName}`
 * @param {Object} [opts.meta] — dbName/appVersion/frameworkVersion/dbVersion
 * @param {Function} [opts.onProgress]
 * @param {number} [opts.previousSize]
 * @returns {Promise<Object>} сведения о созданном файле
 */
async function createBackup(opts) {
    const { sequelize, models } = opts;
    const dumpScope = opts.scope || { type: 'full' };
    const onProgress = opts.onProgress || (() => {});
    const now = new Date();

    if (dumpScope.type === 'organization' && !dumpScope.organizationId) {
        const e = new Error('Не указана организация для выгрузки');
        e.errorKey = 'backup_err_scope_org_required';
        throw e;
    }

    const pre = await checkPreconditions(sequelize, opts);
    if (!pre.ok) {
        const e = new Error(`Предусловие не выполнено: ${pre.errorKey}`);
        e.errorKey = pre.errorKey;
        e.vars = pre.vars;
        throw e;
    }

    const meta = Object.assign({ dbName: (sequelize.config && sequelize.config.database) || '' }, opts.meta || {});
    let fileName = buildFileName(meta.dbName, dumpScope, meta.dbVersion, now);
    // Страховка поверх миллисекунд: существующую копию не затираем НИКОГДА. Потерять
    // готовый бэкап из-за совпадения имени — худший из возможных исходов.
    for (let i = 1; fs.existsSync(path.join(pre.storageDir, fileName)); i++) {
        fileName = buildFileName(meta.dbName, dumpScope, meta.dbVersion, now).replace(FILE_EXT, `-${i}${FILE_EXT}`);
        if (i > 100) throw new Error('Не удалось подобрать свободное имя файла резервной копии');
    }
    const filePath = path.join(pre.storageDir, fileName);
    // Пишем во временное имя и переименовываем в конце: прерванная выгрузка не должна
    // оставить в каталоге файл, выглядящий как готовая копия.
    const tmpPath = filePath + '.part';

    const transaction = await dialect.beginSnapshot(sequelize);
    let payload, tap, encryptor, result;
    try {
        const objects = await dump.compareWithDatabase(sequelize, models, transaction);
        if (objects.unknownObjects.length) {
            // Логическая выгрузка не видит того, чего нет в моделях. Тихий риск обязан
            // стать заметным — в журнал запуска и, через результат, в форму.
            log.warn(`[backup] В базе есть объекты вне моделей: ${objects.unknownObjects.join(', ')}`);
            onProgress(`ВНИМАНИЕ: объекты вне моделей: ${objects.unknownObjects.join(', ')}`);
        }

        payload = dump.createPayloadStream({
            sequelize, models, transaction, scope: dumpScope, meta, onProgress
        });

        for (const w of payload.stats.warnings) {
            log.warn(`[backup] ${w.kind}: ${w.table}`);
            onProgress(`ВНИМАНИЕ: таблица ${w.table} без реквизита доступа и вне excluded_tables`);
        }

        encryptor = new container.EncryptStream({
            publicKeyPem: pre.settings.publicKeyPem,
            header: {
                dbName: meta.dbName,
                createdAt: now.toISOString(),
                dumpFormat: dump.DUMP_FORMAT,
                appVersion: meta.appVersion || '',
                frameworkVersion: meta.frameworkVersion || '',
                dbVersion: meta.dbVersion || null,
                configHash: payload.stats.configHash,
                actualHash: meta.actualHash || '',
                sourceDialect: dialect.nameOf(sequelize),
                keyFingerprint: pre.keyFingerprint,
                scope: dumpScope
            }
        });
        tap = new TapStream();

        await pipeline(payload.stream, zlib.createGzip({ level: 6 }), encryptor, tap, fs.createWriteStream(tmpPath));

        result = {
            fileName, filePath,
            size: tap.size,
            sha256: tap.digest(),
            keyFingerprint: pre.keyFingerprint,
            configHash: payload.stats.configHash,
            totalRows: payload.stats.totalRows,
            tables: payload.stats.tables,
            byClass: payload.stats.byClass,
            warnings: payload.stats.warnings,
            unknownObjects: objects.unknownObjects,
            missingTables: objects.missingTables,
            scope: dumpScope,
            createdAt: now
        };
    } catch (e) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e2) { /* мусор важнее не потерять исходную ошибку */ }
        throw e;
    } finally {
        // Снимок только читал — фиксировать нечего; rollback дешевле и честнее.
        try { await transaction.rollback(); } catch (e) { /* мог закрыться сам */ }
    }

    fs.renameSync(tmpPath, filePath);
    log.info(`[backup] Создан ${fileName} (${result.totalRows} строк, ${Math.round(result.size / 1024)} КБ)`);
    return result;
}

/**
 * Выбрать лишние копии для удаления — ДВА независимых лимита (ТЗ §1).
 *
 * Раздельный подсчёт принципиален: ручную копию делают ровно перед рискованной
 * операцией, и она не должна вылететь из-за трёх ночных запусков.
 *
 * @param {Array<Object>} files — записи `backup_files` (нужны `triggeredBy`, `createdAt`, `UID`)
 * @param {Object} limits — `{ keepScheduled, keepManual }`
 * @returns {Array<Object>} что удалять
 */
function selectForPruning(files, limits) {
    const keep = {
        manual: Math.max(0, Number(limits.keepManual) || 0),
        schedule: Math.max(0, Number(limits.keepScheduled) || 0)
    };
    const groups = { manual: [], schedule: [] };
    for (const f of files || []) {
        const g = String(f.triggeredBy) === 'manual' ? 'manual' : 'schedule';
        groups[g].push(f);
    }
    const doomed = [];
    for (const g of Object.keys(groups)) {
        const sorted = groups[g].slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        doomed.push(...sorted.slice(keep[g]));
    }
    return doomed;
}

/**
 * Удалить файл копии с диска.
 *
 * Зовётся ТОЛЬКО после того, как новая копия успешно создана и проверена (ТЗ §1):
 * удалять старое до создания нового — значит на время операции остаться без копий.
 */
function deleteFile(storageDir, fileName) {
    const p = path.join(storageDir, fileName);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    log.info(`[backup] Удалена устаревшая копия ${fileName}`);
    return true;
}

module.exports = {
    createBackup, checkPreconditions, selectForPruning, deleteFile, buildFileName,
    settings: settingsStore, keys, container, dialect, dump, FILE_EXT
};
