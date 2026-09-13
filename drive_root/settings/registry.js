'use strict';

/**
 * registry — реестр объявленных настроек и уровней.
 *
 * Приложение объявляет свои настройки файлом `settings.json` в корне приложения (рядом
 * с `config.json`, а не в `db/`: это не схема базы). Ядро собирает такие файлы при
 * старте тем же принципом, что и `db.json`, — см. tmp/ТЗ_НАСТРОЙКИ_ПРИЛОЖЕНИЙ.md.
 *
 * ── Уровень (scope) ──────────────────────────────────────────────────────────
 * Уровень — это пара «таблица + UID записи», а не отдельный механизм. Встроены два
 * уровня без владельца (`system`, `default`) и один по таблице (`user` → `users`:
 * таблица фреймворка, есть всегда). Всё остальное объявляют приложения — уровень
 * объявляет то приложение, которому принадлежит таблица (`organizations` и `hotels` —
 * приложение `common` проекта). Добавление уровня НЕ создаёт таблиц.
 *
 * ── Почему объявления в файле, а не в базе ────────────────────────────────────
 * Старый механизм держал описания настроек строками `defaultValues.json`: добавить
 * настройку значило дописать сид и знать UID типа. Объявление — это код: оно версионируется
 * вместе с приложением и не может «разъехаться» с тем, что код читает.
 *
 * @module drive_root/settings/registry
 */

const fs = require('fs');
const path = require('path');
const log = require('../log');
const { enumerateApps } = require('../appsRegistry');
const types = require('./types');

/** Служебные значения `scopeTable` для уровней без записи-владельца. */
const SYSTEM_SCOPE_TABLE  = '__system';
const DEFAULT_SCOPE_TABLE = '__default';

/** Вид строки значений (`settings_values.kind`). */
const KIND_SETTING = 'setting';
const KIND_STATE   = 'state';

/** Имя приложения для настроек самого фреймворка. */
const CORE_APP = 'core';

/** Имя приложения для настроек решения в целом (корневой settings.json проекта). */
const PROJECT_APP = 'project';

const VISIBILITIES = new Set(['user', 'admin']);

/** Вид контрола там, где их несколько (пока только enum: список или радио-группа). */
const CONTROLS = new Set(['list', 'radio']);

/**
 * Встроенные уровни.
 *
 * `default` в списке для полноты картины, но настройка объявить его своим уровнем не
 * может: дефолт — не «кому принадлежит значение», а нижняя ступень чтения.
 */
const BUILTIN_SCOPES = {
    default: {
        name: 'default', table: null, displayField: null, ownerless: true,
        scopeTable: DEFAULT_SCOPE_TABLE, assignable: false, adminOnly: true,
        caption: { i18n: 'settings_scope_default' },
        icon: '/apps/general_icons/resources/public/16x16/settings.png',
        order: 90, declaredBy: CORE_APP
    },
    system: {
        name: 'system', table: null, displayField: null, ownerless: true,
        scopeTable: SYSTEM_SCOPE_TABLE, assignable: true, adminOnly: true,
        caption: { i18n: 'settings_scope_system' },
        icon: '/apps/general_icons/resources/public/16x16/settings.png',
        order: 80, declaredBy: CORE_APP
    },
    user: {
        name: 'user', table: 'users', displayField: 'name', ownerless: false,
        scopeTable: 'users', assignable: true, adminOnly: false,
        caption: { i18n: 'settings_scope_user' },
        icon: '/apps/general_icons/resources/public/16x16/user.png',
        order: 10, declaredBy: CORE_APP
    }
};

let _loaded = false;
let _loadedFor = null;
let _apps = new Map();     // appName → { name, caption, icon, order, dir, source, settings: Map }
let _scopes = new Map();   // scopeName → объявление уровня
let _errors = [];

/** Ошибка объявления: в лог с явным маркером и в сводку. Сервер не роняем. */
function declError(where, message) {
    const text = `${where}: ${message}`;
    _errors.push(text);
    log.error('[settings] ОШИБКА ОБЪЯВЛЕНИЯ —', text);
}

