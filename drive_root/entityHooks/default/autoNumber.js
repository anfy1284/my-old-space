/**
 * default.autoNumber — встроенный обработчик автонумерации.
 *
 * Алгоритм (как в 1С):
 *   1. Если поле уже заполнено — не трогаем (пользователь ввёл вручную).
 *   2. SELECT MAX(field) из таблицы (с опциональным фильтром периода).
 *   3. Ищем хвостовые цифры в результате:
 *        "R00-01" → prefix="R00-", digits="01" → "R00-02"
 *        "00041"  → prefix="",     digits="00041" → "00042"
 *        "ЙЦУК"   → нет цифр                     → "ЙЦУК1"
 *   4. Длина числовой части сохраняется (при переполнении растёт).
 *   5. Первая запись (MAX=null) — формат из params: prefix + padStart(length, '0').
 *
 * Параметры (entityConfig.hooks.beforeCreate[n].params):
 *   field   {string}      — имя поля для номера (обязательно)
 *   length  {number}      — длина числовой части для ПЕРВОЙ записи (по умолчанию 5)
 *   prefix  {string}      — префикс для ПЕРВОЙ записи (по умолчанию "")
 *   period  {string|null} — периодичность сброса: null/"year"/"month" (по умолчанию null)
 */

'use strict';

const { Op } = require('sequelize');

module.exports = async function autoNumber(request, params, context) {
    const { field, length = 5, prefix = '', period = null } = params;

    if (!field) {
        throw new Error('[default.autoNumber] "field" param is required');
    }

    // Если поле уже заполнено — пользователь ввёл номер вручную, не трогаем
    const currentValue = request.data && request.data[field];
    if (currentValue !== null && currentValue !== undefined && currentValue !== '') {
        return;
    }

    const { modelsDB, dbGateway } = context;
    const globalCtx = require('../../globalServerContext');
    const modelName = globalCtx.getModelNameForTable(request.table);
    if (!modelName) return;

    const Model = modelsDB[modelName];
    if (!Model) return;

    // Строим фильтр периода
    const where = {};
    if (period === 'year') {
        const now = new Date();
        const startOfYear = new Date(now.getFullYear(), 0, 1);
        const endOfYear = new Date(now.getFullYear() + 1, 0, 1);
        where.createdAt = { [Op.gte]: startOfYear, [Op.lt]: endOfYear };
    } else if (period === 'month') {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        where.createdAt = { [Op.gte]: startOfMonth, [Op.lt]: endOfMonth };
    }

    // SELECT MAX(field) с учётом периода
    let maxRow = null;
    try {
        const queryOpts = { attributes: [[require('sequelize').fn('MAX', require('sequelize').col(field)), 'maxVal']], raw: true };
        if (Object.keys(where).length > 0) queryOpts.where = where;
        const rows = await Model.findAll(queryOpts);
        maxRow = rows && rows[0] ? rows[0].maxVal : null;
    } catch (e) {
        console.error(`[default.autoNumber] MAX query failed for "${request.table}.${field}":`, e.message);
        maxRow = null;
    }

    // Вычисляем следующий номер из максимального значения
    let nextValue;

    if (maxRow === null || maxRow === undefined) {
        // Первая запись в таблице — используем params для начального формата
        const numStr = String(1).padStart(length, '0');
        nextValue = prefix + numStr;
    } else {
        const maxStr = String(maxRow);
        // Ищем хвостовые цифры: всё до них — префикс, их инкрементируем
        const match = maxStr.match(/^([\s\S]*?)(\d+)$/);
        if (match) {
            const existingPrefix = match[1]; // "R00-", "", "Б-" и т.д.
            const digits = match[2];         // "01", "0041" и т.д.
            const nextNum = parseInt(digits, 10) + 1;
            // Сохраняем длину (не уменьшаем), позволяем расти при переполнении
            const padLen = Math.max(digits.length, String(nextNum).length);
            nextValue = existingPrefix + String(nextNum).padStart(padLen, '0');
        } else {
            // Нет цифр вообще ("ЙЦУК") — добавляем "1" в конец
            nextValue = maxStr + '1';
        }
    }

    request.data[field] = nextValue;
    console.log(`[default.autoNumber] ${request.table}.${field} = "${request.data[field]}"`);
};
