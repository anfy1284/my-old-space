/**
 * perfMetrics — лёгкое инструментирование производительности фреймворка.
 * (ТЗ «Оптимизация фреймворка», раздел «Инструментирование», пп. 1–3)
 *
 * 1. Per-request тайминги: общее время, время в БД, число DB-операций,
 *    разбивка по таблицам/операциям. Клиенту отдаётся заголовок Server-Timing,
 *    медленные запросы (>= PERF_SLOW_MS, по умолчанию 200 мс) логируются
 *    с request-id и разбивкой (session / db / other).
 * 2. Счётчик DB-операций на запрос: dbGateway.execute оборачивается в
 *    dbEnter()/dbExit() — привязка к HTTP-запросу через AsyncLocalStorage.
 *    Вложенные execute (RLS-подзапросы middleware) считаются в dbCount,
 *    но их время не суммируется в dbMs повторно (учёт только верхнего уровня).
 * 3. Периодический лог памяти: process.memoryUsage() + размеры всех
 *    namespace'ов memory_store (подтверждение/опровержение утечек).
 *
 * Управление через переменные окружения:
 *   PERF_SLOW_MS          — порог «медленного» запроса, мс (default 200)
 *   PERF_LOG_ALL=1        — логировать каждый запрос, а не только медленные
 *   PERF_MEM_LOG=0        — отключить периодический лог памяти
 *   PERF_MEM_LOG_INTERVAL — интервал лога памяти, сек (default 60)
 *
 * Инвариант: модуль не должен ломать обработку запросов ни при каких
 * условиях — всё взаимодействие с req/res и memory_store обёрнуто в try/catch.
 */

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

const SLOW_MS = Number(process.env.PERF_SLOW_MS) || 200;
const LOG_ALL = process.env.PERF_LOG_ALL === '1';

let requestCounter = 0;

function msSince(startNs) {
    return Number(process.hrtime.bigint() - startNs) / 1e6;
}

/**
 * Запустить обработку HTTP-запроса в контексте метрик.
 * Вызывается один раз на входе (drive_root/server.js → requestListener);
 * весь нижележащий код (drive_forms, dbGateway) видит контекст через ALS.
 */
function runWithRequest(req, res, fn) {
    const ctx = {
        id: ++requestCounter,
        method: req.method,
        url: req.url,
        startNs: process.hrtime.bigint(),
        dbCount: 0,      // все dbGateway.execute, включая вложенные (RLS)
        dbMs: 0,         // wall-clock время БД только верхнего уровня
        dbDepth: 0,
        dbAgg: new Map(),// 'table.operation' → { count, ms }
        marks: {},       // именованные тайминги (session, ...)
        details: {}      // произвольные метки (rpc: 'app.method', ...)
    };
    try { instrumentResponse(ctx, res); } catch (e) { /* метрики не ломают ответ */ }
    return als.run(ctx, fn);
}

function instrumentResponse(ctx, res) {
    const origWriteHead = res.writeHead;
    res.writeHead = function (...args) {
        try {
            if (!res.headersSent && !res.getHeader('Server-Timing')) {
                const parts = [
                    `total;dur=${msSince(ctx.startNs).toFixed(1)}`,
                    `db;dur=${ctx.dbMs.toFixed(1)};desc="${ctx.dbCount} ops"`
                ];
                for (const name of Object.keys(ctx.marks)) {
                    parts.push(`${name};dur=${ctx.marks[name].toFixed(1)}`);
                }
                res.setHeader('Server-Timing', parts.join(', '));
            }
        } catch (e) { /* никогда не ломаем ответ из-за метрик */ }
        return origWriteHead.apply(this, args);
    };
    res.on('finish', () => {
        try {
            const total = msSince(ctx.startNs);
            if (total >= SLOW_MS || LOG_ALL) {
                const session = ctx.marks.session || 0;
                const other = Math.max(0, total - ctx.dbMs - session);
                const rpc = ctx.details.rpc ? ` rpc=${ctx.details.rpc}` : '';
                const slowTag = total >= SLOW_MS ? 'SLOW ' : '';
                console.warn(
                    `[perf] ${slowTag}#${ctx.id} ${total.toFixed(0)}ms ${ctx.method} ${ctx.url}${rpc}` +
                    ` | db=${ctx.dbMs.toFixed(0)}ms/${ctx.dbCount}ops session=${session.toFixed(0)}ms other=${other.toFixed(0)}ms` +
                    summarizeDbAgg(ctx)
                );
            }
        } catch (e) { /* ignore */ }
    });
}

