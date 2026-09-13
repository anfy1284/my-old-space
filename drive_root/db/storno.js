'use strict';

/**
 * storno.js — ВСТРЕЧНЫЙ ДОКУМЕНТ. Механизм ЯДРА, цепляемый к любому документу.
 *
 * Выставленный документ исправлять нельзя (GoBD, см. `immutable.js`). Законный
 * способ изменить его действие — отдельный документ, который на него ссылается.
 * Видов таких документов ДВА, и они различаются не кодом, а объявлением:
 *
 *   • сторно (`entityConfig.storno`) — полная отмена: копия с обратными знаками,
 *     исходный документ уходит в «отменён», когда сторно ВЫСТАВЛЕН;
 *   • коррекция (`entityConfig.correction`) — частичное изменение: исходный
 *     документ ОСТАЁТСЯ действующим, а встречный несёт только разницу
 *     (§ 31 Abs. 5 UStDV: передаются лишь изменившиеся данные документом,
 *     однозначно привязанным к исходному счёту).
 *
 * ── Жизненный цикл (переделан 13.09.2026) ────────────────────────────────────
 * Команда «Сторнировать»/«Скорректировать» НИЧЕГО НЕ ПИШЕТ. Раньше она сразу
 * создавала документ в базе: пользователь передумал — а черновик уже лежит, номер
 * занят (удаление даёт дыру в нумерации), и брошенный черновик сторно блокировал
 * повторное сторно. Теперь (решение владельца: «открывшийся документ уже в базе —
 * так быть не должно»):
 *
 *   1. `prepareCounter` — собирает шапку и строки В ПАМЯТИ и проверяет отказы;
 *      форма открывается НЕСОХРАНЁННОЙ (как «создать на основании»).
 *   2. Сохранение формы (`uniForm.applyChanges`): `verifyCounter` проверяет всё
 *      заново (между открытием и сохранением документ могли сторнировать), а
 *      `stampCounter` ставит ссылку и вид — ТОЛЬКО ядро: с формы им не верят.
 *   3. Выставление сторно (любым путём) → `dbGateway`-middleware зовёт
 *      `issuingStornos`/`cancelSourcesOf`: исходный документ уходит в «отменён»
 *      ровно в этот момент. Сорвалось выставление — исходный остался действующим.
 *
 * Прикладному коду остаётся объявление в `db.json`:
 *
 *     "entityConfig": {
 *       "storno": {
 *         "link":         "correctsInvoiceId",   // поле встречного документа → исходный
 *         "kindField":    "correctionKind",      // поле «вид встречного документа»
 *         "kindValue":    "storno",              // значение этого поля
 *         "cancelStatus": "cancelled",           // статус, в который уходит исходный
 *         "negate":       ["prepayment"],        // поля документа с инверсией знака
 *         "copyExclude":  ["status", "issuedAt"],// поля, которые не копируются
 *         "hook":         "invoice.onStorno"     // необязательный прикладной хук
 *       },
 *       "correction": {
 *         "link":      "correctsInvoiceId",
 *         "kindField": "correctionKind",
 *         "kindValue": "correction",
 *         "difference": { "section": "invoice_lines", … }   // см. db/difference.js
 *       }
 *     }
 *
 *   Каждая табличная часть — свой список инвертируемых полей:
 *     "entityConfig": { "storno": { "negate": ["quantity", "amount"] } }
 *
 * Прикладной хук получает `{ table, sourceUID, source, head, sections, kind }` и
 * правит `head`/`sections` ПО ССЫЛКЕ — в базе ещё ничего нет.
 *
 * `kindField` обязателен, когда у документа объявлены ОБА вида: без него
 * проверка «документ уже сторнирован» считала бы сторно и коррекции вместе и
 * отказывала бы в сторно скорректированного документа чужим текстом.
 *
 * `sectionMap` переносит строки исходного документа в ДРУГУЮ табличную часть
 * встречного. Коррекции это нужно: пользователь правит копию исходных строк
 * («как должно быть»), а собственные строки документа несут разницу. Задавать
 * карту руками не требуется — её выводит объявление разницы
 * (`entityConfig.correction.difference`, см. `drive_root/db/difference.js`).
 *
 * Что НЕ копируется никогда: `UID`, `number`, `date`, `name`, `createdAt`,
 * `updatedAt` — номер и дата у встречного документа свои (их проставят
 * автонумерация и `documentDate` при СОЗДАНИИ), представление пересоберёт
 * `applyPresentation`.
 */

