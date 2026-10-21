'use strict';

/**
 * journals — ЖУРНАЛ ДОКУМЕНТОВ: один список на несколько видов документов
 * (ТЗ «Платежи брони и журнал документов», §3.1).
 *
 * Как в классических учётных системах: «все денежные документы» — не три журнала,
 * которые человек обходит по очереди, а один, где поступление, выплата и
 * перемещение стоят рядом в порядке времени. У разных видов разные реквизиты, но у
 * всех есть ОБЩИЕ — сумма, дата операции, клиент, касса; журнал объявляет именно их.
 *
 * ОБЪЯВЛЕНИЕ — раздел `journals` в `db.json`, рядом с `models` и `registers`:
 *
 *     "journals": [{
 *       "name": "CashDocumentsJournal",
 *       "tableName": "jrn_cash_documents",
 *       "caption": { "i18n": "jrn_cash_documents_caption" },
 *       "documents": ["cash_receipts", "cash_payments", "cash_transfers"],
 *       "fields": { "organizationId": {...}, "amount": {...}, "cashboxId": {...} },
 *       "map": { "cash_transfers": { "cashboxId": "fromCashboxId", "clientId": null } }
 *     }]
 *
 * Поле журнала по умолчанию берётся из ОДНОИМЁННОГО поля документа; `map`
 * переименовывает его (`"cashboxId": "fromCashboxId"`) или говорит `null` — «у этого
 * вида такого нет».
 *
 * ЧТО ДОБАВЛЯЕТ ЯДРО (объявлять запрещено — см. `CORE_FIELDS`): `UID`, `docTable`
 * (вид документа), `number`, `date`, `seq`, `deletionMark`, `postingState` — то, что
 * есть у любого документа по его природе, а не по решению приложения.
 *
 * РЕАЛИЗАЦИЯ — ПРЕДСТАВЛЕНИЕ СУБД (`CREATE VIEW … UNION ALL`). Данных у журнала нет:
 * копия строк в отдельной таблице была бы вторым источником правды о документах,
 * обязанным совпадать с первым после каждой записи. Отсюда всё остальное:
 *   - модель журнала — ТОЛЬКО ДЛЯ ЧТЕНИЯ, запись отбивается в `dbGateway`
 *     (`journalWriteGuard`), как прямая запись в регистр;
 *   - сортировка, отбор, страницы, RLS — те же пути, что у таблицы: Sequelize
 *     читает представление как таблицу;
 *   - порядок «по моменту» работает МЕЖДУ видами сам: `seq` у всех документов из
 *     одной последовательности (`entityMoment`);
 *   - миграция не создаёт для журнала таблицу и не сверяет с ним схему: определение
 *     журнала НЕ входит в `collectAllModelDefs().models` (его отдают отдельным
 *     списком `journals`), а значит его не видят ни миграция, ни резервная копия, ни
 *     восстановление, ни правило ссылок, ни удаление помеченных. Представление
 *     пересоздаёт `createAll` в конце каждого старта (`ensureViews`): пересоздать
 *     дешевле, чем сверять, и после полного восстановления оно вернётся само.
 *
 * ПРОВЕРКИ ПРИ СТАРТЕ — ошибкой с понятным текстом (`validate`): каждый вид —
 * `entityType: document`; тип поля журнала совпадает с типом поля каждого документа;
 * журнал объявляет ВСЕ реквизиты доступа (`required_access_fields`) своих документов —
 * иначе RLS по журналу считала бы видимость не по тем полям, что у документа.
 */

const path = require('path');
const fs = require('fs');

/** Поля, которые ядро добавляет каждому журналу. */
const CORE_FIELDS = ['UID', 'docTable', 'number', 'date', 'seq', 'deletionMark', 'postingState'];

/** Имя колонки «вид документа». */
const DOC_TABLE_FIELD = 'docTable';

/** Реестр объявленных журналов: tableName → конфигурация. */
const registry = new Map();

function safeIdent(name) {
    return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name);
}

/** Ключ-комментарий («//…») — не поле, а пояснение в `db.json`. */
const noComments = (obj) => Object.fromEntries(
    Object.entries(obj || {}).filter(([k]) => k.slice(0, 2) !== '//'));

