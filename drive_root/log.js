/**
 * log.js — единый логгер с уровнями (ТЗ «Оптимизация фреймворка», п. 0.6).
 *
 * Проблема: console.log на КАЖДЫЙ HTTP-запрос (включая каждую иконку), на
 * КАЖДУЮ DB-операцию (с JSON.stringify where!), по 2–5 строк на каждый RPC.
 * Консольный вывод — синхронный I/O; на хостингах с журналированием stdout
 * (Docker/journald) это заметный налог на CPU и забитые логи.
 *
 * Решение: уровни error/warn/info/debug, порог из LOG_LEVEL. В production
 * по умолчанию `warn` — горячие debug-логи замолкают без удаления кода.
 *
 *   LOG_LEVEL=error|warn|info|debug   (default: warn в production, иначе info)
 *
 * Замена в горячих путях: console.log → log.debug (виден только при
 * LOG_LEVEL=debug). console.error/console.warn оставляем как есть либо через
 * log.error/log.warn — они проходят всегда (важные события).
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function resolveLevel() {
    const env = String(process.env.LOG_LEVEL || '').toLowerCase();
    if (LEVELS[env] != null) return LEVELS[env];
    return process.env.NODE_ENV === 'production' ? LEVELS.warn : LEVELS.info;
}

let currentLevel = resolveLevel();

function enabled(level) {
    return LEVELS[level] <= currentLevel;
}

function error(...args) { if (enabled('error')) console.error(...args); }
function warn(...args) { if (enabled('warn')) console.warn(...args); }
function info(...args) { if (enabled('info')) console.log(...args); }
function debug(...args) { if (enabled('debug')) console.log(...args); }

/** Позволяет менять уровень в рантайме (например, из админки). */
function setLevel(name) {
    const v = LEVELS[String(name || '').toLowerCase()];
    if (v != null) currentLevel = v;
}

module.exports = { error, warn, info, debug, enabled, setLevel, LEVELS };