const NEVER_COPY = ['UID', 'number', 'date', 'name', 'createdAt', 'updatedAt'];
const KINDS = ['storno', 'correction'];

class StornoError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'StornoError';
        this.code = code || 'STORNO_REFUSED';
        this.userMessage = message;
    }
}

/**
 * Текст отказа на языке сессии. `t` — асинхронный переводчик `(key) => Promise`
 * (обёртка над `tForSession`); ключа нет — берётся запасной текст.
 * Без этого отказы уходили пользователю по-русски посреди немецкого интерфейса.
 */
async function say(t, key, fallback) {
    try {
        const v = t ? await t(key) : null;
        if (v && v !== key) return v;
    } catch (e) { /* перевода нет */ }
    return fallback;
}

function stornoConfig(Model) {
    return (Model && Model.entityConfig && Model.entityConfig.storno) || null;
}

/** Объявление встречного документа выбранного вида ('storno' | 'correction'). */
function counterConfig(Model, kind) {
    const ec = Model && Model.entityConfig;
    return (ec && ec[kind === 'correction' ? 'correction' : 'storno']) || null;
}

function modelFor(table) {
    const globalCtx = require('../globalServerContext');
    const name = globalCtx.getModelNameForTable(table);
    return name ? globalCtx.modelsDB[name] : null;
}

/**
 * Инвертирует знак значения.
 *
 * DECIMAL приезжает из драйвера СТРОКОЙ ('100.00'), и знак у неё переставляется
 * текстом — без промежуточного float и без округления. Через `money` этого
 * делать нельзя: инвертировать приходится не только суммы, но и количества
 * (`quantity` — FLOAT), а денежный модуль округлил бы их до двух знаков.
 */
function negateValue(v) {
    if (v === null || v === undefined || v === '') return v;
    // `-0` в базе ни к чему, и в печати он даёт «−0,00»: ноль остаётся нулём.
    if (typeof v === 'number') return v === 0 ? 0 : -v;

    const s = String(v).trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) return v;   // не число — не наше дело
    if (s === '0' || /^-?0(\.0+)?$/.test(s)) return v;  // «минус ноль» в базе ни к чему
    return s.charAt(0) === '-' ? s.slice(1) : '-' + s;
}

/** Копия строки: убирает служебные поля, инвертирует объявленные. */
function copyRow(Model, row, cfg, extra) {
    const attrs = Model.rawAttributes || {};
    const negate = (cfg && Array.isArray(cfg.negate)) ? cfg.negate : [];
    const exclude = NEVER_COPY.concat((cfg && Array.isArray(cfg.copyExclude)) ? cfg.copyExclude : []);

    const out = {};
    for (const key of Object.keys(attrs)) {
        if (exclude.indexOf(key) !== -1) continue;
        if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
        out[key] = negate.indexOf(key) !== -1 ? negateValue(row[key]) : row[key];
    }
    return Object.assign(out, extra || {});
}

/** Табличные части документа: определения моделей, ссылающихся на него как на владельца. */
function sectionsOf(globalCtx, parentTable) {
    const out = [];
    const models = globalCtx.modelsDB || {};
    for (const name of Object.keys(models)) {
        const M = models[name];
        const ts = M && M.tabularSection;
        if (ts && ts.parentTable === parentTable && ts.parentField) {
            out.push({ Model: M, parentField: ts.parentField });
        }
    }
    return out;
}

/** Исходный документ — ЧЕРЕЗ `dbGateway` с сессией: чужой документ RLS не отдаст. */
async function loadSource(table, UID, context) {
    const dbGateway = require('../dbGateway');
    return await dbGateway.execute({
        operation: 'findByPk', table, where: { UID }, options: { raw: true }, context
    });
}

/**
 * Можно ли оформить встречный документ вида `kind` к `source`. Бросает `StornoError`.
 * Одни и те же проверки — при открытии формы и при её сохранении.
 */
