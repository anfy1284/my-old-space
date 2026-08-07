'use strict';

/**
 * restoreFull — ПОЛНОЕ восстановление базы из резервной копии (ТЗ §6.1–§6.5).
 *
 * Отличие от восстановления одной организации (`restore.js`) принципиальное, а не
 * количественное. Там строки ложатся в ЖИВУЮ схему, которую менять нельзя, поэтому
 * структура дампа только сверяется. Здесь структура ВОССОЗДАЁТСЯ из снимка моделей,
 * лежащего в дампе, — и данные ложатся ровно в свою схему, без сопоставления колонок
 * на лету. Приведение к сегодняшней версии делает потом штатная миграция. Мы
 * переиспользуем инструмент, а не пишем рядом второй.
 *
 * ГЛАВНОЕ СВОЙСТВО: живая база не разрушается. Всё строится РЯДОМ (теневая схема),
 * в конце — одно неделимое переключение (§6.1а). Падение на любом шаге до переключения
 * оставляет живую базу нетронутой; остаётся мусорная теневая схема, которая удаляется.
 *
 * ПОРЯДОК (§6.1):
 *   1. safety-выгрузка текущей базы          — ДО любой записи (ведёт главный процесс)
 *   2. теневое пространство                   — живая база не трогается
 *   3. структура ИЗ СНИМКА МОДЕЛЕЙ В ДАМПЕ    — сверка с `actualHash` заголовка
 *   4. загрузка данных                        — потоком, батчами, мимо ORM-хуков
 *   5. внешние ключи с проверкой              — висячая ссылка ⇒ отказ ДО переключения
 *   6. `sequences`                            — если секция непуста
 *   7. АТОМАРНОЕ ПЕРЕКЛЮЧЕНИЕ
 *   8. штатная миграция + сброс кэшей         — ведёт главный процесс
 *
 * ЗАПИСЬ ИДЁТ RAW, мимо `dbGateway` и ORM-хуков. Иначе отработали бы `applyPresentation`
 * (перезапишет представление, причём результат зависит от порядка вставки),
 * `default.documentDate` (проставит документу СЕГОДНЯШНЮЮ дату — тихая порча даты в
 * юридическом документе), `default.autoNumber`, прикладные `beforeCreate` и SSE-событие
 * на каждую строку. Восстановление обязано ВОСПРОИЗВЕСТИ данные, а не пересчитать их
 * бизнес-правилами.
 */

const fs = require('fs');
const path = require('path');

const log = require('../log');
const dialect = require('./dialect');
const serialize = require('./serialize');
const restore = require('./restore');
const settingsStore = require('./settings');
const modelsHash = require('../db/modelsHash');
const schemaBuilder = require('../db/schemaBuilder');

const INSERT_BATCH = 500;

// ── Фаза 0: что можно узнать БЕЗ приватного ключа ────────────────────────────────

/**
 * Заголовок копии и режим, в котором будет работать восстановление.
 *
 * Читается без ключа (заголовок в файле открытым текстом) и показывается на экране
 * перед запуском (§6.2б): администратор обязан увидеть версию структуры и режим ДО
 * точки невозврата, а не выяснять их в момент аварии.
 *
 * @returns {Promise<Object>}
 */
async function inspect(sequelize, filePath) {
    const parsed = restore.readContainerInfo(filePath);
    const header = parsed.header;
    const shadow = await dialect.canCreateShadowSpace(sequelize);
    return {
        header,
        // Копия из домашнего архива приходит РАСШИФРОВАННОЙ — приватный ключ для неё
        // не нужен и спрашивать его нельзя (см. container.js, ALG_NONE).
        encrypted: parsed.encrypted,
        scopeType: (header.scope && header.scope.type) || 'full',
        mode: shadow.mode,                       // 'shadow' | 'destructive'
        shadowAvailable: shadow.ok,
        shadowReason: shadow.reason || '',
        sourceDialect: header.sourceDialect || '',
        targetDialect: dialect.nameOf(sequelize),
        dbVersion: header.dbVersion || 0,
        configHash: header.configHash || '',
        actualHash: header.actualHash || ''
    };
}

// ── Чтение дампа по секциям ──────────────────────────────────────────────────────

