'use strict';

/**
 * types — типы настроек: проверка объявления, приведение значения и сериализация.
 *
 * Значения настроек лежат в JSON-колонке (`settings_values.data`), поэтому у каждого
 * типа две стороны:
 *   `serialize` — значение → то, что переживёт JSON (дата ISO-строкой, деньги строкой);
 *   `coerce`    — то, что достали из JSON → значение для прикладного кода.
 * Обе стороны обязаны быть согласованы, иначе «прочитали не то, что записали» вылезет
 * не там, где ошиблись.
 *
 * Отдельных `getNumber`/`getBoolean`, как в старом `apps/systemSettings/lib`, не будет:
 * тип известен из декларации, и приводить его — работа ядра, а не вызывающего.
 *
 * @module drive_root/settings/types
 */

const money = require('../db/money');
const emptyValues = require('../db/emptyValues');

const EMPTY_DATE = emptyValues.EMPTY_DATE;

/** Допустимые типы настроек (см. §4.3 ТЗ). */
const TYPES = new Set(['string', 'text', 'number', 'boolean', 'date', 'money', 'enum', 'reference']);

function isKnownType(type) {
    return TYPES.has(String(type || ''));
}

/** Пусто ли значение «в смысле пользователя» (не задано). */
function isBlank(v) {
    return v === null || v === undefined || v === '';
}

/**
 * Значение из хранилища → значение для прикладного кода.
 * @param {Object} decl — объявление настройки
 * @param {*} raw — то, что лежало в JSON
 */
function coerce(decl, raw) {
    const type = decl && decl.type;
    switch (type) {
        case 'boolean':
            // Булево «не задано» — это false, а не null: `if (v)` у вызывающего должен
            // работать без оговорок.
            return raw === true || raw === 'true';

        case 'number': {
            if (isBlank(raw)) return null;
            const n = (typeof raw === 'number') ? raw : Number(raw);
            return Number.isFinite(n) ? n : null;
        }

        case 'money':
            // Деньги — строка с двумя знаками, как во всей системе (drive_root/db/money.js).
            return isBlank(raw) ? money.db(0) : money.db(raw);

        case 'date': {
            // Незаполненная дата — 0001-01-01, а не null («у каждого типа своё пустое»).
            if (isBlank(raw)) return new Date(EMPTY_DATE);
            const d = raw instanceof Date ? raw : new Date(raw);
            return isNaN(d.getTime()) ? new Date(EMPTY_DATE) : d;
        }

        case 'reference':
        case 'enum':
            return isBlank(raw) ? null : String(raw);

        case 'string':
        case 'text':
        default:
            return isBlank(raw) ? null : String(raw);
    }
}

/**
 * Значение → то, что кладём в JSON-колонку.
 * @param {Object} decl
 * @param {*} value
 */
function serialize(decl, value) {
    const type = decl && decl.type;
    switch (type) {
        case 'boolean':
            return value === true || value === 'true';

        case 'number': {
            if (isBlank(value)) return null;
            const n = (typeof value === 'number') ? value : Number(value);
            return Number.isFinite(n) ? n : null;
        }

        case 'money':
            return isBlank(value) ? null : money.db(value);

        case 'date': {
            if (isBlank(value)) return EMPTY_DATE.toISOString();
            const d = value instanceof Date ? value : new Date(value);
            return isNaN(d.getTime()) ? EMPTY_DATE.toISOString() : d.toISOString();
        }

        case 'reference':
        case 'enum':
            return isBlank(value) ? null : String(value);

        case 'string':
        case 'text':
        default:
            return isBlank(value) ? null : String(value);
    }
}

/**
 * Проверить значение по объявлению.
 *
 * Существование записи справочника здесь НЕ проверяется: для этого нужны модели, а этот
 * модуль о базе ничего не знает. Проверку делает `settings/index.js` при чтении и записи.
 *
 * @returns {{ok: true, value: *} | {ok: false, error: string}}
 */
function validate(decl, value) {
    const type = decl && decl.type;
    if (!isKnownType(type)) return { ok: false, error: `неизвестный тип "${type}"` };

    if (type === 'number' && !isBlank(value)) {
        const n = (typeof value === 'number') ? value : Number(value);
        if (!Number.isFinite(n)) return { ok: false, error: `не число: "${value}"` };
    }

    if (type === 'money' && !isBlank(value)) {
        const n = money.num(value);
        if (!Number.isFinite(n)) return { ok: false, error: `не сумма: "${value}"` };
    }

    if (type === 'date' && !isBlank(value)) {
        const d = value instanceof Date ? value : new Date(value);
        if (isNaN(d.getTime())) return { ok: false, error: `не дата: "${value}"` };
    }

    if (type === 'enum' && !isBlank(value)) {
        const allowed = (decl.options || []).map(o => String(o.value));
        if (allowed.indexOf(String(value)) < 0) {
            return { ok: false, error: `значение "${value}" не из списка: ${allowed.join(', ')}` };
        }
    }

    return { ok: true, value: serialize(decl, value) };
}

/**
 * Набор значений из JSON-колонки.
 *
 * `raw: true` отдаёт колонку так, как её вернул драйвер: PostgreSQL — объектом,
 * SQLite — строкой. Разбор здесь, а не у вызывающих: иначе разница диалектов вылезет
 * в прикладном коде.
 */
function parseData(raw) {
    if (!raw) return {};
    if (typeof raw === 'string') {
        try { const parsed = JSON.parse(raw); return (parsed && typeof parsed === 'object') ? parsed : {}; }
        catch (e) { return {}; }
    }
    return (typeof raw === 'object') ? raw : {};
}

module.exports = { TYPES, isKnownType, isBlank, coerce, serialize, validate, parseData, EMPTY_DATE };
