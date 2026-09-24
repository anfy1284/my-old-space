'use strict';

/**
 * postingHandlers — реестр ОБРАБОТЧИКОВ ПРОВЕДЕНИЯ приложений.
 *
 * ── Зачем отдельный реестр, если есть `entityHooks.register` ──────────────────
 * Потому что проведение выполняется в ДРУГОМ ПРОЦЕССЕ. Исполнитель очереди —
 * тип регламентной задачи, а задачи планировщика идут в форкнутом воркере
 * (`drive_root/scheduler/worker.js`). `init.js` приложения выполняет ТОЛЬКО
 * главный процесс, поэтому обработчик, зарегистрированный там императивно, в
 * воркере не существует, и проведение падает с «обработчик не зарегистрирован».
 * Поймано живым прогоном: документ ушёл в очередь, воркер его взял и отказался.
 *
 * Ровно та же причина, по которой типы регламентных задач объявляются файлом
 * `scheduler.handlers.js`, а не побочным эффектом `init.js` (см.
 * `drive_root/scheduler/registry.js`). Здесь — тот же приём для той же беды.
 *
 * ── Объявление ───────────────────────────────────────────────────────────────
 * Файл `apps/<app>/posting.handlers.js` — ЧИСТЫЙ МОДУЛЬ-ФАБРИКА без побочных
 * эффектов (его грузят оба процесса):
 *
 *     module.exports = function (modelsDB, Utilities) {
 *         return {
 *             'cash.postReceipt': postReceipt,     // именованные функции,
 *             'cash.postPayment': postPayment      // не анонимные замыкания
 *         };
 *     };
 *
 * Обработчик получает `(doc, ctx)` — см. `drive_root/db/posting.js`.
 *
 * `entityHooks.register` остаётся рабочим запасным путём: механизм проведения
 * ищет обработчика сначала здесь, потом там. Но полагаться на него нельзя —
 * в воркере его не будет.
 */

const fs = require('fs');
const path = require('path');

const HANDLERS_FILE = 'posting.handlers.js';

let _handlers = null;   // Map<name, fn>

/** Каталоги приложений: сначала проект (перекрывает), затем фреймворк. */
function collectAppDirs() {
    const projectRoot = process.env.PROJECT_ROOT
        || (function () { try { return require('../globalServerContext').getProjectRoot(); } catch (e) { return null; } })();
    const frameworkRoot = path.join(__dirname, '..', '..');

    let appsBasePath = 'apps';
    const appNames = [];
    const readAppsJson = (p) => {
        if (!fs.existsSync(p)) return;
        try {
            const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (typeof cfg.path === 'string' && cfg.path) appsBasePath = cfg.path.replace(/^[/\\]+/, '');
            for (const app of (cfg.apps || [])) {
                if (app && app.name && !appNames.includes(app.name)) appNames.push(app.name);
            }
        } catch (e) {
            console.error(`[postingHandlers] Битый apps.json: ${p}: ${e.message}`);
        }
    };
    readAppsJson(path.join(frameworkRoot, 'drive_forms', 'apps.json'));
    readAppsJson(path.join(frameworkRoot, 'apps.json'));
    if (projectRoot) readAppsJson(path.join(projectRoot, 'apps.json'));

    const baseDirs = [];
    if (projectRoot) baseDirs.push(path.join(projectRoot, appsBasePath));
    baseDirs.push(path.join(frameworkRoot, appsBasePath));
    return { appNames, baseDirs };
}

/**
 * Загрузить (или перечитать) реестр.
 * @param {object} [modelsDB]
 * @param {object} [Utilities]
 * @returns {Map<string, Function>}
 */
function load(modelsDB, Utilities) {
    const handlers = new Map();
    const { appNames, baseDirs } = collectAppDirs();

    for (const appName of appNames) {
        for (const baseDir of baseDirs) {
            const file = path.join(baseDir, appName, HANDLERS_FILE);
            if (!fs.existsSync(file)) continue;
            try {
                const factory = require(file);
                if (typeof factory !== 'function') {
                    console.error(`[postingHandlers] ${file}: модуль должен экспортировать функцию-фабрику`);
                    break;
                }
                const declared = factory(modelsDB, Utilities) || {};
                for (const [name, fn] of Object.entries(declared)) {
                    if (typeof fn !== 'function') {
                        console.error(`[postingHandlers] ${file}: "${name}" не функция`);
                        continue;
                    }
                    handlers.set(name, fn);
                }
                console.log(`[postingHandlers] ${appName}: обработчиков ${Object.keys(declared).length}`);
            } catch (e) {
                console.error(`[postingHandlers] Ошибка загрузки ${file}: ${e && e.message || e}`);
            }
            break; // проектный файл перекрывает фреймворковый
        }
    }

    _handlers = handlers;
    return handlers;
}

function ensureLoaded(modelsDB, Utilities) {
    if (!_handlers) {
        const globalCtx = (function () { try { return require('../globalServerContext'); } catch (e) { return null; } })();
        load(modelsDB || (globalCtx && globalCtx.modelsDB), Utilities);
    }
    return _handlers;
}

/**
 * Найти обработчик по имени. Сначала файловый реестр (виден обоим процессам),
 * затем `entityHooks` (императивная регистрация, видна только главному).
 * @param {string} name
 * @returns {Function|null}
 */
function resolve(name) {
    if (!name) return null;
    const reg = ensureLoaded();
    const fn = reg.get(name);
    if (fn) return fn;
    try {
        return require('../entityHooks').resolve(name);
    } catch (e) {
        return null;
    }
}

/** Имена всех объявленных обработчиков — для диагностики. */
function list() {
    return Array.from(ensureLoaded().keys());
}

module.exports = { HANDLERS_FILE, load, ensureLoaded, resolve, list };
