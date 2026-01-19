// Simple HTTP JSON API wrapper around the memory store
// Exposes endpoints: POST /set, GET /get?ns=&key=, POST /del, GET /keys?ns=&prefix=

const http = require('http');
const url = require('url');
const memoryStore = require('./memory_store');

const DEFAULT_PORT = parseInt(process.env.MEMORY_STORE_PORT, 10) || 40001;
const HOST = '127.0.0.1';

let server = null;

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function handle(req, res) {
  const parsed = url.parse(req.url, true);
  if (req.method === 'GET' && parsed.pathname === '/get') {
    const ns = parsed.query.ns || '_default';
    const key = parsed.query.key;
    if (!key) return sendJSON(res, 400, { error: 'missing key' });
    try {
      const v = await memoryStore.get(ns, key);
      return sendJSON(res, 200, { ok: true, value: v });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e) });
    }
  }

  if (req.method === 'GET' && parsed.pathname === '/keys') {
    const ns = parsed.query.ns || '_default';
    const prefix = parsed.query.prefix || undefined;
    try {
      const k = await memoryStore.keys(ns, prefix);
      return sendJSON(res, 200, { ok: true, keys: k });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e) });
    }
  }

  if ((req.method === 'POST' && parsed.pathname === '/set') || (req.method === 'POST' && parsed.pathname === '/del')) {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', async () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const ns = payload.ns || '_default';
        if (parsed.pathname === '/set') {
          const key = payload.key || undefined;
          const value = payload.value;
          const id = await memoryStore.set(ns, key, value);
          return sendJSON(res, 200, { ok: true, key: id });
        } else {
          const key = payload.key;
          if (!key) return sendJSON(res, 400, { error: 'missing key' });
          await memoryStore.del(ns, key);
          return sendJSON(res, 200, { ok: true });
        }
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: String(e) });
      }
    });
    return;
  }

  // health
  if (req.method === 'GET' && parsed.pathname === '/health') {
    return sendJSON(res, 200, { ok: true });
  }

  sendJSON(res, 404, { error: 'not found' });
}

function start() {
  server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      try { sendJSON(res, 500, { ok: false, error: String(err) }); } catch (_) {}
    });
  });

  server.listen(DEFAULT_PORT, HOST, () => {
    console.log('[memory_store_service] listening on', HOST + ':' + DEFAULT_PORT);
  });

  function shutdown() {
    if (server) {
      try { server.close(() => { process.exit(0); }); } catch (e) { process.exit(0); }
    } else process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  start();
}

module.exports = { start };
