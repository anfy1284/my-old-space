'use strict';

/**
 * invalidate.js — «НЕДЕЙСТВИТЕЛЕН» (Ungültig). Механизм ЯДРА, цепляемый к любому документу.
 *
 * Третий способ закрыть ошибку в выставленном документе рядом со сторно и коррекцией
 * (`storno.js`): документ не отменяется встречной записью и не исправляется разницей, а
 * признаётся недействительным целиком. Встречного документа нет; при печати поверх
 * документа ложится штамп «Ungültig» (`markInvalid`). Решение владельца
 * 13.09.2026: кнопку жмёт любой пользователь, только у выставленного документа,
 * без причины — одно подтверждение. Сначала был ещё красный крест — убран 14.09.2026:
 * на бумаге он выглядел как пометка ручкой, а штамп говорит всё сам.
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
        from: Array.isArray(c.from) ? c.from.map(String) : [],
        // Ключ текста строки «недействителен» в печати: у документа — своё слово
        // («Diese Rechnung…»), без объявления — общее «Dieser Beleg…». Вариант без даты —
        // тот же ключ с суффиксом `_nodate`.
        noticeKey: (c.notice && c.notice.i18n) ? String(c.notice.i18n) : null,
        // CSS-селектор заголовка печатной формы: к нему пристраивается отметка.
        titleSelector: c.titleSelector ? String(c.titleSelector) : null
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

// Штамп «Ungültig» — ТОТ ЖЕ, что «Entwurf» у черновика (`.draft-watermark` шаблона
// счёта, решение владельца 14.09.2026): напечатанное слово видно как отметку
// программы — для консультанта и Finanzamt. Отдельный слой поверх документа, а не
// часть шаблона: печатается ровно тот документ, что лежит в архиве, и штамп ложится
// на ЛЮБОЙ документ одинаково. position: fixed — Chrome повторяет его на каждом листе.
const STAMP_STYLE = '<style>'
    + '.mos-invalid-stamp{position:fixed;top:50%;left:50%;'
    + 'transform:translate(-50%,-50%) rotate(-35deg);'
    + 'font-size:72pt;font-weight:bold;letter-spacing:6pt;'
    + 'color:rgba(180,0,0,.18);border:6pt solid rgba(180,0,0,.18);'
    + 'padding:4mm 10mm;white-space:nowrap;pointer-events:none;z-index:2001;'
    + '-webkit-print-color-adjust:exact;print-color-adjust:exact}'
    + '</style>';

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Отметка В ЗАГОЛОВКЕ документа (решение владельца 14.09.2026): «UNGÜLTIG Rechnung Nr. 1440» и
// строкой ниже «Diese Rechnung wurde am … für ungültig erklärt.». Штампа мало — он бледный, на
// ч/б печати почти пропадает. Строка в верхнем поле листа отвергнута: поле отрезается
// ножницами, и счёт выглядит действительным. Заголовок не отрежешь, не уничтожив документ.
//
// Архивная копия не переписывается: к документу добавляется стиль с `::before`/`::after` на
// заголовке. Стиль действует и на элементы, которые скрипт страницы строит после загрузки, и не
// зависит от их текста. Какой элемент — заголовок, объявляет документ
// (`entityConfig.invalidate.titleSelector`); ядро шаблонов не знает. Не объявлено — только штамп.

/** Строка для CSS `content`: кавычки и обратная косая экранированы, `<` не закроет `<style>`. */
function cssString(s) {
    return '"' + String(s)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/</g, '\\3C ')
        .replace(/\r?\n/g, ' ') + '"';
}

