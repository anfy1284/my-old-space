// Entry point for my-old-space framework

const path = require('path');

// Exported modules from core
const globalContext = require('./drive_root/globalServerContext');
const eventBus = require('./drive_root/eventBus');
const SequelizeInstance = require('./drive_root/db/sequelize_instance');
const Utilities = require('./drive_root/db/utilites');

/**
 * Start the framework server
 * @param {Object} options - Options for start
 * @param {string} options.rootPath - Path to project root
 * @param {Object} options.config - Server config
 */
function start(options = {}) {
  // Сохраняем rootPath проекта для доступа из других модулей
  if (options.rootPath) {
    console.log(`[Framework] Setting PROJECT_ROOT to: ${options.rootPath}`);
    globalContext.setProjectRoot(options.rootPath);
    // Также устанавливаем переменную окружения для дочерних процессов (createDB.js)
    process.env.PROJECT_ROOT = options.rootPath;
    console.log(`[Framework] PROJECT_ROOT environment variable set: ${process.env.PROJECT_ROOT}`);
  } else {
    console.warn(`[Framework] WARNING: rootPath not provided in start() options!`);
  }
  
  // Optionally start the memory_store service so it's tied to framework lifecycle
  try {
    const memoryStore = require('./drive_root/memory_store');
    // start service in background (port from env MEMORY_STORE_PORT or default)
    try { memoryStore.startServiceProcess(); console.log('[Framework] memory_store service started'); } catch (e) { console.warn('[Framework] cannot start memory_store service', e); }
    // Ensure service is stopped on exit
    process.on('exit', () => { try { memoryStore.stopServiceProcess(); } catch (_) {} });
    process.on('SIGINT', () => { try { memoryStore.stopServiceProcess(); } catch (_) {} ; process.exit(0); });
    process.on('SIGTERM', () => { try { memoryStore.stopServiceProcess(); } catch (_) {} ; process.exit(0); });
  } catch (e) {
    console.warn('[Framework] memory_store module not available, skipping service spawn');
  }

  // Запускаем main_server.js из пакета my-old-space
  require(path.join(__dirname, 'main_server.js'));
}

module.exports = {
  start,
  globalContext,
  eventBus,
  SequelizeInstance,
  Utilities
};
