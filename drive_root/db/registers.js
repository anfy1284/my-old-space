'use strict';

/**
 * registers — РЕГИСТР НАКОПЛЕНИЯ (ТЗ «Проведение документов», §7).
 *
 * Регистр — типовое место, куда документ кладёт свои ДВИЖЕНИЯ, и типовой способ
 * спросить у них остаток или оборот. До него «остаток по кассе» пришлось бы считать
 * своим SQL в каждом приложении, а «отменить всё, что документ сделал» — писать руками
 * рядом с проведением, где эта пара рано или поздно разошлась бы.
 *
 * ГЛАВНОЕ СВОЙСТВО: движение принадлежит РЕГИСТРАТОРУ — документу, который его создал
 * (`recorderTable` + `recorderUID`). Снимает движения ядро, одним `DELETE` по
 * регистратору, поэтому обработчика распроведения в приложении не существует как
 * понятия и разойтись с проведением ему негде.
 *
 * ОБЪЯВЛЕНИЕ — раздел `registers` в `db.json`, рядом с `models`:
 *
 *     "registers": [{
 *       "name": "CashRegister", "tableName": "reg_cash", "kind": "balances",
 *       "caption": { "i18n": "reg_cash_caption" },
 *       "dimensions": { "organizationId": {...}, "cashboxId": {...} },
 *       "resources":  { "amount": { "type": "DECIMAL(12,2)" } },
 *       "attributes": { "comment": { "type": "STRING" } }
 *     }]
 *
 * Три вида полей отличаются не типом, а ролью, и роль определяет поведение:
 *   - ИЗМЕРЕНИЕ — в разрезе чего ведётся учёт. По нему группируются остатки, по нему
 *     же каскад определяет, кого задела правка (§11.2);
 *   - РЕСУРС — что складывается. Деньги — `DECIMAL`, а значит приходят из драйвера
 *     СТРОКОЙ (`drive_root/db/money.js`);
 *   - РЕКВИЗИТ — сопроводительное, не участвует ни в группировке, ни в сложении.
 *
 * ЧТО ДОБАВЛЯЕТ ЯДРО (объявлять вручную запрещено — см. `CORE_FIELDS`): `UID`,
 * `period`/`seq` (момент времени РЕГИСТРАТОРА — по нему считается остаток «на момент»),
 * `recorderTable`/`recorderUID`, `lineNo`, `sign`.
 *
 * ТАБЛИЦА РЕГИСТРА — обычная таблица модели: её создаёт и мигрирует тот же механизм,
 * что все прочие, и RLS применяется к ней штатно. Поэтому регистр обязан нести
 * реквизит доступа — обычно `organizationId` измерением. В `excluded_tables` регистры
 * не добавлять: «виден всем» для учётных движений означает чужие деньги на экране.
 *
 * ПРЯМАЯ ЗАПИСЬ ЗАПРЕЩЕНА. Писать в регистр вправе только проведение, и это не
 * договорённость, а проверка: middleware `registerWriteGuard` в корневом `dbGateway`
 * отклоняет create/update/delete по таблице регистра без токена, который выдаётся
 * внутри механизма проведения и наружу не уезжает.
 */

const Sequelize = require('sequelize');
const { Op } = Sequelize;

// ── Поля, которые ядро добавляет каждому регистру ────────────────────────────

const CORE_FIELDS = ['UID', 'period', 'seq', 'recorderTable', 'recorderUID', 'lineNo', 'sign'];

/** Роли полей регистра. */
const ROLE = { DIMENSION: 'dimension', RESOURCE: 'resource', ATTRIBUTE: 'attribute' };

/**
 * Право записи в регистр — общий механизм ядра (`drive_root/db/coreWrite.js`):
 * случайный токен процесса, который не уезжает ни в HTTP, ни в клиент, ни в базу.
 * Свой второй токен здесь был бы вторым механизмом с той же целью.
 */
const coreWrite = require('./coreWrite');

/** Реестр объявленных регистров: tableName → конфигурация. */
const registry = new Map();

// ── Объявление → определение модели ──────────────────────────────────────────

function safeIdent(name) {
    return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name);
}

