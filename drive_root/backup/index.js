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
 *   · в журнал `backup_files` не попадает — записи без файла там не нужны;
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
 * ПОДТВЕРЖДЁННОСТЬ (`acked`) — необязательное УСЛОВИЕ УДАЛЕНИЯ, а не третья группа.
 * При `pruneOnlyAcked` копия, которую внешнее хранилище ещё не забрало, из списка на
 * удаление исключается: сервер хранит последние копии, а долгий архив ведёт хранилище,
 * и удалять то, что до него не доехало, — значит терять поколение молча. Защита не
 * бессрочна: молчащее хранилище иначе забьёт диск, поэтому через `keepUnackedMaxDays`
 * копия прореживается на общих основаниях. Лимиты при этом НЕ пересчитываются —
 * защищённые копии просто не удаляются, и их накопление видно в панели состояния.
 *
 * @param {Array<Object>} files — записи `backup_files` (нужны `triggeredBy`, `createdAt`, `UID`)
 * @param {Object} limits — `{ keepScheduled, keepManual, pruneOnlyAcked, keepUnackedMaxDays }`
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
    if (!limits || !limits.pruneOnlyAcked) return doomed;

    const graceMs = Math.max(0, Number(limits.keepUnackedMaxDays) || 0) * 24 * 60 * 60 * 1000;
    return doomed.filter((f) => {
        if (f.acked) return true;
        const age = Date.now() - copyDate(f);
        if (age > graceMs) {
            log.warn(`[backup] Копия ${f.fileName} не подтверждена хранилищем, но старше `
                + `${limits.keepUnackedMaxDays} дн. — прореживается`);
            return true;
        }
        return false;
    });
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

// ── Сверка журнала копий с каталогом хранения ────────────────────────────────────
//
// Таблица `backup_files` едет ВНУТРИ дампа как обычные данные. Значит после полного
// восстановления она описывает каталог ЧУЖОГО момента: часть перечисленных файлов на
// этом диске уже удалена ретеншном, а реально лежащие копии — в том числе safety-копия,
// снятая прямо перед восстановлением, — в журнале отсутствуют.
//
// Последствия обе стороны имеют скверные: пользователь видит ссылки в никуда, а
// невидимая копия НИКОГДА не будет прорежена и останется на диске навсегда. Причём
// невидимой оказывается самая ценная копия на сервере — та, что страхует только что
// выполненную операцию.
//
// Поэтому сверка делает две вещи: помечает пропавшее и УСЫНОВЛЯЕТ найденное.
//
// `SYSTEM_SESSION_ID` здесь законен: это собственная служебная таблица механизма, а
// сверка идёт при старте и после восстановления, когда пользовательской сессии нет.

const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';

