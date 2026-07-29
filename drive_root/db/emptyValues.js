'use strict';

// ─────────────────────────────────────────────────────────────────────
// ПУСТЫЕ ЗНАЧЕНИЯ: NULL в базе допустим ТОЛЬКО у полей-ссылок.
//
// Правило проекта (образец — 1С, см. ИНСТРУКЦИИ_ДЛЯ_AI.md, «Системность»):
// у каждого типа есть собственное «пустое» значение, и оно записывается
// вместо NULL.
//
//   число  → 0
//   строка → ""
//   булево → false
//   дата   → 0001-01-01 (пустая дата)
//   ссылка → NULL   ← единственное исключение
//
// Зачем. NULL перегружен: он одновременно значит «не заполнено», «не
// применимо» и «неизвестно», а в сравнениях ведёт себя не как значение
// (`NULL = NULL` ложно). Из-за этого один и тот же смысл в разных строках
// оказывался записан по-разному — где 0, где NULL, — и код, сравнивавший
// напрямую, видел две разные позиции там, где позиция одна. Ровно так из
// счёта пропала плата за собаку: строка прайс-листа с границами возраста
// NULL/NULL и строка с 0/0 считались разными позициями, новая цена не
// заменяла старую, и услуга молча давала ноль.
//
// Два места применения:
//   1) до `sequelize.define` — этот модуль (умолчания в схеме + валидаторы,
//      которые не спотыкаются о пустую строку);
//   2) перед каждой записью — `sanitizeData` в `drive_root/dbGateway.js`.
// Оба обязательны: схема задаёт умолчание для новых строк, шлюз ловит
// значения, пришедшие с формы или из скрипта.
// ─────────────────────────────────────────────────────────────────────

// Пустая дата. Как в 1С: не NULL, а заведомо недостижимая ранняя дата,
// с которой сравнивают при проверке «дата не заполнена».
const EMPTY_DATE = new Date('0001-01-01T00:00:00.000Z');

const NUMERIC_TYPES = new Set([
    'INTEGER', 'BIGINT', 'FLOAT', 'DOUBLE', 'DOUBLE PRECISION',
    'DECIMAL', 'REAL', 'NUMBER', 'SMALLINT', 'TINYINT', 'MEDIUMINT'
]);
const STRING_TYPES  = new Set(['STRING', 'TEXT', 'CHAR', 'CITEXT', 'UUID', 'UUIDV4']);
const BOOLEAN_TYPES = new Set(['BOOLEAN']);
const DATE_TYPES    = new Set(['DATE', 'DATEONLY', 'DATETIME', 'TIME']);

// Тип из определения db.json (строка) или из rawAttributes Sequelize (объект).
function typeKeyOf(fieldOrAttr) {
    if (!fieldOrAttr) return '';
    const t = fieldOrAttr.type;
    if (typeof t === 'string') return t.toUpperCase().replace(/\(.*$/, '').trim();
    const k = t && (t.key || (t.constructor && t.constructor.key));
    return k ? String(k).toUpperCase() : '';
}

// Поле-ссылка: только у него NULL законен.
// `references` — форма Sequelize, `foreignKey` — форма db.json проекта.
function isReferenceField(fieldOrAttr) {
    return !!(fieldOrAttr && (fieldOrAttr.references || fieldOrAttr.foreignKey));
}

// Пустое значение для типа. Для ссылки — null. Для неизвестного типа —
// undefined: трогать не будем, чтобы не испортить то, чего не поняли.
function emptyValueFor(fieldOrAttr) {
    if (isReferenceField(fieldOrAttr)) return null;
    const k = typeKeyOf(fieldOrAttr);
    if (NUMERIC_TYPES.has(k)) return 0;
    if (STRING_TYPES.has(k))  return '';
    if (BOOLEAN_TYPES.has(k)) return false;
    if (DATE_TYPES.has(k))    return EMPTY_DATE;
    return undefined;
}

// Значение считается «пустым» и подлежит замене.
// Пустая строка для числа/даты/булева — это тоже «пусто» (приходит с формы).
function isEmptyValue(v) {
    return v === null || v === undefined || v === '';
}

// Дата пуста, если это NULL или ровно EMPTY_DATE. Для прикладного кода:
// проверять заполненность даты сравнением с этим, а не с null.
function isEmptyDate(v) {
    if (v == null || v === '') return true;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) || d.getTime() <= EMPTY_DATE.getTime();
}

