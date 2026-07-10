/**
 * default.documentDate — встроенный обработчик системной даты документа.
 *
 * Алгоритм:
 *   1. Работает только на create (beforeCreate). На update дата не трогается —
 *      правка документа не «передатирует» его.
 *   2. Если поле уже заполнено (ручной ввод пользователя / данные формы) — не трогаем.
 *   3. Иначе — присваиваем текущие дату-время (new Date()).
 *
 * Параметры (entityConfig.hooks.beforeCreate[n].params):
 *   field {string} — имя поля даты (обязательно, системно 'date')
 */

'use strict';

module.exports = async function documentDate(request, params) {
    const { field } = params;

    if (!field) {
        throw new Error('[default.documentDate] "field" param is required');
    }

    if (request.operation === 'update') return;

    const currentValue = request.data ? request.data[field] : undefined;
    const isEmpty = currentValue === null || currentValue === undefined || currentValue === '';
    if (!isEmpty) return;

    if (!request.data) request.data = {};
    request.data[field] = new Date();
};
