// Точка входа приложения «messenger» (autoStart).
//
// Тонкая по замыслу: строит окно и отдаёт форме серверную спецификацию
// (getFormSpec), а всю обвязку делает клиентский скрипт формы в событии onReady
// (forms/messenger.client.js). Ручной вёрстки здесь нет — список чатов и лента
// рисуются контролами фреймворка по лейауту.
//
// Мессенджер — фоновое приложение: значок в трее, окна нет в панели задач,
// крестик сворачивает (см. config.json: tray/hideFromTaskbar/preventClose).

try {
    (function () {
        'use strict';

        var APP_NAME = 'messenger';

        async function buildForm(params) {
            var form = new DataForm(APP_NAME);

            // Чат, на который надо встать, как только форма будет готова.
            //
            // Готовность приходит ПОЗЖЕ построения окна: обработчики формы живут
            // в клиентском скрипте, который ядро подгружает запросом (onReady →
            // callClientBinding → fetch /files/<uid>). Клик по уведомлению на
            // свежей странице попадал ровно в этот промежуток — окно уже есть,
            // обработчиков ещё нет, и выбор чата терялся молча.
            if (params && params.chatId) form._pendingChatId = params.chatId;

            form.getLayoutWithData = async function () {
                var spec;
                try {
                    spec = await callServer('messenger.actions', 'getFormSpec', {});
                } catch (e) {
                    console.error('[messenger] getFormSpec failed:', e);
                    return { layout: [], data: [] };
                }
                if (!spec || !Array.isArray(spec.layout)) return { layout: [], data: [] };
                return {
                    layout: spec.layout,
                    clientScript: spec.clientScript,
                    events: spec.events,
                    appCaption: spec.appCaption,
                    data: []
                };
            };

            // Правая половина экрана — переписку держат открытой рядом с работой,
            // а не поверх неё.
            var topOffset = (typeof Form !== 'undefined' && Form.topOffset) ? Form.topOffset : 0;
            var bottomOffset = (typeof Form !== 'undefined' && Form.bottomOffset) ? Form.bottomOffset : 0;
            var w = Math.max(520, Math.round(window.innerWidth / 2));
            form.setWidth(w);
            form.setHeight(window.innerHeight - topOffset - bottomOffset);
            form.setX(window.innerWidth - w);
            form.setY(topOffset);

            await form.Draw(document.body);
            return form;
        }

        var app = new App(APP_NAME, { config: { allowMultipleInstances: false } });

        app.createInstance = async function (params) {
            var instanceId = this.generateInstanceId();
            var form = await buildForm(params);

            var instance = {
                id: instanceId,
                appName: APP_NAME,
                form: form,

                onOpen: async function (openParams) {
                    // Окно единственное: повторное открытие (значок в трее, клик по
                    // уведомлению) не пересобирает интерфейс, а поднимает готовое.
                    var alive = !!(this.form && this.form.element && document.contains(this.form.element));
                    if (!alive) this.form = await buildForm(openParams);
                    if (typeof this.form.restore === 'function') this.form.restore();
                    if (openParams && openParams.chatId) this.selectChat(openParams.chatId);
                },

                // Публичный метод экземпляра: им пользуется обработчик клика по
                // уведомлению (forms/messenger.client.js → openChat).
                selectChat: function (chatId) {
                    if (!chatId) return;
                    var api = this.form && this.form._messenger;
                    if (api && typeof api.selectChat === 'function') { api.selectChat(chatId); return; }
                    // Обработчиков формы ещё нет — оставляем чат ожидающим,
                    // onFormReady его подхватит. Тихо потерять просьбу нельзя:
                    // пользователь нажал на уведомление и ждёт свой разговор.
                    if (this.form) this.form._pendingChatId = chatId;
                },

                onAction: async function () { return false; },

                destroy: function () {
                    try {
                        var api = this.form && this.form._messenger;
                        if (api && typeof api.destroy === 'function') api.destroy();
                    } catch (e) {}
                    try { if (this.form && this.form.close) this.form.close(); } catch (e) {}
                }
            };

            form.instance = instance;
            // Параметры открытия применяет onOpen — и для нового окна тоже.
            // MySpace зовёт onOpen только когда окно УЖЕ было; без этой строки
            // у первого открытия был бы свой, второй путь применения chatId,
            // и однажды они разошлись бы.
            if (params && params.chatId) await instance.onOpen(params);
            return instance;
        };

        try { app.register(); } catch (e) { console.error('[messenger] register failed:', e); }
    })();
} catch (error) {
    console.error('[messenger] init error:', error);
}
