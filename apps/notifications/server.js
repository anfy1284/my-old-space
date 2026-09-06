'use strict';

/**
 * Пуш-уведомления — серверная часть.
 *
 * Механизм общий для всех приложений: любое из них может поставить уведомление
 * пользователю, а показывает их одно место — стек в правом нижнем углу экрана
 * (apps/notifications/resources/public/client.js).
 *
 * ── Почему в базе, а не в памяти вкладки ──────────────────────────────────────
 * Решение владельца: уведомление должно пережить перезагрузку страницы и приход
 * сообщения, когда получателя нет на месте. Отсюда таблица `notifications` с
 * реквизитом доступа `userId` — RLS отдаёт пользователю ровно его строки.
 *
 * ── Почему в базе лежит ИМЯ функции, а не ссылка на скрипт ────────────────────
 * Обработчик клика — функция в клиентском скрипте приложения. UID скрипта выдаёт
 * `loadScript` при старте процесса (drive_root/fileStore.js) и на следующем
 * старте он ДРУГОЙ. Поэтому в базе лежит `appName` + `handlerFn` + параметры, а
 * действующий UID подставляется в момент выдачи — через реестр
 * drive_root/notificationHandlers.js.
 *
 * ── Почему постановка уведомления идёт под системной сессией ──────────────────
 * `notify()` пишет строку ПОЛУЧАТЕЛЮ, а не себе: автор сообщения и адресат — это
 * разные пользователи, и RLS такую запись справедливо не пропустит. Это ровно тот
 * случай, для которого существует SYSTEM_SESSION_ID: собственная служебная
 * таблица механизма. Всё, что делает пользователь со СВОИМИ уведомлениями
 * (список, очистка, отметка о прочтении), идёт под его сессией — через ту же
 * RLS, что и любые другие данные.
 */

const globalRoot = require('../../drive_root/globalServerContext');
const dbGateway = require('../../drive_root/dbGateway');
const notificationHandlers = require('../../drive_root/notificationHandlers');
const { sendSessionEventToUser } = require('../../drive_forms/dynamicTableRegistry');
const log = require('../../drive_root/log');

const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';
const TABLE = 'notifications';
// Источник по умолчанию, когда клиент не назвал приложение: уведомление всё
// равно должно знать, чьё оно, — иначе его нечем отличить в списке.
const APP_NAME_SELF = 'notifications';

// Сколько уведомлений отдаём в стек за раз. Стек прокручивается, но грузить в
// окно всю историю незачем — старое всё равно уедет по сроку хранения.
const LIST_LIMIT = 200;

/**
 * Привести строку базы к виду, который понимает клиент: подставить действующий
 * UID клиентского скрипта приложения вместо непереносимого идентификатора.
 */
function toClient(row) {
    const scriptUID = notificationHandlers.getScriptUID(row.appName);
    return {
        UID: row.UID,
        appName: row.appName,
        title: row.title || '',
        text: row.text || '',
        icon: row.icon || null,
        isRead: !!row.isRead,
        createdAt: row.createdAt,
        // handler отсутствует, если приложение не объявляло обработчиков или
        // уведомление поставлено без них — такое уведомление просто не кликается.
        handler: (scriptUID && row.handlerFn)
            ? { scriptUID: scriptUID, fn: row.handlerFn, fnParams: row.handlerParams || {} }
            : null
    };
}

/**
 * Поставить уведомление пользователю. Точка входа для серверного кода ЛЮБОГО
 * приложения:
 *
 *     const notifications = require('../notifications/server');
 *     await notifications.notify({
 *         userId, appName: 'messenger',
 *         title: 'Иван Петров', text: 'Привет!',
 *         icon: '/apps/general_icons/resources/public/16x16/email.png',
 *         onClick: { fn: 'openChat', fnParams: { chatId } }
 *     });
 *
 * @param {object} params
 * @param {string} params.userId   — получатель (users.UID)
 * @param {string} params.appName  — приложение-источник (как в apps.json)
 * @param {string} params.text     — текст уведомления
 * @param {string} [params.title]  — заголовок (обычно — кто/что)
 * @param {string} [params.icon]   — ссылка на иконку
 * @param {{fn: string, fnParams?: object}} [params.onClick] — ИМЯ функции
 *        приложения, которую позвать по клику, и её параметры
 * @returns {Promise<object|null>} — уведомление в клиентском виде
 */
