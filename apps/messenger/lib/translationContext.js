'use strict';

/**
 * translationContext — «контекст переводчика» мессенджера: термины и короткие правила,
 * которые модель получает при КАЖДОМ переводе (lib/translator.js).
 *
 * Ведёт его регламентное задание `messenger.reviewTranslations` (lib/translationReview.js):
 * раз в неделю разбирает новые переводы и правит контекст САМО; владелец получает отчёт и
 * может откатить версию (решение владельца 14.09.2026, tmp/ТЗ_КОНТЕКСТ_ПЕРЕВОДЧИКА.md).
 *
 * ── Один словарь на всю систему ──────────────────────────────────────────────
 * Словарей организаций нет (решение владельца 14.09.2026: терминов, нужных только одной
 * организации, не придумать, а два уровня — лишнее усложнение).
 *
 * ── Где лежит ────────────────────────────────────────────────────────────────
 * `messenger_translation_contexts` — версии, только на дозапись. Текущая — с наибольшим
 * `version`. Откат — новая версия, скопированная со старой: история не теряется.
 *
 * ── Формат ───────────────────────────────────────────────────────────────────
 *   { terms: [{ term, equivalents: { de: '…', ru: '…' }, note }], rules: ['…'] }
 * Лимиты — не вкусовщина: контекст пишет модель по материалам, которые набирают люди,
 * и «правило», надиктованное в чате, не должно разрастись в свободную инструкцию.
 *
 * Модуль без побочных эффектов: его грузят и главный процесс (перевод при отправке), и
 * воркер планировщика (разбор). Чтение базы — через переданную функцию `query`, чтобы
 * каждый процесс ходил своим законным путём (воркер — через dbGateway со служебной сессией).
 *
 * @module apps/messenger/lib/translationContext
 */

const TABLE = 'messenger_translation_contexts';

const LIMITS = {
    terms: 300,
    termLen: 80,
    noteLen: 200,
    rules: 20,
    ruleLen: 300
};

/** Строка без лишних пробелов, не длиннее `max`. */
function clip(value, max) {
    const s = (value === null || value === undefined) ? '' : String(value).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) : s;
}

function parseJson(text, fallback) {
    if (text === null || text === undefined || text === '') return fallback;
    if (typeof text !== 'string') return text;
    try { return JSON.parse(text); } catch (e) { return fallback; }
}

/**
 * Эквиваленты термина → `{ код: текст }`. Принимает и объект, и массив
 * `[{ lang, text }]` — в таком виде их отдаёт модель (схема ответа не умеет «карту»).
 */
function normalizeEquivalents(input) {
    const pairs = [];
    if (Array.isArray(input)) {
        for (const p of input) if (p && typeof p === 'object') pairs.push([p.lang, p.text]);
    } else if (input && typeof input === 'object') {
        for (const [k, v] of Object.entries(input)) pairs.push([k, v]);
    }
    const out = {};
    for (const [lang, text] of pairs) {
        const code = String(lang || '').trim().toLowerCase();
        if (!/^[a-z]{2,3}(-[a-z]{2})?$/.test(code)) continue;
        const t = clip(text, LIMITS.termLen);
        if (t) out[code] = t;
    }
    const sorted = {};
    for (const k of Object.keys(out).sort()) sorted[k] = out[k];
    return sorted;
}

/** Привести контекст к строгому виду и лимитам. Порядок терминов — по алфавиту. */
function normalize(input) {
    const src = (input && typeof input === 'object') ? input : {};
    const terms = [];
    const seen = new Set();
    for (const t of (Array.isArray(src.terms) ? src.terms : [])) {
        const term = clip(t && t.term, LIMITS.termLen);
        if (!term) continue;
        const key = term.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = { term, equivalents: normalizeEquivalents(t.equivalents) };
        const note = clip(t.note, LIMITS.noteLen);
        if (note) entry.note = note;
        terms.push(entry);
        if (terms.length >= LIMITS.terms) break;
    }
    terms.sort((a, b) => a.term.localeCompare(b.term));

    const rules = [];
    for (const r of (Array.isArray(src.rules) ? src.rules : [])) {
        const s = clip(r, LIMITS.ruleLen);
        if (s && rules.indexOf(s) === -1) rules.push(s);
        if (rules.length >= LIMITS.rules) break;
    }
    return { terms, rules };
}

