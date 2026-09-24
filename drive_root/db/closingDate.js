'use strict';

/**
 * closingDate — ДАТА ЗАПРЕТА РЕДАКТИРОВАНИЯ (ТЗ «Проведение документов», §13).
 *
 * ДВЕ РАЗНЫЕ ЗАДАЧИ ОДНОЙ НАСТРОЙКОЙ — это надо различать, иначе механизм
 * настраивают не тем концом (уточнено владельцем 24.09.2026).
 *
 *   1. НАСТОЯЩЕЕ ЗАКРЫТИЕ ПЕРИОДА — то, ради чего существует GoBD-Festschreibung:
 *      по периоду отчитались перед налоговой, и с этого момента данные в нём не
 *      меняются. Делается ОСОЗНАННО и РУКАМИ: человек выставляет дату, потому что
 *      знает, что именно он закрывает. Автоматика сюда не лезет.
 *
 *   2. ЗАЩИТА ОТ СЛУЧАЙНОЙ ПРАВКИ СТАРОГО — то, что нужно прямо сейчас. Учёт
 *      пока ОПЕРАТИВНЫЙ, месяцы не закрываются, и смысл даты запрета скромнее:
 *      не дать случайно тронуть документ полугодичной давности. Для этого
 *      служит автосдвиг — скользящее окно постоянной длины (см. ниже,
 *      `computeClosingDate`). Он ВЫКЛЮЧАЕТСЯ ПОЛНОСТЬЮ и может не понадобиться
 *      вовсе.
 *
 * Пункт 1 сильнее пункта 2: автосдвиг умеет только отодвигать границу вперёд и
 * никогда не возвращает её назад — иначе закрытый и сданный период тихо открылся
 * бы обратно.
 *
 * ЧТО СРАВНИВАЕТСЯ: **дата документа**, а не дата правки. Запрет закрывает период
 * учёта, а не запрещает работать в понедельник. Граница ВКЛЮЧАЮЩАЯ и берётся по
 * концу суток: «запрет по 15 сентября» означает, что 15 сентября закрыто целиком.
 *
 * УРОВЕНЬ — ОРГАНИЗАЦИЯ (решение владельца), с готовностью перенести на пользователя.
 * Поэтому резолвер настройки здесь ОДИН (`configFor`), а не размазан по вызовам:
 * перенос уровня тогда — правка одной функции, а не поиск всех мест сравнения.
 *
 * ОБХОД — тот же, что у неизменности: администратор при системной настройке
 * `core.adminEditsClosedDocuments`. Второго исключения не заводить.
 *
 * КАСКАД ПЕРЕПРОВЕДЕНИЯ ЭТОТ ЗАПРЕТ НЕ СМОТРИТ (§11.4): если замок уже пробит
 * администратором, полусогласованный учёт хуже изменённого закрытого периода.
 * Каскад пишет движения не через этот путь, а внутри проведения, которому
 * право выдано токеном ядра, — поэтому отдельного исключения здесь не нужно.
 */

const SETTINGS_APP = 'core';
const KEYS = {
    closingDate: 'closingDate',
    closingAuto: 'closingAuto',
    closingOffsetDays: 'closingOffsetDays'
};

const emptyValues = require('./emptyValues');
const dates = require('./dates');

/** Ошибка отказа — того же вида, что у неизменности: клиент показывает текст как есть. */
class ClosedPeriodError extends Error {
    constructor(message, details) {
        super(message);
        this.name = 'ClosedPeriodError';
        this.code = 'CLOSED_PERIOD';
        this.details = details || {};
        this.userMessage = message;
    }
}

/**
 * Кэш настроек запрета, на несколько секунд.
 *
 * Проверка стоит middleware'ом на КАЖДОЙ записи документа, а настройка у
 * механизма настроек кэша нет намеренно. Без этого одно сохранение брони давало
 * бы шесть запросов к `settings_values` (три ключа × «сейчас» и «после правки»).
 * Секунды достаточно: дату запрета двигают раз в месяц, а не раз в минуту, и
 * задержка в несколько секунд после её изменения никого не задевает — документы
 * этой даты и так не менялись всё предыдущее время.
 */
const _cache = new Map();          // organizationId → { value, expires }
const CACHE_TTL_MS = 5000;

/** Сбросить кэш (правка настройки, подмена базы). */
function invalidate() {
    _cache.clear();
}

try {
    require('../dbLifecycle').onDatabaseReset('closingDate', invalidate);
} catch (e) { /* без подписки кэш протухнет сам за 5 секунд */ }

/**
 * Настройки запрета для организации. Одно место чтения — см. шапку.
 * @param {string} organizationId
 * @returns {Promise<{date: Date|null, auto: boolean, offsetDays: number}>}
 */
