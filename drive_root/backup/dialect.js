'use strict';

/**
 * dialect — адаптер СУБД для резервного копирования (ТЗ §6.3).
 *
 * Единственное место, где различия диалектов вообще присутствуют. Это осознанная цена
 * переносимости: мы не зовём `pg_dump`/`expdp`/`bcp`, потому что ERP обязана делать
 * бэкап из коробки на любой поддерживаемой СУБД, а не тащить зоопарк клиентских
 * бинарников и следить за совпадением их версий с сервером.
 *
 * На этапе 2.1 нужны: снимок-транзакция, проверка что снимок не блокирует запись,
 * интроспекция списка таблиц, постраничное чтение и оценка размеров.
 */

const fs = require('fs');
const path = require('path');
const log = require('../log');

/** @returns {'postgres'|'sqlite'|string} */
function nameOf(sequelize) {
    return String(sequelize.getDialect ? sequelize.getDialect() : (sequelize.options && sequelize.options.dialect) || '');
}

/**
 * Первое значение первой строки результата.
 *
 * Форма строки у сырого запроса НЕ гарантирована: обычные таблицы приходят объектами,
 * а, например, `information_schema` — массивами значений. Код, полагающийся на одну из
 * форм, ломается молча (см. историю `listTables`), поэтому извлечение — через это
 * место, а не через `rows[0].имя_колонки` в каждом вызове.
 */
function scalarOf(rows) {
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (row === null || row === undefined) return undefined;
    if (Array.isArray(row)) return row[0];
    if (typeof row === 'object') { const v = Object.values(row); return v.length ? v[0] : undefined; }
    return row;
}

/** Цитирование идентификатора средствами самого драйвера — свои кавычки не изобретаем. */
function quoter(sequelize) {
    const qq = sequelize.getQueryInterface().quoteIdentifier
        ? (s) => sequelize.getQueryInterface().quoteIdentifier(s)
        : (s) => `"${String(s).replace(/"/g, '""')}"`;
    return qq;
}

/**
 * Имя таблицы, при необходимости квалифицированное схемой.
 *
 * Нужно потому, что при полном восстановлении данные пишутся в ТЕНЕВУЮ схему, а
 * подключение по-прежнему смотрит в живую: неквалифицированное имя ушло бы по
 * `search_path` в `public`, то есть восстановление писало бы прямо в живую базу —
 * ровно то, чего вся конструкция и избегает.
 */
function qualify(q, table, schema) {
    return schema ? `${q(schema)}.${q(table)}` : q(table);
}

/**
 * Убедиться, что снимок не заблокирует пользователей (ТЗ §3.2а).
 *
 * Требование «бэкап не мешает работе» выполнимо не само собой: в SQLite с журналом
 * отката открытая read-транзакция блокирует запись на всё время выгрузки. Молча
 * остановить работу гостиницы на десять минут недопустимо, поэтому это предусловие,
 * а не рекомендация.
 *
 * @returns {Promise<{ok: boolean, errorKey?: string, vars?: Object, note?: string}>}
 */
async function checkNonBlocking(sequelize) {
    const d = nameOf(sequelize);
    if (d === 'postgres') {
        // MVCC: читатели не блокируют писателей и наоборот. Проверять нечего.
        return { ok: true, note: 'mvcc' };
    }
    if (d === 'sqlite') {
        const [rows] = await sequelize.query('PRAGMA journal_mode;');
        const mode = String(scalarOf(rows) || '').toLowerCase();
        if (mode !== 'wal') {
            return { ok: false, errorKey: 'backup_err_sqlite_needs_wal', vars: { mode: mode || 'unknown' } };
        }
        return { ok: true, note: 'wal' };
    }
    // Незнакомый диалект: не утверждаем, что всё хорошо, но и не блокируем работу.
    log.warn(`[backup] Диалект "${d}" не проверен на блокировки при снимке`);
    return { ok: true, note: 'unverified' };
}

/**
 * Открыть транзакцию-снимок для согласованного чтения (ТЗ §3.2).
 *
 * Без неё наивный обход «по таблице за раз» читает их в разные моменты, и бэкап живой
 * базы получается битым: бронь уже уехала, а строки счёта, созданные секундой позже,
 * ссылаются на то, чего в дампе нет. Выясняется это при восстановлении.
 */
