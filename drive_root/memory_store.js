// Generic memory-backed store with optional Redis backing.
// API (async): set(namespace, key, value, opts), get(namespace,key), del(namespace,key), keys(namespace, prefix)
// Also provides sync helpers backed by in-memory cache: getSync, hasSync, debugKeysSync
//
// Память (ТЗ оптимизации, П1):
//   - 1.3: дочерний сервис-процесс и Redis по умолчанию ВЫКЛЮЧЕНЫ (на однопроцессном
//     деплое это чистый оверхед: второй Node + HTTP на каждый set/get). Включаются
//     явно: сервис — MEMORY_STORE_SERVICE=1, Redis — наличием REDIS_URL.
//   - 1.1/1.4: per-namespace TTL + max-size (LRU/FIFO) + фоновый sweeper. Конфиг
//     namespace'а задаётся через configureNamespace(ns,{ttl,max}); записи через set()
//     получают expires, get/getSync их соблюдают, sweeper подчищает протухшее.
//   - 1.2: класс BoundedTTLMap — Map-совместимая обёртка с TTL+max для локальных
//     кэшей (editSessions, sessionCache), чтобы не плодить отдельные механизмы.

const { randomBytes } = require('crypto');
let redisClient = null;
let useRedis = false;
const http = require('http');
const querystring = require('querystring');

// Local service host/port (service was added as memory_store_service.js)
const SERVICE_HOST = '127.0.0.1';
const SERVICE_PORT = process.env.MEMORY_STORE_PORT ? Number(process.env.MEMORY_STORE_PORT) : 40001;
// 1.3: сервис нужен только при кластере/нескольких воркерах. По умолчанию выключен —
// тогда checkServiceAvailable() мгновенно отдаёт false и set/get не делают HTTP.
const _serviceEnabled = process.env.MEMORY_STORE_SERVICE === '1';
let _serviceAvailableChecked = false;
let _serviceAvailable = false;

function callService(method, path, payload, timeout = 2000) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: SERVICE_HOST,
            port: SERVICE_PORT,
            path: path,
            method: method,
            headers: { 'Content-Type': 'application/json' },
            timeout: timeout
        };
        const req = http.request(opts, (res) => {
            let raw = '';
            res.on('data', (c) => raw += c);
            res.on('end', () => {
                if (!raw) return resolve(null);
                try { resolve(JSON.parse(raw)); } catch (e) { resolve(null); }
            });
        });
        req.on('error', (err) => reject(err));
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (payload) {
            try { req.write(JSON.stringify(payload)); } catch (e) {}
        }
        req.end();
    });
}

async function checkServiceAvailable() {
    // 1.3: короткое замыкание — если сервис не включён, не делаем ни одного HTTP-вызова.
    if (!_serviceEnabled) return false;
    if (_serviceAvailableChecked) return _serviceAvailable;
    _serviceAvailableChecked = true;
    try {
        const res = await callService('GET', '/health', null, 800);
        _serviceAvailable = !!(res && res.ok);
    } catch (e) { _serviceAvailable = false; }
    return _serviceAvailable;
}
let _serviceProcess = null;
const { spawn } = require('child_process');

// 1.3: Redis-подключение только при явно заданном REDIS_URL (раньше — безусловная
// попытка соединиться с localhost:6379 при каждом require, что на хостинге без Redis
// плодило ошибки и висящие сокеты).
if (process.env.REDIS_URL) {
    try {
        const { createClient } = require('redis');
        const redisUrl = process.env.REDIS_URL;
        redisClient = createClient({ url: redisUrl });
        redisClient.on('error', (err) => console.error('[memory_store] redis client error', err));
        redisClient.connect().then(() => {
            useRedis = true;
            console.log('[memory_store] connected to redis at', redisUrl);
        }).catch((e) => {
            console.warn('[memory_store] redis not available, using in-memory only');
            redisClient = null;
            useRedis = false;
        });
    } catch (e) {
        redisClient = null;
        useRedis = false;
    }
}

