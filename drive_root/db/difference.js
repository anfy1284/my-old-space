'use strict';

/**
 * difference.js — ДОКУМЕНТ-КОРРЕКЦИЯ: зеркальная табличная часть и расчёт разницы.
 * Механизм ЯДРА, цепляемый к любому документу с табличной частью.
 *
 * Зачем. Выставленный документ исправлять нельзя (GoBD). Полная отмена — сторно
 * (`storno.js`). Частичное изменение — коррекция: исходный документ остаётся
 * действующим, а встречный несёт ТОЛЬКО разницу (§ 31 Abs. 5 UStDV: «Es müssen nur
 * die fehlenden oder unzutreffenden Angaben durch ein Dokument, das spezifisch und
 * eindeutig auf die Rechnung bezogen ist, übermittelt werden»).
 *
 * Пользователь при этом не считает разницу в уме: он правит КОПИЮ строк документа
 * («как должно быть»), а разницу считает ядро. Значит, у коррекции две строковые
 * части: зеркальная (правится) и собственная (разница, печатается). Вторую часть
 * приложению объявлять не надо — ядро синтезирует её из первой, ровно как
 * `entityNumber`/`entityDate` синтезируют реквизиты сущности.
 *
 * Объявление — в `entityConfig.correction.difference` документа:
 *
 *   "correction": {
 *     "link": "correctsInvoiceId",
 *     "kindField": "correctionKind",
 *     "kindValue": "correction",
 *     "difference": {
 *       "section":       "invoice_lines",          // ТЧ, которая несёт разницу
 *       "targetTable":   "invoice_target_lines",   // зеркальная ТЧ — СОЗДАЁТ ЯДРО
 *       "targetCaption": { "i18n": "invoice_target_lines_tab" },
 *       "matchBy":  ["serviceId", "taxRate", "unitPrice"],  // что делает строки «одной позицией»
 *       "quantity": "quantity",
 *       "price":    "unitPrice",
 *       "amount":   "amount",
 *       "order":    "sortOrder"
 *     }
 *   }
 *
 * Прикладного знания здесь ровно столько, сколько в этом объявлении: КАКИЕ поля
 * делают строки одной позицией и в каких лежат количество, цена и сумма. Всё
 * остальное — сопоставление, действующее состояние, знаки, свёртка — одинаково для
 * любого документа и живёт в ядре.
 *
 * Вызывается из ЧЕТЫРЁХ мест (логика — одна, здесь):
 *   1. Миграция: корневой `events_handler.js` → `onModelsPostCollect` (создаёт таблицу).
 *   2. Рантайм:  `globalServerContext.collectAllModelDefs` (модель знает о части).
 *   3. Создание встречного документа: `storno.js` (заполняет зеркальную часть).
 *   4. Сохранение формы: `apps/uniForm/server.js` (пересчитывает разницу).
 */

// Деньги приходят из базы СТРОКОЙ (DECIMAL) и считаются в целых центах.
// `M.num` служит заодно округлением количества до двух знаков.
const M = require('./money');

const DEFAULTS = {
    quantity: 'quantity',
    price:    'unitPrice',
    amount:   'amount',
    order:    'sortOrder'
};

/** Объявление разницы у документа, или null. */
function readConfig(defOrModel) {
    const ec = defOrModel && defOrModel.entityConfig;
    const corr = ec && ec.correction;
    const diff = corr && corr.difference;
    if (!diff || !diff.section || !diff.targetTable) return null;
    return Object.assign({}, DEFAULTS, diff, {
        matchBy: Array.isArray(diff.matchBy) ? diff.matchBy : []
    });
}

// ── 1. Синтез зеркальной табличной части ─────────────────────────────────────

/**
 * Создаёт определение зеркальной ТЧ «как должно быть» — копию исходной ТЧ под
 * другим именем таблицы. Приложение объявляет ОДНУ строковую часть; вторая
 * появляется отсюда, потому что она не несёт прикладного смысла: это та же
 * структура, но в роли «желаемого состояния».
 *
 * Идемпотентна: если приложение объявило зеркальную часть само (нужны свои поля),
 * ядро её не трогает.
 *
 * @param {Array} defs — все определения моделей (мутируется in-place)
 * @returns {number} сколько частей синтезировано
 */
