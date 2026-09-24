'use strict';

/**
 * entityMoment — МОМЕНТ ВРЕМЕНИ документа (ТЗ «Проведение документов», §4).
 *
 * Момент времени = пара `(date, seq)`, где `seq` — глобальный монотонно растущий
 * счётчик. Дата отвечает на вопрос «каким днём документ учтён», `seq` — «когда он
 * попал на эту дату». Пара нужна потому, что одной даты для упорядочивания не
 * хватает: у трёх документов одного дня дата совпадает, а порядок у них обязан
 * быть один и тот же для всех потребителей (очередь проведения, остаток регистра
 * «на момент», каскад перепроведения). Сравнение — кортежем, средствами СУБД:
 *
 *     WHERE ("date", "seq") > (:momentDate, :momentSeq)
 *
 * ДВА ПРАВИЛА ПРИСВОЕНИЯ, и оба следуют из смысла «когда документ попал на эту дату»:
 *   1. при СОЗДАНИИ — всегда;
 *   2. при ИЗМЕНЕНИИ — только если изменилась `date`.
 * Обычное сохранение `seq` не трогает: иначе исправление опечатки в комментарии
 * молча переставляло бы документ в конец дня, меняя порядок учёта задним числом.
 * Счётчик глобальный и всегда растущий, поэтому новое значение заведомо больше
 * всех существующих — документ автоматически становится ПОСЛЕДНИМ на своей дате,
 * и при вводе задним числом, и при переносе даты. Отдельного «посчитать, что уже
 * есть на этот день» не требуется.
 *
 * «Когда документ на самом деле завели» при этом не теряется — для этого есть
 * `createdAt` (Sequelize `timestamps`), и он не переписывается никогда.
 *
 * ГДЕ БЕРЁТСЯ ЗНАЧЕНИЕ. Последовательность PostgreSQL `document_moment_seq`
 * (`nextval` не блокирует и не откатывается вместе с транзакцией — именно это и
 * нужно: два параллельных сохранения не должны ждать друг друга и не должны
 * получить один номер). Для прочих диалектов есть запасной путь (MAX+1 по всем
 * документным таблицам) — медленнее, но смысл тот же.
 *
 * ИНЪЕКЦИЯ — в тех же двух точках, что `number`/`date`/`name`:
 *   1. Миграция: корневой `events_handler.js` → `onModelsPostCollect` (создаёт колонку);
 *   2. Рантайм:  `globalServerContext.collectAllModelDefs` (модель знает о поле + хук).
 * Обе функции идемпотентны — повторный вызов ничего не дублирует.
 *
 * ОБЪЯВЛЯТЬ `seq` ВРУЧНУЮ В `db.json` ЗАПРЕЩЕНО — как `UID`, `number`, `date`.
 */

const { isDocumentDef, injectEntityDate } = require('./entityDate');

/** Имя последовательности. Одна на всю базу: момент времени сквозной по всем документам. */
const SEQUENCE_NAME = 'document_moment_seq';

/** Имя реквизита момента и имя реквизита даты, с которым он образует пару. */
const FIELD = 'seq';
const DATE_FIELD = 'date';

/**
 * «Пустой» момент. Как и у прочих типов (см. `emptyValues.js`), у BIGINT своё пустое
 * значение — 0, а не NULL. Ноль означает «момент ещё не присвоен»: так выглядят
 * строки, доехавшие мимо шлюза (восстановление копии, сырые сидеры) и строки,
 * существовавшие до появления механизма. Их лечит `backfill` при старте.
 */
const EMPTY_SEQ = 0;

// ── Инъекция в определения моделей ───────────────────────────────────────────

function fieldNameOf(f) {
    return typeof f === 'string' ? f : (f && f.name) || '';
}

/** Индекс `(date, seq)` — это он и есть? */
function isMomentIndex(idx) {
    if (!idx || !Array.isArray(idx.fields) || idx.fields.length !== 2) return false;
    return fieldNameOf(idx.fields[0]) === DATE_FIELD && fieldNameOf(idx.fields[1]) === FIELD;
}

/**
 * Гарантирует у документа реквизит `seq`, хуки присвоения и индекс `(date, seq)`.
 * Не-документы (справочники, табличные части, технические таблицы) пропускаются:
 * момент времени — свойство документа, справочник во времени не упорядочивается.
 *
 * @param {object} def — определение модели (мутируется in-place)
 * @returns {boolean} true если это документ и инъекция применена
 */
