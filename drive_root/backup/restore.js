'use strict';

/**
 * restore — восстановление данных ОДНОЙ организации из резервной копии (ТЗ §6.6).
 *
 * Это не режим полного восстановления, а отдельная процедура с другими гарантиями.
 * Главное отличие: остальные организации продолжают работать в той же базе, поэтому
 * приём «построить рядом и атомарно переключиться» неприменим — пишем в ЖИВУЮ базу.
 * Цена ошибки выше, чем при полном восстановлении: там мы рушим своё и откатываемся,
 * здесь можно испортить работающего соседа.
 *
 * Компенсируется тем, что операция — ТОЛЬКО ДАННЫЕ, без DDL, а потому целиком
 * помещается в одну транзакцию, и откат достаётся бесплатно средствами СУБД.
 *
 * Порядок (ТЗ §6.6):
 *   1. safety-выгрузка этой организации          — обязательна, отключить нельзя
 *   2. проверка совместимости структуры          — потеряна колонка/сменился тип ⇒ отказ
 *   3. сверка ссылок на глобальные справочники   — висячая ссылка ⇒ отказ ДО записи
 *   4. dry-run отчёт: сколько строк удалим/вставим
 *   5. подтверждение вводом наименования организации
 *   6. сброс сессий пользователей организации
 *   7. ОДНА транзакция: DELETE класса A → INSERT из дампа → upsert класса D
 *   8. запись в файловый аудит-лог
 *
 * Ссылочная целостность держится ПОРЯДКОМ записи (`dialect.topoOrder`), а не
 * отключением проверок: `session_replication_role` требует суперпользователя, которого
 * на управляемом хостинге не дают. Отключение, если оно доступно, применяется
 * дополнительно — оно нужно только структурам с циклом ссылок.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const log = require('../log');
const container = require('./container');
const dialect = require('./dialect');
const scope = require('./scope');
const serialize = require('./serialize');
const { typeKeyOf } = require('../db/emptyValues');

const INSERT_BATCH = 200;

/**
 * Предел строк, удерживаемых в памяти за одно восстановление.
 *
 * Строки приходится буферизовать: в файле они лежат в порядке выгрузки, а вставлять
 * их надо в порядке ссылок (родители раньше детей). Для ОДНОЙ организации это
 * осмысленный объём, но молча упереться в память нельзя — предел назван и проверяется,
 * а сообщение отсылает к полному восстановлению (этап 2.4), где поток не буферизуется.
 */
const MAX_BUFFERED_ROWS = 500000;

// ── Аудит-лог: в ФАЙЛ, он должен пережить подмену базы (ТЗ §6.5) ─────────────────
//
// Реэкспорт общего модуля: своя копия здесь была, пока копий не стало три и они не
// начали расходиться. Имя `audit` сохранено — его зовут из этого файла десятками мест.
const { audit } = require('./audit');

// ── Чтение дампа ────────────────────────────────────────────────────────────────

/**
 * Разобрать начало файла — БЕЗ приватного ключа.
 * @returns {{header: Object, algId: number, encrypted: boolean}}
 */