/**
 * Построить определение модели по объявлению журнала.
 *
 * Модель нужна рантайму — по ней читает Sequelize, по ней строятся колонки списка
 * и подставляются представления ссылок (`references` полей журнала работают как
 * у любой таблицы: колонка «Kunde» покажет имя клиента, а не UID). Ограничений
 * внешнего ключа у представления нет и быть не может — его никто не синхронизирует.
 */
function buildJournalModelDef(j) {
    if (!j || !j.tableName || !j.name) {
        throw new Error('[journals] Объявление журнала требует "name" и "tableName"');
    }
    if (!safeIdent(j.tableName)) {
        throw new Error(`[journals] Недопустимое имя журнала "${j.tableName}"`);
    }
    const documents = Array.isArray(j.documents) ? j.documents.filter(Boolean) : [];
    if (!documents.length) {
        throw new Error(`[journals] Журнал "${j.tableName}" не перечислил ни одного вида документа`);
    }
    for (const d of documents) {
        if (!safeIdent(d)) throw new Error(`[journals] Журнал "${j.tableName}": недопустимое имя документа "${d}"`);
    }
    const declared = noComments(j.fields);
    for (const n of Object.keys(declared)) {
        if (CORE_FIELDS.includes(n)) {
            throw new Error(`[journals] Журнал "${j.tableName}": поле "${n}" объявлять нельзя — его добавляет ядро.`);
        }
        if (!safeIdent(n)) throw new Error(`[journals] Журнал "${j.tableName}": недопустимое имя поля "${n}"`);
    }

    const posting = require('./posting');
    const fields = {
        UID: { type: 'STRING', allowNull: false, primaryKey: true },
        // Вид документа. Подписи видов и значки — у ЗАРЕГИСТРИРОВАННЫХ форм записи
        // (`saveLayout({ recordCaption, formIcon })`), а не здесь: второе объявление
        // одной подписи разошлось бы с первым. Подставляет их `decorateFields`.
        [DOC_TABLE_FIELD]: {
            type: 'STRING', allowNull: false,
            caption: { i18n: 'journal_doc_table_field' }
        },
        number: { type: 'STRING', allowNull: true, caption: { i18n: 'number_field' } },
        date: { type: 'DATE', allowNull: true, caption: { i18n: 'document_date_field' } },
        seq: { type: 'BIGINT', allowNull: true, service: true },
        deletionMark: { type: 'BOOLEAN', allowNull: true, service: true },
        postingState: {
            type: 'STRING', allowNull: true, service: true,
            caption: { i18n: 'posting_state_field' },
            inputType: 'emunList',
            options: [
                { value: posting.STATE.NOT_POSTED, caption: { i18n: 'posting_state_not_posted' } },
                { value: posting.STATE.QUEUED, caption: { i18n: 'posting_state_queued' } },
                { value: posting.STATE.POSTED, caption: { i18n: 'posting_state_posted' } },
                { value: posting.STATE.ERROR, caption: { i18n: 'posting_state_error' } }
            ]
        }
    };
    for (const [n, d] of Object.entries(declared)) fields[n] = Object.assign({}, d);

    return {
        name: j.name,
        tableName: j.tableName,
        fields,
        // Отметок времени у представления нет: Sequelize не должен их ни читать,
        // ни дописывать в запрос.
        options: { timestamps: false },
        entityConfig: null,
        journalConfig: {
            caption: j.caption || null,
            documents,
            fields: Object.keys(declared),
            map: j.map && typeof j.map === 'object' ? j.map : {}
        }
    };
}

/**
 * Объявить журнал: положить в реестр и вернуть определение модели.
 * Идемпотентно — сбор определений выполняется многократно.
 */
function declare(j) {
    const def = buildJournalModelDef(j);
    registry.set(def.tableName, Object.assign({ tableName: def.tableName, name: def.name }, def.journalConfig));
    return def;
}

/** Конфигурация журнала по имени таблицы (или `null`). */
function get(tableName) {
    return registry.get(tableName) || null;
}

/** Таблица — журнал? Нужно сторожу записи, спискам и командам. */
function isJournalTable(tableName) {
    return registry.has(tableName);
}