async function checkAllowed(Model, source, kind, t) {
    const isCorrection = kind === 'correction';
    const cfg = counterConfig(Model, kind);
    if (!cfg || !cfg.link) {
        throw new StornoError(await say(t,
            isCorrection ? 'correction_refuse_not_declared' : 'storno_refuse_not_declared',
            'Для этого документа встречный документ не объявлен'), 'STORNO_NOT_DECLARED');
    }
    if (!source) throw new StornoError(await say(t, 'storno_refuse_no_target', 'Документ не найден'), 'STORNO_NO_TARGET');
    const UID = source.UID;

    // Встречный документ на встречный документ — бессмыслица: и отмена, и
    // коррекция относятся к ИСХОДНОМУ документу, он и так остался в базе.
    if (source[cfg.link]) {
        throw new StornoError(await say(t,
            isCorrection ? 'correction_refuse_of_counter' : 'storno_refuse_of_storno',
            'Встречный документ нельзя сторнировать или корректировать'), 'STORNO_OF_STORNO');
    }
    // Дважды сторнировать один документ нельзя: у отменённого документа больше
    // нет действия, которое можно отменить. Коррекций, наоборот, может быть
    // сколько угодно — каждая меняет уже скорректированное состояние. Поэтому
    // считаем только СТОРНО: без фильтра по виду ранее сделанная коррекция
    // блокировала бы отмену чужим по смыслу текстом «уже сторнирован».
    // «Уже сторнирован» = есть встречный документ, который НЕ коррекция (в том
    // числе сохранённый черновик сторно: второй параллельный сторно не нужен).
    //
    // Именно так, а не «вид = сторно»: поле вида появилось позже самого сторно,
    // и у документов, сторнированных ДО его появления, оно пустое. Значение вида
    // коррекции берём из её объявления, а не литералом.
    const correctionKindValue = (counterConfig(Model, 'correction') || {}).kindValue || 'correction';
    const alreadyWhere = { [cfg.link]: UID };
    if (cfg.kindField) {
        const { Op } = require('sequelize');
        alreadyWhere[cfg.kindField] = {
            [Op.or]: [{ [Op.ne]: correctionKindValue }, { [Op.is]: null }]
        };
    }
    if (!isCorrection) {
        const already = await Model.count({ where: alreadyWhere });
        if (already > 0) {
            throw new StornoError(await say(t, 'storno_refuse_already', 'Документ уже сторнирован'), 'STORNO_ALREADY');
        }
    } else if (cfg.kindField) {
        // Отменённый документ корректировать нечего: его действие уже снято
        // целиком, разницу считать не от чего.
        const stornoed = await Model.count({ where: alreadyWhere });
        if (stornoed > 0) {
            throw new StornoError(await say(t, 'correction_refuse_stornoed', 'Документ сторнирован — корректировать нечего'), 'STORNO_ALREADY');
        }
    }
    // Черновик сторнировать нечего — он не покидал сферу выставителя,
    // его правят или удаляют.
    const immCfg = require('./immutable').readConfig(Model);
    if (immCfg) {
        const state = source[immCfg.field];
        if (immCfg.when.indexOf(state) === -1) {
            throw new StornoError(await say(t,
                isCorrection ? 'correction_refuse_not_issued' : 'storno_refuse_not_issued',
                'Встречный документ можно сделать только к выставленному документу'), 'STORNO_NOT_ISSUED');
        }
        const cancelStatus = cfg.cancelStatus || (stornoConfig(Model) || {}).cancelStatus;
        if (cancelStatus && state === cancelStatus) {
            throw new StornoError(await say(t, 'storno_refuse_cancelled', 'Документ уже отменён'), 'STORNO_ALREADY');
        }
        // Недействительный документ («Ungültig», `invalidate.js`) не действует вовсе:
        // отменять и корректировать в нём нечего.
        const invalidCfg = require('./invalidate').configOf(Model);
        if (invalidCfg && state === invalidCfg.status) {
            throw new StornoError(await say(t, 'storno_refuse_invalidated',
                'Документ признан недействительным — отменять и корректировать нечего'), 'STORNO_ALREADY');
        }
    }
    return cfg;
}

/** Строка для формы: без служебных полей и без ссылки на владельца (её ставит сохранение). */
function formRow(TargetModel, row, secCfg, parentField) {
    const data = copyRow(TargetModel, row, secCfg, null);
    delete data[parentField];
    return data;
}

/**
 * Собрать встречный документ В ПАМЯТИ — для несохранённой формы.
 *
 * @param {Object} opts — { table, UID, kind: 'storno'|'correction', context: { sessionID }, t }
 * @returns {Promise<{prefill: Object, prefillTabular: Object, counterOf: {kind, sourceUID}}>}
 */
