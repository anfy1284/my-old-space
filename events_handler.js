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
const { injectEntityNames } = require('./drive_root/db/entityName');
const { injectEmptyDefaults } = require('./drive_root/db/emptyValues');
const { injectIndexNames } = require('./drive_root/db/indexNames');

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
        // «name» (представление) — полноценное поле модели, а не колонка,
        // навешиваемая после миграции. Иначе перестройка таблицы теряет
        // представления всех записей: см. drive_root/db/entityName.js.
        const nm = injectEntityNames(mergedModelsDef);
        console.log(`[my-old-space:events_handler] "number" + autonumber injected into ${n} entity model(s), "date" into ${d} document(s), "name" into ${nm} model(s).`);

        // Пустые значения по типам вместо NULL (NULL остаётся только у
        // полей-ссылок). enforceNotNull пока выключен намеренно: ограничение
        // NOT NULL ставится ОТДЕЛЬНЫМ шагом, уже после того как существующие
        // NULL-ы вычищены миграцией — иначе первый же старт сервера начнёт
        // ронять запись там, где сегодня всё работает.
        const e = injectEmptyDefaults(mergedModelsDef, { enforceNotNull: false });
        console.log(`[my-old-space:events_handler] empty-value defaults set on ${e.fields} field(s), ${e.validators} validator(s) made empty-safe.`);

        // Явные имена индексов: без них СУБД обрезает длинное имя по своему пределу,
        // и `sync()` на каждом старте пытается создать индекс заново (drive_root/db/indexNames.js).
        const ix = injectIndexNames(mergedModelsDef);
        if (ix) console.log(`[my-old-space:events_handler] explicit names assigned to ${ix} index(es).`);
    }
};
