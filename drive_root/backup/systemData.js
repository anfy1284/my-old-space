'use strict';

/**
 * systemData — СИСТЕМНЫЕ ДАННЫЕ при полном восстановлении базы.
 *
 * ЗАДАЧА. Полное восстановление строит теневую схему из дампа и переключает схемы
 * целиком. Значит по умолчанию из копии приезжает ВСЁ, включая то, что описывает не
 * данные гостиницы, а саму инсталляцию: кто имеет доступ, какие регламентные задания
 * заведены, каким ключом шифруются копии. Развернуть годичную копию значило бы вернуть
 * отозванный доступ, воскресить удалённые задания и подменить действующий ключ —
 * причём молча, потому что операция считается успешной.
 *
 * Обратная крайность не лучше: просто не восстанавливать такие таблицы нельзя, потому
 * что теневая схема строится с нуля, и «не применить» означает «оставить пустыми» —
 * то есть остаться без пользователей вообще.
 *
 * РЕШЕНИЕ (владелец, 11.08.2026). Таблицы помечаются ТИПОМ системных данных
 * (`entityConfig.systemData` в `db.json`), типы перечислены в справочнике
 * `system_data_types`, а у каждого типа есть СТРАТЕГИЯ — зарегистрированный здесь
 * обработчик, который перед переключением приводит теневую схему в нужный вид,
 * заглядывая в ещё живую. Администратор в форме восстановления может по каждому типу
 * сказать «взять из копии как есть» — тогда стратегия не запускается.
 *
 * ПОЧЕМУ СТРАТЕГИЯ, А НЕ ФЛАГ «переносить/не переносить». Потому что типы ведут себя
 * по-разному, и разница содержательная, а не техническая. Настройки и задания — это
 * конфигурация ЭТОЙ машины, у них побеждает текущее целиком. Пользователи так не
 * умеют: восстановленные данные ссылаются на пользователей из копии, и если оставить
 * только текущих, ссылки повиснут; если оставить только тех, что в копии, — админ,
 * выполняющий восстановление, потеряет собственный вход. Поэтому у пользователей своя
 * стратегия — слияние. Один флаг на все типы означал бы, что однажды кто-то напишет
 * `if (table === 'users')` внутри кода восстановления, и разница станет неявной.
 *
 * ГДЕ ВЫПОЛНЯЕТСЯ. В `restoreFull.runPhases`, между заполнением теневой схемы и
 * атомарным переключением. Раньше нельзя — теневой схемы ещё нет; позже нельзя —
 * живой схемы уже нет, и заглядывать будет некуда.
 *
 * @module backup/systemData
 */

const log = require('../log');
const dialect = require('./dialect');

/** Схема, в которой живёт работающая база (из неё стратегии читают «текущее»). */
const LIVE_SCHEMA = 'public';

const _strategies = new Map();

/**
 * Есть ли таблица в схеме.
 *
 * Нужна потому, что метки типов читаются из ТЕКУЩИХ определений моделей, а теневая
 * схема построена по снимку из копии. Копия может быть старше таблицы: тогда метка
 * есть, а таблицы в теневой схеме нет, и перенос упал бы посреди операции — после
 * того, как часть типов уже применена. Пропустить с предупреждением честнее: сама
 * несовместимость структур проверяется отдельно и говорит об этом внятно.
 */