function assertNoCoreField(reg, section, names) {
    for (const n of names) {
        if (CORE_FIELDS.includes(n)) {
            throw new Error(`[registers] Регистр "${reg.tableName}": поле "${n}" в разделе`
                + ` "${section}" объявлять нельзя — его добавляет ядро.`);
        }
    }
}

/**
 * Построить определение модели по объявлению регистра.
 * Отдельная функция (а не «создать таблицу») намеренно: регистр обязан ехать по тому
 * же пути, что остальные таблицы, — миграция, сверка схемы, RLS, резервная копия.
 * Второго пути создания таблиц в системе быть не должно.
 *
 * @param {object} reg — объявление из `db.json`
 * @returns {object} определение модели
 */
function buildRegisterModelDef(reg) {
    if (!reg || !reg.tableName || !reg.name) {
        throw new Error('[registers] Объявление регистра требует "name" и "tableName"');
    }
    if (!safeIdent(reg.tableName)) {
        throw new Error(`[registers] Недопустимое имя таблицы регистра "${reg.tableName}"`);
    }

    const dimensions = reg.dimensions || {};
    const resources = reg.resources || {};
    const attributes = reg.attributes || {};
    assertNoCoreField(reg, 'dimensions', Object.keys(dimensions));
    assertNoCoreField(reg, 'resources', Object.keys(resources));
    assertNoCoreField(reg, 'attributes', Object.keys(attributes));
    if (!Object.keys(resources).length) {
        throw new Error(`[registers] Регистр "${reg.tableName}" без ресурсов — складывать нечего`);
    }

    const fields = {
        // Момент времени РЕГИСТРАТОРА, скопированный в движение. Копия, а не join:
        // остаток «на момент» — самый горячий запрос механизма, и join к пяти
        // документным таблицам ради двух чисел он не переживёт.
        period: {
            type: 'DATE', allowNull: true, service: true,
            caption: { i18n: 'register_period_field' }
        },
        seq: {
            type: 'BIGINT', allowNull: false, defaultValue: 0, service: true,
            caption: { i18n: 'register_seq_field' }
        },
        recorderTable: {
            type: 'STRING', allowNull: true, service: true,
            caption: { i18n: 'register_recorder_table_field' }
        },
        recorderUID: {
            type: 'STRING', allowNull: true, service: true,
            caption: { i18n: 'register_recorder_field' }
        },
        lineNo: {
            type: 'INTEGER', allowNull: false, defaultValue: 0, service: true,
            caption: { i18n: 'register_line_no_field' }
        },
        // +1 приход, −1 расход. Знак отдельным полем, а не минусом в ресурсе:
        // оборот «сколько пришло» и «сколько ушло» иначе не разделить, а он нужен
        // кассовой книге не меньше остатка.
        sign: {
            type: 'INTEGER', allowNull: false, defaultValue: 1, service: true,
            caption: { i18n: 'register_sign_field' }
        }
    };
    for (const [n, d] of Object.entries(dimensions)) fields[n] = Object.assign({}, d);
    for (const [n, d] of Object.entries(resources)) fields[n] = Object.assign({}, d);
    for (const [n, d] of Object.entries(attributes)) fields[n] = Object.assign({}, d);

    const dimNames = Object.keys(dimensions);
    const indexes = [
        // Снятие движений документа целиком — самый частый запрос записи.
        { fields: ['recorderTable', 'recorderUID'] },
        // Остатки и обороты: сначала разрез, потом момент.
        { fields: [...dimNames, 'period', 'seq'] }
    ];

    return {
        name: reg.name,
        tableName: reg.tableName,
        fields,
        options: { indexes },
        // Не сущность: ни номера, ни даты документа, ни автонумерации регистру не
        // полагается — у движения нет собственной жизни, оно принадлежит документу.
        entityConfig: null,
        registerConfig: {
            kind: reg.kind || 'balances',
            caption: reg.caption || null,
            dimensions: dimNames,
            resources: Object.keys(resources),
            attributes: Object.keys(attributes)
        }
    };
}

/**
 * Объявить регистр: положить в реестр и вернуть определение модели.
 * Идемпотентно — сбор определений моделей выполняется многократно.
 * @param {object} reg
 * @returns {object} определение модели
 */