/**
 * Прочитать только снимок моделей (вторая строка полезной нагрузки) и остановиться.
 *
 * Отдельным проходом, а не заодно с данными: структуру надо построить ДО того, как
 * появится куда класть строки, а держать весь дамп в памяти нельзя (в этом и разница
 * с восстановлением одной организации, где буферизация осмысленна).
 */
async function readModelsSection(filePath, privateKeyPem, passphrase) {
    let header = null;
    let models = null;
    await restore.readPayload(filePath, privateKeyPem, (rec) => {
        if (!rec || !rec.kind) return;
        if (rec.kind === 'header') { header = rec; return; }
        if (rec.kind === 'models') { models = rec.models || []; return false; }
        // Дошли до данных, а секции моделей не было — файл не той структуры.
        if (rec.kind === 'row' || rec.kind === 'table') return false;
    }, passphrase);

    if (!models) {
        const e = new Error('no models section');
        e.errorKey = 'restore_err_no_models';
        throw e;
    }
    return { header, models };
}

// ── Фазы восстановления (исполняются в ДОЧЕРНЕМ процессе) ────────────────────────

/**
 * Выполнить восстановление до переключения включительно.
 *
 * Живёт в дочернем процессе (`restoreWorker.js`): изоляция даёт возможность убить
 * операцию по таймауту и не оставить главный процесс в неопределённом состоянии.
 *
 * @param {Object} opts
 * @param {Object} opts.sequelize
 * @param {string} opts.filePath
 * @param {string} opts.privateKeyPem — только в памяти, на диск не попадает НИКОГДА
 * @param {Function} opts.report — (phase, text, progress) => void
 * @returns {Promise<Object>} итог: фазы, счётчики, имя схемы отката
 */
async function runPhases(opts) {
    const { sequelize, filePath, privateKeyPem, passphrase } = opts;
    const report = opts.report || (() => {});
    const started = Date.now();
    const result = { switched: false, rollbackSchema: '', shadowSchema: '', tables: {}, totalRows: 0 };

    // ── 0. Заголовок ────────────────────────────────────────────────────────────
    report('header', 'Чтение заголовка копии');
    const info = await inspect(sequelize, filePath);
    if (info.scopeType !== 'full') {
        // Восстановить всю базу из выгрузки ОДНОЙ организации нельзя: в ней нет ни
        // чужих организаций, ни личных и системных таблиц. Молча развернуть такое —
        // значит потерять данные всех остальных клиентов.
        const e = new Error('scope is not full');
        e.errorKey = 'restore_err_scope_not_full';
        throw e;
    }
    result.header = info.header;
    result.mode = info.mode;

    if (info.mode !== 'shadow') {
        // Разрушающий путь: гарантия «живая база не пострадает» теряется. Сюда мы
        // попадаем только если теневое пространство недоступно, и главный процесс уже
        // сделал safety-выгрузку ПРИНУДИТЕЛЬНО (в теневом режиме её можно отключить).
        return await runDestructive(Object.assign({}, opts, { info, result, report, started }));
    }

    // ── 2. Теневое пространство ─────────────────────────────────────────────────
    report('shadow', 'Создание теневого пространства');
    const shadowSchema = await dialect.createShadowSpace(sequelize);
    result.shadowSchema = shadowSchema;

    try {
        await buildAndLoad({ sequelize, filePath, privateKeyPem, passphrase, schema: shadowSchema, info, result, report });

        // ── 7. АТОМАРНОЕ ПЕРЕКЛЮЧЕНИЕ ───────────────────────────────────────────
        report('switch', 'Переключение на восстановленную базу');
        const sw = await dialect.switchToShadow(sequelize, { shadow: shadowSchema });
        result.switched = true;
        result.rollbackSchema = sw.rollbackSchema;
        result.shadowSchema = '';
        report('switch', `Переключение выполнено; прежняя схема сохранена как ${sw.rollbackSchema}`);
    } catch (e) {
        // До переключения живая база НЕ ТРОНУТА — убираем мусор и отдаём ошибку.
        // Именно ради этого состояния и строилось «рядом»: отката не требуется,
        // потому что рушить было нечего.
        if (!result.switched) {
            try { await dialect.dropSchema(sequelize, shadowSchema); result.shadowSchema = ''; }
            catch (e2) { log.warn(`[restoreFull] Теневая схема ${shadowSchema} не удалена: ${e2.message}`); }
        }
        // Признак «переключение уже состоялось» едет ВМЕСТЕ с ошибкой: по нему главный
        // процесс решает, можно ли снимать флаг обслуживания. До переключения живая
        // база цела и флаг снимается; после — нет.
        e.switched = result.switched;
        e.rollbackSchema = result.rollbackSchema;
        throw e;
    }

    result.durationMs = Date.now() - started;
    return result;
}

