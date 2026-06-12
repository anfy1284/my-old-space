// Use getContentType from global context via globalRoot
const formsGlobal = require('./globalServerContext');
const globalRoot = require('../drive_root/globalServerContext');
const { t } = require('../drive_root/i18n');
const httpCache = require('../drive_root/httpCache');
const log = require('../drive_root/log');
const fs = require('fs');
const path = require('path');

// Load app config (public files whitelist)
let appConfig = { publicFiles: [] };
try {
	const cfgPath = path.join(__dirname, 'server_config.json');
	appConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch (e) {
	console.error('[drive_forms] Failed to read server_config.json:', e.message);
}

// Load apps.json config (consider framework-local, package root and project root)
let appsConfig = { apps: [] };
try {
	const localAppsPath = path.join(__dirname, 'apps.json');
	const packageAppsPath = path.join(__dirname, '..', 'apps.json');
	const projectAppsPath = path.resolve(process.cwd(), 'apps.json');

	const configs = [];
	if (fs.existsSync(localAppsPath)) {
		configs.push({ cfg: JSON.parse(fs.readFileSync(localAppsPath, 'utf8')), baseDir: path.resolve(__dirname, '..') });
	}
	if (fs.existsSync(packageAppsPath)) {
		configs.push({ cfg: JSON.parse(fs.readFileSync(packageAppsPath, 'utf8')), baseDir: path.resolve(__dirname, '..') });
	}
	if (fs.existsSync(projectAppsPath)) {
		configs.push({ cfg: JSON.parse(fs.readFileSync(projectAppsPath, 'utf8')), baseDir: process.cwd() });
	}

	if (configs.length > 0) {
		// Merge apps with priority: project (last) overrides package and framework
		const appsMap = new Map();
		let chosenPath = '/apps';
		for (const entry of configs) {
			const cfg = entry.cfg || {};
			const appsPath = (cfg.path || '/apps').replace(/^[/\\]+/, '');
			if (cfg.path) chosenPath = cfg.path;
			const apps = cfg.apps || [];
			for (const app of apps) {
				appsMap.set(app.name, Object.assign({}, app));
			}
		}
		appsConfig.apps = Array.from(appsMap.values());
		appsConfig.path = chosenPath;
	}
	if (!appsConfig.path) appsConfig.path = '/apps';
} catch (e) {
	console.error('[drive_forms] Failed to read or merge apps.json:', e.message);
}

const ALLOWED = new Set(appConfig.publicFiles || []);

// 0.1 (оптимизация): кэш резолва путей server.js приложений (appName → путь)
// строится один раз; модуль грузится обычным require (Node кэширует его сам).
// Перекомпиляция server.js на КАЖДЫЙ RPC (delete require.cache + require) —
// десятки мс CPU на больших модулях (uniForm ~62KB), потеря module-level
// состояния и JIT-прогрева. Hot-reload оставляем только в dev.
const _appServerPathCache = new Map(); // appName -> resolved path | null
const HOT_RELOAD = process.env.DEV_HOT_RELOAD === '1'
	|| (!!process.env.NODE_ENV && process.env.NODE_ENV !== 'production');

function resolveAppServerPath(appName) {
	if (_appServerPathCache.has(appName)) return _appServerPathCache.get(appName);
	const appsBasePath = (appsConfig.path || '/apps').replace(/^[/\\]+/, '');
	// Try project root first (for user apps), then framework
	const projectRoot = globalRoot.getProjectRoot() || process.cwd();
	const possiblePaths = [
		path.join(projectRoot, appsBasePath, appName, 'server.js'),
		path.join(__dirname, '..', appsBasePath, appName, 'server.js')
	];
	let resolved = null;
	for (const tryPath of possiblePaths) {
		if (fs.existsSync(tryPath)) { resolved = tryPath; break; }
	}
	_appServerPathCache.set(appName, resolved);
	return resolved;
}


function safeJoin(baseDir, relativePath) {
	const norm = path.normalize(relativePath).replace(/^[/\\]+/, '');
	// prevent directory traversal
	if (norm.includes('..')) return null;
	return path.join(baseDir, norm);
}

function loadApp(name) {
	const app = appsConfig.apps.find(a => a.name === name);
	if (app && app.path) {
		return path.join(app.path, 'resources', 'public', 'client.js');
	}
	return null;
}


// Helper function for dynamic app method invocation
function invokeAppMethod(appName, methodName, params, sessionID, callback, req, res) {
	// Path to app server.js
	const appEntry = appsConfig.apps.find(a => a.name === appName);
	if (!appEntry) return callback(new Error(t('App not found', 'en')));

	// Резолв пути кэшируется (см. resolveAppServerPath / 0.1)
	const appServerPath = resolveAppServerPath(appName);
	if (!appServerPath) {
		console.error('[invokeAppMethod] server.js not found for app:', appName);
		return callback(new Error(t('App server.js not found', 'en')));
	}

	// Метка для perf-лога: какой RPC-метод обрабатывался в этом запросе
	try { require('../drive_root/perfMetrics').setDetail('rpc', appName + '.' + methodName); } catch (e) { }

	let appModule;
	try {
		// Hot-reload только в dev; в production модуль кэшируется Node'ом (0.1)
		if (HOT_RELOAD) delete require.cache[require.resolve(appServerPath)];
		appModule = require(appServerPath);
	} catch (e) {
		console.error('[invokeAppMethod] Failed to load server.js:', e);
		return callback(new Error(t('Failed to load app server.js:', 'en') + ' ' + e.message));
	}
	if (typeof appModule[methodName] !== 'function') return callback(new Error(t('Method not found in app', 'en')));
	// Call function with sessionID as separate parameter
	try {
		// params is object, sessionID is string, req, res for SSE
		const result = appModule[methodName](params, sessionID, req, res);
		if (result && typeof result.then === 'function') {
			// async/Promise
			result.then(r => callback(null, r)).catch(e => callback(e));
		} else {
			callback(null, result);
		}
	} catch (e) {
		callback(e);
	}
}

// Гейт обязательной смены пароля: true, если у пользователя сессии стоит
// mustChangePassword. Пока флаг стоит, все app-вызовы (/call, /upload) блокируются —
// приложение логина свои методы зовёт через /server-call ('login.actions'), а не сюда,
// поэтому форма смены пароля не страдает. Цель — не дать работать в системе в обход
// смены пароля после перезагрузки страницы (сессия уже привязана).
async function isPasswordChangePending(sessionID) {
	try {
		const user = await globalRoot.getUserBySessionID(sessionID);
		return !!(user && user.mustChangePassword);
	} catch (e) { return false; }
}

function denyPasswordChange(res) {
	res.writeHead(403, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: 'PASSWORD_CHANGE_REQUIRED' }));
}

