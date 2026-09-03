'use strict';

/**
 * storno.js — сторнирование документа. Механизм ЯДРА, цепляемый к любому документу.
 *
 * Выставленный документ исправлять нельзя (GoBD, см. `immutable.js`). Единственный
 * законный способ отменить его действие — встречный документ с обратными знаками.
 * Прикладному коду остаётся объявление в `db.json`:
 *
 *   Документ:
 *     "entityConfig": {
 *       "storno": {
 *         "link":         "correctsInvoiceId",   // поле сторно-документа → исходный
 *         "cancelStatus": "cancelled",           // статус, в который уходит исходный
 *         "negate":       ["prepayment"],        // поля документа с инверсией знака
 *         "copyExclude":  ["status", "issuedAt"],// поля, которые не копируются
 *         "hook":         "invoice.onStorno"     // необязательный прикладной хук
 *       }
 *     }
 *
 *   Каждая табличная часть — свой список инвертируемых полей:
 *     "entityConfig": { "storno": { "negate": ["quantity", "amount"] } }
 *
 * Что НЕ копируется никогда: `UID`, `number`, `date`, `name`, `createdAt`,
 * `updatedAt` — номер и дата у сторно свои (их проставят автонумерация и
 * `documentDate`), представление пересоберёт `applyPresentation`.
 *
 * Запись идёт ТОЛЬКО через `dbGateway`: массовая запись мимо него обошла бы
 * автонумерацию, дату документа, представление и хуки — сторно получился бы
 * документом без номера.
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
    if (typeof v === 'number') return -v;

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
    const { table, UID, context = {}, override = {}, t = null } = opts || {};
    if (!table || !UID) throw new StornoError(await say(t, 'storno_refuse_no_target', 'Документ не найден'), 'STORNO_NO_TARGET');

    const globalCtx = require('../globalServerContext');
    const dbGateway = require('../dbGateway');
    const immutable = require('./immutable');

    const modelName = globalCtx.getModelNameForTable(table);
    const Model = modelName ? globalCtx.modelsDB[modelName] : null;
    if (!Model) throw new StornoError(await say(t, 'storno_refuse_no_model', `Модель для таблицы "${table}" не найдена`), 'STORNO_NO_MODEL');

    const cfg = stornoConfig(Model);
    if (!cfg || !cfg.link) {
        throw new StornoError(await say(t, 'storno_refuse_not_declared', 'Для этого документа сторно не объявлено'), 'STORNO_NOT_DECLARED');
    }
    const immCfg = immutable.readConfig(Model);

    const source = await Model.findOne({ where: { UID }, raw: true });
    if (!source) throw new StornoError(await say(t, 'storno_refuse_no_target', 'Документ не найден'), 'STORNO_NO_TARGET');

    // ── Отказы ────────────────────────────────────────────────────────────
    // Сторно сторна — бессмыслица: это возврат к исходному документу, который
    // и так остался в базе.
    if (source[cfg.link]) {
        throw new StornoError(await say(t, 'storno_refuse_of_storno', 'Сторнирующий документ нельзя сторнировать'), 'STORNO_OF_STORNO');
    }
    // Дважды сторнировать один документ нельзя: у отменённого документа
    // больше нет действия, которое можно отменить.
    const already = await Model.count({ where: { [cfg.link]: UID } });
    if (already > 0) {
        throw new StornoError(await say(t, 'storno_refuse_already', 'Документ уже сторнирован'), 'STORNO_ALREADY');
    }
    // Черновик сторнировать нечего — он не покидал сферу выставителя,
    // его правят или удаляют.
    if (immCfg) {
        const state = source[immCfg.field];
        if (immCfg.when.indexOf(state) === -1) {
            throw new StornoError(await say(t, 'storno_refuse_not_issued', 'Сторнировать можно только выставленный документ'), 'STORNO_NOT_ISSUED');
        }
        if (cfg.cancelStatus && state === cfg.cancelStatus) {
            throw new StornoError(await say(t, 'storno_refuse_cancelled', 'Документ уже отменён'), 'STORNO_ALREADY');
        }
    }

    // ── Шапка сторно ──────────────────────────────────────────────────────
    const head = copyRow(Model, source, cfg, Object.assign({ [cfg.link]: UID }, override));
    // Сторно рождается черновиком: выставляет его вызывающая сторона тем же
    // путём, что и обычный документ, — чтобы отработали архив и журнал.
    if (immCfg && head[immCfg.field] === undefined) {
        head[immCfg.field] = Model.rawAttributes[immCfg.field]
            && Model.rawAttributes[immCfg.field].defaultValue;
    }

    const created = await dbGateway.execute({
        operation: 'create', table, data: head, context
    });
    const newUID = created && (created.UID || (created.dataValues && created.dataValues.UID));
    if (!newUID) throw new StornoError(await say(t, 'storno_refuse_create_failed', 'Не удалось создать сторно-документ'), 'STORNO_CREATE_FAILED');

    // ── Табличные части ───────────────────────────────────────────────────
    for (const sec of sectionsOf(globalCtx, table)) {
        const secCfg = stornoConfig(sec.Model);
        const rows = await sec.Model.findAll({
            where: { [sec.parentField]: UID },
            raw: true,
            order: [['UID', 'ASC']]
        });
        for (const row of rows) {
            const data = copyRow(sec.Model, row, secCfg, { [sec.parentField]: newUID });
            await dbGateway.execute({
                operation: 'create', table: sec.Model.tableName, data, context
            });
        }
    }

    // ── Прикладной хук: то, что ядру знать неоткуда ───────────────────────
    if (cfg.hook) {
        const entityHooks = require('../entityHooks');
        // resolve() бросает, если обработчик не зарегистрирован: объявленный, но
        // не поднятый хук — ошибка приложения, и молчать о ней нельзя.
        const fn = entityHooks.resolve(cfg.hook);
        if (typeof fn === 'function') {
            await fn({ table, sourceUID: UID, stornoUID: newUID, source, context },
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

module.exports = {
    StornoError,
    createStorno,
    cancelSource,
    stornoConfig,
    // negateValue/copyRow вынесены в экспорт ради самопроверки: инверсия знака у
    // DECIMAL-строк — то место, где ошибка стоит дороже всего.
    negateValue,
    copyRow,
    NEVER_COPY
};
