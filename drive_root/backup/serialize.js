'use strict';

/**
 * serialize — представление значений в дампе.
 *
 * ГЛАВНОЕ ПРАВИЛО (ТЗ §3.5): сериализуем по ОБЪЯВЛЕННОМУ ТИПУ МОДЕЛИ, а не по типу
 * пришедшего JS-значения. Драйверы отдают одно и то же по-разному: `DECIMAL` из
 * Postgres приезжает строкой, из SQLite числом; булево в SQLite это 0/1; даты то
 * объектом, то строкой. Сериализация «как пришло» сделала бы дамп зависимым от СУБД,
 * из которой он снят, — а по дампу не должно быть видно, где он снят.
 *
 * Определение типа переиспользует `emptyValues.typeKeyOf`: он уже понимает и форму
 * `db.json` (тип строкой), и `rawAttributes` Sequelize (тип объектом).
 */

const { typeKeyOf, isReferenceField } = require('../db/emptyValues');

// Точные числа: через double они теряют разряды, а деньги в этом проекте — DECIMAL.
const EXACT_NUMERIC = new Set(['DECIMAL', 'NUMERIC', 'BIGINT']);
const INT_NUMERIC = new Set(['INTEGER', 'SMALLINT', 'TINYINT', 'MEDIUMINT']);
const FLOAT_NUMERIC = new Set(['FLOAT', 'DOUBLE', 'DOUBLE PRECISION', 'REAL', 'NUMBER']);
const BOOL_TYPES = new Set(['BOOLEAN']);
const BLOB_TYPES = new Set(['BLOB', 'BINARY', 'VARBINARY', 'BYTEA']);
const JSON_TYPES = new Set(['JSON', 'JSONB']);

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * `DATEONLY` — календарная дата БЕЗ времени и БЕЗ зоны.
 *
 * Её нельзя гнать через ISO-строку с `Z`: дата, записанная как полночь UTC, при
 * обратном разборе в зоне восточнее Гринвича превращается в следующий день, а
 * западнее — в предыдущий. Тихий сдвиг даты заезда на сутки. Поэтому только
 * `YYYY-MM-DD`, и компоненты берутся UTC-шные — драйвер отдаёт эту дату как полночь UTC.
 */
function dateOnlyToString(v) {
    if (typeof v === 'string') {
        const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    }
    const d = v instanceof Date ? v : new Date(v);
    if (isNaN(d.getTime())) return null;
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Момент времени — всегда ISO-8601 в UTC с явным `Z`. */
function dateToString(v) {
    const d = v instanceof Date ? v : new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
}

/**
 * Значение → представление в дампе.
 * @param {*} value — как пришло из драйвера (raw)
 * @param {Object} fieldDef — определение поля (db.json или rawAttributes)
 * @returns {*} JSON-совместимое значение
 */
function toDump(value, fieldDef) {
    if (value === null || value === undefined) return null;
    const key = typeKeyOf(fieldDef);

    if (EXACT_NUMERIC.has(key)) {
        // Строкой — и только строкой: `"123.45"` переживает любой диалект без потерь.
        return typeof value === 'string' ? value : String(value);
    }
    if (INT_NUMERIC.has(key) || FLOAT_NUMERIC.has(key)) {
        const n = typeof value === 'number' ? value : Number(value);
        return isFinite(n) ? n : null;
    }
    if (BOOL_TYPES.has(key)) {
        // SQLite отдаёт 0/1, Postgres — true/false, форма могла прислать "true".
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        return String(value).toLowerCase() === 'true' || String(value) === '1';
    }
    if (key === 'DATEONLY') return dateOnlyToString(value);
    if (key === 'DATE' || key === 'DATETIME') return dateToString(value);
    if (key === 'TIME') return String(value);
    if (BLOB_TYPES.has(key)) {
        return Buffer.isBuffer(value) ? value.toString('base64') : Buffer.from(String(value)).toString('base64');
    }
    if (JSON_TYPES.has(key)) {
        // Postgres отдаёт разобранный объект, SQLite — строку. В дампе всегда значение.
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); } catch (e) { return value; }
    }
    // STRING/TEXT/UUID и всё, чего мы не знаем: строкой, но не превращая объект в "[object Object]".
    return typeof value === 'string' ? value : (typeof value === 'object' ? value : String(value));
}

/**
 * Представление из дампа → значение для вставки.
 *
 * Тип берётся из снимка моделей, лежащего В ДАМПЕ (а не из актуальных), — иначе при
 * восстановлении старой копии значение приведётся к типу, которого тогда не было.
 * @param {*} value
 * @param {Object} fieldDef
 * @returns {*}
 */
function fromDump(value, fieldDef) {
    if (value === null || value === undefined) return null;
    const key = typeKeyOf(fieldDef);

    if (EXACT_NUMERIC.has(key)) return String(value);
    if (INT_NUMERIC.has(key)) {
        const n = Number(value);
        return isFinite(n) ? Math.trunc(n) : null;
    }
    if (FLOAT_NUMERIC.has(key)) {
        const n = Number(value);
        return isFinite(n) ? n : null;
    }
    if (BOOL_TYPES.has(key)) return value === true || value === 1 || String(value).toLowerCase() === 'true';
    if (key === 'DATEONLY') return dateOnlyToString(value);
    if (key === 'DATE' || key === 'DATETIME') {
        const d = new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }
    if (BLOB_TYPES.has(key)) return Buffer.from(String(value), 'base64');
    if (JSON_TYPES.has(key)) return value;
    return value;
}

/**
 * Сериализовать строку целиком по определению модели.
 *
 * Колонки, которых нет в модели, ОТБРАСЫВАЮТСЯ молча: они не будут воссозданы при
 * восстановлении (структура строится из снимка моделей), и тащить их в дамп —
 * создавать иллюзию, что они переживут round-trip. Их наличие — отдельный сигнал
 * уровня «неизвестные объекты» (§0), а не забота сериализатора.
 */
function rowToDump(row, fields) {
    const out = {};
    for (const [name, def] of Object.entries(fields)) {
        if (!(name in row)) continue;
        out[name] = toDump(row[name], def);
    }
    return out;
}

module.exports = { toDump, fromDump, rowToDump, dateOnlyToString, dateToString, isReferenceField };
