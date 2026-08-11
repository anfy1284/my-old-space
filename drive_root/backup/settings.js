'use strict';

/**
 * settings — настройки резервного копирования.
 *
 * ГДЕ ОНИ ЖИВУТ И ПОЧЕМУ ИМЕННО ТАМ. Решение владельца 11.08.2026: настройки — в БАЗЕ
 * (`backup_config`, реестр хранилищ — `backup_api_clients`), а не в файле, как было по
 * ТЗ §2.1. Прежнее обоснование защищало от того, что восстановление годичного дампа
 * откатит настройки к прежнему состоянию, — но защищало ценой худшего: файл в корне
 * проекта живёт внутри контейнера и уничтожается на каждом деплое вместе с ключом
 * шифрования и реестром хранилищ. «Сколько копий хранить» — это ПОЛИТИКА владельца, а
 * не факт об этой машине, и терять её при развёртывании нечем оправдать.
 *
 * От отката дампом теперь защищает не место хранения, а механизм системных данных
 * (`systemData.js`): обе таблицы помечены типом `backup_settings` и при полном
 * восстановлении по умолчанию остаются текущими.
 *
 * ЧТО ВСЁ-ТАКИ НЕ В БАЗЕ. Каталог хранения копий. Он нужен ровно тогда, когда базы
 * НЕТ: страница обслуживания отдаёт из него файл во время подмены схем
 * (`maintenanceServer.js`), туда же пишет аварийный журнал (`audit.js`), оттуда читает
 * восстановление. Реквизит, который требуется в момент недоступности базы, в базе
 * бесполезен именно тогда, когда он нужен. Поэтому каталог задаётся переменной
 * окружения `BACKUP_STORAGE_DIR` либо берётся умолчанием внутри каталога состояния.
 *
 * ПОЧЕМУ ЧТЕНИЕ ОСТАЛОСЬ СИНХРОННЫМ. `read()` зовут из синхронного кода — в том числе
 * из проверки подписи внешнего хранилища на каждом запросе. Перевод на async растащил
 * бы обещание по трём десяткам мест, включая сервер обслуживания, который обязан
 * работать без базы. Поэтому авторитет — база, а в памяти живёт кэш: он наполняется
 * `load()` при старте и после каждой записи. Данных здесь единицы строк, меняются они
 * раз в месяц — цена кэша нулевая, а свойство «читать можно откуда угодно» сохраняется.
 *
 * НО ПРОГРЕВ ПРИ СТАРТЕ — НЕ ГАРАНТИЯ. Он выполняется в отложенном обработчике, и всё,
 * что успело спросить настройки раньше, получало умолчания: форма показывала пустую
 * таблицу внешних хранилищ, а вход хранилища в первые секунды отвергал исправный ключ.
 * Поэтому асинхронные потребители зовут `ensureLoaded()` и не полагаются на порядок
 * запуска; `read()` остаётся для тех, кто ждать не может.
 */

const fs = require('fs');
const path = require('path');
const log = require('../log');
const stateDir = require('../stateDir');

/** Прежний файл настроек. Существует только ради однократного переноса в базу. */
const LEGACY_FILE_NAME = 'backupSettings.json';

const CONFIG_TABLE = 'backup_config';
const CLIENTS_TABLE = 'backup_api_clients';

/** Единственная строка настроек инсталляции. */
const CONFIG_UID = '000000000-backupcfg-0001';

const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';

/**
 * Значения по умолчанию. Публичного ключа среди них нет намеренно: инсталляция без
 * ключа не работает, и подставлять сюда что-либо значило бы делать вид, что работает.
 */
const DEFAULTS = {
    storageDir: 'backups',          // относительный путь разрешается от каталога состояния
    keepScheduled: 7,
    keepManual: 3,
    publicKeyPem: '',
    keyFingerprint: '',
    apiClients: []
};

let _cache = null;                  // { keepScheduled, keepManual, publicKeyPem, keyFingerprint, apiClients }
let _warnedNotLoaded = false;
let _loading = null;                // промис незавершённой загрузки (см. ensureLoaded)

function gateway() {
    return require('../dbGateway');
}

/** Контекст служебных обращений: собственные таблицы механизма, живой сессии нет. */
function sysContext() {
    return { sessionID: SYSTEM_SESSION_ID };
}

// ── Каталог хранения (вне базы) ─────────────────────────────────────────────────

/**
 * Каталог копий.
 *
 * Абсолютный путь из `BACKUP_STORAGE_DIR` берётся как есть — им указывают на том или
 * сетевой каталог. Относительный разрешается от каталога состояния, а не от корня
 * проекта: файлы копий — состояние ровно в той же мере, что и всё остальное там.
 */