function handleRequest(req, res, appDir, appAlias) {
	// Processing resources and API endpoints
	log.debug('[drive_forms/handleRequest] Request:', req.method, req.url, 'appAlias:', appAlias);
	try {
		// --- Endpoint for GET requests with parameters (for SSE) - CHECK FIRST ---
		// --- Global SSE endpoint for session-scoped events (one EventSource per session) ---
		if (req.method === 'GET' && req.url === `/${appAlias}/events`) {
			// Extract sessionID from cookie
			let sessionID = null;
			if (req.headers && req.headers.cookie) {
				const match = req.headers.cookie.match(/(?:^|; )sessionID=([^;]+)/);
				if (match) sessionID = decodeURIComponent(match[1]);
			}
			// Verify user
			globalRoot.getUserBySessionID(sessionID).then(async user => {
				if (!user) {
					res.writeHead(401, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: await formsGlobal.tForSession('User not authorized', sessionID) }));
					return;
				}
				res.writeHead(200, {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'Connection': 'keep-alive',
					'Access-Control-Allow-Origin': '*'
				});

				if (!global._sessionSseClients) global._sessionSseClients = new Map();
				if (!global._sessionSseClients.has(sessionID)) global._sessionSseClients.set(sessionID, new Set());
				const set = global._sessionSseClients.get(sessionID);
				const clientId = Math.random().toString(36).substr(2, 9);
				const clientInfo = { res, clientId };
				set.add(clientInfo);
				log.debug(`[drive_forms/events] session SSE connected session=${sessionID} user=${user.UID} clientId=${clientId} total=${set.size}`);
				res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

				req.on('close', () => {
					try {
						set.delete(clientInfo);
						log.debug(`[drive_forms/events] session SSE disconnected session=${sessionID} clientId=${clientId} remaining=${set.size}`);
						if (set.size === 0) global._sessionSseClients.delete(sessionID);
					} catch (e) { console.error('[drive_forms/events] error on close handler:', e); }
				});
			}).catch(e => {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: e.message }));
			});
			return;
		}
		if (req.method === 'GET' && req.url.startsWith(`/${appAlias}/`) && !req.url.startsWith(`/${appAlias}/res/`) && req.url !== `/${appAlias}/loadApps`) {
			const urlObj = new URL(req.url, `http://${req.headers.host}`);
			const pathParts = urlObj.pathname.split('/').filter(Boolean);

			log.debug('[drive_forms] GET request:', req.url, 'pathParts:', pathParts);

			// Format: /{appAlias}/{appName}/{methodName}?params
			// pathParts will be ['appAlias', 'appName', 'methodName']
			if (pathParts.length >= 3 && pathParts[0] === appAlias) {
				const appName = pathParts[1];
				const methodName = pathParts[2];

				log.debug('[drive_forms] Invoking:', appName, methodName);

				// Extract params from query string
				const params = {};
				urlObj.searchParams.forEach((value, key) => {
					params[key] = value;
				});

				// Extract sessionID from cookie
				let sessionID = null;
				if (req.headers && req.headers.cookie) {
					const match = req.headers.cookie.match(/(?:^|; )sessionID=([^;]+)/);
					if (match) sessionID = decodeURIComponent(match[1]);
				}

				invokeAppMethod(appName, methodName, params, sessionID, async (err, result) => {
						if (err) {
							console.error('[drive_forms] Error invoking method:', err.message);
							res.writeHead(500, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({ error: await formsGlobal.tForSession(err.message, sessionID) }));
					} else {
						// Check if request handled inside method (SSE, etc)
						if (result && (result._sse || result._handled)) {
							// Connection already handled inside method, don't close
							log.debug('[drive_forms] Request handled by app method');
							return;
						}
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ result }));
					}
				}, req, res);
				return;
			}
		}

		// Universal resource serving: /<appAlias>/res/public/..., /<appAlias>/res/protected/...
		if (req.url.startsWith(`/${appAlias}/res/`)) {
			let sessionID = null;
			if (req.headers && req.headers.cookie) {
				const m = req.headers.cookie.match(/(?:^|; )sessionID=([^;]+)/);
				if (m) sessionID = decodeURIComponent(m[1]);
			}
			const parts = req.url.split('/').filter(Boolean); // ['', appAlias, 'res', 'public', ...] => ['appAlias', 'res', 'public', ...]
			if (parts.length >= 4) {
				const resType = parts[2]; // public or protected
				const relPathRaw = parts.slice(3).join(path.sep);
				const relPath = relPathRaw.split('?')[0]; // strip query string (e.g. ?t=...)
				let filePath;
				if (resType === 'public') {
					filePath = path.join(__dirname, 'resources', 'public', relPath);
					if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
						res.writeHead(404, { 'Content-Type': 'text/plain' });
						res.end('404 Not Found');
						return;
					}
					const contentType = globalRoot.getContentType(filePath);
					const fileStore = require('../drive_root/fileStore');
					const ext = path.extname(filePath).slice(1).toLowerCase();
					if (ext === 'js') {
						(async () => {
							let language = null;
							if (sessionID) {
								try {
									const ctx = await formsGlobal.getSessionContext(sessionID);
									language = ctx && ctx.language;
								} catch (e) { /* no session */ }
							}
							const text = await fileStore.serveFileFromPath(filePath, 'public', language);
							const headers = httpCache.jsHeaders(text, contentType);
							if (httpCache.maybe304(req, res, headers)) return;
							res.writeHead(200, headers);
							res.end(text);
						})();
					} else {
						let st = null;
						try { st = fs.statSync(filePath); } catch (e) { }
						const fheaders = st ? httpCache.fileHeaders(st, contentType) : { 'Content-Type': contentType };
						if (st && httpCache.maybe304(req, res, fheaders)) return;
						fs.readFile(filePath, (err, data) => {
							if (err) {
								res.writeHead(500, { 'Content-Type': 'text/plain' });
								res.end('Error reading file');
								return;
							}
							res.writeHead(200, fheaders);
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
					// Check access by sessionID (stub)
					let sessionID = null;
					if (req.headers && req.headers.cookie) {
						const match = req.headers.cookie.match(/(?:^|; )sessionID=([^;]+)/);
						if (match) sessionID = decodeURIComponent(match[1]);
					}
					// TODO: Implement real access check
					// Currently access is always forbidden
					const checkProtectedAccess = (sessionId, filePath) => false;
					if (!checkProtectedAccess(sessionID, filePath)) {
						res.writeHead(403, { 'Content-Type': 'text/plain' });
							res.end(t('Forbidden', 'en'));
							return;
						}
						const contentType = globalRoot.getContentType(filePath);
						fs.readFile(filePath, (err, data) => {
							if (err) {
								res.writeHead(500, { 'Content-Type': 'text/plain' });
								res.end(t('Error reading file', 'en'));
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
		// --- Endpoint for loading available apps client scripts ---
		if ((req.method === 'POST' || req.method === 'GET') && req.url === `/${appAlias}/loadApps`) {
			// Get user by sessionID
			let sessionID = null;
			if (req.headers && req.headers.cookie) {
				const match = req.headers.cookie.match(/(?:^|; )sessionID=([^;]+)/);
				if (match) sessionID = decodeURIComponent(match[1]);
			}
			globalRoot.getUserBySessionID(sessionID).then(user => {
				return formsGlobal.loadApps(user, sessionID);
			}).then(result => {
				if (req.method === 'GET') {
					const _h = httpCache.jsHeaders(result, 'application/javascript');
					if (httpCache.maybe304(req, res, _h)) return;
					res.writeHead(200, _h);
					res.end(result);
				} else {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ result }));
				}
			}).catch(e => {
				res.writeHead(500, { 'Content-Type': req.method === 'GET' ? 'text/javascript' : 'application/json' });
				res.end(req.method === 'GET' ? ('/* error: ' + e.message.replace(/\*\//g, '') + ' */') : JSON.stringify({ error: e.message }));
			});
			return;
		}

		// --- Endpoint for uploading app files via POST ---
		if (req.method === 'POST' && req.url === `/${appAlias}/upload`) {
			// Expect multipart/form-data with app, method, file and other fields
			const multer = require('multer');
			const upload = multer({ storage: multer.memoryStorage() }); // In memory to pass to method
			upload.single('file')(req, res, (err) => {
				if (err) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: t('Upload error:', 'en') + ' ' + err.message }));
					return;
				}
				const { app, method } = req.body;
				if (!app || !method) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: t('Missing app or method', 'en') }));
					return;
				}
				// Извлекаем sessionID из cookie
				let sessionID = null;
				if (req.headers && req.headers.cookie) {
					const match = req.headers.cookie.match(/(?:^|; )sessionID=([^;]+)/i);
					if (match) sessionID = decodeURIComponent(match[1]);
				}
				isPasswordChangePending(sessionID).then(pending => {
					if (pending) { denyPasswordChange(res); return; }
					invokeAppMethod(app, method, req.body, sessionID, async (err, result) => {
						if (err) {
							res.writeHead(500, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({ error: await formsGlobal.tForSession(err.message, sessionID) }));
						} else {
							res.writeHead(200, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({ result }));
						}
					}, req, res);
				});
			});
			return;
		}

		// --- Endpoint for calling app method via POST ---
		if (req.method === 'POST' && req.url === `/${appAlias}/call`) {
			let body = '';
			req.on('data', chunk => { body += chunk; });
			req.on('end', () => {
				let data;
				try {
					data = JSON.parse(body);
				} catch (e) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: t('Invalid JSON', 'en') }));
					return;
				}
				const { app, method, params } = data;
				if (!app || !method) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: t('Missing app or method', 'en') }));
					return;
				}
				// Извлекаем sessionID из cookie
				let sessionID = null;
				if (req.headers && req.headers.cookie) {
					const match = req.headers.cookie.match(/(?:^|; )sessionID=([^;]+)/);
					if (match) sessionID = decodeURIComponent(match[1]);
				}
				log.debug('[drive_forms/call] Cookie header:', req.headers.cookie);
				log.debug('[drive_forms/call] Extracted sessionID:', sessionID);
				isPasswordChangePending(sessionID).then(pending => {
					if (pending) { denyPasswordChange(res); return; }
					invokeAppMethod(app, method, params || {}, sessionID, async (err, result) => {
						if (err) {
							res.writeHead(500, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({ error: await formsGlobal.tForSession(err.message, sessionID) }));
						} else {
							res.writeHead(200, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({ result }));
						}
					}, req, res);
				});
			});
			return;
		}

		// Everything else - 404
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end(t('Not Found', 'en'));
	} catch (e) {
		console.error('[drive_forms] handleRequest error:', e);
		res.writeHead(500, { 'Content-Type': 'text/plain' });
		res.end(t('Internal Server Error', 'en'));
	}
}

module.exports = { handleRequest };

