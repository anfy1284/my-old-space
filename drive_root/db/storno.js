'use strict';

/**
 * storno.js — ВСТРЕЧНЫЙ ДОКУМЕНТ. Механизм ЯДРА, цепляемый к любому документу.
 *
 * Выставленный документ исправлять нельзя (GoBD, см. `immutable.js`). Законный
 * способ изменить его действие — отдельный документ, который на него ссылается.
 * Видов таких документов ДВА, и они различаются не кодом, а объявлением:
 *
 *   • сторно (`entityConfig.storno`) — полная отмена: копия с обратными знаками,
 *     исходный документ уходит в «отменён»;
 *   • коррекция (`entityConfig.correction`) — частичное изменение: исходный
 *     документ ОСТАЁТСЯ действующим, а встречный несёт только разницу
 *     (§ 31 Abs. 5 UStDV: передаются лишь изменившиеся данные документом,
 *     однозначно привязанным к исходному счёту).
 *
 * Прикладному коду остаётся объявление в `db.json`:
 *
 *   Документ:
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
 * `kindField` обязателен, когда у документа объявлены ОБА вида: без него
 * проверка «документ уже сторнирован» считала бы сторно и коррекции вместе и
 * отказывала бы в сторно скорректированного документа чужим текстом.
 *
 * `sectionMap` переносит строки исходного документа в ДРУГУЮ табличную часть
 * встречного. Коррекции это нужно: пользователь правит копию исходных строк
 * («как должно быть»), а собственные строки документа несут разницу. Задавать
 * карту руками не требуется — её выводит объявление разницы
 * (`entityConfig.correction.difference`, см. `drive_root/db/difference.js`),
 * оно же синтезирует саму зеркальную часть и считает разницу.
 *
 * Что НЕ копируется никогда: `UID`, `number`, `date`, `name`, `createdAt`,
 * `updatedAt` — номер и дата у встречного документа свои (их проставят
 * автонумерация и `documentDate`), представление пересоберёт `applyPresentation`.
 *
 * Запись идёт ТОЛЬКО через `dbGateway`: массовая запись мимо него обошла бы
 * автонумерацию, дату документа, представление и хуки — документ получился бы
 * без номера.
 */

const NEVER_COPY = ['UID', 'number', 'date', 'name', 'createdAt', 'updatedAt'];

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

/**
 * Создаёт сторно-документ.
 *
 * @param {Object} opts
 * @param {string} opts.table    — таблица документа ('invoices')
 * @param {string} opts.UID      — UID исходного документа
 * @param {Object} opts.context  — контекст вызова dbGateway ({ sessionID })
 * @param {Object} [opts.override] — поля, задаваемые поверх копии
 * @returns {Promise<{UID: string, table: string}>} — созданный сторно-документ
 */
