// Generic memory-backed store with optional Redis backing.
// API (async): set(namespace, key, value), get(namespace,key), del(namespace,key), keys(namespace, prefix)
// Also provides sync helpers backed by in-memory cache: getSync, hasSync, debugKeysSync

const { randomBytes } = require('crypto');
let redisClient = null;
let useRedis = false;
const http = require('http');
const querystring = require('querystring');

// Local service host/port (service was added as memory_store_service.js)
const SERVICE_HOST = '127.0.0.1';
const SERVICE_PORT = process.env.MEMORY_STORE_PORT ? Number(process.env.MEMORY_STORE_PORT) : 40001;
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

try {
    const { createClient } = require('redis');
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
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

// In-memory storage: Map<namespace, Map<key, {value, created, modified}>>
const MEM = new Map();

function ensureNamespace(ns) {
    if (!MEM.has(ns)) MEM.set(ns, new Map());
    return MEM.get(ns);
}

function makeRedisKey(ns, key) {
    return `ms:${ns}:${key}`;
}

async function set(ns, key, value) {
    if (!ns) ns = '_default';
    if (!key) key = randomBytes(6).toString('hex');
    const entry = { value: value, created: Date.now(), modified: Date.now() };
    ensureNamespace(ns).set(key, entry);
    if (useRedis && redisClient) {
        try { await redisClient.set(makeRedisKey(ns, key), JSON.stringify(entry)); } catch (e) {}
    }
    // try to replicate to local service (best-effort)
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
    if (nsMap && nsMap.has(key)) return nsMap.get(key).value;
    // Try Redis first if configured
    if (useRedis && redisClient) {
        try {
            const raw = await redisClient.get(makeRedisKey(ns, key));
            if (raw) {
                try { const parsed = JSON.parse(raw); ensureNamespace(ns).set(key, parsed); return parsed.value; } catch (e) { return null; }
            }
        } catch (e) {}
    }
    // If local service available, try to fetch and populate cache
    try {
        if (await checkServiceAvailable()) {
            const q = '/get?' + querystring.stringify({ ns: ns, key: key });
            const svc = await callService('GET', q, null, 1000);
            if (svc && svc.ok && svc.value !== undefined) {
                try { ensureNamespace(ns).set(key, { value: svc.value, created: Date.now(), modified: Date.now() }); } catch (e) {}
                return svc.value;
            }
        }
    } catch (e) {}
    return null;
}

function getSync(ns, key) {
    if (!ns) ns = '_default';
    if (!key) return null;
    const nsMap = MEM.get(ns);
    if (nsMap && nsMap.has(key)) return nsMap.get(key).value;
    return null;
}

function hasSync(ns, key) {
    if (!ns) ns = '_default';
    const nsMap = MEM.get(ns);
    return !!(nsMap && nsMap.has(key));
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

module.exports = {
    set,
    get,
    del,
    keys,
    getSync,
    hasSync,
    debugKeysSync,
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