function declare(reg) {
    const def = buildRegisterModelDef(reg);
    registry.set(def.tableName, Object.assign({ tableName: def.tableName, name: def.name }, def.registerConfig));
    return def;
}

/** Конфигурация регистра по имени таблицы (или `null`). */
function get(tableName) {
    return registry.get(tableName) || null;
}

/** Таблица — регистр? Нужно сторожу записи и механизму проведения. */
function isRegisterTable(tableName) {
    return registry.has(tableName);
}

/** Все объявленные регистры. */
function all() {
    return Array.from(registry.values());
}

// ── Сторож прямой записи ─────────────────────────────────────────────────────

/**
 * Право записи в регистр. Выдаётся механизмом проведения на время своей транзакции и
 * кладётся в `request.context.coreWrite`. Клиент такой контекст не собирает:
 * серверные RPC кладут в него только `sessionID`.
 * @returns {object} значение для `context.coreWrite`
 */
function writeGrant() {
    // Строка движения создаётся целиком, поэтому право — на всю строку.
    return coreWrite.grant(coreWrite.ALL);
}

/** Запрос имеет право писать в регистр? */
function mayWrite(request) {
    return coreWrite.allows(request, coreWrite.ALL);
}

// ── Чтение: остатки и обороты ────────────────────────────────────────────────

/**
 * Условие «движение не позже момента времени».
 *
 * Кортежем `(period, seq) <= (:d, :s)` — но выраженным средствами Sequelize, а не
 * литералом: `where` этого запроса ещё будет склеиваться с фильтрами RLS, и литерал
 * в такой склейке ведёт себя непредсказуемо.
 */
function momentCondition(moment) {
    if (!moment || !moment.date) return null;
    const d = moment.date;
    const s = moment.seq === undefined || moment.seq === null ? null : String(moment.seq);
    if (s === null) return { period: { [Op.lte]: d } };
    return {
        [Op.or]: [
            { period: { [Op.lt]: d } },
            { [Op.and]: [{ period: d }, { seq: { [Op.lte]: s } }] }
        ]
    };
}

/**
 * Транзакция вызывающего, если он в ней находится.
 *
 * Обязательна: проведение читает регистр ВНУТРИ своей транзакции (проверочный
 * документ каскада спрашивает остаток на свой момент), и запрос без транзакции
 * не увидел бы ещё не зафиксированных движений — то есть посчитал бы остаток по
 * старым данным и записал бы его как верный.
 */
function txOf(p) {
    return (p && p.context && p.context.transaction) || (p && p.transaction) || null;
}

function requireRegister(tableName) {
    const cfg = get(tableName);
    if (!cfg) throw new Error(`[registers] Регистр "${tableName}" не объявлен`);
    return cfg;
}

/** Ресурсы, о которых спрашивают: либо заказанные, либо все объявленные. */
function resolveResources(cfg, asked) {
    const list = Array.isArray(asked) && asked.length ? asked : cfg.resources;
    for (const r of list) {
        if (!cfg.resources.includes(r)) {
            throw new Error(`[registers] Регистр "${cfg.tableName}": ресурс "${r}" не объявлен`);
        }
    }
    return list;
}

/**
 * ОСТАТОК на момент времени.
 *
 * Считается как сумма движений со знаком до указанного момента включительно. Отдельной
 * таблицы итогов нет и пока не нужно: движений мало, а таблица итогов — это второй
 * источник правды, который обязан совпадать с первым.
 *
 * @param {object} p — `{ register, dimensions, moment: {date, seq}, resources, context }`
 * @returns {Promise<Array<object>>} строки `{ ...измерения, ...ресурсы }`; суммы —
 *   СТРОКИ (`DECIMAL` из драйвера), складывать их только через `money.js`
 */