// In-memory storage: Map<namespace, Map<key, {value, created, modified, expires}>>
const MEM = new Map();

// Per-namespace TTL/max config: Map<ns, {ttl, max}> (ttl/max в мс / штуках; 0 = без лимита)
const _nsConfig = new Map();

function configureNamespace(ns, opts = {}) {
    if (!ns) return;
    _nsConfig.set(ns, { ttl: opts.ttl || 0, max: opts.max || 0 });
}

function _nsTtl(ns) {
    const c = _nsConfig.get(ns);
    return c && c.ttl ? c.ttl : 0;
}

function ensureNamespace(ns) {
    if (!MEM.has(ns)) MEM.set(ns, new Map());
    return MEM.get(ns);
}

function _enforceMax(ns, nsMap) {
    const c = _nsConfig.get(ns);
    if (!c || !c.max) return;
    // FIFO-вытеснение по порядку вставки (Map сохраняет порядок); на set существующий
    // ключ переставляется в конец → даёт recency-приближение к LRU.
    while (nsMap.size > c.max) {
        const oldest = nsMap.keys().next().value;
        if (oldest === undefined) break;
        nsMap.delete(oldest);
    }
}

// Единая точка записи в локальный MEM с учётом expires/LRU.
function _localSet(ns, key, value, opts = {}) {
    const nsMap = ensureNamespace(ns);
    if (nsMap.has(key)) nsMap.delete(key); // переставить в конец (recency)
    const ttl = (opts.ttl != null) ? opts.ttl : _nsTtl(ns);
    const now = Date.now();
    const stored = opts.clone ? JSON.parse(JSON.stringify(value)) : value;
    const entry = { value: stored, created: now, modified: now, expires: ttl ? now + ttl : 0 };
    nsMap.set(key, entry);
    _enforceMax(ns, nsMap);
    return entry;
}

// Вернуть живую запись (с проверкой expires) или null; протухшую удаляет.
function _getValidEntry(nsMap, key) {
    if (!nsMap || !nsMap.has(key)) return null;
    const e = nsMap.get(key);
    if (e.expires && Date.now() > e.expires) {
        nsMap.delete(key);
        return null;
    }
    return e;
}

function makeRedisKey(ns, key) {
    return `ms:${ns}:${key}`;
}

async function set(ns, key, value, opts = {}) {
    if (!ns) ns = '_default';
    if (!key) key = randomBytes(6).toString('hex');
    const entry = _localSet(ns, key, value, opts);
    if (useRedis && redisClient) {
        try { await redisClient.set(makeRedisKey(ns, key), JSON.stringify(entry)); } catch (e) {}
    }
    // try to replicate to local service (best-effort; no-op when service disabled)
    try {
        if (await checkServiceAvailable()) {
            callService('POST', '/set', { ns, key, value }).catch(() => {});
        }
    } catch (_) {}
    return key;
}

async function get(ns, key) {
    if (!ns) ns = '_default';
    if (!key) return null;
    const nsMap = MEM.get(ns);
    const local = _getValidEntry(nsMap, key);
    if (local) return local.value;
    // Try Redis first if configured
    if (useRedis && redisClient) {
        try {
            const raw = await redisClient.get(makeRedisKey(ns, key));
            if (raw) {
                try { const parsed = JSON.parse(raw); _localSet(ns, key, parsed.value); return parsed.value; } catch (e) { return null; }
            }
        } catch (e) {}
    }
    // If local service available, try to fetch and populate cache
    try {
        if (await checkServiceAvailable()) {
            const q = '/get?' + querystring.stringify({ ns: ns, key: key });
            const svc = await callService('GET', q, null, 1000);
            if (svc && svc.ok && svc.value !== undefined) {
                try { _localSet(ns, key, svc.value); } catch (e) {}
                return svc.value;
            }
        }
    } catch (e) {}
    return null;
}

