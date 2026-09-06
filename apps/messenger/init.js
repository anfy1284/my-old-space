'use strict';

// Точка регистрации приложения «messenger» (приложение фреймворка).
// Вызывается фреймворком при старте по записи в drive_forms/apps.json.
//
// Мессенджер — standalone-приложение с одним окном:
//   forms/messenger.layout.json — лейаут окна (список чатов + лента переписки)
//   forms/messenger.server.js   — модуль-фабрика: чаты, история, отправка, статусы
//   forms/messenger.client.js   — обвязка окна (onReady) + обработчик уведомления
//   resources/public/client.js  — точка входа: строит окно, отдаёт ему getFormSpec
//   server.js                   — тонкий бинарный маршрут выдачи вложений
//
// Здесь же живёт заведение чатов: личный чат на каждую пару пользователей и
// общий чат для всех. Это делает ПРИЛОЖЕНИЕ при старте и при появлении нового
// пользователя, а не пользователь руками: переписка должна работать сразу.

const path = require('path');
const fs = require('fs');

const globalRoot = require('../../drive_root/globalServerContext');
const eventBus = require('../../drive_root/eventBus');
const i18n = require('../../drive_root/i18n');
const log = require('../../drive_root/log');

const SERVER_SCRIPT_NAME = 'messenger.actions';
const COMMON_CHAT_ID = '000000000-messenger_chats-0001';

/**
 * Рекурсивно переводит ЛЮБОЙ объект вида { i18n: 'ключ' } в дереве лейаута.
 *
 * Не только `caption`: у контролов есть и другие пользовательские строки
 * (`properties.emptyText` списка чатов). Обходчик, знающий одно поле, такие
 * строки молча оставлял бы объектом — на экране появилось бы «[object Object]».
 */
function translateTree(node, lang) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(n => translateTree(n, lang));
    if (typeof node.i18n === 'string') return i18n.t(node.i18n, lang);
    const out = {};
    for (const key of Object.keys(node)) out[key] = translateTree(node[key], lang);
    return out;
}

// ── Заведение чатов ──────────────────────────────────────────────────────────

/** Личный чат двух пользователей: найти существующий или создать. */
async function ensurePrivateChat(modelsDB, u1, u2) {
    const Members = modelsDB.MessengerChatMembers;
    const Chats = modelsDB.MessengerChats;

    const memberships = await Members.findAll({ where: { userId: [u1.UID, u2.UID] }, raw: true });
    const byChat = new Map();
    for (const m of memberships) {
        const arr = byChat.get(m.chatId) || [];
        arr.push(m.userId);
        byChat.set(m.chatId, arr);
    }
    for (const [, users] of byChat) {
        const set = new Set(users);
        if (set.size === 2 && set.has(u1.UID) && set.has(u2.UID)) return null; // уже есть
    }

    const chat = await Chats.create({
        userId: u1.UID,
        // Имя личного чата — служебное: в списке показывается имя собеседника,
        // а не это значение (см. loadChats).
        name: `${u1.name} ↔ ${u2.name}`,
        kind: 'private',
        isActive: true
    });
    const now = new Date();
    await Members.bulkCreate([
        { chatId: chat.UID, userId: u1.UID, role: 'owner', customName: u2.name, joinedAt: now, isActive: true },
        { chatId: chat.UID, userId: u2.UID, role: 'member', customName: u1.name, joinedAt: now, isActive: true }
    ]);
    return chat.UID;
}

/** Все пользователи должны состоять в общем чате. */
async function ensureCommonChatMembership(modelsDB, users) {
    const Members = modelsDB.MessengerChatMembers;
    // Реестр предопределённых записей ключуется ИМЕНЕМ ТАБЛИЦЫ, а не модели
    // (см. getDefaultValue в drive_root/globalServerContext.js).
    const common = globalRoot.getDefaultValue('messenger', 'messenger_chats', COMMON_CHAT_ID);
    if (!common) {
        log.debug('[messenger/init] предопределённый общий чат не найден');
        return;
    }
    const existing = await Members.findAll({ where: { chatId: common.UID }, attributes: ['userId'], raw: true });
    const have = new Set(existing.map(m => m.userId));
    const now = new Date();
    for (const u of users) {
        if (have.has(u.UID)) continue;
        await Members.create({
            chatId: common.UID,
            userId: u.UID,
            role: u.UID === common.userId ? 'owner' : 'member',
            joinedAt: now,
            isActive: true
        });
    }
}

