'use strict';

/**
 * Серверный модуль мессенджера.
 *
 * ── Почему доступ идёт напрямую через модели, а не через dbGateway ───────────
 * Право на чат даёт УЧАСТИЕ в нём, а RLS фреймворка умеет фильтровать только по
 * трём реквизитам (организация, отель, пользователь). По `userId` строка чата
 * досталась бы одному владельцу, а сообщения — только их авторам: переписка
 * перестала бы существовать как переписка. Поэтому здесь модели используются
 * напрямую, а право проверяется явно — функцией `requireMember` перед каждой
 * операцией. Реквизиты доступа в таблицах при этом объявлены (валидатор
 * обязательных реквизитов проходит), и случайный запрос через шлюз отдаёт
 * МЕНЬШЕ, чем нужно, а не больше — ошибка в безопасную сторону.
 *
 * ── Доставка ─────────────────────────────────────────────────────────────────
 * Своего SSE-канала у мессенджера больше нет: он ходит по сессионному каналу
 * ядра (`/app/events`) адресной отправкой `sendSessionEventToUser`. Один поток
 * на окно вместо потока на каждый открытый чат.
 *
 * ── Вложения ────────────────────────────────────────────────────────────────
 * Лежат в базе (таблица `messenger_attachments`), а не на диске: прод работает в
 * контейнере без томов, и файлы на диске не переживают деплой и не попадают в
 * резервную копию. Приходят base64-строкой в обычном RPC — отдельного канала
 * загрузки заводить не пришлось. Отдаёт их бинарно тонкий слой `server.js`.
 */

const { Op } = require('sequelize');
const emptyValues = require('../../../drive_root/db/emptyValues');
const globalRoot = require('../../../drive_root/globalServerContext');
const appAvailability = require('../../../drive_root/appAvailability');
const userPresentation = require('../../../drive_root/userPresentation');
const presence = require('../../../drive_root/presence');
const translator = require('../lib/translator');
const translationContext = require('../lib/translationContext');
const log = require('../../../drive_root/log');
const { sendSessionEventToUser } = require('../../../drive_forms/dynamicTableRegistry');
const { tForSession } = require('../../../drive_forms/globalServerContext');

const APP_NAME = 'messenger';
const MESSENGER_ICON = '/apps/general_icons/resources/public/16x16/email.png';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const THUMB_SIZE = 240;
// Обрезка текста в уведомлении и в превью списка чатов: карточка в углу экрана
// и строка списка — это анонс, а не место для чтения переписки.
const PREVIEW_LIMIT = 60;
const NOTIFY_LIMIT = 160;
// Сколько последних сообщений чата получает переводчик как контекст. Хватает, чтобы
// понять, о чём речь и как называются вещи, и не раздувать каждый запрос к модели.
const TRANSLATION_HISTORY = 8;

// Какой чат сейчас открыт у пользователя: userId → { chatId, at }. Живёт в
// памяти процесса — сведения сиюминутные, переживать перезапуск им незачем.
// Нужно ровно для одного: не слать уведомление тому, кто и так смотрит в этот чат.
if (!global.messengerActiveChat) global.messengerActiveChat = new Map();
const activeChat = global.messengerActiveChat;

// Отметка протухает. Клиент честно снимает её при сворачивании окна и закрытии,
// но вкладку могут убить, браузер — уснуть, сеть — оборваться. Тогда отметка
// осталась бы навсегда и человек молча перестал бы получать уведомления из
// этого чата. Из двух ошибок выбираем лишнее уведомление, а не потерянное.
const ACTIVE_CHAT_TTL_MS = 10 * 60 * 1000;

function isLookingAt(userId, chatId) {
    const entry = activeChat.get(userId);
    if (!entry || entry.chatId !== chatId) return false;
    if (Date.now() - entry.at > ACTIVE_CHAT_TTL_MS) { activeChat.delete(userId); return false; }
    return true;
}

function touchActiveChat(userId, chatId) {
    if (chatId) activeChat.set(userId, { chatId: chatId, at: Date.now() });
    else activeChat.delete(userId);
}

function shorten(text, limit) {
    const s = String(text || '');
    return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
}

// Незаполненная дата в этой системе — НЕ NULL, а `0001-01-01`: фреймворк
// проставляет её умолчанием каждому необязательному полю-дате
// (drive_root/db/emptyValues.js, правило «у каждого типа своё пустое»). Поэтому
// «прочитано» нельзя проверять ни через `!= null`, ни через истинность значения:
// пустая дата — объект Date и истинна. Отсюда две вещи ниже: условие отбора
// сравнивает со значением пустой даты, а признак — через isEmptyDate.
const EMPTY_DATE = emptyValues.EMPTY_DATE;
const FILLED = { [Op.gt]: EMPTY_DATE };
const isFilled = (v) => !emptyValues.isEmptyDate(v);