function getSync(ns, key) {
    if (!ns) ns = '_default';
    if (!key) return null;
    const e = _getValidEntry(MEM.get(ns), key);
    return e ? e.value : null;
}

function hasSync(ns, key) {
    if (!ns) ns = '_default';
    return !!_getValidEntry(MEM.get(ns), key);
}

async function del(ns, key) {
    if (!ns) ns = '_default';
    const nsMap = MEM.get(ns);
    if (nsMap) nsMap.delete(key);
    if (useRedis && redisClient) {
        try { await redisClient.del(makeRedisKey(ns, key)); } catch (e) {}
    }
    try {
        if (await checkServiceAvailable()) {
            callService('POST', '/del', { ns, key }).catch(() => {});
        }
    } catch (_) {}
}

/**
 * Очистить пространство имён целиком (или ВЕСЬ store, если `ns` не задан).
 *
 * Нужно для события `onDatabaseReset`: store живёт в ОТДЕЛЬНОМ процессе и переживает
 * перезапуск сервера, унося сессии, роли и справочники прежней базы. Поэтому чистить
 * надо не только локальную копию, но и сервис, и Redis — иначе после подмены базы
 * первый же `get` вернёт данные, которых в базе больше нет.
 *
 * @param {string} [ns] — пространство имён; без него чистится всё
 * @param {Object} [opts] — `{ localOnly }`: не транслировать дальше. Обязателен, когда
 *   вызов пришёл ИЗ сервис-процесса: иначе он адресует запрос сам себе и зацикливается.
 */
async function clearNamespace(ns, opts = {}) {
    if (ns) MEM.delete(ns); else MEM.clear();
    if (opts.localOnly) return;

    if (useRedis && redisClient) {
        try {
            const pattern = ns ? `ms:${ns}:*` : 'ms:*';
            const found = await redisClient.keys(pattern);
            if (found && found.length) await redisClient.del(found);
        } catch (e) { /* Redis недоступен — локальная копия уже очищена */ }
    }
    try {
        if (await checkServiceAvailable()) {
            await callService('POST', '/clear', { ns: ns || '' }).catch(() => {});
        }
    } catch (_) {}
}

async function keys(ns, prefix) {
    if (!ns) ns = '_default';
    const nsMap = MEM.get(ns) || new Map();
    let arr = Array.from(nsMap.keys());
    if (prefix) arr = arr.filter(k => k.indexOf(prefix) === 0);
    // Also try Redis keys if available (async)
    if (useRedis && redisClient) {
        try {
            const pattern = `ms:${ns}:${prefix || '*'}*`;
            const found = await redisClient.keys(pattern);
            const trimmed = found.map(k => k.replace(`ms:${ns}:`, ''));
            // merge unique
            const set = new Set([...arr, ...trimmed]);
            return Array.from(set);
        } catch (e) {}
    }
    // Try service keys if available and merge
    try {
        if (await checkServiceAvailable()) {
            const q = '/keys?' + querystring.stringify({ ns: ns, prefix: prefix || '' });
            const svc = await callService('GET', q, null, 1200);
            if (svc && svc.ok && Array.isArray(svc.keys)) {
                const set = new Set([...arr, ...svc.keys]);
                return Array.from(set);
            }
        }
    } catch (e) {}
    return arr;
}

function debugKeysSync(ns) {
    if (!ns) ns = '_default';
    const nsMap = MEM.get(ns) || new Map();
    const keys = Array.from(nsMap.keys());
    return { count: keys.length, keys: keys.slice(0, 50) };
}

// ─── BoundedTTLMap: Map-совместимый кэш с TTL+max для локальных Map (1.2) ──────────
// Используется там, где исторически был new Map() без очистки (editSessions,
// sessionCache). API совместим с Map в части set/get/has/delete/size — менять
// вызывающий код не нужно. Авторегистрируется в общем sweeper'е.
const _boundedMaps = new Set();

