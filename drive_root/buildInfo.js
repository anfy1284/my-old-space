'use strict';

/**
 * buildInfo — какой версии код сейчас работает (16.10.2026).
 *
 * Зачем. Чтобы по копии базы прода ответить «какой это коммит и какие разовые
 * скрипты ему ещё нужны», версия должна попадать в базу. До сих пор в
 * `db_versions` писалось `npm_package_version` (пусто, когда сервер запущен не
 * через npm) и `version` из package.json фреймворка (вечное «1.0.0») — то есть
 * ничего.
 *
 * Откуда берётся:
 *  - приложение: переменная окружения `APP_COMMIT` (её передаёт сборка образа —
 *    в образ `.git` не попадает) → файл `version.json` в корне проекта
 *    (`{ "commit": "…" }`) → `git rev-parse` в корне (разработка; с пометкой
 *    `-dirty`, если есть незакоммиченные правки) → пусто;
 *  - фреймворк: `git rev-parse` в его каталоге → коммит, с которого npm его
 *    поставил (`node_modules/.package-lock.json`, поле `resolved`) → пусто.
 *
 * Пустое значение — честный ответ «неизвестно», а не ошибка: старт сервера от
 * этого не зависит.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FRAMEWORK_ROOT = path.join(__dirname, '..');

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function git(cwd, args) {
    if (!fs.existsSync(path.join(cwd, '.git'))) return '';
    try {
        return String(execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })).trim();
    } catch (_) { return ''; }
}

function gitCommit(cwd) {
    const head = git(cwd, 'rev-parse --short=12 HEAD');
    if (!head) return '';
    const dirty = git(cwd, 'status --porcelain --untracked-files=no');
    return dirty ? `${head}-dirty` : head;
}

function projectRoot() {
    return process.env.PROJECT_ROOT || process.cwd();
}

function join(version, commit) {
    if (version && commit) return `${version}+${commit}`;
    return version || commit || '';
}

function appVersion() {
    const root = projectRoot();
    const pkg = readJson(path.join(root, 'package.json')) || {};
    let commit = String(process.env.APP_COMMIT || '').trim();
    if (!commit) {
        const v = readJson(path.join(root, 'version.json'));
        if (v && v.commit) commit = String(v.commit).trim();
    }
    if (!commit) commit = gitCommit(root);
    if (/^[0-9a-f]{13,}$/i.test(commit)) commit = commit.slice(0, 12);
    return join(pkg.version || '', commit);
}

function frameworkVersion() {
    const pkg = readJson(path.join(FRAMEWORK_ROOT, 'package.json')) || {};
    let commit = gitCommit(FRAMEWORK_ROOT);
    if (!commit) {
        const lock = readJson(path.join(projectRoot(), 'node_modules', '.package-lock.json'));
        const entry = lock && lock.packages && lock.packages['node_modules/my-old-space'];
        const m = entry && entry.resolved && String(entry.resolved).match(/#([0-9a-f]{7,40})$/i);
        if (m) commit = m[1].slice(0, 12);
    }
    return join(pkg.version || '', commit);
}

let cached = null;
/** `{ appVersion, frameworkVersion }`, считается один раз на процесс. */
function get() {
    if (!cached) cached = { appVersion: appVersion(), frameworkVersion: frameworkVersion() };
    return cached;
}

module.exports = { get, appVersion, frameworkVersion };