module.exports = function factory(modelsDB, Utilities) {

    const Chats = () => modelsDB.MessengerChats;
    const Members = () => modelsDB.MessengerChatMembers;
    const Messages = () => modelsDB.MessengerMessages;
    const Reads = () => modelsDB.MessengerMessageReads;
    const Attachments = () => modelsDB.MessengerAttachments;
    const Translations = () => modelsDB.MessengerMessageTranslations;
    const Languages = () => modelsDB.Languages;
    const Users = () => modelsDB.Users;

    // ── Языки и настройки перевода ──────────────────────────────────────────
    /**
     * Справочник языков: UID → { UID, code, name }, плюс тот же объект по коду.
     * Читается запросом, а не из кэша: языков единицы, а кэш настроек и справочников
     * в этой системе уже стрелял (см. drive_root/settings/index.js).
     */
    async function languageIndex() {
        const out = { byId: new Map(), byCode: new Map(), list: [] };
        if (!Languages()) return out;
        const rows = await Languages().findAll({ attributes: ['UID', 'code', 'name'], raw: true });
        for (const r of rows) {
            const item = { UID: r.UID, code: r.code, name: r.name };
            out.byId.set(r.UID, item);
            out.byCode.set(r.code, item);
            out.list.push(item);
        }
        return out;
    }

    /**
     * Настройки перевода пользователя: что ему включено и на какой язык он читает.
     * @returns {Promise<{incoming: boolean, outgoing: boolean, language: Object|null}>}
     */
    async function translationPrefs(userId, langs) {
        const settings = require('../../../drive_root/settings');
        const empty = { incoming: false, outgoing: false, language: null };
        if (!userId) return empty;
        try {
            const [incoming, outgoing, languageId] = await Promise.all([
                settings.getUserSetting(userId, APP_NAME, 'translateIncoming'),
                settings.getUserSetting(userId, APP_NAME, 'translateOutgoing'),
                settings.getUserSetting(userId, APP_NAME, 'translateLanguage')
            ]);
            const index = langs || await languageIndex();
            return {
                incoming: !!incoming,
                outgoing: !!outgoing,
                language: languageId ? (index.byId.get(String(languageId)) || null) : null
            };
        } catch (e) {
            log.error('[messenger] настройки перевода', userId, e && e.message);
            return empty;
        }
    }

    /**
     * На какой язык читает получатель. Пусто — переводить незачем: либо перевод ему
     * выключен, либо язык не выбран, и угадывать его за администратора нельзя.
     */
    function readingLanguageOf(prefs) {
        return (prefs && prefs.incoming && prefs.language) ? prefs.language : null;
    }

    async function currentUser(ctx) {
        if (ctx && ctx.user && ctx.user.UID) return ctx.user;
        return await globalRoot.getUserBySessionID(ctx && ctx.sessionID);
    }

    /** Пользователь и его участие в чате — или null, если он не участник. */
    async function requireMember(ctx, chatId) {
        const user = await currentUser(ctx);
        if (!user || !chatId) return null;
        const membership = await Members().findOne({
            where: { chatId: chatId, userId: user.UID, isActive: true },
            raw: true
        });
        if (!membership) return null;
        return { user, membership };
    }

    /** Активные участники чата (простые объекты). */
    async function chatMembers(chatId) {
        return await Members().findAll({ where: { chatId: chatId, isActive: true }, raw: true });
    }

    // ── Кого мессенджер не показывает ───────────────────────────────────────
    /**
     * Личный собеседник каждого чата: chatId → UID (null, если чат групповой).
     *
     * @param {Array} chats — записи чатов (нужен `kind`)
     * @param {Array} allMembers — активные участники этих чатов
     * @param {string} myId — чья точка зрения
     * @returns {Map<string, string|null>}
     */
    function peerByChatFrom(chats, allMembers, myId) {
        const byChat = new Map();
        for (const m of allMembers) {
            if (!byChat.has(m.chatId)) byChat.set(m.chatId, []);
            byChat.get(m.chatId).push(m);
        }
        const out = new Map();
        for (const c of chats) {
            const others = (byChat.get(c.UID) || []).filter(m => m.userId !== myId);
            const isGroup = c.kind === 'group' || others.length > 1;
            out.set(c.UID, (!isGroup && others.length === 1) ? others[0].userId : null);
        }
        return out;
    }

    /**
     * Чаты, которых пользователю видеть не должно: личная переписка с тем, у кого
     * мессенджер выключен. Такой человек для мессенджера не существует — ни строкой
     * в списке, ни цифрой на значке: счётчик непрочитанного, который нельзя обнулить,
     * хуже отсутствующего.
     *
     * Общий чат остаётся у всех: выключенный участник в нём просто молчит.
     *
     * @param {Map<string, string|null>} peerByChat — результат peerByChatFrom
     * @returns {Promise<Set<string>>} UID чатов, которые надо скрыть
     */
    async function hiddenChatIds(peerByChat) {
        const peers = Array.from(peerByChat.values()).filter(Boolean);
        const hidden = new Set();
        if (!peers.length) return hidden;
        const enabled = await appAvailability.enabledMapForUsers(peers, APP_NAME);
        for (const [chatId, peer] of peerByChat) {
            if (peer && enabled.get(peer) === false) hidden.add(chatId);
        }
        return hidden;
    }

    // ── Формирование вида сообщения для клиента ─────────────────────────────
    /**
     * @param {Array} rows — строки сообщений
     * @param {string} chatId
     * @param {string} viewerId — чьими глазами смотрим (галочки, «моё/чужое»)
     * @param {string} [viewerLangCode] — язык чтения зрителя; с ним к сообщению
     *        прикладывается ПЕРЕВОД. Оригинал при этом остаётся в `content` —
     *        переключатель «оригиналы/переводы» работает без похода на сервер.
     */
    async function decorateMessages(rows, chatId, viewerId, viewerLangCode) {
        if (!rows.length) return [];
        const ids = rows.map(r => r.UID);

        const translationByMsg = {};
        if (viewerLangCode && Translations()) {
            try {
                const trs = await Translations().findAll({
                    where: { messageId: ids, language: viewerLangCode },
                    attributes: ['messageId', 'content'], raw: true
                });
                for (const t of trs) translationByMsg[t.messageId] = t.content || '';
            } catch (e) {
                log.error('[messenger] переводы не прочитаны:', e && e.message);
            }
        }

        const [atts, receipts, authors] = await Promise.all([
            Attachments().findAll({
                where: { messageId: ids },
                // Содержимое файла НЕ выбираем: список сообщений тянул бы за собой
                // все картинки чата. Байты отдаёт отдельный бинарный маршрут.
                attributes: ['UID', 'messageId', 'name', 'mimeType', 'size', 'isImage'],
                raw: true
            }),
            Reads().findAll({ where: { messageId: ids }, raw: true }),
            Users().findAll({
                where: { UID: Array.from(new Set(rows.map(r => r.userId))) },
                attributes: userPresentation.ATTRIBUTES,
                raw: true
            })
        ]);

        const attByMsg = {};
        atts.forEach(a => { (attByMsg[a.messageId] = attByMsg[a.messageId] || []).push(a); });

        const recByMsg = {};
        receipts.forEach(r => { (recByMsg[r.messageId] = recByMsg[r.messageId] || []).push(r); });

        // Подпись автора — представление, а не логин (drive_root/userPresentation.js).
        const nameById = {};
        authors.forEach(u => { nameById[u.UID] = userPresentation.presentationOf(u); });

        const members = await chatMembers(chatId);

        return rows.map(r => {
            const rec = recByMsg[r.UID] || [];
            // Получатели — все участники, кроме автора: галочки отражают путь
            // сообщения к другим, а не к самому себе.
            const recipientCount = Math.max(0, members.filter(m => m.userId !== r.userId).length);
            return {
                UID: r.UID,
                chatId: r.chatId,
                authorId: r.userId,
                authorName: nameById[r.userId] || '',
                content: r.content || '',
                // Перевод — рядом с оригиналом, а не вместо него. Автор своих
                // сообщений перевода не получает: он написал их сам.
                translation: (r.userId !== viewerId && translationByMsg[r.UID]) ? translationByMsg[r.UID] : null,
                // Набранный текст — ТОЛЬКО автору. Для получателя этого текста не
                // существует: ему пришло обычное сообщение, и знать, что оно
                // переведено, ему незачем.
                original: (r.userId === viewerId && r.originalContent) ? r.originalContent : null,
                clientMsgId: r.clientMsgId || null,
                createdAt: r.createdAt,
                attachments: (attByMsg[r.UID] || []).map(a => ({
                    UID: a.UID, name: a.name, mimeType: a.mimeType, size: a.size, isImage: !!a.isImage
                })),
                recipientCount: recipientCount,
                deliveredCount: rec.filter(x => x.userId !== r.userId && isFilled(x.deliveredAt)).length,
                readCount: rec.filter(x => x.userId !== r.userId && isFilled(x.readAt)).length,
                readByMe: !!rec.find(x => x.userId === viewerId && isFilled(x.readAt))
            };
        });
    }

    // ── Список чатов ────────────────────────────────────────────────────────
    /**
     * Чаты пользователя в виде «входящих»: имя, превью последнего сообщения,
     * время, счётчик непрочитанного и присутствие собеседника.
     */
    async function loadChats(params, ctx) {
        const user = await currentUser(ctx);
        if (!user) return { error: await tForSession('User not authorized', ctx.sessionID) };

        const myMemberships = await Members().findAll({
            where: { userId: user.UID, isActive: true }, raw: true
        });
        if (!myMemberships.length) return { chats: [] };

        const chatIds = myMemberships.map(m => m.chatId);
        const chats = await Chats().findAll({ where: { UID: chatIds, isActive: true }, raw: true });
        if (!chats.length) return { chats: [] };

        const liveIds = chats.map(c => c.UID);

        // Последнее сообщение каждого чата и непрочитанное — двумя запросами на
        // все чаты сразу, а не по запросу на чат: список открывается на каждом
        // показе окна.
        // Прочитанное этим пользователем — отдельным запросом ДО остальных:
        // от него зависит выборка непрочитанного. Пустой список подменяем
        // заведомо несуществующим значением: `NOT IN ()` — синтаксическая
        // ошибка, и «непрочитанных нет» превратилось бы в отказ запроса.
        const readIds = (await Reads().findAll({
            where: { userId: user.UID, chatId: liveIds, readAt: FILLED },
            attributes: ['messageId'], raw: true
        })).map(r => r.messageId);
        const notRead = readIds.length ? readIds : ['-'];

        const [lastRows, unreadRows, allMembers] = await Promise.all([
            Messages().findAll({
                where: { chatId: liveIds },
                order: [['createdAt', 'DESC'], ['UID', 'DESC']],
                raw: true
            }),
            Messages().findAll({
                where: {
                    chatId: liveIds,
                    userId: { [Op.ne]: user.UID },
                    UID: { [Op.notIn]: notRead }
                },
                attributes: ['UID', 'chatId'], raw: true
            }),
            Members().findAll({ where: { chatId: liveIds, isActive: true }, raw: true })
        ]);

        const lastByChat = {};
        for (const m of lastRows) if (!lastByChat[m.chatId]) lastByChat[m.chatId] = m;

        const unreadByChat = {};
        unreadRows.forEach(m => { unreadByChat[m.chatId] = (unreadByChat[m.chatId] || 0) + 1; });

        // Собеседник в переписке вдвоём — чтобы показать его присутствие и его
        // имя вместо служебного названия чата.
        const membersByChat = {};
        allMembers.forEach(m => { (membersByChat[m.chatId] = membersByChat[m.chatId] || []).push(m); });

        const peerByChat = peerByChatFrom(chats, allMembers, user.UID);
        const peerIds = Array.from(peerByChat.values()).filter(Boolean);

        const [peers, presenceMap, hidden] = await Promise.all([
            peerIds.length ? Users().findAll({ where: { UID: peerIds }, attributes: userPresentation.ATTRIBUTES, raw: true }) : [],
            presence.getPresence(peerIds),
            hiddenChatIds(peerByChat)
        ]);
        const peerName = {};
        peers.forEach(u => { peerName[u.UID] = userPresentation.presentationOf(u); });

        const out = chats.map(c => {
            if (hidden.has(c.UID)) return null;
            const others = (membersByChat[c.UID] || []).filter(m => m.userId !== user.UID);
            const isGroup = c.kind === 'group' || others.length > 1;
            const peer = peerByChat.get(c.UID) || null;
            const last = lastByChat[c.UID] || null;
            return {
                chatId: c.UID,
                name: peer ? (peerName[peer] || c.name) : c.name,
                isGroup: isGroup,
                peerId: peer,
                online: peer ? !!(presenceMap[peer] && presenceMap[peer].online) : null,
                lastSeenAt: peer ? (presenceMap[peer] && presenceMap[peer].lastSeenAt) || null : null,
                preview: last ? shorten(last.content || '', PREVIEW_LIMIT) : '',
                lastMessageAt: last ? last.createdAt : c.lastMessageAt,
                unread: unreadByChat[c.UID] || 0
            };
        }).filter(Boolean);

        // Свежие разговоры сверху — чат без сообщений уходит вниз, а не наверх.
        out.sort((a, b) => {
            const ta = isFilled(a.lastMessageAt) ? new Date(a.lastMessageAt).getTime() : 0;
            const tb = isFilled(b.lastMessageAt) ? new Date(b.lastMessageAt).getTime() : 0;
            return tb - ta;
        });

        return { chats: out, unreadTotal: out.reduce((n, c) => n + c.unread, 0) };
    }

    // ── История сообщений ───────────────────────────────────────────────────
    /**
     * Страница истории. `before` — UID сообщения, СТАРШЕ которого нужно отдать
     * (прокрутка вверх). Порядок — по времени, с UID как тай-брейком: у двух
     * сообщений одной секунды иначе нет устойчивого порядка, и при подгрузке
     * они меняются местами.
     */
    async function loadMessages(params, ctx) {
        const chatId = params && params.chatId;
        const access = await requireMember(ctx, chatId);
        if (!access) return { error: await tForSession('Access denied', ctx.sessionID) };

        const limit = Math.min(Math.max(Number(params.limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
        const where = { chatId: chatId };

        if (params.before) {
            const anchor = await Messages().findOne({ where: { UID: params.before }, raw: true });
            if (anchor) {
                where[Op.or] = [
                    { createdAt: { [Op.lt]: anchor.createdAt } },
                    { createdAt: anchor.createdAt, UID: { [Op.lt]: anchor.UID } }
                ];
            }
        }

        // Тянем на одну строку больше запрошенного — так узнаём, есть ли ещё
        // история, не делая второго запроса на подсчёт.
        const rows = await Messages().findAll({
            where,
            order: [['createdAt', 'DESC'], ['UID', 'DESC']],
            limit: limit + 1,
            raw: true
        });
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit).reverse();

        const myPrefs = await translationPrefs(access.user.UID);
        const myLang = readingLanguageOf(myPrefs);
        const messages = await decorateMessages(page, chatId, access.user.UID, myLang && myLang.code);

        // Показанное считается доставленным: получатель эти сообщения получил,
        // даже если ещё не отметил прочтение прокруткой.
        await markDelivered(access.user.UID, chatId, page.filter(m => m.userId !== access.user.UID).map(m => m.UID));

        return { messages, hasMore };
    }

    /** Отметка доставки. Тихая: отправителю уходит обновлением галочек. */
    async function markDelivered(userId, chatId, messageIds) {
        if (!messageIds || !messageIds.length) return;
        try {
            const now = new Date();
            for (const id of messageIds) {
                await Reads().findOrCreate({
                    where: { messageId: id, userId: userId },
                    defaults: { messageId: id, userId: userId, chatId: chatId, deliveredAt: now }
                });
            }
            await pushReceipts(chatId, messageIds);
        } catch (e) {
            log.debug('[messenger] markDelivered:', e && e.message);
        }
    }

    /** Отметка прочтения — по каждому сообщению отдельной строкой. */
    async function markRead(params, ctx) {
        const chatId = params && params.chatId;
        const access = await requireMember(ctx, chatId);
        if (!access) return { error: await tForSession('Access denied', ctx.sessionID) };

        // Читает — значит смотрит: продлеваем отметку, чтобы она не протухла
        // у того, кто давно сидит в одном чате и не переключался.
        touchActiveChat(access.user.UID, chatId);

        const ids = Array.isArray(params.messageIds) ? params.messageIds : [];
        if (!ids.length) return { success: true };

        const now = new Date();
        for (const id of ids) {
            const [row] = await Reads().findOrCreate({
                where: { messageId: id, userId: access.user.UID },
                defaults: { messageId: id, userId: access.user.UID, chatId: chatId, deliveredAt: now, readAt: now }
            });
            if (!isFilled(row.readAt)) await row.update({ readAt: now, deliveredAt: isFilled(row.deliveredAt) ? row.deliveredAt : now });
        }
        await pushReceipts(chatId, ids);
        return { success: true, unreadTotal: await unreadTotalFor(access.user.UID) };
    }

    /** Сообщить авторам, что их сообщения доставлены/прочитаны. */
    async function pushReceipts(chatId, messageIds) {
        try {
            const rows = await Messages().findAll({ where: { UID: messageIds }, attributes: ['UID', 'userId'], raw: true });
            if (!rows.length) return;
            const receipts = await Reads().findAll({ where: { messageId: messageIds }, raw: true });
            const byAuthor = {};
            for (const m of rows) {
                const rec = receipts.filter(r => r.messageId === m.UID && r.userId !== m.userId);
                (byAuthor[m.userId] = byAuthor[m.userId] || []).push({
                    messageId: m.UID,
                    delivered: rec.filter(r => isFilled(r.deliveredAt)).length,
                    read: rec.filter(r => isFilled(r.readAt)).length
                });
            }
            for (const authorId of Object.keys(byAuthor)) {
                sendSessionEventToUser(authorId, { type: 'messenger.receipts', chatId: chatId, receipts: byAuthor[authorId] });
            }
        } catch (e) {
            log.debug('[messenger] pushReceipts:', e && e.message);
        }
    }

    // ── Перевод входящих ────────────────────────────────────────────────────
    /**
     * Перевести новое сообщение на языки получателей и сохранить переводы.
     *
     * Ключ перевода — ЯЗЫК, а не человек: двум получателям, читающим по-немецки,
     * нужен один перевод и один вызов модели. Оригинал (`messenger_messages.content`)
     * не трогается никогда.
     *
     * Делается ДО рассылки, а не в фоне: иначе два подряд отправленных сообщения
     * приходили бы получателю в порядке, в каком успели перевестись, — то есть
     * иногда наоборот. Порядок реплик в переписке дороже секунды ожидания.
     *
     * @param {Object} messageRow — созданное сообщение (UID, userId, content)
     * @param {Array} members — участники чата
     * @param {string} [sentLangCode] — язык, на который текст уже переведён при отправке
     * @param {function(): Promise<Object|null>} [getContext] — контекст переводчика;
     *        собирается лениво — только если кому-то действительно нужен перевод
     * @returns {Promise<{byCode: Map<string,string>, langByUser: Map<string,Object>}>}
     */
    async function translateForRecipients(messageRow, members, sentLangCode, getContext) {
        const byCode = new Map();
        const langByUser = new Map();
        const content = String(messageRow.content || '').trim();
        if (!content) return { byCode, langByUser };

        const langs = await languageIndex();
        for (const m of members) {
            if (!m.userId || m.userId === messageRow.userId) continue;
            const prefs = await translationPrefs(m.userId, langs);
            const lang = readingLanguageOf(prefs);
            if (lang) langByUser.set(m.userId, lang);
        }
        if (!langByUser.size) return { byCode, langByUser };

        const targets = new Map();
        for (const lang of langByUser.values()) {
            // Отправитель уже перевёл текст на этот язык — переводить его сам в себя
            // значит потратить вызов модели и получить другую формулировку того же.
            if (sentLangCode && lang.code === sentLangCode) continue;
            targets.set(lang.code, lang);
        }

        const context = (targets.size && typeof getContext === 'function') ? await getContext() : null;
        for (const [code, lang] of targets) {
            try {
                const res = await translator.translate(content, lang, null, context);
                if (!res.ok) { log.warn('[messenger] перевод на', code, 'не выполнен:', res.error); continue; }
                byCode.set(code, res.text);
                // Уникальный индекс (messageId, language) — повтор невозможен;
                // findOrCreate защищает от гонки двух процессов.
                await Translations().findOrCreate({
                    where: { messageId: messageRow.UID, language: code },
                    defaults: {
                        messageId: messageRow.UID,
                        userId: messageRow.userId,
                        language: code,
                        content: res.text,
                        engine: res.engine || null
                    }
                });
            } catch (e) {
                log.error('[messenger] перевод на', code, e && e.message);
            }
        }
        return { byCode, langByUser };
    }

    /**
     * Перевод исходящего: текст, который реально уйдёт собеседнику.
     *
     * Отказ возвращается ошибкой, а не молчаливой отправкой оригинала: человек нажал
     * «Отправить перевод» и обязан узнать, что перевода не получилось, — иначе
     * собеседник получит текст на языке, которого не знает, и оба будут уверены,
     * что всё в порядке.
     *
     * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
     */
    async function translateOutgoing(content, languageUID, context) {
        const langs = await languageIndex();
        const lang = langs.byId.get(String(languageUID));
        if (!lang) return { ok: false, error: 'msg_translate_no_language' };
        const res = await translator.translate(content, lang, null, context);
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, text: res.text, code: lang.code };
    }

    // ── Контекст переводчика ────────────────────────────────────────────────
    /**
     * Контекст переводчика для сообщения чата (решение владельца 14.09.2026): автор и
     * читатели по именам — без них модель не знает рода; последние сообщения чата — о чём
     * речь; словарь — один на всю систему (lib/translationContext.js), его еженедельно
     * правит разбор (lib/translationReview.js).
     *
     * Сбой сбора контекста перевод НЕ отменяет: переводим без него, а не отказываем
     * человеку в отправке.
     *
     * @param {string} chatId
     * @param {string} authorId
     * @param {Array} members — участники чата
     * @param {Date} [beforeDate] — история только до этого момента (само сообщение — не история)
     * @returns {Promise<Object|null>}
     */
    async function translationContextFor(chatId, authorId, members, beforeDate) {
        try {
            const ids = Array.from(new Set((members || []).map(m => m.userId).concat([authorId]).filter(Boolean)));
            const names = await userPresentation.presentationsByIds(modelsDB, ids);

            const where = { chatId: chatId };
            if (beforeDate) where.createdAt = { [Op.lt]: beforeDate };
            const recent = await Messages().findAll({
                where, attributes: ['userId', 'content'],
                order: [['createdAt', 'DESC']], limit: TRANSLATION_HISTORY, raw: true
            });
            const history = recent.reverse()
                .filter(r => String(r.content || '').trim())
                .map(r => ({ author: names.get(r.userId) || '?', text: r.content }));

            const current = await translationContext.loadCurrent(readTranslationContexts);

            return {
                author: names.get(authorId) || null,
                readers: (members || []).filter(m => m.userId !== authorId).map(m => names.get(m.userId)).filter(Boolean),
                history,
                glossaryText: current ? translationContext.toPromptText(current.context) : ''
            };
        } catch (e) {
            log.warn('[messenger] контекст переводчика не собран:', e && e.message);
            return null;
        }
    }

    /** Чтение версий контекста — моделью, как и остальные данные мессенджера (см. шапку файла). */
    async function readTranslationContexts(table, where, options) {
        const Model = modelsDB.MessengerTranslationContexts;
        if (!Model || table !== translationContext.TABLE) return [];
        return await Model.findAll(Object.assign({ where, raw: true }, options || {}));
    }

    /**
     * «Восстановить эту версию» контекста переводчика: текущей становится НОВАЯ версия с
     * тем же содержимым — таблица только на дозапись, история не теряется. Только
     * администратор: словарь влияет на переводы всех.
     */
    async function restoreTranslationContext(params, ctx) {
        const user = await currentUser(ctx);
        const { getUserAccessRole } = require('../../../drive_forms/globalServerContext');
        const role = user ? await getUserAccessRole({ UID: user.UID }) : null;
        if (role !== 'admin') return { error: await tForSession('msg_trctx_restore_denied', ctx.sessionID) };

        const Model = modelsDB.MessengerTranslationContexts;
        const source = (Model && params && params.contextId)
            ? await Model.findByPk(String(params.contextId), { raw: true }) : null;
        if (!source) return { error: await tForSession('msg_trctx_not_found', ctx.sessionID) };

        const latest = await Model.findOne({ order: [['version', 'DESC']], raw: true });
        const version = (Number(latest && latest.version) || 0) + 1;
        await Model.create({
            userId: null, version,
            terms: source.terms, rules: source.rules,
            reviewId: null, restoredFromId: source.UID, note: null
        });
        return { success: true, version };
    }

    // ── Отправка ────────────────────────────────────────────────────────────
    /**
     * Отправить сообщение. `clientMsgId` — ключ идемпотентности: повтор того же
     * запроса (ретрай при обрыве) не создаёт второе сообщение, а возвращает уже
     * записанное.
     *
     * `translateTo` — UID языка: текст переводится и уходит ПЕРЕВЕДЁННЫМ, как
     * обычное сообщение. Получатель не видит никакой пометки о переводе: для него
     * это просто письмо на его языке.
     */
    async function sendMessage(params, ctx) {
        const chatId = params && params.chatId;
        const access = await requireMember(ctx, chatId);
        if (!access) return { error: await tForSession('Access denied', ctx.sessionID) };

        let content = String((params && params.content) || '').trim();
        let sentLangCode = null;      // на каком языке текст ушёл (если переводили при отправке)
        let originalContent = null;   // что автор набрал, если ушёл перевод
        const files = Array.isArray(params.attachments) ? params.attachments : [];
        if (!content && !files.length) return { error: await tForSession('msg_empty_message', ctx.sessionID) };

        const clientMsgId = params.clientMsgId ? String(params.clientMsgId) : null;
        if (clientMsgId) {
            const existing = await Messages().findOne({
                where: { userId: access.user.UID, clientMsgId: clientMsgId }, raw: true
            });
            if (existing) {
                const [decorated] = await decorateMessages([existing], chatId, access.user.UID);
                return { success: true, message: decorated, duplicate: true };
            }
        }

        // Участники и контекст переводчика — один раз на сообщение: они нужны и переводу
        // исходящего, и переводу для получателей. Контекст собирается лениво — только
        // если перевод действительно понадобится.
        const members = await chatMembers(chatId);
        let contextCreatedAt = null;
        let trContext;
        const getTranslationContext = async () => {
            if (trContext === undefined) {
                trContext = await translationContextFor(chatId, access.user.UID, members, contextCreatedAt);
            }
            return trContext;
        };

        // Перевод исходящего — ДО записи: в базу ложится ровно то, что уйдёт человеку.
        // Право на эту кнопку проверяется здесь, а не только тем, что она нарисована:
        // кнопка на экране — не разрешение.
        if (params && params.translateTo && content) {
            const prefs = await translationPrefs(access.user.UID);
            if (!prefs.outgoing) return { error: await tForSession('Access denied', ctx.sessionID) };
            const out = await translateOutgoing(content, params.translateTo, await getTranslationContext());
            if (!out.ok) return { error: await tForSession('msg_translate_failed', ctx.sessionID) };
            // Уходит перевод, но набранное сохраняется: свои сообщения автор обязан
            // видеть на том языке, на котором их писал. Это ВТОРОЙ текст того же
            // сообщения, а не второе сообщение: получателю уходит ровно одно.
            originalContent = content;
            content = out.text;
            sentLangCode = out.code;
        }

        const maxBytes = await maxAttachmentBytes();
        for (const f of files) {
            const size = Number(f.size) || 0;
            if (size > maxBytes) return { error: await tForSession('msg_attachment_too_big', ctx.sessionID) };
        }

        const created = await Messages().create({
            chatId: chatId,
            userId: access.user.UID,
            content: content,
            originalContent: originalContent,
            clientMsgId: clientMsgId
        });

        for (const f of files) {
            try { await storeAttachment(created.UID, access.user.UID, f); }
            catch (e) { log.error('[messenger] вложение не сохранено:', e && e.message); }
        }

        await Chats().update({ lastMessageAt: created.createdAt }, { where: { UID: chatId } });

        const plain = created.get ? created.get({ plain: true }) : created;
        const [decorated] = await decorateMessages([plain], chatId, access.user.UID);

        // Новое сообщение — не история: если контекст ещё не собран, он возьмёт только
        // то, что было до него.
        contextCreatedAt = created.createdAt;
        const translations = await translateForRecipients(plain, members, sentLangCode, getTranslationContext);

        await fanOut(chatId, access.user, decorated, members, translations);
        return { success: true, message: decorated };
    }

    /**
     * Разослать сообщение участникам: живым — событием в ленту, всем прочим —
     * уведомлением. Уведомление НЕ шлём тому, у кого этот чат сейчас открыт:
     * он и так видит сообщение, а карточка в углу поверх открытой переписки —
     * шум, из-за которого уведомления перестают читать.
     */
    async function fanOut(chatId, author, message, membersIn, translations) {
        const members = membersIn || await chatMembers(chatId);
        const notifications = require('../../notifications/server');
        const byCode = (translations && translations.byCode) || new Map();
        const langByUser = (translations && translations.langByUser) || new Map();

        // Кому мессенджер выключен — ни события в ленту, ни карточки в углу: у него
        // нет окна, в которое это можно показать.
        const enabled = await appAvailability.enabledMapForUsers(
            members.map(m => m.userId), APP_NAME
        );

        for (const m of members) {
            if (!m.userId || m.userId === author.UID) continue;
            if (enabled.get(m.userId) === false) continue;

            // Каждому — его перевод: «показать переводы» обязано работать и на
            // сообщении, пришедшем в открытое окно, а не только после перезагрузки.
            const lang = langByUser.get(m.userId);
            const translated = lang ? (byCode.get(lang.code) || null) : null;
            // `message` собрано глазами АВТОРА — в нём может лежать его набранный
            // текст. Получателю он не принадлежит: копия всегда без `original`.
            const forMember = Object.assign({}, message, { translation: translated, original: null });

            sendSessionEventToUser(m.userId, { type: 'messenger.message', chatId: chatId, message: forMember });

            if (isLookingAt(m.userId, chatId) && presence.isOnline(m.userId)) continue;

            // Карточка в углу — на языке получателя, если перевод есть: анонс на
            // незнакомом языке не анонс.
            const body = translated || message.content;
            const text = body
                ? shorten(body, NOTIFY_LIMIT)
                : shorten((message.attachments[0] && message.attachments[0].name) || '', NOTIFY_LIMIT);
            try {
                await notifications.notify({
                    userId: m.userId,
                    appName: APP_NAME,
                    // Подпись — та же строка, что стоит над сообщением в ленте
                    // (`decorateMessages` читает представление из базы). Считать её
                    // здесь второй раз нельзя: `author` приезжает из КЭША сессии
                    // (`getUserBySessionID` хранит снимок в memory_store), и запись,
                    // положенная туда до заполнения представления, показывала в
                    // уведомлении логин, когда в ленте уже стояло имя.
                    title: message.authorName || userPresentation.presentationOf(author),
                    text: text,
                    icon: MESSENGER_ICON,
                    onClick: { fn: 'openChat', fnParams: { chatId: chatId } }
                });
            } catch (e) {
                log.error('[messenger] уведомление не поставлено:', e && e.message);
            }
        }
    }

    // ── Вложения ────────────────────────────────────────────────────────────
    async function maxAttachmentBytes() {
        try {
            const settings = require('../../../drive_root/settings');
            const mb = await settings.getSystemSetting('messenger', 'maxAttachmentMb');
            return Math.max(1, Number(mb) || 10) * 1024 * 1024;
        } catch (e) {
            return 10 * 1024 * 1024;
        }
    }

    /**
     * Сохранить вложение. Миниатюра делается на сервере: клиентская пришла бы
     * снаружи, и доверять её размеру и типу нельзя.
     *
     * `jimp` подключается лениво и не обязателен: если библиотека не
     * установлена, вложение сохраняется без миниатюры, а лента покажет
     * оригинал, сжатый по ширине. Падать из-за отсутствия картинки нельзя —
     * сообщение важнее превью.
     */
    async function storeAttachment(messageId, userId, file) {
        const buffer = Buffer.from(String(file.data || ''), 'base64');
        const mimeType = String(file.mimeType || 'application/octet-stream');
        const isImage = /^image\//i.test(mimeType);

        let thumb = null;
        if (isImage) thumb = await makeThumb(buffer, mimeType);

        await Attachments().create({
            messageId: messageId,
            userId: userId,
            name: String(file.name || 'file'),
            mimeType: mimeType,
            size: buffer.length,
            isImage: isImage,
            data: buffer,
            thumb: thumb
        });
    }

    async function makeThumb(buffer, mimeType) {
        try {
            const Jimp = require('jimp');
            const image = await Jimp.read(buffer);
            image.scaleToFit(THUMB_SIZE, THUMB_SIZE);
            return await image.getBufferAsync(mimeType === 'image/png' ? 'image/png' : 'image/jpeg');
        } catch (e) {
            log.debug('[messenger] миниатюра не построена:', e && e.message);
            return null;
        }
    }

    /**
     * Байты вложения для бинарного маршрута. Право проверяется здесь же:
     * вложение отдаётся только участнику чата, которому принадлежит сообщение.
     */
    async function readAttachment(uid, ctx, wantThumb) {
        const att = await Attachments().findOne({ where: { UID: uid }, raw: true });
        if (!att) return null;
        const message = await Messages().findOne({ where: { UID: att.messageId }, raw: true });
        if (!message) return null;
        const access = await requireMember(ctx, message.chatId);
        if (!access) return null;
        // Миниатюры может не быть (не картинка либо не собралась) — отдаём
        // оригинал, чтобы в ленте не появлялась битая картинка.
        const body = (wantThumb && att.thumb) ? att.thumb : att.data;
        return { name: att.name, mimeType: att.mimeType, body: body };
    }

    // ── Присутствие и служебное ─────────────────────────────────────────────
    async function unreadTotalFor(userId) {
        const memberships = await Members().findAll({ where: { userId: userId, isActive: true }, attributes: ['chatId'], raw: true });
        if (!memberships.length) return 0;
        let chatIds = memberships.map(m => m.chatId);

        // Скрытые чаты (собеседник не пользуется мессенджером) не считаются: иначе на
        // значке висела бы цифра, которую нечем обнулить — чата в списке-то нет.
        const [chatRows, allMembers] = await Promise.all([
            Chats().findAll({ where: { UID: chatIds, isActive: true }, attributes: ['UID', 'kind'], raw: true }),
            Members().findAll({ where: { chatId: chatIds, isActive: true }, attributes: ['chatId', 'userId'], raw: true })
        ]);
        const hidden = await hiddenChatIds(peerByChatFrom(chatRows, allMembers, userId));
        chatIds = chatRows.map(c => c.UID).filter(id => !hidden.has(id));
        if (!chatIds.length) return 0;

        const readIds = (await Reads().findAll({
            where: { userId: userId, chatId: chatIds, readAt: FILLED },
            attributes: ['messageId'], raw: true
        })).map(r => r.messageId);
        return await Messages().count({
            where: {
                chatId: chatIds,
                userId: { [Op.ne]: userId },
                UID: { [Op.notIn]: readIds.length ? readIds : ['-'] }
            }
        });
    }

    async function getUnreadTotal(params, ctx) {
        const user = await currentUser(ctx);
        if (!user) return { unreadTotal: 0 };
        return { unreadTotal: await unreadTotalFor(user.UID) };
    }

    /**
     * Клиент сообщает, какой чат он сейчас ПОКАЗЫВАЕТ (см. fanOut).
     * `chatId: null` — окно свёрнуто или закрыто, показывать нечего.
     */
    async function setActiveChat(params, ctx) {
        const user = await currentUser(ctx);
        if (!user) return { success: false };
        touchActiveChat(user.UID, params && params.chatId);
        return { success: true };
    }

    // ── Состав панелей композера ────────────────────────────────────────────
    /**
     * Что показывать над и рядом с полем ввода в ЭТОМ чате.
     *
     * Состав панелей решает СЕРВЕР, а не клиент: это права (настройки правит только
     * администратор) и справочные данные (список языков). Клиент, который сам решает,
     * рисовать ли кнопку «Отправить перевод», однажды нарисует её тому, кому нельзя.
     *
     * @returns {Promise<{translateIncoming: boolean, translateOutgoing: boolean,
     *                    languages: Array, outgoingLanguageId: string|null,
     *                    configured: boolean}>}
     */
    async function composerState(params, ctx) {
        const chatId = params && params.chatId;
        const user = await currentUser(ctx);
        if (!user) return { translateIncoming: false, translateOutgoing: false, languages: [], outgoingLanguageId: null, configured: false };

        const langs = await languageIndex();
        const prefs = await translationPrefs(user.UID, langs);
        const configured = await translator.isConfigured();

        let outgoingLanguageId = null;
        if (chatId && prefs.outgoing) {
            const membership = await Members().findOne({
                where: { chatId: chatId, userId: user.UID, isActive: true },
                attributes: ['outgoingLanguageId'], raw: true
            });
            outgoingLanguageId = (membership && membership.outgoingLanguageId) || null;
        }

        return {
            // Переключатель «оригиналы/переводы» нужен только тому, кому переводят.
            translateIncoming: !!(prefs.incoming && prefs.language),
            translateOutgoing: !!prefs.outgoing,
            readingLanguage: prefs.language ? prefs.language.code : null,
            languages: langs.list.map(l => ({ UID: l.UID, code: l.code, name: l.name })),
            outgoingLanguageId: outgoingLanguageId,
            // Переводить нечем — панели рисуем, но об этом надо сказать вслух,
            // а не отправлять в пустоту.
            configured: configured
        };
    }

    /**
     * Запомнить язык, на который переводим ЭТОМУ собеседнику.
     *
     * Хранится реквизитом участия в чате, а не в состоянии интерфейса: от него
     * зависит, какой текст реально уйдёт человеку, а состояние интерфейса приходит
     * с клиента и для такого не предназначено.
     */
    async function setOutgoingLanguage(params, ctx) {
        const chatId = params && params.chatId;
        const access = await requireMember(ctx, chatId);
        if (!access) return { error: await tForSession('Access denied', ctx.sessionID) };

        const languageId = (params && params.languageId) ? String(params.languageId) : null;
        if (languageId) {
            const langs = await languageIndex();
            if (!langs.byId.has(languageId)) return { error: await tForSession('msg_translate_no_language', ctx.sessionID) };
        }
        await Members().update(
            { outgoingLanguageId: languageId },
            { where: { chatId: chatId, userId: access.user.UID } }
        );
        return { success: true, outgoingLanguageId: languageId };
    }

    return {
        loadChats, loadMessages, sendMessage, markRead,
        getUnreadTotal, setActiveChat,
        composerState, setOutgoingLanguage,
        // Откат версии контекста переводчика (форма версии, только admin).
        restoreTranslationContext,
        // Не RPC, а внутренний метод для бинарного маршрута (server.js).
        readAttachment,
        maxAttachmentBytes
    };
};