/**
 * Общая часть обоих путей: структура → данные → внешние ключи → sequences → сверка.
 * @param {Object} p — `{ sequelize, filePath, privateKeyPem, schema, info, result, report }`
 */
async function buildAndLoad(p) {
    const { sequelize, filePath, privateKeyPem, passphrase, schema, info, result, report } = p;

    // ── 3. Структура ИЗ СНИМКА МОДЕЛЕЙ, ЛЕЖАЩЕГО В ДАМПЕ ────────────────────────
    report('structure', 'Чтение снимка структуры из копии');
    const { models: dumpModels } = await readModelsSection(filePath, privateKeyPem, passphrase);
    result.dumpModelCount = dumpModels.length;

    // Целостность файла: снимок должен давать тот же `configHash`, что записан в
    // заголовке. Не совпал — файл повреждён или собран не этим механизмом.
    const snap = modelsHash.modelsSnapshot(dumpModels);
    if (info.header.configHash && snap.configHash !== info.header.configHash) {
        const e = new Error('config hash mismatch');
        e.errorKey = 'restore_err_config_hash';
        e.vars = { expected: String(info.header.configHash).slice(0, 22), actual: String(snap.configHash).slice(0, 22) };
        throw e;
    }

    // Стратегия ссылочной целостности зависит от диалекта — и это единственное место,
    // где различие видно (сама развилка живёт в адаптере, см. `supportsAddForeignKey`).
    //
    // Общая задача одна: строки в файле лежат в порядке ВЫГРУЗКИ, а не в порядке
    // ссылок, поэтому грузить их с включёнными проверками нельзя, а буферизовать всю
    // базу в памяти — тем более. Значит проверки на время загрузки надо снять и
    // включить обратно В КОНЦЕ, с полной проверкой загруженного.
    const deferFk = dialect.supportsAddForeignKey(sequelize);

    report('structure', `Создание структуры: ${dumpModels.length} таблиц`);
    const built = await schemaBuilder.buildSchema(sequelize, dumpModels, {
        schema,
        withoutForeignKeys: deferFk,
        onProgress: (table, prog) => report('structure', table, prog)
    });
    if (built.failed.length) {
        const e = new Error('schema build failed');
        e.errorKey = 'restore_err_schema_build';
        e.vars = { list: built.failed.map(f => `${f.table} (${f.error})`).join('; ') };
        throw e;
    }

    // СВЕРКА СТРУКТУРЫ (ТЗ §6.1 шаг 3).
    //
    // Сверять `configHash` построенной схемы с заголовком бессмысленно: мы строили ПО
    // ТОМУ ЖЕ снимку, значит хэш совпадёт всегда — это тавтология. Настоящий вопрос
    // другой: породил ли СЕГОДНЯШНИЙ фреймворк по этому снимку ТУ ЖЕ ФАКТИЧЕСКУЮ
    // структуру, что была в базе-источнике. На него отвечает `actualHash`.
    //
    // Сравнение осмысленно только в пределах одного диалекта: `VARCHAR(255)` в Postgres
    // и в SQLite — разные физические типы. Восстановление в ДРУГУЮ СУБД поэтому идёт
    // без этой сверки, и это не послабление: там структуру всё равно не с чем сравнить.
    const actual = await modelsHash.actualSchemaHash(sequelize, dumpModels.map(m => m.tableName), { schema });
    result.actualHash = actual.actualHash;
    if (info.header.actualHash && info.header.sourceDialect === dialect.nameOf(sequelize)) {
        if (actual.actualHash !== info.header.actualHash) {
            const e = new Error('actual hash mismatch');
            e.errorKey = 'restore_err_actual_hash';
            e.vars = {
                expected: String(info.header.actualHash).slice(0, 22),
                actual: String(actual.actualHash).slice(0, 22)
            };
            throw e;
        }
        report('structure', 'Структура совпала с копией (actualHash)');
    } else if (!info.header.actualHash) {
        // Копии, снятые до появления журнала версий, отпечатка структуры не несут.
        // Восстановление возможно, но проверить «построили то же самое» нечем —
        // молчать об этом нельзя.
        report('structure', 'ВНИМАНИЕ: копия без отпечатка структуры — сверка невозможна');
    } else {
        report('structure', `Восстановление в другую СУБД (${info.header.sourceDialect} → ${dialect.nameOf(sequelize)}): сверка структуры не применима`);
    }

    // ── 4. Загрузка данных ──────────────────────────────────────────────────────
    report('data', 'Загрузка данных');
    // Там, где ключи уже созданы вместе с таблицами (SQLite), проверки снимаются на
    // время загрузки — ВНЕ транзакции, иначе `PRAGMA` не действует.
    if (!deferFk) await dialect.setForeignKeysEnabled(sequelize, false);
    const loaded = await loadRows({ sequelize, filePath, privateKeyPem, passphrase, schema, dumpModels, report });
    result.tables = loaded.tables;
    result.totalRows = loaded.totalRows;
    result.summary = loaded.summary;

    // ── 5. Внешние ключи С ПРОВЕРКОЙ ────────────────────────────────────────────
    report('constraints', 'Ссылочная целостность: проверка');
    if (deferFk) {
        const fk = await addForeignKeys(sequelize, dumpModels, { schema, report });
        result.foreignKeys = fk.created;
        if (fk.failed.length) {
            const e = new Error('foreign keys failed');
            e.errorKey = 'restore_err_foreign_keys';
            e.vars = { list: fk.failed.map(f => `${f.table}.${f.column} → ${f.target}: ${f.error}`).slice(0, 10).join('; ') };
            throw e;
        }
    } else {
        await dialect.setForeignKeysEnabled(sequelize, true);
        const violations = await dialect.checkForeignKeys(sequelize);
        result.foreignKeys = [];
        if (violations.length) {
            const e = new Error('foreign key violations');
            e.errorKey = 'restore_err_foreign_keys';
            e.vars = {
                list: violations.slice(0, 10)
                    .map(v => `${v.table || v['table']}: строка ${v.rowid}`).join('; ')
            };
            throw e;
        }
        report('constraints', 'Нарушений ссылочной целостности нет');
    }

    // ── 6. sequences ────────────────────────────────────────────────────────────
    // Секция сегодня пуста: первичный ключ строковый и генерится в коде, номера
    // документов считаются как MAX+1. Появится реальный автоинкремент — восстановление
    // обязано выставить счётчик, иначе первая же вставка упадёт с «duplicate key».
    if (loaded.sequences && Object.keys(loaded.sequences).length) {
        report('sequences', `Восстановление счётчиков: ${Object.keys(loaded.sequences).length}`);
        await applySequences(sequelize, loaded.sequences, schema);
    }

    // ── Сверка загруженного с итоговой секцией копии ────────────────────────────
    const mismatch = [];
    for (const [table, s] of Object.entries(loaded.summary || {})) {
        const got = (loaded.tables[table] || 0);
        if (Number(s.rows) !== got) mismatch.push(`${table}: в копии ${s.rows}, загружено ${got}`);
    }
    if (mismatch.length) {
        const e = new Error('row count mismatch');
        e.errorKey = 'restore_err_row_count';
        e.vars = { list: mismatch.slice(0, 10).join('; ') };
        throw e;
    }
    report('data', `Загружено ${loaded.totalRows} строк в ${Object.keys(loaded.tables).length} таблиц`);
}