/** Стиль отметки в заголовке или '' — если документ заголовок не объявил. */
function titleMarkStyle(opts, word) {
    const o = opts || {};
    let selector = null;
    try {
        const cfg = o.table ? configOf(modelFor(o.table)) : null;
        selector = cfg && cfg.titleSelector;
    } catch (e) { /* модели не подняты — только штамп */ }
    // Селектор приходит из объявления модели, но в стиль он вставляется как есть: символы,
    // которыми можно выйти из правила или из `<style>`, не пропускаем.
    if (!selector || /[<{}]/.test(selector)) return '';
    const upper = String(word).toLocaleUpperCase(o.lang || 'de');
    const exact = '-webkit-print-color-adjust:exact;print-color-adjust:exact';
    return '<style>'
        + `${selector}::before{content:${cssString(upper + ' ')};color:#b00000;font-weight:bold;${exact}}`
        + `${selector}::after{content:${cssString(noticeText(o))};display:block;margin-top:1mm;`
        + `font-size:10pt;font-weight:bold;color:#b00000;${exact}}`
        + '</style>';
}

const DATE_LOCALES = { de: 'de-DE', en: 'en-GB', ru: 'ru-RU', pl: 'pl-PL' };

/** Дата в формате языка документа, с ведущими нулями (юридический документ). */
function formatDate(date, lang) {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(DATE_LOCALES[lang] || 'de-DE', {
        day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin'
    });
}

/**
 * Текст строки «недействителен». Ключ — из объявления документа (`invalidate.notice`),
 * иначе общий; нет даты — вариант `_nodate`.
 * @param {Object} [opts] — { lang, table, invalidatedAt }
 */
function noticeText(opts) {
    const o = opts || {};
    let key = 'invalidate_notice';
    try {
        const cfg = o.table ? configOf(modelFor(o.table)) : null;
        if (cfg && cfg.noticeKey) key = cfg.noticeKey;
    } catch (e) { /* модели не подняты — общий текст */ }
    const date = o.invalidatedAt ? formatDate(o.invalidatedAt, o.lang) : '';
    const i18n = require('../i18n');
    const fullKey = date ? key : key + '_nodate';
    const text = i18n.tf(fullKey, o.lang, { date });
    if (text && text !== fullKey) return text;
    return date ? `Ungültig: ${date}` : 'Ungültig';
}

/**
 * Когда документ признан недействительным: последний переход в недействительное состояние
 * по журналу изменений (`document_audit_log`). Отдельного реквизита не заводим — журнал уже
 * хранит это событие. Нет журнала или записи — null.
 */
async function invalidatedAt(table, UID) {
    const Model = modelFor(table);
    const cfg = configOf(Model);
    if (!cfg || !UID) return null;
    const field = stateFieldOf(Model);
    const Log = modelFor('document_audit_log');
    if (!Log) return null;
    const rows = await Log.findAll({
        where: { documentTable: table, documentUID: UID, operation: 'update' },
        order: [['changedAt', 'DESC']],
        raw: true
    });
    for (const r of rows) {
        let after = r.after;
        if (typeof after === 'string') { try { after = JSON.parse(after); } catch (e) { after = null; } }
        if (after && String(after[field]) === cfg.status) return r.changedAt;
    }
    return null;
}

/**
 * HTML документа со штампом «Ungültig» поверх. Исходная строка не меняется.
 *
 * @param {string} html
 * @param {Object} [opts]
 * @param {string} [opts.lang] — язык ДОКУМЕНТА (у архивной копии — её `lang`), не сессии:
 *        документ организации печатается на её языке, и штамп с ним не должен расходиться.
 */
function markInvalid(html, opts) {
    const src = String(html || '');
    const lang = opts && opts.lang;
    let word = 'Ungültig';
    try {
        const v = require('../i18n').t('invalidate_watermark', lang);
        if (v && v !== 'invalidate_watermark') word = v;
    } catch (e) { /* реестр переводов не поднят — остаётся запасное слово */ }
    const layer = STAMP_STYLE + '<div class="mos-invalid-stamp">' + escapeHtml(word) + '</div>'
        + titleMarkStyle(opts, word);
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

module.exports = { InvalidateError, configOf, isInvalid, markInvalid, invalidatedAt, noticeText, invalidateDocument };
