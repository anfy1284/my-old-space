'use strict';

/**
 * Корневой обработчик событий пакета my-old-space.
 *
 * Вызывается фреймворком (drive_root/db/createDB.js → triggerProjectEvent) ПЕРВЫМ,
 * до обработчика проекта (PROJECT_ROOT/events_handler.js). Сюда выносятся системные,
 * общие для всех потребителей фреймворка преобразования моделей.
 *
 * ВАЖНО: только CommonJS `module.exports` (как и проектный events_handler) — иначе
 * require() не подхватит обработчики.
 */

const { injectEntityNumbers } = require('./drive_root/db/entityNumber');
const { injectEntityDates } = require('./drive_root/db/entityDate');

module.exports = {
    /**
     * Вызывается после сбора и слияния моделей, до инициализации Sequelize.
     * Системно добавляет реквизит `number` + автонумерацию всем сущностям
     * (документы/справочники) и реквизит `date` документам. UID инъектируется
     * отдельно (drive_root/globalServerContext в рантайме и проектный
     * events_handler на миграции).
     * @param {Object} context — { mergedModelsDef, allAssociations, sequelize, projectRoot }
     */
    onModelsPostCollect: async function (context) {
        const { mergedModelsDef } = context || {};
        if (!Array.isArray(mergedModelsDef)) return;
        const n = injectEntityNumbers(mergedModelsDef);
        const d = injectEntityDates(mergedModelsDef);
        console.log(`[my-old-space:events_handler] "number" + autonumber injected into ${n} entity model(s), "date" into ${d} document(s).`);
    }
};
