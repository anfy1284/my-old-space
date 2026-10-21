/**
 * default.autoNumber — встроенный обработчик автонумерации.
 *
 * Алгоритм (как в классических учётных системах):
 *   1. Если поле уже заполнено — не трогаем (пользователь ввёл вручную).
 *   2. Читаем ВСЕ номера области (организации): образец формата — номер последней
 *      созданной записи, продолжение — ЧИСЛОВОЙ максимум среди номеров с тем же
 *      префиксом (не строковый MAX: при «1…59» он даёт «9»).
 *   3. Хвостовые цифры образца:
 *        "R00-01" → prefix="R00-", digits="01" → "R00-02"
 *        "00041"  → prefix="",     digits="00041" → "00042"
 *        "ЙЦУК"   → нет цифр                     → "ЙЦУК1"
 *   4. Длина числовой части сохраняется (при переполнении растёт).
 *   5. Первая запись — формат из params: prefix + padStart(length, '0').
 *   6. Кандидат, который уже есть в области, пропускается — до первого свободного.
 *
 * НУМЕРАЦИЯ ВЕДЁТСЯ В РАЗРЕЗЕ ОРГАНИЗАЦИИ (как в учётных системах — по информационной базе, а у нас
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

const { resolveScopeValue, scopeCondition } = require('./numberScope');

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

    // Границы периода нумерации (сброс по году/месяцу), по дате создания записи.
    let periodRange = null;
    if (period === 'year') {
        const now = new Date();
        periodRange = { from: new Date(now.getFullYear(), 0, 1), to: new Date(now.getFullYear() + 1, 0, 1) };
    } else if (period === 'month') {
        const now = new Date();
        periodRange = { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
    }

    // ВСЕ НОМЕРА ОБЛАСТИ — без фильтра периода (15.10.2026).
    //
    // Раньше следующий номер считался от `MAX(number)`, а номер — СТРОКА: при
    // номерах 1…59 строковый максимум — «9», следующий «10» уже существовал, и
    // сохранение падало на проверке уникальности. Владелец: «инкрементор не должен
    // пытаться создать номер, который уже есть в базе, какие бы номера в каком бы
    // порядке ни существовали». Поэтому:
    //   1. число сравнивается как ЧИСЛО, а не как строка;
    //   2. кандидат проверяется по всем занятым номерам ТОЙ ЖЕ области, в которой
    //      их проверяет `uniqueNumber` (организация, без периода), и, пока он занят,
    //      растёт дальше. Помеченные на удаление тоже занимают номер — они в базе.
    const scopeWhere = scopeCondition(scope);

    let rows = [];
    try {
        const queryOpts = { attributes: [field, 'createdAt'], raw: true };
        if (Object.keys(scopeWhere).length > 0) queryOpts.where = scopeWhere;
        rows = await Model.findAll(queryOpts) || [];
    } catch (e) {
        console.error(`[default.autoNumber] numbers query failed for "${request.table}.${field}":`, e.message);
        rows = [];
    }

    const taken = new Set();
    for (const r of rows) {
        const v = r[field];
        if (v !== null && v !== undefined && v !== '') taken.add(String(v));
    }

    // Номера ПЕРИОДА (если нумерация сбрасывается по году/месяцу) — от них берётся
    // продолжение; без периода это все номера области.
    const inPeriod = periodRange
        ? rows.filter(r => {
            const t = new Date(r.createdAt).getTime();
            return t >= periodRange.from.getTime() && t < periodRange.to.getTime();
        })
        : rows;

    // ОБРАЗЕЦ ФОРМАТА — номер последней созданной записи: его префикс и есть то,
    // как сейчас нумеруют («R00-», «Б-», без префикса). Продолжаем максимум среди
    // номеров с ТЕМ ЖЕ префиксом, сравнивая числом; ширину берём наибольшую в этой
    // группе (ведущие нули не теряются, при переполнении номер растёт).
    const TAIL = /^([\s\S]*?)(\d+)$/;
    let pattern = null;
    let latest = -Infinity;
    for (const r of inPeriod) {
        const v = r[field];
        if (v === null || v === undefined || v === '') continue;
        const t = new Date(r.createdAt).getTime() || 0;
        if (t >= latest) { latest = t; pattern = String(v); }
    }

    let nextValue;
    const m = pattern !== null ? pattern.match(TAIL) : null;
    if (m) {
        const pfx = m[1];
        let max = 0n;
        let width = m[2].length;
        for (const r of inPeriod) {
            const mm = String(r[field] == null ? '' : r[field]).match(TAIL);
            if (!mm || mm[1] !== pfx) continue;
            const n = BigInt(mm[2]);
            if (n > max) max = n;
            if (mm[2].length > width) width = mm[2].length;
        }
        nextValue = nextFree(pfx, max + 1n, width, taken);
    } else if (pattern !== null) {
        // Образец без цифр («ЙЦУК») — дописываем счётчик: «ЙЦУК1», «ЙЦУК2», …
        nextValue = nextFree(pattern, 1n, 1, taken);
    } else {
        // В области (периоде) номеров ещё нет — формат из параметров.
        nextValue = nextFree(prefix, 1n, length, taken);
    }

    request.data[field] = nextValue;
    console.log(`[default.autoNumber] ${request.table}.${field} = "${request.data[field]}"`
        + (scope.scoped ? ` (${scope.field}=${scope.value || '∅'})` : ''));
};

/**
 * Первый СВОБОДНЫЙ номер «префикс + число», начиная с `start`: занятый
 * пропускается, сколько бы их ни шло подряд. Ширина числа — не меньше `width`.
 */
function nextFree(pfx, start, width, taken) {
    let n = start;
    for (;;) {
        const s = String(n);
        const candidate = pfx + s.padStart(Math.max(width, s.length), '0');
        if (!taken.has(candidate)) return candidate;
        n += 1n;
    }
}
