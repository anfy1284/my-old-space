'use strict';

/**
 * immutable.js — проведение документа: запрет изменения выставленного документа.
 *
 * Механизм ЯДРА, применимый к любому документу. Прикладной код объявляет в
 * `db.json` только правило:
 *
 *   "entityConfig": {
 *     "immutable": {
 *       "field":  "status",                         // поле состояния (умолчание — "status")
 *       "when":   ["issued", "paid", "cancelled"],  // состояния, в которых документ закрыт
 *       "except": ["status", "paidAt"],             // поля, которые всё же можно менять
 *       "transitions": {                            // разрешённые переходы состояния
 *         "draft":  ["issued"],
 *         "issued": ["paid", "cancelled"]
 *       },
 *       "deletable": ["draft"],                     // из каких состояний можно удалять
 *       "formEditable":  ["paidAt"],                // что остаётся доступным на ФОРМЕ
 *       "commandStates": ["issued", "cancelled"]    // состояния, которые ставит команда
 *     }
 *   }
 *
 * Последние два — для формы записи (`describeLock`): она гасит поля закрытого
 * документа сама, не дожидаясь отказа при сохранении.
 *
 * Табличные части документа закрываются ВМЕСТЕ с ним: строка счёта принадлежит
 * счёту, и без этого блокировка дырявая — запись правится через `uniForm.updateRow`
 * или прямым вызовом `dbGateway` по таблице ТЧ, минуя форму документа.
 * Родитель находится по `tabularSection.parentTable`/`parentField`.
 *
 * Проверка стоит в root-middleware `dbGateway` — то есть на ЕДИНСТВЕННОМ пути к
 * базе. Обойти её из прикладного кода нельзя; системный вызов
 * (`sessionID === '__SYS_INTERNAL__'`) НЕ является исключением: неизменность
 * документа — требование GoBD, а не права доступа.
 */

const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';

// Сравнение «то же самое значение» берём у журнала изменений, а не пишем второе:
// разойдясь, они начали бы считать изменением разное — журнал молчал бы там, где
// запрет отказывает, и наоборот.
const { same } = require('./auditLog');

/** Ошибка отказа: распознаётся клиентом по `code` и показывается пользователю как есть. */
class ImmutableError extends Error {
    constructor(message, code, details) {
        super(message);
        this.name = 'ImmutableError';
        this.code = code || 'DOCUMENT_IMMUTABLE';
        this.details = details || {};
        this.userMessage = message;
    }
}

/** Нормализует объявление: строки/массивы приводятся к единому виду. */
function readConfig(Model) {
    const cfg = Model && Model.entityConfig && Model.entityConfig.immutable;
    if (!cfg) return null;

    const field = cfg.field || 'status';

    // "when" принимается и массивом состояний, и объектом { status: [...] } —
    // второй вид встречается в существующих объявлениях.
    let when = cfg.when;
    if (when && !Array.isArray(when) && typeof when === 'object') {
        when = when[field] || Object.values(when)[0];
    }
    if (typeof when === 'string') when = [when];
    if (!Array.isArray(when) || !when.length) return null;

    return {
        field,
        when,
        except: Array.isArray(cfg.except) ? cfg.except : [],
        transitions: cfg.transitions && typeof cfg.transitions === 'object' ? cfg.transitions : null,
        deletable: Array.isArray(cfg.deletable) ? cfg.deletable : null
    };
}

/**
 * Находит модель документа-владельца для табличной части.
 * @returns {{Model: Object, parentField: string}|null}
 */
function findParent(globalCtx, Model) {
    const ts = Model && (Model.tabularSection || (Model.entityConfig && Model.entityConfig.tabularSection));
    if (!ts || !ts.parentTable || !ts.parentField) return null;

    const parentModelName = globalCtx.getModelNameForTable(ts.parentTable);
    const ParentModel = parentModelName ? globalCtx.modelsDB[parentModelName] : null;
    if (!ParentModel) return null;

    return { Model: ParentModel, parentField: ts.parentField };
}