async function tableExists(sequelize, schema, table) {
    const rows = await sequelize.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = :schema AND table_name = :table`,
        { replacements: { schema, table }, type: sequelize.QueryTypes.SELECT }
    );
    return Array.isArray(rows) ? rows.length > 0 : !!rows;
}

/** Отфильтровать список таблиц по фактическому наличию в обеих схемах. */
async function presentIn(sequelize, shadow, live, tables) {
    const ok = [];
    for (const t of tables) {
        if (!(await tableExists(sequelize, shadow, t))) {
            log.warn(`[restore/systemData] ${t}: нет в теневой схеме (копия старше таблицы) — пропущена`);
            continue;
        }
        if (!(await tableExists(sequelize, live, t))) {
            log.warn(`[restore/systemData] ${t}: нет в живой схеме — переносить нечего, пропущена`);
            continue;
        }
        ok.push(t);
    }
    return ok;
}

/**
 * Зарегистрировать стратегию типа системных данных.
 *
 * Регистрация — в коде, привязка — по `code` строки справочника: справочник отвечает
 * на вопрос «какие типы бывают и как они называются пользователю», код — на вопрос
 * «что с ними делать». Разводить это по разным местам приходится потому, что первое
 * должно переводиться и показываться, а второе — исполняться.
 *
 * @param {string} code — код типа (`system_data_types.code`)
 * @param {Function} fn — async ({ sequelize, q, shadow, live, tables, report }) => void
 */
function registerStrategy(code, fn) {
    if (!code || typeof fn !== 'function') return;
    _strategies.set(String(code), fn);
}

/** Есть ли у типа собственная стратегия (иначе применяется `carryOver`). */
function hasStrategy(code) {
    return _strategies.has(String(code));
}

/**
 * Разобрать слитые определения моделей: какие таблицы к какому типу относятся.
 *
 * Признак читается из `entityConfig.systemData` — там же, где живёт остальная
 * декларация модели. Список таблиц по типу нигде не дублируется: добавить таблицу к
 * типу значит поставить ей метку, а не дописать её имя во второй список, который
 * однажды разойдётся с первым.
 *
 * @param {Array<Object>} models — слитые определения (`collectMergedModelDefs`)
 * @returns {Map<string, string[]>} код типа → имена таблиц
 */
function tablesByType(models) {
    const map = new Map();
    const seen = new Set();
    for (const m of (models || [])) {
        const table = m && m.tableName;
        if (!table || seen.has(table)) continue;
        seen.add(table);
        const code = m.entityConfig && m.entityConfig.systemData;
        if (!code) continue;
        if (!map.has(code)) map.set(code, []);
        map.get(code).push(table);
    }
    return map;
}

/**
 * Сколько строк затронул сырой запрос.
 *
 * Драйвер отвечает по-разному: у `UPDATE`/`DELETE` во втором элементе объект с
 * `rowCount`, у `INSERT` — просто число. Читать один способ нельзя — второй вид молча
 * даёт ноль, и этот ноль уходит в отчёт администратора как факт о его данных.
 */
function affected(meta) {
    if (typeof meta === 'number') return meta;
    return (meta && typeof meta.rowCount === 'number') ? meta.rowCount : 0;
}

/** Колонки таблицы в схеме, в порядке объявления. */
async function columnsOf(sequelize, schema, table) {
    const rows = await sequelize.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = :schema AND table_name = :table ORDER BY ordinal_position`,
        { replacements: { schema, table }, type: sequelize.QueryTypes.SELECT }
    );
    return (rows || [])
        .map(r => (Array.isArray(r) ? r[0] : (r.column_name !== undefined ? r.column_name : Object.values(r)[0])))
        .filter(Boolean);
}

/**
 * Общие колонки двух схем — ЕДИНСТВЕННЫЙ допустимый способ переносить строки между
 * живой схемой и схемой, построенной из копии.
 *
 * `INSERT … SELECT *` здесь недопустим, и это не вкусовщина. Снимок моделей в копии
 * хранит поля ОТСОРТИРОВАННЫМИ по имени (`serialize.modelFields`), поэтому схема из
 * копии всегда получает алфавитный порядок колонок, а живая база — исторический, в
 * котором добавленные позже поля стоят в конце. Наборы имён при этом совпадают, и
 * проверка структуры расхождения не видит. `SELECT *` сопоставляет колонки ПО ПОЗИЦИИ:
 * `backup_config.publicKeyPem` уезжал в `keyFingerprint varchar(255)` и валил
 * восстановление сообщением «значение не умещается». Там, где длины совпадают, отказа
 * не было бы вовсе — данные легли бы в чужие колонки молча.
 */
