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
 * НУМЕРАЦИЯ ВЕДЁТСЯ В РАЗРЕЗЕ ОРГАНИЗАЦИИ (как в 1С — по информационной базе, а у нас
 * арендаторов несколько в одной). Инсталляция обслуживает несколько организаций, и
 * общая сквозная нумерация означала бы, что счёт клиента А получает номер, зависящий от
 * того, сколько документов завёл клиент Б: номера прыгают через десятки, а по журналу
 * одной организации видны дыры, которых она себе не объясняет. Поэтому `MAX` берётся
 * среди записей ТОЙ ЖЕ организации, и у каждой организации своя непрерывная нумерация.
 *
 * Сужение применяется, только если у таблицы ЕСТЬ реквизит области (`scopeField`).
 * Таблицы ядра без организации (`scheduler_*`, `backup_config`, `db_versions`)
 * нумеруются сквозным образом, как и раньше.
 *
 * Параметры (entityConfig.hooks.beforeCreate[n].params):
 *   field      {string}      — имя поля для номера (обязательно)
 *   length     {number}      — длина числовой части для ПЕРВОЙ записи (по умолчанию 5)
 *   prefix     {string}      — префикс для ПЕРВОЙ записи (по умолчанию "")
 *   period     {string|null} — периодичность сброса: null/"year"/"month" (по умолчанию null)
 *   scopeField {string|null} — реквизит области нумерации (по умолчанию "organizationId";
 *                              `null` — сквозная нумерация по всей таблице)
 */

'use strict';

const { Op } = require('sequelize');
const { resolveScopeValue } = require('./numberScope');

module.exports = async function autoNumber(request, params, context) {
    const { field, length = 5, prefix = '', period = null } = params;

    if (!field) {
        throw new Error('[default.autoNumber] "field" param is required');
    }

    // Определяем заполненность поля и тип операции.
    //  create: пустое/отсутствующее поле → присвоить номер; заполненное (ручной ввод) → не трогать.
    //  update: трогаем ТОЛЬКО если поле явно передано и очищено (пользователь стёр номер) —
    //          тогда присваиваем новый, как при создании. Если поле не пришло в changes
    //          или содержит значение — оставляем как есть (обычное редактирование не
    //          перенумеровывает запись).
    const op = request.operation;
    const hasField = !!(request.data && Object.prototype.hasOwnProperty.call(request.data, field));
    const currentValue = hasField ? request.data[field] : undefined;
    const isEmpty = currentValue === null || currentValue === undefined || currentValue === '';
    if (op === 'update') {
        if (!hasField || !isEmpty) return;
    } else {
        if (!isEmpty) return;
    }

    const { modelsDB, dbGateway } = context;
    const globalCtx = require('../../globalServerContext');
    const modelName = globalCtx.getModelNameForTable(request.table);
    if (!modelName) return;

    const Model = modelsDB[modelName];
    if (!Model) return;

    // Область нумерации: своя непрерывная последовательность у каждой организации.
    const scope = await resolveScopeValue(request, Model, params);

    // Строим фильтр периода
    const where = {};
    if (scope.scoped) where[scope.field] = scope.value;
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
    console.log(`[default.autoNumber] ${request.table}.${field} = "${request.data[field]}"`
        + (scope.scoped ? ` (${scope.field}=${scope.value || '∅'})` : ''));
};