/** Досоздать недостающие чаты для всех пользователей (старт сервера). */
async function provisionChats(modelsDB) {
    if (!modelsDB || !modelsDB.Users || !modelsDB.MessengerChats || !modelsDB.MessengerChatMembers) {
        log.debug('[messenger/init] модели недоступны, заведение чатов пропущено');
        return;
    }
    const users = await modelsDB.Users.findAll({ attributes: ['UID', 'name'], raw: true });
    for (let i = 0; i < users.length; i++) {
        for (let j = i + 1; j < users.length; j++) {
            try { await ensurePrivateChat(modelsDB, users[i], users[j]); }
            catch (e) { log.error('[messenger/init] личный чат не создан:', e && e.message); }
        }
    }
    try { await ensureCommonChatMembership(modelsDB, users); }
    catch (e) { log.error('[messenger/init] общий чат:', e && e.message); }
}

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../');
        const { getSessionContext } = require('../../drive_forms/globalServerContext');
        const notificationHandlers = require('../../drive_root/notificationHandlers');

        const serverFns = require('./forms/messenger.server')(modelsDB, Utilities);

        // Клиентский скрипт формы: он же держит обработчик клика по уведомлению.
        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/messenger.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, SERVER_SCRIPT_NAME);
        const clientUID = await loadScript(clientSource, 'user');
        notificationHandlers.register('messenger', clientUID);

        // Лейаут читаем ТЕКСТОМ: в свойствах ленты стоит тот же плейсхолдер
        // __SERVER_SCRIPT__, что и в клиентском скрипте — контрол ходит на сервер сам.
        const layoutRaw = JSON.parse(
            fs.readFileSync(path.join(__dirname, 'forms/messenger.layout.json'), 'utf8')
                .replace(/__SERVER_SCRIPT__/g, SERVER_SCRIPT_NAME)
        );

        /**
         * Спецификация окна для клиента: переведённый лейаут, UID клиентского
         * скрипта и form-level событие onReady, в котором форма связывает контролы.
         */
        async function getFormSpec(params, ctx) {
            let language = 'en';
            try {
                const sctx = await getSessionContext(ctx && ctx.sessionID);
                language = (sctx && sctx.language) || 'en';
            } catch (e) { /* язык по умолчанию */ }

            const layout = translateTree(JSON.parse(JSON.stringify(layoutRaw)), language);

            // Значения, известные только в рантайме, кладём в свойства ленты:
            // чьи сообщения считать своими и какой файл считать слишком большим.
            const user = (ctx && ctx.user) || await globalRoot.getUserBySessionID(ctx && ctx.sessionID);
            const feed = layout[0] && (layout[0].layout || []).find(n => n.type === 'messageFeed');
            if (feed) {
                feed.properties = feed.properties || {};
                feed.properties.currentUserId = user ? user.UID : null;
                feed.properties.maxAttachmentBytes = await serverFns.maxAttachmentBytes();
            }

            return {
                layout,
                clientScript: clientUID,
                events: { onReady: 'onFormReady' },
                appCaption: i18n.t('messenger_app_caption', language)
            };
        }

        loadServerScript(SERVER_SCRIPT_NAME, Object.assign({}, serverFns, { getFormSpec }), 'user');

        // Новый пользователь — сразу с чатами: иначе он есть в системе, но
        // написать ему некуда.
        eventBus.on('userCreated', async (user) => {
            if (!user || !user.UID) return;
            try { await provisionChats(globalRoot.modelsDB || modelsDB); }
            catch (e) { log.error('[messenger/init] чаты нового пользователя:', e && e.message); }
        });

        await provisionChats(modelsDB);

        console.log('[messenger/init] Registered layout, server script and notification handler');
    } catch (e) {
        console.error('[messenger/init] Failed:', e && e.message || e);
    }
};
