(function () {
    /**
     * Пуш-уведомления — стек в правом нижнем углу экрана.
     *
     * Одно место показа на всю систему: приложение-источник только СТАВИТ
     * уведомление, а как оно выглядит и где — решает этот модуль. Иначе каждое
     * приложение рисовало бы свою всплывашку и они наложились бы друг на друга.
     *
     * Порядок стека — как в переписке: новое появляется СНИЗУ, старые уезжают
     * вверх. Когда уведомлений становится больше, чем помещается на экран,
     * область прокручивается (см. .mos-notify-area в style.css), а не растёт
     * до верхнего края.
     *
     * Клик по уведомлению зовёт ИМЕНОВАННУЮ функцию приложения-источника — тем
     * же способом, что и события лейаута (`doAction('runScript')`): текст скрипта
     * берётся из fileStore по UID, из него достаётся функция по имени. Имя и
     * параметры лежат в базе, UID подставляет сервер при выдаче — поэтому клик
     * работает и после перезагрузки страницы.
     */
    const APP_NAME = 'notifications';

    const Notifications = {
        area: null,
        clearBtn: null,
        items: [],          // [{ data, element }] — в порядке показа (свежие в конце)
        _scriptCache: {},   // UID скрипта → модуль (не тянуть один файл на каждый клик)
        _unsubscribe: null,

        // ── Построение области ────────────────────────────────────────────
        build: function () {
            if (this.area) return;

            this.area = document.createElement('div');
            this.area.className = 'mos-notify-area';
            // Геометрия зависит от панели задач и главного меню — значения
            // динамические, поэтому задаются здесь, а не в CSS.
            const bottomOffset = (typeof Form !== 'undefined' && Form.bottomOffset) ? Form.bottomOffset : 0;
            const topOffset = (typeof Form !== 'undefined' && Form.topOffset) ? Form.topOffset : 0;
            this.area.style.bottom = (bottomOffset + 8) + 'px';
            this.area.style.maxHeight = 'calc(100vh - ' + (topOffset + bottomOffset + 16) + 'px)';
            this.area.style.display = 'none';
            document.body.appendChild(this.area);

            // Кнопка — классом Button, как любая кнопка интерфейса. Липкую
            // позицию держит ОБЁРТКА, а не сама кнопка: Button.Draw проставляет
            // `position` инлайном, и он победил бы `position: sticky` из стилей.
            // Контейнер передаётся в конструктор — без parentElement кнопка
            // уходит в `position: absolute` и садится в угол области.
            const clearWrap = document.createElement('div');
            clearWrap.className = 'mos-notify-clear';
            this.area.appendChild(clearWrap);

            this.clearBtn = new Button(clearWrap, {
                showIcon: true, showText: true, caption: __t('notif_clear_all'),
                icon: '/apps/general_icons/resources/public/16x16/clear_all.png'
            });
            this.clearBtn.Draw(clearWrap);
            this.clearBtn.onClick = () => this.clearAll();
        },

        // ── Отрисовка одного уведомления ──────────────────────────────────
        createElement: function (n) {
            const item = document.createElement('div');
            item.className = 'mos-notify-item';

            const head = document.createElement('div');
            head.className = 'mos-notify-head';
            if (n.icon) head.appendChild(MySpace.icon.img(n.icon, 16));

            const title = document.createElement('span');
            title.className = 'mos-notify-title';
            title.textContent = n.title || '';
            head.appendChild(title);

            const time = document.createElement('span');
            time.className = 'mos-notify-time';
            time.textContent = this.formatTime(n.createdAt);
            head.appendChild(time);

            item.appendChild(head);

            const text = document.createElement('div');
            text.className = 'mos-notify-text';
            text.textContent = n.text || '';
            item.appendChild(text);

            // Кликается только уведомление, у которого есть обработчик: иначе
            // нажатие ничего не делает, и «мёртвый» курсор об этом врёт.
            if (n.handler || typeof n.onClick === 'function') {
                item.classList.add('mos-notify-clickable');
                item.onclick = () => this.activate(n);
            }

            return item;
        },

        formatTime: function (value) {
            try {
                const d = value ? new Date(value) : new Date();
                if (isNaN(d.getTime())) return '';
                const p = v => String(v).padStart(2, '0');
                return p(d.getHours()) + ':' + p(d.getMinutes());
            } catch (e) { return ''; }
        },

        // ── Добавление в стек ─────────────────────────────────────────────
        /** Показать готовое уведомление (из базы или из потока событий). */
        push: function (n) {
            if (!n) return null;
            this.build();
            // Одно и то же уведомление может прийти дважды: списком при загрузке
            // и потоком событий. Ключ — UID строки.
            if (n.UID && this.items.some(i => i.data.UID === n.UID)) return null;

            const el = this.createElement(n);
            this.area.appendChild(el);           // свежее — вниз
            this.items.push({ data: n, element: el });
            this.area.style.display = 'flex';
            // Показать только что пришедшее, даже если стек прокручен вверх.
            this.area.scrollTop = this.area.scrollHeight;
            return n;
        },

        /**
         * Поставить уведомление из клиентского кода.
         *
         *   MySpace.notify({ title, text, icon, appName,
         *                    onClick: { fn: 'openChat', fnParams: { chatId } } })
         *
         * По умолчанию уведомление СОХРАНЯЕТСЯ (переживает перезагрузку) — его
         * записывает сервер и возвращает обратно потоком событий, поэтому здесь
         * оно не добавляется в стек вручную. Живая функция в `onClick` сохранена
         * быть не может, поэтому такое уведомление показывается только в этой
         * вкладке; то же делает явный `local: true`.
         */
        show: function (params) {
            const p = params || {};
            this.build();

            const isLocal = p.local === true || typeof p.onClick === 'function';
            if (isLocal) {
                return this.push({
                    UID: null,
                    appName: p.appName || null,
                    title: p.title || '',
                    text: p.text || '',
                    icon: p.icon || null,
                    createdAt: new Date().toISOString(),
                    handler: null,
                    onClick: (typeof p.onClick === 'function') ? p.onClick : null
                });
            }

            callServerMethod(APP_NAME, 'notifySelf', {
                appName: p.appName || null,
                title: p.title || null,
                text: p.text || '',
                icon: p.icon || null,
                onClick: p.onClick || null
            }).catch(err => console.error('[notifications] notifySelf:', err.message));
            return null;
        },

        // ── Клик по уведомлению ───────────────────────────────────────────
        activate: async function (n) {
            try {
                if (typeof n.onClick === 'function') {
                    await n.onClick(n);
                } else if (n.handler) {
                    const mod = await this.loadHandlerModule(n.handler.scriptUID);
                    if (mod && typeof mod[n.handler.fn] === 'function') {
                        await mod[n.handler.fn](n.handler.fnParams || {}, { notification: n });
                    } else {
                        console.error('[notifications] обработчик не найден: ' + n.handler.fn);
                    }
                }
            } catch (e) {
                console.error('[notifications] обработчик упал:', e && e.message);
            }
            // Обработанное уведомление уходит со стека — как прочитанное письмо.
            this.remove(n);
        },

        loadHandlerModule: async function (uid) {
            if (!uid) return null;
            if (this._scriptCache[uid]) return this._scriptCache[uid];
            const resp = await fetch('/files/' + uid);
            if (!resp.ok) { console.error('[notifications] скрипт обработчиков недоступен'); return null; }
            const code = await resp.text();
            const mod = (new Function(code))();
            this._scriptCache[uid] = mod;
            return mod;
        },

        // ── Снятие со стека ───────────────────────────────────────────────
        remove: function (n) {
            const idx = this.items.findIndex(i => i.data === n || (n.UID && i.data.UID === n.UID));
            if (idx === -1) return;
            const item = this.items[idx];
            if (item.element) item.element.remove();
            this.items.splice(idx, 1);
            if (!this.items.length && this.area) this.area.style.display = 'none';
            if (n.UID) {
                callServerMethod(APP_NAME, 'remove', { UID: n.UID })
                    .catch(err => console.error('[notifications] remove:', err.message));
            }
        },

        clearAll: function () {
            this.items.forEach(i => { if (i.element) i.element.remove(); });
            this.items = [];
            if (this.area) this.area.style.display = 'none';
            callServerMethod(APP_NAME, 'clearAll', {})
                .catch(err => console.error('[notifications] clearAll:', err.message));
        },

        // ── Запуск ────────────────────────────────────────────────────────
        init: function () {
            this.build();

            // Уведомления, накопившиеся пока пользователя не было.
            callServerMethod(APP_NAME, 'list', {})
                .then(result => {
                    if (!result || result.error) return;
                    (result.notifications || []).forEach(n => this.push(n));
                })
                .catch(err => console.error('[notifications] list:', err.message));

            // Живые уведомления — по сессионному каналу событий. Своего потока
            // не заводим: окно и так держит один (см. MySpaceEvents).
            if (window.MySpaceEvents) {
                this._unsubscribe = window.MySpaceEvents.on((d) => {
                    if (d && d.type === 'notification' && d.notification) this.push(d.notification);
                });
            }
        }
    };

    // Приложение подставляет себя в ядро: MySpace.notify() зовёт Notifications.show().
    if (window.MySpace) {
        window.MySpace.notifications = Notifications;
    } else {
        console.error('[notifications] window.MySpace не найден!');
    }

    window.addEventListener('load', () => Notifications.init());
})();
