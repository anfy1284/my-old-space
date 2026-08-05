'use strict';

/**
 * engine — движок планировщика регламентных заданий.
 *
 * Тик раз в 30 секунд выбирает задачи, которым пора, атомарно их захватывает и
 * отдаёт процессу-воркеру. Долгая задача не должна блокировать event loop главного
 * процесса — иначе UI подвисает у всех, поэтому исполнение вынесено в отдельный
 * процесс (`worker.js`), а главный только диспетчеризует.
 *
 * Работа со СВОИМИ служебными таблицами (`scheduler_*`, `sessions`) идёт с
 * `__SYS_INTERNAL__` — это единственное допустимое здесь место системного контекста.
 * ПРИКЛАДНЫЕ данные обработчик трогает только через служебную сессию (см. worker.js).
 */

const path = require('path');
const { fork } = require('child_process');

const dbGateway = require('../dbGateway');
const globalCtx = require('../globalServerContext');
const serviceSession = require('../serviceSession');
const log = require('../log');
const cron = require('./cron');
const registry = require('./registry');

const SYS = { sessionID: '__SYS_INTERNAL__' };
const TASKS = 'scheduler_tasks';
const RUNS = 'scheduler_runs';

const TICK_MS = 30 * 1000;            // гранулярность расписания — 1 минута, 30 с даёт запас
const HEARTBEAT_DEAD_MS = 3 * 60 * 1000;
const SIGKILL_GRACE_MS = 10 * 1000;
const CANCEL_GRACE_MS = 30 * 1000;

const state = {
    started: false,
    tickTimer: null,
    workers: [],                       // [{ proc, busy, runId }]
    queue: [],                         // [{ task, run, handlerCode, params }]
    active: new Map(),                 // runId → { task, run, worker, timeoutTimer, cancelTimer }
    retryTimers: new Map(),            // taskUID → Timeout
    poolSize: 1
};

// ── Мелкие обёртки над dbGateway ─────────────────────────────────────────────

const db = {
    read: (table, where, options) => dbGateway.execute({ operation: 'read', table, where, options, context: SYS }),
    findByPk: (table, uid) => dbGateway.execute({ operation: 'findByPk', table, where: { UID: uid }, context: SYS }),
    create: (table, data) => dbGateway.execute({ operation: 'create', table, data, context: SYS }),
    update: (table, where, data) => dbGateway.execute({ operation: 'update', table, where, data, context: SYS })
};

/** SSE-оповещение открытых списков/журналов (мутации идут мимо applyChanges). */
function notify(table, action, rowId) {
    try {
        require('../../apps/uniForm/server.js').notifyTableChange(table, action, rowId || null);
    } catch (e) { /* uniForm мог быть не поднят — не повод ронять тик */ }
}

const isEmpty = (v) => v === null || v === undefined || v === '';

/** Пустая дата в этой платформе — 0001-01-01, а не NULL (drive_root/db/emptyValues.js). */
function isRealDate(v) {
    if (isEmpty(v)) return false;
    const d = v instanceof Date ? v : new Date(v);
    return !isNaN(d.getTime()) && d.getUTCFullYear() > 1900;
}

const plain = (row) => (row && typeof row.get === 'function') ? row.get({ plain: true }) : row;

// ── Захват задачи ────────────────────────────────────────────────────────────

/**
 * Атомарный захват: `runningRunId` проставляется одним условным UPDATE.
 * Пустой результат → задачу уже забрал кто-то другой (второй инстанс сервера).
 * @returns {Promise<boolean>}
 */
async function claimTask(taskUID, runId) {
    const { Op } = require('sequelize');
    const res = await db.update(TASKS,
        { UID: taskUID, [Op.or]: [{ runningRunId: null }, { runningRunId: '' }] },
        { runningRunId: runId });
    const affected = Array.isArray(res) ? Number(res[0]) : Number(res);
    return affected > 0;
}

async function releaseTask(taskUID) {
    await db.update(TASKS, { UID: taskUID }, { runningRunId: '' });
}

// ── Пул воркеров ─────────────────────────────────────────────────────────────

