'use strict';

/**
 * schemaBuilder — создание структуры базы ПО ПЕРЕДАННОМУ снимку моделей (ТЗ §6.1 шаг 3).
 *
 * Ключевое отличие от `createDB.createAll`: там структура приводится к АКТУАЛЬНЫМ
 * `db.json` (миграция существующей базы), здесь — строится с нуля по снимку, лежащему
 * В ДАМПЕ. Именно поэтому старая копия восстановима: данные ложатся ровно в свою
 * структуру, без сопоставления колонок на лету, а приведение к сегодняшней версии
 * делает потом штатная миграция (шаг 7). Второй реализации миграции в системе не
 * появляется — появляется реализация СОЗДАНИЯ, которой у нас и не было отдельно.
 *
 * Строим в теневом пространстве (`schema`), живая база при этом не трогается.
 */

const log = require('../log');
const { defineModels, computeCreateOrder } = require('./createDB');

/**
 * Создать таблицы по определениям моделей в указанной схеме.
 *
 * Порядок — топологический (родители раньше детей), тот же `computeCreateOrder`, что
 * и при обычной миграции. Цикл ссылок алгоритм не разрешает и честно откатывается на
 * исходный порядок, поэтому неудачные таблицы повторяются вторым проходом.
 *
 * @param {Object} sequelize
 * @param {Array<Object>} modelDefs — снимок СЛИТЫХ определений (из дампа)
 * @param {Object} opts — `{ schema, withoutForeignKeys, onProgress }`
 * @returns {Promise<{created: Array<string>, failed: Array<{table: string, error: string}>}>}
 */
async function buildSchema(sequelize, modelDefs, opts = {}) {
    const schema = opts.schema || null;
    const onProgress = opts.onProgress || (() => {});

    // Внешние ключи можно отложить: тогда данные грузятся потоком в том порядке, в
    // каком лежат в файле, а ограничения навешиваются в конце — с проверкой. Иначе
    // пришлось бы либо буферизовать всю базу в памяти, либо требовать прав
    // суперпользователя на отключение проверок. `references` при этом снимается ТОЛЬКО
    // из копии определений: исходный снимок мутировать нельзя, его хэшируют и по нему
    // же потом навешивают ключи.
    const defs = opts.withoutForeignKeys
        ? modelDefs.map(m => Object.assign({}, m, {
            fields: Object.fromEntries(Object.entries(m.fields || {}).map(([k, v]) => {
                if (!v || !v.references) return [k, v];
                const copy = Object.assign({}, v);
                delete copy.references;
                delete copy.onDelete;
                delete copy.onUpdate;
                return [k, copy];
            }))
        }))
        : modelDefs;

    // Ассоциации сознательно НЕ применяются: они добавляют Sequelize-связи (hasMany и
    // т.п.), а иногда и колонки внешних ключей, которых в снимке нет. Структуру задаёт
    // снимок и только он — иначе воссозданная схема разойдётся с той, из которой сняты
    // данные, и сверка по `actualHash` это честно поймает уже после потраченного часа.
    const models = defineModels(sequelize, defs, [], { schema, quiet: true });

    // Порядок считаем по ИСХОДНЫМ определениям: даже без ограничений в СУБД порядок
    // создания родитель-раньше-ребёнка остаётся правильным и делает результат
    // воспроизводимым (а при `withoutForeignKeys: false` — обязательным).
    const orderedTables = computeCreateOrder(modelDefs);
    const defByTable = new Map(modelDefs.map(d => [d.tableName, d]));
    const ordered = orderedTables.map(t => defByTable.get(t)).filter(Boolean);

    const created = [];
    const failed = [];
    let pending = [...ordered];
    let attempts = ordered.length * 2;

    while (pending.length && attempts-- > 0) {
        const batch = pending;
        pending = [];
        for (const def of batch) {
            try {
                await models[def.name].sync();
                created.push(def.tableName);
                onProgress(def.tableName, { done: created.length, total: ordered.length });
            } catch (e) {
                // Может не хватать родителя (цикл ссылок) — повторим следующим проходом.
                pending.push(def);
                def.__lastError = e.message;
            }
        }
        if (pending.length === batch.length) break;   // прогресса нет — дальше бессмысленно
    }

    for (const def of pending) {
        failed.push({ table: def.tableName, error: def.__lastError || 'unknown' });
        log.error(`[schemaBuilder] Таблица ${def.tableName} не создана: ${def.__lastError}`);
    }

    return { created, failed };
}

module.exports = { buildSchema };
