'use strict';

/**
 * entityDate — системная инъекция реквизита «date» (дата документа)
 * для документов уровня ERP, по аналогии с entityNumber (реквизит «number»).
 *
 * Идея (как в 1С): любая таблица, помеченная как ДОКУМЕНТ
 * (entityConfig.entityType === 'document'), автоматически получает реквизит
 * `date` (дата+время) и хук default.documentDate, который на beforeCreate
 * заполняет пустую дату текущим моментом. Справочникам дата не инъецируется.
 *
 * Ручной ввод сохраняется: хук не трогает уже заполненное поле,
 * на beforeUpdate дата не изменяется вовсе.
 *
 * Вызывается из тех же двух мест, что и entityNumber (логика — одна, здесь):
 *   1. Миграция:  корневой events_handler.js → onModelsPostCollect (создаёт колонку в БД).
 *   2. Рантайм:   globalServerContext.collectAllModelDefs (модель знает о поле + хук).
 *
 * Все функции идемпотентны — повторный вызов ничего не дублирует.
 */

/**
 * Является ли определение модели документом?
 * @param {object} def — определение модели из db.json (с .entityConfig)
 * @returns {boolean}
 */
function isDocumentDef(def) {
    const et = def && def.entityConfig && def.entityConfig.entityType;
    return !!et && String(et).toLowerCase() === 'document';
}

/**
 * Гарантирует у документа реквизит `date` и хук default.documentDate на нём.
 * Не-документы (справочники, табличные части, технические таблицы) пропускаются.
 *
 * Приложение может объявить своё поле `date` (например, со своей подписью) —
 * тогда поле не пересоздаётся, но хук заполнения на него всё равно навешивается.
 *
 * @param {object} def — определение модели (мутируется in-place)
 * @returns {boolean} true если это документ и инъекция применена
 */
function injectEntityDate(def) {
    if (!isDocumentDef(def)) return false;
    if (!def.fields) def.fields = {};

    // 1. Реквизит date (дата+время). Если приложение объявило своё — уважаем его.
    if (!def.fields.date) {
        def.fields.date = {
            type: 'DATE',
            allowNull: true,
            caption: { i18n: 'document_date_field' }
        };
    }

    // 2. Хук заполнения даты — только на beforeCreate (beforeUpdate дату не трогает:
    //    правка документа не «передатирует» его; ручная правка даты пользователем
    //    проходит как обычное изменение поля).
    //    unshift — системные хуки раньше прикладных (как у number).
    const ec = def.entityConfig;
    ec.hooks = ec.hooks || {};
    if (!Array.isArray(ec.hooks.beforeCreate)) ec.hooks.beforeCreate = [];
    const arr = ec.hooks.beforeCreate;
    const hasDate = arr.some(h =>
        h && h.handler === 'default.documentDate' && h.params && h.params.field === 'date'
    );
    if (!hasDate) arr.unshift({ handler: 'default.documentDate', params: { field: 'date' } });
    return true;
}

/**
 * Применить injectEntityDate ко всему массиву определений моделей.
 * @param {Array<object>} defs
 * @returns {number} сколько документов обработано
 */
function injectEntityDates(defs) {
    if (!Array.isArray(defs)) return 0;
    let n = 0;
    for (const def of defs) {
        if (injectEntityDate(def)) n++;
    }
    return n;
}

module.exports = { isDocumentDef, injectEntityDate, injectEntityDates };