function injectTargetSections(defs) {
    if (!Array.isArray(defs)) return 0;
    const byTable = new Map();
    for (const d of defs) if (d && d.tableName) byTable.set(d.tableName, d);

    let made = 0;
    for (const doc of defs.slice()) {
        const cfg = readConfig(doc);
        if (!cfg) continue;
        if (byTable.has(cfg.targetTable)) continue;         // объявлена вручную — уважаем

        const src = byTable.get(cfg.section);
        if (!src) {
            console.warn(`[difference] ТЧ "${cfg.section}" документа "${doc.tableName}" не найдена — зеркальная часть не создана`);
            continue;
        }

        const mirror = JSON.parse(JSON.stringify(src));
        mirror.tableName = cfg.targetTable;
        // Имя модели выводим из имени таблицы: «invoice_target_lines» →
        // «InvoiceTargetLines». Второго источника имени нет — иначе приложение
        // обязали бы придумать его и держать в согласии с таблицей.
        mirror.name = cfg.targetTable.split(/[_\s]+/)
            .map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
        if (mirror.tabularSection) {
            mirror.tabularSection = Object.assign({}, mirror.tabularSection);
            if (cfg.targetCaption) mirror.tabularSection.caption = cfg.targetCaption;
        }
        // Зеркальная часть — рабочая копия, а не содержание документа: в архив,
        // в печать и в отчёты идёт разница. Поэтому у неё нет собственной
        // инверсии знаков при сторно.
        mirror.entityConfig = {};

        defs.push(mirror);
        byTable.set(mirror.tableName, mirror);
        made++;
    }
    return made;
}

/**
 * Карта переноса ТЧ для `storno.js`: строки исходного документа ложатся в
 * ЗЕРКАЛЬНУЮ часть коррекции («как должно быть»), а собственная часть остаётся
 * пустой — её заполнит расчёт разницы.
 */
function sectionMapFor(Model) {
    const cfg = readConfig(Model);
    if (!cfg) return null;
    return { [cfg.section]: cfg.targetTable };
}

// ── 2. Сопоставление строк ───────────────────────────────────────────────────

/**
 * Ключ, по которому строка «как должно быть» узнаёт себя в уже выставленном.
 *
 * Состав объявляет приложение (`matchBy`) — и цена за единицу входить в него
 * ОБЯЗАНА, если позиция может продаваться по разной цене (возрастные полосы одной
 * услуги): иначе разные цены схлопнутся в одну позицию и разница посчитается не по
 * той цене. Подпись строки в ключ не входит никогда: правка текста — это правка
 * текста, а не замена позиции.
 */
function rowKey(row, cfg) {
    const parts = [];
    for (const f of cfg.matchBy) {
        const v = row[f];
        // Число и его строковая запись из DECIMAL — одно и то же значение
        // ('7.00' и 7): ключ обязан их отождествить, иначе строка не найдёт себя.
        parts.push(v === null || v === undefined ? ''
            : (isFinite(v) && v !== '' ? String(Number(v)) : String(v)));
    }
    return parts.join('|');
}

/** Свёртка строк в «одна позиция — одна строка» с суммированием количества и суммы. */
function collapse(rows, cfg) {
    const byKey = new Map();
    for (const r of rows) {
        const key = rowKey(r, cfg);
        const g = byKey.get(key);
        if (!g) { byKey.set(key, Object.assign({}, r)); continue; }
        g[cfg.quantity] = M.num((Number(g[cfg.quantity]) || 0) + (Number(r[cfg.quantity]) || 0));
        g[cfg.amount] = M.add(g[cfg.amount], r[cfg.amount]);
    }
    // Позиция, снятая коррекциями в ноль, в состоянии не участвует — иначе
    // следующая коррекция увидела бы её как существующую строку.
    return [...byKey.values()].filter(r => (Number(r[cfg.quantity]) || 0) !== 0);
}

/**
 * ДЕЙСТВУЮЩЕЕ состояние документа: что причитается по нему СЕЙЧАС — строки самого
 * документа плюс строки всех его ВЫСТАВЛЕННЫХ коррекций.
 *
 * Черновики не в счёт: документ, не покинувший сферу выставителя, ничего не меняет.
 * Считать очередную коррекцию от исходных строк нельзя — вторая повторно сняла бы
 * то, что сняла первая.
 *
 * @param {Object} globalCtx — globalServerContext (модели)
 * @param {string} table     — таблица документа
 * @param {string} docUID    — исходный документ
 * @param {string} [exceptUID] — коррекция, которую не учитывать (та, что считается)
 */
