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
const catalog = require('./catalog');
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

        // Считаем ДО записи заголовка: он уходит в файл первым, а `stats.totalRows`
        // набирается по ходу выгрузки и в этот момент равен нулю (именно поэтому у всех
        // прежних копий в заголовке стоял ноль).
        const rowsPlanned = await payload.countPlannedRows();
        onProgress(`Строк к выгрузке: ${rowsPlanned}`);

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
                scope: dumpScope,
                // Ниже — то, что прежде лежало в строке журнала `backup_files`.
                // Журнала больше нет (источник истины — каталог), а заголовок лежит
                // открытым текстом и читается без приватного ключа, поэтому место ему
                // здесь. Единственное, что в заголовок положить нельзя, — sha256: он
                // считается по готовому файлу ВМЕСТЕ с заголовком (см. спутник).
                triggeredBy: String(opts.triggeredBy || 'manual'),
                title: String(opts.title || ''),
                rowsTotal: rowsPlanned
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
    // Спутник пишется ПОСЛЕ переименования: файл-спутник без копии бессмысленен, а
    // копия без спутника — работоспособна (см. catalog.js, спутник необязателен).
    catalog.writeSidecar(filePath, { sha256: result.sha256, size: result.size });
    log.info(`[backup] Создан ${fileName} (${result.totalRows} строк, ${Math.round(result.size / 1024)} КБ)`);
    return result;
}

/**
 * Незашифрованная копия ПОТОКОМ, без записи на диск сервера (решение владельца 2026-08-07).
 *
 * Зачем режим существует — см. `container.js` (ALG_NONE). Здесь важно ДРУГОЕ: почему он
 * устроен потоком, а не «создать файл и дать ссылку».
 *
 * Незашифрованный дамп содержит персональные данные всех клиентов. Пока он лежит в
 * каталоге копий, он уязвим ровно там, где аргумент «за годы хранения ключ потеряется»
 * не работает: на сервере ключ нужен на минуты. Поэтому такой копии на сервере не
 * возникает вовсе — байты идут из снимка сразу в HTTP-ответ. Нет объекта — нет риска;
 * это сильнее любой пометки «осторожно, не шифровано».
 *
 * Отсюда же ограничения, которые НЕ обсуждаются:
 *   · только ручной запуск (расписание такого не делает никогда);
 *   · в каталоге не появляется — файла на сервере нет вовсе;
 *   · внешнему хранилищу не отдаётся.
 *
 * Цена: выгрузка идёт в главном процессе, а не в воркере (решение 0.0.2 про изоляцию
 * касается ПЛАНОВОЙ выгрузки в файл). Обмен осознанный: поток отдаётся непрерывно,
 * поэтому таймаутов прокси не возникает, а операция редкая и ручная.
 *
 * @param {Object} opts — `{ sequelize, models, scope, meta, onProgress }`
 * @returns {Promise<{stream: Readable, fileName: string, stats: Object, finish: Function}>}
 */
async function createPlainStream(opts) {
    const { sequelize, models } = opts;
    const dumpScope = opts.scope || { type: 'full' };
    const now = new Date();
    const meta = Object.assign({ dbName: (sequelize.config && sequelize.config.database) || '' }, opts.meta || {});

    const nb = await dialect.checkNonBlocking(sequelize);
    if (!nb.ok) {
        const e = new Error(`Предусловие не выполнено: ${nb.errorKey}`);
        e.errorKey = nb.errorKey; e.vars = nb.vars;
        throw e;
    }

    // Имя говорит о том, что файл НЕ зашифрован, прямо в себе: он уедет на чужую машину
    // и будет там лежать годами, а к тому времени объяснять будет некому.
    const fileName = buildFileName(meta.dbName, dumpScope, meta.dbVersion, now)
        .replace(FILE_EXT, `-PLAIN${FILE_EXT}`);

    const transaction = await dialect.beginSnapshot(sequelize);
    let payload, tap;
    try {
        payload = dump.createPayloadStream({
            sequelize, models, transaction, scope: dumpScope, meta,
            onProgress: opts.onProgress || (() => {})
        });
        tap = new TapStream();

        const encryptor = new container.EncryptStream({
            publicKeyPem: null,                       // явный выбор режима без шифрования
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
                keyFingerprint: '',
                scope: dumpScope
            }
        });

        const { pipeline } = require('stream');
        const { PassThrough } = require('stream');
        const out = new PassThrough();
        pipeline(payload.stream, zlib.createGzip({ level: 6 }), encryptor, tap, out, (err) => {
            // Снимок закрывается ВСЕГДА: незакрытая read-транзакция в Postgres держит
            // очистку мёртвых версий строк, а оборвать скачивание пользователь может
            // в любой момент.
            transaction.rollback().catch(() => {});
            if (err) out.destroy(err);
        });

        return { stream: out, fileName, stats: payload.stats, tap };
    } catch (e) {
        try { await transaction.rollback(); } catch (e2) {}
        throw e;
    }
}

