/**
 * default.uniqueNumber — встроенный обработчик контроля уникальности номера сущности.
 *
 * Срабатывает на beforeCreate/beforeUpdate (после default.autoNumber). Если значение
 * реквизита `number` (или иного, заданного params.field) уже встречается в другой записи
 * этой таблицы — бросает ошибку, прерывая сохранение. Сама запись (update) исключается
 * из проверки по UID.
 *
 * Включается/отключается на уровне сущности: entityConfig.uniqueNumber (по умолчанию true).
 * Навешивается централизованно в drive_root/db/entityNumber.js, как и автонумерация.
 *
 * Параметры (entityConfig.hooks[event][n].params):
 *   field {string} — имя проверяемого поля (по умолчанию "number")
 */

'use strict';

const { Op } = require('sequelize');

// Достаёт UID текущей записи из where. Важно: к моменту запуска хука (root-уровень)
// app-level RLS-middleware уже мог обернуть исходный where в { [Op.and]: [ {UID}, {Op.or:[…]} ] },
// поэтому прямого where.UID может не быть — рекурсивно ищем равенство по UID
// (строковое значение), проходя массивы Op.and / Op.or.
function _extractSelfUID(where) {
    if (!where || typeof where !== 'object') return null;
    const direct = where.UID || where.uid;
    if (typeof direct === 'string') return direct;
    for (const opKey of [Op.and, Op.or]) {
        const arr = where[opKey];
        if (Array.isArray(arr)) {
            for (const sub of arr) {
                const found = _extractSelfUID(sub);
                if (found) return found;
            }
        }
    }
    return null;
}

module.exports = async function uniqueNumber(request, params, context) {
    const { field = 'number' } = params || {};

    const value = request.data ? request.data[field] : undefined;
    // Пусто — нечего проверять (автонумерация присвоит/уже присвоила значение,
    // которое уникально по построению).
    if (value === null || value === undefined || value === '') return;

    const { modelsDB } = context;
    const globalCtx = require('../../globalServerContext');
    const modelName = globalCtx.getModelNameForTable(request.table);
    if (!modelName) return;
    const Model = modelsDB[modelName];
    if (!Model) return;

    // Исключаем саму запись из проверки (иначе нельзя сохранить существующую запись,
    // не меняя номер). UID берём из data или из (возможно обёрнутого RLS) where.
    const selfUID = (request.data && request.data.UID)
        || _extractSelfUID(request.where)
        || null;
    const where = { [field]: value };
    if (selfUID) where.UID = { [Op.ne]: selfUID };

    let dup = null;
    try {
        dup = await Model.findOne({ where, attributes: ['UID'], raw: true });
    } catch (e) {
        // Сбой самой проверки не должен молча блокировать сохранение — логируем и пропускаем.
        console.error(`[default.uniqueNumber] uniqueness query failed for "${request.table}.${field}":`, e.message);
        return;
    }

    if (dup) {
        let msg = null;
        try {
            const { tfForSession } = require('../../../drive_forms/globalServerContext');
            msg = await tfForSession('number_not_unique', context.sessionID, { number: value });
        } catch (e) { /* fallback ниже */ }
        throw new Error(msg || `Number "${value}" already exists`);
    }
};