function injectEntityMoment(def) {
    if (!isDocumentDef(def)) return false;
    if (!def.fields) def.fields = {};

    // 0. Момент — ПАРА `(date, seq)`, и вторая её половина обязана существовать:
    //    индекс ниже объявляется по обеим колонкам, и без даты СУБД откажет в его
    //    создании. Полагаться на то, что `injectEntityDate` вызовут раньше, нельзя —
    //    порядок вызовов в точке впрыска не является частью договора этого модуля.
    //    Вызов идемпотентен: уже объявленную дату он не трогает.
    injectEntityDate(def);

    // 1. Реквизит seq. В отличие от `number`/`date`, ручное объявление здесь не
    //    уважается, а ПЕРЕКРЫВАЕТСЯ: объявлять `seq` запрещено, и неверный тип
    //    ломает не запись, а ПОРЯДОК — молча и не сразу. Реквизит целиком
    //    принадлежит ядру, поэтому ядро его и задаёт.
    //    Предупреждаем только о настоящем расхождении: повторная инъекция (а она
    //    штатная — рантайм впрыскивает в слои, миграция ещё раз в их слитую копию)
    //    видит собственный результат и обязана молчать.
    const existing = def.fields[FIELD];
    if (existing && String(existing.type || '').toUpperCase() !== 'BIGINT') {
        console.warn(`[entityMoment] Таблица "${def.tableName || def.name}" объявляет реквизит`
            + ` "${FIELD}" типа ${existing.type} — это запрещено: момент времени присваивает`
            + ` ядро, объявление перекрыто BIGINT.`);
    }
    def.fields[FIELD] = {
        type: 'BIGINT',
        allowNull: false,
        // Умолчание — пустой момент, а не NULL. Без него перестройка таблицы
        // при миграции не смогла бы перенести существующие строки: колонка
        // NOT NULL, а в старой копии такого столбца нет и вставка бы падала.
        defaultValue: EMPTY_SEQ,
        // Реквизит механизма, а не пользователя: в автоформу и в автоколонку
        // не попадает (drive_root/db/serviceFields.js). Рукописный лейаут
        // вправе показать его намеренно.
        service: true,
        // Подпись своя, если автор модели её задал: показать момент в
        // отладочном лейауте — законный случай, и называться он может иначе.
        caption: (existing && existing.caption) || { i18n: 'document_seq_field' }
    };

    // 2. Хуки присвоения — на СОЗДАНИЕ и на ИЗМЕНЕНИЕ. Решение «трогать или нет»
    //    принимает сам обработчик (на изменении — только при смене даты): здесь
    //    объявлять два разных хука незачем, правило одно и живёт в одном месте.
    //    unshift — системные хуки раньше прикладных, как у number/date.
    const ec = def.entityConfig;
    ec.hooks = ec.hooks || {};
    for (const event of ['beforeCreate', 'beforeUpdate']) {
        if (!Array.isArray(ec.hooks[event])) ec.hooks[event] = [];
        const arr = ec.hooks[event];
        const has = arr.some(h =>
            h && h.handler === 'default.documentSeq' && h.params && h.params.field === FIELD
        );
        if (!has) arr.unshift({
            handler: 'default.documentSeq',
            params: { field: FIELD, dateField: DATE_FIELD }
        });
    }

    // 3. Индекс (date, seq). Без него выборка «следующий по моменту» и каскад
    //    перепроведения пойдут сканом таблицы.
    //    Дубли вычищаем: миграционное слияние (`mergeModelDefinitions`) СКЛЕИВАЕТ
    //    списки индексов разных слоёв, а два одноимённых индекса подряд — это
    //    отказ «отношение уже существует» на втором.
    def.options = def.options || {};
    const indexes = Array.isArray(def.options.indexes) ? def.options.indexes : [];
    def.options.indexes = indexes.filter(i => !isMomentIndex(i));
    def.options.indexes.push({ fields: [DATE_FIELD, FIELD] });

    return true;
}

/**
 * Применить `injectEntityMoment` ко всему массиву определений моделей.
 * @param {Array<object>} defs
 * @returns {number} сколько документов обработано
 */
function injectEntityMoments(defs) {
    if (!Array.isArray(defs)) return 0;
    let n = 0;
    for (const def of defs) {
        if (injectEntityMoment(def)) n++;
    }
    return n;
}

/**
 * Документные таблицы, у которых реквизит момента есть.
 * @param {Array<object>} defs — определения моделей
 * @returns {Array<string>} имена таблиц
 */
function documentTables(defs) {
    const seen = new Set();
    for (const def of defs || []) {
        if (!isDocumentDef(def)) continue;
        if (!def.fields || !def.fields[FIELD]) continue;
        if (def.tableName) seen.add(def.tableName);
    }
    return Array.from(seen);
}

/**
 * Документные таблицы по текущим определениям моделей процесса.
 * Отдельная функция, потому что потребителей два: запасной путь присвоения
 * (когда диалект не postgres) и постобработка старта.
 */
