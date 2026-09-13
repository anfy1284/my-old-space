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
 * `translate(text, toCode, fromCode)` возвращает `{ ok, text }` либо
 * `{ ok: false, error }`. НИКОГДА не бросает и никогда не возвращает исходный
 * текст под видом перевода: «перевод не получился» обязано быть отличимо от
 * «перевод совпал с оригиналом», иначе в базе окажется английский текст,
 * помеченный как немецкий.
 *
 * @module apps/messenger/lib/translator
 */

const log = require('../../../drive_root/log');

const APP_NAME = 'messenger';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const REQUEST_TIMEOUT_MS = 30000;

/**
 * Указание модели. Просим ТОЛЬКО текст перевода: любая приписка («Here is the
 * translation:») уехала бы в чат как часть сообщения.
 */
function buildPrompt(text, toName, fromName) {
    const from = fromName ? ` from ${fromName}` : '';
    return 'Translate the following chat message' + from + ' into ' + toName + '.\n'
        + 'Rules: return ONLY the translated text — no quotes, no notes, no language labels, '
        + 'no explanations. Keep line breaks, emoji, names, numbers and formatting as they are. '
        + 'If the text is already in the target language, return it unchanged.\n\n'
        + '---\n' + text;
}

/** Настройки подключения из системных настроек мессенджера. */
async function connection() {
    const settings = require('../../../drive_root/settings');
    const apiKey = await settings.getSystemSetting(APP_NAME, 'translateApiKey');
    const model = await settings.getSystemSetting(APP_NAME, 'translateModel');
    return { apiKey: apiKey || '', model: model || DEFAULT_MODEL };
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
async function callGemini(apiKey, model, payload) {
    const url = GEMINI_ENDPOINT + '/' + encodeURIComponent(model) +
        ':generateContent?key=' + encodeURIComponent(apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
            return { ok: false, error: 'translate request timed out (' + (REQUEST_TIMEOUT_MS / 1000) + 's)' };
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
 * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
 */
async function translate(text, to, from) {
    const source = String(text || '').trim();
    if (!source) return { ok: false, error: 'empty text' };
    if (!to || !to.code) return { ok: false, error: 'target language not specified' };

    const { apiKey, model } = await connection();
    if (!apiKey) return { ok: false, error: 'translate_not_configured' };

    const res = await callGemini(apiKey, model, {
        contents: [{ role: 'user', parts: [{ text: buildPrompt(source, to.name || to.code, from && (from.name || from.code)) }] }]
    });
    if (!res.ok) {
        log.error('[messenger/translator]', res.error);
        return { ok: false, error: res.error };
    }

    const out = replyText(res.data);
    if (!out) return { ok: false, error: 'model returned no text' };
    return { ok: true, text: out, engine: model };
}

module.exports = { translate, isConfigured, connection, DEFAULT_MODEL };
