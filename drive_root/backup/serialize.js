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
        if (isNaN(d.getTime())) return null;
        // СТРОКОЙ ISO В UTC, а не объектом `Date`.
        //
        // Восстановление вставляет строки сырым SQL с именованными подстановками, а
        // Sequelize форматирует объект `Date` через ЛОКАЛЬНУЮ зону процесса. Для
        // современных дат смещение зоны кратно минутам и на результате не сказывается,
        // но у дат первого года действует историческое среднее солнечное время
        // (Europe/Berlin — UTC+0:53:28), и остаток в 28 СЕКУНД переживает преобразование.
        //
        // Практическое следствие: платформенная «пустая дата» `0001-01-01T00:00:00Z`
        // после восстановления превращалась в `0001-01-01T00:00:28Z`. Функционально
        // это ещё «пусто» (`isEmptyDate` сравнивает по `<=`), но данные УЖЕ не те, что
        // были, — а восстановление обязано воспроизводить, а не пересчитывать.
        // Строка-литерал разбирается самой СУБД и через локальную зону не проходит.
        // Поймано побайтовым сравнением восстановленной базы со схемой отката.
        return d.toISOString();
    }
    if (BLOB_TYPES.has(key)) return Buffer.from(String(value), 'base64');
    if (JSON_TYPES.has(key)) {
        // ТЕКСТОМ, а не объектом. Восстановление вставляет строки сырым SQL с
        // именованными подстановками, а экранирование Sequelize объект не принимает —
        // падает с «Invalid value { … }» на середине загрузки. СУБД разбирает
        // JSON-литерал из текста сама, и это работает одинаково на всех диалектах
        // (в SQLite такая колонка и хранится текстом).
        // Поймано живым прогоном: восстановление падало на `user_settings_fields`.
        return typeof value === 'string' ? value : JSON.stringify(value);
    }
    return value;
}

/**
 * Служебные отметки времени Sequelize (`createdAt`/`updatedAt`/`deletedAt`).
 *
 * В `def.fields` их НЕТ — их добавляет сама ORM по `options.timestamps`. Поэтому
 * наивный обход полей модели молча выбрасывает их из дампа, и восстановление либо
 * падает на `NOT NULL`, либо (что хуже) проставляет всем строкам момент
 * восстановления: «когда документ создан» — единственный след его происхождения, и
 * терять его нельзя. Ровно та же ошибка однажды была допущена в переносе данных при
 * миграции таблиц (B1), и лечится она так же — явным перечислением этих колонок.
 *
 * Имена берутся из опций: Sequelize позволяет их переименовать или отключить
 * поштучно (`updatedAt: false`).
 */
function serviceFields(model) {
    const opts = (model && model.options) || {};
    if (opts.timestamps === false) return {};
    const out = {};
    const nameOf = (key, dflt) => {
        const v = opts[key];
        if (v === false) return null;
        return (typeof v === 'string' && v) ? v : dflt;
    };
    const c = nameOf('createdAt', 'createdAt'); if (c) out[c] = { type: 'DATE' };
    const u = nameOf('updatedAt', 'updatedAt'); if (u) out[u] = { type: 'DATE' };
    if (opts.paranoid) { const d = nameOf('deletedAt', 'deletedAt'); if (d) out[d] = { type: 'DATE' }; }
    return out;
}

/**
 * Полный набор колонок таблицы = объявленные поля + служебные отметки времени.
 * Единая точка для выгрузки и восстановления — второго списка быть не должно.
 *
 * Имена ОТСОРТИРОВАНЫ, и это не косметика. Порядок ключей в строке дампа задаётся
 * порядком обхода этого объекта, а определения моделей приходят к нам двумя разными
 * путями: из живого реестра (порядок ОБЪЯВЛЕНИЯ полей) и из снимка внутри дампа
 * (канонический, то есть алфавитный). Значения при этом одни и те же, но текст строки
 * получается разным — а по тексту считается контрольная сумма таблицы. Следствие:
 * копия, снятая после восстановления, имела ДРУГИЕ контрольные суммы при тех же
 * данных, и сверка round-trip между СУБД (ТЗ, приёмка §9 п. 2) оказывалась
 * невыполнимой в принципе. Сортировка делает представление строки каноническим
 * независимо от происхождения определений. Поймано прогоном postgres → sqlite → дамп.
 */
function modelFields(model) {
    // Явно объявленное поле важнее служебного умолчания (напр. `deletedAt` как
    // прикладной реквизит в `backup_files`).
    const merged = Object.assign({}, serviceFields(model), (model && model.fields) || {});
    const out = {};
    for (const name of Object.keys(merged).sort()) out[name] = merged[name];
    return out;
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

module.exports = {
    toDump, fromDump, rowToDump, dateOnlyToString, dateToString, isReferenceField,
    serviceFields, modelFields
};