/**
 * Потоковая загрузка строк из копии.
 *
 * Строки НЕ буферизуются целиком: копится только текущая пачка одной таблицы. В файле
 * они лежат таблица за таблицей, поэтому пачка сбрасывается либо по размеру, либо при
 * смене таблицы.
 */
async function loadRows(p) {
    const { sequelize, filePath, privateKeyPem, passphrase, schema, dumpModels, report } = p;
    const fieldsByTable = new Map(dumpModels.map(m => [m.tableName, serialize.modelFields(m)]));
    const tables = {};
    const pending = [];                 // накопленные операции вставки (см. ниже)
    let summary = {};
    let sequences = {};
    let totalRows = 0;

    let curTable = null;
    let curRows = [];
    const flushQueue = [];

    // Вставка асинхронна, а обработчик строк — синхронный (его зовёт построчный
    // разбор). Поэтому пачки складываются в очередь и выполняются между строками:
    // разбор приостанавливается на `await` ниже, обратное давление сохраняется.
    const enqueueFlush = (table, rows) => { flushQueue.push({ table, rows }); };

    async function drain() {
        while (flushQueue.length) {
            const job = flushQueue.shift();
            const fields = fieldsByTable.get(job.table);
            if (!fields) continue;                    // таблицы нет в снимке — строк не будет
            for (let i = 0; i < job.rows.length; i += INSERT_BATCH) {
                const chunk = job.rows.slice(i, i + INSERT_BATCH).map(r => rowToInsert(r, fields));
                // Набор колонок в пачке общий: берём объединение и подставляем NULL там,
                // где значения нет, — иначе одна строка без необязательного поля разбила
                // бы пачку на отдельные вставки.
                const columns = [...new Set(chunk.flatMap(o => Object.keys(o)))];
                const values = chunk.map(o => columns.map(c => (c in o ? o[c] : null)));
                await dialect.insertBatch(sequelize, { table: job.table, columns, values, schema });
            }
            tables[job.table] = (tables[job.table] || 0) + job.rows.length;
            totalRows += job.rows.length;
            report('data', `${job.table}: ${tables[job.table]}`);
        }
    }

    // Построчный обход: обработчик синхронный, поэтому копим и сбрасываем порциями.
    // `readPayload` отдаёт строки по мере расшифровки, память под контролем.
    await restore.readPayload(filePath, privateKeyPem, (rec) => {
        if (!rec || !rec.kind) return;
        if (rec.kind === 'sequences') { sequences = rec.values || {}; return; }
        if (rec.kind === 'summary') { summary = rec.tables || {}; return; }
        if (rec.kind === 'table') {
            if (curTable && curRows.length) enqueueFlush(curTable, curRows);
            curTable = rec.table; curRows = [];
            if (!(rec.table in tables)) tables[rec.table] = 0;
            return;
        }
        if (rec.kind !== 'row') return;
        if (rec.table !== curTable) {
            if (curTable && curRows.length) enqueueFlush(curTable, curRows);
            curTable = rec.table; curRows = [];
        }
        curRows.push(rec.data);
        if (curRows.length >= INSERT_BATCH) { enqueueFlush(curTable, curRows); curRows = []; }
    }, passphrase, drain);

    if (curTable && curRows.length) enqueueFlush(curTable, curRows);
    await drain();

    return { tables, totalRows, summary, sequences };
}

