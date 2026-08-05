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
async function countRows(sequelize, { table, where, params, transaction }) {
    const q = quoter(sequelize);
    const sql = `SELECT COUNT(*) AS n FROM ${q(table)}` + (where ? ` WHERE ${where}` : '');
    const [rows] = await sequelize.query(sql, { replacements: params || {}, transaction, raw: true });
    return Number(scalarOf(rows)) || 0;
}

module.exports = {
    nameOf, quoter, scalarOf, checkNonBlocking, beginSnapshot, listTables,
    databaseSize, freeSpace, readPage, countRows
};
