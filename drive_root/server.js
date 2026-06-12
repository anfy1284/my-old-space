// Get getContentType from global context
const { getContentType } = require('./globalServerContext');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const qs = require('querystring');

// Sessions and clients are now handled via sessionManager
const { getOrCreateSession } = require('./db/sessionManager');
const perfMetrics = require('./perfMetrics');
const httpCompression = require('./httpCompression');
const httpCache = require('./httpCache');
const log = require('./log');

// Universal function to find and run init.js
function runInitIfExists(dir) {
    const initPath = path.join(dir, 'init.js');
    if (fs.existsSync(initPath)) {
        try {
            require(initPath);
        } catch (e) {
            console.error(`[init] Error running ${initPath}:`, e);
        }
    }
}

// App settings (directory and alias taken from config)

let config;
let appAlias;
let appDir;
let appHandler;
try {
    // 1. Initialize base level
    runInitIfExists(path.join(__dirname));

    config = require(path.join(__dirname, '..', 'server.config.json'));
    appAlias = config.appAlias;
    appDir = path.join(__dirname, '..', config.appDir);

    // 2. Initialize application level
    runInitIfExists(appDir);

    appHandler = require(path.join(appDir, config.appHandler));

    // 3. Initialize all applications from apps.json (if present)
    const localAppsJsonPath = path.join(appDir, 'apps.json');
    const rootAppsJsonPath = path.join(__dirname, '..', 'apps.json');

    let appsBaseDir = path.join(__dirname, '..', 'apps');
    let allApps = [];

    const loadAppsFromPath = (p) => {
        if (fs.existsSync(p)) {
            try {
                const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
                if (Array.isArray(cfg.apps)) {
                    cfg.apps.forEach(app => {
                        if (app.name && !allApps.find(a => a.name === app.name)) {
                            allApps.push(app);
                        }
                    });
                }
            } catch (err) {
                console.error(`[drive_root] Error reading apps.json at ${p}:`, err.message);
            }
        }
    };

    loadAppsFromPath(localAppsJsonPath);
    loadAppsFromPath(rootAppsJsonPath);

    for (const app of allApps) {
        runInitIfExists(path.join(appsBaseDir, app.name));
    }
} catch (e) {
    console.error('ERROR loading configuration or application handler:', e.message);
    console.error('Expected server.config.json like:');
    console.error(JSON.stringify({ appDir: 'drive_forms', appAlias: 'app', appIndexPage: 'index.html', appHandler: 'server.js' }, null, 2));
    process.exit(1);
}

// 2.3: appsBasePath (override "path" из apps.json) резолвится ОДИН раз при старте,
// а не парсится на каждый запрос статики /apps/.../resources/public (раньше checkPath
// делал 3× existsSync+readFileSync+JSON.parse на каждую иконку). Состав apps.json
// фиксируется при старте → рантайм-инвалидация не нужна.
let _resolvedAppsBasePath = 'apps';
(function resolveAppsBasePathOnce() {
    try {
        const candidates = [
            path.join(appDir, 'apps.json'),
            path.join(__dirname, '..', 'apps.json'),
            path.resolve(process.cwd(), 'apps.json'),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                try {
                    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
                    if (cfg.path) _resolvedAppsBasePath = cfg.path.replace(/^[/\\]+/, '');
                } catch (e) { /* битый apps.json — игнор, остаётся дефолт */ }
            }
        }
    } catch (e) { /* оставляем 'apps' */ }
})();

// 5.5: favicon читается в буфер ОДИН раз при старте (+ предвычисленные ETag/Cache-
// Control-заголовки по mtime+size), а не stat+readFile на КАЖДЫЙ запрос.
let _faviconCache = null;
(function loadFaviconOnce() {
    try {
        const faviconPath = path.join(__dirname, 'resources', 'public', 'favicon.svg');
        const st = fs.statSync(faviconPath);
        if (st && st.isFile()) {
            _faviconCache = { data: fs.readFileSync(faviconPath), headers: httpCache.fileHeaders(st, 'image/svg+xml') };
        }
    } catch (e) { _faviconCache = null; }
})();

// 5.4: кэш резолва пути app-server.js для /api/apps/:appName (Map appName → path|null).
// require() и так кэширует модуль; убираем fs.existsSync на каждый такой запрос.
const _apiAppServerPathCache = new Map();
function resolveApiAppServerPath(appName) {
    if (_apiAppServerPathCache.has(appName)) return _apiAppServerPathCache.get(appName);
    const p = path.join(__dirname, '..', 'apps', appName, 'server.js');
    const resolved = fs.existsSync(p) ? p : null;
    _apiAppServerPathCache.set(appName, resolved);
    return resolved;
}