async function configFor(organizationId) {
    const settings = require('../settings');
    const out = { date: null, auto: false, offsetDays: 30 };
    if (!organizationId) return out;

    const hit = _cache.get(organizationId);
    if (hit && hit.expires > Date.now()) return hit.value;

    try {
        const raw = await settings.getRecordSetting('organization', organizationId, SETTINGS_APP, KEYS.closingDate);
        if (raw && !emptyValues.isEmptyDate(raw)) out.date = new Date(raw);
        out.auto = (await settings.getRecordSetting('organization', organizationId, SETTINGS_APP, KEYS.closingAuto)) === true;
        const off = await settings.getRecordSetting('organization', organizationId, SETTINGS_APP, KEYS.closingOffsetDays);
        const n = Number(off);
        if (isFinite(n) && n >= 0) out.offsetDays = n;
    } catch (e) {
        // Настройки недоступны — запрета нет. Молчать нельзя: иначе однажды
        // окажется, что период «не закрывался» весь год.
        console.error(`[closingDate] Настройки организации ${organizationId} не прочитаны: ${e.message}`);
    }
    _cache.set(organizationId, { value: out, expires: Date.now() + CACHE_TTL_MS });
    return out;
}

/**
 * Дата документа попадает в закрытый период этой организации?
 *
 * Сравнение — по КОНЦУ СУТОК даты запрета. Настройка объявлена `type: "date"`,
 * то есть приезжает полночью, и сравнение меток времени в лоб давало «дата
 * запрета 30.09, а документ от 30.09 09:15 не закрыт»: весь последний день
 * периода оставался редактируемым. Дата запрета названа ДАТОЙ — значит день,
 * который в ней указан, закрыт целиком (`drive_root/db/dates.js`).
 */
async function isClosed(organizationId, documentDate) {
    if (!documentDate || emptyValues.isEmptyDate(documentDate)) return false;
    const cfg = await configFor(organizationId);
    if (!cfg.date) return false;
    const boundary = dates.endOfDay(cfg.date);
    if (!boundary) return false;
    return new Date(documentDate).getTime() <= boundary.getTime();
}

/**
 * Проверка запроса. Ставится middleware'ом рядом с неизменностью.
 *
 * Проверяются `update` и `delete` документов. `create` НЕ проверяется здесь
 * намеренно: новый документ прошлым числом — обычная операция (счёт выставлен
 * задним числом в пределах открытого периода), а если его дата попадает в
 * закрытый период, это ловит та же проверка ниже — по данным самого запроса.
 *
 * @param {object} request — запрос `dbGateway`
 * @param {object} globalCtx
 * @param {Function} t — переводчик сессии
 */
async function check(request, globalCtx, t) {
    const { operation, table, where, data, options = {} } = request;
    if (operation !== 'update' && operation !== 'delete' && operation !== 'create') return;

    const modelName = globalCtx.getModelNameForTable(table);
    const Model = modelName ? globalCtx.modelsDB[modelName] : null;
    if (!Model) return;

    // Запрет — про ДОКУМЕНТЫ. Справочники и служебные таблицы периодом не
    // закрываются: закрывается учёт, а не вся база.
    const et = Model.entityConfig && Model.entityConfig.entityType;
    if (!et || String(et).toLowerCase() !== 'document') return;

    // Служебная запись ядра (состояние проведения, движения) замком периода не
    // закрыта — по той же причине, что и замком неизменности: это отметка
    // механизма о себе, а не учётные данные.
    const coreWrite = require('./coreWrite');
    if (operation === 'update' && data) {
        const touched = Object.keys(data).filter(k => k !== 'UID' && k !== 'updatedAt');
        if (touched.length && !coreWrite.notAllowed(request, touched).length) return;
    }

    const rowsToCheck = [];
    if (operation === 'create') {
        rowsToCheck.push({ organizationId: data && data.organizationId, date: data && data.date, UID: data && data.UID });
    } else {
        if (!where) return;
        const found = await Model.findAll({
            where, raw: true, attributes: ['UID', 'date', 'organizationId'].filter(f => Model.rawAttributes[f]),
            transaction: options.transaction
        });
        rowsToCheck.push(...found);
    }

    for (const row of rowsToCheck) {
        // Новая дата важнее старой: перенос документа В закрытый период — то же
        // изменение закрытого периода, что и правка документа, который уже там.
        const nextDate = (operation === 'update' && data && Object.prototype.hasOwnProperty.call(data, 'date'))
            ? data.date : row.date;
        const closedNow = await isClosed(row.organizationId, row.date);
        const closedNext = await isClosed(row.organizationId, nextDate);
        if (!closedNow && !closedNext) continue;

        const immutable = require('./immutable');
        if (await immutable.adminOverride(request.context && request.context.sessionID)) return;

        const cfg = await configFor(row.organizationId);
        const text = (t && await t('closing_period_refusal'))
            || 'Период закрыт: документы этой даты изменять нельзя.';
        throw new ClosedPeriodError(text, {
            table, UID: row.UID, closingDate: cfg.date, documentDate: closedNext ? nextDate : row.date
        });
    }
}