async function beginSnapshot(sequelize) {
    const d = nameOf(sequelize);
    const { Transaction } = require('sequelize');

    if (d === 'postgres') {
        const t = await sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ });
        // READ ONLY — не оптимизация, а защита: выгрузка физически не сможет ничего
        // записать, даже если в неё однажды заедет посторонний запрос.
        await sequelize.query('SET TRANSACTION READ ONLY', { transaction: t });
        return t;
    }
    if (d === 'sqlite') {
        // В WAL открытая read-транзакция даёт тот же эффект снимка и не мешает писателю.
        return await sequelize.transaction();
    }
    return await sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ });
}

/**
 * Фактический список таблиц в БД (интроспекция).
 *
 * Нужен для страховки из §0: сравнить с моделями и ГРОМКО сообщить о неизвестных
 * объектах. Логическая выгрузка не видит того, чего нет в моделях, и тихий риск
 * должен стать заметным.
 * @returns {Promise<Array<string>>}
 */
async function listTables(sequelize, transaction) {
    // Портативный путь ORM вместо собственного SQL под каждый диалект. Своя версия
    // была написана и оказалась неверной: на запрос к `information_schema` драйвер
    // отдаёт строки МАССИВАМИ значений, а не объектами (для обычных таблиц —
    // объектами), и `rows.map(r => r.table_name)` молча давал `[undefined]`. Наружу
    // это выглядело как «в базе одна неизвестная таблица», то есть страховка §0 не
    // работала вовсе. Форму ответа сырого запроса угадывать нельзя — для интроспекции
    // есть queryInterface, он и нормализует результат.
    const all = await sequelize.getQueryInterface().showAllTables({ transaction });
    return (all || [])
        .map(t => (typeof t === 'string' ? t : (t && (t.tableName || t.table_name))))
        .filter(Boolean);
}

/** Размер базы в байтах — для оценки места до начала выгрузки (§3.0). */
async function databaseSize(sequelize) {
    const d = nameOf(sequelize);
    try {
        if (d === 'postgres') {
            const [rows] = await sequelize.query('SELECT pg_database_size(current_database()) AS size');
            return Number(scalarOf(rows)) || 0;
        }
        if (d === 'sqlite') {
            const [rows] = await sequelize.query('SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()');
            return Number(scalarOf(rows)) || 0;
        }
    } catch (e) {
        log.warn(`[backup] Размер базы не определён: ${e.message}`);
    }
    return 0;
}

/**
 * Свободное место в каталоге хранения.
 * @returns {number} байт, либо 0 если определить не удалось
 */
function freeSpace(dirPath) {
    if (typeof fs.statfsSync !== 'function') return 0;
    // Каталог хранения может ещё не существовать (первый показ формы до первой
    // выгрузки) — тогда `statfs` падает с ENOENT. Свободное место при этом
    // прекрасно определяется по ЛЮБОМУ существующему родителю: том тот же.
    let dir = path.resolve(String(dirPath || '.'));
    for (let i = 0; i < 32; i++) {
        try {
            const st = fs.statfsSync(dir);
            return Number(st.bavail) * Number(st.bsize);
        } catch (e) {
            const parent = path.dirname(dir);
            if (!parent || parent === dir) {
                log.warn(`[backup] Свободное место не определено: ${e.message}`);
                return 0;
            }
            dir = parent;
        }
    }
    return 0;
}

/**
 * Постраничное чтение таблицы по ключу (ТЗ §3.3).
 *
 * Именно по ключу, а не `OFFSET`: `OFFSET` на больших таблицах заставляет СУБД
 * пересчитывать пропущенные строки на каждой странице. Внутри снимка порядок по `UID`
 * стабилен, поэтому «после последнего прочитанного» — надёжный курсор.
 *
 * @returns {Promise<Array<Object>>} строки как есть (raw)
 */