function spawnWorker() {
    const workerPath = path.join(__dirname, 'worker.js');
    const proc = fork(workerPath, [], {
        env: { ...process.env, PROJECT_ROOT: process.env.PROJECT_ROOT || globalCtx.getProjectRoot() || '' },
        stdio: 'inherit'
    });
    const w = { proc, busy: false, runId: null };

    proc.on('message', (msg) => { handleWorkerMessage(w, msg).catch(e => log.error('[scheduler] worker message:', e)); });
    proc.on('exit', (code, signal) => {
        log.warn(`[scheduler] Воркер завершился (code=${code}, signal=${signal})`);
        const idx = state.workers.indexOf(w);
        if (idx >= 0) state.workers.splice(idx, 1);
        // Запуск, который вёл этот воркер, остался без исполнителя — закрываем его,
        // иначе задача навсегда останется «выполняющейся».
        if (w.runId && state.active.has(w.runId)) {
            const entry = state.active.get(w.runId);
            const status = entry.killReason || 'error';
            finishRun(w.runId, {
                status,
                errorText: entry.killReason
                    ? null
                    : 'Процесс-воркер завершился до окончания задачи'
            }).catch(e => log.error('[scheduler] finishRun after worker exit:', e));
        }
        if (state.started) setTimeout(() => { ensurePool(); pumpQueue(); }, 1000);
    });
    proc.on('error', (e) => log.error('[scheduler] Ошибка воркера:', e && e.message || e));

    state.workers.push(w);
    return w;
}

function ensurePool() {
    while (state.workers.length < state.poolSize) spawnWorker();
}

function freeWorker() {
    return state.workers.find(w => !w.busy) || null;
}

function pumpQueue() {
    while (state.queue.length) {
        const w = freeWorker();
        if (!w) return;
        const job = state.queue.shift();
        sendToWorker(w, job);
    }
}

function sendToWorker(w, job) {
    const entry = state.active.get(job.runId);
    if (!entry) return;
    w.busy = true;
    w.runId = job.runId;
    entry.worker = w;

    const timeoutSec = Number(job.task.timeoutSec) || 3600;
    entry.timeoutTimer = setTimeout(() => killRun(job.runId, 'timeout'), timeoutSec * 1000);

    try {
        w.proc.send({
            type: 'run',
            runId: job.runId,
            taskUID: job.task.UID,
            handler: job.task.handler,
            params: job.params,
            sessionID: job.sessionID,
            organizationId: job.task.organizationId || null,
            hotelId: job.task.hotelId || null,
            userId: job.task.userId || null
        });
    } catch (e) {
        finishRun(job.runId, { status: 'error', errorText: `Не удалось отправить задание воркеру: ${e && e.message || e}` })
            .catch(err => log.error('[scheduler] finishRun:', err));
    }
}

/** Принудительное завершение запуска: SIGTERM → через 10 с SIGKILL. */
function killRun(runId, reason) {
    const entry = state.active.get(runId);
    if (!entry || !entry.worker) return;
    entry.killReason = reason;             // exit-хендлер воркера закроет запуск этим статусом
    log.warn(`[scheduler] Запуск ${runId}: принудительное завершение (${reason})`);
    try { entry.worker.proc.kill('SIGTERM'); } catch (e) {}
    setTimeout(() => {
        try { if (entry.worker && !entry.worker.proc.killed) entry.worker.proc.kill('SIGKILL'); } catch (e) {}
    }, SIGKILL_GRACE_MS);
}

async function handleWorkerMessage(w, msg) {
    if (!msg || !msg.type) return;
    // Запуск уже приговорён (таймаут/отмена) — итог берём по причине убийства, а не по
    // тому, что успел ответить обработчик: иначе таймаут записался бы как «отменено».
    const doomed = msg.runId && state.active.get(msg.runId) && state.active.get(msg.runId).killReason;
    if (doomed && ['done', 'error', 'cancelled'].includes(msg.type)) {
        await finishRun(msg.runId, {
            status: doomed,
            errorText: msg.errorText || null,
            resultText: msg.resultText || null
        });
        return;
    }
    switch (msg.type) {
        case 'progress':
            log.info(`[scheduler] Запуск ${msg.runId}: ${msg.text}`);
            break;
        case 'heartbeat':
            await db.update(RUNS, { UID: msg.runId }, { lastHeartbeatAt: new Date() });
            break;
        case 'done':
            await finishRun(msg.runId, { status: 'success', resultText: msg.resultText || '' });
            break;
        case 'error':
            await finishRun(msg.runId, { status: 'error', errorText: msg.errorText || 'Ошибка без описания' });
            break;
        case 'cancelled':
            await finishRun(msg.runId, { status: 'cancelled', resultText: msg.resultText || '' });
            break;
        default:
            break;
    }
}

// ── Запуск задачи ────────────────────────────────────────────────────────────