// ── Валидаторы, не спотыкающиеся о пустую строку ─────────────────────
// Sequelize пропускает валидаторы только для null. Пустую строку он гонит
// через `isEmail` и роняет сохранение — ровно поэтому раньше "" приводили
// к NULL у nullable-полей с валидаторами. Теперь "" законное пустое
// значение, поэтому валидатор обязан его пропускать.
//
// Оборачиваем встроенные валидаторы в функцию, которая выходит на пустом
// значении и в остальных случаях зовёт штатную проверку Sequelize.
function wrapValidatorsSkipEmpty(fieldDef) {
    if (!fieldDef || !fieldDef.validate) return 0;
    let Validator = null;
    try { Validator = require('sequelize').Validator; } catch (e) { /* нет — не оборачиваем */ }
    if (!Validator) return 0;

    const wrapped = {};
    let n = 0;
    for (const [name, arg] of Object.entries(fieldDef.validate)) {
        // Пользовательские валидаторы-функции не трогаем: их автор сам
        // решает, как относиться к пустому значению.
        if (typeof arg === 'function') { wrapped[name] = arg; continue; }
        const check = Validator[name];
        if (typeof check !== 'function') { wrapped[name] = arg; continue; }

        const msg = (arg && typeof arg === 'object' && arg.msg) ? arg.msg : `Validation ${name} failed`;
        const args = (arg && typeof arg === 'object' && Array.isArray(arg.args)) ? arg.args : [];
        wrapped[`${name}OrEmpty`] = function (value) {
            if (value === null || value === undefined || value === '') return;
            if (!check(String(value), ...args)) throw new Error(msg);
        };
        n++;
    }
    fieldDef.validate = wrapped;
    return n;
}

// ── Инъекция в определения моделей (до sequelize.define) ─────────────
// Проставляет defaultValue пустым значением типа и снимает allowNull у
// нессылочных полей — чтобы правило держала сама схема, а не только
// договорённость. Поля-ссылки не трогаются: там NULL законен.
//
// ВАЖНО: `allowNull: false` ставится только если у поля есть внятное
// пустое значение. Иначе notNull-ограничение уронит запись там, где мы
// не понимаем тип.
function injectEmptyDefaults(mergedModelsDef, { enforceNotNull = false } = {}) {
    if (!Array.isArray(mergedModelsDef)) return { fields: 0, validators: 0 };
    let fields = 0, validators = 0;

    for (const def of mergedModelsDef) {
        const flds = def && def.fields;
        if (!flds || typeof flds !== 'object') continue;

        for (const [name, fd] of Object.entries(flds)) {
            if (!fd || typeof fd !== 'object') continue;
            if (name === 'UID' || fd.primaryKey) continue;
            if (isReferenceField(fd)) continue;

            validators += wrapValidatorsSkipEmpty(fd);

            const empty = emptyValueFor(fd);
            if (empty === undefined) continue;

            if (fd.defaultValue === undefined || fd.defaultValue === null) {
                fd.defaultValue = empty;
                fields++;
            }
            if (enforceNotNull) fd.allowNull = false;
        }
    }
    return { fields, validators };
}

module.exports = {
    EMPTY_DATE,
    typeKeyOf,
    isReferenceField,
    emptyValueFor,
    isEmptyValue,
    isEmptyDate,
    wrapValidatorsSkipEmpty,
    injectEmptyDefaults
};