function readContainerInfo(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(Math.min(65536, fs.statSync(filePath).size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        const parsed = container.parseHeader(buf);
        return {
            header: parsed.header,
            algId: parsed.algId,
            encrypted: parsed.algId !== container.ALG_NONE
        };
    } finally {
        try { fs.closeSync(fd); } catch (e) {}
    }
}

/** Заголовок файла — БЕЗ приватного ключа (область, дата, версия структуры). */
function readHeader(filePath) {
    return readContainerInfo(filePath).header;
}

/**
 * Опознать «не тот приватный ключ» среди ошибок OpenSSL.
 *
 * Пользователю нужно знать, что он вставил чужой ключ, а не читать
 * «data greater than mod len» — этот текст не подсказывает ни одного действия.
 */
function asFriendlyError(e) {
    const msg = String((e && e.message) || '');
    const code = String((e && e.code) || '');
    if (/^ERR_OSSL/.test(code) || /rsa routines|oaep|decrypt/i.test(msg)) {
        const err = new Error(msg);
        err.errorKey = 'restore_err_bad_key';
        return err;
    }
    return e;
}

/**
 * Построчный обход полезной нагрузки: файл → расшифровка → gunzip → NDJSON.
 *
 * Обработчик может вернуть `false`, чтобы прекратить чтение (например, когда всё
 * нужное уже собрано). Ошибки расшифровки и целостности прилетают ИСКЛЮЧЕНИЕМ —
 * «прочитали сколько смогли» здесь недопустимо.
 *
 * Цепочка собирается через `pipeline`, а не ручными `.pipe()`: у ручной сборки
 * ошибка промежуточного потока никем не слушается и становится необработанным
 * событием `error`, то есть роняет ВЕСЬ СЕРВЕР. Проверено вводом чужого приватного
 * ключа — процесс умирал, все пользователи теряли работу из-за опечатки одного
 * администратора.
 *
 * @param {Function} onRecord — (obj) => void|false
 * @param {string} [passphrase]
 * @param {Function} [onTick] — async-хук между записями. Нужен потребителю, который
 *   ПИШЕТ прочитанное (полное восстановление): обработчик записи синхронный, а вставка
 *   асинхронна, поэтому пачки складываются в очередь и выполняются здесь. Ожидание на
 *   этом `await` и есть обратное давление — без него разбор обгонял бы вставку и вся
 *   база оказалась бы в памяти, то есть ровно то, чего поток и избегает.
 */
async function readPayload(filePath, privateKeyPem, onRecord, passphrase, onTick) {
    const { pipeline, PassThrough } = require('stream');

    const source = fs.createReadStream(filePath);
    const decrypt = new container.DecryptStream({ privateKeyPem, passphrase });
    const gunzip = zlib.createGunzip();
    const out = new PassThrough();

    let stopped = false;      // читатель сказал «достаточно» (вернул false)
    let aborted = false;      // читатель отказал — цепочку рвём мы сами
    let pipeError = null;
    let settle;
    const finished = new Promise(res => { settle = res; });
    pipeline(source, decrypt, gunzip, out, (err) => {
        // Преждевременное закрытие — это наша собственная остановка чтения, а не сбой.
        // Ошибку разорванной цепочки нельзя ставить выше ошибки обработчика: иначе
        // настоящая причина («не удалось вставить строку») подменяется бессмысленным
        // «Premature close», и разбираться в отказе не с чем.
        if (err && !stopped && !aborted) pipeError = err;
        settle();
    });

    let handlerError = null;
    try {
        const rl = readline.createInterface({ input: out, crlfDelay: Infinity });
        for await (const line of rl) {
            if (!line) continue;
            let obj;
            try { obj = JSON.parse(line); }
            catch (e) { throw new Error(`Строка дампа нечитаема: ${e.message}`); }
            if (onRecord(obj) === false) { stopped = true; rl.close(); out.destroy(); break; }
            if (onTick) await onTick();
        }
    } catch (e) {
        // Ошибка потока приходит и сюда (readline отвергает итератор) — исходную
        // причину всё равно берём из pipeline, она информативнее.
        handlerError = e;
        aborted = true;
        // Цепочку ОБЯЗАТЕЛЬНО разрушаем. Иначе `pipeline` продолжает ждать, когда из
        // `out` дочитают, читать некому, обратное давление останавливает и файловый
        // поток — в событийном цикле не остаётся ни одной задачи, и процесс просто
        // ВЫХОДИТ с кодом 0, не сказав ни слова об ошибке. Поймано живым прогоном:
        // отказ вставки посреди восстановления выглядел как «скрипт молча закончился».
        try { out.destroy(); } catch (e2) {}
        try { source.destroy(); } catch (e2) {}
    }

    await finished;
    // Порядок важен: ошибка обработчика — первопричина, ошибка цепочки после неё —
    // следствие нашего же разрыва.
    if (handlerError && !stopped) throw asFriendlyError(handlerError);
    if (pipeError) throw asFriendlyError(pipeError);
    return { stopped };
}

// ── Шаг 2: совместимость структуры ──────────────────────────────────────────────

/**
 * Сверить структуру дампа с ДЕЙСТВУЮЩЕЙ структурой базы.
 *
 * Здесь проверяется не то же, что при полном восстановлении: там структура
 * воссоздаётся из дампа и обязана совпасть с ним точно, здесь — надо вписать старые
 * строки в живую схему, которую менять нельзя.
 *
 *   колонка есть в дампе, но её больше нет   ⇒ ОТКАЗ (данные некуда положить)
 *   тип колонки изменился                     ⇒ ОТКАЗ (подгонка значений = вторая миграция)
 *   таблица есть в дампе, но её больше нет    ⇒ ОТКАЗ
 *   колонка появилась после снятия дампа      ⇒ можно, если nullable/с умолчанием
 *   таблица появилась после снятия дампа      ⇒ можно, но её строки организации удалятся
 *
 * @returns {{ok: boolean, fatal: Array<Object>, safe: Array<Object>}}
 */
function compareStructure(dumpModels, currentModels, restorableTables) {
    const cur = new Map((currentModels || []).map(m => [m.tableName, m]));
    const dmp = new Map((dumpModels || []).map(m => [m.tableName, m]));
    const fatal = [];
    const safe = [];

    for (const table of restorableTables) {
        const c = cur.get(table);
        const d = dmp.get(table);
        if (!c) { fatal.push({ kind: 'table_missing_now', table }); continue; }
        if (!d) { safe.push({ kind: 'table_added_since_dump', table }); continue; }

        const cf = c.fields || {};
        const df = d.fields || {};
        for (const [name, def] of Object.entries(df)) {
            if (!(name in cf)) { fatal.push({ kind: 'column_removed', table, column: name }); continue; }
            const a = typeKeyOf(def);
            const b = typeKeyOf(cf[name]);
            if (a && b && a !== b) fatal.push({ kind: 'type_changed', table, column: name, from: a, to: b });
        }
        for (const [name, def] of Object.entries(cf)) {
            if (name in df) continue;
            const nullable = def.allowNull !== false;
            const hasDefault = Object.prototype.hasOwnProperty.call(def, 'defaultValue');
            if (nullable || hasDefault) safe.push({ kind: 'column_added', table, column: name });
            else fatal.push({ kind: 'column_added_required', table, column: name });
        }
    }
    return { ok: fatal.length === 0, fatal, safe };
}

// ── Разбор дампа под конкретную организацию ─────────────────────────────────────

/**
 * Прочитать из файла всё, что относится к организации.
 *
 * Работает и с целевой выгрузкой организации, и с ОБЩИМ дампом: во втором случае
 * строки отбираются тем же правилом принадлежности, что и при выгрузке
 * (`scope.rowBelongsToOrg`), включая транзитивный случай `hotelId` — для него сначала
 * собираются отели организации, а таблицы с `hotelId` фильтруются вторым проходом по
 * уже собранным строкам (порядок таблиц в файле не гарантирует, что `hotels` встретится
 * раньше `rooms`).
 *
 * @returns {Promise<{header, models, byTable: Map<string, Array>, counts: Object}>}
 */
async function collectOrganizationData(filePath, privateKeyPem, organizationId, opts = {}) {
    const passphrase = opts.passphrase;
    let header = null;
    let dumpModels = [];
    const rawByTable = new Map();       // таблица → сырые строки (до фильтра по организации)
    let totalKept = 0;

    await readPayload(filePath, privateKeyPem, (rec) => {
        if (!rec || !rec.kind) return;
        if (rec.kind === 'header') { header = rec; return; }
        if (rec.kind === 'models') { dumpModels = rec.models || []; return; }
        if (rec.kind !== 'row') return;
        const arr = rawByTable.get(rec.table) || [];
        arr.push(rec.data);
        rawByTable.set(rec.table, arr);
        if (++totalKept > MAX_BUFFERED_ROWS) {
            const e = new Error('too_large');
            e.errorKey = 'restore_err_too_large';
            e.vars = { limit: String(MAX_BUFFERED_ROWS) };
            throw e;
        }
    }, passphrase);

    if (!header) throw Object.assign(new Error('no header'), { errorKey: 'restore_err_no_header' });

    // Отели организации — база транзитивного отбора (`rooms` не имеет organizationId).
    const hotelIds = new Set(
        (rawByTable.get('hotels') || [])
            .filter(r => String(r[scope.ORG_FIELD] || '') === String(organizationId))
            .map(r => String(r.UID))
    );

    return { header, dumpModels, rawByTable, hotelIds };
}

/** Отфильтровать сырые строки под организацию согласно плану выгрузки. */
function filterForOrganization(rawByTable, plan, organizationId, hotelIds) {
    const byTable = new Map();
    for (const entry of plan.tables) {
        if (!scope.isRestorable(entry.cls)) continue;
        const raw = rawByTable.get(entry.table) || [];
        const filter = entry.filter || null;
        const kept = filter ? raw.filter(r => scope.rowBelongsToOrg(r, filter, organizationId, hotelIds)) : raw;
        byTable.set(entry.table, kept);
    }
    return byTable;
}

// ── Шаг 3: сверка ссылок на невосстанавливаемые таблицы ─────────────────────────

/**
 * Проверить, что все ссылки восстанавливаемых строк ведут в существующие записи.
 *
 * Проверять надо ссылки на то, что мы НЕ пишем: глобальные справочники (класс B) общие
 * для всех организаций, и откатывать их к состоянию месячной давности нельзя — сломаются
 * соседи. Значит справочник мог измениться после снятия копии (удалили ставку НДС,
 * статус, тип размещения), и строка приедет с висячей ссылкой. Ловится ДО записи.
 *
 * Ссылки внутрь набора (класс A и `users` класса D) проверять не нужно — эти строки мы
 * вставляем сами; но если целевой строки нет ни в дампе, ни в базе, это тоже висячая
 * ссылка, и она попадёт в отчёт.
 */
async function checkReferences(sequelize, { models, byTable, transaction }) {
    const modelByTable = new Map((models || []).map(m => [m.tableName, m]));
    const needed = new Map();          // целевая таблица → Map(uid → [{table, column}])

    for (const [table, rows] of byTable) {
        const fields = (modelByTable.get(table) || {}).fields || {};
        const refFields = Object.entries(fields)
            .filter(([, def]) => def && def.references && (def.references.model || def.references.table))
            .map(([name, def]) => ({ name, target: def.references.model || def.references.table }));
        if (!refFields.length) continue;

        for (const row of rows) {
            for (const rf of refFields) {
                const v = row[rf.name];
                if (v === null || v === undefined || v === '') continue;   // пусто — законное «нет ссылки»
                const m = needed.get(rf.target) || new Map();
                if (!m.has(String(v))) m.set(String(v), { table, column: rf.name });
                needed.set(rf.target, m);
            }
        }
    }

    const dangling = [];
    for (const [target, uidMap] of needed) {
        // UID, которые мы вставим сами, проверять в базе не надо.
        const incoming = new Set((byTable.get(target) || []).map(r => String(r.UID)));
        const toCheck = [...uidMap.keys()].filter(u => !incoming.has(u));
        if (!toCheck.length) continue;
        let present;
        try {
            present = await dialect.existingUIDs(sequelize, { table: target, uids: toCheck, transaction });
        } catch (e) {
            // Таблицы нет в базе — это уже поймано сверкой структуры; здесь не гадаем.
            log.warn(`[restore] Сверка ссылок: таблица ${target} недоступна (${e.message})`);
            continue;
        }
        for (const uid of toCheck) {
            if (present.has(uid)) continue;
            const src = uidMap.get(uid);
            dangling.push({ target, uid, table: src.table, column: src.column });
        }
    }
    return dangling;
}

// ── Анализ (шаги 2–4): всё, что делается ДО записи ──────────────────────────────

/**
 * Разобрать файл и сказать, что произойдёт. Ничего не меняет.
 *
 * @returns {Promise<Object>} отчёт: заголовок, структура, ссылки, план по строкам
 */
async function analyze(opts) {
    const { sequelize, models, filePath, privateKeyPem, organizationId } = opts;

    const collected = await collectOrganizationData(filePath, privateKeyPem, organizationId, opts);
    const plan = scope.buildPlan(models, { type: 'organization', organizationId });
    const byTable = filterForOrganization(collected.rawByTable, plan, organizationId, collected.hotelIds);

    const restorable = plan.tables.filter(t => scope.isRestorable(t.cls));
    const structure = compareStructure(collected.dumpModels, models, restorable.map(t => t.table));

    // Дамп, снятый до того, как выгрузка научилась сохранять служебные отметки
    // времени, их не содержит. Восстановление пройдёт, но происхождение строк
    // («когда документ создан») будет утеряно — молчать об этом нельзя.
    const modelByTableForTs = new Map((models || []).map(m => [m.tableName, m]));
    for (const entry of restorable) {
        const rows = byTable.get(entry.table);
        if (!rows || !rows.length) continue;
        const svc = Object.keys(serialize.serviceFields(modelByTableForTs.get(entry.table) || {}));
        if (!svc.length) continue;
        if (!(svc[0] in rows[0])) structure.safe.push({ kind: 'timestamps_missing', table: entry.table });
    }

    // Порядок записи. Цикл ссылок без возможности отключить проверки — тупик, и
    // сказать об этом надо здесь, а не на середине транзакции.
    const { order, cycle } = dialect.topoOrder(models, restorable.map(t => t.table));
    const fkOff = await dialect.canDisableForeignKeys(sequelize);

    // Сколько строк удалим (текущее состояние) и сколько вставим (из дампа).
    const q = dialect.quoter(sequelize);
    const tables = [];
    for (const entry of restorable) {
        const where = scope.buildWhere(entry.filter, organizationId, q);
        let existing = 0;
        try {
            existing = await dialect.countRows(sequelize, {
                table: entry.table, where: where ? where.sql : null, params: where ? where.params : null
            });
        } catch (e) { existing = -1; }         // таблицы нет — поймано сверкой структуры
        const incoming = (byTable.get(entry.table) || []).length;
        const mode = scope.restoreMode(entry.cls);
        if (!existing && !incoming) continue;  // молчим о том, где ничего не происходит
        tables.push({ table: entry.table, cls: entry.cls, mode, willDelete: mode === 'replace' ? existing : 0, willInsert: incoming });
    }
    tables.sort((a, b) => a.table.localeCompare(b.table));

    let dangling = [];
    if (structure.ok) dangling = await checkReferences(sequelize, { models, byTable });

    // Класс D: сколько учётных записей будет создано и скольким откатится хэш пароля.
    const users = byTable.get('users') || [];
    let usersExisting = new Set();
    if (users.length) {
        try { usersExisting = await dialect.existingUIDs(sequelize, { table: 'users', uids: users.map(u => String(u.UID)) }); }
        catch (e) { /* сверка структуры уже сказала бы, что таблицы нет */ }
    }

    const blockers = [];
    if (!structure.ok) blockers.push('structure');
    if (dangling.length) blockers.push('references');
    if (cycle.length && !fkOff.ok) blockers.push('reference_cycle');

    return {
        header: collected.header,
        organizationId,
        structure,
        dangling,
        tables,
        order,
        cycle,
        foreignKeysOff: fkOff,
        totalDelete: tables.reduce((s, t) => s + Math.max(0, t.willDelete), 0),
        totalInsert: tables.reduce((s, t) => s + t.willInsert, 0),
        users: { total: users.length, create: users.length - usersExisting.size, update: usersExisting.size },
        warnings: plan.warnings,
        blockers,
        ok: blockers.length === 0,
        _byTable: byTable                      // для execute, наружу не показывается
    };
}

// ── Шаг 7: собственно запись ────────────────────────────────────────────────────

/**
 * Значения строки дампа → значения для вставки, по типам ДЕЙСТВУЮЩЕЙ модели.
 *
 * Отдельный случай — служебные отметки времени: в старых дампах (снятых до того, как
 * выгрузка научилась их сохранять) их нет вовсе, а колонки `NOT NULL`. Подставляем
 * текущий момент, но МОЛЧА этого не делаем: анализ отдельной строкой предупреждает,
 * что происхождение строк из такого дампа не восстановимо.
 */
function rowToInsert(row, fields, serviceNames) {
    const out = {};
    const now = new Date();
    for (const [name, def] of Object.entries(fields)) {
        if (name in row) { out[name] = serialize.fromDump(row[name], def); continue; }
        if (serviceNames && serviceNames.has(name)) out[name] = now;
    }
    return out;
}

/**
 * Выполнить восстановление организации. ОДНА транзакция: любая ошибка — ROLLBACK,
 * состояние организации не изменилось.
 *
 * Анализ выполняется ЗАНОВО внутри процедуры и его вердикт обязателен: между показом
 * отчёта и нажатием кнопки база живёт своей жизнью, и решение по устаревшему отчёту
 * было бы решением вслепую.
 */
async function restoreOrganization(opts) {
    const { sequelize, models, filePath, privateKeyPem, organizationId } = opts;
    const started = Date.now();

    const report = await analyze(opts);
    if (!report.ok) {
        const e = new Error('restore blocked: ' + report.blockers.join(','));
        e.errorKey = 'restore_err_blocked';
        e.report = report;
        throw e;
    }

    const byTable = report._byTable;
    const modelByTable = new Map((models || []).map(m => [m.tableName, m]));
    const plan = scope.buildPlan(models, { type: 'organization', organizationId });
    const planByTable = new Map(plan.tables.map(t => [t.table, t]));
    const q = dialect.quoter(sequelize);
    const stats = { deleted: {}, inserted: {}, usersCreated: 0, usersUpdated: 0 };

    const transaction = await sequelize.transaction();
    let killedSessions = { count: 0, sessionIds: [] };
    try {
        if (report.foreignKeysOff.ok) {
            await dialect.setForeignKeysEnabled(sequelize, false, transaction);
        }

        // Сессии пользователей организации — В ТОЙ ЖЕ транзакции: если восстановление
        // откатится, никого не разлогинило зря. Свою сессию администратор сохраняет.
        killedSessions = await resetOrganizationSessions(sequelize, {
            organizationId, keepSessionId: opts.keepSessionId, transaction
        });

        // Замещение, а не слияние: состояние организации становится ровно таким, как в
        // дампе. Удаляем в ОБРАТНОМ порядке ссылок — дети раньше родителей.
        const replaceTables = report.tables.filter(t => t.mode === 'replace').map(t => t.table);
        const deleteOrder = report.order.filter(t => replaceTables.includes(t)).reverse();
        for (const table of deleteOrder) {
            const entry = planByTable.get(table);
            const where = scope.buildWhere(entry && entry.filter, organizationId, q);
            stats.deleted[table] = await dialect.deleteRows(sequelize, {
                table, where: where ? where.sql : null, params: where ? where.params : null, transaction
            });
        }

        // Вставляем в ПРЯМОМ порядке — родители раньше детей.
        for (const table of report.order) {
            if (!replaceTables.includes(table)) continue;
            const rows = byTable.get(table) || [];
            if (!rows.length) { stats.inserted[table] = 0; continue; }
            const model = modelByTable.get(table) || {};
            const fields = serialize.modelFields(model);
            const serviceNames = new Set(Object.keys(serialize.serviceFields(model)));
            let done = 0;
            for (let i = 0; i < rows.length; i += INSERT_BATCH) {
                const chunk = rows.slice(i, i + INSERT_BATCH).map(r => rowToInsert(r, fields, serviceNames));
                // Набор колонок в пачке общий: берём объединение и подставляем NULL там,
                // где значения нет — иначе одна строка без необязательного поля разбила бы
                // пачку на строки и вернула нас к построчной вставке.
                const columns = [...new Set(chunk.flatMap(o => Object.keys(o)))];
                const values = chunk.map(o => columns.map(c => (c in o ? o[c] : null)));
                done += await dialect.insertBatch(sequelize, { table, columns, values, transaction });
            }
            stats.inserted[table] = done;
        }

        // Класс D — upsert: создаём недостающих, обновляем существующих, НИЧЕГО не
        // удаляем. Удаление утащило бы каскадом сессии, личные настройки и задания —
        // данные, к организации не относящиеся.
        for (const table of scope.IDENTITY_TABLES) {
            const rows = byTable.get(table) || [];
            if (!rows.length) continue;
            const model = modelByTable.get(table) || {};
            const fields = serialize.modelFields(model);
            const serviceNames = new Set(Object.keys(serialize.serviceFields(model)));
            const present = await dialect.existingUIDs(sequelize, { table, uids: rows.map(r => String(r.UID)), transaction });
            const toCreate = [];
            for (const raw of rows) {
                const data = rowToInsert(raw, fields, serviceNames);
                data.UID = raw.UID;
                if (present.has(String(raw.UID))) {
                    await dialect.updateRowByUID(sequelize, { table, uid: raw.UID, data, transaction });
                    stats.usersUpdated++;
                } else {
                    toCreate.push(data);
                }
            }
            for (let i = 0; i < toCreate.length; i += INSERT_BATCH) {
                const chunk = toCreate.slice(i, i + INSERT_BATCH);
                const columns = [...new Set(chunk.flatMap(o => Object.keys(o)))];
                const values = chunk.map(o => columns.map(c => (c in o ? o[c] : null)));
                stats.usersCreated += await dialect.insertBatch(sequelize, { table, columns, values, transaction });
            }
        }

        if (report.foreignKeysOff.ok) {
            await dialect.setForeignKeysEnabled(sequelize, true, transaction);
        }
        await transaction.commit();
    } catch (e) {
        try { await transaction.rollback(); } catch (e2) { /* транзакция могла закрыться сама */ }
        throw e;
    }

    // Кэш пользователя по сессии живёт в memory_store, а не в БД — удалённые строки
    // сами по себе его не вычищают, и сессия продолжала бы «работать» из кэша.
    try {
        const globalCtx = require('../globalServerContext');
        for (const sid of killedSessions.sessionIds) await globalCtx.invalidateSessionUser(sid);
    } catch (e) {
        log.warn(`[restore] Кэш сессий не сброшен: ${e.message}`);
    }

    return { ok: true, stats, report, sessionsReset: killedSessions.count, durationMs: Date.now() - started };
}

/**
 * Сбросить сессии пользователей организации (шаг 6).
 *
 * Их данные только что подменили под ними — работать поверх обломков прежнего состояния
 * нельзя. Сессия администратора не трогается: он не обязан быть пользователем
 * восстанавливаемой организации, а без своей сессии он не увидит и результата.
 * Остальные организации операции не замечают.
 *
 * @returns {Promise<{count: number, sessionIds: Array<string>}>}
 */
async function resetOrganizationSessions(sequelize, { organizationId, keepSessionId, transaction }) {
    const q = dialect.quoter(sequelize);
    const userSub = `SELECT ${q('UID')} FROM ${q('users')} WHERE ${q(scope.ORG_FIELD)} = :org`
        + ` UNION SELECT ${q('userId')} FROM ${q('user_organizations')} WHERE ${q(scope.ORG_FIELD)} = :org`;

    const [rows] = await sequelize.query(
        `SELECT ${q('sessionId')} AS sid FROM ${q('sessions')} WHERE ${q('userId')} IN (${userSub})`,
        { replacements: { org: organizationId }, transaction, raw: true }
    );
    const sessionIds = (rows || [])
        .map(r => (r && typeof r === 'object' && !Array.isArray(r)) ? (r.sid !== undefined ? r.sid : Object.values(r)[0]) : r)
        .filter(s => s && s !== keepSessionId);

    if (sessionIds.length) {
        const bind = { };
        const holders = sessionIds.map((v, i) => { bind[`s${i}`] = v; return `:s${i}`; });
        await sequelize.query(
            `DELETE FROM ${q('sessions')} WHERE ${q('sessionId')} IN (${holders.join(', ')})`,
            { replacements: bind, transaction }
        );
    }
    return { count: sessionIds.length, sessionIds };
}

module.exports = {
    analyze, restoreOrganization, resetOrganizationSessions, readContainerInfo,
    readHeader, readPayload, compareStructure, checkReferences,
    audit, MAX_BUFFERED_ROWS
};
