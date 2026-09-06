'use strict';

/**
 * Тип регламентной задачи «Очистка старых уведомлений».
 *
 * Уведомления живут в базе, а значит копятся: у пользователя, который месяц не
 * нажимал «Очистить все сообщения», стек растёт без границы, а в тексте лежит
 * кусок переписки — то есть персональные данные с неопределённым сроком
 * хранения. Поэтому срок задаётся системной настройкой
 * `notificationRetentionDays`, а сносит просроченное эта задача.
 *
 * Файл грузят ДВА процесса — главный (форма показывает тип задачи) и воркер
 * (исполняет), — поэтому он обязан быть чистым модулем-фабрикой без побочных
 * эффектов. См. drive_root/scheduler/registry.js.
 */

const { Op } = require('sequelize');
const dbGateway = require('../../drive_root/dbGateway');
const systemSettings = require('../systemSettings/lib/systemSettings');

// Если описания настройки нет вовсе (не досеялось, чужая инсталляция) — задача
// обязана отработать, а не встать. Тот же срок, что и в описании настройки.
const FALLBACK_RETENTION_DAYS = 30;

module.exports = function (modelsDB, Utilities) {
    return {

        'notifications.cleanup': {
            caption: { i18n: 'notif_handler_cleanup' },
            icon: '/apps/general_icons/resources/public/16x16/delete.png',
            // Задача сносит уведомления ВСЕХ пользователей, поэтому владелец —
            // администратор, а области организации у неё нет.
            scope: 'system',
            paramsSchema: {},
            run: async (ctx) => {
                const formsCtx = require('../../drive_forms/globalServerContext');
                const ownerRole = ctx.userId ? await formsCtx.getUserAccessRole({ UID: ctx.userId }) : null;
                if (ownerRole !== 'admin') {
                    throw new Error(`Владелец задачи очистки уведомлений должен иметь роль admin (сейчас: ${ownerRole || 'не определена'})`);
                }

                // Настройка читается на КАЖДОМ прогоне: задача идёт в отдельном
                // процессе-воркере, и значение, прочитанное при его старте, могло
                // устареть на недели (тот же урок, что с настройками бэкапа).
                const days = await systemSettings.getNumber('notificationRetentionDays', FALLBACK_RETENTION_DAYS);
                const retention = (Number.isFinite(days) && days > 0) ? days : FALLBACK_RETENTION_DAYS;

                const cutoff = new Date(Date.now() - retention * 24 * 60 * 60 * 1000);

                const before = await dbGateway.execute({
                    operation: 'count',
                    table: 'notifications',
                    where: { createdAt: { [Op.lt]: cutoff } },
                    context: { sessionID: ctx.sessionID }
                });

                if (before) {
                    await dbGateway.execute({
                        operation: 'delete',
                        table: 'notifications',
                        where: { createdAt: { [Op.lt]: cutoff } },
                        context: { sessionID: ctx.sessionID }
                    });
                }

                ctx.log(`Срок хранения: ${retention} дн. Удалено уведомлений: ${before || 0}`);
                return { resultText: `Удалено уведомлений: ${before || 0} (старше ${retention} дн.)` };
            }
        }
    };
};