async function commonColumns(sequelize, shadow, live, table) {
    const liveCols = new Set(await columnsOf(sequelize, live, table));
    return (await columnsOf(sequelize, shadow, table)).filter(c => liveCols.has(c));
}

/**
 * Кто ссылается на таблицу ВНУТРИ схемы — по фактическим ограничениям, а не по списку в
 * коде. Список пришлось бы дописывать при каждой новой ссылке, и он молча разошёлся бы
 * с базой, а расхождение здесь стоит отказа посреди восстановления.
 *
 * @returns {Promise<Array<{table: string, column: string, parentColumn: string}>>}
 */
async function dependentsOf(sequelize, schema, parent) {
    const rows = await sequelize.query(
        `SELECT tc.table_name AS child, kcu.column_name AS col, ccu.column_name AS pcol
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = :schema AND ccu.table_schema = :schema
            AND ccu.table_name = :parent`,
        { replacements: { schema, parent }, type: sequelize.QueryTypes.SELECT }
    );
    return (rows || [])
        .map(r => (Array.isArray(r)
            ? { table: r[0], column: r[1], parentColumn: r[2] }
            : { table: r.child, column: r.col, parentColumn: r.pcol }))
        .filter(d => d.table && d.column && d.parentColumn && d.table !== parent);
}

/**
 * На что ссылается таблица — обратная сторона `dependentsOf`.
 * @returns {Promise<Array<{column: string, parentTable: string, parentColumn: string}>>}
 */
async function foreignKeysOf(sequelize, schema, table) {
    const rows = await sequelize.query(
        `SELECT kcu.column_name AS col, ccu.table_name AS parent, ccu.column_name AS pcol
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = :schema AND ccu.table_schema = :schema
            AND tc.table_name = :table`,
        { replacements: { schema, table }, type: sequelize.QueryTypes.SELECT }
    );
    return (rows || [])
        .map(r => (Array.isArray(r)
            ? { column: r[0], parentTable: r[1], parentColumn: r[2] }
            : { column: r.col, parentTable: r.parent, parentColumn: r.pcol }))
        .filter(f => f.column && f.parentTable && f.parentColumn);
}

/**
 * Привести таблицу к содержимому живой схемы, НЕ ПОРВАВ ссылки на неё.
 *
 * Очевидное «`DELETE` всё, затем `INSERT` живое» неисполнимо, как только на таблицу
 * кто-то ссылается без каскада: на `access_roles` смотрит `user_systems.roleId`, и
 * первый же `DELETE` упирается в внешний ключ. Снять ключи нельзя — они к этому моменту
 * навешены, ими и проверено загруженное. Поэтому замена идёт как замена:
 *   1. строки, которых в живой схеме нет, исчезнут — сначала убираем ссылки на них;
 *   2. затем сами исчезнувшие строки;
 *   3. остальные обновляем/добавляем `ON CONFLICT` — ссылки на них не рвутся ни на миг.
 */
