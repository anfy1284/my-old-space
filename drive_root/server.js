// Get getContentType from global context
const { getContentType } = require('./globalServerContext');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const qs = require('querystring');

// Sessions and clients are now handled via sessionManager
const { getOrCreateSession } = require('./db/sessionManager');

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

// Check access to protected resources (stub)
function checkProtectedAccess(sessionId, filePath) {
    // TODO: Implement real access check by sessionId and filePath
    return false;
}

async function handleRequest(req, res) {
    console.log('[drive_root] Request:', req.method, req.url);

    // Universal App API routing: /api/apps/:appName/...
    if (req.url.startsWith('/api/apps/')) {
        const parts = req.url.split('/'); // ['', 'api', 'apps', 'appName', ...]
        if (parts.length >= 4) {
            const appName = parts[3];
            const appServerPath = path.join(__dirname, '..', 'apps', appName, 'server.js');
            if (fs.existsSync(appServerPath)) {
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

    await getOrCreateSession(req, res);

    // Handle favicon
    if (req.url === '/favicon.ico' || req.url === '/favicon.svg') {
        const faviconPath = path.join(__dirname, 'resources', 'public', 'favicon.svg');
        if (fs.existsSync(faviconPath)) {
            fs.readFile(faviconPath, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
                res.end(data);
            });
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
                        res.writeHead(200, { 'Content-Type': contentType });
                        res.end(await fileStore.serveFileFromPath(filePath, 'public', language));
                    })();
                } else {
                    fs.readFile(filePath, (err, data) => {
                        if (err) {
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end('Error reading file');
                            return;
                        }
                        res.writeHead(200, { 'Content-Type': contentType });
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

            // Path to apps folder relative to drive_root, but prefer project-level apps when present
            let appsBasePath = "apps"; // Default
            try {
                // Try to find path in apps.json files: appDir/apps.json, drive_root/../apps.json, project/apps.json
                const localAppsJsonPath = path.join(appDir, 'apps.json');
                const rootAppsJsonPath = path.join(__dirname, '..', 'apps.json');
                const projectAppsJsonPath = path.resolve(process.cwd(), 'apps.json');
                const checkPath = (p) => {
                    if (fs.existsSync(p)) {
                        try {
                            const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
                            if (cfg.path) appsBasePath = cfg.path.replace(/^[/\\]+/, '');
                        } catch (e) { }
                    }
                };
                checkPath(localAppsJsonPath);
                checkPath(rootAppsJsonPath);
                checkPath(projectAppsJsonPath);
            } catch (e) { }

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
                        res.writeHead(200, { 'Content-Type': contentType });
                        res.end(await fileStore.serveFileFromPath(resolvedPath, 'public', language));
                    } else {
                        fs.readFile(resolvedPath, (err, data) => {
                            if (err) {
                                res.writeHead(500, { 'Content-Type': 'text/plain' });
                                res.end('Error reading file');
                                return;
                            }
                            res.writeHead(200, { 'Content-Type': contentType });
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
                'Content-Security-Policy': "default-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"
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
    const requestListener = (req, res) => {
        handleRequest(req, res).catch(e => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal Server Error', details: e.message }));
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