async function reconcileJournal() {
    const dbGateway = require('../dbGateway');
    const settings = settingsStore.read();
    const dir = settingsStore.ensureStorage(settings);

    const onDisk = new Set(
        fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(FILE_EXT))
    );

    const rows = await dbGateway.execute({
        operation: 'read', table: 'backup_files', where: {}, options: { raw: true },
        context: { sessionID: SYSTEM_SESSION_ID }
    }) || [];

    const known = new Set();
    let marked = 0, unmarked = 0, adopted = 0;

    for (const rec of rows) {
        known.add(rec.fileName);
        const exists = onDisk.has(rec.fileName);
        if (exists === !rec.missing) continue;                 // пометка и так верна
        await dbGateway.execute({
            operation: 'update', table: 'backup_files',
            where: { UID: rec.UID }, data: { missing: !exists },
            context: { sessionID: SYSTEM_SESSION_ID }
        });
        if (exists) unmarked++; else marked++;
    }

    for (const fileName of onDisk) {
        if (known.has(fileName)) continue;
        // Заголовок копии лежит открытым текстом — приватный ключ не нужен.
        let header = null;
        try { header = require('./restore').readHeader(path.join(dir, fileName)); }
        catch (e) { log.warn(`[backup] ${fileName} не опознан как копия: ${e.message}`); continue; }

        const st = fs.statSync(path.join(dir, fileName));
        const scope = header.scope || { type: 'full' };
        await dbGateway.execute({
            operation: 'create', table: 'backup_files',
            data: {
                organizationId: '',
                fileName,
                sizeBytes: st.size,
                // ДАТА КОПИИ — из её заголовка, а не момент усыновления. Иначе все
                // найденные файлы получают одну и ту же дату (секунду сверки), и любая
                // политика поколений — и здешний ретеншн, и «дед-отец-сын» во внешнем
                // хранилище — видит пачку копий одного мгновения вместо истории за
                // неделю. Поймано живым прогоном: пять копий за 07–10 августа приехали
                // с одинаковой датой.
                date: header.createdAt ? new Date(header.createdAt) : new Date(st.mtimeMs),
                // Контрольная сумма считается ОТДЕЛЬНО и после (`backfillChecksums`):
                // файл может весить гигабайты, а сверка идёт на старте сервера. Пустое
                // значение здесь — временное состояние, а не окончательное: внешнему
                // хранилищу сумма нужна, чтобы проверить целостность скачанного.
                sha256: '',
                keyFingerprint: header.keyFingerprint || '',
                configHash: header.configHash || '',
                dbVersion: Number(header.dbVersion) || 0,
                // Повод в заголовке не хранится. Считаем копию РУЧНОЙ: у ручных лимит
                // меньше, поэтому усыновлённые файлы не копятся, и ручная копия никогда
                // не вытесняется плановыми — то есть ошибка в эту сторону безопасна.
                triggeredBy: 'manual',
                scopeType: scope.type || 'full',
                scopeOrganizationId: scope.organizationId || '',
                scopeOrganizationName: scope.organizationName || '',
                rowsTotal: 0,
                verifyStatus: 'none',
                acked: false,
                missing: false
            },
            context: { sessionID: SYSTEM_SESSION_ID }
        });
        adopted++;
    }

    if (marked || unmarked || adopted) {
        log.info(`[backup] Журнал копий сверен с каталогом: помечено отсутствующими ${marked}, `
            + `восстановлено в наличии ${unmarked}, добавлено найденных ${adopted}`);
        try { require('../../apps/uniForm/server.js').notifyTableChange('backup_files', 'update', null); }
        catch (e) { /* оповещение не важнее сверки */ }
    }

    // Досчёт сумм — БЕЗ ожидания: сверка журнала идёт на старте сервера, и держать
    // старт на хэшировании гигабайтов нельзя. Ошибку глотаем в лог: не посчитанная
    // сумма хуже посчитанной, но не настолько, чтобы ронять запуск.
    backfillChecksums().catch(e => log.error(`[backup] Досчёт контрольных сумм: ${e.message}`));

    return { marked, unmarked, adopted };
}

/**
 * Досчитать SHA-256 у копий, попавших в журнал без неё (усыновлённые файлы).
 *
 * Зачем вообще. Сумма считается по ШИФРОТЕКСТУ и нужна внешнему хранилищу, чтобы
 * проверить скачанное, не имея приватного ключа. Пустая сумма в ответе `list` (§5)
 * оставляет хранилище перед выбором «поверить молча» или «отказаться забирать» — оба
 * плохи, поэтому сумма обязана появиться, пусть и не мгновенно.
 *
 * Строго по одному файлу за раз: это фоновая работа рядом с работающим сервером, и
 * параллельное хэширование нескольких гигабайтных файлов отняло бы диск у пользователей.
 */
async function backfillChecksums() {
    const dbGateway = require('../dbGateway');
    const dir = settingsStore.storagePath();

    const rows = await dbGateway.execute({
        operation: 'read', table: 'backup_files', where: {}, options: { raw: true },
        context: { sessionID: SYSTEM_SESSION_ID }
    }) || [];

    let done = 0;
    for (const rec of rows) {
        if (rec.sha256 || rec.missing) continue;
        const full = path.join(dir, rec.fileName);
        if (!fs.existsSync(full)) continue;

        let sha;
        try {
            sha = await new Promise((resolve, reject) => {
                const h = crypto.createHash('sha256');
                const s = fs.createReadStream(full);
                s.on('data', c => h.update(c));
                s.on('end', () => resolve(h.digest('hex')));
                s.on('error', reject);
            });
        } catch (e) {
            log.warn(`[backup] Сумма для ${rec.fileName} не посчитана: ${e.message}`);
            continue;
        }

        await dbGateway.execute({
            operation: 'update', table: 'backup_files',
            where: { UID: rec.UID }, data: { sha256: sha },
            context: { sessionID: SYSTEM_SESSION_ID }
        });
        done++;
    }

    if (done) {
        log.info(`[backup] Досчитаны контрольные суммы: ${done}`);
        try { require('../../apps/uniForm/server.js').notifyTableChange('backup_files', 'update', null); }
        catch (e) { /* оповещение не важнее результата */ }
    }
    return { done };
}

module.exports = {
    createBackup, createPlainStream, checkPreconditions, selectForPruning, deleteFile, buildFileName,
    markInUse, isInUse, reconcileJournal, backfillChecksums,
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