class BoundedTTLMap {
    constructor(opts = {}) {
        this.ttl = opts.ttl || 0;
        this.max = opts.max || 0;
        this._m = new Map();
        _boundedMaps.add(this);
    }
    set(key, value) {
        if (this._m.has(key)) this._m.delete(key);
        this._m.set(key, { v: value, exp: this.ttl ? Date.now() + this.ttl : 0 });
        if (this.max) {
            while (this._m.size > this.max) {
                const oldest = this._m.keys().next().value;
                if (oldest === undefined) break;
                this._m.delete(oldest);
            }
        }
        return this;
    }
    get(key) {
        const e = this._m.get(key);
        if (!e) return undefined;
        if (e.exp && Date.now() > e.exp) { this._m.delete(key); return undefined; }
        return e.v;
    }
    has(key) {
        const e = this._m.get(key);
        if (!e) return false;
        if (e.exp && Date.now() > e.exp) { this._m.delete(key); return false; }
        return true;
    }
    delete(key) { return this._m.delete(key); }
    clear() { this._m.clear(); }
    get size() { return this._m.size; }
    sweep() {
        if (!this.ttl) return;
        const now = Date.now();
        for (const [k, e] of this._m) { if (e.exp && now > e.exp) this._m.delete(k); }
    }
}

// ─── Фоновый sweeper: чистит протухшие записи во всех namespace и BoundedTTLMap ──
function _sweep() {
    const now = Date.now();
    for (const nsMap of MEM.values()) {
        for (const [k, e] of nsMap) { if (e && e.expires && now > e.expires) nsMap.delete(k); }
    }
    for (const bm of _boundedMaps) { try { bm.sweep(); } catch (_) {} }
}
const _SWEEP_MS = process.env.MEMORY_STORE_SWEEP_MS ? Number(process.env.MEMORY_STORE_SWEEP_MS) : 300000;
const _sweepTimer = setInterval(_sweep, _SWEEP_MS);
if (_sweepTimer.unref) _sweepTimer.unref();

// ─── Дефолтные конфиги namespace'ов (1.1 datasets, 1.4 сессионные кэши) ──────────
configureNamespace('datasets', { ttl: 60 * 60 * 1000, max: 500 });       // 1.1: датасеты форм — 60 мин / 500
configureNamespace('session_users', { ttl: 24 * 60 * 60 * 1000, max: 5000 });   // 1.4
configureNamespace('session_context', { ttl: 24 * 60 * 60 * 1000, max: 5000 });  // 1.4
configureNamespace('user_roles', { ttl: 24 * 60 * 60 * 1000, max: 5000 });       // 1.4

module.exports = {
    set,
    get,
    del,
    clearNamespace,
    keys,
    getSync,
    hasSync,
    debugKeysSync,
    configureNamespace,
    BoundedTTLMap,
    _MEM: MEM,
    _useRedis: () => useRedis
};

// Start a background service process that exposes the store over HTTP.
// Returns the spawned ChildProcess instance.
function startServiceProcess(opts = {}) {
    if (_serviceProcess) return _serviceProcess;
    const port = opts.port || process.env.MEMORY_STORE_PORT || '40001';
    const node = process.execPath;
    const script = require('path').join(__dirname, 'memory_store_service.js');
    const env = Object.assign({}, process.env, { MEMORY_STORE_PORT: String(port) });
    const child = spawn(node, [script], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    _serviceProcess = child;
    child.on('exit', () => { _serviceProcess = null; });
    return child;
}

function stopServiceProcess() {
    if (_serviceProcess) {
        try { _serviceProcess.kill('SIGTERM'); } catch (e) {}
        _serviceProcess = null;
    }
}

module.exports.startServiceProcess = startServiceProcess;
module.exports.stopServiceProcess = stopServiceProcess;
