'use strict';

/**
 * entityName — системная инъекция реквизита «name» (представление записи)
 * в ОПРЕДЕЛЕНИЯ моделей, по аналогии с entityNumber и entityDate.
 *
 * Зачем этот модуль появился (важно, иначе правку легко откатят обратно).
 * Раньше колонка `name` не входила в определения моделей вообще: её навешивала
 * функция `ensureNameColumns` в `createDB.js` — уже ПОСЛЕ коммита миграции,
 * через `addColumn`. Пока схема не менялась, это работало. Но когда таблица
 * требует перестройки, миграция делает так:
 *
 *     1. Backing up  <table> to <table>_temp_backup
 *     2. Dropping table <table>
 *     3. пересоздание таблицы ПО ОПРЕДЕЛЕНИЯМ МОДЕЛЕЙ (где `name` нет)
 *     4. Restoring data — переносятся только ОБЩИЕ поля старой и новой таблиц,
 *        а `name` в новой таблице ещё не существует → значения теряются
 *     5. ensureNameColumns добавляет пустую колонку `name`
 *
 * Итог: при каждой перестройке таблицы представления ВСЕХ записей обнулялись,
 * молча. В журналах документов вместо наименований оставались пустые ячейки,
 * а восстановить их можно было только пересохранением каждой записи.
 *
 * Решение — сделать `name` полноценным полем модели, как `UID`, `number`
 * и `date`. Тогда оно есть в таблице с момента создания, попадает в список
 * общих полей при переносе и переживает перестройку.
 *
 * Вызывается из тех же двух мест, что entityNumber/entityDate:
 *   1. Миграция:  корневой events_handler.js → onModelsPostCollect
 *   2. Рантайм:   globalServerContext.collectAllModelDefs
 *
 * Идемпотентно: если приложение объявило своё поле `name` (со своей подписью,
 * длиной, признаком translatable) — оно не трогается.
 */

/**
 * Гарантирует у модели реквизит `name` (представление).
 *
 * Применяется ко ВСЕМ таблицам, а не только к сущностям: представление
 * используется и служебными таблицами (его показывают списки и окна выбора),
 * и именно так вела себя прежняя `ensureNameColumns`. Сужать охват здесь
 * нельзя — это молча удалило бы колонку у части таблиц при следующей
 * перестройке.
 *
 * @param {object} def — определение модели (мутируется in-place)
 * @returns {boolean} true если поле было добавлено этим вызовом
 */
function injectEntityName(def) {
    if (!def || typeof def !== 'object') return false;
    if (!def.fields) def.fields = {};
    if (def.fields.name) return false; // приложение объявило своё — уважаем

    def.fields.name = {
        type: 'STRING',
        allowNull: true,
        caption: { i18n: 'presentation_field' }
    };
    return true;
}

/**
 * Применить injectEntityName ко всему массиву определений моделей.
 * @param {Array<object>} defs
 * @returns {number} скольким моделям поле добавлено
 */
function injectEntityNames(defs) {
    if (!Array.isArray(defs)) return 0;
    let n = 0;
    for (const def of defs) {
        if (injectEntityName(def)) n++;
    }
    return n;
}

module.exports = { injectEntityName, injectEntityNames };