/**
 * Значения поля состояния у документов, попадающих под `where`.
 * Читаем напрямую через модель, а не через `dbGateway`: это внутренняя проверка,
 * ей не нужны ни RLS-фильтры, ни хуки, и рекурсии через middleware быть не должно.
 */
async function statesOf(Model, where, field, options) {
    if (!where) return [];
    const rows = await Model.findAll({
        where,
        attributes: ['UID', field],
        raw: true,
        transaction: options && options.transaction
    });
    return rows;
}

/** Собирает UID документов-владельцев для строк ТЧ, попадающих под `where`. */
async function parentIdsOf(Model, where, parentField, options) {
    const rows = await Model.findAll({
        where,
        attributes: [parentField],
        raw: true,
        transaction: options && options.transaction
    });
    const ids = [];
    for (const r of rows) {
        const v = r[parentField];
        if (v != null && ids.indexOf(v) === -1) ids.push(v);
    }
    return ids;
}

/**
 * Человекочитаемый текст отказа на языке сессии.
 * `t` — асинхронный переводчик `(key) => Promise<string>` (обёртка над
 * `tForSession`); если ключа нет, `tForSession` возвращает сам ключ — тогда
 * берётся запасной русский текст.
 */
async function refusalText(t, kind, ctx) {
    const say = async (key, fallback) => {
        try {
            const v = t ? await t(key) : null;
            if (v && v !== key) return v;
        } catch (e) { /* перевода нет — берём запасной текст */ }
        return fallback;
    };

    switch (kind) {
        case 'update':
            return say('immutable_refuse_update',
                'Документ уже выставлен и не может быть изменён. Чтобы исправить ошибку, оформите сторно.');
        case 'updateLine':
            return say('immutable_refuse_line',
                'Строки принадлежат выставленному документу и не могут быть изменены. Чтобы исправить ошибку, оформите сторно.');
        case 'delete':
            return say('immutable_refuse_delete',
                'Выставленный документ нельзя удалить. Чтобы отменить его действие, оформите сторно.');
        case 'updateLog':
            return say('immutable_refuse_log_update',
                'Записи журнала и архива изменению не подлежат.');
        case 'deleteLog':
            return say('immutable_refuse_log_delete',
                'Записи журнала и архива удалению не подлежат.');
        case 'transition':
            return say('immutable_refuse_transition',
                `Переход состояния «${ctx.from}» → «${ctx.to}» не разрешён.`);
        default:
            return say('immutable_refuse_update', 'Документ закрыт для изменений.');
    }
}

/**
 * Проверяет одну операцию. Бросает `ImmutableError` при отказе.
 * @param {Object} request — запрос dbGateway
 * @param {Object} globalCtx — globalServerContext
 * @param {Function} [t] — переводчик (key) => string
 */