async function readPage(sequelize, { table, where, params, afterUID, limit, transaction }) {
    const q = quoter(sequelize);
    const conds = [];
    const bind = Object.assign({}, params || {});
    if (where) conds.push(`(${where})`);
    if (afterUID !== null && afterUID !== undefined) {
        conds.push(`${q('UID')} > :afterUID`);
        bind.afterUID = afterUID;
    }
    const sql = `SELECT * FROM ${q(table)}`
        + (conds.length ? ` WHERE ${conds.join(' AND ')}` : '')
        + ` ORDER BY ${q('UID')} ASC LIMIT ${Number(limit) || 1000}`;

    // raw + replacements: без ORM-модели, а значит без translationMiddleware,
    // FK-резолва и хуков (§3.4). Дамп обязан нести базовые значения.
    const [rows] = await sequelize.query(sql, { replacements: bind, transaction, raw: true });
    return rows;
}

/** Количество строк таблицы с учётом отбора — для dry-run и отчётов. */
async function countRows(sequelize, { table, where, params, transaction, schema }) {
    const q = quoter(sequelize);
    const sql = `SELECT COUNT(*) AS n FROM ${qualify(q, table, schema)}` + (where ? ` WHERE ${where}` : '');
    const [rows] = await sequelize.query(sql, { replacements: params || {}, transaction, raw: true });
    return Number(scalarOf(rows)) || 0;
}

// ── Запись: транзакция, отключение проверок ссылок, батч-вставка ──────────────────

/**
 * Можно ли на этой инсталляции временно отключить проверку внешних ключей.
 *
 * Выясняется ЗАРАНЕЕ, а не в момент отказа посреди восстановления. В PostgreSQL
 * `session_replication_role` доступен только суперпользователю (а на управляемых
 * хостингах вроде Supabase его не дают), в SQLite `PRAGMA foreign_keys` не действует
 * внутри транзакции. Поэтому отключение ссылок — УДОБСТВО, а не основа механизма:
 * порядок записи всё равно строится топологически (`topoOrder`), и без отключения
 * восстановление работает — кроме структур с циклом ссылок.
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function canDisableForeignKeys(sequelize) {
    const d = nameOf(sequelize);
    try {
        if (d === 'postgres') {
            const [rows] = await sequelize.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
            const v = scalarOf(rows);
            return (v === true || v === 't' || v === 1)
                ? { ok: true }
                : { ok: false, reason: 'not_superuser' };
        }
        if (d === 'sqlite') {
            // PRAGMA внутри транзакции — no-op, а восстановление идёт транзакцией.
            return { ok: false, reason: 'sqlite_pragma_in_transaction' };
        }
    } catch (e) {
        return { ok: false, reason: e.message };
    }
    return { ok: false, reason: 'unsupported_dialect' };
}

/**
 * Включить/выключить проверку внешних ключей.
 * Молча ничего не делает там, где это недоступно — вызывающий обязан заранее
 * спросить `canDisableForeignKeys` и, если нельзя, полагаться на порядок записи.
 *
 * Для SQLite это `PRAGMA foreign_keys`, и она действует ТОЛЬКО ВНЕ транзакции —
 * поэтому `transaction` здесь не передаётся, а вызывающий обязан звать её до начала
 * записи. Полное восстановление именно так и устроено: оно грузит данные потоком, без
 * одной большой транзакции.
 */
async function setForeignKeysEnabled(sequelize, enabled, transaction) {
    const d = nameOf(sequelize);
    if (d === 'postgres') {
        const mode = enabled ? 'origin' : 'replica';
        await sequelize.query(`SET session_replication_role = ${mode}`, { transaction });
        return true;
    }
    if (d === 'sqlite') {
        if (transaction) return false;              // внутри транзакции PRAGMA — пустышка
        await sequelize.query(`PRAGMA foreign_keys = ${enabled ? 'ON' : 'OFF'}`);
        return true;
    }
    return false;
}

/**
 * Умеет ли диалект навесить внешние ключи ПОСЛЕ загрузки данных.
 *
 * От ответа зависит вся стратегия ссылочной целостности при полном восстановлении:
 *
 *   умеет (PostgreSQL)   — таблицы создаются БЕЗ ключей, данные грузятся потоком в том
 *                          порядке, в каком лежат в файле, ключи навешиваются в конце
 *                          и тем самым ПРОВЕРЯЮТ загруженное;
 *   не умеет (SQLite)    — `ALTER TABLE ... ADD CONSTRAINT` там не существует вовсе.
 *                          Тогда таблицы создаются СРАЗУ с ключами, проверки на время
 *                          загрузки отключаются (`PRAGMA foreign_keys = OFF` вне
 *                          транзакции), а в конце гоняется `PRAGMA foreign_key_check`.
 *
 * Результат в обоих случаях один: данные ложатся потоком, а целостность проверяется
 * ПОЛНОСТЬЮ и до переключения.
 */