async function prepareCounter(opts) {
    const { table, UID, context = {}, t = null } = opts || {};
    const kind = opts && opts.kind === 'correction' ? 'correction' : 'storno';
    const isCorrection = kind === 'correction';
    if (!table || !UID) throw new StornoError(await say(t, 'storno_refuse_no_target', 'Документ не найден'), 'STORNO_NO_TARGET');

    const globalCtx = require('../globalServerContext');
    const Model = modelFor(table);
    if (!Model) throw new StornoError(await say(t, 'storno_refuse_no_model', `Модель для таблицы "${table}" не найдена`), 'STORNO_NO_MODEL');

    const source = await loadSource(table, UID, context);
    const cfg = await checkAllowed(Model, source, kind, t);
    const immCfg = require('./immutable').readConfig(Model);

    // ── Шапка ─────────────────────────────────────────────────────────────
    // Ссылка и вид кладутся в шапку ради ПОКАЗА (подпись «Storno zu …», вкладка
    // «как должно быть» по `visibleWhen`). В базу их запишет не форма, а
    // `stampCounter` — по проверенному `counterOf`.
    const extra = { [cfg.link]: UID };
    if (cfg.kindField) extra[cfg.kindField] = cfg.kindValue || kind;
    const head = copyRow(Model, source, cfg, extra);
    // Встречный документ рождается черновиком: выставляет его пользователь тем же
    // путём, что и обычный документ, — чтобы отработали архив, проверка и журнал.
    if (immCfg && head[immCfg.field] === undefined) {
        head[immCfg.field] = Model.rawAttributes[immCfg.field]
            && Model.rawAttributes[immCfg.field].defaultValue;
    }

    // ── Табличные части ───────────────────────────────────────────────────
    const difference = require('./difference');
    const sectionMap = Object.assign({}, (isCorrection ? difference.sectionMapFor(Model) : null) || {},
                                     (cfg && cfg.sectionMap) || {});
    const sections = {};
    const parentFieldOf = {};
    for (const sec of sectionsOf(globalCtx, table)) {
        const targetTable = Object.prototype.hasOwnProperty.call(sectionMap, sec.Model.tableName)
            ? sectionMap[sec.Model.tableName] : sec.Model.tableName;
        // Явный null в карте — «эту часть не переносить вовсе».
        if (!targetTable) continue;
        const TargetModel = modelFor(targetTable);
        if (!TargetModel) {
            throw new StornoError(`sectionMap: таблица "${targetTable}" не найдена`, 'STORNO_NO_MODEL');
        }
        const targetParentField = (TargetModel.tabularSection && TargetModel.tabularSection.parentField)
            || sec.parentField;
        parentFieldOf[targetTable] = targetParentField;
        const secCfg = counterConfig(sec.Model, kind);
        const rows = await sec.Model.findAll({
            where: { [sec.parentField]: UID }, raw: true, order: [['UID', 'ASC']]
        });
        // Копируем по полям ЦЕЛЕВОЙ модели: у части-приёмника набор полей может отличаться.
        const list = sections[targetTable] || (sections[targetTable] = []);
        for (const row of rows) list.push(formRow(TargetModel, row, secCfg, targetParentField));
    }

    // Коррекции нужно ДЕЙСТВУЮЩЕЕ состояние исходного документа в «как должно быть»,
    // а сторно скорректированного документа обязано отменять то же действующее
    // состояние, а не исходные строки. Считает ядро (difference.counterRows), без записи.
    let computed = null;
    try {
        computed = await difference.counterRows({ globalCtx, table, sourceUID: UID, kind });
    } catch (e) {
        throw new StornoError(`Не удалось собрать строки встречного документа: ${e.message}`, 'STORNO_LINES_FAILED');
    }
    if (computed) {
        for (const [tbl, rows] of Object.entries(computed)) {
            const TargetModel = modelFor(tbl);
            const pf = parentFieldOf[tbl] || (TargetModel && TargetModel.tabularSection && TargetModel.tabularSection.parentField);
            sections[tbl] = rows.map(r => formRow(TargetModel, r, null, pf));
        }
    }

    // ── Прикладной хук: то, что ядру знать неоткуда ───────────────────────
    if (cfg.hook) {
        const entityHooks = require('../entityHooks');
        // resolve() бросает, если обработчик не зарегистрирован: объявленный, но
        // не поднятый хук — ошибка приложения, и молчать о ней нельзя.
        const fn = entityHooks.resolve(cfg.hook);
        if (typeof fn === 'function') {
            await fn({ table, sourceUID: UID, source, head, sections, kind, context },
                { modelsDB: globalCtx.modelsDB, sessionID: context.sessionID });
        }
    }

    return { prefill: head, prefillTabular: sections, counterOf: { kind, sourceUID: UID } };
}

