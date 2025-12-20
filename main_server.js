// main_server.js для запуска из пакета my-old-space
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const globalContext = require('./drive_root/globalServerContext');
const selfsigned = require('selfsigned');

const isProduction = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || (isProduction ? 80 : 3000);

// Run createDB.js before starting the server
const createDBPath = path.join(__dirname, 'drive_root', 'db', 'createDB.js');
console.log('Initializing database...');
console.log(`[main_server] PROJECT_ROOT from environment: ${process.env.PROJECT_ROOT || 'NOT SET'}`);

// Ensure createDB exists before spawning
if (!fs.existsSync(createDBPath)) {
  console.error(`[main_server] createDB not found at ${createDBPath}`);
  process.exit(1);
}

// Pass PROJECT_ROOT environment variable to child process
const dbProcess = spawn(process.execPath, [createDBPath], {
  stdio: 'inherit',
  env: { ...process.env, PROJECT_ROOT: process.env.PROJECT_ROOT }
});

console.log(`[main_server] Spawned createDB pid=${dbProcess.pid}`);

dbProcess.on('error', (err) => {
  console.error('[main_server] Failed to start DB init process:', err && err.message || err);
  process.exit(1);
});

dbProcess.on('exit', (code, signal) => {
  if (code !== 0 || signal) {
    console.error(`DB initialization error (exit code: ${code}, signal: ${signal})`);
    process.exit(1);
  }

  console.log('Database initialized.');

  // Load default values cache before starting the server
  Promise.resolve(globalContext.reloadDefaultValues())
    .then(async () => {
      const { createServer } = require('./drive_root/server');

      console.log(`Starting server in ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'} mode`);

      // SSL Certificate handling
      let options = {};

      if (isProduction) {
        // Production: Use provided certificates or fallback to HTTP (often handled by reverse proxy)
        if (process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH) {
          if (fs.existsSync(process.env.SSL_KEY_PATH) && fs.existsSync(process.env.SSL_CERT_PATH)) {
            options.key = fs.readFileSync(process.env.SSL_KEY_PATH);
            options.cert = fs.readFileSync(process.env.SSL_CERT_PATH);
          }
        }
      }
      // Development: Default to HTTP (no options.key/cert)

      const server = createServer(options);
      const protocol = (options.key && options.cert) ? 'https' : 'http';

      // Initialize WebSockets for all apps from apps.json
      const localAppsJsonPath = path.join(__dirname, 'drive_forms', 'apps.json');
      const rootAppsJsonPath = path.join(__dirname, 'apps.json');

      let allApps = [];
      let appsBasePath = "apps"; // Default if not specified

      const loadAppsFromPath = (p) => {
        if (fs.existsSync(p)) {
          try {
            const appsConfig = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (typeof appsConfig.path === 'string' && appsConfig.path.length > 0) {
              appsBasePath = appsConfig.path.replace(/^[/\\]+/, '');
            }
            if (Array.isArray(appsConfig.apps)) {
              appsConfig.apps.forEach(app => {
                if (app.name && !allApps.find(a => a.name === app.name)) {
                  allApps.push(app);
                }
              });
            }
          } catch (e) {
            console.error(`[main_server] Error reading apps.json at ${p}:`, e.message);
          }
        }
      };

      loadAppsFromPath(localAppsJsonPath);
      loadAppsFromPath(rootAppsJsonPath);

      const appsDir = path.join(__dirname, appsBasePath);

      for (const app of allApps) {
        const appServerPath = path.join(appsDir, app.name, 'server.js');
        if (fs.existsSync(appServerPath)) {
          try {
            const appModule = require(appServerPath);
            if (typeof appModule.setupWebSocket === 'function') {
              appModule.setupWebSocket(server);
              console.log(`WebSocket initialized for app: ${app.name}`);
            }
          } catch (e) {
            console.error(`Error initializing WebSocket for app ${app.name}:`, e);
          }
        }
      }

      server.listen(PORT, () => {
        console.log(`Server running at ${protocol}://localhost:${PORT}`);
      });
    })
    .catch(err => {
      console.error('Error loading defaultValuesCache:', err && err.message || err);
      const { createServer } = require('./drive_root/server');
      const server = createServer();
      server.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT} (without default values cache)`);
      });
    });
});

module.exports = { server: null };