function supportsAddForeignKey(sequelize) {
    return nameOf(sequelize) === 'postgres';
}

/**
 * Проверить ссылочную целостность там, где ключи не навешивались отдельным шагом.
 * @returns {Promise<Array<Object>>} нарушения; пустой массив — всё хорошо
 */
async function checkForeignKeys(sequelize) {
    if (nameOf(sequelize) !== 'sqlite') return [];
    const [rows] = await sequelize.query('PRAGMA foreign_key_check');
    return rows || [];
}

/**
 * Порядок записи таблиц: родители раньше детей (топологическая сортировка по `references`).
 *
 * Это ОСНОВНОЙ механизм соблюдения ссылочной целостности при восстановлении, а не
 * запасной: он не требует прав суперпользователя и работает одинаково на любом
 * диалекте. Удаление идёт этим же порядком, но в обратную сторону.
 *
 * Самоссылки (таблица ссылается на себя) не мешают порядку ТАБЛИЦ и в цикл не
 * считаются — они решаются порядком строк, а не порядком таблиц.
 *
 * @param {Array<Object>} models — слитые определения
 * @param {Set<string>|Array<string>} [only] — ограничить набор
 * @returns {{order: Array<string>, cycle: Array<string>}} cycle непуст, если порядок невозможен
 */
function topoOrder(models, only) {
    const limit = only ? new Set(only) : null;
    const deps = new Map();      // таблица → Set(таблиц, от которых зависит)
    for (const m of models || []) {
        const t = m && m.tableName;
        if (!t || (limit && !limit.has(t))) continue;
        const set = deps.get(t) || new Set();
        for (const def of Object.values((m && m.fields) || {})) {
            const ref = def && def.references;
            const target = ref && (ref.model || ref.table);
            if (!target || target === t) continue;                 // самоссылка — не зависимость таблицы
            if (limit && !limit.has(target)) continue;             // вне набора — не ограничивает порядок
            set.add(target);
        }
        deps.set(t, set);
    }

    const order = [];
    const done = new Set();
    let progress = true;
    while (progress) {
        progress = false;
        for (const [t, set] of deps) {
            if (done.has(t)) continue;
            let ready = true;
            for (const d of set) if (!done.has(d)) { ready = false; break; }
            if (!ready) continue;
            order.push(t); done.add(t); progress = true;
        }
    }
    const cycle = [...deps.keys()].filter(t => !done.has(t)).sort();
    return { order, cycle };
}

/** Удалить строки таблицы по условию. Возвращает число удалённых. */
async function deleteRows(sequelize, { table, where, params, transaction }) {
    const q = quoter(sequelize);
    const sql = `DELETE FROM ${q(table)}` + (where ? ` WHERE ${where}` : '');
    const [, meta] = await sequelize.query(sql, { replacements: params || {}, transaction });
    return (meta && (meta.rowCount !== undefined ? meta.rowCount : meta.affectedRows)) || 0;
}

/**
 * Пакетная вставка строк.
 *
 * Одним `INSERT … VALUES (…),(…),…` на пачку: построчная вставка на десятках тысяч
 * записей превращает восстановление в часы сетевых round-trip'ов. Значения идут
 * ИМЕНОВАННЫМИ подстановками — конкатенация литералов в SQL недопустима.
 *
 * @param {Array<string>} columns — набор колонок, общий для всей пачки
 * @param {Array<Array>} values — строки в порядке `columns`
 */
async function insertBatch(sequelize, { table, columns, values, transaction, schema }) {
    if (!values || !values.length) return 0;
    const q = quoter(sequelize);
    const cols = columns.map(q).join(', ');
    const bind = {};
    const tuples = values.map((row, ri) => {
        const holders = row.map((v, ci) => {
            const key = `v${ri}_${ci}`;
            bind[key] = v === undefined ? null : v;
            return `:${key}`;
        });
        return `(${holders.join(', ')})`;
    });
    await sequelize.query(
        `INSERT INTO ${qualify(q, table, schema)} (${cols}) VALUES ${tuples.join(', ')}`,
        { replacements: bind, transaction }
    );
    return values.length;
}

