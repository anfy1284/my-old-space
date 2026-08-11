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
 * Стратегия по умолчанию: содержимое живой схемы вытесняет содержимое теневой.
 *
 * Для конфигурации инсталляции это ровно то, что нужно: копия описывает, как машина
 * была настроена год назад, а нас интересует, как она настроена сейчас. Строки из
 * копии не «сливаются» — они отбрасываются целиком, потому что частичное совпадение
 * конфигураций смысла не имеет: половина старого расписания и половина нового — это
 * не расписание.
 */
async function carryOver({ sequelize, q, shadow, live, tables, report }) {
    for (const table of tables) {
        const src = dialect.qualify(q, table, live);
        const dst = dialect.qualify(q, table, shadow);
        await sequelize.query(`DELETE FROM ${dst}`);
        // Явного списка колонок нет намеренно: структура теневой схемы построена по
        // тем же слитым определениям, что и живая, поэтому набор колонок совпадает.
        // Расхождение здесь означало бы, что копия несовместима по структуре, а это
        // проверяется раньше (`compareStructure`) и отдельным сообщением.
        await sequelize.query(`INSERT INTO ${dst} SELECT * FROM ${src}`);
        report && report(`${table}: перенесено из текущей базы`);
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
        const fn = _strategies.get(code) || carryOver;
        await fn({ sequelize, q, shadow, live, tables: present, report });
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
    snapshotForDestructive, dropSnapshot, LIVE_SCHEMA
};
