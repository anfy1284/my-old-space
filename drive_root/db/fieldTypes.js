'use strict';

// ─────────────────────────────────────────────────────────────────────
// ТИПЫ ПОЛЕЙ: единственное место, где строка типа из `db.json`
// превращается в тип Sequelize.
//
// Зачем модуль. Резолв был написан одинаково в восьми местах
// (`DataTypes[v.type]` в двух globalServerContext, sessionManager ×2,
// createDB, migrationUtils …). У такой записи два недостатка:
//
//   1. **Параметры типа выразить нечем.** `DataTypes[...]` — обращение по
//      имени, а `DECIMAL(12,2)` требует ВЫЗОВА `DataTypes.DECIMAL(12, 2)`.
//      Без параметров postgres создаёт `numeric` произвольной точности —
//      колонка не держит два знака, и правило «деньги хранятся с точностью
//      до цента» опирается только на аккуратность кода.
//   2. **Опечатка в типе молчит.** Неизвестное имя даёт `undefined`, и
//      падение случается позже, внутри Sequelize, сообщением про другое.
//
// Формат в `db.json` — SQL-подобный, тот же, что человек ожидает увидеть:
//
//   "type": "STRING"           → DataTypes.STRING
//   "type": "STRING(50)"       → DataTypes.STRING(50)
//   "type": "DECIMAL(12,2)"    → DataTypes.DECIMAL(12, 2)
//
// Ключ типа (`typeKey`) отделён от самого типа намеренно: сравнение схем
// при миграции работает с ИМЕНЕМ типа, и параметры там только мешают —
// postgres описывает колонку как `NUMERIC(12,2)`, а модель как `DECIMAL`.
// ─────────────────────────────────────────────────────────────────────

const Sequelize = require('sequelize');
const DataTypes = Sequelize.DataTypes;

/**
 * Разбор строки типа на имя и аргументы.
 * @param {string|Object} spec — "DECIMAL(12,2)" либо уже готовый тип Sequelize
 * @returns {{ key: string, args: number[] }}
 */
function parseTypeSpec(spec) {
    if (!spec) return { key: '', args: [] };
    if (typeof spec !== 'string') {
        // Уже тип Sequelize (или его экземпляр) — имя достаём из него.
        const k = spec.key || (spec.constructor && spec.constructor.key);
        return { key: k ? String(k).toUpperCase() : '', args: [] };
    }
    const m = String(spec).trim().match(/^([A-Za-z_][A-Za-z0-9_ ]*)\s*(?:\(([^)]*)\))?$/);
    if (!m) return { key: String(spec).trim().toUpperCase(), args: [] };

    const key = m[1].trim().toUpperCase();
    const args = (m[2] || '')
        .split(',')
        .map(s => s.trim())
        .filter(s => s !== '')
        .map(s => {
            const n = Number(s);
            if (!isFinite(n)) {
                throw new Error(
                    `[fieldTypes] Тип "${spec}": параметр "${s}" не число. ` +
                    `Поддерживаются только числовые параметры, напр. DECIMAL(12,2).`
                );
            }
            return n;
        });
    return { key, args };
}

/**
 * Имя типа без параметров — для сравнения схем и для карт типов
 * (`emptyValues`, `serialize`). "DECIMAL(12,2)" → "DECIMAL".
 */
function typeKey(spec) {
    return parseTypeSpec(spec).key;
}

/**
 * Строка типа из `db.json` → тип Sequelize.
 *
 * Неизвестное имя — ошибка, а не `undefined`: опечатка в `db.json` должна
 * останавливать старт с внятным текстом, а не всплывать позже внутри ORM.
 */
function resolveDataType(spec) {
    if (spec && typeof spec !== 'string') return spec; // уже тип

    const { key, args } = parseTypeSpec(spec);
    const base = DataTypes[key];
    if (!base) {
        throw new Error(
            `[fieldTypes] Неизвестный тип поля "${spec}". ` +
            `Допустимые имена — типы Sequelize (STRING, TEXT, INTEGER, FLOAT, ` +
            `DECIMAL, BOOLEAN, DATE, DATEONLY, JSON …).`
        );
    }
    if (!args.length) return base;
    if (typeof base !== 'function') {
        throw new Error(`[fieldTypes] Тип "${key}" не принимает параметров, а получил (${args.join(', ')}).`);
    }
    return base(...args);
}

/**
 * Определение поля из `db.json` → определение для `sequelize.define`.
 * Тип заменяется на резолвленный, остальные ключи переносятся как есть.
 */
function resolveFieldDef(fieldOpts) {
    return { ...fieldOpts, type: resolveDataType(fieldOpts.type) };
}

module.exports = {
    parseTypeSpec,
    typeKey,
    resolveDataType,
    resolveFieldDef
};