async function notify(params) {
    const { userId, appName, title, text, icon, onClick } = params || {};
    if (!userId || !appName || !text) {
        log.error('[notifications] notify: нужны userId, appName и text');
        return null;
    }

    const data = {
        userId: userId,
        appName: appName,
        title: title || null,
        text: String(text),
        icon: icon || null,
        handlerFn: (onClick && onClick.fn) ? String(onClick.fn) : null,
        handlerParams: (onClick && onClick.fnParams) ? onClick.fnParams : null,
        isRead: false
    };

    let row;
    try {
        row = await dbGateway.execute({
            operation: 'create',
            table: TABLE,
            data: data,
            context: { sessionID: SYSTEM_SESSION_ID }
        });
    } catch (e) {
        log.error('[notifications] не удалось записать уведомление:', e && e.message);
        return null;
    }

    // Sequelize отдаёт модель; работаем с простым объектом.
    const plain = (row && typeof row.get === 'function') ? row.get({ plain: true }) : row;
    if (!plain) return null;

    const clientView = toClient(plain);
    // Живым окнам получателя — сразу, адресно. Если он сейчас не в системе,
    // уведомление подхватится из базы при следующем входе.
    try {
        sendSessionEventToUser(userId, { type: 'notification', notification: clientView });
    } catch (e) {
        log.error('[notifications] push:', e && e.message);
    }
    return clientView;
}

// ── RPC: методы, которые зовёт клиентский стек уведомлений ───────────────────

/**
 * Уведомление, поставленное клиентским кодом самому себе (MySpace.notify).
 * Отдельный метод, а не `notify` напрямую: получателя определяет СЕССИЯ, а не
 * параметр запроса — иначе через этот RPC можно было бы слать уведомления
 * произвольному пользователю.
 */
async function notifySelf(params, sessionID) {
    const user = await globalRoot.getUserBySessionID(sessionID);
    if (!user) return { error: 'User not authorized' };
    const p = params || {};
    const created = await notify({
        userId: user.UID,
        appName: p.appName || APP_NAME_SELF,
        title: p.title,
        text: p.text,
        icon: p.icon,
        onClick: p.onClick
    });
    return created ? { success: true, notification: created } : { error: 'Notification not created' };
}

/** Уведомления текущего пользователя, свежие внизу (порядок стека). */
async function list(params, sessionID) {
    const user = await globalRoot.getUserBySessionID(sessionID);
    if (!user) return { error: 'User not authorized' };

    const rows = await dbGateway.execute({
        operation: 'read',
        table: TABLE,
        where: { userId: user.UID },
        options: { raw: true, order: [['createdAt', 'ASC']], limit: LIST_LIMIT },
        context: { sessionID }
    });

    return { notifications: (rows || []).map(toClient) };
}

/**
 * «Очистить все сообщения» — строки удаляются физически (решение владельца:
 * очищенное не хранится). Незачем держать кусок переписки в базе после того,
 * как пользователь его убрал с экрана.
 */
async function clearAll(params, sessionID) {
    const user = await globalRoot.getUserBySessionID(sessionID);
    if (!user) return { error: 'User not authorized' };

    await dbGateway.execute({
        operation: 'delete',
        table: TABLE,
        where: { userId: user.UID },
        context: { sessionID }
    });
    return { success: true };
}

/** Убрать одно уведомление (клик по нему — оно обработано). */
async function remove(params, sessionID) {
    const user = await globalRoot.getUserBySessionID(sessionID);
    if (!user) return { error: 'User not authorized' };
    const uid = params && params.UID;
    if (!uid) return { error: 'UID not specified' };

    // userId в условии — не «на всякий случай»: RLS и так не отдаст чужую
    // строку, но условие делает намерение явным в самом запросе.
    await dbGateway.execute({
        operation: 'delete',
        table: TABLE,
        where: { UID: uid, userId: user.UID },
        context: { sessionID }
    });
    return { success: true };
}

/** Отметить уведомление прочитанным (без удаления). */
async function markRead(params, sessionID) {
    const user = await globalRoot.getUserBySessionID(sessionID);
    if (!user) return { error: 'User not authorized' };
    const uid = params && params.UID;
    if (!uid) return { error: 'UID not specified' };

    await dbGateway.execute({
        operation: 'update',
        table: TABLE,
        where: { UID: uid, userId: user.UID },
        data: { isRead: true },
        context: { sessionID }
    });
    return { success: true };
}

module.exports = { notify, notifySelf, list, clearAll, remove, markRead, toClient };
