'use strict';

/**
 * deleteMarked — ОБРАБОТКА «УДАЛЕНИЕ ПОМЕЧЕННЫХ ОБЪЕКТОВ» (серверная часть).
 *
 * Второй шаг удаления. Первый — пометка (drive_root/db/deletionMark.js) — стоит
 * дёшево и обратим; этот необратим, поэтому здесь и только здесь проверяется
 * главное: НЕ ССЫЛАЕТСЯ ЛИ НА ОБЪЕКТ КТО-ТО ЕЩЁ.
 *
 * Почему проверка отдельная, а не «попробуем удалить и посмотрим». Попытка
 * удаления отвечает нарушением внешнего ключа — сообщением, из которого видно
 * имя ограничения и ничего больше. Человеку нужен другой ответ: «на этого
 * клиента ссылаются 12 броней». Одно чинится за минуту, другое приводит к письму
 * в поддержку.
 *
 * ГРАНИЦА ПОИСКА ССЫЛОК. Учитываются ссылки ИЗВНЕ. Табличные части самого
 * объекта не считаются: они ему принадлежат и удаляются вместе с ним
 * (`cascadeDeleteChildren` в uniForm). Иначе любой документ со строками объявлял
 * бы сам себя неудаляемым.
 *
 * ПРАВА. Всё читается и пишется через `dbGateway` с сессией пользователя —
 * значит, RLS применяется тем же кодом, что и везде: сотрудник видит и удаляет
 * помеченных только в своей организации. Никакого `__SYS_INTERNAL__` здесь нет и
 * быть не должно: обработка действует ОТ ИМЕНИ человека.
 *
 * ЗАКРЫТЫЕ ДОКУМЕНТЫ. Отдельной проверки не нужно: удаление идёт через шлюз, а
 * на нём стоит замок неизменности (`drive_root/db/immutable.js`), который
 * отказывает в удалении документа в закрытом состоянии. Выставленный счёт не
 * может быть даже помечен, но правило всё равно проверяется дважды — намеренно:
 * пометка могла быть поставлена до того, как документ закрыли.
 */

const deletionMark = require('./deletionMark');

/** Все сущности системы: `[{ tableName, modelName, caption }]`. */
function entityTables() {
    const globalCtx = require('../globalServerContext');
    const defs = (globalCtx.collectAllModelDefs().models) || [];
    const out = [];
    for (const def of defs) {
        if (!deletionMark.isEntityDef(def)) continue;
        if (!def.tableName) continue;
        out.push({
            tableName: def.tableName,
            modelName: def.name || def.tableName,
            caption: (def.entityConfig && def.entityConfig.caption) || def.tableName,
            entityType: def.entityConfig && def.entityConfig.entityType
        });
    }
    return out;
}

/**
 * Кто ссылается на таблицу: `[{ table, field, isOwnSection }]`.
 * Считается один раз на вызов обработки — определения моделей не меняются.
 */
function referencesTo(tableName) {
    const globalCtx = require('../globalServerContext');
    const defs = (globalCtx.collectAllModelDefs().models) || [];
    const out = [];
    for (const def of defs) {
        const fields = def.fields || {};
        for (const [name, f] of Object.entries(fields)) {
            const ref = f && f.references;
            const refTable = ref && (ref.model || ref.table);
            if (!refTable || refTable !== tableName) continue;
            // Табличная часть САМОГО объекта — не внешняя ссылка: она уедет
            // вместе с ним.
            const isOwnSection = !!(def.tabularSection
                && def.tabularSection.parentTable === tableName
                && def.tabularSection.parentField === name);
            out.push({ table: def.tableName, field: name, isOwnSection });
        }
    }
    return out;
}

/**
 * Помеченные объекты, видимые этому пользователю.
 *
 * @param {object} p — `{ sessionID, withRefs }`
 * @returns {Promise<Array>} `[{ table, uid, name, number, entityType, blockers }]`
 */
async function list(p) {
    const dbGateway = require('../dbGateway');
    const sessionID = p && p.sessionID;
    const out = [];

    for (const t of entityTables()) {
        let rows = [];
        try {
            rows = await dbGateway.execute({
                operation: 'read',
                table: t.tableName,
                where: { [deletionMark.FIELD]: true },
                options: { raw: true },
                context: { sessionID }
            });
        } catch (e) {
            // Таблица могла не пережить миграцию или быть недоступна этой роли —
            // это не повод не показать остальные.
            continue;
        }
        for (const r of (rows || [])) {
            out.push({
                table: t.tableName,
                entityType: t.entityType,
                uid: r.UID,
                name: r.name || r.presentation || r.number || r.UID,
                number: r.number || '',
                date: r.date || null,
                blockers: null
            });
        }
    }

    if (p && p.withRefs) {
        for (const item of out) item.blockers = await blockersOf(item.table, item.uid, sessionID);
    }
    return out;
}