async function balance(p) {
    const cfg = requireRegister(p && p.register);
    const resources = resolveResources(cfg, p.resources);
    const groupBy = Array.isArray(p.groupBy) ? p.groupBy : cfg.dimensions;
    for (const g of groupBy) {
        if (!cfg.dimensions.includes(g)) {
            throw new Error(`[registers] Регистр "${cfg.tableName}": измерение "${g}" не объявлено`);
        }
    }

    const where = {};
    for (const [k, v] of Object.entries(p.dimensions || {})) {
        if (!cfg.dimensions.includes(k)) {
            throw new Error(`[registers] Регистр "${cfg.tableName}": измерение "${k}" не объявлено`);
        }
        if (v !== undefined) where[k] = v;
    }
    const mc = momentCondition(p.moment);
    const finalWhere = mc ? { [Op.and]: [where, mc] } : where;

    const attributes = [
        ...groupBy,
        // «Остаток» — это сумма со знаком: sign * ресурс. Знак хранится отдельно
        // (см. поле `sign`), поэтому умножение здесь, а не в данных.
        ...resources.map(r => [
            Sequelize.fn('SUM', Sequelize.literal(`"sign" * "${r}"`)), r
        ])
    ];

    return await require('../dbGateway').execute({
        operation: 'read',
        table: cfg.tableName,
        where: finalWhere,
        options: Object.assign({ attributes, group: groupBy, raw: true },
            txOf(p) ? { transaction: txOf(p) } : {}),
        context: p.context || {}
    });
}

/**
 * ОБОРОТЫ за период: приход, расход и их разница по каждому ресурсу.
 *
 * Приход и расход разделены намеренно: кассовой книге (§ 146 AO) нужны именно они, а
 * не итог. Границы включительные с обеих сторон — период задаётся датами, а не
 * моментами: оборот «за май» не зависит от того, каким по счёту документом день начался.
 *
 * @param {object} p — `{ register, dimensions, from, to, resources, groupBy, context }`
 * @returns {Promise<Array<object>>} строки `{ ...группировка, <r>_income, <r>_expense, <r> }`
 */
async function turnovers(p) {
    const cfg = requireRegister(p && p.register);
    const resources = resolveResources(cfg, p.resources);
    const groupBy = Array.isArray(p.groupBy) ? p.groupBy : cfg.dimensions;

    const where = {};
    for (const [k, v] of Object.entries(p.dimensions || {})) {
        if (!cfg.dimensions.includes(k)) {
            throw new Error(`[registers] Регистр "${cfg.tableName}": измерение "${k}" не объявлено`);
        }
        if (v !== undefined) where[k] = v;
    }
    const period = {};
    if (p.from) period[Op.gte] = p.from;
    if (p.to) period[Op.lte] = p.to;
    if (Object.getOwnPropertySymbols(period).length) where.period = period;

    const attributes = [...groupBy];
    for (const r of resources) {
        attributes.push([Sequelize.fn('SUM', Sequelize.literal(`CASE WHEN "sign" > 0 THEN "${r}" ELSE 0 END`)), `${r}_income`]);
        attributes.push([Sequelize.fn('SUM', Sequelize.literal(`CASE WHEN "sign" < 0 THEN "${r}" ELSE 0 END`)), `${r}_expense`]);
        attributes.push([Sequelize.fn('SUM', Sequelize.literal(`"sign" * "${r}"`)), r]);
    }

    return await require('../dbGateway').execute({
        operation: 'read',
        table: cfg.tableName,
        where,
        options: Object.assign({ attributes, group: groupBy, raw: true },
            txOf(p) ? { transaction: txOf(p) } : {}),
        context: p.context || {}
    });
}

/**
 * ДВИЖЕНИЯ одного регистратора — как они лежат, без сложения.
 * Нужно кассовой книге (строка отчёта = движение) и приёмке (проверить, что
 * распроведение действительно всё сняло).
 */
async function movementsOf(p) {
    const cfg = requireRegister(p && p.register);
    return await require('../dbGateway').execute({
        operation: 'read',
        table: cfg.tableName,
        where: { recorderTable: p.recorderTable, recorderUID: p.recorderUID },
        options: Object.assign({ order: [['lineNo', 'ASC']], raw: true },
            txOf(p) ? { transaction: txOf(p) } : {}),
        context: p.context || {}
    });
}

module.exports = {
    CORE_FIELDS,
    ROLE,
    buildRegisterModelDef,
    declare,
    get,
    isRegisterTable,
    all,
    writeGrant,
    mayWrite,
    momentCondition,
    balance,
    turnovers,
    movementsOf
};
