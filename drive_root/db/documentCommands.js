'use strict';

/**
 * documentCommands.js — КОМАНДЫ ДОКУМЕНТА «Сторнировать» и «Скорректировать».
 * Механизм ЯДРА: приложение получает их вместе с объявлением встречного
 * документа, не написав ни серверной функции, ни обработчика на клиенте.
 *
 * Регистрируются один раз как серверный скрипт `document.actions`; кнопка формы
 * зовёт их декларацией в лейауте, без клиентского кода:
 *
 *   { "name": "btnStorno",  "command": "storno",  "icon": …, "caption": … }
 *   { "name": "btnCorrect", "command": "correct", "icon": …, "caption": … }
 *
 * Что здесь общего для любого документа, а что остаётся приложению:
 *
 *   ядро      — создать встречный документ, связать с исходным, собрать его
 *               строки (`difference.js`), перевести исходный в «отменён»;
 *   приложение — ВЫСТАВИТЬ документ, потому что выставление собирает печатную
 *               форму и проверяет её реквизиты, а печатная форма у каждого
 *               документа своя. Объявляется именем хука:
 *
 *                 "storno": { …, "issueHook": "invoice.issue" }
 *
 *               Хук получает `{ table, UID, print, sessionID }` и возвращает
 *               `{ error?, html? }`. Нет хука — встречный документ остаётся
 *               черновиком, и это законно: так живёт коррекция, которую ещё
 *               предстоит заполнить.
 *
 * Порядок шагов у сторно неизменен: создать → ВЫСТАВИТЬ → и только потом
 * отменить исходный. Если выставление сорвётся, исходный документ обязан
 * остаться действующим, а не превратиться в отменённый без замены.
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

function modelFor(table) {
    const globalCtx = require('../globalServerContext');
    const name = globalCtx.getModelNameForTable(table);
    return name ? globalCtx.modelsDB[name] : null;
}

/**
 * Выставить документ прикладным хуком, если он объявлен.
 * @returns {Promise<{issued: boolean, error?: string, html?: string}>}
 */
async function issueVia(hookName, table, UID, print, sessionID) {
    if (!hookName) return { issued: false };
    const entityHooks = require('../entityHooks');
    const fn = entityHooks.resolve(hookName);
    if (typeof fn !== 'function') return { issued: false };
    const res = await fn({ table, UID, print, sessionID });
    if (res && res.error) return { issued: false, error: res.error };
    return { issued: true, html: res && res.html };
}

/** Оповестить открытые списки: документ появился/изменился. */
function notify(table, op, uid) {
    try {
        require('../../apps/uniForm/server').notifyTableChange(table, op, uid);
    } catch (e) { /* списков может не быть */ }
}

/**
 * «Сторнировать»: полная отмена. Встречный документ выставляется сразу — у него
 * нечего дозаполнять, он зеркало исходного.
 */
async function stornoDocument({ table, uid, print }, ctx) {
    const sessionID = ctx && ctx.sessionID;
    if (!table || !uid) return { error: await say(sessionID, 'storno_refuse_no_target', 'Документ не найден') };
    const Model = modelFor(table);
    const cfg = Model && storno.stornoConfig(Model);
    if (!cfg) return { error: await say(sessionID, 'storno_refuse_not_declared', 'Для этого документа сторно не объявлено') };

    try {
        const context = { sessionID };
        const { UID: newUID } = await storno.createStorno({
            table, UID: uid, context, t: (key) => say(sessionID, key, key)
        });

        const issued = await issueVia(cfg.issueHook, table, newUID, print, sessionID);
        if (issued.error) {
            // Сторно создан, но не выставлен: исходный документ НЕ отменяем.
            return { error: issued.error, documentUID: newUID, table };
        }

        await storno.cancelSource(table, uid, context);

        const doc = await Model.findByPk(newUID, { raw: true });
        notify(table, 'create', newUID);
        return {
            ok: true, table, documentUID: newUID,
            number: doc && doc.number,
            // Форме исходного документа: показать новое состояние сразу.
            sourceState: cfg.cancelStatus || null,
            stateField: (require('./immutable').readConfig(Model) || {}).field || null,
            html: issued.html,
            // Созданный документ ОТКРЫВАЕТСЯ. Пользователю нужен не факт «создано»,
            // а сам документ: его номер, суммы, возможность распечатать. Сообщение
            // остаётся только на случай, когда открыть окно нечем.
            openDocument: true,
            message: await say(sessionID, 'storno_created', 'Сторно-документ создан:')
        };
    } catch (e) {
        return { error: (e && e.userMessage) || (e && e.message) || String(e) };
    }
}

/**
 * «Скорректировать»: частичное изменение. В отличие от сторно НЕ выставляется —
 * пользователю ещё предстоит сказать, как должно быть. Исходный документ статуса
 * не меняет, он остаётся действующим.
 */
async function correctDocument({ table, uid }, ctx) {
    const sessionID = ctx && ctx.sessionID;
    if (!table || !uid) return { error: await say(sessionID, 'storno_refuse_no_target', 'Документ не найден') };
    const Model = modelFor(table);
    const cfg = Model && storno.counterConfig(Model, 'correction');
    if (!cfg) return { error: await say(sessionID, 'correction_refuse_not_declared', 'Для этого документа коррекция не объявлена') };

    try {
        const { UID: newUID } = await storno.createCorrection({
            table, UID: uid, context: { sessionID }, t: (key) => say(sessionID, key, key)
        });
        const doc = await Model.findByPk(newUID, { raw: true });
        notify(table, 'create', newUID);
        return {
            ok: true, table, documentUID: newUID,
            number: doc && doc.number,
            // Открыть созданный документ: работать пользователь будет в нём.
            openDocument: true,
            message: await say(sessionID, 'correction_created', 'Документ коррекции создан:')
        };
    } catch (e) {
        return { error: (e && e.userMessage) || (e && e.message) || String(e) };
    }
}

/** Регистрация серверного скрипта команд. Зовётся один раз при старте. */
function register(loadServerScript) {
    return loadServerScript('document.actions', {
        storno: stornoDocument,
        correct: correctDocument
    }, 'user');
}

module.exports = { register, stornoDocument, correctDocument };