// ── Автосдвиг: СКОЛЬЗЯЩЕЕ ОКНО ПОСТОЯННОЙ ДЛИНЫ (пересмотрено 24.09.2026) ────
//
// Раньше здесь было «конец прошлого месяца + offsetDays», по образцу
// бухгалтерского закрытия месяца. Это оказалось неверно по двум причинам сразу.
//
// ПЕРВАЯ — арифметическая, и она ломала работу. При умолчании `offsetDays = 30`
// запуск в любой день октября давал дату запрета 30 ОКТЯБРЯ: запирался текущий,
// ещё идущий месяц целиком, а заодно и будущие даты. Документ, заведённый
// 5 октября, нельзя было исправить 6-го.
//
// ВТОРАЯ — смысловая, и она важнее (решение владельца 24.09.2026). Закрытие ПО
// КОНЕЦ МЕСЯЦА — приём бухгалтерии: период закрывают, когда по нему уже
// отчитались, и делают это осознанно, руками. У нас пока учёт ОПЕРАТИВНЫЙ,
// месяцы не закрываются, и эта дата решает другую задачу — уменьшить случайную
// правку старых данных. На такой задаче месячная граница даёт несправедливость,
// которая мешает работать:
//
//     27-е число — можно править всё до 1-го числа (почти месяц свободы);
//     1-е число  — вчерашний документ уже не поправить (ноль свободы).
//
// Поэтому окно ПОСТОЯННОЙ ДЛИНЫ, одинаковое в любой день: дата запрета всегда
// отстоит от сегодняшнего дня на `offsetDays`. Сегодня 15 октября при значении
// 30 — закрыто по 15 сентября включительно, 16 сентября ещё правится. Завтра
// граница сдвинется на день, и свобода останется той же самой.
//
// Настоящее закрытие периода — то, ради которого границу двигают руками перед
// сдачей отчётности, — никуда не девается: это та же настройка `closingDate`,
// выставленная вручную. Автосдвиг её НЕ ОТКАТЫВАЕТ (см. `advanceAll`), иначе
// закрытый и сданный период тихо открылся бы обратно.

/**
 * Дата запрета при автосдвиге: конец суток, отстоящих от сегодняшнего дня на
 * `offsetDays` назад.
 *
 * Конец суток, а не полночь: граница включающая, день в ней закрыт целиком
 * (см. `isClosed`). Сдвиг — по календарным суткам (`dates.addDays`), а не
 * вычитанием миллисекунд: при переходе на летнее время в сутках 23 или 25
 * часов, и арифметика в миллисекундах дважды в год промахивается на день.
 *
 * @param {number} offsetDays — длина окна свободной правки, в днях
 * @param {Date} [now] — «сегодня» (для проверки)
 * @returns {Date}
 */
function computeClosingDate(offsetDays, now) {
    const today = now ? new Date(now) : new Date();
    const n = Number(offsetDays);
    const back = isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
    return dates.endOfDay(dates.addDays(today, -back));
}

/**
 * Сдвинуть дату запрета всем организациям, у которых включён автосдвиг.
 * Вызывается типом задачи `core.advanceClosingDate`.
 * @returns {Promise<number>} сколько организаций сдвинуто
 */
async function advanceAll(sessionID) {
    const dbGateway = require('../dbGateway');
    const settings = require('../settings');

    const orgs = await dbGateway.execute({
        operation: 'read', table: 'organizations',
        options: { raw: true, attributes: ['UID'] },
        context: { sessionID }
    });

    let n = 0;
    for (const org of orgs || []) {
        const cfg = await configFor(org.UID);

        // ВЫКЛЮЧЕНО — не трогаем ничего. Механизм скользящего окна нужен не
        // всем: возможно, он не нужен вовсе, и выключенным он обязан быть
        // ПОЛНОСТЬЮ — не «двигает реже», а не двигает совсем. Дата, выставленная
        // руками, при этом продолжает действовать: выключен автосдвиг, а не
        // запрет.
        if (!cfg.auto) continue;

        const next = computeClosingDate(cfg.offsetDays);

        // ТОЛЬКО ВПЕРЁД. Скользящее окно само по себе назад не ходит, но дата
        // могла быть выставлена РУКАМИ и дальше — именно так закрывают период,
        // по которому отчитались перед налоговой. Сдвинуть её назад значило бы
        // тихо открыть сданный период, и обнаружилось бы это в худший момент:
        // когда данные уже разошлись с поданным отчётом. Поэтому автосдвиг
        // умеет только отодвигать границу вперёд и никогда не возвращает её.
        if (cfg.date && next.getTime() <= cfg.date.getTime()) continue;

        await settings.setRecordSetting('organization', org.UID, SETTINGS_APP, KEYS.closingDate, next);
        invalidate();
        n++;
    }
    return n;
}

module.exports = {
    SETTINGS_APP, KEYS,
    invalidate,
    ClosedPeriodError,
    configFor,
    isClosed,
    check,
    computeClosingDate,
    advanceAll
};
