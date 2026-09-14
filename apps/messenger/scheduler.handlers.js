'use strict';

/**
 * Типы регламентных задач мессенджера.
 *
 * «Разбор переводов» — раз в неделю модель с большим контекстом разбирает новые переводы
 * и сама правит контекст переводчика; итерациями проверяет правку на тех же сообщениях
 * (lib/translationReview.js, решения владельца 14.09.2026).
 *
 * Файл грузят ДВА процесса — главный (форма показывает тип задачи и схему параметров) и
 * воркер (исполняет), — поэтому он обязан быть чистым модулем-фабрикой без побочных
 * эффектов. См. drive_root/scheduler/registry.js.
 */

module.exports = function (modelsDB, Utilities) {
    return {

        'messenger.reviewTranslations': {
            caption: { i18n: 'msg_handler_review_translations' },
            icon: '/apps/general_icons/resources/public/16x16/translate.png',
            // Читает переписку всех чатов и пишет общий словарь — только администратор.
            scope: 'system',
            paramsSchema: {
                // Сколько раз проверять исправленный контекст повторным переводом
                // разобранных сообщений. 0 — без проверки.
                iterations: { type: 'integer', required: false, default: 1 },
                // Сколько новых сообщений разбирать за один прогон; остальное — в следующий.
                maxMessages: { type: 'integer', required: false, default: 300 }
            },
            run: async (ctx) => require('./lib/translationReview').run(ctx)
        }
    };
};
