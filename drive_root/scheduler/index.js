'use strict';

/**
 * scheduler — публичный API сервиса регламентных заданий фреймворка.
 *
 *   const scheduler = require('.../drive_root/scheduler');
 *   await scheduler.start();                       // из main_server.js
 *   scheduler.listHandlers();                      // типы задач для формы
 *   await scheduler.runNow(taskUID);               // «Выполнить сейчас»
 *   await scheduler.cancel(taskUID);               // «Остановить»
 *   scheduler.recalcSchedule(taskData);            // пересчёт cron/nextRunAt при сохранении
 *
 * Устройство: engine.js (тик, захват, диспетчеризация), worker.js (исполнение в
 * отдельном процессе), cron.js (расписание), registry.js (реестр типов задач).
 * Изоляция данных — служебные сессии (drive_root/serviceSession.js), НЕ `__SYS_INTERNAL__`.
 */

const engine = require('./engine');
const registry = require('./registry');
const cron = require('./cron');
const log = require('../log');

/**
 * Пересчитать вычисляемые реквизиты расписания. Зовётся из `onBeforeSave` формы:
 * `cronExpression` — снапшот полей конструктора, поэтому пересчитывается ВСЕГДА,
 * кроме режима `cron` (там истина — значение пользователя); заодно пересчитывается
 * `nextRunAt`, иначе расписание разъедется с настройками.
 *
 * @param {Object} task — данные задачи (после мерджа изменений)
 * @returns {{cronExpression: string, nextRunAt: Date|null}}
 */
function recalcSchedule(task) {
    const cronExpression = cron.buildCronExpression(task);
    const nextRunAt = task && task.enabled ? cron.computeNextRun(task, new Date()) : null;
    return { cronExpression, nextRunAt };
}

/** Запустить сервис. Отключается переменной окружения SCHEDULER_DISABLED=1. */
async function start(opts = {}) {
    if (process.env.SCHEDULER_DISABLED === '1') {
        log.info('[scheduler] SCHEDULER_DISABLED=1 — планировщик не запущен');
        return;
    }
    await engine.start(opts);
}

module.exports = {
    start,
    stop: engine.stop,
    runNow: engine.runNow,
    cancel: engine.cancel,
    listHandlers: registry.list,
    getHandler: registry.get,
    validateParams: registry.validateParams,
    recalcSchedule,
    describeSchedule: cron.describeSchedule,
    validateCron: cron.validateCron,
    computeNextRun: cron.computeNextRun,
    buildCronExpression: cron.buildCronExpression
};