async function effectiveRows(globalCtx, table, docUID, exceptUID) {
    const Model = modelFor(globalCtx, table);
    const cfg = readConfig(Model);
    if (!cfg) return [];
    const corrCfg = Model.entityConfig.correction;
    const immCfg = require('./immutable').readConfig(Model);

    const Section = modelFor(globalCtx, cfg.section);
    const parentField = Section.tabularSection.parentField;

    const own = await Section.findAll({
        where: { [parentField]: docUID }, order: [[cfg.order, 'ASC']], raw: true
    });
    const rows = own.slice();

    const where = { [corrCfg.link]: docUID };
    if (corrCfg.kindField) where[corrCfg.kindField] = corrCfg.kindValue || 'correction';
    const corrections = await Model.findAll({ where, raw: true });
    for (const c of corrections) {
        if (exceptUID && c.UID === exceptUID) continue;
        // «Выставлен» — это состояние из `immutable.when`, второго определения
        // выставленности в системе нет.
        if (immCfg && immCfg.when.indexOf(c[immCfg.field]) === -1) continue;
        const part = await Section.findAll({
            where: { [parentField]: c.UID }, order: [[cfg.order, 'ASC']], raw: true
        });
        rows.push(...part);
    }
    return collapse(rows, cfg);
}

/**
 * Разница: «как должно быть» минус «что уже выставлено».
 *
 * Позиции без изменений в документ не попадают — печатать «0 × 67,00» незачем.
 * Позиция, которой в «как должно быть» больше нет, снимается целиком.
 */
function diffRows(targetRows, effective, cfg, newUID) {
    const effByKey = new Map();
    for (const r of effective) effByKey.set(rowKey(r, cfg), r);

    const out = [];
    const seen = new Set();
    for (const t of targetRows) {
        const key = rowKey(t, cfg);
        seen.add(key);
        const e = effByKey.get(key);
        const d = M.num((Number(t[cfg.quantity]) || 0) - (e ? (Number(e[cfg.quantity]) || 0) : 0));
        if (d === 0) continue;
        out.push(Object.assign({}, t, {
            UID: newUID(),
            [cfg.quantity]: d,
            [cfg.amount]: M.mul(t[cfg.price], d)
        }));
    }
    for (const e of effective) {
        if (seen.has(rowKey(e, cfg))) continue;
        const q = Number(e[cfg.quantity]) || 0;
        if (q === 0) continue;
        out.push(Object.assign({}, e, {
            UID: newUID(),
            [cfg.quantity]: -q,
            [cfg.amount]: M.mul(e[cfg.price], -q)
        }));
    }
    out.forEach((r, i) => { r[cfg.order] = i + 1; });
    return out;
}

// ── 3. Точки применения ──────────────────────────────────────────────────────

function modelFor(globalCtx, table) {
    const name = globalCtx.getModelNameForTable(table);
    const M2 = name ? globalCtx.modelsDB[name] : null;
    if (!M2) throw new Error(`[difference] модель для таблицы "${table}" не найдена`);
    return M2;
}

/** Является ли документ коррекцией. */
function isCorrection(Model, row) {
    const corr = Model && Model.entityConfig && Model.entityConfig.correction;
    if (!corr || !row) return false;
    if (corr.kindField) return row[corr.kindField] === (corr.kindValue || 'correction');
    return !!row[corr.link];
}

/**
 * Встречный документ создан — привести его строковые части в порядок.
 * Зовётся из `storno.js` для ОБОИХ видов, прикладного хука для этого не нужно.
 *
 * • Коррекция: «как должно быть» = действующее состояние исходного документа.
 *   Ядро `storno.js` положило туда исходные строки — для первой коррекции это то
 *   же самое, но для второй уже нет.
 * • Сторно: если у документа есть коррекции, отменять надо действующее состояние,
 *   а не исходные строки, — иначе вернётся больше, чем причитается.
 */