/** Все объявленные журналы. */
function all() {
    return Array.from(registry.values());
}

/** Журналы, в которые входит документ этого вида (для SSE и сброса кэшей). */
function journalsOfDocument(docTable) {
    const out = [];
    for (const cfg of registry.values()) {
        if (cfg.documents.indexOf(docTable) !== -1) out.push(cfg.tableName);
    }
    return out;
}

/**
 * Из какого поля документа берётся поле журнала.
 * @returns {string|null} имя поля документа; `null` — у этого вида поля нет
 */
function sourceField(cfg, docTable, field) {
    const m = cfg.map && cfg.map[docTable];
    if (m && Object.prototype.hasOwnProperty.call(m, field)) return m[field] || null;
    return field;
}

// ── Проверки при старте ──────────────────────────────────────────────────────

/** Реквизиты доступа проекта — те же, что у RLS и стартового валидатора. */
function requiredAccessFields() {
    try {
        const root = process.env.PROJECT_ROOT || process.cwd();
        const p = path.join(root, 'app.config.json');
        if (fs.existsSync(p)) {
            const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (Array.isArray(cfg.required_access_fields)) return cfg.required_access_fields;
        }
    } catch (e) { /* остаётся стандартный набор */ }
    return ['organizationId', 'userId', 'hotelId'];
}

/** Тип поля для сравнения: «DECIMAL(12,2)» и «decimal(12, 2)» — один тип. */
function typeKey(decl) {
    const t = decl && (typeof decl === 'string' ? decl : decl.type);
    return String(t || '').toUpperCase().replace(/\s+/g, '');
}

/**
 * Проверить объявления журналов против определений документов.
 *
 * Бросает ОДНУ ошибку со всеми найденными расхождениями: журнал, объявленный
 * неверно, показал бы не те данные (поле другого типа в `UNION ALL`, видимость по
 * другим реквизитам доступа) — и сделал бы это молча. Сервер, не стартовавший с
 * внятной причиной, дешевле.
 *
 * @param {Array<object>} defs — определения моделей ПОСЛЕ впрысков ядра (послойные:
 *   поля одной таблицы из разных слоёв сливаются здесь же)
 */
function validate(defs) {
    const byTable = new Map();
    for (const d of (defs || [])) {
        if (!d || !d.tableName) continue;
        const cur = byTable.get(d.tableName) || { fields: {}, entityConfig: null };
        Object.assign(cur.fields, d.fields || {});
        if (d.entityConfig) cur.entityConfig = d.entityConfig;
        byTable.set(d.tableName, cur);
    }
    const access = requiredAccessFields();
    const problems = [];

    for (const cfg of registry.values()) {
        const jt = cfg.tableName;
        if (byTable.has(jt)) {
            problems.push(`журнал "${jt}": таблица с таким именем уже объявлена моделью`);
        }
        for (const doc of cfg.documents) {
            const def = byTable.get(doc);
            if (!def) { problems.push(`журнал "${jt}": документ "${doc}" не объявлен`); continue; }
            const et = def.entityConfig && def.entityConfig.entityType;
            if (et !== 'document') {
                problems.push(`журнал "${jt}": "${doc}" — не документ (entityType: ${et || 'нет'})`);
                continue;
            }
            for (const f of cfg.fields) {
                const src = sourceField(cfg, doc, f);
                if (src === null) continue;
                const df = def.fields[src];
                if (!df) {
                    problems.push(`журнал "${jt}": у "${doc}" нет поля "${src}" для "${f}"`
                        + ' (переименуйте через map или скажите null)');
                    continue;
                }
                const want = typeKey(registryFieldDecl(jt, f));
                const have = typeKey(df);
                if (want !== have) {
                    problems.push(`журнал "${jt}": поле "${f}" ${want}, а у "${doc}.${src}" ${have}`);
                }
            }
            // Реквизиты доступа документа обязан нести и журнал: RLS по журналу
            // считает видимость по ЕГО полям, и без такого поля строка документа
            // была бы видна (или не видна) не тому, кому видна сама.
            for (const af of access) {
                if (def.fields[af] && cfg.fields.indexOf(af) === -1) {
                    problems.push(`журнал "${jt}": у "${doc}" есть реквизит доступа "${af}", а журнал его не объявил`);
                }
            }
        }
    }
    if (problems.length) {
        throw new Error('[journals] Журнал документов объявлен неверно:\n  - ' + problems.join('\n  - '));
    }
}