async function check(request, globalCtx, t) {
    const { operation, table, where, data, options = {} } = request;
    if (operation !== 'update' && operation !== 'delete') return;

    const modelName = globalCtx.getModelNameForTable(table);
    const Model = modelName ? globalCtx.modelsDB[modelName] : null;
    if (!Model) return;

    // ── 0. Таблица «только на дозапись» ───────────────────────────────────
    // `"entityConfig": { "appendOnly": true }` — журнал изменений и архив
    // выставленных документов: запись туда попадает один раз и навсегда.
    // Правка задним числом в них — ровно то, что закон запрещает.
    if (Model.entityConfig && Model.entityConfig.appendOnly) {
        throw new ImmutableError(
            await refusalText(t, operation === 'delete' ? 'deleteLog' : 'updateLog'),
            'APPEND_ONLY', { table, operation });
    }

    const cfg = readConfig(Model);

    // ── 1. Сам документ ───────────────────────────────────────────────────
    if (cfg) {
        const rows = await statesOf(Model, where, cfg.field, options);
        if (!rows.length) return;

        for (const row of rows) {
            const state = row[cfg.field];
            const closed = cfg.when.indexOf(state) !== -1;

            if (operation === 'delete') {
                const allowed = cfg.deletable ? cfg.deletable.indexOf(state) !== -1 : !closed;
                if (!allowed) {
                    throw new ImmutableError(await refusalText(t, 'delete'), 'DOCUMENT_IMMUTABLE',
                        { table, UID: row.UID, state });
                }
                continue;
            }

            // update: смена состояния проверяется всегда — и для открытого документа
            // тоже, иначе `draft` уедет сразу в `paid`, минуя выставление.
            const changed = Object.keys(data || {});
            const nextState = Object.prototype.hasOwnProperty.call(data || {}, cfg.field)
                ? data[cfg.field] : undefined;

            if (cfg.transitions && nextState !== undefined && nextState !== state) {
                const allowedTargets = cfg.transitions[state] || [];
                if (allowedTargets.indexOf(nextState) === -1) {
                    throw new ImmutableError(
                        await refusalText(t, 'transition', { from: state, to: nextState }),
                        'TRANSITION_NOT_ALLOWED',
                        { table, UID: row.UID, from: state, to: nextState });
                }
            }

            if (!closed) continue;

            // Документ закрыт: разрешены только поля из `except` (плюс само поле
            // состояния, если переход выше признан законным).
            //
            // «Правка» — это ОТЛИЧАЮЩЕЕСЯ значение, а не присутствие поля в запросе.
            // Форма присылает запись целиком, поэтому без сравнения со старым
            // значением отказ приходил бы на любое сохранение закрытого документа —
            // в том числе такое, где пользователь тронул одно лишь разрешённое поле
            // (отметку об оплате). Сравнение то же, что в журнале изменений: DECIMAL
            // приезжает из драйвера строкой, а с формы числом.
            const allowedFields = cfg.except.concat([cfg.field]);
            const suspect = changed.filter(k => allowedFields.indexOf(k) === -1
                && k !== 'UID' && k !== 'updatedAt');
            let forbidden = suspect;
            if (suspect.length) {
                const current = await Model.findOne({
                    where: { UID: row.UID }, raw: true,
                    transaction: options && options.transaction
                });
                if (current) forbidden = suspect.filter(k => !same(current[k], data[k]));
            }
            if (forbidden.length) {
                throw new ImmutableError(await refusalText(t, 'update'), 'DOCUMENT_IMMUTABLE',
                    { table, UID: row.UID, state, fields: forbidden });
            }
        }
        return;
    }

    // ── 2. Табличная часть закрытого документа ────────────────────────────
    const parent = findParent(globalCtx, Model);
    if (!parent) return;

    const parentCfg = readConfig(parent.Model);
    if (!parentCfg) return;

    const parentIds = await parentIdsOf(Model, where, parent.parentField, options);
    if (!parentIds.length) return;

    const parents = await statesOf(parent.Model, { UID: parentIds }, parentCfg.field, options);
    for (const p of parents) {
        if (parentCfg.when.indexOf(p[parentCfg.field]) !== -1) {
            throw new ImmutableError(await refusalText(t, 'updateLine'), 'DOCUMENT_IMMUTABLE',
                { table, parentUID: p.UID, state: p[parentCfg.field] });
        }
    }
}

/**
 * Проверка для `create` в табличной части: дописать строку в выставленный
 * документ — то же изменение документа, что и правка существующей строки.
 */
async function checkInsert(request, globalCtx, t) {
    const { operation, table, data, options = {} } = request;
    if (operation !== 'create' || !data) return;

    const modelName = globalCtx.getModelNameForTable(table);
    const Model = modelName ? globalCtx.modelsDB[modelName] : null;
    if (!Model) return;

    const parent = findParent(globalCtx, Model);
    if (!parent) return;

    const parentCfg = readConfig(parent.Model);
    if (!parentCfg) return;

    const parentId = data[parent.parentField];
    if (!parentId) return;

    const parents = await statesOf(parent.Model, { UID: parentId }, parentCfg.field, options);
    for (const p of parents) {
        if (parentCfg.when.indexOf(p[parentCfg.field]) !== -1) {
            throw new ImmutableError(await refusalText(t, 'updateLine'), 'DOCUMENT_IMMUTABLE',
                { table, parentUID: p.UID, state: p[parentCfg.field] });
        }
    }
}

