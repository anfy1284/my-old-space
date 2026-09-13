'use strict';

/**
 * documentCommands.js — КОМАНДЫ ДОКУМЕНТА «Сторнировать», «Скорректировать»,
 * «Признать недействительным». Механизм ЯДРА: приложение получает их вместе с
 * объявлением в `entityConfig`, не написав ни серверной функции, ни обработчика
 * на клиенте.
 *
 * Регистрируются один раз как серверный скрипт `document.actions`; кнопка формы
 * зовёт их декларацией в лейауте, без клиентского кода:
 *
 *   { "name": "btnStorno",     "command": "storno",     "icon": …, "caption": … }
 *   { "name": "btnCorrect",    "command": "correct",    "icon": …, "caption": … }
 *   { "name": "btnInvalidate", "command": "invalidate", "icon": …, "caption": … }
 *
 * Сторно и коррекция НИЧЕГО НЕ ПИШУТ (13.09.2026): команда собирает встречный
 * документ в памяти (`storno.prepareCounter`) и отдаёт форме `openNew` — клиент
 * открывает НЕСОХРАНЁННУЮ форму. Передумал — закрыл окно, в базе ничего не осталось.
 * Документ создаёт сохранение формы, выставляет — обычная кнопка «Выставить»
 * приложения, а исходный документ сторно отменяется в момент выставления
 * (middleware `dbGateway` → `storno.issuingStornos`/`cancelSourcesOf`).
 *
 * «Недействителен» встречного документа не создаёт и меняет только состояние
 * (`invalidate.js`) — ему открывать нечего.
 */

const storno = require('./storno');

/** Локализованный текст для ответа пользователю. */
async function say(sessionID, key, fallback) {
    try {
        const { tForSession } = require('../../drive_forms/globalServerContext');
        const v = await tForSession(key, sessionID);
        if (v && v !== key) return v;
    } catch (e) { /* перевода нет */ }
    return fallback;
}

/** Оповестить открытые списки: документ изменился. */
function notify(table, op, uid) {
    try {
        require('../../apps/uniForm/server').notifyTableChange(table, op, uid);
    } catch (e) { /* списков может не быть */ }
}

/**
 * Собрать встречный документ вида `kind` и вернуть данные несохранённой формы.
 * Отказы («уже сторнирован», «не выставлен» …) — здесь же, до открытия окна.
 */
async function prepareCounterCommand(kind, { table, uid }, ctx) {
    const sessionID = ctx && ctx.sessionID;
    if (!table || !uid) return { error: await say(sessionID, 'storno_refuse_no_target', 'Документ не найден') };
    try {
        const prep = await storno.prepareCounter({
            table, UID: uid, kind, context: { sessionID }, t: (key) => say(sessionID, key, key)
        });
        return {
            ok: true, table,
            // Параметры открытия формы записи: `prefill`/`prefillTabular` — как у
            // «создать на основании», `counterOf` — природа документа, которую при
            // сохранении проверит и запишет ядро (storno.verifyCounter/stampCounter).
            openNew: { prefill: prep.prefill, prefillTabular: prep.prefillTabular, counterOf: prep.counterOf }
        };
    } catch (e) {
        return { error: (e && e.userMessage) || (e && e.message) || String(e) };
    }
}

/** «Сторнировать»: полная отмена. */
async function stornoDocument(params, ctx) {
    return await prepareCounterCommand('storno', params || {}, ctx);
}

/** «Скорректировать»: частичное изменение, исходный документ остаётся действующим. */
async function correctDocument(params, ctx) {
    return await prepareCounterCommand('correction', params || {}, ctx);
}

/**
 * «Признать недействительным» (Ungültig): встречного документа нет, меняется только
 * состояние (`invalidate.js`). Форме возвращается новое состояние — она покажет его
 * сразу; открывать нечего, поэтому ответ несёт сообщение.
 */
async function invalidateCommand({ table, uid }, ctx) {
    const sessionID = ctx && ctx.sessionID;
    if (!table || !uid) return { error: await say(sessionID, 'storno_refuse_no_target', 'Документ не найден') };
    try {
        const res = await require('./invalidate').invalidateDocument({
            table, UID: uid, context: { sessionID }, t: (key) => say(sessionID, key, key)
        });
        notify(table, 'update', uid);
        return {
            ok: true, table, documentUID: uid,
            number: res.number,
            sourceState: res.status,
            stateField: res.field,
            message: await say(sessionID, 'invalidate_done', 'Документ признан недействительным:')
        };
    } catch (e) {
        return { error: (e && e.userMessage) || (e && e.message) || String(e) };
    }
}

/** Регистрация серверного скрипта команд. Зовётся один раз при старте. */
function register(loadServerScript) {
    return loadServerScript('document.actions', {
        storno: stornoDocument,
        correct: correctDocument,
        invalidate: invalidateCommand
    }, 'user');
}

module.exports = { register, stornoDocument, correctDocument, invalidateCommand };