/** Существующие UID таблицы из заданного набора — для сверки ссылок и upsert'а. */
async function existingUIDs(sequelize, { table, uids, transaction }) {
    const found = new Set();
    const list = [...uids];
    const q = quoter(sequelize);
    const CHUNK = 500;
    for (let i = 0; i < list.length; i += CHUNK) {
        const part = list.slice(i, i + CHUNK);
        const bind = {};
        const holders = part.map((v, j) => { bind[`u${j}`] = v; return `:u${j}`; });
        const [rows] = await sequelize.query(
            `SELECT ${q('UID')} AS uid FROM ${q(table)} WHERE ${q('UID')} IN (${holders.join(', ')})`,
            { replacements: bind, transaction, raw: true }
        );
        for (const r of rows || []) {
            const v = (r && typeof r === 'object' && !Array.isArray(r)) ? (r.uid !== undefined ? r.uid : Object.values(r)[0]) : (Array.isArray(r) ? r[0] : r);
            if (v !== undefined && v !== null) found.add(String(v));
        }
    }
    return found;
}

/** Обновить одну строку по UID. Возвращает `true`, если строка нашлась. */
async function updateRowByUID(sequelize, { table, uid, data, transaction }) {
    const q = quoter(sequelize);
    const cols = Object.keys(data).filter(k => k !== 'UID');
    if (!cols.length) return false;
    const bind = { __uid: uid };
    const sets = cols.map((c, i) => { bind[`s${i}`] = data[c] === undefined ? null : data[c]; return `${q(c)} = :s${i}`; });
    const [, meta] = await sequelize.query(
        `UPDATE ${q(table)} SET ${sets.join(', ')} WHERE ${q('UID')} = :__uid`,
        { replacements: bind, transaction }
    );
    const n = (meta && (meta.rowCount !== undefined ? meta.rowCount : meta.affectedRows)) || 0;
    return n > 0;
}

// ── Теневое пространство и атомарное переключение (ТЗ §6.1а) ─────────────────────
//
// Главная идея всего полного восстановления: живая база НЕ РАЗРУШАЕТСЯ. Новая
// структура и данные строятся РЯДОМ, а в конце происходит одно неделимое действие —
// подмена. Падение на любом шаге до подмены не оставляет полуразрушенного состояния:
// остаётся мусорное теневое пространство, которое просто удаляется.
//
// Старое НЕ УДАЛЯЕТСЯ, а ПЕРЕИМЕНОВЫВАЕТСЯ: тогда откат неудачного восстановления —
// это обратное переименование, мгновенное, без разворачивания safety-выгрузки.
//
// Переключаемся на уровне СХЕМЫ, а не базы: на управляемом хостинге прав на
// `CREATE DATABASE` может не быть, а на создание схемы — как правило, есть.

const SHADOW_SCHEMA = 'restore_tmp';
const ROLLBACK_PREFIX = 'rollback_';
const LIVE_SCHEMA = 'public';

