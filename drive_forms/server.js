// Use getContentType from global context via globalRoot
const formsGlobal = require('./globalServerContext');
const globalRoot = require('../drive_root/globalServerContext');
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

// Load apps.json config
let appsConfig = { apps: [] };
try {
	const localAppsPath = path.join(__dirname, 'apps.json');
	const rootAppsPath = path.join(__dirname, '..', 'apps.json');

	const configs = [];
	if (fs.existsSync(localAppsPath)) {
		configs.push(JSON.parse(fs.readFileSync(localAppsPath, 'utf8')));
	}
	if (fs.existsSync(rootAppsPath)) {
		configs.push(JSON.parse(fs.readFileSync(rootAppsPath, 'utf8')));
	}

	if (configs.length > 0) {
		appsConfig = configs[0];
		if (configs.length > 1) {
			// Merge apps arrays from both configs
			const mergedApps = [...(appsConfig.apps || [])];
			const rootApps = configs[1].apps || [];
			rootApps.forEach(app => {
				if (!mergedApps.find(a => a.name === app.name)) {
					mergedApps.push(app);
				}
			});
			appsConfig.apps = mergedApps;
			// If root config has a path, it takes precedence for root apps
			if (configs[1].path) {
				appsConfig.path = configs[1].path;
			}
		}
	}
	if (!appsConfig.path) appsConfig.path = '/apps';
} catch (e) {
	console.error('[drive_forms] Failed to read or merge apps.json:', e.message);
}

const ALLOWED = new Set(appConfig.publicFiles || []);


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
	if (!appEntry) return callback(new Error('App not found'));
	const appsBasePath = (appsConfig.path || '/apps').replace(/^[/\\]+/, '');
	const appServerPath = path.join(__dirname, '..', appsBasePath, appName, 'server.js');
	if (!fs.existsSync(appServerPath)) return callback(new Error('App server.js not found'));
	let appModule;
	try {
		// Remove from require cache for hot-reload
		delete require.cache[require.resolve(appServerPath)];
		appModule = require(appServerPath);
	} catch (e) {
		return callback(new Error('Failed to load app server.js: ' + e.message));
	}
	if (typeof appModule[methodName] !== 'function') return callback(new Error('Method not found in app'));
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

function handleRequest(req, res, appDir, appAlias) {
	// Processing resources and API endpoints
	console.log('[drive_forms/handleRequest] Request:', req.method, req.url, 'appAlias:', appAlias);
	try {
		// --- Endpoint for GET requests with parameters (for SSE) - CHECK FIRST ---
		if (req.method === 'GET' && req.url.startsWith(`/${appAlias}/`) && !req.url.startsWith(`/${appAlias}/res/`) && req.url !== `/${appAlias}/loadApps`) {
			const urlObj = new URL(req.url, `http://${req.headers.host}`);
			const pathParts = urlObj.pathname.split('/').filter(Boolean);

			console.log('[drive_forms] GET request:', req.url, 'pathParts:', pathParts);

			// Format: /{appAlias}/{appName}/{methodName}?params
			// pathParts will be ['appAlias', 'appName', 'methodName']
			if (pathParts.length >= 3 && pathParts[0] === appAlias) {
				const appName = pathParts[1];
				const methodName = pathParts[2];

				console.log('[drive_forms] Invoking:', appName, methodName);

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

				invokeAppMethod(appName, methodName, params, sessionID, (err, result) => {
					if (err) {
						console.error('[drive_forms] Error invoking method:', err.message);
						res.writeHead(500, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: err.message }));
					} else {
						// Check if request handled inside method (SSE, etc)
						if (result && (result._sse || result._handled)) {
							// Connection already handled inside method, don't close
							console.log('[drive_forms] Request handled by app method');
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
			const parts = req.url.split('/').filter(Boolean); // ['', appAlias, 'res', 'public', ...] => ['appAlias', 'res', 'public', ...]
			if (parts.length >= 4) {
				const resType = parts[2]; // public or protected
				const relPath = parts.slice(3).join(path.sep);
				let filePath;
				if (resType === 'public') {
					filePath = path.join(__dirname, 'resources', 'public', relPath);
					if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
						res.writeHead(404, { 'Content-Type': 'text/plain' });
						res.end('404 Not Found');
						return;
					}
					const contentType = globalRoot.getContentType(filePath);
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
						res.end('Forbidden');
						return;
					}
					const contentType = globalRoot.getContentType(filePath);
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
		// --- Endpoint for loading available apps client scripts ---
		if ((req.method === 'POST' || req.method === 'GET') && req.url === `/${appAlias}/loadApps`) {
			// Get user by sessionID
			let sessionID = null;
			if (req.headers && req.headers.cookie) {
				const match = req.headers.cookie.match(/(?:^|; )sessionID=([^;]+)/);
				if (match) sessionID = decodeURIComponent(match[1]);
			}
			globalRoot.getUserBySessionID(sessionID).then(user => {
				return formsGlobal.loadApps(user);
			}).then(result => {
				if (req.method === 'GET') {
					res.writeHead(200, { 'Content-Type': 'application/javascript' });
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
					res.end(JSON.stringify({ error: 'Upload error: ' + err.message }));
					return;
				}
				const { app, method } = req.body;
				if (!app || !method) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Missing app or method' }));
					return;
				}
				// Извлекаем sessionID из cookie
				let sessionID = null;
				if (req.headers && req.headers.cookie) {
					const match = req.headers.cookie.match(/(?:^|; )sessionID=([^;]+)/i);
					if (match) sessionID = decodeURIComponent(match[1]);
				}
				invokeAppMethod(app, method, req.body, sessionID, (err, result) => {
					if (err) {
						res.writeHead(500, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: err.message }));
					} else {
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ result }));
					}
				}, req, res);
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
					res.end(JSON.stringify({ error: 'Invalid JSON' }));
					return;
				}
				const { app, method, params } = data;
				if (!app || !method) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Missing app or method' }));
					return;
				}
				// Извлекаем sessionID из cookie
				let sessionID = null;
				if (req.headers && req.headers.cookie) {
					const match = req.headers.cookie.match(/(?:^|; )sessionID=([^;]+)/);
					if (match) sessionID = decodeURIComponent(match[1]);
				}
				invokeAppMethod(app, method, params || {}, sessionID, (err, result) => {
					if (err) {
						res.writeHead(500, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: err.message }));
					} else {
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ result }));
					}
				}, req, res);
			});
			return;
		}

		// Everything else - 404
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('Not Found');
	} catch (e) {
		console.error('[drive_forms] handleRequest error:', e);
		res.writeHead(500, { 'Content-Type': 'text/plain' });
		res.end('Internal Server Error');
	}
}

module.exports = { handleRequest };