function documentTablesOfProcess() {
    try {
        const globalCtx = require('../globalServerContext');
        return documentTables(globalCtx.collectMergedModelDefs().models);
    } catch (e) {
        console.error('[entityMoment] Список документных таблиц недоступен:', e && e.message || e);
        return [];
    }
}

// ── Работа с базой ───────────────────────────────────────────────────────────

const Sequelize = require('sequelize');

function dialectOf(sequelize) {
    try { return sequelize.getDialect(); } catch (e) { return ''; }
}

/** Идентификатор схемы/таблицы безопасен? Имена приходят из наших же определений. */
function safeIdent(name) {
    return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name);
}

function quoted(schema, name) {
    if (!safeIdent(name)) throw new Error(`[entityMoment] Недопустимое имя "${name}"`);
    if (!schema) return `"${name}"`;
    if (!safeIdent(schema)) throw new Error(`[entityMoment] Недопустимое имя схемы "${schema}"`);
    return `"${schema}"."${name}"`;
}

/** Ссылка на последовательность в том виде, в каком её ждут nextval/setval. */
function sequenceRef(schema) {
    return quoted(schema, SEQUENCE_NAME);
}

/**
 * Создать последовательность, если её ещё нет.
 * Зовётся при каждом старте (`onDatabasePostInit`) и после восстановления копии:
 * теневая схема приезжает без неё, и без этого шага первый же документ упадёт.
 *
 * @param {object} sequelize
 * @param {object} [opts] — `{ schema }` для работы в теневой схеме
 * @returns {Promise<boolean>} создана/существует
 */
async function ensureSequence(sequelize, opts = {}) {
    if (dialectOf(sequelize) !== 'postgres') return false;
    const ref = sequenceRef(opts.schema);
    await sequelize.query(`CREATE SEQUENCE IF NOT EXISTS ${ref}`, opts.transaction ? { transaction: opts.transaction } : {});
    return true;
}

/**
 * Следующее значение момента.
 *
 * @param {object} sequelize
 * @param {object} [opts] — `{ schema }`
 * @returns {Promise<string>} значение BIGINT СТРОКОЙ — как его отдаёт драйвер и как
 *   его принимает Sequelize. Через Number такие значения не гонять: 2^53 далеко,
 *   но правило то же, что с деньгами, — не заводить второго представления числа.
 */
async function nextMoment(sequelize, opts = {}) {
    if (dialectOf(sequelize) === 'postgres') {
        const rows = await sequelize.query(
            `SELECT nextval('${sequenceRef(opts.schema)}') AS v`,
            { type: Sequelize.QueryTypes.SELECT }
        );
        return String(rows[0].v);
    }
    return await nextMomentFallback(sequelize);
}

/**
 * Запасной путь для диалектов без последовательностей (SQLite — режим разработки).
 * MAX+1 по ВСЕМ документным таблицам: счётчик обязан остаться сквозным, иначе
 * документы разных видов получат пересекающиеся моменты и порядок станет ничьим.
 */
async function nextMomentFallback(sequelize) {
    const tables = documentTablesOfProcess();
    let max = 0n;
    for (const t of tables) {
        try {
            const rows = await sequelize.query(
                `SELECT COALESCE(MAX("${FIELD}"), 0) AS m FROM ${quoted('', t)}`,
                { type: Sequelize.QueryTypes.SELECT }
            );
            const m = BigInt(String((rows[0] && rows[0].m) || 0));
            if (m > max) max = m;
        } catch (e) { /* таблицы может ещё не быть */ }
    }
    return String(max + 1n);
}

/** Есть ли у таблицы колонка? Нужно из-за `createdAt`: `timestamps` можно отключить. */
async function hasColumn(sequelize, schema, table, column) {
    try {
        const qi = sequelize.getQueryInterface();
        const desc = await qi.describeTable(schema ? { tableName: table, schema } : table);
        return !!(desc && desc[column]);
    } catch (e) {
        return false;
    }
}

/**
 * Присвоить момент строкам, у которых его нет (`seq = 0`).
 *
 * Кто эти строки: документы, созданные до появления механизма, и строки, приехавшие
 * мимо шлюза — восстановление копии пишет RAW (и правильно делает: пересчитывать
 * данные бизнес-правилами при восстановлении нельзя), сырые SQL-сидеры тоже.
 *
 * Порядок присвоения — по `(date, createdAt)` и СРАЗУ ПО ВСЕМ таблицам, а не по
 * одной: момент сквозной, и если раздавать его таблица за таблицей, все счета
 * окажутся раньше всех броней независимо от дат.
 *
 * @returns {Promise<number>} сколько строк получило момент
 */