/** Объявление поля журнала (для сверки типов) — из последнего построенного определения. */
const _defs = new Map();
function registryFieldDecl(journalTable, field) {
    const def = _defs.get(journalTable);
    return def && def.fields ? def.fields[field] : null;
}

/** Запомнить определение (нужно `validate` для сверки типов). */
function remember(def) {
    if (def && def.tableName) _defs.set(def.tableName, def);
    return def;
}

// ── Представление СУБД ───────────────────────────────────────────────────────

/** SQL представления одного журнала: `SELECT … FROM doc UNION ALL …`. */
function viewSql(cfg, defsByTable) {
    const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';
    const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const parts = [];
    for (const doc of cfg.documents) {
        const def = defsByTable ? defsByTable.get(doc) : null;
        const has = (f) => !def || !!(def.fields && def.fields[f]);
        const cols = [
            `${q('UID')} AS ${q('UID')}`,
            `${lit(doc)} AS ${q(DOC_TABLE_FIELD)}`,
            `${has('number') ? q('number') : 'NULL'} AS ${q('number')}`,
            `${has('date') ? q('date') : 'NULL'} AS ${q('date')}`,
            `${has('seq') ? q('seq') : 'NULL'} AS ${q('seq')}`,
            `${has('deletionMark') ? q('deletionMark') : 'NULL'} AS ${q('deletionMark')}`,
            // Документ без проведения в журнале законен — состояния у него просто нет.
            `${has('postingState') ? q('postingState') : 'NULL'} AS ${q('postingState')}`
        ];
        for (const f of cfg.fields) {
            const src = sourceField(cfg, doc, f);
            cols.push(`${src ? q(src) : 'NULL'} AS ${q(f)}`);
        }
        parts.push(`SELECT ${cols.join(', ')} FROM ${q(doc)}`);
    }
    return parts.join('\nUNION ALL\n');
}

/**
 * Снять представления журналов. Зовётся миграцией В НАЧАЛЕ: перестройка таблицы
 * документа (`DROP TABLE … CASCADE`, смена типа колонки) упёрлась бы в зависящее от
 * неё представление. Пересоздаёт их `ensureViews` в конце.
 */
async function dropViews(sequelize, transaction) {
    for (const cfg of registry.values()) {
        const kind = await relationKind(sequelize, transaction, cfg.tableName);
        if (kind === 'view') {
            await sequelize.query(`DROP VIEW IF EXISTS "${cfg.tableName}"`, transaction ? { transaction } : {});
        }
    }
}

/** Что лежит в базе под этим именем: `'view'`, `'table'` или `null`. */
async function relationKind(sequelize, transaction, name) {
    const dialect = sequelize.getDialect ? sequelize.getDialect() : 'postgres';
    const opts = Object.assign({ type: sequelize.QueryTypes.SELECT, replacements: { n: name } },
        transaction ? { transaction } : {});
    if (dialect === 'sqlite') {
        const rows = await sequelize.query(`SELECT type FROM sqlite_master WHERE name = :n`, opts);
        return rows && rows[0] ? rows[0].type : null;
    }
    const rows = await sequelize.query(
        `SELECT table_type FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = :n`, opts);
    if (!rows || !rows[0]) return null;
    return /VIEW/i.test(rows[0].table_type) ? 'view' : 'table';
}

/**
 * Пересоздать представления всех журналов.
 *
 * Под этим именем ТАБЛИЦА — это не наш объект (или след прежней ошибки), и молча
 * удалять её нельзя: бросаем внятную ошибку.
 *
 * @param {object} sequelize
 * @param {object|null} transaction
 * @param {Array<object>} defs — определения моделей (чтобы не ссылаться на колонки, которых нет)
 */
