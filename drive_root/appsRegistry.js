'use strict';

/**
 * appsRegistry — ЕДИНЫЙ обход приложений (фреймворка и проекта).
 *
 * Зачем отдельный модуль. Список приложений сейчас собирается в ЧЕТЫРЁХ местах, и
 * каждое делает это по-своему:
 *   - `globalServerContext.collectAllModelDefs` — по трём apps.json, каталог `<app>/db/db.json`;
 *   - `i18n.loadI18n` — приложения фреймворка через `readdir`, проекта — по apps.json;
 *   - `drive_forms/globalServerContext.loadApps` — по трём apps.json, с приоритетом «проект последний»;
 *   - `drive_forms/init.runAppInits` — снова по трём apps.json, но с другим набором каталогов.
 * Наборы расходятся: `readdir` видит приложение фреймворка, не зарегистрированное в
 * `drive_forms/apps.json` (например `UserSettings`), а обход по apps.json — нет. Пятая
 * копия ради `settings.json` (см. tmp/ТЗ_НАСТРОЙКИ_ПРИЛОЖЕНИЙ.md, §6.1) не пишется:
 * обход живёт здесь, потребители зовут `enumerateApps()`.
 *
 * Правило набора — как у i18n, самый широкий:
 *   1. приложения фреймворка — по факту наличия каталога в `<пакет>/apps`
 *      (регистрация в apps.json решает, грузится ли клиент, а не есть ли у приложения
 *      серверная часть: у `UserSettings` клиента в бандле нет, а init.js и i18n есть);
 *   2. приложения проекта — по `<PROJECT_ROOT>/apps.json` (там и только там перечислено,
 *      что проект считает своим: `booking_old` лежит на диске, но в списке его нет).
 * Одноимённое приложение проекта перекрывает приложение фреймворка — тот же приоритет,
 * что в `loadApps` и `runAppInits`.
 *
 * @module drive_root/appsRegistry
 */

const fs = require('fs');
const path = require('path');
const log = require('./log');

/** Корень пакета my-old-space. */
const PACKAGE_ROOT = path.resolve(__dirname, '..');

// Список каталогов кэшируется: за один старт его спрашивают несколько механизмов
// (модели, переводы, настройки), а состав приложений в рантайме не меняется —
// новое приложение появляется только с рестартом. Ключ — projectRoot: в одном
// процессе он один, но подмена проекта в тестах не должна отдавать чужой кэш.
let _cache = null;
let _cacheKey = null;

/** Убрать ведущие слэши: в apps.json пути пишут как `/booking`. */
function trimSlashes(s) {
    return String(s || '').replace(/^[/\\]+/, '');
}

/**
 * Приложения фреймворка — по факту наличия каталога.
 * @returns {Array<{name: string, dir: string, source: string}>}
 */
function frameworkApps() {
    const appsDir = path.join(PACKAGE_ROOT, 'apps');
    if (!fs.existsSync(appsDir)) return [];
    const out = [];
    for (const name of fs.readdirSync(appsDir)) {
        const dir = path.join(appsDir, name);
        try {
            if (!fs.statSync(dir).isDirectory()) continue;
        } catch (e) { continue; }
        out.push({ name, dir, source: 'framework' });
    }
    return out;
}

/**
 * Приложения проекта — по `<projectRoot>/apps.json`.
 * @returns {Array<{name: string, dir: string, source: string}>}
 */
function projectApps(projectRoot) {
    if (!projectRoot) return [];
    const appsJsonPath = path.join(projectRoot, 'apps.json');
    if (!fs.existsSync(appsJsonPath)) return [];
    let cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(appsJsonPath, 'utf8'));
    } catch (e) {
        log.error('[appsRegistry] apps.json проекта не прочитан:', e.message);
        return [];
    }
    const basePath = trimSlashes(cfg.path || 'apps');
    const out = [];
    for (const app of (cfg.apps || [])) {
        if (!app || !app.name) continue;
        const dir = path.join(projectRoot, basePath, trimSlashes(app.path || app.name));
        if (!fs.existsSync(dir)) {
            log.warn(`[appsRegistry] приложение "${app.name}" объявлено в apps.json, каталога нет: ${dir}`);
            continue;
        }
        out.push({ name: app.name, dir, source: 'project' });
    }
    return out;
}

/**
 * Все приложения системы.
 *
 * @param {string} [projectRoot] — корень проекта; по умолчанию `PROJECT_ROOT` или cwd
 * @returns {Array<{name: string, dir: string, source: 'framework'|'project'}>}
 */
function enumerateApps(projectRoot) {
    const root = projectRoot || process.env.PROJECT_ROOT || process.cwd();
    if (_cache && _cacheKey === root) return _cache;

    const byName = new Map();
    for (const app of frameworkApps()) byName.set(app.name, app);
    // Проект перекрывает фреймворк — как в loadApps и runAppInits.
    for (const app of projectApps(root)) byName.set(app.name, app);

    _cache = Array.from(byName.values());
    _cacheKey = root;
    return _cache;
}

/**
 * Каталог приложения по имени (или null).
 * @param {string} appName
 * @param {string} [projectRoot]
 */
function appDir(appName, projectRoot) {
    const found = enumerateApps(projectRoot).find(a => a.name === appName);
    return found ? found.dir : null;
}

/** Сбросить кэш обхода (тесты, подмена проекта). */
function reset() {
    _cache = null;
    _cacheKey = null;
}

module.exports = { enumerateApps, appDir, reset, PACKAGE_ROOT };
