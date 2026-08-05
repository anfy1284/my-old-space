'use strict';

/**
 * worker — процесс-исполнитель регламентных заданий.
 *
 * Поднимается через `child_process.fork` из engine.js и живёт до остановки сервера
 * (пул долгоживущих процессов). Своё подключение к БД и свой реестр обработчиков
 * поднимает САМ — именно поэтому обработчики объявляются файлом по соглашению об
 * имени (`apps/<app>/scheduler.handlers.js`), а не побочным эффектом `init.js`.
 *
 * Протокол IPC:
 *   главный → воркер: { type:'run', runId, taskUID, handler, params, sessionID,
 *                       organizationId, hotelId, userId }
 *                     { type:'cancel', runId }
 *   воркер → главный: { type:'progress'|'heartbeat'|'done'|'error'|'cancelled', ... }
 *
 * ГЛАВНОЕ ПРАВИЛО: прикладные данные обработчик читает и пишет ТОЛЬКО через
 * dbGateway со СЛУЖЕБНОЙ сессией (`ctx.sessionID`). `__SYS_INTERNAL__` внутри
 * обработчика запрещён — иначе RLS обходится там, где её никто не проверит.
 */

const path = require('path');
const fs = require('fs');

const HEARTBEAT_MS = 30 * 1000;

// ── Загрузка контекста фреймворка в отдельном процессе ───────────────────────
const globalCtx = require('../globalServerContext');
const projectRoot = process.env.PROJECT_ROOT || '';
if (projectRoot) {
    // Пересобирает модели с учётом приложений ПРОЕКТА (без этого воркер знает
    // только фреймворковые таблицы).
    globalCtx.setProjectRoot(projectRoot);
    // Проектный dbGateway регистрирует middleware RLS — без него служебная сессия
    // ничего не ограничивает, и весь смысл механизма теряется.
    try {
        const projGateway = path.join(projectRoot, 'dbGateway.js');
        if (fs.existsSync(projGateway)) require(projGateway);
    } catch (e) {
        console.error('[scheduler/worker] Не загружен проектный dbGateway:', e && e.message || e);
    }
}
try { require('../i18n').loadI18n(projectRoot || process.cwd()); } catch (e) { /* переводы не критичны для исполнения */ }

const registry = require('./registry');
const log = require('../log');

let Utilities = null;
try { Utilities = require('../../index.js').Utilities; } catch (e) { Utilities = null; }
registry.load(globalCtx.modelsDB, Utilities);

// ── Состояние текущего запуска ───────────────────────────────────────────────
const current = { runId: null, cancelled: false, heartbeatTimer: null };

function send(msg) {
    try { if (process.send) process.send(msg); } catch (e) { /* канал закрыт */ }
}

function startHeartbeat(runId) {
    stopHeartbeat();
    current.heartbeatTimer = setInterval(() => send({ type: 'heartbeat', runId }), HEARTBEAT_MS);
}

function stopHeartbeat() {
    if (current.heartbeatTimer) { clearInterval(current.heartbeatTimer); current.heartbeatTimer = null; }
}

async function runJob(msg) {
    current.runId = msg.runId;
    current.cancelled = false;
    startHeartbeat(msg.runId);

    const ctx = {
        sessionID: msg.sessionID,
        userId: msg.userId || null,
        organizationId: msg.organizationId || null,
        hotelId: msg.hotelId || null,
        params: msg.params || {},
        log: (text) => send({ type: 'progress', runId: msg.runId, text: String(text) }),
        heartbeat: () => send({ type: 'heartbeat', runId: msg.runId }),
        isCancelled: () => current.cancelled === true
    };

    try {
        const handler = registry.get(msg.handler);
        if (!handler) throw new Error(`Неизвестный тип задачи: ${msg.handler}`);

        const result = await handler.run(ctx);

        if (current.cancelled) {
            send({ type: 'cancelled', runId: msg.runId, resultText: (result && result.resultText) || '' });
        } else {
            send({ type: 'done', runId: msg.runId, resultText: (result && result.resultText) || '' });
        }
    } catch (e) {
        if (current.cancelled) {
            send({ type: 'cancelled', runId: msg.runId, resultText: (e && e.message) || '' });
        } else {
            send({ type: 'error', runId: msg.runId, errorText: `${e && e.message || e}\n${e && e.stack || ''}`.trim() });
        }
    } finally {
        stopHeartbeat();
        current.runId = null;
        current.cancelled = false;
    }
}

process.on('message', (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'run') {
        runJob(msg).catch(e => {
            send({ type: 'error', runId: msg.runId, errorText: String(e && e.message || e) });
        });
        return;
    }
    if (msg.type === 'cancel') {
        if (current.runId && current.runId === msg.runId) {
            current.cancelled = true;
            log.info(`[scheduler/worker] Запрошена отмена запуска ${msg.runId}`);
        }
    }
});

// SIGTERM приходит при таймауте/отмене — даём обработчику увидеть флаг отмены,
// добивание SIGKILL сделает главный процесс.
process.on('SIGTERM', () => { current.cancelled = true; });

log.info('[scheduler/worker] Готов');
send({ type: 'ready' });