/** Одинаковы ли два контекста по существу. */
function same(a, b) {
    return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** Значения для строки таблицы версий. */
function toRow(context) {
    const n = normalize(context);
    return { terms: JSON.stringify(n.terms), rules: JSON.stringify(n.rules) };
}

/** Контекст из строки таблицы версий. */
function fromRow(row) {
    return normalize({ terms: parseJson(row && row.terms, []), rules: parseJson(row && row.rules, []) });
}

/**
 * Словарь программы: короткие подписи интерфейса из реестра i18n — модели разбора, чтобы
 * термины в переводах совпадали со словами, которые люди видят на экране.
 *
 * Берутся только подписи (до `maxWords` слов и `maxLen` символов на КАЖДОМ языке, без
 * подстановок) — подсказки и тексты ошибок терминами не являются. Одинаковые наборы
 * значений схлопываются: у многих ключей одна и та же подпись.
 *
 * @returns {{entries: Object[], toText: function(): string}}
 */
function programVocabulary(opts) {
    const maxWords = (opts && opts.maxWords) || 4;
    const maxLen = (opts && opts.maxLen) || 40;
    const registry = (opts && opts.registry) || require('../../../drive_root/i18n').entries();

    const entries = [];
    const signatures = new Set();
    for (const tr of Object.values(registry || {})) {
        if (!tr || typeof tr !== 'object') continue;
        const values = {};
        let ok = true;
        for (const [lang, v] of Object.entries(tr)) {
            if (typeof v !== 'string') { ok = false; break; }
            const s = v.trim().replace(/:$/, '');
            if (!s || s.length > maxLen || s.split(/\s+/).length > maxWords || s.indexOf('{{') !== -1) { ok = false; break; }
            values[lang] = s;
        }
        if (!ok || !Object.keys(values).length) continue;
        const sig = JSON.stringify(values);
        if (signatures.has(sig)) continue;
        signatures.add(sig);
        entries.push(values);
    }

    return {
        entries,
        toText: () => entries.map(v => Object.entries(v).map(([k, s]) => `${k}: ${s}`).join(' | ')).join('\n')
    };
}

/**
 * Содержит ли термин запретное слово (имя участника переписки). Словарь уходит в КАЖДЫЙ
 * перевод всем пользователям — имена людей в нём не нужны и не должны туда попадать.
 */
function containsForbidden(entry, forbiddenWords) {
    if (!entry || !forbiddenWords || !forbiddenWords.length) return false;
    const texts = [entry.term].concat(Object.values(entry.equivalents || {}), entry.note ? [entry.note] : [])
        .map(s => String(s).toLowerCase());
    return forbiddenWords.some(w => texts.some(t => t.split(/[^\p{L}\p{N}]+/u).indexOf(w) !== -1));
}

/**
 * Применить правку модели к контексту.
 *
 * @param {Object} current — текущий контекст
 * @param {Object} diff — { upsertTerms: [], removeTerms: [], rules: [], replaceRules: bool }
 * @param {Object} [opts]
 * @param {string[]} [opts.forbiddenWords] — слова в нижнем регистре (имена участников):
 *        термин, где они встречаются, отклоняется
 * @returns {{context: Object, changed: boolean, rejected: string[]}}
 */
function applyDiff(current, diff, opts) {
    const before = normalize(current);
    const byKey = new Map(before.terms.map(t => [t.term.toLowerCase(), t]));
    const rejected = [];
    const d = (diff && typeof diff === 'object') ? diff : {};
    const forbiddenWords = (opts && opts.forbiddenWords) || [];

    for (const r of (Array.isArray(d.removeTerms) ? d.removeTerms : [])) {
        byKey.delete(String(r || '').trim().toLowerCase());
    }
    for (const raw of (Array.isArray(d.upsertTerms) ? d.upsertTerms : [])) {
        const entry = normalize({ terms: [raw] }).terms[0];
        if (!entry) continue;
        if (containsForbidden(entry, forbiddenWords)) { rejected.push(entry.term); continue; }
        byKey.set(entry.term.toLowerCase(), entry);
    }
    let rules = before.rules;
    if (d.replaceRules === true && Array.isArray(d.rules)) rules = d.rules;

    const after = normalize({ terms: Array.from(byKey.values()), rules });
    return { context: after, changed: !same(before, after), rejected };
}

/** Что изменилось: добавленные, удалённые, изменённые термины и смена правил. */
function describeChange(before, after) {
    const b = normalize(before);
    const a = normalize(after);
    const bm = new Map(b.terms.map(t => [t.term.toLowerCase(), t]));
    const am = new Map(a.terms.map(t => [t.term.toLowerCase(), t]));
    const added = [], changed = [], removed = [];
    for (const [k, t] of am) {
        if (!bm.has(k)) added.push(t);
        else if (JSON.stringify(bm.get(k)) !== JSON.stringify(t)) changed.push(t);
    }
    for (const [k, t] of bm) if (!am.has(k)) removed.push(t.term);
    return { added, changed, removed, rules: JSON.stringify(b.rules) !== JSON.stringify(a.rules) ? a.rules : null };
}

/** Текст контекста для указания модели-переводчику. Пустой контекст — пустая строка. */
function toPromptText(context) {
    const c = context || {};
    const lines = [];
    if (Array.isArray(c.terms) && c.terms.length) {
        lines.push('Glossary (use these equivalents exactly when the term applies):');
        for (const t of c.terms) {
            const eq = Object.entries(t.equivalents || {}).map(([k, v]) => `${k}: ${v}`).join('; ');
            lines.push(`- ${t.term}${eq ? ' — ' + eq : ''}${t.note ? ' (' + t.note + ')' : ''}`);
        }
    }
    if (Array.isArray(c.rules) && c.rules.length) {
        lines.push('Notes from earlier reviews of translations in this system:');
        for (const r of c.rules) lines.push('- ' + r);
    }
    return lines.join('\n');
}

/**
 * Текущая версия контекста.
 *
 * @param {function(string, Object, Object): Promise<Object[]>} query — чтение строк
 *        (главный процесс — моделью, воркер — через dbGateway со своей сессией)
 * @returns {Promise<{row: Object, context: Object}|null>}
 */
async function loadCurrent(query) {
    const rows = (await query(TABLE, {}, { order: [['version', 'DESC']], limit: 1 })) || [];
    const row = rows[0];
    return row ? { row, context: fromRow(row) } : null;
}

module.exports = {
    TABLE, LIMITS,
    normalize, same, toRow, fromRow,
    programVocabulary, containsForbidden,
    applyDiff, describeChange, toPromptText, loadCurrent
};
