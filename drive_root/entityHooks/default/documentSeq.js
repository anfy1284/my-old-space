/**
 * default.documentSeq — встроенный обработчик МОМЕНТА ВРЕМЕНИ документа (ТЗ §4).
 *
 * Момент времени документа — пара `(date, seq)`. Дата — учётный день, `seq` —
 * момент, когда документ попал НА ЭТОТ ДЕНЬ. Отсюда всё поведение обработчика:
 *
 *   1. СОЗДАНИЕ — момент присваивается всегда, даже если значение пришло с формы:
 *      `seq` не реквизит пользователя, и встречный документ (сторно, коррекция),
 *      собранный копированием исходного, обязан получить СВОЙ момент, а не
 *      унаследовать чужой.
 *   2. ИЗМЕНЕНИЕ — момент переприсваивается ТОЛЬКО при смене `date`. Обычное
 *      сохранение его не трогает: иначе исправление опечатки в комментарии молча
 *      переставило бы документ в конец дня и изменило порядок учёта задним числом.
 *   3. ИЗМЕНЕНИЕ строки без момента (`seq = 0`) — момент присваивается. Так лечатся
 *      строки, доехавшие мимо шлюза: восстановление копии пишет RAW, сырые сидеры
 *      тоже. Это та же логика, что у `default.autoNumber` с очищенным номером.
 *
 * Смена даты определяется сравнением с ТЕКУЩИМ значением в базе, а не по наличию
 * поля в `request.data`: форма присылает дату при каждом сохранении, и «поле
 * пришло» не значит «значение изменилось».
 *
 * Запись `seq` не пробивает замок неизменности: проверка `immutable` стоит в
 * цепочке ПЕРВОЙ и успевает отказать раньше, чем хук что-либо допишет. То есть у
 * закрытого документа дата не меняется, а значит и момент не переприсваивается.
 *
 * Параметры (entityConfig.hooks.before*[n].params):
 *   field     {string} — имя реквизита момента (системно 'seq')
 *   dateField {string} — имя реквизита даты (системно 'date')
 */

'use strict';

const entityMoment = require('../../db/entityMoment');

/** Два значения даты — это один и тот же момент? */
function sameMoment(a, b) {
    const ta = a === null || a === undefined || a === '' ? null : new Date(a).getTime();
    const tb = b === null || b === undefined || b === '' ? null : new Date(b).getTime();
    if (ta === null || tb === null) return ta === tb;
    if (isNaN(ta) || isNaN(tb)) return false;
    return ta === tb;
}

/** Момент не присвоен? Пустое значение BIGINT — 0, а не NULL (см. emptyValues.js). */
function isEmptySeq(v) {
    if (v === null || v === undefined || v === '') return true;
    try { return BigInt(String(v)) === BigInt(entityMoment.EMPTY_SEQ); } catch (e) { return true; }
}

module.exports = async function documentSeq(request, params, context) {
    const field = (params && params.field) || entityMoment.FIELD;
    const dateField = (params && params.dateField) || entityMoment.DATE_FIELD;

    const globalCtx = require('../../globalServerContext');
    const modelName = globalCtx.getModelNameForTable(request.table);
    if (!modelName) return;

    const modelsDB = (context && context.modelsDB) || globalCtx.modelsDB;
    const Model = modelsDB && modelsDB[modelName];
    if (!Model) return;

    if (request.operation === 'update') {
        const uid = request.where && (request.where.UID || request.where.uid);
        if (!uid) return;

        let current = null;
        try {
            current = await Model.findByPk(uid, { raw: true });
        } catch (e) {
            // Не прочитали текущее состояние — значит не знаем, менялась ли дата.
            // Присвоить момент «на всякий случай» нельзя: это тихая перестановка
            // документа в конец дня. Оставляем как есть.
            console.error(`[default.documentSeq] ${request.table}[${uid}]: текущая запись не прочитана: ${e.message}`);
            return;
        }
        if (!current) return;

        const hasDate = !!(request.data && Object.prototype.hasOwnProperty.call(request.data, dateField));
        const dateChanged = hasDate && !sameMoment(current[dateField], request.data[dateField]);
        if (!dateChanged && !isEmptySeq(current[field])) return;
    }

    try {
        if (!request.data) request.data = {};
        request.data[field] = await entityMoment.nextMoment(Model.sequelize);
    } catch (e) {
        // Без момента документ нельзя ни поставить в очередь, ни упорядочить —
        // молчать здесь значит получить неупорядоченный учёт. Операцию прерываем.
        throw new Error(`[default.documentSeq] ${request.table}: момент времени не присвоен: ${e.message}`);
    }
};