/**
 * Сохранение НОВОГО встречного документа: проверить `counterOf` из датасета формы.
 *
 * `counterOf` приходит в параметрах открытия формы, то есть с клиента, — поэтому
 * здесь то же, что и при нажатии кнопки: исходный документ виден пользователю
 * (RLS) и встречный документ к нему всё ещё допустим. Подделка даёт ровно то, что
 * дала бы кнопка.
 *
 * @returns {Promise<{kind, sourceUID, cfg}>}
 */
async function verifyCounter({ table, counterOf, sessionID, t }) {
    const kind = counterOf && counterOf.kind;
    const sourceUID = counterOf && counterOf.sourceUID;
    if (KINDS.indexOf(kind) === -1 || !sourceUID) {
        throw new StornoError(await say(t, 'storno_refuse_no_target', 'Документ не найден'), 'STORNO_NO_TARGET');
    }
    const Model = modelFor(table);
    const source = await loadSource(table, sourceUID, { sessionID });
    const cfg = await checkAllowed(Model, source, kind, t);
    return { kind, sourceUID, cfg };
}

/** Поставить ссылку и вид встречного документа — ПОСЛЕ прикладного onBeforeSave. */
function stampCounter(changes, verified) {
    if (!changes || !verified) return;
    const { cfg, kind, sourceUID } = verified;
    changes[cfg.link] = sourceUID;
    if (cfg.kindField) changes[cfg.kindField] = cfg.kindValue || kind;
}

/** Является ли строка сторно (а не коррекцией) по объявлению. */
function isStornoRow(Model, row) {
    const cfg = stornoConfig(Model);
    if (!cfg || !row || !row[cfg.link]) return false;
    if (cfg.kindField) return row[cfg.kindField] === (cfg.kindValue || 'storno');
    // Без поля вида сторно и коррекцию не различить — считаем сторно только если
    // коррекция не объявлена.
    return !counterConfig(Model, 'correction');
}

/**
 * ДО записи: какие сторно этот `update` ВЫСТАВЛЯЕТ (переводит из открытого
 * состояния в закрытое). Зовётся middleware `dbGateway`; дёшево выходит, если
 * запрос не про состояние документа со сторно.
 * @returns {Promise<Array|null>} строки сторно
 */
async function issuingStornos(request) {
    if (!request || request.operation !== 'update' || !request.data || !request.where) return null;
    const Model = modelFor(request.table);
    const cfg = stornoConfig(Model);
    const immCfg = Model ? require('./immutable').readConfig(Model) : null;
    if (!cfg || !cfg.cancelStatus || !cfg.link || !immCfg) return null;
    if (!Object.prototype.hasOwnProperty.call(request.data, immCfg.field)) return null;
    if (immCfg.when.indexOf(request.data[immCfg.field]) === -1) return null;

    const attrs = ['UID', immCfg.field, cfg.link];
    if (cfg.kindField) attrs.push(cfg.kindField);
    const rows = await Model.findAll({
        where: request.where, attributes: attrs, raw: true,
        transaction: request.options && request.options.transaction
    });
    return rows.filter(r => immCfg.when.indexOf(r[immCfg.field]) === -1 && isStornoRow(Model, r));
}

/** ПОСЛЕ записи: отменить исходные документы выставленных сторно. */
async function cancelSourcesOf(table, stornoRows, context) {
    const cfg = stornoConfig(modelFor(table));
    if (!cfg || !Array.isArray(stornoRows)) return;
    for (const r of stornoRows) {
        if (r && r[cfg.link]) await cancelSource(table, r[cfg.link], context || {});
    }
}

/**
 * Переводит исходный документ в «отменён». Зовётся, когда сторно выставлен: если
 * выставление сорвётся, исходный документ должен остаться действующим, а не
 * превратиться в отменённый без замены.
 */
async function cancelSource(table, UID, context) {
    const dbGateway = require('../dbGateway');
    const Model = modelFor(table);
    const cfg = stornoConfig(Model);
    const immCfg = require('./immutable').readConfig(Model);
    if (!cfg || !cfg.cancelStatus || !immCfg) return;

    await dbGateway.execute({
        operation: 'update',
        table,
        where: { UID },
        data: { [immCfg.field]: cfg.cancelStatus },
        context
    });
}

module.exports = {
    StornoError,
    prepareCounter,
    verifyCounter,
    stampCounter,
    issuingStornos,
    cancelSourcesOf,
    cancelSource,
    checkAllowed,
    stornoConfig,
    counterConfig,
    // negateValue/copyRow вынесены в экспорт ради самопроверки: инверсия знака у
    // DECIMAL-строк — то место, где ошибка стоит дороже всего.
    negateValue,
    copyRow,
    NEVER_COPY
};
