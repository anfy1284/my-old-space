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
// Здесь же живёт заведение чатов. Это делает ПРИЛОЖЕНИЕ при старте и при появлении
// нового пользователя, а не пользователь руками: переписка должна работать сразу.
// Кому с кем — см. needsAutoChat: с администратором всем, между собой — только
// внутри одной области доступа (drive_root/accessScopes). Общего чата по умолчанию
// нет. Это правило ЗАВЕДЕНИЯ, а не запрет: чат, созданный вручную поперёк границы,
// работает как любой другой.

const path = require('path');
const fs = require('fs');

const globalRoot = require('../../drive_root/globalServerContext');
const eventBus = require('../../drive_root/eventBus');
const i18n = require('../../drive_root/i18n');
const log = require('../../drive_root/log');
const appAvailability = require('../../drive_root/appAvailability');
const accessScopes = require('../../drive_root/accessScopes');
const userPresentation = require('../../drive_root/userPresentation');

const APP_NAME = 'messenger';
const SERVER_SCRIPT_NAME = 'messenger.actions';

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

    // Представление, а не логин: это имя видит человек (drive_root/userPresentation.js).
    const p1 = userPresentation.presentationOf(u1);
    const p2 = userPresentation.presentationOf(u2);

    const chat = await Chats.create({
        userId: u1.UID,
        // Имя личного чата — служебное: в списке показывается имя собеседника,
        // а не это значение (см. loadChats).
        name: `${p1} ↔ ${p2}`,
        kind: 'private',
        isActive: true
    });
    const now = new Date();
    await Members.bulkCreate([
        { chatId: chat.UID, userId: u1.UID, role: 'owner', customName: p2, joinedAt: now, isActive: true },
        { chatId: chat.UID, userId: u2.UID, role: 'member', customName: p1, joinedAt: now, isActive: true }
    ]);
    return chat.UID;
}

/**
 * Кому автоматически заводить переписку: `Map<UID, { admin, scopes }>`.
 *
 * Администратор — по роли (`drive_forms/globalServerContext.getUserAccessRole`),
 * области доступа — у решения (`drive_root/accessScopes`): ядро не знает слова
 * «организация», границу объявляет проект своим резолвером.
 */
async function autoChatProfiles(users) {
    const { getUserAccessRole } = require('../../drive_forms/globalServerContext');
    const out = new Map();
    for (const u of users) {
        let admin = false;
        try { admin = (await getUserAccessRole({ UID: u.UID })) === 'admin'; }
        catch (e) { log.error('[messenger/init] роль пользователя не определена:', e && e.message); }
        out.set(u.UID, { admin, scopes: await accessScopes.scopesOf(u.UID) });
    }
    return out;
}

/**
 * Нужна ли этой паре переписка ПО УМОЛЧАНИЮ.
 *
 * Правило (решение владельца 13.09.2026):
 *   • с администратором переписка есть у всех — он единственный, к кому идут со всем;
 *   • остальные — только внутри своей области доступа (у нас это организация):
 *     сотрудникам разных клиентов незачем видеть друг друга в списке.
 *
 * Это правило ЗАВЕДЕНИЯ, а не запрет на общение: чат, созданный вручную поперёк
 * границы, работает как любой другой — отбора по областям в `loadChats` нет и не
 * должно быть. Пары без общей области просто не появляются сами.
 */
function needsAutoChat(a, b) {
    if (a.admin || b.admin) return true;
    return accessScopes.share(a.scopes, b.scopes);
}

/** Досоздать недостающие чаты для всех пользователей (старт сервера). */
async function provisionChats(modelsDB) {
    if (!modelsDB || !modelsDB.Users || !modelsDB.MessengerChats || !modelsDB.MessengerChatMembers) {
        log.debug('[messenger/init] модели недоступны, заведение чатов пропущено');
        return;
    }
    // Чаты заводятся ВСЕМ, включая тех, у кого мессенджер сейчас выключен: настройку
    // включают в любой момент, а заведение чатов происходит только при старте и при
    // появлении нового пользователя. Иначе включённому пришлось бы ждать перезапуска.
    // Из списков его при этом не видно — отбор живёт в loadChats.
    const users = await modelsDB.Users.findAll({ attributes: userPresentation.ATTRIBUTES, raw: true });
    const profiles = await autoChatProfiles(users);

    // Решение не объявило границы — переписка между не-администраторами не заведётся
    // ни у кого. Это законная настройка (система на одного человека), но чаще это
    // незарегистрированный резолвер, и молчать об этом нельзя: снаружи выглядит как
    // «мессенджер сломался».
    if (!accessScopes.hasResolvers() && users.filter(u => !profiles.get(u.UID).admin).length > 1) {
        log.warn('[messenger/init] области доступа не объявлены (drive_root/accessScopes) — '
               + 'переписка заводится только с администратором');
    }

    let created = 0;
    for (let i = 0; i < users.length; i++) {
        for (let j = i + 1; j < users.length; j++) {
            const a = profiles.get(users[i].UID);
            const b = profiles.get(users[j].UID);
            if (!a || !b || !needsAutoChat(a, b)) continue;
            try {
                if (await ensurePrivateChat(modelsDB, users[i], users[j])) created++;
            } catch (e) {
                log.error('[messenger/init] личный чат не создан:', e && e.message);
            }
        }
    }
    log.debug(`[messenger/init] пользователей: ${users.length}, заведено чатов: ${created}`);

    // Общего чата по умолчанию НЕТ (решение владельца 13.09.2026): типичный клиент —
    // один-два человека, и «чат со всеми» у них совпадает с личным. Предопределённая
    // запись чата (defaultValues.json) остаётся якорем для будущей групповой
    // переписки, но в участники никого не добавляем: чат без участников никому не
    // виден и ничего не стоит. Раньше здесь жил ensureCommonChatMembership.
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
        // Роль здесь, в loadServerScript и в config.access должны совпадать:
        // иначе приложения на экране нет, а его RPC остаётся вызываемым по имени.
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

        // Выключатель приложения закрывает и RPC: клиентский запрет — это про экран,
        // а вызов по имени серверного скрипта остаётся доступным (serverScriptStore
        // знает имя, но не знает приложения). Одна обёртка на всю регистрацию.
        loadServerScript(
            SERVER_SCRIPT_NAME,
            appAvailability.guard(APP_NAME, Object.assign({}, serverFns, { getFormSpec })),
            'user'
        );

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
