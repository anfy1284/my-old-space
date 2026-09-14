'use strict';

/**
 * translator — перевод текста сообщений средствами Google AI (Gemini).
 *
 * ── Почему это СВОЙ модуль мессенджера, а не обращение к «AI-ассистенту» ─────
 * Приложения независимы. То, что сегодня оба пользуются одним поставщиком, —
 * совпадение, а не связь: у мессенджера свой ключ и своя модель в собственных
 * настройках (решение владельца 13.09.2026). Вызов к поставщику скопирован из
 * `apps/ai_chat/forms/chat.server.js` намеренно — это граница между приложениями,
 * а не дублирование внутри одного.
 *
 * ── Что обещает модуль ──────────────────────────────────────────────────────
 * `translate(text, to, from, context)` возвращает `{ ok, text }` либо
 * `{ ok: false, error }`. НИКОГДА не бросает и никогда не возвращает исходный
 * текст под видом перевода: «перевод не получился» обязано быть отличимо от
 * «перевод совпал с оригиналом», иначе в базе окажется английский текст,
 * помеченный как немецкий.
 *
 * ── Контекст (14.09.2026) ───────────────────────────────────────────────────
 * Разбор реальной переписки показал: ошибки модели были от НЕХВАТКИ контекста —
 * мужской род у автора-женщины (имени модель не знала), «storniert» вместо
 * «für ungültig erklärt» (терминов программы не знала), немецкое слово кириллицей
 * транслитерировано вместо перевода. Поэтому при переводе модель получает автора и
 * читателей по именам, последние сообщения чата и словарь (lib/translationContext.js),
 * который еженедельно правит разбор (lib/translationReview.js → `analyze`).
 *
 * @module apps/messenger/lib/translator
 */

const log = require('../../../drive_root/log');

const APP_NAME = 'messenger';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_ANALYSIS_MODEL = 'gemini-2.5-pro';
const REQUEST_TIMEOUT_MS = 30000;
// Разбор получает переписку за неделю и весь словарь программы — это не секунды.
const ANALYSIS_TIMEOUT_MS = 300000;
const HISTORY_TEXT_LIMIT = 500;

/**
 * Указание модели-переводчику. Просим ТОЛЬКО текст перевода: любая приписка
 * («Here is the translation:») уехала бы в чат как часть сообщения.
 *
 * Обращение («ты»/«вы») не трогаем: это выбор АВТОРА, и переводчик обязан его
 * сохранить, а не выравнивать (решение владельца 14.09.2026).
 *
 * @param {string} text
 * @param {string} toName — язык перевода
 * @param {string} [fromName] — язык оригинала
 * @param {Object} [context] — { author, readers: [], history: [{author, text}], glossaryText }
 */
function buildPrompt(text, toName, fromName, context) {
    const c = context || {};
    const L = [];
    L.push('You translate a message of a private business chat' + (fromName ? ` from ${fromName}` : '') + ' into ' + toName + '.');
    if (c.author) L.push(`Author of the message: ${c.author}.`);
    if (Array.isArray(c.readers) && c.readers.length) L.push(`Reader(s): ${c.readers.join(', ')}.`);
    L.push('Rules:');
    L.push(`- Convey the meaning naturally and correctly in ${toName}, with its normal grammar, capitalization and punctuation.`);
    L.push("- Keep the author's tone and form of address exactly as written: informal stays informal, formal stays formal.");
    L.push('- Where the target language marks grammatical gender (e.g. past tense in Russian or Polish), use the gender of the author and readers, judging by their names.');
    L.push('- The author may use words of another language, sometimes written in a different script (e.g. German words in Cyrillic). Recognize them and translate their meaning instead of transliterating.');
    L.push('- When a glossary term applies, use its equivalent exactly.');
    L.push('- Keep line breaks exactly as in the original: do not add or remove them. Keep emoji, names and numbers as they are.');
    L.push(`- If the message is already in ${toName}, return it unchanged.`);
    L.push('- Return ONLY the translated message — no quotes, no notes, no language labels, no explanations.');
    const glossary = c.glossaryText ? String(c.glossaryText).trim() : '';
    if (glossary) L.push('', glossary);
    if (Array.isArray(c.history) && c.history.length) {
        L.push('', 'Earlier messages of this chat, for context only (do NOT translate them):');
        for (const h of c.history) {
            const t = String((h && h.text) || '').replace(/\s+/g, ' ').trim();
            if (t) L.push(`${(h && h.author) || '?'}: ${t.length > HISTORY_TEXT_LIMIT ? t.slice(0, HISTORY_TEXT_LIMIT) + '…' : t}`);
        }
    }
    L.push('', 'Message to translate:', '---', text);
    return L.join('\n');
}

