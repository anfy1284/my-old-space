'use strict';

/**
 * modelsHash — идентичность структуры базы двумя хэшами (ТЗ §6.4).
 *
 *   `configHash` — хэш КОНФИГУРАЦИИ: канонической сериализации слитых определений
 *                  моделей. Отвечает на вопрос «что фреймворк СОБИРАЕТСЯ построить».
 *   `actualHash` — хэш ФАКТИЧЕСКОЙ структуры, прочитанной интроспекцией из базы.
 *                  Отвечает на вопрос «что в базе есть НА САМОМ ДЕЛЕ».
 *
 * Два хэша, а не один: их расхождение означает, что миграция упала посередине либо
 * структуру правили руками. Одним хэшем это не обнаруживается никак.
 *
 * Модуль лежит в `db/`, а не в `backup/`, потому что потребителей три и все разные:
 * журнал версий (`dbVersions`), заголовок резервной копии (`backup/dump`) и сверка
 * воссозданной теневой схемы при полном восстановлении. Второй реализации канонической
 * сериализации в системе быть не должно — она задаёт идентичность версии продукта.
 */

const crypto = require('crypto');

/**
 * Каноническая сериализация (ТЗ §6.4 п. 1).
 *
 * Хэшировать определения «как есть» нельзя: значение запляшет от порядка ключей в
 * объектах и порядка обхода приложений, и после каждого рестарта появится «новая
 * версия структуры» на ровном месте. Поэтому ключи сортируются, а волатильное
 * (функции-умолчания вида `defaultValue: () => …`) отбрасывается.
 */
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        // Date сериализуется в ISO — иначе `{}` и любые две даты станут одинаковыми.
        if (value instanceof Date) return value.toISOString();
        const out = {};
        for (const k of Object.keys(value).sort()) {
            const v = value[k];
            if (typeof v === 'function') continue;
            out[k] = canonical(v);
        }
        return out;
    }
    return value;
}

const sha256 = (s) => 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');

/**
 * Снимок структуры в каноническом виде + его хэш.
 *
 * На вход — СЛИТЫЕ определения (`collectMergedModelDefs`), то есть уже после инъекций
 * `UID`/`number`/`date`/`name`. Снимок сырых `db.json` был бы бесполезен: воссозданная
 * по нему структура не совпала бы с той, что была в базе.
 *
 * @param {Array<Object>} models
 * @returns {{snapshot: Array<Object>, configHash: string}}
 */
function modelsSnapshot(models) {
    const snapshot = canonical(
        (models || [])
            .map(m => ({
                name: m.name,
                tableName: m.tableName,
                fields: m.fields,
                options: m.options,
                entityConfig: m.entityConfig || null
            }))
            .sort((a, b) => String(a.tableName).localeCompare(String(b.tableName)))
    );
    return { snapshot, configHash: sha256(JSON.stringify(snapshot)) };
}

// ── Фактическая структура: интроспекция ──────────────────────────────────────────

/**
 * Привести имя типа колонки к сопоставимому виду.
 *
 * Драйверы называют один и тот же тип по-разному даже в пределах диалекта
 * (`character varying` / `varchar`, `int4` / `integer`), а длина и точность в
 * описании то есть, то нет. Без нормализации `actualHash` менялся бы от версии
 * драйвера, то есть врал бы о смене структуры.
 *
 * ВАЖНО: сравнимость `actualHash` гарантируется только В ПРЕДЕЛАХ ОДНОГО ДИАЛЕКТА.
 * `VARCHAR(255)` в Postgres и `VARCHAR(255)` в SQLite — разные физические типы, и
 * сравнивать их хэши бессмысленно. Поэтому диалект возвращается рядом с хэшем, а
 * потребитель обязан сверять и его (см. `restoreFull`).
 */
function normalizeType(raw) {
    let t = String(raw || '').toUpperCase().trim();
    t = t.replace(/\s+/g, ' ');
    const alias = {
        'CHARACTER VARYING': 'VARCHAR',
        'CHARACTER': 'CHAR',
        'INT4': 'INTEGER',
        'INT8': 'BIGINT',
        'INT2': 'SMALLINT',
        'INT': 'INTEGER',
        'BOOL': 'BOOLEAN',
        'FLOAT8': 'DOUBLE PRECISION',
        'FLOAT4': 'REAL',
        'TIMESTAMP WITH TIME ZONE': 'TIMESTAMPTZ',
        'TIMESTAMP WITHOUT TIME ZONE': 'TIMESTAMP',
        'NUMERIC': 'DECIMAL'
    };
    // Отделяем параметры типа: VARCHAR(255) → base=VARCHAR, args=(255)
    const m = t.match(/^([A-Z ]+?)\s*(\([^)]*\))?$/);
    if (!m) return t;
    const base = alias[m[1].trim()] || m[1].trim();
    return base + (m[2] || '');
}

/**
 * Прочитать фактическую структуру базы и посчитать её хэш.
 *
 * Читаются только КОЛОНКИ (имя, тип, обязательность, признак ключа). Умолчания
 * сознательно не входят: СУБД переписывает их своим текстом (`now()`, `'x'::text`,
 * приведение типа), и хэш начинал бы плясать от версии сервера, а не от структуры.
 *
 * @param {Object} sequelize
 * @param {Array<string>} tables — какие таблицы считать (обычно из моделей)
 * @param {Object} [opts] — `{ schema, transaction }`
 * @returns {Promise<{snapshot: Object, actualHash: string, dialect: string, missing: Array<string>}>}
 */
async function actualSchemaHash(sequelize, tables, opts = {}) {
    const qi = sequelize.getQueryInterface();
    const dialect = String(sequelize.getDialect ? sequelize.getDialect() : '');
    const snapshot = {};
    const missing = [];

    for (const table of [...(tables || [])].sort()) {
        let desc = null;
        try {
            const target = opts.schema ? { tableName: table, schema: opts.schema } : table;
            desc = await qi.describeTable(target, { transaction: opts.transaction });
        } catch (e) {
            desc = null;
        }
        if (!desc) { missing.push(table); continue; }

        const cols = {};
        for (const name of Object.keys(desc).sort()) {
            const c = desc[name] || {};
            cols[name] = {
                type: normalizeType(c.type),
                allowNull: c.allowNull !== false,
                primaryKey: !!c.primaryKey
            };
        }
        snapshot[table] = cols;
    }

    return {
        snapshot,
        actualHash: sha256(JSON.stringify(canonical(snapshot))),
        dialect,
        missing
    };
}

module.exports = { canonical, modelsSnapshot, actualSchemaHash, normalizeType, sha256 };