/**
 * Кто мешает удалить объект: `[{ table, field, count }]`.
 * Пустой массив — можно удалять.
 */
async function blockersOf(table, uid, sessionID) {
    const dbGateway = require('../dbGateway');
    const blockers = [];
    for (const ref of referencesTo(table)) {
        if (ref.isOwnSection) continue;
        let n = 0;
        try {
            n = await dbGateway.execute({
                operation: 'count',
                table: ref.table,
                where: { [ref.field]: uid },
                context: { sessionID }
            });
        } catch (e) {
            // Посчитать не вышло — честнее считать, что ссылка есть: удалить и
            // потом обнаружить, что ссылались, нельзя.
            blockers.push({ table: ref.table, field: ref.field, count: null });
            continue;
        }
        const cnt = (typeof n === 'number') ? n : (n && n.count) || 0;
        if (cnt > 0) blockers.push({ table: ref.table, field: ref.field, count: cnt });
    }
    return blockers;
}

/**
 * КТО ССЫЛАЕТСЯ — сами объекты, а не их количество.
 *
 * `blockersOf` отвечает «сколько», и для решения «можно ли удалять» этого хватает.
 * Но человеку, который видит «Бронирования: 44», дальше нужно другое: ОТКРЫТЬ ту
 * бронь и снять ссылку. Поэтому список ссылающихся объектов — отдельный вопрос и
 * отдельная функция.
 *
 * ОДНА СТРОКА НА ОБЪЕКТ, а не на ссылку: документ может ссылаться на клиента и
 * полем «плательщик», и полем «гость», но открывать его всё равно один раз.
 *
 * ТАБЛИЧНАЯ ЧАСТЬ показывается своим ДОКУМЕНТОМ: строка счёта не открывается
 * сама по себе, и мешает не она, а счёт, которому она принадлежит.
 *
 * ПОТОЛОК обязателен: на справочник могут ссылаться тысячи документов, и список
 * из тысяч строк не помогает — он только заставляет ждать. Сколько их на самом
 * деле, говорит `blockersOf`.
 *
 * @param {string} table
 * @param {string} uid
 * @param {string} sessionID
 * @param {number} [limit] — максимум строк на один ссылающийся вид
 * @returns {Promise<Array>} `[{ table, uid, name }]`
 */
async function referrersOf(table, uid, sessionID, limit) {
    const dbGateway = require('../dbGateway');
    const globalCtx = require('../globalServerContext');
    const cap = (typeof limit === 'number' && limit > 0) ? limit : 100;
    const defs = (globalCtx.collectAllModelDefs().models) || [];
    const defOf = (t) => defs.find(d => d.tableName === t);
    const seen = new Set();
    const out = [];

    for (const ref of referencesTo(table)) {
        if (ref.isOwnSection) continue;
        let rows = [];
        try {
            rows = await dbGateway.execute({
                operation: 'read',
                table: ref.table,
                where: { [ref.field]: uid },
                options: { raw: true, limit: cap },
                context: { sessionID }
            });
        } catch (e) {
            // Прочитать не вышло — в списке этого вида не будет, но число в
            // колонке «на него ссылаются» его всё равно назовёт.
            continue;
        }
        for (const r of (rows || [])) {
            let ownerTable = ref.table;
            let ownerUID = r.UID;
            let ownerName = r.name || r.presentation || r.number || r.UID;
            // Строка табличной части — это её документ.
            const def = defOf(ref.table);
            if (def && def.tabularSection && def.tabularSection.parentTable) {
                const parentField = def.tabularSection.parentField;
                const parentUID = parentField ? r[parentField] : null;
                if (!parentUID) continue;
                ownerTable = def.tabularSection.parentTable;
                ownerUID = parentUID;
                ownerName = '';
            }
            const key = ownerTable + '|' + ownerUID;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ table: ownerTable, uid: ownerUID, name: ownerName });
        }
    }

    // У документов-владельцев имени не было (строка табличной части его не
    // несёт) — дочитываем одним запросом на таблицу, а не по одному на строку.
    const needName = out.filter(o => !o.name);
    const byTable = new Map();
    for (const o of needName) {
        if (!byTable.has(o.table)) byTable.set(o.table, []);
        byTable.get(o.table).push(o);
    }
    for (const [t, items] of byTable.entries()) {
        let rows = [];
        try {
            rows = await dbGateway.execute({
                operation: 'read', table: t,
                where: { UID: items.map(i => i.uid) },
                options: { raw: true },
                context: { sessionID }
            });
        } catch (e) { continue; }
        const byUID = new Map((rows || []).map(r => [r.UID, r]));
        for (const it of items) {
            const r = byUID.get(it.uid);
            it.name = (r && (r.name || r.presentation || r.number)) || it.uid;
        }
    }

    return out;
}

module.exports = { entityTables, referencesTo, list, blockersOf, referrersOf };