/**
 * Файлы объявлений: фреймворк (`core`), приложения, решение в целом (`project`).
 *
 * Объявления ядра лежат в `settings/core.settings.json`, а не в `drive_root/settings.json`:
 * Node при `require('./settings')` берёт `settings.json` РАНЬШЕ каталога `settings/`,
 * и файл объявлений подменил бы собой весь модуль настроек.
 *
 * Корневой `<PROJECT_ROOT>/settings.json` — для настроек, которые принадлежат решению, а
 * не отдельному приложению: язык документов читают и `invoice`, и `reports`, и приписать
 * его одному из них значило бы, что второй лезет в чужие настройки. Ровно так же устроен
 * корневой `i18n.json`. Настройка, у которой хозяин есть, живёт в его `settings.json` —
 * корневой файл не свалка.
 */
function declarationFiles(projectRoot) {
    const files = [];
    const corePath = path.join(__dirname, 'core.settings.json');
    if (fs.existsSync(corePath)) files.push({ appName: CORE_APP, file: corePath, dir: __dirname, source: 'framework' });
    for (const app of enumerateApps(projectRoot)) {
        const file = path.join(app.dir, 'settings.json');
        if (fs.existsSync(file)) files.push({ appName: app.name, file, dir: app.dir, source: app.source });
    }
    if (projectRoot) {
        const projectFile = path.join(projectRoot, 'settings.json');
        if (fs.existsSync(projectFile)) files.push({ appName: PROJECT_APP, file: projectFile, dir: projectRoot, source: 'project' });
    }
    return files;
}

/** Разбор блока `scopes` одного файла. */
function readScopes(raw, appName, file) {
    for (const [name, decl] of Object.entries(raw.scopes || {})) {
        if (BUILTIN_SCOPES[name]) {
            declError(file, `уровень "${name}" встроенный, переобъявлять нельзя`);
            continue;
        }
        if (_scopes.has(name)) {
            declError(file, `уровень "${name}" уже объявлен приложением "${_scopes.get(name).declaredBy}"`);
            continue;
        }
        if (!decl || !decl.table) {
            declError(file, `уровень "${name}": не указана таблица`);
            continue;
        }
        _scopes.set(name, {
            name,
            table: String(decl.table),
            displayField: decl.displayField || 'name',
            ownerless: false,
            scopeTable: String(decl.table),
            assignable: true,
            adminOnly: decl.adminOnly === true,
            caption: decl.caption || { i18n: `settings_scope_${name}` },
            icon: decl.icon || null,
            order: Number.isFinite(decl.order) ? decl.order : 50,
            declaredBy: appName
        });
        if (!decl.icon) log.warn(`[settings] уровень "${name}" объявлен без иконки (${file})`);
    }
}