function storagePath() {
    const dir = String(process.env.BACKUP_STORAGE_DIR || DEFAULTS.storageDir).trim() || DEFAULTS.storageDir;
    return path.isAbsolute(dir) ? dir : path.join(stateDir.dir(), dir);
}

/**
 * Создать каталог хранения, если его нет.
 * @returns {string} абсолютный путь
 */
function ensureStorage() {
    const dir = storagePath();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log.info(`[backup] Создан каталог хранения: ${dir}`);
    }
    return dir;
}

// ── Чтение ──────────────────────────────────────────────────────────────────────

/**
 * Текущие настройки. СИНХРОННО, из кэша.
 *
 * Кэш не наполнен — возвращаются умолчания, и об этом сообщается ОДИН раз. Молчать
 * нельзя: работа на умолчаниях означает «копии не шифруются, потому что ключа нет», и
 * причина должна быть видна в журнале, а не выясняться по последствиям.
 *
 * @returns {Object}
 */
function read() {
    if (!_cache) {
        if (!_warnedNotLoaded) {
            _warnedNotLoaded = true;
            log.warn('[backup] Настройки ещё не загружены из базы — временно действуют умолчания. '
                + 'Ожидался вызов settings.load() при старте механизма.');
        }
        return Object.assign({}, DEFAULTS, { storageDir: storagePath() });
    }
    return Object.assign({}, DEFAULTS, _cache, { storageDir: storagePath() });
}

/** Загружены ли настройки из базы (для диагностики). */
function isLoaded() {
    return !!_cache;
}

/**
 * Гарантировать, что кэш наполнен, и только потом отдавать управление.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ `load()`. Наполнение кэша при старте — это ПРОГРЕВ, а не гарантия:
 * оно происходит в отложенном обработчике, и всё, что успело спросить настройки раньше,
 * получало умолчания. Симптомы у этого разные и одинаково молчаливые: форма показывала
 * пустую таблицу внешних хранилищ, а проверка подписи в первые секунды после старта
 * отвергала законный запрос как «ключ неизвестен». Зависимость от того, успел ли
 * сработать таймер, чинится не ожиданием, а тем, чтобы её не было.
 *
 * Поэтому асинхронные потребители (загрузка формы, вход внешнего хранилища) зовут
 * `ensureLoaded()` и не полагаются на порядок запуска. Синхронный `read()` остаётся как
 * есть — он нужен там, где ждать нельзя, и работает поверх уже прогретого кэша.
 *
 * Параллельные вызовы разделяют ОДНУ загрузку: без этого первый же запрос после старта
 * (форма + опрос хранилища одновременно) порождал бы две гонящиеся записи в одну строку.
 *
 * @returns {Promise<Object>} актуальные настройки
 */
async function ensureLoaded() {
    if (_cache) return read();
    if (!_loading) {
        _loading = load().finally(() => { _loading = null; });
    }
    try {
        return await _loading;
    } catch (e) {
        // Отдаём умолчания, но НЕ молча: без ключа копирование всё равно не пойдёт, и
        // причина должна быть видна здесь, а не через сутки по несделанной копии.
        log.error(`[backup] Настройки не загружены из базы: ${e.message}`);
        return read();
    }
}

// ── Загрузка и запись ───────────────────────────────────────────────────────────

/**
 * Загрузить настройки из базы в кэш. Зовётся при старте механизма и после записи.
 *
 * Строки настроек нет — она создаётся с умолчаниями: инсталляция должна иметь
 * настройки с первого запуска, а не с первого сохранения формы.
 *
 * @returns {Promise<Object>} актуальные настройки
 */
async function load() {
    const db = gateway();
    const context = sysContext();

    let rows = await db.execute({
        operation: 'read', table: CONFIG_TABLE,
        where: { UID: CONFIG_UID }, options: { raw: true }, context
    }) || [];

    if (!rows.length) {
        const imported = await importLegacyFile();
        await db.execute({
            operation: 'create', table: CONFIG_TABLE, context,
            data: Object.assign({
                UID: CONFIG_UID,
                organizationId: null,
                keepScheduled: DEFAULTS.keepScheduled,
                keepManual: DEFAULTS.keepManual,
                publicKeyPem: '',
                keyFingerprint: ''
            }, imported.config)
        });
        for (const c of imported.clients) {
            await db.execute({ operation: 'create', table: CLIENTS_TABLE, context, data: c });
        }
        rows = await db.execute({
            operation: 'read', table: CONFIG_TABLE,
            where: { UID: CONFIG_UID }, options: { raw: true }, context
        }) || [];
    }

    const cfg = rows[0] || {};
    const clients = await db.execute({
        operation: 'read', table: CLIENTS_TABLE,
        where: {}, options: { raw: true }, context
    }) || [];

    _cache = {
        keepScheduled: Number(cfg.keepScheduled) || DEFAULTS.keepScheduled,
        keepManual: Number(cfg.keepManual) || DEFAULTS.keepManual,
        publicKeyPem: cfg.publicKeyPem || '',
        keyFingerprint: cfg.keyFingerprint || '',
        apiClients: clients.map(c => ({
            id: c.UID,
            name: c.name || '',
            publicKeyPem: c.publicKeyPem || '',
            fingerprint: c.fingerprint || '',
            algorithm: c.algorithm || 'ed25519',
            disabled: !!c.disabled,
            lastSeenAt: c.lastSeenAt || '',
            lastSeenIp: c.lastSeenIp || ''
        }))
    };
    return read();
}