async function ensureViews(sequelize, transaction, defs) {
    const byTable = new Map();
    for (const d of (defs || [])) {
        if (!d || !d.tableName) continue;
        const cur = byTable.get(d.tableName) || { fields: {} };
        Object.assign(cur.fields, d.fields || {});
        byTable.set(d.tableName, cur);
    }
    const opts = transaction ? { transaction } : {};
    let n = 0;
    for (const cfg of registry.values()) {
        const kind = await relationKind(sequelize, transaction, cfg.tableName);
        if (kind === 'table') {
            throw new Error(`[journals] Под именем журнала "${cfg.tableName}" в базе лежит ТАБЛИЦА —`
                + ' представление не создано. Удалите таблицу вручную, если она не нужна.');
        }
        if (kind === 'view') await sequelize.query(`DROP VIEW IF EXISTS "${cfg.tableName}"`, opts);
        await sequelize.query(`CREATE VIEW "${cfg.tableName}" AS\n${viewSql(cfg, byTable)}`, opts);
        n++;
    }
    return n;
}

// ── Рантайм: колонки, команды ────────────────────────────────────────────────

/**
 * Подписи и значки видов документа — для колонки «вид» в списке журнала.
 * Берутся у ЗАРЕГИСТРИРОВАННЫХ форм записи: это та же подпись, что у окна документа.
 */
function kindsOf(cfg) {
    let layoutMemory = null;
    try { layoutMemory = require('../layoutMemory'); } catch (e) { /* без подписей */ }
    return cfg.documents.map(doc => {
        let caption = null, icon = null;
        try { caption = layoutMemory && layoutMemory.getTableRecordCaption(doc); } catch (e) {}
        try { icon = layoutMemory && layoutMemory.getTableIcon(doc); } catch (e) {}
        return { table: doc, caption: caption || doc, icon: icon || null };
    });
}

/**
 * Дополнить колонки списка журнала: у «вида документа» — подписи значений и значки.
 * Мутирует переданные поля; возвращает их же.
 */
function decorateFields(tableName, fields) {
    const cfg = get(tableName);
    if (!cfg || !Array.isArray(fields)) return fields;
    const kinds = kindsOf(cfg);
    for (const f of fields) {
        if (!f || typeof f !== 'object' || (f.name || f.data) !== DOC_TABLE_FIELD) continue;
        f.inputType = 'emunList';
        f.options = kinds.map(k => ({ value: k.table, caption: k.caption }));
        const icons = {};
        for (const k of kinds) if (k.icon) icons[k.table] = k.icon;
        if (Object.keys(icons).length) f.valueIcons = icons;
        f.sortable = true;
    }
    return fields;
}

/**
 * Разложить UID строк журнала по видам документа: команда над выделением журнала
 * уходит в документ СВОЕГО вида (пометка, групповое проведение).
 *
 * @returns {Promise<Map<string, string[]>>} docTable → UID
 */
async function splitByDocument(tableName, uids, sessionID) {
    const out = new Map();
    const ids = Array.from(new Set((uids || []).filter(Boolean).map(String)));
    if (!ids.length || !isJournalTable(tableName)) return out;
    const rows = await require('../dbGateway').execute({
        operation: 'read', table: tableName,
        where: { UID: ids },
        options: { raw: true, attributes: ['UID', DOC_TABLE_FIELD] },
        context: { sessionID }
    });
    for (const r of (rows || [])) {
        if (!r || !r[DOC_TABLE_FIELD]) continue;
        if (!out.has(r[DOC_TABLE_FIELD])) out.set(r[DOC_TABLE_FIELD], []);
        out.get(r[DOC_TABLE_FIELD]).push(r.UID);
    }
    return out;
}

/** Вид документа одной строки журнала (или `null`). */
async function documentOf(tableName, uid, sessionID) {
    const m = await splitByDocument(tableName, [uid], sessionID);
    for (const k of m.keys()) return k;
    return null;
}

module.exports = {
    CORE_FIELDS,
    DOC_TABLE_FIELD,
    buildJournalModelDef,
    declare: (j) => remember(declare(j)),
    get,
    isJournalTable,
    all,
    journalsOfDocument,
    sourceField,
    validate,
    viewSql,
    dropViews,
    ensureViews,
    kindsOf,
    decorateFields,
    splitByDocument,
    documentOf
};
