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
const presence = require('../../../drive_root/presence');
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
    const Users = () => modelsDB.Users;

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

    // ── Формирование вида сообщения для клиента ─────────────────────────────
    async function decorateMessages(rows, chatId, viewerId) {
        if (!rows.length) return [];
        const ids = rows.map(r => r.UID);

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
                attributes: ['UID', 'name'],
                raw: true
            })
        ]);

        const attByMsg = {};
        atts.forEach(a => { (attByMsg[a.messageId] = attByMsg[a.messageId] || []).push(a); });

        const recByMsg = {};
        receipts.forEach(r => { (recByMsg[r.messageId] = recByMsg[r.messageId] || []).push(r); });

        const nameById = {};
        authors.forEach(u => { nameById[u.UID] = u.name; });

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

        const peerIds = [];
        for (const c of chats) {
            const others = (membersByChat[c.UID] || []).filter(m => m.userId !== user.UID);
            if (c.kind !== 'group' && others.length === 1) peerIds.push(others[0].userId);
        }
        const [peers, presenceMap] = await Promise.all([
            peerIds.length ? Users().findAll({ where: { UID: peerIds }, attributes: ['UID', 'name'], raw: true }) : [],
            presence.getPresence(peerIds)
        ]);
        const peerName = {};
        peers.forEach(u => { peerName[u.UID] = u.name; });

        const out = chats.map(c => {
            const others = (membersByChat[c.UID] || []).filter(m => m.userId !== user.UID);
            const isGroup = c.kind === 'group' || others.length > 1;
            const peer = (!isGroup && others.length === 1) ? others[0].userId : null;
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
        });

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

        const messages = await decorateMessages(page, chatId, access.user.UID);

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

    // ── Отправка ────────────────────────────────────────────────────────────
    /**
     * Отправить сообщение. `clientMsgId` — ключ идемпотентности: повтор того же
     * запроса (ретрай при обрыве) не создаёт второе сообщение, а возвращает уже
     * записанное.
     */
    async function sendMessage(params, ctx) {
        const chatId = params && params.chatId;
        const access = await requireMember(ctx, chatId);
        if (!access) return { error: await tForSession('Access denied', ctx.sessionID) };

        const content = String((params && params.content) || '').trim();
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

        const maxBytes = await maxAttachmentBytes();
        for (const f of files) {
            const size = Number(f.size) || 0;
            if (size > maxBytes) return { error: await tForSession('msg_attachment_too_big', ctx.sessionID) };
        }

        const created = await Messages().create({
            chatId: chatId,
            userId: access.user.UID,
            content: content,
            clientMsgId: clientMsgId
        });

        for (const f of files) {
            try { await storeAttachment(created.UID, access.user.UID, f); }
            catch (e) { log.error('[messenger] вложение не сохранено:', e && e.message); }
        }

        await Chats().update({ lastMessageAt: created.createdAt }, { where: { UID: chatId } });

        const plain = created.get ? created.get({ plain: true }) : created;
        const [decorated] = await decorateMessages([plain], chatId, access.user.UID);

        await fanOut(chatId, access.user, decorated);
        return { success: true, message: decorated };
    }

    /**
     * Разослать сообщение участникам: живым — событием в ленту, всем прочим —
     * уведомлением. Уведомление НЕ шлём тому, у кого этот чат сейчас открыт:
     * он и так видит сообщение, а карточка в углу поверх открытой переписки —
     * шум, из-за которого уведомления перестают читать.
     */
    async function fanOut(chatId, author, message) {
        const members = await chatMembers(chatId);
        const notifications = require('../../notifications/server');

        for (const m of members) {
            if (!m.userId || m.userId === author.UID) continue;

            sendSessionEventToUser(m.userId, { type: 'messenger.message', chatId: chatId, message: message });

            if (isLookingAt(m.userId, chatId) && presence.isOnline(m.userId)) continue;

            const text = message.content
                ? shorten(message.content, NOTIFY_LIMIT)
                : shorten((message.attachments[0] && message.attachments[0].name) || '', NOTIFY_LIMIT);
            try {
                await notifications.notify({
                    userId: m.userId,
                    appName: APP_NAME,
                    title: author.name,
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
            const systemSettings = require('../../systemSettings/lib/systemSettings');
            const mb = await systemSettings.getNumber('messengerMaxAttachmentMb', 10);
            return Math.max(1, mb) * 1024 * 1024;
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
        const chatIds = memberships.map(m => m.chatId);
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

    return {
        loadChats, loadMessages, sendMessage, markRead,
        getUnreadTotal, setActiveChat,
        // Не RPC, а внутренний метод для бинарного маршрута (server.js).
        readAttachment,
        maxAttachmentBytes
    };
};
