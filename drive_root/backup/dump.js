'use strict';

/**
 * dump — полезная нагрузка резервной копии: NDJSON-поток (ТЗ §3.1).
 *
 * Строение потока (по строке JSON на запись, порядок значим):
 *   {"kind":"header",  …}                 версия формата, БД, область, версия структуры
 *   {"kind":"models",  models:[…]}        снимок СЛИТЫХ определений моделей
 *   {"kind":"sequences", values:{}}       счётчики СУБД (сегодня пусто — см. §3.1 п.3)
 *   {"kind":"table",   table:"…", cls:"A"} начало таблицы
 *   {"kind":"row",     table:"…", data:{}} строка
 *   {"kind":"summary", tables:{…}}        контрольные суммы и счётчики — ПОСЛЕДНЕЙ
 *
 * Почему итог последний: он считается по ходу выгрузки. Почему построчно: базу нельзя
 * собирать в память — «сформировать массив и `JSON.stringify`» падает на первой же
 * настоящей базе.
 */

const crypto = require('crypto');
const { Readable } = require('stream');

const log = require('../log');
const dialect = require('./dialect');
const scope = require('./scope');
const serialize = require('./serialize');

const DUMP_FORMAT = 'mos-logical-1';
const PAGE_SIZE = 1000;

/**
 * Каноническая сериализация — основа `configHash` (ТЗ §6.4 п.1).
 *
 * Хэшировать определения «как есть» нельзя: значение запляшет от порядка ключей в
 * объектах и порядка обхода приложений, и после каждого рестарта появится «новая
 * версия структуры» на ровном месте. Поэтому сортируем ключи и таблицы.
 */
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value).sort()) {
            const v = value[k];
            if (typeof v === 'function') continue;          // `defaultValue: () => …` волатильна
            out[k] = canonical(v);
        }
        return out;
    }
    return value;
}

/** Снимок структуры в каноническом виде + его хэш. */
function modelsSnapshot(models) {
    const snapshot = canonical(
        (models || [])
            .map(m => ({ name: m.name, tableName: m.tableName, fields: m.fields, options: m.options, entityConfig: m.entityConfig || null }))
            .sort((a, b) => String(a.tableName).localeCompare(String(b.tableName)))
    );
    const hash = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    return { snapshot, configHash: hash };
}

/**
 * Сверить фактические таблицы БД с моделями (ТЗ §0, страховка).
 * @returns {Promise<{unknownObjects: Array<string>, missingTables: Array<string>}>}
 */
async function compareWithDatabase(sequelize, models, transaction) {
    const actual = new Set(await dialect.listTables(sequelize, transaction));
    const known = new Set((models || []).map(m => m.tableName));
    const unknownObjects = [...actual].filter(t => !known.has(t)).sort();
    const missingTables = [...known].filter(t => !actual.has(t)).sort();
    return { unknownObjects, missingTables };
}

/**
 * Построить поток полезной нагрузки.
 *
 * Возвращает `Readable`, который можно сразу пустить в gzip → шифратор → файл.
 * Асинхронный генератор здесь уместен: он естественно даёт обратное давление —
 * страница читается только когда потребитель готов её принять.
 *
 * @param {Object} opts
 * @param {Object} opts.sequelize
 * @param {Array<Object>} opts.models — СЛИТЫЕ определения (`collectMergedModelDefs`)
 * @param {Object} opts.scope — `{type:'full'}` | `{type:'organization', organizationId, organizationName}`
 * @param {Object} opts.transaction — снимок из `dialect.beginSnapshot`
 * @param {Object} [opts.meta] — appVersion/frameworkVersion/dbName
 * @param {Function} [opts.onProgress] — (текст) для журнала запуска
 * @returns {{stream: Readable, stats: Object}} stats заполняется по ходу
 */
function createPayloadStream(opts) {
    const { sequelize, models, transaction, onProgress } = opts;
    const dumpScope = opts.scope || { type: 'full' };
    const meta = opts.meta || {};
    const q = dialect.quoter(sequelize);

    const plan = scope.buildPlan(models, dumpScope);
    const { snapshot, configHash } = modelsSnapshot(models);

    const stats = {
        configHash,
        tables: {},              // table → { rows, sha256, cls }
        totalRows: 0,
        warnings: plan.warnings,
        byClass: plan.byClass,
        plannedTables: plan.tables.length
    };

    const progress = (text) => { try { if (onProgress) onProgress(text); } catch (e) { /* журнал не должен ронять выгрузку */ } };
    const line = (obj) => JSON.stringify(obj) + '\n';

    async function* generate() {
        yield line({
            kind: 'header',
            dumpFormat: DUMP_FORMAT,
            createdAt: new Date().toISOString(),
            dbName: meta.dbName || '',
            sourceDialect: dialect.nameOf(sequelize),
            appVersion: meta.appVersion || '',
            frameworkVersion: meta.frameworkVersion || '',
            configHash,
            actualHash: meta.actualHash || '',
            dbVersion: meta.dbVersion || null,
            scope: dumpScope
        });

        yield line({ kind: 'models', models: snapshot });

        // Секция заведена заранее и сегодня пуста: PK — строковый UID из кода, номера
        // документов считаются как MAX+1, реальных последовательностей в базе нет.
        // Появится автоинкремент — выгрузка обязана сохранить счётчик, иначе первая
        // же вставка после восстановления упадёт с «duplicate key».
        yield line({ kind: 'sequences', values: {} });

        for (const entry of plan.tables) {
            const where = dumpScope.type === 'organization'
                ? scope.buildWhere(entry.filter, dumpScope.organizationId, q)
                : null;

            yield line({ kind: 'table', table: entry.table, cls: entry.cls, filtered: !!where });

            const fields = (entry.model && entry.model.fields) || {};
            const hash = crypto.createHash('sha256');
            let count = 0;
            let afterUID = null;

            for (;;) {
                const rows = await dialect.readPage(sequelize, {
                    table: entry.table,
                    where: where ? where.sql : null,
                    params: where ? where.params : null,
                    afterUID, limit: PAGE_SIZE, transaction
                });
                if (!rows.length) break;

                for (const row of rows) {
                    const data = serialize.rowToDump(row, fields);
                    const text = line({ kind: 'row', table: entry.table, data });
                    // Контрольная сумма считается по ТОМУ ЖЕ тексту, что уехал в файл:
                    // иначе она проверяет не то, что записано.
                    hash.update(text);
                    count++;
                    yield text;
                }
                afterUID = rows[rows.length - 1].UID;
                if (rows.length < PAGE_SIZE) break;
            }

            stats.tables[entry.table] = { rows: count, sha256: hash.digest('hex'), cls: entry.cls };
            stats.totalRows += count;
            if (count) progress(`${entry.table}: ${count}`);
        }

        yield line({ kind: 'summary', totalRows: stats.totalRows, tables: stats.tables });
    }

    return { stream: Readable.from(generate()), stats, plan };
}

module.exports = { createPayloadStream, modelsSnapshot, canonical, compareWithDatabase, DUMP_FORMAT, PAGE_SIZE };