async function replaceReferenced({ sequelize, q, shadow, live, table, report }) {
    const dst = dialect.qualify(q, table, shadow);
    const src = dialect.qualify(q, table, live);
    const uid = q('UID');
    // На разрушающем пути теневой схемы нет (`shadow === null`) — работаем прямо в живой.
    // Для ИМЕНИ в SQL это правильный null (имя без схемы уходит по `search_path`), а вот
    // интроспекции нужно настоящее имя: запрос с `table_schema = null` вернёт пусто, и
    // перенос молча выродится в «нет общих колонок», то есть в потерю системных данных
    // ровно на том пути, где страховки уже нет.
    const shadowSchema = shadow || LIVE_SCHEMA;

    let orphans = 0;
    for (const dep of await dependentsOf(sequelize, shadowSchema, table)) {
        const [, res] = await sequelize.query(
            `DELETE FROM ${dialect.qualify(q, dep.table, shadow)} d
              WHERE d.${q(dep.column)} IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM ${src} s WHERE s.${q(dep.parentColumn)} = d.${q(dep.column)})`
        );
        const n = affected(res);
        if (!n) continue;
        orphans += n;
        // Молчать нельзя: это удаление ДАННЫХ КОПИИ. Строка ссылалась на то, чего в
        // этой сборке больше нет; сохранить её невозможно, но знать о ней администратор
        // обязан.
        log.warn(`[restore/systemData] ${dep.table}.${dep.column}: удалено ${n} ссылок на `
            + `отсутствующие строки ${table}`);
        report && report(`${dep.table}: удалено ${n} ссылок на исчезнувшие ${table}`);
    }

    await sequelize.query(`DELETE FROM ${dst} WHERE ${uid} NOT IN (SELECT ${uid} FROM ${src})`);

    const cols = await commonColumns(sequelize, shadowSchema, live, table);
    if (!cols.length) {
        log.warn(`[restore/systemData] ${table}: нет общих колонок со схемой ${live} — пропущена`);
        return { orphans, moved: 0 };
    }
    const colList = cols.map(q).join(', ');
    const setList = cols.filter(c => c !== 'UID').map(c => `${q(c)} = EXCLUDED.${q(c)}`).join(', ');
    const [, ins] = await sequelize.query(
        `INSERT INTO ${dst} (${colList}) SELECT ${colList} FROM ${src}`
        + (setList ? ` ON CONFLICT (${uid}) DO UPDATE SET ${setList}` : ` ON CONFLICT (${uid}) DO NOTHING`)
    );
    const moved = affected(ins);

    report && report(`${table}: приведён к текущей базе (${moved})`
        + (orphans ? `, удалено висячих ссылок: ${orphans}` : ''));
    return { orphans, moved };
}

/**
 * Стратегия по умолчанию: содержимое живой схемы вытесняет содержимое теневой.
 *
 * Для конфигурации инсталляции это ровно то, что нужно: копия описывает, как машина
 * была настроена год назад, а нас интересует, как она настроена сейчас. Строки из
 * копии не «сливаются» — они отбрасываются целиком, потому что частичное совпадение
 * конфигураций смысла не имеет: половина старого расписания и половина нового — это
 * не расписание.
 *
 * Выполняется через `replaceReferenced`, а не «`DELETE` + `INSERT SELECT *`»: колонки
 * сопоставляются ПО ИМЕНИ (порядок в двух схемах разный, см. `commonColumns`), а
 * ссылающиеся строки переживают замену.
 */
async function carryOver({ sequelize, q, shadow, live, tables, report }) {
    for (const table of tables) {
        await replaceReferenced({ sequelize, q, shadow, live, table, report });
    }
    log.info(`[restore/systemData] Перенесено из живой схемы: ${tables.join(', ')}`);
}

/**
 * Применить стратегии ко всем типам системных данных.
 *
 * @param {Object} opts
 * @param {Object} opts.sequelize
 * @param {string} opts.shadow — имя теневой схемы
 * @param {Array<Object>} opts.models — слитые определения моделей
 * @param {Object} opts.restoreFromCopy — { [code]: true } — типы, которые администратор
 *        распорядился взять из копии как есть; для них стратегия НЕ запускается
 * @param {string} [opts.live] — схема, из которой читается «текущее». По умолчанию живая;
 *        на разрушающем пути живой схемы к этому моменту уже нет, и подставляется
 *        схема-снимок, снятая до удаления таблиц
 * @param {Function} [opts.report]
 * @returns {Promise<{applied: string[], fromCopy: string[]}>}
 */