/** Топ-5 «table.operation» по времени — для лога медленных запросов. */
function summarizeDbAgg(ctx) {
    if (!ctx.dbAgg || ctx.dbAgg.size === 0) return '';
    const top = Array.from(ctx.dbAgg.entries())
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, 5)
        .map(([key, v]) => `${key}×${v.count}=${v.ms.toFixed(0)}ms`);
    return ' | top: ' + top.join(', ');
}

/** Зафиксировать именованный тайминг (например, session) от startNs до «сейчас». */
function markSince(name, startNs) {
    const ctx = als.getStore();
    if (!ctx) return;
    ctx.marks[name] = (ctx.marks[name] || 0) + msSince(startNs);
}

/** Произвольная метка для лога (например, имя RPC-метода). */
function setDetail(name, value) {
    const ctx = als.getStore();
    if (ctx) ctx.details[name] = value;
}

/** Вход в dbGateway.execute — возвращает стартовое время для dbExit. */
function dbEnter() {
    const ctx = als.getStore();
    if (ctx) ctx.dbDepth++;
    return process.hrtime.bigint();
}

/** Выход из dbGateway.execute: счётчик + агрегация по table.operation. */
function dbExit(table, operation, startNs) {
    const ctx = als.getStore();
    if (!ctx) return;
    const ms = msSince(startNs);
    ctx.dbDepth--;
    ctx.dbCount++;
    // Время суммируем только для верхнего уровня, иначе вложенные RLS-подзапросы
    // учитывались бы дважды (их время уже входит во внешнюю операцию).
    if (ctx.dbDepth === 0) ctx.dbMs += ms;
    const key = `${table}.${operation}`;
    const agg = ctx.dbAgg.get(key);
    if (agg) { agg.count++; agg.ms += ms; }
    else ctx.dbAgg.set(key, { count: 1, ms });
}

// ── Периодический лог памяти ─────────────────────────────────────────────────

let memTimer = null;

function startMemoryLogger() {
    if (memTimer) return;
    if (process.env.PERF_MEM_LOG === '0') return;
    const intervalSec = Number(process.env.PERF_MEM_LOG_INTERVAL) || 60;
    memTimer = setInterval(() => {
        try {
            const mu = process.memoryUsage();
            const mb = (b) => (b / 1048576).toFixed(1);
            let storeInfo = '';
            try {
                const memoryStore = require('./memory_store');
                const parts = [];
                for (const [ns, nsMap] of memoryStore._MEM) {
                    parts.push(`${ns}=${nsMap.size}`);
                }
                if (parts.length > 0) storeInfo = ' | store: ' + parts.join(' ');
            } catch (e) { /* ignore */ }
            console.log(
                `[perf] mem rss=${mb(mu.rss)}MB heap=${mb(mu.heapUsed)}/${mb(mu.heapTotal)}MB external=${mb(mu.external)}MB${storeInfo}`
            );
        } catch (e) { /* ignore */ }
    }, intervalSec * 1000);
    // Не держим процесс живым ради таймера метрик
    if (typeof memTimer.unref === 'function') memTimer.unref();
}

module.exports = {
    runWithRequest,
    markSince,
    setDetail,
    dbEnter,
    dbExit,
    startMemoryLogger
};