async function backfill(sequelize, tables, opts = {}) {
    const schema = opts.schema || '';
    const pending = [];

    for (const table of tables || []) {
        const withCreatedAt = await hasColumn(sequelize, schema, table, 'createdAt');
        const cols = `"UID", "${DATE_FIELD}"` + (withCreatedAt ? ', "createdAt"' : '');
        let rows;
        try {
            rows = await sequelize.query(
                `SELECT ${cols} FROM ${quoted(schema, table)}`
                + ` WHERE "${FIELD}" IS NULL OR "${FIELD}" = ${EMPTY_SEQ}`,
                { type: Sequelize.QueryTypes.SELECT }
            );
        } catch (e) {
            console.warn(`[entityMoment] ${table}: строки без момента не прочитаны: ${e.message}`);
            continue;
        }
        for (const r of rows) {
            pending.push({
                table,
                uid: r.UID,
                date: r[DATE_FIELD] ? new Date(r[DATE_FIELD]).getTime() : 0,
                createdAt: r.createdAt ? new Date(r.createdAt).getTime() : 0
            });
        }
    }

    if (!pending.length) return 0;
    pending.sort((a, b) => (a.date - b.date) || (a.createdAt - b.createdAt));

    let n = 0;
    for (const p of pending) {
        try {
            const v = await nextMoment(sequelize, { schema });
            await sequelize.query(
                `UPDATE ${quoted(schema, p.table)} SET "${FIELD}" = :v WHERE "UID" = :uid`,
                { replacements: { v, uid: p.uid } }
            );
            n++;
        } catch (e) {
            console.warn(`[entityMoment] ${p.table}[${p.uid}]: момент не присвоен: ${e.message}`);
        }
    }
    return n;
}

/**
 * Поднять последовательность до максимума, уже лежащего в данных.
 *
 * Значение последовательности — ЧАСТЬ ДАННЫХ. Восстановление полной копии приносит
 * документы с моментами, а последовательность в восстановленной схеме начинается
 * с единицы: без этого шага новые документы получили бы `seq`, уже занятые
 * восстановленными, и порядок сломался бы молча — никакой ошибки, просто учёт
 * поехал. Понижать счётчик нельзя никогда, поэтому берём GREATEST с текущим.
 *
 * @returns {Promise<string>} значение, на котором стоит счётчик
 */
async function raiseSequenceToData(sequelize, tables, opts = {}) {
    if (dialectOf(sequelize) !== 'postgres') return '0';
    const schema = opts.schema || '';
    let max = 0n;
    for (const table of tables || []) {
        try {
            const rows = await sequelize.query(
                `SELECT COALESCE(MAX("${FIELD}"), 0) AS m FROM ${quoted(schema, table)}`,
                { type: Sequelize.QueryTypes.SELECT }
            );
            const m = BigInt(String((rows[0] && rows[0].m) || 0));
            if (m > max) max = m;
        } catch (e) {
            console.warn(`[entityMoment] ${table}: максимум момента не прочитан: ${e.message}`);
        }
    }
    const ref = sequenceRef(schema);
    const rows = await sequelize.query(
        `SELECT setval('${ref}', GREATEST(:max, (SELECT last_value FROM ${ref}))) AS v`,
        { replacements: { max: String(max) }, type: Sequelize.QueryTypes.SELECT }
    );
    return String(rows[0] && rows[0].v);
}

/**
 * Вся постобработка момента одним вызовом: последовательность есть, строки без
 * момента вылечены, счётчик поднят до данных.
 *
 * Два потребителя, одна реализация: `onDatabasePostInit` (каждый старт) и полное
 * восстановление копии (`backup/restoreFull.js`, теневая схема).
 *
 * @param {object} sequelize
 * @param {object} [opts] — `{ schema, tables }`; без `tables` берутся определения процесса
 */
async function prepare(sequelize, opts = {}) {
    const tables = opts.tables || documentTablesOfProcess();
    if (!tables.length) return { created: false, filled: 0, sequence: '0' };
    const created = await ensureSequence(sequelize, opts);
    // Счётчик поднимаем ДО раздачи: иначе backfill выдал бы уже занятые значения.
    let sequence = await raiseSequenceToData(sequelize, tables, opts);
    const filled = await backfill(sequelize, tables, opts);
    if (filled) sequence = await raiseSequenceToData(sequelize, tables, opts);
    return { created, filled, sequence, tables: tables.length };
}

module.exports = {
    SEQUENCE_NAME,
    FIELD,
    DATE_FIELD,
    EMPTY_SEQ,
    isDocumentDef,
    injectEntityMoment,
    injectEntityMoments,
    documentTables,
    documentTablesOfProcess,
    ensureSequence,
    nextMoment,
    backfill,
    raiseSequenceToData,
    prepare
};