/** Параметры задачи (ТЧ) → плоский объект с проверкой по схеме обработчика. */
async function loadParams(task) {
    const rows = await db.read('scheduler_task_params', { taskId: task.UID });
    const pairs = (rows || []).map(r => ({ key: plain(r).key, value: plain(r).value }));
    return registry.validateParams(task.handler, pairs);
}

/**
 * Поставить задачу на исполнение.
 * @param {Object} task — запись scheduler_tasks (plain)
 * @param {'schedule'|'manual'|'catchup'} triggeredBy
 * @param {number} attempt
 * @returns {Promise<{ok: boolean, runId?: string, errorKey?: string}>}
 */
async function dispatch(task, triggeredBy = 'schedule', attempt = 1) {
    const util = require('../db/utilites');
    let runId;
    try { runId = util.generateUID('SchedulerRuns'); }
    catch (e) { runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }

    if (!await claimTask(task.UID, runId)) {
        return { ok: false, errorKey: 'sched_err_already_running' };
    }

    // Следующее время считаем сразу: падение процесса не должно оставить
    // просроченный nextRunAt и породить лавину догоняющих запусков.
    const next = cron.computeNextRun(task, new Date());

    let sessionID = null;
    try {
        const handler = registry.get(task.handler);

        // Обработчик мог исчезнуть вместе с приложением. Молча пропускать нельзя —
        // иначе задача годами «работает» вхолостую.
        if (!handler) {
            await db.create(RUNS, {
                UID: runId, taskId: task.UID, organizationId: task.organizationId || null,
                userId: task.userId || null, startedAt: new Date(), finishedAt: new Date(),
                status: 'error', triggeredBy, attempt,
                errorText: `Неизвестный тип задачи: ${task.handler}`
            });
            await db.update(TASKS, { UID: task.UID }, {
                enabled: false, runningRunId: '', lastRunAt: new Date(), lastStatus: 'error', nextRunAt: next || null
            });
            notify(RUNS, 'create', runId);
            notify(TASKS, 'update', task.UID);
            log.error(`[scheduler] Задача "${task.caption}" выключена: неизвестный тип "${task.handler}"`);
            return { ok: false, errorKey: 'sched_err_unknown_handler' };
        }

        const validated = await loadParams(task);
        if (!validated.ok) {
            await db.create(RUNS, {
                UID: runId, taskId: task.UID, organizationId: task.organizationId || null,
                userId: task.userId || null, startedAt: new Date(), finishedAt: new Date(),
                status: 'error', triggeredBy, attempt,
                errorText: `Параметры задачи не прошли проверку: ${validated.errorKey} ${JSON.stringify(validated.vars || {})}`
            });
            await db.update(TASKS, { UID: task.UID }, {
                runningRunId: '', lastRunAt: new Date(), lastStatus: 'error', nextRunAt: next || null
            });
            notify(RUNS, 'create', runId);
            notify(TASKS, 'update', task.UID);
            return { ok: false, errorKey: validated.errorKey };
        }

        // Служебная сессия владельца — через неё задача видит ровно его данные.
        sessionID = await serviceSession.create({
            userId: task.userId,
            scopeOrganizationId: task.organizationId || null,
            taskRunId: runId,
            ttlSec: (Number(task.timeoutSec) || 3600) + 300
        });

        const startedAt = new Date();
        await db.create(RUNS, {
            UID: runId, taskId: task.UID, organizationId: task.organizationId || null,
            userId: task.userId || null, startedAt, status: 'running', triggeredBy, attempt,
            serviceSessionId: sessionID, lastHeartbeatAt: startedAt
        });
        await db.update(TASKS, { UID: task.UID }, { lastRunAt: startedAt, lastStatus: 'running', nextRunAt: next || null });
        notify(RUNS, 'create', runId);
        notify(TASKS, 'update', task.UID);

        state.active.set(runId, { task, startedAt, sessionID, attempt, triggeredBy, worker: null });
        state.queue.push({ runId, task, params: validated.values, sessionID });
        ensurePool();
        pumpQueue();
        return { ok: true, runId };
    } catch (e) {
        log.error('[scheduler] dispatch:', e && e.stack || e);
        if (sessionID) await serviceSession.destroy(sessionID);
        await releaseTask(task.UID);
        state.active.delete(runId);
        return { ok: false, errorKey: 'sched_err_dispatch_failed' };
    }
}