/**
 * Описание «замка» для ФОРМЫ записи — из ТОЙ ЖЕ декларации, что и запрет записи.
 *
 * Форма обязана гасить поля сама, а не узнавать об отказе при сохранении: иначе
 * пользователь заполняет закрытый документ и теряет введённое. Второй список полей
 * (в лейауте, в клиентском скрипте) для этого не годится — разъехавшись с
 * `entityConfig.immutable`, он показал бы редактируемым то, что база не примет.
 *
 * Дополнения декларации, нужные только форме:
 *   "formEditable": ["paidAt"]           // поля, доступные у ЗАКРЫТОГО документа
 *   "commandStates": ["issued", "cancelled"]  // состояния, которые ставит КОМАНДА
 *
 * `commandStates` — про побочные действия: выставление снимает архивную копию и
 * проверяет реквизиты § 14, отмена оформляется сторно. Разрешённый переход
 * `draft → issued` без этого выбирался бы прямо в списке состояний на форме, и
 * счёт оказывался бы выставленным без архивной копии и без проверки.
 *
 * @param {Object} Model — модель Sequelize (нужен только `entityConfig`)
 * @param {Object} values — значения записи (для новой — значения по умолчанию формы)
 * @returns {{field, state, closed, closedStates, editable, states}|null}
 */
function describeLock(Model, values) {
    const cfg = readConfig(Model);
    if (!cfg) return null;

    const raw = (Model.entityConfig && Model.entityConfig.immutable) || {};
    const rawState = values ? values[cfg.field] : undefined;
    const state = (rawState === undefined || rawState === null || rawState === '')
        ? null : String(rawState);

    const commandStates = Array.isArray(raw.commandStates) ? raw.commandStates : [];
    const formEditable  = Array.isArray(raw.formEditable)  ? raw.formEditable  : [];

    // Ручные переходы КАЖДОГО состояния: разрешённые минус командные. Отдаём картой,
    // а не только для текущего состояния: документ может быть проведён в уже открытом
    // окне, и список выбора обязан пересчитаться там же, без переоткрытия формы.
    let manual = null;
    if (cfg.transitions) {
        manual = {};
        for (const from of Object.keys(cfg.transitions)) {
            manual[from] = (cfg.transitions[from] || []).filter(s => commandStates.indexOf(s) === -1);
        }
    }

    // Состояния, доступные для выбора на форме: текущее плюс его ручные переходы.
    // Текущее — всегда, иначе поле показало бы пустоту.
    const states = (state !== null && manual) ? [state].concat(manual[state] || []) : null;

    return {
        field: cfg.field,
        state,
        closed: state !== null && cfg.when.indexOf(state) !== -1,
        closedStates: cfg.when.slice(),
        editable: formEditable.slice(),
        states,
        manual
    };
}

/** Закрыт ли документ прямо сейчас (для прикладных проверок до записи). */
async function isClosed(globalCtx, table, uid) {
    const modelName = globalCtx.getModelNameForTable(table);
    const Model = modelName ? globalCtx.modelsDB[modelName] : null;
    if (!Model) return false;
    const cfg = readConfig(Model);
    if (!cfg) return false;
    const row = await Model.findOne({ where: { UID: uid }, attributes: ['UID', cfg.field], raw: true });
    return !!row && cfg.when.indexOf(row[cfg.field]) !== -1;
}

module.exports = {
    ImmutableError,
    SYSTEM_SESSION_ID,
    readConfig,
    findParent,
    describeLock,
    check,
    checkInsert,
    isClosed
};