/** Настройки подключения из системных настроек мессенджера. */
async function connection() {
    const settings = require('../../../drive_root/settings');
    const apiKey = await settings.getSystemSetting(APP_NAME, 'translateApiKey');
    const model = await settings.getSystemSetting(APP_NAME, 'translateModel');
    let analysisModel = null;
    try { analysisModel = await settings.getSystemSetting(APP_NAME, 'analysisModel'); } catch (e) { /* не объявлена */ }
    return {
        apiKey: apiKey || '',
        model: model || DEFAULT_MODEL,
        analysisModel: analysisModel || DEFAULT_ANALYSIS_MODEL
    };
}

/** Настроен ли перевод вообще (без ключа переводить нечем). */
async function isConfigured() {
    try {
        const { apiKey } = await connection();
        return !!apiKey;
    } catch (e) {
        return false;
    }
}

/** Единый вызов generateContent. Возвращает `{ ok, data }` | `{ ok: false, error }`. */
async function callGemini(apiKey, model, payload, timeoutMs) {
    const limit = timeoutMs || REQUEST_TIMEOUT_MS;
    const url = GEMINI_ENDPOINT + '/' + encodeURIComponent(model) +
        ':generateContent?key=' + encodeURIComponent(apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);

    let httpResp, rawText;
    try {
        httpResp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        rawText = await httpResp.text();
    } catch (e) {
        clearTimeout(timer);
        if (e && e.name === 'AbortError') {
            return { ok: false, error: 'translate request timed out (' + (limit / 1000) + 's)' };
        }
        return { ok: false, error: 'network error: ' + ((e && e.message) || String(e)) };
    }
    clearTimeout(timer);

    let data = null;
    try { data = rawText ? JSON.parse(rawText) : null; } catch (_) { /* не JSON */ }

    if (!httpResp.ok) {
        const apiMsg = (data && data.error && data.error.message) || rawText || ('HTTP ' + httpResp.status);
        return { ok: false, error: 'API error (' + httpResp.status + '): ' + apiMsg };
    }
    return { ok: true, data };
}

/** Текст ответа модели. */
function replyText(data) {
    try {
        const parts = data.candidates[0].content.parts || [];
        return parts.map(p => (p && p.text) || '').join('').trim();
    } catch (e) {
        return '';
    }
}

/**
 * Перевести текст.
 *
 * @param {string} text — исходный текст
 * @param {{code: string, name: string}} to — язык назначения
 * @param {{code: string, name: string}} [from] — язык оригинала, если известен
 * @param {Object} [context] — автор, читатели, история чата, словарь (см. buildPrompt)
 * @returns {Promise<{ok: boolean, text?: string, error?: string, engine?: string}>}
 */
async function translate(text, to, from, context) {
    const source = String(text || '').trim();
    if (!source) return { ok: false, error: 'empty text' };
    if (!to || !to.code) return { ok: false, error: 'target language not specified' };

    const { apiKey, model } = await connection();
    if (!apiKey) return { ok: false, error: 'translate_not_configured' };

    const prompt = buildPrompt(source, to.name || to.code, from && (from.name || from.code), context);
    const res = await callGemini(apiKey, model, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });
    if (!res.ok) {
        log.error('[messenger/translator]', res.error);
        return { ok: false, error: res.error };
    }

    const out = replyText(res.data);
    if (!out) return { ok: false, error: 'model returned no text' };
    return { ok: true, text: out, engine: model };
}

/**
 * Разбор: большой запрос с ответом СТРОГО в JSON по схеме (моделью разбора).
 * Никогда не бросает.
 *
 * @param {string} prompt
 * @param {Object} schema — responseSchema Gemini (OpenAPI-подмножество)
 * @returns {Promise<{ok: boolean, data?: Object, engine?: string, error?: string}>}
 */
async function analyze(prompt, schema) {
    let conn;
    try { conn = await connection(); } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
    if (!conn.apiKey) return { ok: false, error: 'translate_not_configured' };

    const res = await callGemini(conn.apiKey, conn.analysisModel, {
        contents: [{ role: 'user', parts: [{ text: String(prompt || '') }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema }
    }, ANALYSIS_TIMEOUT_MS);
    if (!res.ok) {
        log.error('[messenger/translator] analyze:', res.error);
        return { ok: false, error: res.error };
    }
    const text = replyText(res.data);
    if (!text) return { ok: false, error: 'model returned no text' };
    try {
        return { ok: true, data: JSON.parse(text), engine: conn.analysisModel };
    } catch (e) {
        return { ok: false, error: 'model returned invalid JSON: ' + text.slice(0, 200) };
    }
}

module.exports = { translate, analyze, isConfigured, connection, buildPrompt, DEFAULT_MODEL, DEFAULT_ANALYSIS_MODEL };