async function applyAll(opts) {
    const { sequelize, shadow, models } = opts;
    const live = opts.live || LIVE_SCHEMA;
    const restoreFromCopy = opts.restoreFromCopy || {};
    const report = opts.report || (() => {});
    const q = dialect.quoter(sequelize);
    const byType = tablesByType(models);

    const applied = [];
    const fromCopy = [];

    for (const [code, tables] of byType) {
        if (restoreFromCopy[code]) {
            // Осознанный выбор администратора: воспроизвести состояние на дату целиком,
            // включая то, у кого был доступ. Ничего не делаем — в теневой схеме уже
            // лежит содержимое копии.
            fromCopy.push(code);
            report(`${code}: взято из копии по указанию администратора`);
            log.warn(`[restore/systemData] Тип «${code}» восстановлен ИЗ КОПИИ по явному указанию`);
            continue;
        }
        const present = await presentIn(sequelize, shadow || LIVE_SCHEMA, live, tables);
        if (!present.length) {
            report(`${code}: нет ни одной применимой таблицы — пропущен`);
            continue;
        }
        // Какая стратегия выбрана — в отчёт, а не только в код. Подмена собственной
        // стратегии умолчанием (реестр не собран в этом процессе) иначе видна лишь как
        // падение по внешнему ключу где-то в чужой таблице, и разбираться приходится с
        // симптомом. Строка в журнале операции называет причину сразу.
        const fn = _strategies.get(code);
        report(`${code}: стратегия — ${fn ? 'собственная' : 'умолчание (текущее целиком)'}`);
        await (fn || carryOver)({ sequelize, q, shadow, live, tables: present, report });
        applied.push(code);
    }

    return { applied, fromCopy };
}

/**
 * Снять СНИМОК системных таблиц в отдельную схему — для разрушающего пути.
 *
 * Разрушающий путь удаляет таблицы живой схемы и строит их заново из копии. К моменту,
 * когда стратегиям пора работать, читать «текущее» уже неоткуда: оно удалено. Поэтому
 * снимок снимается ДО удаления.
 *
 * `CREATE TABLE … AS SELECT` копирует только данные, без ограничений и индексов, — и
 * это ровно то, что нужно: из снимка мы только читаем.
 *
 * @returns {Promise<string|null>} имя схемы-снимка либо null, если снять не удалось
 */
async function snapshotForDestructive(sequelize, models) {
    if (dialect.nameOf(sequelize) !== 'postgres') {
        // Молча продолжать нельзя: без снимка настройки инсталляции приедут из копии,
        // и администратор должен узнать об этом сейчас, а не через месяц.
        log.error('[restore/systemData] Диалект не поддерживает схемы: на разрушающем пути '
            + 'системные данные будут восстановлены ИЗ КОПИИ (текущие сохранить негде)');
        return null;
    }
    const q = dialect.quoter(sequelize);
    const name = `mos_sysdata_snapshot_${Date.now()}`;
    const byType = tablesByType(models);

    await sequelize.query(`DROP SCHEMA IF EXISTS ${q(name)} CASCADE`);
    await sequelize.query(`CREATE SCHEMA ${q(name)}`);

    let copied = 0;
    for (const [, tables] of byType) {
        for (const table of tables) {
            try {
                await sequelize.query(
                    `CREATE TABLE ${q(name)}.${q(table)} AS SELECT * FROM ${dialect.qualify(q, table, LIVE_SCHEMA)}`
                );
                copied++;
            } catch (e) {
                log.warn(`[restore/systemData] ${table}: снимок не снят (${e.message})`);
            }
        }
    }
    log.info(`[restore/systemData] Снимок системных данных в ${name}: таблиц ${copied}`);
    return name;
}

/** Убрать схему-снимок. Ошибку глотаем: мусорная схема не повод рушить операцию. */
async function dropSnapshot(sequelize, name) {
    if (!name) return;
    try { await dialect.dropSchema(sequelize, name); }
    catch (e) { log.warn(`[restore/systemData] Схема-снимок ${name} не удалена: ${e.message}`); }
}

module.exports = {
    registerStrategy, hasStrategy, tablesByType, applyAll, carryOver,
    snapshotForDestructive, dropSnapshot, LIVE_SCHEMA,
    // Общие примитивы переноса между схемами. Живут здесь, а не в конкретной стратегии:
    // сопоставлять колонки по имени обязан КАЖДЫЙ, кто переносит строки между живой
    // схемой и построенной из копии.
    affected, columnsOf, commonColumns, dependentsOf, foreignKeysOf, replaceReferenced
};