/** Разбор блока `settings` одного файла. Уровни к этому моменту уже собраны все. */
function readSettings(raw, appName, file) {
    const app = _apps.get(appName);
    for (const [key, decl] of Object.entries(raw.settings || {})) {
        const where = `${file} → "${key}"`;

        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
            declError(where, 'недопустимый идентификатор (латиница, цифры, подчёркивание; начинается с буквы)');
            continue;
        }
        if (!decl || typeof decl !== 'object') { declError(where, 'объявление не объект'); continue; }

        const scope = _scopes.get(decl.scope);
        if (!scope) { declError(where, `уровень "${decl.scope}" не объявлен`); continue; }
        if (!scope.assignable) { declError(where, `уровень "${decl.scope}" нельзя назначить настройке`); continue; }

        if (!types.isKnownType(decl.type)) {
            declError(where, `неизвестный тип "${decl.type}" (допустимо: ${Array.from(types.TYPES).join(', ')})`);
            continue;
        }
        if (decl.type === 'enum') {
            const opts = Array.isArray(decl.options) ? decl.options : [];
            if (!opts.length) { declError(where, 'тип enum без options'); continue; }
            if (opts.some(o => !o || o.value === undefined)) { declError(where, 'в options есть вариант без value'); continue; }
        }
        if (decl.type === 'reference' && !(decl.reference && decl.reference.table)) {
            declError(where, 'тип reference без reference.table');
            continue;
        }
        const visibility = decl.visibility || 'user';
        if (!VISIBILITIES.has(visibility)) {
            declError(where, `visibility "${visibility}" — допустимо: ${Array.from(VISIBILITIES).join(', ')}`);
            continue;
        }
        if (!decl.caption) log.warn(`[settings] ${where}: нет caption — в форме будет виден идентификатор`);
        // `control` выбирает вид контрола там, где их несколько: enum рисуется списком
        // либо радио-группой. Неизвестное значение — ошибка объявления, а не тихий откат
        // к умолчанию: автор ждёт одного вида, а получает другой.
        if (decl.control && !CONTROLS.has(decl.control)) {
            declError(where, `неизвестный control "${decl.control}" (допустимо: ${Array.from(CONTROLS).join(', ')})`);
            continue;
        }

        const normalized = {
            app: appName,
            key,
            scope: scope.name,
            type: decl.type,
            caption: decl.caption || key,
            hint: decl.hint || null,
            options: decl.type === 'enum' ? decl.options : null,
            control: decl.control || null,
            reference: decl.type === 'reference' ? {
                table: String(decl.reference.table),
                displayField: decl.reference.displayField || 'name'
            } : null,
            visibility,
            group: decl.group || null,
            order: Number.isFinite(decl.order) ? decl.order : 50,
            default: null
        };

        // Дефолт проверяется тем же кодом, что и любое значение: объявление с
        // невозможным дефолтом — ошибка объявления, а не сюрприз при первом чтении.
        const checked = types.validate(normalized, decl.default === undefined ? null : decl.default);
        if (!checked.ok) { declError(where, `значение по умолчанию — ${checked.error}`); continue; }
        normalized.default = checked.value;

        if (app.settings.has(key)) { declError(where, 'идентификатор повторяется в этом же приложении'); continue; }
        app.settings.set(key, normalized);
    }
}

/**
 * Собрать реестр. Вызывается один раз при старте (drive_forms/init.js) и в процессе
 * миграции (засев дефолтов).
 *
 * @param {string} [projectRoot]
 * @returns {{apps: number, scopes: number, settings: number, errors: string[]}}
 */
function load(projectRoot) {
    const root = projectRoot || process.env.PROJECT_ROOT || process.cwd();
    _apps = new Map();
    _scopes = new Map();
    _errors = [];

    for (const [name, decl] of Object.entries(BUILTIN_SCOPES)) _scopes.set(name, Object.assign({}, decl));

    const files = declarationFiles(root);
    const parsed = [];

    // Проход 1 — приложения и уровни. Уровень объявляется в одном приложении, а
    // пользуются им настройки другого (уровень `hotel` объявляет `common`, настройки
    // на нём — `booking`), поэтому все уровни должны быть известны до разбора настроек.
    for (const entry of files) {
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
        } catch (e) {
            declError(entry.file, `не разобран: ${e.message}`);
            continue;
        }
        const appBlock = raw.app || {};
        _apps.set(entry.appName, {
            name: entry.appName,
            caption: appBlock.caption || entry.appName,
            hasCaption: !!appBlock.caption,
            icon: appBlock.icon || null,
            order: Number.isFinite(appBlock.order) ? appBlock.order : 50,
            dir: entry.dir,
            source: entry.source,
            settings: new Map()
        });
        readScopes(raw, entry.appName, entry.file);
        parsed.push({ raw, entry });
    }

    // Проход 2 — настройки.
    for (const { raw, entry } of parsed) readSettings(raw, entry.appName, entry.file);

    // Приложение без единой настройки в реестре не держим: вкладку рисовать нечем.
    // (Файл только с блоком `scopes` — законный случай: `apps/common` объявляет уровни
    // «организация» и «гостиница», а настроек на них не имеет.)
    for (const [name, app] of Array.from(_apps)) {
        if (app.settings.size === 0) _apps.delete(name);
    }

    // Про подпись и иконку ругаемся только тем, у кого вкладка будет: файлу с одними
    // уровнями блок `app` не нужен, и предупреждение о нём — шум в каждом старте.
    for (const app of _apps.values()) {
        if (!app.hasCaption) log.warn(`[settings] приложение "${app.name}": нет app.caption — вкладка будет названа именем приложения`);
        if (!app.icon) log.warn(`[settings] приложение "${app.name}": нет app.icon`);
    }

    _loaded = true;
    _loadedFor = root;

    const total = Array.from(_apps.values()).reduce((n, a) => n + a.settings.size, 0);
    log.info(`[settings] реестр: ${_apps.size} приложение(й), ${_scopes.size} уровень(ей), ${total} настроек(и)`);
    if (_errors.length) log.error(`[settings] объявления с ошибками: ${_errors.length} — эти настройки НЕ работают:\n  - ${_errors.join('\n  - ')}`);

    return { apps: _apps.size, scopes: _scopes.size, settings: total, errors: _errors.slice() };
}

