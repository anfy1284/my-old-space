'use strict';

/**
 * entityNumber — системная инъекция реквизита «number» (номер) и автонумерации
 * для сущностей уровня ERP (документы и справочники), по аналогии с авто-инъекцией UID.
 *
 * Идея (как в 1С): любая таблица, помеченная как сущность (entityConfig.entityType ∈
 * {document, directory, catalog, справочник}), автоматически получает строковый
 * реквизит `number` и автонумерацию на нём. Прикладному коду больше не нужно
 * объявлять поле или хук автонумерации вручную.
 *
 * Механизм автонумерации (default.autoNumber) сохраняет РУЧНОЙ ВВОД: если номер
 * уже заполнен — не трогает его, а последующая автонумерация продолжается от MAX(number).
 *
 * Вызывается из двух мест (логика — одна, здесь):
 *   1. Миграция:  корневой events_handler.js → onModelsPostCollect (создаёт колонку в БД).
 *   2. Рантайм:   globalServerContext.generateModelsFromDefs (модель знает о поле + хук).
 *
 * Все функции идемпотентны — повторный вызов ничего не дублирует.
 */

// Типы сущностей, которым положен номер. document — документ, остальные — справочник.
const ENTITY_TYPES = new Set(['document', 'directory', 'catalog', 'справочник', 'reference']);

/**
 * Является ли определение модели сущностью (документ/справочник)?
 * @param {object} def — определение модели из db.json (с .entityConfig)
 * @returns {boolean}
 */
function isEntityDef(def) {
    const et = def && def.entityConfig && def.entityConfig.entityType;
    return !!et && ENTITY_TYPES.has(String(et).toLowerCase());
}

/**
 * Гарантирует у сущности строковый реквизит `number` и хук автонумерации на нём.
 * Не-сущности (табличные части, технические таблицы без entityType) пропускаются.
 *
 * Приложение может объявить своё поле `number` (например, со своей подписью) —
 * тогда поле не пересоздаётся, но автонумерация на него всё равно навешивается.
 *
 * @param {object} def — определение модели (мутируется in-place)
 * @returns {boolean} true если это сущность и инъекция применена
 */
function injectEntityNumber(def) {
    if (!isEntityDef(def)) return false;
    if (!def.fields) def.fields = {};

    // 1. Реквизит number (строка). Если приложение объявило своё — уважаем его.
    if (!def.fields.number) {
        def.fields.number = {
            type: 'STRING',
            allowNull: true,
            caption: { i18n: 'number_field' }
        };
    }

    // 2. Автонумерация (+ контроль уникальности) на number — на beforeCreate И beforeUpdate.
    //    beforeUpdate нужен, чтобы при ОЧИСТКЕ номера в существующей записи автонумерация
    //    присвоила новый (как при создании) — см. default.autoNumber (логика update).
    //    Порядок в массиве: [autoNumber, uniqueNumber, ...прикладные хуки] — номер
    //    присваивается первым, затем проверяется уникальность, затем прикладная логика.
    //    unshift — чтобы это происходило ДО прикладных хуков и вычисления представления.
    const ec = def.entityConfig;
    ec.hooks = ec.hooks || {};

    // Контроль уникальности номера: включён по умолчанию, отключается в db.json
    // через entityConfig.uniqueNumber: false.
    const uniqueEnabled = ec.uniqueNumber !== false;

    function ensureNumberHooks(event) {
        if (!Array.isArray(ec.hooks[event])) ec.hooks[event] = [];
        const arr = ec.hooks[event];
        // uniqueNumber unshift'им раньше autoNumber, чтобы итоговый порядок был
        // [autoNumber, uniqueNumber, ...].
        if (uniqueEnabled) {
            const hasUnique = arr.some(h =>
                h && h.handler === 'default.uniqueNumber' && h.params && h.params.field === 'number'
            );
            if (!hasUnique) arr.unshift({ handler: 'default.uniqueNumber', params: { field: 'number' } });
        }
        const hasAuto = arr.some(h =>
            h && h.handler === 'default.autoNumber' && h.params && h.params.field === 'number'
        );
        if (!hasAuto) arr.unshift({ handler: 'default.autoNumber', params: { field: 'number', length: 5 } });
    }
    ensureNumberHooks('beforeCreate');
    ensureNumberHooks('beforeUpdate');
    return true;
}

/**
 * Применить injectEntityNumber ко всему массиву определений моделей.
 * @param {Array<object>} defs
 * @returns {number} сколько сущностей обработано
 */
function injectEntityNumbers(defs) {
    if (!Array.isArray(defs)) return 0;
    let n = 0;
    for (const def of defs) {
        if (injectEntityNumber(def)) n++;
    }
    return n;
}

module.exports = { ENTITY_TYPES, isEntityDef, injectEntityNumber, injectEntityNumbers };