async function createStorno(opts) {
    const { table, UID, context = {}, override = {}, t = null, kind = 'storno' } = opts || {};
    const isCorrection = kind === 'correction';
    if (!table || !UID) throw new StornoError(await say(t, 'storno_refuse_no_target', 'Документ не найден'), 'STORNO_NO_TARGET');

    const globalCtx = require('../globalServerContext');
    const dbGateway = require('../dbGateway');
    const immutable = require('./immutable');

    const modelName = globalCtx.getModelNameForTable(table);
    const Model = modelName ? globalCtx.modelsDB[modelName] : null;
    if (!Model) throw new StornoError(await say(t, 'storno_refuse_no_model', `Модель для таблицы "${table}" не найдена`), 'STORNO_NO_MODEL');

    const cfg = counterConfig(Model, kind);
    if (!cfg || !cfg.link) {
        throw new StornoError(await say(t,
            isCorrection ? 'correction_refuse_not_declared' : 'storno_refuse_not_declared',
            'Для этого документа встречный документ не объявлен'), 'STORNO_NOT_DECLARED');
    }
    const immCfg = immutable.readConfig(Model);

    const source = await Model.findOne({ where: { UID }, raw: true });
    if (!source) throw new StornoError(await say(t, 'storno_refuse_no_target', 'Документ не найден'), 'STORNO_NO_TARGET');

    // ── Отказы ────────────────────────────────────────────────────────────
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
    // «Уже сторнирован» = есть встречный документ, который НЕ коррекция.
    //
    // Именно так, а не «вид = сторно»: поле вида появилось позже самого сторно,
    // и у документов, сторнированных ДО его появления, оно пустое. Проверка по
    // равенству их бы не увидела — и разрешила бы сторнировать такой документ
    // второй раз. Значение вида коррекции берём из её объявления, а не
    // литералом: имена видов задаёт приложение.
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
    }

    // ── Шапка встречного документа ────────────────────────────────────────
    const extra = Object.assign({ [cfg.link]: UID }, override);
    if (cfg.kindField) extra[cfg.kindField] = cfg.kindValue || kind;
    const head = copyRow(Model, source, cfg, extra);
    // Встречный документ рождается черновиком: выставляет его вызывающая
    // сторона тем же путём, что и обычный документ, — чтобы отработали архив
    // и журнал. Коррекции черновик нужен ещё и по существу: пользователь
    // правит в нём «как должно быть», прежде чем выставить.
    if (immCfg && head[immCfg.field] === undefined) {
        head[immCfg.field] = Model.rawAttributes[immCfg.field]
            && Model.rawAttributes[immCfg.field].defaultValue;
    }

    const created = await dbGateway.execute({
        operation: 'create', table, data: head, context
    });
    const newUID = created && (created.UID || (created.dataValues && created.dataValues.UID));
    if (!newUID) throw new StornoError(await say(t, 'storno_refuse_create_failed', 'Не удалось создать встречный документ'), 'STORNO_CREATE_FAILED');

    // ── Табличные части ───────────────────────────────────────────────────
    // `sectionMap` перенаправляет строки в ДРУГУЮ табличную часть встречного
    // документа: коррекция кладёт копию исходных строк в «как должно быть», а
    // собственные строки (разницу) заполняет прикладной код.
    // Карта переноса ТЧ. У коррекции её задаёт объявление разницы
    // (`entityConfig.correction.difference`) — приложению не нужно повторять
    // одно и то же двумя записями; явный `sectionMap` остаётся для случаев,
    // которые разницей не описываются.
    const difference = require('./difference');
    const sectionMap = Object.assign({}, (isCorrection ? difference.sectionMapFor(Model) : null) || {},
                                     (cfg && cfg.sectionMap) || {});
    for (const sec of sectionsOf(globalCtx, table)) {
        const targetTable = Object.prototype.hasOwnProperty.call(sectionMap, sec.Model.tableName)
            ? sectionMap[sec.Model.tableName] : sec.Model.tableName;
        // Явный null в карте — «эту часть не переносить вовсе».
        if (!targetTable) continue;
        const targetModelName = globalCtx.getModelNameForTable(targetTable);
        const TargetModel = targetModelName ? globalCtx.modelsDB[targetModelName] : null;
        if (!TargetModel) {
            throw new StornoError(`sectionMap: таблица "${targetTable}" не найдена`, 'STORNO_NO_MODEL');
        }
        const targetParentField = (TargetModel.tabularSection && TargetModel.tabularSection.parentField)
            || sec.parentField;
        const secCfg = counterConfig(sec.Model, kind);
        const rows = await sec.Model.findAll({
            where: { [sec.parentField]: UID },
            raw: true,
            order: [['UID', 'ASC']]
        });
        for (const row of rows) {
            // Копируем по полям ЦЕЛЕВОЙ модели: у части-приёмника набор полей
            // может отличаться от источника.
            const data = copyRow(TargetModel, row, secCfg, { [targetParentField]: newUID });
            await dbGateway.execute({
                operation: 'create', table: targetTable, data, context
            });
        }
    }

    // ── Строковые части встречного документа ──────────────────────────────
    // Коррекции нужно ДЕЙСТВУЮЩЕЕ состояние исходного документа в «как должно
    // быть» (скопированных исходных строк хватает только на первую коррекцию),
    // а сторно скорректированного документа обязано отменять то же действующее
    // состояние, а не исходные строки. И то и другое — механика, не прикладное
    // знание: считает ядро (drive_root/db/difference.js).
    try {
        await difference.onCounterCreated({
            globalCtx, dbGateway, table, sourceUID: UID, newUID, kind, context
        });
    } catch (e) {
        throw new StornoError(`Не удалось собрать строки встречного документа: ${e.message}`, 'STORNO_LINES_FAILED');
    }

    // ── Прикладной хук: то, что ядру знать неоткуда ───────────────────────
    if (cfg.hook) {
        const entityHooks = require('../entityHooks');
        // resolve() бросает, если обработчик не зарегистрирован: объявленный, но
        // не поднятый хук — ошибка приложения, и молчать о ней нельзя.
        const fn = entityHooks.resolve(cfg.hook);
        if (typeof fn === 'function') {
            await fn({ table, sourceUID: UID, stornoUID: newUID, source, context, kind },
                { modelsDB: globalCtx.modelsDB, dbGateway, sessionID: context.sessionID });
        }
    }

    return { UID: newUID, table, sourceUID: UID };
}

/**
 * Переводит исходный документ в «отменён» — отдельным шагом, ПОСЛЕ того как
 * сторно выставлен: если выставление сорвётся, исходный документ должен
 * остаться действующим, а не превратиться в отменённый без замены.
 */
async function cancelSource(table, UID, context) {
    const globalCtx = require('../globalServerContext');
    const dbGateway = require('../dbGateway');

    const modelName = globalCtx.getModelNameForTable(table);
    const Model = modelName ? globalCtx.modelsDB[modelName] : null;
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

/**
 * Создаёт документ-КОРРЕКЦИЮ: копию исходного БЕЗ инверсии знаков, со ссылкой
 * на исходный. Исходный документ остаётся действующим — его статус не трогаем
 * (в отличие от сторно). Разницу считает прикладной код: ядру неизвестно, что
 * в этом документе считается «строкой».
 *
 * @param {Object} opts — как у createStorno
 */
async function createCorrection(opts) {
    return await createStorno(Object.assign({}, opts, { kind: 'correction' }));
}

module.exports = {
    StornoError,
    createStorno,
    createCorrection,
    cancelSource,
    stornoConfig,
    counterConfig,
    // negateValue/copyRow вынесены в экспорт ради самопроверки: инверсия знака у
    // DECIMAL-строк — то место, где ошибка стоит дороже всего.
    negateValue,
    copyRow,
    NEVER_COPY
};
