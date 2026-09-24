'use strict';

/**
 * closingDate — ДАТА ЗАПРЕТА РЕДАКТИРОВАНИЯ (ТЗ «Проведение документов», §13).
 *
 * Это наша реализация GoBD-Festschreibung: после закрытия периода документы в нём
 * не меняются и не удаляются. Требование «не позже 30-го числа следующего месяца»
 * задаётся настройкой (`closingOffsetDays`), а не зашивается в код: срок — норма,
 * а норма меняется без нас.
 *
 * ЧТО СРАВНИВАЕТСЯ: **дата документа**, а не дата правки. Запрет закрывает период
 * учёта, а не запрещает работать в понедельник.
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

/** Дата документа попадает в закрытый период этой организации? */
async function isClosed(organizationId, documentDate) {
    if (!documentDate || emptyValues.isEmptyDate(documentDate)) return false;
    const cfg = await configFor(organizationId);
    if (!cfg.date) return false;
    return new Date(documentDate).getTime() <= cfg.date.getTime();
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

// ── Автосдвиг (§13.3) ────────────────────────────────────────────────────────

/** Конец прошлого месяца + offsetDays — та дата, на которую сдвигаем. */
function computeClosingDate(offsetDays, now) {
    const d = now ? new Date(now) : new Date();
    // Последний день ПРОШЛОГО месяца: нулевой день текущего.
    const endOfPrev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0, 0, 0, 0, 0));
    return new Date(endOfPrev.getTime() + Number(offsetDays || 0) * 24 * 60 * 60 * 1000);
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
        if (!cfg.auto) continue;
        const next = computeClosingDate(cfg.offsetDays);
        // Назад дату запрета не двигаем никогда: это открыло бы уже закрытый период.
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