function ensureLoaded(projectRoot) {
    const root = projectRoot || process.env.PROJECT_ROOT || process.cwd();
    if (!_loaded || _loadedFor !== root) load(root);
}

/**
 * Проверить, что таблицы уровней и справочников существуют.
 *
 * Отдельным шагом от `load`, потому что реестр собирается раньше моделей. Опечатка в
 * имени таблицы иначе всплыла бы через полгода как молчаливый `null`.
 *
 * @param {Iterable<string>} tableNames — имена существующих таблиц
 * @returns {string[]} новые ошибки
 */
function validateTables(tableNames) {
    const known = new Set(tableNames || []);
    if (!known.size) return [];
    const found = [];

    for (const scope of _scopes.values()) {
        if (scope.ownerless) continue;
        if (!known.has(scope.table)) {
            const text = `уровень "${scope.name}" (объявлен в "${scope.declaredBy}"): таблицы "${scope.table}" не существует`;
            found.push(text);
            _errors.push(text);
            log.error('[settings] ОШИБКА ОБЪЯВЛЕНИЯ —', text);
            scope.broken = true;
        }
    }
    // Настройки битого уровня тоже нерабочие: адресовать значение нечем.
    // Без этого они попали бы в форму и падали бы при первой же записи.
    for (const app of _apps.values()) {
        for (const decl of app.settings.values()) {
            const scope = _scopes.get(decl.scope);
            if (scope && scope.broken) decl.broken = true;
        }
    }
    for (const app of _apps.values()) {
        for (const decl of app.settings.values()) {
            if (decl.type !== 'reference') continue;
            if (!known.has(decl.reference.table)) {
                const text = `${app.name} → "${decl.key}": справочника "${decl.reference.table}" не существует`;
                found.push(text);
                _errors.push(text);
                log.error('[settings] ОШИБКА ОБЪЯВЛЕНИЯ —', text);
                decl.broken = true;
            }
        }
    }
    return found;
}

// ── Доступ к реестру ─────────────────────────────────────────────────────────

function getScope(name)   { return _scopes.get(name) || null; }
function getScopes()      { return Array.from(_scopes.values()).sort((a, b) => a.order - b.order); }
function getApp(appName)  { return _apps.get(appName) || null; }
function getApps()        { return Array.from(_apps.values()).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)); }

function getSetting(appName, key) {
    const app = _apps.get(appName);
    if (!app) return null;
    const decl = app.settings.get(key);
    return (decl && !decl.broken) ? decl : null;
}

/** Все настройки приложения (без битых). */
function getSettings(appName) {
    const app = _apps.get(appName);
    if (!app) return [];
    return Array.from(app.settings.values()).filter(d => !d.broken)
        .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

/** Настройки уровня по всем приложениям: [{ app, settings: [] }]. */
function listByScope(scopeName) {
    const out = [];
    for (const app of getApps()) {
        const settings = getSettings(app.name).filter(d => d.scope === scopeName);
        if (settings.length) out.push({ app, settings });
    }
    return out;
}

function getErrors() { return _errors.slice(); }

function reset() {
    _loaded = false; _loadedFor = null;
    _apps = new Map(); _scopes = new Map(); _errors = [];
}

module.exports = {
    load, ensureLoaded, validateTables, reset,
    getScope, getScopes, getApp, getApps, getSetting, getSettings, listByScope, getErrors,
    SYSTEM_SCOPE_TABLE, DEFAULT_SCOPE_TABLE, KIND_SETTING, KIND_STATE, CORE_APP, PROJECT_APP
};
