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

// 3.6: на бесплатном хостинге с auto-sleep каждый wake = полный schema-sync
// (spawn createDB.js — второй Node-процесс строит ВСЕ модели и сравнивает схемы),
// и первые запросы пользователей ждут несколько секунд. SKIP_DB_SYNC=1 пропускает
// этот цикл целиком — уместно, когда схема не менялась с прошлого запуска (после
// первого успешного старта на том же деплое). Default (флаг не задан) — прежнее
// поведение: полная синхронизация при каждом старте.
const SKIP_DB_SYNC = process.env.SKIP_DB_SYNC === '1';

// Продолжение запуска ПОСЛЕ готовности БД — вызывается из exit-handler createDB
// либо напрямую при SKIP_DB_SYNC.
function proceedAfterDb() {
  // Load default values cache before starting the server
  return Promise.resolve(globalContext.reloadDefaultValues())
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

      // Сброс кэшей ДО того, как сервер начнёт обслуживать запросы.
      //
      // Зовётся при обычном старте, а не только после восстановления, по двум
      // причинам. Первая: `memory_store` — ОТДЕЛЬНЫЙ процесс, он переживает
      // перезапуск сервера и способен вернуть сессии, роли и справочники
      // ПРЕДЫДУЩЕЙ базы. Вторая: старт и восстановление обязаны идти одним путём
      // (инициализация БД → сброс кэшей → обслуживание), иначе через полгода это
      // будут два разных пути с разным набором забытого.
      //
      // Место вызова принципиально: ПОСЛЕ `createServer` (он загружает все
      // приложения, а подписчик регистрируется при загрузке своего модуля) и ДО
      // `listen` (иначе первые запросы успеют лечь на кэши прежней базы).
      try {
        await require('./drive_root/dbLifecycle').notifyDatabaseReset({ reason: 'startup' });
      } catch (e) {
        console.error('[main_server] Сброс кэшей при старте не выполнен:', e && e.message || e);
      }

      server.listen(PORT, () => {
        console.log(`Server running at ${protocol}://localhost:${PORT}`);
      });

      // Планировщик регламентных заданий. Стартует ПОСЛЕ инициализации БД и
      // подъёма сервера: тик и пул воркеров не должны задерживать listen.
      // Отключается переменной окружения SCHEDULER_DISABLED=1.
      try {
        const scheduler = require('./drive_root/scheduler');
        scheduler.start().catch(e => console.error('[main_server] Планировщик не запущен:', e && e.message || e));
        const shutdown = () => { try { scheduler.stop(); } catch (_) {} };
        process.on('exit', shutdown);
        process.on('SIGINT', () => { shutdown(); process.exit(0); });
        process.on('SIGTERM', () => { shutdown(); process.exit(0); });
      } catch (e) {
        console.error('[main_server] Ошибка загрузки планировщика:', e && e.message || e);
      }
    })
    .catch(err => {
      console.error('Error loading defaultValuesCache:', err && err.message || err);
      const { createServer } = require('./drive_root/server');
      const server = createServer();
      server.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT} (without default values cache)`);
      });
    });
}

// ── Старт при поднятом флаге обслуживания ───────────────────────────────────────
//
// Сервер ОБЯЗАН подниматься при отсутствующей или битой базе (ТЗ §6.2, приёмка §9
// п. 19). Стартовая последовательность синхронизирует модели и досевает справочники,
// то есть на пустой базе упала бы. Поэтому: увидел файл-флаг → пропустил фазу
// инициализации БД ЦЕЛИКОМ → занял порт → поднял только страницу обслуживания.
//
// Обычные приложения при этом не грузятся вовсе: их `init.js` ходит в базу, а базы
// может не быть. Пользователи в систему не допускаются ни при каком раскладе.
//
// Флаг НЕ снимается автоматически: иначе прерванное восстановление закончится тем,
// что сервер начнёт обслуживать полуразрушенные данные (см. drive_root/maintenance.js).
/** Обычный старт: инициализация БД отдельным процессом, затем подъём сервера. */
function bootNormally() {
  if (SKIP_DB_SYNC) {
    console.log('[main_server] SKIP_DB_SYNC=1 — schema-sync пропущен, старт сервера напрямую');
    return proceedAfterDb();
  }

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
    proceedAfterDb();
  });
}

const maintenanceFlag = require('./drive_root/maintenance');
if (maintenanceFlag.isActive()) {
  const st = maintenanceFlag.read() || {};
  console.warn('[main_server] РЕЖИМ ОБСЛУЖИВАНИЯ: инициализация БД пропущена'
    + ` (фаза обрыва: ${st.phase || 'неизвестна'})`);
  maintenanceFlag.audit(`SERVER_START_MAINTENANCE phase=${st.phase || ''} pid=${process.pid}`);

  // ПОСЛЕ ручного снятия блокировки сервер поднимается сам, без перезапуска.
  //
  // Без этого получался тупик: администратор снял блокировку на странице обслуживания,
  // а процесс так и остался отвечать 503 — он ведь стартовал БЕЗ инициализации базы и
  // приложений. Требовать в этот момент перезапуск значит вернуться к супервизору, от
  // которого мы ушли: под службой Windows или pm2 его ещё надо иметь, а из консоли
  // перезапускать некому. Поэтому страница обслуживания просто передаёт управление
  // обычному старту: слушатель освобождает порт, дальше идёт штатная последовательность.
  require('./drive_root/maintenanceServer').startStandalone(PORT, {
    onResume: (server) => new Promise((resolve) => {
      console.log('[main_server] Блокировка снята — передаю управление обычному старту');

      let handedOver = false;
      const handOver = () => { if (handedOver) return; handedOver = true; bootNormally(); resolve(); };

      // `close()` ждёт завершения ВСЕХ соединений, а браузер держит keep-alive и
      // отпускать его не собирается — без явного закрытия передача управления просто
      // не наступала, и сервер оставался молчащим. Поймано живым прогоном.
      server.close(handOver);
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      else if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();

      // Страховка: порт должен освободиться в любом случае, иначе обычный старт
      // упадёт с EADDRINUSE и мы получим тупик вместо выхода из тупика.
      setTimeout(handOver, 5000).unref();
    })
  });
} else {
  bootNormally();
}

module.exports = { server: null };