async function onCounterCreated({ globalCtx, dbGateway, table, sourceUID, newUID, kind, context }) {
    const Model = modelFor(globalCtx, table);
    const cfg = readConfig(Model);
    if (!cfg) return;

    const effective = await effectiveRows(globalCtx, table, sourceUID, newUID);
    const Section = modelFor(globalCtx, cfg.section);
    const parentField = Section.tabularSection.parentField;
    const Utilities = require('./utilites');

    if (kind === 'correction') {
        const Target = modelFor(globalCtx, cfg.targetTable);
        await rewrite(dbGateway, cfg.targetTable, parentField, newUID, effective,
            () => Utilities.generateUID(Target.name), cfg, context);
        return;
    }

    // Сторно: строки уже инвертированы ядром из ИСХОДНЫХ. Пересобирать нужно,
    // только если состояние успели изменить коррекциями.
    const corrCfg = Model.entityConfig.correction;
    const where = { [corrCfg.link]: sourceUID };
    if (corrCfg.kindField) where[corrCfg.kindField] = corrCfg.kindValue || 'correction';
    if (await Model.count({ where }) === 0) return;

    const negated = effective.map(r => {
        const q = Number(r[cfg.quantity]) || 0;
        return Object.assign({}, r, { [cfg.quantity]: -q, [cfg.amount]: M.mul(r[cfg.price], -q) });
    });
    await rewrite(dbGateway, cfg.section, parentField, newUID, negated,
        () => Utilities.generateUID(Section.name), cfg, context);
}

/** Перезаписать табличную часть документа готовыми строками. */
async function rewrite(dbGateway, table, parentField, parentUID, rows, newUID, cfg, context) {
    await dbGateway.execute({
        operation: 'delete', table, where: { [parentField]: parentUID }, context
    });
    let order = 0;
    for (const row of rows) {
        const data = Object.assign({}, row, {
            UID: newUID(), [parentField]: parentUID, [cfg.order]: ++order
        });
        delete data.createdAt; delete data.updatedAt;
        await dbGateway.execute({ operation: 'create', table, data, context });
    }
}

/**
 * Сохранение формы: подменить собственную ТЧ коррекции пересчитанной разницей.
 *
 * Зовётся ядром (`apps/uniForm/server.js`) ДО прикладного `onBeforeSave` и до
 * записи: пользователь правит «как должно быть», а в базу и в печать уходит
 * разница. Считает СЕРВЕР — знак и сумма разницы это то место, где ручная
 * арифметика ошибается тише всего.
 *
 * @returns {boolean} была ли подмена
 */
async function recalcOnSave({ globalCtx, table, changes, tabularSections, parentUID, sessionID }) {
    if (!tabularSections) return false;
    let Model;
    try { Model = modelFor(globalCtx, table); } catch (e) { return false; }
    const cfg = readConfig(Model);
    if (!cfg || !tabularSections[cfg.targetTable]) return false;

    const corrCfg = Model.entityConfig.correction;

    // Природа документа берётся ИЗ БАЗЫ, а не из `changes`.
    //
    // Форма присылает то, что показано на экране: у поля-ссылки это может быть
    // объект `{UID, display}` или отображаемое имя, а не голый UID. Ссылку на
    // исходный документ форма и не вправе менять (её ставит команда), поэтому
    // доверять ей нечего. Цена ошибки здесь высокая и МОЛЧАЛИВАЯ: с неверным
    // `sourceUID` действующее состояние выходит пустым, разницей становится весь
    // целевой состав, и коррекция печатается как новый счёт по новым данным —
    // ровно то, что она не должна делать.
    const docUID = parentUID || (changes && changes.UID);
    if (!docUID) return false;
    const stored = await Model.findByPk(docUID, { raw: true });
    if (!stored || !isCorrection(Model, stored)) return false;
    const sourceUID = stored[corrCfg.link];
    if (!sourceUID) return false;

    // Исходный документ обязан существовать. Если его нет — считать не от чего, и
    // молча выдать «разницу», равную всему составу, нельзя: это уйдёт клиенту
    // как счёт.
    const source = await Model.findByPk(sourceUID, { raw: true });
    if (!source) {
        throw new Error(`[difference] исходный документ ${sourceUID} не найден: разницу считать не от чего`);
    }

    const effective = await effectiveRows(globalCtx, table, sourceUID, docUID);
    const Utilities = require('./utilites');
    const Section = modelFor(globalCtx, cfg.section);
    const diff = diffRows(tabularSections[cfg.targetTable], effective, cfg,
        () => Utilities.generateUID(Section.name));

    const parentField = Section.tabularSection.parentField;
    for (const r of diff) r[parentField] = docUID;
    tabularSections[cfg.section] = diff;
    return true;
}

module.exports = {
    readConfig,
    injectTargetSections,
    sectionMapFor,
    isCorrection,
    rowKey,
    collapse,
    effectiveRows,
    diffRows,
    onCounterCreated,
    recalcOnSave
};
