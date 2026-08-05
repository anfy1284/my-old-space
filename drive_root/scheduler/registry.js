'use strict';

/**
 * registry — реестр типов регламентных задач (обработчиков).
 *
 * Никакого `eval` и произвольных пользовательских скриптов: пользователь выбирает
 * тип задачи из зарегистрированных В КОДЕ и заполняет объявленные параметры.
 *
 * Обработчики объявляются ПО СОГЛАШЕНИЮ ОБ ИМЕНИ ФАЙЛА, а не побочным эффектом
 * `init.js`, потому что реестр нужен ДВУМ процессам: главному (форма показывает
 * список типов и схему параметров) и воркеру (исполняет). Поэтому файл обязан быть
 * чистым модулем-фабрикой без побочных эффектов:
 *
 *   apps/<app>/scheduler.handlers.js
 *   module.exports = function (modelsDB, Utilities) {
 *     return {
 *       'backup.create': {
 *         caption: { i18n: 'sched_handler_backup_create' },
 *         icon: '/apps/general_icons/resources/public/16x16/backup.png',
 *         scope: 'system',            // 'system' | 'organization' | 'any'
 *         paramsSchema: { keepCount: { type: 'integer', required: true, default: 7 } },
 *         run: async (ctx) => ({ resultText: '...' })
 *       }
 *     };
 *   };
 *
 * ctx, передаваемый в run: { sessionID, userId, organizationId, hotelId, params,
 *                            log(text), heartbeat(), isCancelled() }
 * ПРАВИЛО ДЛЯ АВТОРОВ ОБРАБОТЧИКОВ: любые обращения к данным — через dbGateway
 * с `ctx.sessionID`. Передавать `__SYS_INTERNAL__` внутри обработчика запрещено.
 */

const fs = require('fs');
const path = require('path');
const log = require('../log');

const HANDLERS_FILE = 'scheduler.handlers.js';
const SCOPES = new Set(['system', 'organization', 'any']);

let _handlers = null;   // Map<code, definition>

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
            log.error(`[scheduler/registry] Битый apps.json: ${p}: ${e.message}`);
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

/** Проверка объявления обработчика. Кривое объявление лучше отбросить с криком. */
function validateDefinition(code, def) {
    if (!def || typeof def !== 'object') return `обработчик "${code}": объявление должно быть объектом`;
    if (typeof def.run !== 'function') return `обработчик "${code}": нет функции run()`;
    if (def.scope && !SCOPES.has(def.scope)) return `обработчик "${code}": неизвестный scope "${def.scope}"`;
    return null;
}

/**
 * Загрузить (или перечитать) реестр обработчиков.
 * @param {Object} modelsDB
 * @param {Object} Utilities
 * @returns {Map<string, Object>}
 */
function load(modelsDB, Utilities) {
    const handlers = new Map();
    const { appNames, baseDirs } = collectAppDirs();

    for (const appName of appNames) {
        for (const baseDir of baseDirs) {
            const file = path.join(baseDir, appName, HANDLERS_FILE);
            if (!fs.existsSync(file)) continue;
            try {
                delete require.cache[require.resolve(file)];
                const factory = require(file);
                if (typeof factory !== 'function') {
                    log.error(`[scheduler/registry] ${file}: модуль должен экспортировать функцию-фабрику`);
                    break;
                }
                const declared = factory(modelsDB, Utilities) || {};
                for (const [code, def] of Object.entries(declared)) {
                    const err = validateDefinition(code, def);
                    if (err) { log.error(`[scheduler/registry] ${file}: ${err}`); continue; }
                    handlers.set(code, Object.assign({ code, appName, scope: 'any', paramsSchema: {} }, def));
                }
                log.info(`[scheduler/registry] ${appName}: обработчиков ${Object.keys(declared).length}`);
            } catch (e) {
                log.error(`[scheduler/registry] Ошибка загрузки ${file}: ${e && e.message || e}`);
            }
            break; // проектный файл перекрывает фреймворковый
        }
    }

    _handlers = handlers;
    return handlers;
}

function ensureLoaded(modelsDB, Utilities) {
    if (!_handlers) load(modelsDB, Utilities);
    return _handlers;
}

/** Определение обработчика по коду или null (обработчик мог исчезнуть с приложением). */
function get(code) {
    return (_handlers && _handlers.get(code)) || null;
}

/**
 * Метаданные всех обработчиков — для формы (список типов + схема параметров).
 * Функция `run` наружу не отдаётся.
 */
function list() {
    if (!_handlers) return [];
    return Array.from(_handlers.values()).map(h => ({
        code: h.code,
        caption: h.caption || h.code,
        icon: h.icon || null,
        scope: h.scope || 'any',
        appName: h.appName,
        paramsSchema: h.paramsSchema || {}
    }));
}

/**
 * Проверить набор параметров задачи против схемы обработчика.
 * @returns {{ok: boolean, errorKey?: string, vars?: Object, values?: Object}}
 */
function validateParams(code, pairs) {
    const def = get(code);
    if (!def) return { ok: false, errorKey: 'sched_err_unknown_handler', vars: { handler: code } };
    const schema = def.paramsSchema || {};
    const values = {};

    for (const p of (pairs || [])) {
        const key = p && p.key;
        if (!key) continue;
        if (!schema[key]) return { ok: false, errorKey: 'sched_err_unknown_param', vars: { key } };
        values[key] = p.value;
    }
    for (const [key, spec] of Object.entries(schema)) {
        const has = values[key] !== undefined && values[key] !== null && values[key] !== '';
        if (!has && spec.default !== undefined) values[key] = spec.default;
        else if (!has && spec.required) return { ok: false, errorKey: 'sched_err_param_required', vars: { key } };
        if (values[key] === undefined) continue;
        if (spec.type === 'integer' || spec.type === 'number') {
            const num = Number(values[key]);
            if (!isFinite(num)) return { ok: false, errorKey: 'sched_err_param_number', vars: { key } };
            values[key] = spec.type === 'integer' ? Math.trunc(num) : num;
        } else if (spec.type === 'boolean') {
            values[key] = (values[key] === true || values[key] === 'true' || values[key] === 1 || values[key] === '1');
        }
    }
    return { ok: true, values };
}

module.exports = { load, ensureLoaded, get, list, validateParams, SCOPES, HANDLERS_FILE };