/**
 * Выбрать лишние копии для удаления — ДВА независимых лимита (ТЗ §1).
 *
 * Раздельный подсчёт принципиален: ручную копию делают ровно перед рискованной
 * операцией, и она не должна вылететь из-за трёх ночных запусков.
 *
 * ПОДТВЕРЖДЁННОСТИ ЗДЕСЬ БОЛЬШЕ НЕТ. Прежде копия, которую хранилище ещё не забрало,
 * могла исключаться из удаления (`pruneOnlyAcked`). Решение владельца 11.08.2026 сняло
 * это вместе с самим понятием подтверждения: сервер — перевалочный буфер, он намеренно
 * не следит за тем, что уехало, а каталог всё равно уничтожается развёртыванием.
 * Обещание беречь неподтверждённое было невыполнимым, и держать его в коде значило бы
 * успокаивать администратора несуществующей гарантией.
 *
 * @param {Array<Object>} files — копии (нужны `triggeredBy` и дата)
 * @param {Object} limits — `{ keepScheduled, keepManual }`
 * @returns {Array<Object>} что удалять
 */
/**
 * КОГДА СНЯТА КОПИЯ — реквизит `date` документа, а не `createdAt` строки журнала.
 *
 * Для копии, снятой этим сервером, они совпадают. Расходятся у найденных на диске
 * (`reconcileJournal`): строка появляется в момент сверки, а копии может быть неделя.
 * Ретеншн обязан хранить свежие КОПИИ, а не свежие записи о них, иначе пачка
 * усыновлённых файлов вытеснит настоящие свежие.
 */
function copyDate(f) {
    const d = new Date(f && (f.date || f.createdAt) || 0).getTime();
    // Пустая дата (`0001-01-01`) значит «реквизит не заполнен» — откатываемся к строке.
    return (!d || d < 0) ? new Date((f && f.createdAt) || 0).getTime() : d;
}

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
        const sorted = groups[g].slice().sort((a, b) => copyDate(b) - copyDate(a));
        doomed.push(...sorted.slice(keep[g]));
    }

    // Защиты «не прореживать неподтверждённые» здесь больше НЕТ, и это следствие решения
    // владельца 11.08.2026: сервер — перевалочный буфер, а не хранилище, и он намеренно
    // не отслеживает, какой файл уехал. Настройка, обещавшая беречь неподтверждённые
    // копии, обещала невыполнимое: каталог всё равно уничтожается развёртыванием. Раз
    // защищать нечего, честнее не делать вид, что защищаем.
    //
    // Цена решения названа прямо: прореживание может удалить копию, которую хранилище не
    // успело забрать. Отсюда требование к лимитам — брать их с запасом на простой
    // хранилища, и к самому хранилищу — опрашивать сервер минутами, а не часами.
    return doomed;
}

// ── Защита файла, с которым сейчас работают ─────────────────────────────────────
//
// Восстановление читает файл копии, а обязательная safety-выгрузка перед ним создаёт
// НОВУЮ копию и тем самым запускает прореживание — которое способно удалить как раз
// тот файл, из которого мы восстанавливаемся (ручных копий хранится три, и каждое
// восстановление добавляет одну). Поймано живым прогоном: восстановление упало с
// ENOENT на собственном источнике.
//
// Отметка — ФАЙЛОМ рядом с копией, а не флагом в памяти: прореживание выполняется в
// ДРУГОМ процессе (воркере планировщика), и переменная процесса до него не доедет.
// Брошенная после аварии отметка не блокирует уборку вечно — у неё есть срок годности.

