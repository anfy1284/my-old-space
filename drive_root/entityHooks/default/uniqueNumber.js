/**
 * default.uniqueNumber — встроенный обработчик контроля уникальности номера сущности.
 *
 * Срабатывает на beforeCreate/beforeUpdate (после default.autoNumber). Если значение
 * реквизита `number` (или иного, заданного params.field) уже встречается в другой записи
 * этой таблицы — бросает ошибку, прерывая сохранение. Сама запись (update) исключается
 * из проверки по UID.
 *
 * УНИКАЛЬНОСТЬ ПРОВЕРЯЕТСЯ В РАЗРЕЗЕ ОРГАНИЗАЦИИ — той же областью, в которой выдаёт
 * номера `default.autoNumber` (общий модуль `numberScope`). Иначе получается пара,
 * которая противоречит сама себе: автонумерация считает `MAX` по своей организации и
 * выдаёт номер, а проверка ищет совпадение по ВСЕЙ таблице и этот же номер отвергает,
 * потому что он занят у соседнего арендатора. Обе стороны обязаны понимать область
 * одинаково.
 *
 * Включается/отключается на уровне сущности: entityConfig.uniqueNumber (по умолчанию true).
 * Навешивается централизованно в drive_root/db/entityNumber.js, как и автонумерация.
 *
 * Параметры (entityConfig.hooks[event][n].params):
 *   field      {string}      — имя проверяемого поля (по умолчанию "number")
 *   scopeField {string|null} — реквизит области (по умолчанию "organizationId")
 */

'use strict';

const { Op } = require('sequelize');
const { resolveScopeValue, extractSelfUID: _extractSelfUID } = require('./numberScope');

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

    // Та же область, что у автонумерации: одинаковый номер у РАЗНЫХ организаций —
    // норма, а не дубликат.
    const scope = await resolveScopeValue(request, Model, params || {});
    if (scope.scoped) where[scope.field] = scope.value;

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
