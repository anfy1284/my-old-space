(function () {
    const APP_NAME = 'messenger';

    const descriptor = {
        config: { allowMultipleInstances: false },

        createInstance: async function (params) {
            const appForm = new DataForm(APP_NAME);
            appForm.setTitle('Messenger');

            // Position: right half of screen
            const topOffset = (typeof Form !== 'undefined' && Form.topOffset) ? Form.topOffset : 0;
            const bottomOffset = (typeof Form !== 'undefined' && Form.bottomOffset) ? Form.bottomOffset : 0;
            const screenWidth = window.innerWidth;
            const screenHeight = window.innerHeight;
            const formWidth = Math.round(screenWidth / 2);
            appForm.setWidth(formWidth);
            appForm.setHeight(screenHeight - topOffset - bottomOffset);
            appForm.setX(screenWidth - formWidth);
            appForm.setY(topOffset);

            // State
            let chatsContainer = null;
            let messagesContainer = null;
            let messageInput = null;
            let sendBtn = null;
            let currentChatId = null;
            let eventSource = null;
            let sseConnectedChatId = null;
            let resizeHandler = null;

            function createMessageElement(msg) {
                const msgDiv = document.createElement('div');
                msgDiv.style.marginBottom = '12px';
                msgDiv.style.padding = '8px';
                msgDiv.style.borderRadius = '4px';
                msgDiv.style.backgroundColor = '#f5f5f5';

                const headerDiv = document.createElement('div');
                headerDiv.style.fontSize = '12px';
                headerDiv.style.color = '#666';
                headerDiv.style.marginBottom = '4px';
                const timestamp = new Date(msg.createdAt).toLocaleString('ru-RU');
                headerDiv.textContent = msg.authorName + ' \u2022 ' + timestamp;
                msgDiv.appendChild(headerDiv);

                const contentDiv = document.createElement('div');
                contentDiv.style.fontSize = '14px';
                contentDiv.textContent = msg.content;
                msgDiv.appendChild(contentDiv);

                return msgDiv;
            }

            function refreshChats() {
                callServerMethod(APP_NAME, 'loadChats', {})
                    .then(result => {
                        if (result.error || !chatsContainer) return;
                        chatsContainer.innerHTML = '';
                        if (result.chats && result.chats.length > 0) {
                            result.chats.forEach(chat => {
                                const chatDiv = document.createElement('div');
                                chatDiv.style.padding = '8px';
                                chatDiv.style.borderBottom = '1px solid #ccc';
                                chatDiv.style.cursor = 'pointer';
                                chatDiv.style.textAlign = 'left';
                                chatDiv.textContent = chat.name;
                                chatDiv.addEventListener('mouseenter', function () { this.style.backgroundColor = '#e0e0e0'; });
                                chatDiv.addEventListener('mouseleave', function () { this.style.backgroundColor = ''; });
                                chatDiv.addEventListener('click', function () { loadChatMessages(chat.chatId); });
                                chatsContainer.appendChild(chatDiv);
                            });
                        } else {
                            chatsContainer.textContent = 'Нет чатов';
                            chatsContainer.style.padding = '8px';
                            chatsContainer.style.color = '#888';
                        }
                    })
                    .catch(err => { console.error('[Messenger] Update error:', err.message); });
            }

            function loadChatMessages(chatId) {
                if (!chatId || !messagesContainer) return;
                messagesContainer.innerHTML = '<div style="padding: 8px; color: #888;">Загрузка сообщений...</div>';

                callServerMethod(APP_NAME, 'loadMessages', { chatId })
                    .then(result => {
                        if (result.error) {
                            messagesContainer.innerHTML = '<div style="padding: 8px; color: red;">Ошибка: ' + result.error + '</div>';
                            return;
                        }
                        messagesContainer.innerHTML = '';
                        if (result.messages && result.messages.length > 0) {
                            result.messages.forEach(msg => {
                                messagesContainer.appendChild(createMessageElement(msg));
                            });
                            messagesContainer.scrollTop = messagesContainer.scrollHeight;
                        } else {
                            messagesContainer.innerHTML = '<div style="padding: 8px; color: #888;">Нет сообщений</div>';
                        }
                        currentChatId = chatId;
                        if (messageInput) messageInput.disabled = false;
                        if (sendBtn) sendBtn.disabled = false;
                        connectSSE(chatId);
                    })
                    .catch(err => {
                        messagesContainer.innerHTML = '<div style="padding: 8px; color: red;">Ошибка загрузки</div>';
                    });
            }

            function sendMessage(content) {
                if (!currentChatId || !content) return;
                if (messageInput) messageInput.disabled = true;
                if (sendBtn) sendBtn.disabled = true;

                callServerMethod(APP_NAME, 'sendMessage', { chatId: currentChatId, content })
                    .then(result => {
                        if (result.error) {
                            if (typeof showAlert === 'function') showAlert('Ошибка: ' + result.error);
                            return;
                        }
                        if (result.success && messageInput) messageInput.value = '';
                    })
                    .catch(err => {
                        if (typeof showAlert === 'function') showAlert('Ошибка отправки');
                    })
                    .finally(() => {
                        if (messageInput) messageInput.disabled = false;
                        if (sendBtn) sendBtn.disabled = false;
                        if (messageInput) messageInput.focus();
                    });
            }

            function connectSSE(chatId) {
                if (eventSource && sseConnectedChatId === chatId) return;
                if (eventSource) { eventSource.close(); eventSource = null; sseConnectedChatId = null; }
                if (!chatId) return;
                sseConnectedChatId = chatId;
                try {
                    const url = '/app/messenger/subscribeToChat?chatId=' + chatId;
                    eventSource = new EventSource(url);
                    eventSource.onmessage = (event) => {
                        try {
                            const data = JSON.parse(event.data);
                            if (data.type === 'newMessage' && messagesContainer) {
                                messagesContainer.appendChild(createMessageElement(data.message));
                                messagesContainer.scrollTop = messagesContainer.scrollHeight;
                            }
                        } catch (e) {
                            console.error('[Messenger] SSE processing error:', e.message);
                        }
                    };
                    eventSource.onerror = () => {};
                } catch (e) {
                    console.error('[Messenger] SSE creation error:', e.message);
                }
            }

            const instance = {
                appName: APP_NAME,
                form: appForm,

                onOpen: async (openParams) => {
                    appForm.getLayoutWithData = async () => ({ layout: [], data: [] });
                    await appForm.Draw();

                    const content = appForm.contentArea || (appForm.getContentArea && appForm.getContentArea());
                    if (!content) return;
                    content.innerHTML = '';
                    content.style.padding = '0';
                    content.style.overflow = 'hidden';

                    // Build chat layout: left panel (chats list) + right panel (messages + input)
                    const table = document.createElement('table');
                    table.style.width = '100%';
                    table.style.height = '100%';
                    table.style.borderCollapse = 'collapse';
                    table.style.tableLayout = 'fixed';
                    table.style.border = '1px solid black';
                    content.appendChild(table);

                    const row = document.createElement('tr');
                    row.style.height = '100%';
                    table.appendChild(row);

                    // Left column — chat list
                    const leftCell = document.createElement('td');
                    leftCell.style.width = '25%';
                    leftCell.style.border = '1px solid black';
                    leftCell.style.verticalAlign = 'top';
                    row.appendChild(leftCell);

                    const leftTable = document.createElement('table');
                    leftTable.style.width = '100%';
                    leftTable.style.height = '100%';
                    leftTable.style.borderCollapse = 'collapse';
                    leftTable.style.tableLayout = 'fixed';
                    leftCell.appendChild(leftTable);

                    const headerRow = document.createElement('tr');
                    leftTable.appendChild(headerRow);
                    const headerCell = document.createElement('td');
                    headerCell.style.height = '30px';
                    headerCell.style.borderBottom = '1px solid black';
                    headerRow.appendChild(headerCell);

                    const chatsLabel = new Label(headerCell);
                    chatsLabel.setText('Чаты');
                    chatsLabel.setFontSize('18px');
                    chatsLabel.setFontWeight('bold');
                    chatsLabel.Draw(headerCell);

                    const listRow = document.createElement('tr');
                    leftTable.appendChild(listRow);
                    const listCell = document.createElement('td');
                    listCell.style.overflow = 'auto';
                    listCell.style.verticalAlign = 'top';
                    listRow.appendChild(listCell);
                    chatsContainer = listCell;

                    // Right column — messages + input
                    const rightCell = document.createElement('td');
                    rightCell.style.width = '75%';
                    rightCell.style.border = '1px solid black';
                    rightCell.style.verticalAlign = 'top';
                    rightCell.style.height = '100%';
                    rightCell.style.position = 'relative';
                    rightCell.style.padding = '0';
                    row.appendChild(rightCell);

                    const rightFlex = document.createElement('div');
                    rightFlex.style.position = 'absolute';
                    rightFlex.style.top = '0';
                    rightFlex.style.left = '0';
                    rightFlex.style.right = '0';
                    rightFlex.style.bottom = '0';
                    rightFlex.style.display = 'flex';
                    rightFlex.style.flexDirection = 'column';
                    rightCell.appendChild(rightFlex);

                    const messagesWrapper = document.createElement('div');
                    messagesWrapper.style.flex = '1';
                    messagesWrapper.style.overflow = 'auto';
                    messagesWrapper.style.padding = '8px';
                    messagesWrapper.style.borderBottom = '1px solid black';
                    rightFlex.appendChild(messagesWrapper);
                    messagesContainer = messagesWrapper;

                    // Input area
                    const inputWrapper = document.createElement('div');
                    inputWrapper.style.display = 'flex';
                    inputWrapper.style.gap = '4px';
                    inputWrapper.style.alignItems = 'center';
                    inputWrapper.style.height = '40px';
                    inputWrapper.style.padding = '4px';
                    inputWrapper.style.flexShrink = '0';
                    rightFlex.appendChild(inputWrapper);

                    messageInput = document.createElement('input');
                    messageInput.type = 'text';
                    messageInput.placeholder = 'Введите сообщение...';
                    messageInput.style.flex = '1';
                    messageInput.style.padding = '4px 8px';
                    messageInput.style.border = '1px solid #ccc';
                    messageInput.style.fontSize = '14px';
                    messageInput.disabled = true;
                    inputWrapper.appendChild(messageInput);

                    // Send button via Button class
                    sendBtn = new Button(null);
                    sendBtn.setCaption('Отправить');
                    sendBtn.setIcon('/apps/general_icons/resources/public/16x16/send.png');
                    sendBtn.Draw(inputWrapper);
                    const sendBtnEl = sendBtn.getElement();
                    if (sendBtnEl) sendBtnEl.disabled = true;

                    const sendMessageHandler = () => {
                        const text = messageInput.value.trim();
                        if (text && currentChatId) sendMessage(text);
                    };

                    sendBtn.onClick = sendMessageHandler;
                    messageInput.addEventListener('keypress', (e) => {
                        if (e.key === 'Enter') { e.preventDefault(); sendMessageHandler(); }
                    });

                    // Resize handler
                    resizeHandler = () => {
                        const sw = window.innerWidth;
                        const sh = window.innerHeight;
                        const to = (typeof Form !== 'undefined' && Form.topOffset) ? Form.topOffset : 0;
                        const bo = (typeof Form !== 'undefined' && Form.bottomOffset) ? Form.bottomOffset : 0;
                        const fw = Math.round(sw / 2);
                        appForm.setWidth(fw);
                        appForm.setHeight(sh - to - bo);
                        appForm.setX(sw - fw);
                        appForm.setY(to);
                    };
                    window.addEventListener('resize', resizeHandler);

                    // Initial load
                    callServerMethod(APP_NAME, 'onLoad', {}).catch(() => {});
                    refreshChats();
                },

                onAction: async () => false,

                destroy: () => {
                    if (eventSource) { eventSource.close(); eventSource = null; }
                    if (resizeHandler) window.removeEventListener('resize', resizeHandler);
                    try { appForm.close(); } catch (e) {}
                }
            };

            appForm.instance = instance;
            await instance.onOpen(params);
            return instance;
        }
    };

    if (window.MySpace) {
        window.MySpace.register(APP_NAME, descriptor);
    } else {
        console.error('[messenger] window.MySpace not found!');
    }
})();