/**
 * Значения строки дампа → значения для вставки, по типам из снимка В ДАМПЕ.
 *
 * Именно из дампа, а не из актуальных моделей: иначе значение старой копии приведётся
 * к типу, которого на момент её снятия не существовало.
 */
function rowToInsert(row, fields) {
    const out = {};
    for (const [name, def] of Object.entries(fields)) {
        if (name in row) out[name] = serialize.fromDump(row[name], def);
    }
    return out;
}

/**
 * Навесить внешние ключи после загрузки данных — это и есть «включить проверку в конце».
 *
 * Имя ограничения НЕ задаём: PostgreSQL сам назовёт его `<таблица>_<колонка>_fkey` —
 * ровно так же, как назвал бы `sync()`. Иначе следующая же штатная миграция решила бы,
 * что ограничения нет, и создала второе.
 */
async function addForeignKeys(sequelize, models, opts = {}) {
    const q = dialect.quoter(sequelize);
    const schema = opts.schema;
    const report = opts.report || (() => {});
    const known = new Set(models.map(m => m.tableName));
    const byName = new Map(models.map(m => [m.name, m.tableName]));
    const created = [];
    const failed = [];

    for (const m of models) {
        for (const [column, def] of Object.entries(m.fields || {})) {
            const ref = def && def.references;
            if (!ref) continue;
            let target = ref.model || ref.table;
            if (typeof target !== 'string') target = target && target.tableName;
            if (!target) continue;
            if (!known.has(target) && byName.has(target)) target = byName.get(target);
            if (!known.has(target)) continue;

            const key = ref.key || 'UID';
            const onDelete = def.onDelete ? ` ON DELETE ${String(def.onDelete).toUpperCase()}` : '';
            const onUpdate = def.onUpdate ? ` ON UPDATE ${String(def.onUpdate).toUpperCase()}` : '';
            const sql = `ALTER TABLE ${dialect.qualify(q, m.tableName, schema)}`
                + ` ADD FOREIGN KEY (${q(column)})`
                + ` REFERENCES ${dialect.qualify(q, target, schema)} (${q(key)})${onDelete}${onUpdate}`;
            try {
                await sequelize.query(sql);
                created.push(`${m.tableName}.${column}`);
            } catch (e) {
                failed.push({ table: m.tableName, column, target, error: e.message });
            }
        }
    }
    report('constraints', `Внешних ключей создано: ${created.length}` + (failed.length ? `, отказов: ${failed.length}` : ''));
    return { created, failed };
}