/** Метка времени для имени схемы отката: `rollback_20260806_204512`. */
function rollbackName(now) {
    const d = now || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${ROLLBACK_PREFIX}${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
        + `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Можно ли на этой инсталляции построить теневое пространство.
 *
 * Выясняется ЗАРАНЕЕ пробным созданием и удалением схемы, а результат показывается в
 * панели состояния формы: администратор обязан знать режим своей инсталляции ДО
 * аварии, а не выяснять его в момент восстановления.
 *
 * @returns {Promise<{ok: boolean, mode: 'shadow'|'destructive', reason?: string}>}
 */
async function canCreateShadowSpace(sequelize) {
    const d = nameOf(sequelize);
    if (d === 'postgres') {
        const probe = `mos_probe_${Date.now().toString(36)}`;
        try {
            await sequelize.query(`CREATE SCHEMA ${quoter(sequelize)(probe)}`);
            await sequelize.query(`DROP SCHEMA ${quoter(sequelize)(probe)} CASCADE`);
            return { ok: true, mode: 'shadow' };
        } catch (e) {
            // Не удалось — значит на этой инсталляции работает разрушающий путь, и
            // safety-выгрузка перед ним становится принудительной (ТЗ §6.1а).
            try { await sequelize.query(`DROP SCHEMA IF EXISTS ${quoter(sequelize)(probe)} CASCADE`); } catch (e2) {}
            return { ok: false, mode: 'destructive', reason: e.message };
        }
    }
    if (d === 'sqlite') {
        // В SQLite «теневое пространство» — соседний ФАЙЛ, а переключение — переименование
        // средствами файловой системы. Отдельная реализация, здесь пока не поддержана:
        // объявлять доступным то, чего нет, хуже, чем честно уйти в разрушающий путь.
        return { ok: false, mode: 'destructive', reason: 'sqlite_shadow_not_implemented' };
    }
    return { ok: false, mode: 'destructive', reason: `unsupported_dialect_${d}` };
}

/**
 * Создать (пересоздав) теневое пространство. Мусор от прошлой неудачной попытки
 * удаляется здесь же — он никому не принадлежит и никого не страхует.
 * @returns {Promise<string>} имя созданной схемы
 */
async function createShadowSpace(sequelize, schemaName) {
    const q = quoter(sequelize);
    const name = schemaName || SHADOW_SCHEMA;
    if (nameOf(sequelize) !== 'postgres') {
        throw new Error(`Теневое пространство не поддержано для диалекта ${nameOf(sequelize)}`);
    }
    await sequelize.query(`DROP SCHEMA IF EXISTS ${q(name)} CASCADE`);
    await sequelize.query(`CREATE SCHEMA ${q(name)}`);
    log.info(`[backup] Создано теневое пространство ${name}`);
    return name;
}

/** Удалить теневое (или любое указанное) пространство. Молча терпит отсутствие. */
async function dropSchema(sequelize, schemaName) {
    if (nameOf(sequelize) !== 'postgres') return false;
    const q = quoter(sequelize);
    await sequelize.query(`DROP SCHEMA IF EXISTS ${q(schemaName)} CASCADE`);
    return true;
}

/**
 * АТОМАРНОЕ ПЕРЕКЛЮЧЕНИЕ: живая схема уходит в откат, теневая занимает её место.
 *
 * Обе операции — в ОДНОЙ транзакции. В PostgreSQL DDL транзакционный, поэтому либо
 * произошло всё, либо не произошло ничего; промежуточного состояния «старой схемы уже
 * нет, новая ещё не переименована» не существует.
 *
 * @returns {Promise<{rollbackSchema: string}>}
 */
async function switchToShadow(sequelize, opts = {}) {
    if (nameOf(sequelize) !== 'postgres') {
        throw new Error(`Атомарное переключение не поддержано для диалекта ${nameOf(sequelize)}`);
    }
    const q = quoter(sequelize);
    const shadow = opts.shadow || SHADOW_SCHEMA;
    const live = opts.live || LIVE_SCHEMA;
    const rollback = opts.rollbackSchema || rollbackName();

    const t = await sequelize.transaction();
    try {
        await sequelize.query(`ALTER SCHEMA ${q(live)} RENAME TO ${q(rollback)}`, { transaction: t });
        await sequelize.query(`ALTER SCHEMA ${q(shadow)} RENAME TO ${q(live)}`, { transaction: t });
        await t.commit();
    } catch (e) {
        try { await t.rollback(); } catch (e2) { /* транзакция могла закрыться сама */ }
        throw e;
    }
    log.info(`[backup] Переключение выполнено: ${live} → ${rollback}, ${shadow} → ${live}`);
    return { rollbackSchema: rollback };
}

/**
 * Откат: вернуть прежнее состояние обратным переименованием.
 *
 * Это и есть выигрыш приёма «построить рядом»: восстановление после неудачи —
 * мгновенное переименование, а не разворачивание safety-выгрузки (часы) с потерей
 * всего, что произошло после её снятия.
 */
async function rollbackToSchema(sequelize, rollbackSchema, opts = {}) {
    if (nameOf(sequelize) !== 'postgres') {
        throw new Error(`Откат схемы не поддержан для диалекта ${nameOf(sequelize)}`);
    }
    const q = quoter(sequelize);
    const live = opts.live || LIVE_SCHEMA;
    // Неудачную «новую» схему уводим в сторону, а не удаляем: разбираться с причиной
    // отказа лучше по её содержимому. Уборка — по политике (`dropStaleRollbacks`).
    const failed = `failed_${rollbackSchema.replace(new RegExp('^' + ROLLBACK_PREFIX), '')}`;

    const t = await sequelize.transaction();
    try {
        await sequelize.query(`ALTER SCHEMA ${q(live)} RENAME TO ${q(failed)}`, { transaction: t });
        await sequelize.query(`ALTER SCHEMA ${q(rollbackSchema)} RENAME TO ${q(live)}`, { transaction: t });
        await t.commit();
    } catch (e) {
        try { await t.rollback(); } catch (e2) {}
        throw e;
    }
    log.info(`[backup] Откат выполнен: ${rollbackSchema} → ${live} (неудачная схема сохранена как ${failed})`);
    return { failedSchema: failed };
}

/** Перечислить схемы по префиксу (`rollback_`/`failed_`), от новых к старым. */
async function listSchemasByPrefix(sequelize, prefix) {
    if (nameOf(sequelize) !== 'postgres') return [];
    const [rows] = await sequelize.query(
        `SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE :p ORDER BY nspname DESC`,
        { replacements: { p: prefix + '%' }, raw: true }
    );
    return (rows || []).map(r => (typeof r === 'object' && !Array.isArray(r)) ? r.name : (Array.isArray(r) ? r[0] : r)).filter(Boolean);
}

/** Схемы отката, от новых к старым. */
async function listRollbackSchemas(sequelize) {
    return listSchemasByPrefix(sequelize, ROLLBACK_PREFIX);
}

/**
 * Уборка схем, оставшихся от прошлых восстановлений.
 *
 * Схема отката занимает СТОЛЬКО ЖЕ МЕСТА, СКОЛЬКО БАЗА, поэтому политика ограничивает
 * не только возраст, но и КОЛИЧЕСТВО. Первая редакция ограничивала только возраст
 * («старше семи дней»), и на живом прогоне за один день накопилось семь полных копий
 * базы — то есть ограничение не работало вовсе в самом частом сценарии, когда
 * восстановления идут одно за другим.
 *
 * Правило: `keep` самых свежих не трогаем никогда (это путь назад), из остальных
 * удаляем всё, что старше срока ЛИБО не влезло в `maxKeep`.
 *
 * Схемы неудачных восстановлений (`failed_`) убираются той же политикой: они полезны
 * для разбора, но копиться бесконечно тоже не должны.
 */
async function dropStaleRollbacks(sequelize, { keep = 1, maxKeep = 3, olderThanDays = 7 } = {}) {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const dropped = [];

    for (const prefix of [ROLLBACK_PREFIX, 'failed_']) {
        const all = await listSchemasByPrefix(sequelize, prefix);
        for (let i = keep; i < all.length; i++) {
            const name = all[i];
            // Дата зашита в имя (`rollback_20260806_204512`) — отдельного хранилища
            // ради срока годности заводить незачем.
            const m = name.match(/_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
            let tooOld = true;
            if (m) {
                const ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
                tooOld = ts <= cutoff;
            }
            if (!tooOld && i < maxKeep) continue;
            try { await dropSchema(sequelize, name); dropped.push(name); }
            catch (e) { log.warn(`[backup] Схема ${name} не удалена: ${e.message}`); }
        }
    }
    if (dropped.length) log.info(`[backup] Удалено схем прошлых восстановлений: ${dropped.length} (${dropped.join(', ')})`);
    return dropped;
}

module.exports = {
    nameOf, quoter, scalarOf, checkNonBlocking, beginSnapshot, listTables,
    databaseSize, freeSpace, readPage, countRows,
    canDisableForeignKeys, setForeignKeysEnabled, supportsAddForeignKey, checkForeignKeys, topoOrder,
    deleteRows, insertBatch, existingUIDs, updateRowByUID,
    qualify,
    canCreateShadowSpace, createShadowSpace, dropSchema, switchToShadow,
    rollbackToSchema, listRollbackSchemas, listSchemasByPrefix, dropStaleRollbacks, rollbackName,
    SHADOW_SCHEMA, ROLLBACK_PREFIX, LIVE_SCHEMA
};