// Check access to protected resources (stub)
function checkProtectedAccess(sessionId, filePath) {
    // TODO: Implement real access check by sessionId and filePath
    return false;
}

// 0.7: статические пути не должны создавать/удалять сессию в БД. Браузер шлёт
// HTML '/' первым → там сессия и cookie создаются; последующая статика уже несёт
// cookie. Создание сессии на каждую иконку/JS = лишние insert'ы + гонка сессий.
function isStaticPath(url) {
    return url.startsWith('/res/')
        || url.startsWith('/apps/')
        || url.startsWith(`/${appAlias}/res/`)
        || url === '/favicon.ico'
        || url === '/favicon.svg';
}

async function handleRequest(req, res) {
    log.debug('[drive_root] Request:', req.method, req.url);

    // Universal App API routing: /api/apps/:appName/...
    if (req.url.startsWith('/api/apps/')) {
        const parts = req.url.split('/'); // ['', 'api', 'apps', 'appName', ...]
        if (parts.length >= 4) {
            const appName = parts[3];
            const appServerPath = resolveApiAppServerPath(appName); // 5.4: кэш, без existsSync на каждый запрос
            if (appServerPath) {
                try {
                    const appModule = require(appServerPath);
                    if (typeof appModule.handleDirectRequest === 'function') {
                        await appModule.handleDirectRequest(req, res, parts.slice(4));
                        return;
                    }
                } catch (e) {
                    console.error(`Error handling direct request for app ${appName}:`, e);
                }
            }
        }
    }

    const sessionStartNs = process.hrtime.bigint();
    // 0.7: для статики сессию НЕ создаём (только пассивно читаем cookie ниже).
    if (!isStaticPath(req.url)) {
        await getOrCreateSession(req, res);
    }
    perfMetrics.markSince('session', sessionStartNs);

    // Handle favicon (5.5: из буфера, без stat/readFile на каждый запрос)
    if (req.url === '/favicon.ico' || req.url === '/favicon.svg') {
        if (_faviconCache) {
            if (httpCache.maybe304(req, res, _faviconCache.headers)) return;
            res.writeHead(200, _faviconCache.headers);
            res.end(_faviconCache.data);
        } else {
            res.writeHead(204);
            res.end();
        }
        return;
    }

    // Universal resource serving: /res/public/..., /res/protected/...
    if (req.url.startsWith('/res/')) {
        const urlPath = req.url.split('?')[0];
        const parts = urlPath.split('/').filter(Boolean); // ['', 'res', 'public', ...] => ['res', 'public', ...]
        if (parts.length >= 3) {
            const resType = parts[1]; // public or protected
            const relPath = parts.slice(2).join(path.sep);
            let filePath;
            if (resType === 'public') {
                filePath = path.join(__dirname, 'resources', 'public', relPath);
                if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('404 Not Found');
                    return;
                }
                const contentType = getContentType(filePath);
                const fileStore = require('./fileStore');
                const ext = path.extname(filePath).slice(1).toLowerCase();
                if (ext === 'js') {
                    let sessionID = null;
                    if (req.headers && req.headers.cookie) {
                        const m = req.headers.cookie.match(/(?:^|; )sessionID=([^;]+)/i);
                        if (m) sessionID = decodeURIComponent(m[1]);
                    }
                    (async () => {
                        let language = null;
                        if (sessionID) {
                            try {
                                const { getSessionContext } = require('../drive_forms/globalServerContext');
                                const ctx = await getSessionContext(sessionID);
                                language = ctx && ctx.language;
                            } catch (e) { /* no session */ }
                        }
                        const text = await fileStore.serveFileFromPath(filePath, 'public', language);
                        // ETag по содержимому: различается между языками (перевод __t()).
                        const headers = httpCache.jsHeaders(text, contentType);
                        if (httpCache.maybe304(req, res, headers)) return;
                        res.writeHead(200, headers);
                        res.end(text);
                    })();
                } else {
                    let st = null;
                    try { st = fs.statSync(filePath); } catch (e) { }
                    const headers = st ? httpCache.fileHeaders(st, contentType) : { 'Content-Type': contentType };
                    if (st && httpCache.maybe304(req, res, headers)) return;
                    fs.readFile(filePath, (err, data) => {
                        if (err) {
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end('Error reading file');
                            return;
                        }
                        res.writeHead(200, headers);
                        res.end(data);
                    });
                }
                return;
            } else if (resType === 'protected') {
                filePath = path.join(__dirname, 'resources', 'protected', relPath);
                if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('404 Not Found');
                    return;
                }
                // Check access by sessionId (from cookie)
                let sessionId = null;
                if (req.headers && req.headers.cookie) {
                    const match = req.headers.cookie.match(/(?:^|; )sessionId=([^;]+)/i);
                    if (match) sessionId = decodeURIComponent(match[1]);
                }
                if (!checkProtectedAccess(sessionId, filePath)) {
                    res.writeHead(403, { 'Content-Type': 'text/plain' });
                    res.end('Forbidden');
                    return;
                }
                // Serve file
                const contentType = getContentType(filePath);
                fs.readFile(filePath, (err, data) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Error reading file');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': contentType });
                    res.end(data);
                });
                return;
            }
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
        return;
    }

    // Handle app static files: /apps/<appName>/resources/<type>/...
    if (req.url.startsWith('/apps/')) {
        const urlPath = req.url.split('?')[0];
        const parts = urlPath.split('/').filter(Boolean); // ['', 'apps', 'appName', 'resources', 'type', ...] => ['apps', 'appName', 'resources', 'type', ...]
        // parts[0] = 'apps'
        // parts[1] = appName
        // parts[2] = 'resources'
        // parts[3] = type (public/protected)
        if (parts.length >= 5 && parts[2] === 'resources') {
            const appName = parts[1];
            const resType = parts[3];
            const relPath = parts.slice(4).join(path.sep);

            // 2.3: appsBasePath резолвится один раз при старте (см. _resolvedAppsBasePath),
            // больше не парсим apps.json на каждый запрос статики приложения.
            const appsBasePath = _resolvedAppsBasePath;

            const appsDirPackage = path.join(__dirname, '..', appsBasePath);
            const appsDirProject = path.join(process.cwd(), appsBasePath);

            if (resType === 'public') {
                const fileStore = require('./fileStore');
                const serveAppFile = async (resolvedPath) => {
                    let sessionID = null;
                    if (req.headers && req.headers.cookie) {
                        const m = req.headers.cookie.match(/(?:^|; )sessionID=([^;]+)/i);
                        if (m) sessionID = decodeURIComponent(m[1]);
                    }
                    let language = null;
                    if (sessionID) {
                        try {
                            const { getSessionContext } = require('../drive_forms/globalServerContext');
                            const ctx = await getSessionContext(sessionID);
                            language = ctx && ctx.language;
                        } catch (e) { /* no session */ }
                    }
                    const contentType = getContentType(resolvedPath);
                    const ext = path.extname(resolvedPath).slice(1).toLowerCase();
                    if (ext === 'js') {
                        const text = await fileStore.serveFileFromPath(resolvedPath, 'public', language);
                        const headers = httpCache.jsHeaders(text, contentType);
                        if (httpCache.maybe304(req, res, headers)) return;
                        res.writeHead(200, headers);
                        res.end(text);
                    } else {
                        // Иконки 16×16 и пр.: длинный max-age + ETag по mtime → 304.
                        let st = null;
                        try { st = fs.statSync(resolvedPath); } catch (e) { }
                        const headers = st ? httpCache.fileHeaders(st, contentType) : { 'Content-Type': contentType };
                        if (st && httpCache.maybe304(req, res, headers)) return;
                        fs.readFile(resolvedPath, (err, data) => {
                            if (err) {
                                res.writeHead(500, { 'Content-Type': 'text/plain' });
                                res.end('Error reading file');
                                return;
                            }
                            res.writeHead(200, headers);
                            res.end(data);
                        });
                    }
                };

                // Prefer project apps directory if file exists there
                const projectFilePath = path.join(appsDirProject, appName, 'resources', 'public', relPath);
                if (fs.existsSync(projectFilePath) && fs.statSync(projectFilePath).isFile()) {
                    serveAppFile(projectFilePath);
                    return;
                }

                // Fallback to package apps directory
                const filePath = path.join(appsDirPackage, appName, 'resources', 'public', relPath);

                if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('404 Not Found');
                    return;
                }

                serveAppFile(filePath);
                return;
            }
            // TODO: protected resources for apps
        }
    }

    // --- Endpoint: GET /files/:uid — получить клиентский файл из MemoryStore ---
    if (req.method === 'GET' && req.url.startsWith('/files/')) {
        const uid = req.url.split('/files/')[1].split('?')[0];
        if (!uid) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Bad Request: uid required');
            return;
        }

        // Извлечь sessionID из cookie
        let sessionID = null;
        if (req.headers && req.headers.cookie) {
            const match = req.headers.cookie.match(/(?:^|; )sessionID=([^;]+)/);
            if (match) sessionID = decodeURIComponent(match[1]);
        }

        const fileStore = require('./fileStore');
        const formsCtx = require('../drive_forms/globalServerContext');

        try {
            // Получить пользователя по сессии
            const user = await require('./globalServerContext').getUserBySessionID(sessionID);
            const userRole = user ? await formsCtx.getUserAccessRole(user) : 'public';

            const result = fileStore.getFile(uid, userRole);
            if (!result) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('Forbidden or file not found');
                return;
            }

            // Определить Content-Type по типу файла
            const MIME_TYPES = {
                js:   'application/javascript',
                css:  'text/css',
                html: 'text/html',
                json: 'application/json',
                txt:  'text/plain',
                svg:  'image/svg+xml',
                xml:  'application/xml',
            };
            const contentType = MIME_TYPES[result.fileType] || 'text/plain';

            res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });

            // Translate __t('key') markers in JS files
            let fileText = result.text;
            if (result.fileType === 'js' && fileText.includes('__t(')) {
                try {
                    const { getSessionContext } = require('../drive_forms/globalServerContext');
                    const { language } = await getSessionContext(sessionID);
                    fileText = fileStore.translateJsMarkers(fileText, language);
                } catch (e) {
                    console.error('[/files] i18n translation error:', e && e.message || e);
                }
            }

            res.end(fileText);
        } catch (e) {
            console.error('[/files] Error serving file:', e);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
        }
        return;
    }

    // --- Endpoint: POST /server-call — вызов серверной функции из serverScriptStore ---
    if (req.method === 'POST' && req.url === '/server-call') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            let data;
            try {
                data = JSON.parse(body);
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
                return;
            }

            const { uid, fn, fnParams } = data;
            if (!uid || !fn) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'uid and fn are required' }));
                return;
            }

            // Извлечь sessionID из cookie
            let sessionID = null;
            if (req.headers && req.headers.cookie) {
                const match = req.headers.cookie.match(/(?:^|; )sessionID=([^;]+)/);
                if (match) sessionID = decodeURIComponent(match[1]);
            }

            const serverScriptStore = require('./serverScriptStore');
            const formsCtx = require('../drive_forms/globalServerContext');

            try {
                const user = await require('./globalServerContext').getUserBySessionID(sessionID);
                const userRole = user ? await formsCtx.getUserAccessRole(user) : 'public';

                // Гейт обязательной смены пароля: пока mustChangePassword, сессия НЕ
                // допускается ни к каким серверным скриптам, кроме приложения логина
                // ('login.actions' — форма смены пароля и boot). Иначе после перезагрузки
                // страницы пользователь, чья сессия уже привязана, мог бы работать в системе
                // в обход обязательной смены пароля.
                if (user && user.mustChangePassword && uid !== 'login.actions') {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'PASSWORD_CHANGE_REQUIRED' }));
                    return;
                }

                const entry = serverScriptStore.getServerScript(uid, userRole);
                if (!entry) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Forbidden or script not found' }));
                    return;
                }

                if (typeof entry.scriptObj[fn] !== 'function') {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Function "${fn}" not found in script` }));
                    return;
                }

                const ctx = { sessionID, user, role: userRole };
                const result = await entry.scriptObj[fn](fnParams, ctx);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ result: result !== undefined ? result : null }));
            } catch (e) {
                console.error('[/server-call] Error:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message || 'Internal Server Error' }));
            }
        });
        return;
    }

    // ...remaining logic...
    if (req.url === '/') {
        fs.readFile(path.join(appDir, config.appIndexPage), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('404 Not Found');
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Security-Policy': "default-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://maps.googleapis.com; connect-src 'self' https://maps.googleapis.com https://places.googleapis.com; img-src 'self' data: https://maps.gstatic.com https://*.googleapis.com; font-src 'self' https://fonts.gstatic.com"
            });
            res.end(data);
        });
    } else if (req.url.startsWith(`/${appAlias}`)) {
        try {
            if (typeof appHandler.handleRequest === 'function') {
                appHandler.handleRequest(req, res, appDir, appAlias);
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                console.error('Error: appHandler.handleRequest is not a function');
                console.error('Please ensure your application handler exports a handleRequest function');
                res.end('Application handler not configured properly. Check server logs for details.');
            }
        } catch (err) {
            console.error('Error loading application handler:', err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Application handler error');
        }
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
    }
}

function createServer(options = {}) {
    perfMetrics.startMemoryLogger();
    const requestListener = (req, res) => {
        perfMetrics.runWithRequest(req, res, () => {
            // 0.4: прозрачное gzip/brotli поверх res. Ставится ПОСЛЕ perfMetrics
            // (тот уже пропатчил writeHead под Server-Timing — мы зовём его при
            // фактическом флаше, поэтому заголовок сохраняется).
            try { httpCompression.install(req, res); } catch (e) { /* сжатие не ломает ответ */ }
            handleRequest(req, res).catch(e => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal Server Error', details: e.message }));
            });
        });
    };

    let server;
    if (options.key && options.cert) {
        server = https.createServer(options, requestListener);
    } else {
        server = http.createServer(requestListener);
    }
    return server;
}

module.exports = { createServer };