/** Закрыть запуск: журнал, освобождение задачи, служебная сессия, ретрай. */
async function finishRun(runId, { status, resultText = null, errorText = null }) {
    const entry = state.active.get(runId);
    state.active.delete(runId);
    if (entry) {
        if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
        if (entry.cancelTimer) clearTimeout(entry.cancelTimer);
        if (entry.worker) { entry.worker.busy = false; entry.worker.runId = null; }
    }

    const finishedAt = new Date();
    const startedAt = entry ? entry.startedAt : finishedAt;
    try {
        await db.update(RUNS, { UID: runId }, {
            status, finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(),
            resultText: resultText || '', errorText: errorText || ''
        });
        notify(RUNS, 'update', runId);
    } catch (e) {
        log.error('[scheduler] Не удалось записать итог запуска:', e && e.message || e);
    }

    if (entry && entry.sessionID) await serviceSession.destroy(entry.sessionID);

    const taskUID = entry ? entry.task.UID : null;
    if (taskUID) {
        try {
            const fresh = plain(await db.findByPk(TASKS, taskUID));
            const next = fresh ? cron.computeNextRun(fresh, new Date()) : null;
            await db.update(TASKS, { UID: taskUID }, { runningRunId: '', lastStatus: status, nextRunAt: next || null });
            notify(TASKS, 'update', taskUID);

            // Ретрай при ошибке/таймауте — отдельной записью журнала.
            const maxRetries = Number(fresh && fresh.maxRetries) || 0;
            const shouldRetry = (status === 'error' || status === 'timeout') && entry.attempt <= maxRetries;
            if (shouldRetry && state.started) {
                const delayMs = (Number(fresh.retryDelaySec) || 300) * 1000;
                log.info(`[scheduler] Задача "${fresh.caption}": повтор ${entry.attempt + 1} через ${delayMs / 1000} с`);
                const timer = setTimeout(() => {
                    state.retryTimers.delete(taskUID);
                    dispatch(fresh, entry.triggeredBy, entry.attempt + 1)
                        .catch(e => log.error('[scheduler] retry dispatch:', e));
                }, delayMs);
                state.retryTimers.set(taskUID, timer);
            }
        } catch (e) {
            log.error('[scheduler] Не удалось освободить задачу:', e && e.message || e);
        }
    }
    pumpQueue();
}

// ── Тик ──────────────────────────────────────────────────────────────────────

let _ticksSinceSweep = 0;

async function tick() {
    if (!state.started) return;
    try {
        const { Op } = require('sequelize');
        const now = new Date();

        // Раз в ~3 минуты перепроверяем «зависшие» запуски (см. sweepStuckRuns).
        if (++_ticksSinceSweep >= Math.ceil(HEARTBEAT_DEAD_MS / TICK_MS)) {
            _ticksSinceSweep = 0;
            await sweepStuckRuns();
        }
        const rows = await db.read(TASKS, {
            enabled: true,
            [Op.or]: [{ runningRunId: null }, { runningRunId: '' }]
        });
        for (const row of rows || []) {
            const task = plain(row);
            if (state.retryTimers.has(task.UID)) continue;      // ждём повтора — не дублируем
            if (!isRealDate(task.nextRunAt)) {
                // Время не рассчитано (только что включили задачу / сид) — считаем и ждём.
                const next = cron.computeNextRun(task, now);
                await db.update(TASKS, { UID: task.UID }, { nextRunAt: next || null });
                continue;
            }
            if (new Date(task.nextRunAt).getTime() > now.getTime()) continue;
            await dispatch(task, 'schedule', 1);
        }
    } catch (e) {
        log.error('[scheduler] Ошибка тика:', e && e.stack || e);
    }
}

// ── Старт / стоп ─────────────────────────────────────────────────────────────

/**
 * Подмести запуски, оставшиеся «выполняющимися» после падения процесса.
 *
 * Зовётся не только при старте, но и периодически из тика: сервер, перезапущенный
 * БЫСТРЕЕ, чем протухает heartbeat, при старте видит запуск ещё «живым» и не трогает
 * его — а исполнителя у запуска уже нет, и без повторной проверки задача осталась бы
 * заблокированной навсегда.
 */
async function sweepStuckRuns() {
    const deadline = new Date(Date.now() - HEARTBEAT_DEAD_MS);
    const rows = await db.read(RUNS, { status: 'running' });
    let n = 0;
    for (const row of rows || []) {
        const run = plain(row);
        if (state.active.has(run.UID)) continue;   // наш собственный живой запуск
        const hb = isRealDate(run.lastHeartbeatAt) ? new Date(run.lastHeartbeatAt)
            : (isRealDate(run.startedAt) ? new Date(run.startedAt) : new Date(0));
        if (hb.getTime() > deadline.getTime()) continue;
        await db.update(RUNS, { UID: run.UID }, {
            status: 'error', finishedAt: new Date(),
            errorText: 'Прервано остановкой сервера (нет сигнала жизни от исполнителя)'
        });
        await db.update(TASKS, { UID: run.taskId }, { runningRunId: '', lastStatus: 'error' });
        if (run.serviceSessionId) await serviceSession.destroy(run.serviceSessionId);
        n++;
    }
    if (n) log.info(`[scheduler] Закрыто зависших запусков: ${n}`);
    return n;
}

