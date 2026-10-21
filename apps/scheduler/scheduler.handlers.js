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
        },

        // ── Исполнитель очереди проведения (ТЗ «Проведение документов», §10) ──
        // Единственное место, откуда зовётся проведение. Сделано типом задачи, а не
        // вторым механизмом, потому что от планировщика нужно ровно одно —
        // «разбудись и сделай проход», а взамен даром достаются форкнутый воркер
        // (проведение не блокирует event loop), служебные сессии, захват задачи
        // (два прохода одновременно невозможны), журнал прогонов, отмена и таймаут.
        //
        // Задача заводится с интервалом — это СТРАХУЮЩИЙ запуск (§10.2.3): процесс
        // может упасть между «строка записана» и «исполнитель разбужен», и тогда
        // документ подберёт ближайший тик. Обычный путь — толчок сразу после
        // постановки в очередь (postingQueue.kick).
        'core.postingQueue': {
            caption: { i18n: 'sched_handler_posting_queue' },
            icon: '/apps/general_icons/resources/public/16x16/document.png',
            scope: 'system',
            paramsSchema: {},
            run: async (ctx) => {
                const runner = require('../../drive_root/db/postingRunner');

                const stats = await runner.pass(ctx);

                // Что приехало в очередь ЗА ВРЕМЯ прохода (в том числе каскадом от
                // только что проведённых), подбирает сам проход: он перечитывает
                // таблицу на каждом шаге. Будить себя отсюда бесполезно — задача
                // исполняется в форкнутом воркере, планировщика в нём нет.
                // Строку, приехавшую после выхода из цикла, подберёт отложенный
                // толчок главного процесса (postingQueue.kick) или страхующий тик.
                if (!stats.seen) return { resultText: 'Очередь пуста' };
                return {
                    resultText: `Проведено: ${stats.posted}, ошибок: ${stats.failed}`
                        + (stats.cascaded ? `, поставлено на перепроведение: ${stats.cascaded}` : '')
                };
            }
        },

        // ── Оповещения по документам: правила по времени + сводка ─────────────
        // ТЗ «Оповещения по документам», §6 (повод 2) и §14. Время событием в
        // базе не является: вчера оповещения не было, сегодня есть, хотя за ночь
        // ничего не менялось. Заметить это больше нечем, поэтому проход
        // объявлен задачей — с интервалом в сутки.
        'core.documentAlerts': {
            caption: { i18n: 'sched_handler_document_alerts' },
            icon: '/apps/general_icons/resources/public/16x16/alert_warning.png',
            // Правила читают данные под служебной сессией владельца задания —
            // область задачи его. Сводка же идёт НЕ ему, а пользователям без
            // роли admin, каждому о его документах (alertsRunner.summary).
            scope: 'any',
            paramsSchema: {},
            run: async (ctx) => {
                const runner = require('../../drive_root/db/alertsRunner');
                const res = await runner.pass(ctx);
                const s = res.stats;
                const parts = [`Правил по времени: ${s.rules}, документов: ${s.documents}`];
                // «Несказанных» — это НЕ отправленные уведомления: фоновый проход
                // молчит и говорит одной сводкой. Число полезно в журнале прогонов:
                // по нему видно, сколько оповещений ждут человека.
                if (s.pending) parts.push(`новых оповещений: ${s.pending}`);
                parts.push(res.summary.sent
                    ? `сводок отправлено: ${res.summary.sent}`
                    : `сводка не нужна${res.summary.reason ? ' — ' + res.summary.reason : ''}`);
                return { resultText: parts.join(', ') };
            }
        },

        // ── Автосдвиг даты запрета редактирования (ТЗ §13.3) ──────────────────
        'core.advanceClosingDate': {
            caption: { i18n: 'sched_handler_advance_closing_date' },
            icon: '/apps/general_icons/resources/public/16x16/calendar.png',
            scope: 'system',
            paramsSchema: {},
            run: async (ctx) => {
                const closing = require('../../drive_root/db/closingDate');
                const n = await closing.advanceAll(ctx.sessionID);
                return { resultText: `Дата запрета сдвинута у организаций: ${n}` };
            }
        }
    };
};