/**
 * Записать настройки (только поля `backup_config`) и обновить кэш.
 *
 * Реестр хранилищ правится через `apiAuth`, а не отсюда: у него своя таблица и свои
 * правила (повторная регистрация того же ключа — включение, а не второй клиент).
 *
 * @param {Object} patch
 * @returns {Promise<Object>} итоговые настройки
 */
async function write(patch) {
    const data = {};
    for (const k of ['keepScheduled', 'keepManual', 'publicKeyPem', 'keyFingerprint']) {
        if (patch && patch[k] !== undefined) data[k] = patch[k];
    }
    if (!Object.keys(data).length) return read();

    if (!_cache) await load();                   // строка обязана существовать до update
    await gateway().execute({
        operation: 'update', table: CONFIG_TABLE,
        where: { UID: CONFIG_UID }, data, context: sysContext()
    });
    return await load();
}

// ── Однократный перенос из прежнего файла ───────────────────────────────────────

/**
 * Прочитать `backupSettings.json`, если он остался от прежней схемы хранения.
 *
 * Файл не удаляется, а переименовывается: перенос ключа не должен быть операцией,
 * после которой нечего откатывать. Читается он ровно один раз — при создании строки
 * настроек, то есть на первом запуске после обновления.
 *
 * @returns {Promise<{config: Object, clients: Array<Object>}>}
 */
async function importLegacyFile() {
    const empty = { config: {}, clients: [] };
    const p = path.join(stateDir.dir(), LEGACY_FILE_NAME);
    if (!fs.existsSync(p)) return empty;

    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    } catch (e) {
        // Битый файл — не повод молча начать с умолчаний: в нём мог быть действующий
        // ключ, и «настройки по умолчанию» тихо остановили бы копирование.
        log.error(`[backup] Прежний файл настроек ${LEGACY_FILE_NAME} повреждён (${e.message}) — `
            + 'перенос не выполнен, настройки создаются с умолчаниями. Файл оставлен на месте.');
        return empty;
    }

    const config = {};
    if (raw.keepScheduled !== undefined) config.keepScheduled = Math.max(1, Number(raw.keepScheduled) || 1);
    if (raw.keepManual !== undefined) config.keepManual = Math.max(1, Number(raw.keepManual) || 1);
    if (raw.publicKeyPem) config.publicKeyPem = String(raw.publicKeyPem);
    if (raw.keyFingerprint) config.keyFingerprint = String(raw.keyFingerprint);

    const clients = (Array.isArray(raw.apiClients) ? raw.apiClients : []).map(c => ({
        organizationId: null,
        name: c.name || '',
        publicKeyPem: c.publicKeyPem || '',
        fingerprint: c.fingerprint || '',
        algorithm: c.algorithm || 'ed25519',
        disabled: !!c.disabled,
        lastSeenAt: c.lastSeenAt || null,
        lastSeenIp: c.lastSeenIp || ''
    })).filter(c => c.fingerprint && c.publicKeyPem);

    try {
        fs.renameSync(p, `${p}.migrated`);
    } catch (e) {
        log.warn(`[backup] ${LEGACY_FILE_NAME} перенесён в базу, но не переименован: ${e.message}`);
    }

    log.info(`[backup] Настройки перенесены из ${LEGACY_FILE_NAME} в базу: `
        + `ключ ${config.publicKeyPem ? 'есть' : 'отсутствует'}, хранилищ ${clients.length}`);
    if (raw.storageDir && raw.storageDir !== DEFAULTS.storageDir) {
        // Каталог в базу не переносится (он нужен без базы), поэтому прежнее значение
        // надо назвать вслух — иначе копии молча начнут ложиться в другое место.
        log.warn(`[backup] В прежнем файле каталог хранения был «${raw.storageDir}». `
            + `Теперь он задаётся переменной BACKUP_STORAGE_DIR; действует ${storagePath()}`);
    }
    return { config, clients };
}

module.exports = {
    read, load, ensureLoaded, write, isLoaded,
    storagePath, ensureStorage,
    DEFAULTS, CONFIG_TABLE, CLIENTS_TABLE, CONFIG_UID, LEGACY_FILE_NAME
};