/** Пропущенные запуски: догнать ОДИН раз либо просто пересчитать время. */
async function handleMisfires() {
    const now = new Date();
    const rows = await db.read(TASKS, { enabled: true });
    for (const row of rows || []) {
        const task = plain(row);
        const missed = isRealDate(task.nextRunAt) && new Date(task.nextRunAt).getTime() < now.getTime();
        if (missed && (task.misfirePolicy || 'runOnce') === 'runOnce') {
            log.info(`[scheduler] Догоняющий запуск задачи "${task.caption}"`);
            await dispatch(task, 'catchup', 1);
            continue;                                   // nextRunAt пересчитан внутри dispatch
        }
        const next = cron.computeNextRun(task, now);
        await db.update(TASKS, { UID: task.UID }, { nextRunAt: next || null });
    }
}

/**
 * Запустить планировщик. Звать после инициализации моделей.
 * @param {Object} [opts]
 * @param {number} [opts.poolSize=1]
 */
async function start(opts = {}) {
    if (state.started) return;
    state.poolSize = Math.max(1, Number(opts.poolSize) || Number(process.env.SCHEDULER_POOL_SIZE) || 1);

    const { Utilities } = require('../../index.js');
    registry.load(globalCtx.modelsDB, Utilities);

    state.started = true;
    try {
        await serviceSession.sweepExpired();
        await sweepStuckRuns();
        await handleMisfires();
    } catch (e) {
        log.error('[scheduler] Ошибка инициализации:', e && e.stack || e);
    }

    ensurePool();
    state.tickTimer = setInterval(() => { tick().catch(e => log.error('[scheduler] tick:', e)); }, TICK_MS);
    log.info(`[scheduler] Планировщик запущен (воркеров: ${state.poolSize}, тик ${TICK_MS / 1000} с, типов задач: ${registry.list().length})`);
}

function stop() {
    state.started = false;
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
    for (const t of state.retryTimers.values()) clearTimeout(t);
    state.retryTimers.clear();
    for (const w of state.workers.slice()) { try { w.proc.kill('SIGTERM'); } catch (e) {} }
    state.workers.length = 0;
}

// ── Ручное управление (из формы) ─────────────────────────────────────────────

/** «Выполнить сейчас» — тот же путь, что и плановый запуск. */
async function runNow(taskUID) {
    const task = plain(await db.findByPk(TASKS, taskUID));
    if (!task) return { ok: false, errorKey: 'sched_err_task_not_found' };
    if (!isEmpty(task.runningRunId)) return { ok: false, errorKey: 'sched_err_already_running' };
    if (!state.started) return { ok: false, errorKey: 'sched_err_not_started' };
    return await dispatch(task, 'manual', 1);
}

/** «Остановить» — флаг отмены воркеру; игнорирующий его обработчик добивается. */
async function cancel(taskUID) {
    const task = plain(await db.findByPk(TASKS, taskUID));
    if (!task || isEmpty(task.runningRunId)) return { ok: false, errorKey: 'sched_err_not_running' };
    const runId = task.runningRunId;
    const entry = state.active.get(runId);
    if (!entry) {
        // Запуск ведёт другой процесс (или он уже мёртв) — освобождаем по heartbeat-таймауту.
        return { ok: false, errorKey: 'sched_err_cancel_foreign' };
    }
    if (entry.worker) {
        try { entry.worker.proc.send({ type: 'cancel', runId }); } catch (e) {}
        entry.cancelTimer = setTimeout(() => killRun(runId, 'cancelled'), CANCEL_GRACE_MS);
    } else {
        // Ещё в очереди — выбрасываем, не начиная.
        const idx = state.queue.findIndex(j => j.runId === runId);
        if (idx >= 0) state.queue.splice(idx, 1);
        await finishRun(runId, { status: 'cancelled', resultText: 'Отменено до начала выполнения' });
    }
    return { ok: true };
}

module.exports = { start, stop, tick, runNow, cancel, dispatch, state };