/** Выставить значения последовательностей (секция `sequences`). */
async function applySequences(sequelize, values, schema) {
    if (dialect.nameOf(sequelize) !== 'postgres') return 0;
    let n = 0;
    for (const [name, value] of Object.entries(values || {})) {
        const qualified = schema ? `${schema}.${name}` : name;
        try {
            await sequelize.query(`SELECT setval(:seq, :val)`, { replacements: { seq: qualified, val: Number(value) || 1 } });
            n++;
        } catch (e) {
            log.warn(`[restoreFull] Счётчик ${qualified} не выставлен: ${e.message}`);
        }
    }
    return n;
}

// ── Разрушающий путь (теневое пространство недоступно) ───────────────────────────

/**
 * «Очистить и залить» — запасной путь, когда создать схему нельзя (ТЗ §6.1а).
 *
 * Гарантия «живая база не пострадает» здесь ТЕРЯЕТСЯ: отката переименованием нет,
 * возврат возможен только разворачиванием safety-выгрузки. Поэтому safety-выгрузка в
 * этом режиме принудительна (её обеспечивает главный процесс), диалог подтверждения
 * прямо говорит о необратимости, а файловый флаг остаётся единственной защитой — его
 * роль здесь возрастает.
 */
async function runDestructive(p) {
    const { sequelize, filePath, privateKeyPem, passphrase, info, result, report, started } = p;
    report('destructive', 'Теневое пространство недоступно — разрушающий путь');

    const { models: dumpModels } = await readModelsSection(filePath, privateKeyPem, passphrase);
    const q = dialect.quoter(sequelize);

    // Удаляем ТОЛЬКО известные таблицы, и в обратном порядке ссылок. Объекты вне
    // моделей (вьюхи, чужие таблицы) не наши — трогать их мы не вправе, о них
    // предупреждает выгрузка (§0).
    report('destructive', 'Удаление существующих таблиц');
    const { order } = dialect.topoOrder(dumpModels, dumpModels.map(m => m.tableName));
    for (const table of [...order].reverse()) {
        try { await sequelize.query(`DROP TABLE IF EXISTS ${q(table)} CASCADE`); }
        catch (e) { log.warn(`[restoreFull] ${table}: ${e.message}`); }
    }

    await buildAndLoad({ sequelize, filePath, privateKeyPem, passphrase, schema: null, info, result, report });

    // Переключаться некуда: мы уже в живой схеме. Отката нет — только safety-выгрузка.
    result.switched = true;
    result.rollbackSchema = '';
    result.durationMs = Date.now() - started;
    report('destructive', 'Разрушающий путь завершён');
    return result;
}

module.exports = {
    inspect, runPhases, readModelsSection, addForeignKeys, loadRows, INSERT_BATCH
};
