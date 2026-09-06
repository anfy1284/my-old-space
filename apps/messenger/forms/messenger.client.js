// Клиентские методы мессенджера.
//
// Загружается как исходный текст через loadScript() в init.js; плейсхолдер
// __SERVER_SCRIPT__ заменяется на реальное имя серверного скрипта.
//
// Вся обвязка окна живёт в form-level событии onReady: контролы (список чатов и
// лента) уже отрисованы фреймворком по лейауту, здесь их только связывают между
// собой и с сервером. Ручной вёрстки нет — её делают контролы ItemList и
// MessageFeed.
//
// Отдельно экспортируется openChat: это обработчик клика по пуш-уведомлению,
// он вызывается ПО ИМЕНИ из другого модуля и потому не должен зависеть от
// состояния формы.

/** Форма отрисована: связать контролы, загрузить чаты, подписаться на события. */
function onFormReady(ctx) {
    var form = ctx.form;
    var chatList = form.controlsMap && form.controlsMap.chatList;
    var feed = form.controlsMap && form.controlsMap.feed;
    if (!chatList || !feed) return;

    var state = { chats: [], currentChatId: null, unsubscribe: null };

    function findChat(chatId) {
        for (var i = 0; i < state.chats.length; i++) if (state.chats[i].chatId === chatId) return state.chats[i];
        return null;
    }

    // Незаполненная дата в этой системе — `0001-01-01`, а не NULL: чат без
    // сообщений иначе показывал бы время «00:53» (см. MySpace.isEmptyDate).
    function hhmm(value) {
        if (MySpace.isEmptyDate(value)) return '';
        var d = new Date(value);
        var p = function (n) { return String(n).padStart(2, '0'); };
        return p(d.getHours()) + ':' + p(d.getMinutes());
    }

    // Подпись присутствия собеседника: «в сети» или «был(а) в 14:05».
    function presenceTitle(chat) {
        if (chat.online === null || chat.online === undefined) return '';
        if (chat.online) return __t('msg_online');
        if (!chat.lastSeenAt) return __t('msg_offline');
        return __t('msg_last_seen') + ' ' + hhmm(chat.lastSeenAt);
    }

    function renderChats() {
        chatList.setItems(state.chats.map(function (c) {
            return {
                id: c.chatId,
                title: c.name,
                subtitle: c.preview,
                right: hhmm(c.lastMessageAt),
                badge: c.unread,
                unread: c.unread > 0,
                dot: (c.online === null || c.online === undefined) ? null : !!c.online,
                dotTitle: presenceTitle(c)
            };
        }));
        chatList.setActive(state.currentChatId);
        updateTrayBadge();
    }

    // Счётчик непрочитанного на значке в трее: окно мессенджера чаще всего
    // свёрнуто, и без счётчика о новом сообщении узнать неоткуда.
    function updateTrayBadge() {
        var total = 0;
        for (var i = 0; i < state.chats.length; i++) total += (state.chats[i].unread || 0);
        if (window.MySpaceTray && typeof MySpaceTray.setBadge === 'function') {
            MySpaceTray.setBadge('messenger', total);
        }
    }

    async function refreshChats() {
        var res = await callServer('__SERVER_SCRIPT__', 'loadChats', {});
        if (!res || res.error) return;
        state.chats = res.chats || [];
        renderChats();
    }

    // Окно на экране? Мессенджер живёт в трее и закрывается СВОРАЧИВАНИЕМ
    // (preventClose), поэтому «форма существует» и «пользователь её видит» —
    // разные вещи.
    function windowVisible() {
        return !!(form.element && document.contains(form.element) && form.element.style.display !== 'none');
    }

    /**
     * Сообщить серверу, в какой чат пользователь СЕЙЧАС СМОТРИТ.
     *
     * От этого зависит, слать ли ему уведомление о сообщении: тому, кто и так
     * видит переписку, карточка в углу не нужна. Свёрнутое окно — это «не
     * смотрит», иначе после первого же сворачивания уведомления пропадают
     * навсегда (ровно этот дефект и был).
     */
    function syncActiveChat() {
        var id = windowVisible() ? state.currentChatId : null;
        callServer('__SERVER_SCRIPT__', 'setActiveChat', { chatId: id }).catch(function () {});
    }

    function onFormVisibilityChanged(e) {
        if (!e || !e.detail || e.detail.form !== form) return;
        syncActiveChat();
        // Окно развернули с открытым чатом — то, что пришло, пока оно было
        // свёрнуто, пользователь теперь видит: гасим счётчики.
        if (windowVisible() && state.currentChatId) {
            var chat = findChat(state.currentChatId);
            if (chat) chat.unread = 0;
            feed.markVisibleRead().then(refreshChats, refreshChats);
        }
    }
    window.addEventListener('form-minimized', onFormVisibilityChanged);
    window.addEventListener('form-restored', onFormVisibilityChanged);

    async function openChatId(chatId) {
        if (!chatId) return;

        // Открыть могли раньше, чем загрузился список чатов: по клику на
        // уведомлении окно создаётся и тут же просят встать на чат. Без списка
        // неизвестны ни имя разговора, ни то, групповой ли он, — а от второго
        // зависит, показывать ли в ленте имена авторов.
        var chat = findChat(chatId);
        if (!chat) { await refreshChats(); chat = findChat(chatId); }

        // Разговора нет вовсе. Так бывает у уведомления, пережившего свой чат.
        // Молча открыть пустое окно — худший вариант: человек нажал и не понял,
        // произошло ли что-нибудь.
        if (!chat) {
            showAlert(__t('msg_chat_unavailable'));
            return;
        }

        state.currentChatId = chatId;
        chatList.setActive(chatId);
        // Счётчик гасим сразу — открытый чат прочитан по определению, и ждать
        // ради этого ответа сервера незачем.
        chat.unread = 0;
        renderChats();
        form.setTitle(__t('messenger_app_caption') + ' — ' + chat.name);

        await feed.setChat({ chatId: chatId, isGroup: !!chat.isGroup });
        syncActiveChat();

        // Порядок важен: сначала ДОЖДАТЬСЯ отметки о прочтении и только потом
        // перечитывать список. Обратный порядок возвращал счётчик на место —
        // ответ приходил по состоянию, каким оно было до отметки.
        await feed.markVisibleRead();
        await refreshChats();
    }

    chatList.onSelect = function (item) { openChatId(item.id); };

    // Отправленное своё сообщение меняет превью и порядок списка.
    feed.onSent = function () { refreshChats(); };

    // Сессионный канал событий — один на окно. Свой поток мессенджер больше не
    // поднимает: сообщения, галочки и присутствие приходят сюда же.
    if (window.MySpaceEvents) {
        state.unsubscribe = MySpaceEvents.on(function (d) {
            if (!d) return;
            if (d.type === 'messenger.message') {
                // Чат открыт и окно на экране — сообщение уже прочитано: ни
                // уведомления (его глушит сервер), ни счётчика у чата, ни цифры
                // на значке в трее. Счётчики обновляем ПОСЛЕ отметки о
                // прочтении, иначе список успевает мигнуть единицей.
                if (d.chatId === state.currentChatId && windowVisible()) {
                    feed.appendMessage(d.message);
                    var chat = findChat(d.chatId);
                    if (chat) chat.unread = 0;
                    feed.markVisibleRead().then(refreshChats, refreshChats);
                } else {
                    if (d.chatId === state.currentChatId) feed.appendMessage(d.message);
                    refreshChats();
                }
            } else if (d.type === 'messenger.receipts') {
                if (d.chatId === state.currentChatId) feed.applyReceipts(d.receipts);
            } else if (d.type === 'presence') {
                var changed = false;
                for (var i = 0; i < state.chats.length; i++) {
                    if (state.chats[i].peerId === d.userId) {
                        state.chats[i].online = d.online;
                        if (d.lastSeenAt) state.chats[i].lastSeenAt = d.lastSeenAt;
                        changed = true;
                    }
                }
                if (changed) renderChats();
            }
        });
    }

    // Наружу — для точки входа приложения (instance.selectChat) и для
    // обработчика уведомления.
    form._messenger = {
        selectChat: openChatId,
        refreshChats: refreshChats,
        syncActiveChat: syncActiveChat,
        destroy: function () {
            if (state.unsubscribe) state.unsubscribe();
            window.removeEventListener('form-minimized', onFormVisibilityChanged);
            window.removeEventListener('form-restored', onFormVisibilityChanged);
            // Окна больше нет — пользователь ни в какой чат не смотрит.
            callServer('__SERVER_SCRIPT__', 'setActiveChat', { chatId: null }).catch(function () {});
        }
    };

    // Список чатов, а следом — чат, заказанный ДО готовности формы (клик по
    // уведомлению на свежей странице: окно построено, обработчики ещё грузились).
    refreshChats().then(function () {
        var pending = form._pendingChatId;
        form._pendingChatId = null;
        if (pending) openChatId(pending);
    });
}

/**
 * Открыть мессенджер на нужном чате — обработчик клика по пуш-уведомлению.
 *
 * Вызывается ПО ИМЕНИ (`onClick: { fn: 'openChat' }`), поэтому не опирается ни
 * на какое состояние: находит окно через MySpace, разворачивает его и просит
 * встать на чат.
 */
async function openChat(params) {
    var chatId = params && params.chatId;
    if (!window.MySpace || typeof MySpace.open !== 'function') return;

    // Единственный путь: MySpace.open доводит параметры до onOpen окна — и для
    // уже открытого мессенджера, и для нового. Разворачивание из трея и выбор
    // чата делает onOpen; звать selectChat ещё и отсюда значит открывать чат
    // дважды и гонять лишние запросы.
    await MySpace.open('messenger', { chatId: chatId });
}

return { onFormReady, openChat };
