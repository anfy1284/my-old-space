'use strict';

/**
 * invalidate.js — «НЕДЕЙСТВИТЕЛЕН» (Ungültig). Механизм ЯДРА, цепляемый к любому документу.
 *
 * Третий способ закрыть ошибку в выставленном документе рядом со сторно и коррекцией
 * (`storno.js`): документ не отменяется встречной записью и не исправляется разницей, а
 * признаётся недействительным целиком. Встречного документа нет; при печати поверх
 * документа ложится красный диагональный крест (`crossOut`). Решение владельца
 * 13.09.2026: кнопку жмёт любой пользователь, только у выставленного документа,
 * без причины — одно подтверждение.
 *
 * Объявление в `db.json`:
 *
 *   "entityConfig": {
 *     "immutable": {
 *       "when":          [ …, "void" ],             // недействительный документ закрыт
 *       "transitions":   { "issued": [ …, "void" ] },
 *       "commandStates": [ …, "void" ]              // ставится только командой
 *     },
 *     "invalidate": { "status": "void", "from": ["issued"] }
 *   }
 *
 * Кнопка формы — декларация, без клиентского кода:
 *   { "name": "btnInvalidate", "command": "invalidate", "confirm": …, "enabledWhen": … }
 *
 * Отказы: состояние не из `from`; у документа уже есть встречные документы (сторно или
 * коррекция) — признать недействительным документ, к которому что-то привязано, значит
 * оставить привязанное висеть. Сторно и коррекция недействительного документа, наоборот,
 * отклоняются в `storno.js`.
 *
 * Запись идёт через `dbGateway`: переход проверит `immutable.js`, журнал его запишет.
 */

class InvalidateError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'InvalidateError';
        this.code = code || 'INVALIDATE_REFUSED';
        this.userMessage = message;
    }
}

async function say(t, key, fallback) {
    try {
        const v = t ? await t(key) : null;
        if (v && v !== key) return v;
    } catch (e) { /* перевода нет */ }
    return fallback;
}

function modelFor(table) {
    const globalCtx = require('../globalServerContext');
    const name = globalCtx.getModelNameForTable(table);
    return name ? globalCtx.modelsDB[name] : null;
}

/** Нормализованное объявление или null. */
function configOf(Model) {
    const c = Model && Model.entityConfig && Model.entityConfig.invalidate;
    if (!c || !c.status) return null;
    return {
        status: String(c.status),
        from: Array.isArray(c.from) ? c.from.map(String) : []
    };
}

/** Поле состояния документа — то же, что у проведения. */
function stateFieldOf(Model) {
    const imm = require('./immutable').readConfig(Model);
    return (imm && imm.field) || 'status';
}

/** Признана ли запись недействительной. */
function isInvalid(table, row) {
    const Model = modelFor(table);
    const cfg = configOf(Model);
    if (!cfg || !row) return false;
    return String(row[stateFieldOf(Model)]) === cfg.status;
}

// Крест — отдельный слой поверх документа, а не часть шаблона: печатается ровно тот
// документ, что лежит в архиве, и крест ложится на ЛЮБОЙ документ одинаково.
// position: fixed — Chrome повторяет слой на каждом печатном листе (как «Entwurf»).
const CROSS_STYLE = '<style>'
    + '.mos-invalid-cross{position:fixed;left:0;top:0;width:100%;height:100%;'
    + 'pointer-events:none;z-index:2000;-webkit-print-color-adjust:exact;print-color-adjust:exact}'
    + '.mos-invalid-cross svg{display:block;width:100%;height:100%}'
    + '.mos-invalid-cross line{stroke:rgba(200,0,0,.8);stroke-width:6px;vector-effect:non-scaling-stroke}'
    + '</style>';
const CROSS_LAYER = '<div class="mos-invalid-cross" aria-hidden="true">'
    + '<svg viewBox="0 0 100 100" preserveAspectRatio="none">'
    + '<line x1="0" y1="0" x2="100" y2="100"/><line x1="100" y1="0" x2="0" y2="100"/>'
    + '</svg></div>';

/** HTML документа с красным диагональным крестом поверх. Исходная строка не меняется. */
function crossOut(html) {
    const src = String(html || '');
    const layer = CROSS_STYLE + CROSS_LAYER;
    const idx = src.toLowerCase().lastIndexOf('</body>');
    return idx === -1 ? src + layer : src.slice(0, idx) + layer + src.slice(idx);
}

/**
 * Признать документ недействительным.
 * @param {Object} opts — { table, UID, context: { sessionID }, t }
 * @returns {Promise<{status: string, field: string, number: string|null}>}
 */
async function invalidateDocument(opts) {
    const { table, UID, context = {}, t = null } = opts || {};
    const Model = modelFor(table);
    const cfg = configOf(Model);
    if (!cfg) {
        throw new InvalidateError(await say(t, 'invalidate_refuse_not_declared',
            'Для этого документа признание недействительным не объявлено'), 'INVALIDATE_NOT_DECLARED');
    }
    const field = stateFieldOf(Model);

    const source = await Model.findOne({ where: { UID }, raw: true });
    if (!source) throw new InvalidateError(await say(t, 'storno_refuse_no_target', 'Документ не найден'), 'INVALIDATE_NO_TARGET');

    const state = source[field] == null ? '' : String(source[field]);
    if (cfg.from.indexOf(state) === -1) {
        throw new InvalidateError(await say(t, 'invalidate_refuse_state',
            'Недействительным можно признать только выставленный документ'), 'INVALIDATE_STATE');
    }

    // Встречные документы (сторно/коррекция) ссылаются на исходный одним полем связи.
    const ec = Model.entityConfig || {};
    const links = [];
    for (const k of ['storno', 'correction']) {
        const link = ec[k] && ec[k].link;
        if (link && links.indexOf(link) === -1) links.push(link);
    }
    for (const link of links) {
        const n = await Model.count({ where: { [link]: UID } });
        if (n > 0) {
            throw new InvalidateError(await say(t, 'invalidate_refuse_has_counter',
                'К документу уже оформлены сторно или коррекция — признать его недействительным нельзя'), 'INVALIDATE_HAS_COUNTER');
        }
    }

    const dbGateway = require('../dbGateway');
    await dbGateway.execute({
        operation: 'update', table, where: { UID }, data: { [field]: cfg.status }, context
    });
    return { status: cfg.status, field, number: source.number || null };
}

module.exports = { InvalidateError, configOf, isInvalid, crossOut, invalidateDocument };
