'use strict';

/**
 * Типы регламентных задач самого планировщика.
 *
 * Файл грузят ДВА процесса — главный (форма показывает список типов и схему
 * параметров) и воркер (исполняет), — поэтому он обязан быть чистым модулем-фабрикой
 * без побочных эффектов. См. drive_root/scheduler/registry.js.
 */

const dbGateway = require('../../drive_root/dbGateway');

module.exports = function (modelsDB, Utilities) {
    return {

        // Ретеншн журнала запусков. Без него `scheduler_runs` растёт бесконечно:
        // задача «каждые 5 минут» даёт больше 100 тыс. записей в год.
        'scheduler.cleanupRuns': {
            caption: { i18n: 'sched_handler_cleanup_runs' },
            icon: '/apps/general_icons/resources/public/16x16/delete.png',
            scope: 'any',
            paramsSchema: {
                keepDays: { type: 'integer', required: true, default: 90 }
            },
            run: async (ctx) => {
                const { Op } = require('sequelize');
                const keepDays = Number(ctx.params.keepDays) || 90;
                const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000);

                // Через сессию задачи: RLS сама решит, чьи записи видны.
                // Выполняющиеся запуски не трогаем — у них нет даты завершения.
                const old = await dbGateway.execute({
                    operation: 'read',
                    table: 'scheduler_runs',
                    where: { startedAt: { [Op.lt]: cutoff }, status: { [Op.ne]: 'running' } },
                    options: { raw: true },
                    context: { sessionID: ctx.sessionID }
                });

                let removed = 0;
                for (const row of old || []) {
                    if (ctx.isCancelled()) break;
                    await dbGateway.execute({
                        operation: 'delete',
                        table: 'scheduler_runs',
                        where: { UID: row.UID },
                        context: { sessionID: ctx.sessionID }
                    });
                    removed++;
                    if (removed % 200 === 0) ctx.heartbeat();
                }

                try {
                    require('../uniForm/server.js').notifyTableChange('scheduler_runs', 'delete', null);
                } catch (e) { /* оповещение необязательно */ }

                return { resultText: `Удалено записей журнала: ${removed} (старше ${keepDays} дн.)` };
            }
        }
    };
};