const IN_USE_SUFFIX = '.inuse';
const IN_USE_TTL_MS = 6 * 60 * 60 * 1000;

/** Пометить файл используемым. Возвращает функцию снятия отметки. */
function markInUse(storageDir, fileName) {
    const marker = path.join(storageDir, fileName + IN_USE_SUFFIX);
    try { fs.writeFileSync(marker, String(Date.now()), 'utf8'); } catch (e) {
        log.warn(`[backup] Не удалось пометить ${fileName} используемым: ${e.message}`);
    }
    return () => { try { if (fs.existsSync(marker)) fs.unlinkSync(marker); } catch (e) {} };
}

/** Занят ли файл сейчас (с учётом срока годности отметки). */
function isInUse(storageDir, fileName) {
    const marker = path.join(storageDir, fileName + IN_USE_SUFFIX);
    if (!fs.existsSync(marker)) return false;
    try {
        const ts = Number(fs.readFileSync(marker, 'utf8')) || 0;
        if (Date.now() - ts > IN_USE_TTL_MS) { fs.unlinkSync(marker); return false; }
    } catch (e) { /* нечитаемая отметка — считаем занятым, это безопаснее */ }
    return true;
}

/**
 * Удалить файл копии с диска.
 *
 * Зовётся ТОЛЬКО после того, как новая копия успешно создана и проверена (ТЗ §1):
 * удалять старое до создания нового — значит на время операции остаться без копий.
 * Файл, с которым сейчас работают (восстановление, скачивание), не удаляется —
 * проверка стоит ЗДЕСЬ, в единственной точке удаления, а не у вызывающих.
 */
function deleteFile(storageDir, fileName) {
    const p = path.join(storageDir, fileName);
    if (!fs.existsSync(p)) return false;
    if (isInUse(storageDir, fileName)) {
        log.info(`[backup] Копия ${fileName} сейчас используется — удаление отложено`);
        return false;
    }
    fs.unlinkSync(p);
    log.info(`[backup] Удалена устаревшая копия ${fileName}`);
    return true;
}

// ── Сверки журнала с каталогом БОЛЬШЕ НЕТ ───────────────────────────────────────
//
// `reconcileJournal()` и `backfillChecksums()` удалены вместе с таблицей `backup_files`
// (решение владельца 11.08.2026). Обе существовали ровно ради одного: сводить два
// источника истины, которые неизбежно расходились, — каталог на диске и записи в базе.
// Источник теперь один, каталог (`catalog.js`), поэтому сводить нечего: файла нет —
// его нет и в списке; файл появился — он в списке. Контрольная сумма считается при
// создании копии и кладётся в спутник, поэтому досчитывать её задним числом тоже не
// требуется.
//
// Вопрос «отработала ли ночная выгрузка и с каким результатом» отвечает
// `scheduler_runs`: он в базе, деплой переживает и от каталога не зависит.


// Стратегии системных данных регистрируются не внутри `systemData` (тот обязан
// оставаться механизмом, не знающим, какие типы бывают) и не здесь: восстановление
// исполняется в дочернем процессе, который `index.js` не грузит, и регистрация в нём
// не отработала бы. Реестр собирает `systemDataStrategies`, его берут ОБА процесса.
const systemData = require('./systemDataStrategies');

module.exports = {
    createBackup, createPlainStream, checkPreconditions, selectForPruning, deleteFile, buildFileName,
    markInUse, isInUse, systemData, catalog,
    settings: settingsStore, keys, container, dialect, dump, FILE_EXT,
    // Вход внешнего хранилища по подписи (ТЗ §5). Отдельный модуль, а не часть `keys`:
    // это другая пара ключей с другим сроком жизни и другим местом хранения.
    get apiAuth() { return require('./apiAuth'); },
    // Восстановление одной организации (ТЗ §6.6) — отдельная процедура, а не режим
    // выгрузки; подключается лениво, чтобы выгрузка не тянула его код.
    get restore() { return require('./restore'); },
    // Полное восстановление (ТЗ §6.1–§6.5) — третья самостоятельная процедура:
    // у неё другие гарантии (живая база не разрушается), другой режим работы сервера
    // (обслуживание) и другой исполнитель (дочерний процесс).
    get restoreFull() { return require('./restoreFull'); },
    get restoreFullRunner() { return require('./restoreFullRunner'); }
};
