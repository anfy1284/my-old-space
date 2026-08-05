'use strict';

/**
 * Серверные функции формы «Регламентное задание» (таблица scheduler_tasks).
 *
 * Модуль-фабрика: module.exports = (modelsDB, Utilities) => ({ ... }).
 * Все RPC получают (params, ctx), ctx = { sessionID, user, role }.
 *
 * Данные читаются/пишутся через dbGateway с сессией ПОЛЬЗОВАТЕЛЯ — RLS применяется
 * штатно. `__SYS_INTERNAL__` здесь не место: это прикладная форма, а не служебная
 * бухгалтерия механизма.
 */

const dbGateway = require('../../../drive_root/dbGateway');
const globalCtx = require('../../../drive_root/globalServerContext');
const formsCtx = require('../../../drive_forms/globalServerContext');
const scheduler = require('../../../drive_root/scheduler');

const TASKS = 'scheduler_tasks';

module.exports = function (modelsDB, Utilities) {

    /** Организации, доступные пользователю (RLS сама отсекает чужие). */
    async function visibleOrganizations(sessionID) {
        try {
            const rows = await dbGateway.execute({
                operation: 'read', table: 'organizations',
                options: { raw: true }, context: { sessionID }
            });
            return (rows || []).map(r => r.UID);
        } catch (e) {
            // Таблицы организаций может не быть вовсе (фреймворк без прикладного слоя).
            return [];
        }
    }

    /**
     * Полные данные задачи: запись из БД + изменения формы.
     * Читаем ПОД СЕССИЕЙ ПОЛЬЗОВАТЕЛЯ — прикладная форма не имеет права обходить RLS.
     */
    async function effectiveTask(changes, parentUID, sessionID) {
        let base = {};
        const uid = parentUID || (changes && changes.UID);
        if (uid) {
            try {
                const rec = await dbGateway.execute({
                    operation: 'findOne', table: TASKS, where: { UID: uid },
                    options: { raw: true }, context: { sessionID }
                });
                if (rec) base = (typeof rec.get === 'function') ? rec.get({ plain: true }) : rec;
            } catch (e) { /* новая запись */ }
        }
        return Object.assign({}, base, changes || {});
    }

    return {

        // ── Сохранение ────────────────────────────────────────────────────
        /**
         * Правила сохранения задачи:
         *   • владелец по умолчанию — текущий пользователь; сменить может только admin;
         *   • организация: обычному пользователю обязательна и только из доступных ему
         *     (пустая = СИСТЕМНАЯ задача, а это привилегия admin);
         *   • `scope` обработчика проверяется и здесь, а не только в UI;
         *   • `cronExpression` и `nextRunAt` — вычисляемые: пересчитываются ВСЕГДА
         *     (кроме режима `cron`, где выражение вводит пользователь), иначе
         *     расписание разъедется с настройками формы;
         *   • параметры ТЧ сверяются со схемой обработчика.
         */
        async onBeforeSave({ changes, tabularSections, parentUID }, ctx) {
            const sessionID = ctx && ctx.sessionID;
            const user = await globalCtx.getUserBySessionID(sessionID);
            if (!user) throw new Error(await formsCtx.tForSession('User not authorized', sessionID));
            const role = await formsCtx.getUserAccessRole(user);
            const isAdmin = role === 'admin';

            const task = await effectiveTask(changes, parentUID, sessionID);

            // Владелец
            if (!isAdmin || !task.userId) {
                changes.userId = user.UID;
                task.userId = user.UID;
            }

            // Организация
            const orgIds = await visibleOrganizations(sessionID);
            if (!isAdmin) {
                if (!task.organizationId && orgIds.length === 1) {
                    changes.organizationId = orgIds[0];
                    task.organizationId = orgIds[0];
                }
                if (!task.organizationId) {
                    throw new Error(await formsCtx.tForSession('sched_err_org_required', sessionID));
                }
                if (orgIds.length && !orgIds.includes(task.organizationId)) {
                    throw new Error(await formsCtx.tForSession('sched_err_org_forbidden', sessionID));
                }
            }

            // Тип задачи и его область применения
            if (!task.handler) {
                throw new Error(await formsCtx.tForSession('sched_err_handler_required', sessionID));
            }
            const handler = scheduler.getHandler(task.handler);
            if (!handler) {
                throw new Error(await formsCtx.tfForSession('sched_err_unknown_handler', sessionID, { handler: task.handler }));
            }
            const scope = handler.scope || 'any';
            if (scope === 'system' && task.organizationId) {
                throw new Error(await formsCtx.tForSession('sched_err_scope_system', sessionID));
            }
            if (scope === 'organization' && !task.organizationId) {
                throw new Error(await formsCtx.tForSession('sched_err_scope_organization', sessionID));
            }

            // Расписание: cron-режим проверяем, остальные пересчитываем из конструктора
            if (task.scheduleMode === 'cron') {
                const check = scheduler.validateCron(task.cronExpression, task.timezone);
                if (!check.ok) {
                    throw new Error(await formsCtx.tfForSession(check.errorKey, sessionID, check.vars || {}));
                }
            }
            const recalced = scheduler.recalcSchedule(task);
            changes.cronExpression = recalced.cronExpression;
            changes.nextRunAt = recalced.nextRunAt || null;

            // Параметры (ТЧ): организация строк + сверка со схемой обработчика
            const rows = (tabularSections && tabularSections.scheduler_task_params) || [];
            for (const row of rows) {
                if (!row.organizationId) row.organizationId = task.organizationId || null;
            }
            const validated = scheduler.validateParams(task.handler, rows.map(r => ({ key: r.key, value: r.value })));
            if (!validated.ok) {
                throw new Error(await formsCtx.tfForSession(validated.errorKey, sessionID, validated.vars || {}));
            }
        },

        // ── RPC формы ─────────────────────────────────────────────────────

        /** Расшифровка расписания человеческим языком (язык сессии). */
        async describeSchedule(params, ctx) {
            const sessionID = ctx && ctx.sessionID;
            const { language } = await formsCtx.getSessionContext(sessionID);
            const i18n = require('../../../drive_root/i18n');
            const tf = (key, vars) => i18n.tf(key, language, vars || {});
            return { text: scheduler.describeSchedule(params || {}, tf) };
        },

        /** «Выполнить сейчас». Тот же путь, что и плановый запуск. */
        async runNow({ taskUID }, ctx) {
            const sessionID = ctx && ctx.sessionID;
            if (!taskUID) return { error: await formsCtx.tForSession('sched_err_task_not_found', sessionID) };
            // Читаем задачу ПОД СЕССИЕЙ ПОЛЬЗОВАТЕЛЯ: не видит — не запускает.
            const rec = await dbGateway.execute({
                operation: 'findOne', table: TASKS, where: { UID: taskUID },
                options: { raw: true }, context: { sessionID }
            });
            if (!rec) return { error: await formsCtx.tForSession('sched_err_task_not_found', sessionID) };

            const res = await scheduler.runNow(taskUID);
            if (!res.ok) return { error: await formsCtx.tForSession(res.errorKey || 'sched_err_dispatch_failed', sessionID) };
            return { ok: true, message: await formsCtx.tForSession('sched_run_started_msg', sessionID) };
        },

        /** «Остановить» выполняющуюся задачу. */
        async stopRun({ taskUID }, ctx) {
            const sessionID = ctx && ctx.sessionID;
            if (!taskUID) return { error: await formsCtx.tForSession('sched_err_task_not_found', sessionID) };
            const rec = await dbGateway.execute({
                operation: 'findOne', table: TASKS, where: { UID: taskUID },
                options: { raw: true }, context: { sessionID }
            });
            if (!rec) return { error: await formsCtx.tForSession('sched_err_task_not_found', sessionID) };

            const res = await scheduler.cancel(taskUID);
            if (!res.ok) return { error: await formsCtx.tForSession(res.errorKey || 'sched_err_not_running', sessionID) };
            return { ok: true, message: await formsCtx.tForSession('sched_cancel_requested_msg', sessionID) };
        },

        /** Состояние задачи для формы (кнопка «Остановить» активна только при запуске). */
        async getTaskState({ taskUID }, ctx) {
            const sessionID = ctx && ctx.sessionID;
            if (!taskUID) return { running: false };
            const rec = await dbGateway.execute({
                operation: 'findOne', table: TASKS, where: { UID: taskUID },
                options: { raw: true }, context: { sessionID }
            });
            if (!rec) return { running: false };
            return {
                running: !!(rec.runningRunId && String(rec.runningRunId).length),
                lastStatus: rec.lastStatus || '',
                nextRunAt: rec.nextRunAt || null
            };
        },

        /** Схема параметров выбранного типа задачи — подсказка для ТЧ «Параметры». */
        async getHandlerSchema({ handler }, ctx) {
            const def = scheduler.getHandler(handler);
            if (!def) return { keys: [] };
            const schema = def.paramsSchema || {};
            return {
                keys: Object.keys(schema).map(k => ({
                    key: k,
                    type: schema[k].type || 'string',
                    required: !!schema[k].required,
                    defaultValue: schema[k].default !== undefined ? String(schema[k].default) : ''
                })),
                scope: def.scope || 'any'
            };
        }
    };
};
