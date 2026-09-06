(function () {
    /**
     * Трей — область значков в правой части панели задач (аналог области
     * уведомлений Windows).
     *
     * Отдельное приложение, а не кусок панели задач: панель задач показывает
     * ОКНА (кнопка появляется и исчезает вместе с окном), трей показывает
     * ПРИЛОЖЕНИЯ (значок стоит независимо от того, открыто окно или нет). Это
     * разные жизненные циклы, и смешивать их в одном модуле — та самая заплатка,
     * из-за которой потом нельзя выключить одно, не сломав другое.
     *
     * Состав значков объявляется в манифесте приложения:
     *
     *     "tray": { "icon": "/apps/general_icons/.../email.png",
     *               "tooltip": { "i18n": "messenger_app_caption" } }
     *
     * и приезжает на клиент в window.MySpaceAppConfig (см. buildAppConfigCode
     * в drive_forms/globalServerContext.js). Приложение, недоступное роли, до
     * клиента не доезжает вовсе — отдельной проверки прав здесь нет и не нужно.
     */
    const Tray = {
        container: null,
        items: [],      // [{ appName, cfg, element }]
        _built: false,

        build: function () {
            if (this._built) return;
            const taskbar = window.MySpaceTaskbar;
            const container = taskbar && typeof taskbar.getTrayContainer === 'function'
                ? taskbar.getTrayContainer() : null;
            if (!container) return;   // панель задач ещё не отрисована — ждём события

            this.container = container;
            this._built = true;

            const configs = window.MySpaceAppConfig || {};
            Object.keys(configs).forEach(appName => {
                const tray = configs[appName] && configs[appName].tray;
                if (!tray || !tray.icon) return;
                this.addItem(appName, tray);
            });

            // Нажатое/отжатое состояние значка следует за окном приложения.
            window.addEventListener('form-created', () => this.updateAll());
            window.addEventListener('form-destroyed', () => this.updateAll());
            window.addEventListener('form-minimized', () => this.updateAll());
            window.addEventListener('form-restored', () => this.updateAll());
            this.updateAll();
        },

        addItem: function (appName, cfg) {
            const el = document.createElement('div');
            el.style.position = 'relative';   // якорь для счётчика (см. setBadge)
            el.style.width = '20px';
            el.style.height = '20px';
            el.style.display = 'flex';
            el.style.alignItems = 'center';
            el.style.justifyContent = 'center';
            el.style.cursor = 'default';
            el.style.boxSizing = 'border-box';
            el.style.border = '1px solid transparent';
            if (cfg.tooltip) el.title = cfg.tooltip;

            // Иконка — только через ядро: оно само выбирает файл под размер либо
            // master и проставляет srcset (см. MySpace.icon).
            const img = MySpace.icon.img(cfg.icon, 16);
            el.appendChild(img);

            el.onclick = (e) => {
                e.stopPropagation();
                this.toggleApp(appName);
            };

            this.container.appendChild(el);
            this.items.push({ appName: appName, cfg: cfg, element: el, badge: null });
        },

        /**
         * Счётчик на значке приложения (непрочитанные сообщения и т.п.).
         *
         * Метод трея, а не приложения: значок принадлежит трею, и рисовать
         * поверх чужого элемента из прикладного кода — это ручной DOM в
         * приложении, ровно то, от чего мы уходим. Ноль или пусто — счётчик
         * снимается.
         *
         * @param {string} appName
         * @param {number} count
         */
        setBadge: function (appName, count) {
            const item = this.items.find(i => i.appName === appName);
            if (!item) return;
            const n = Number(count) || 0;
            if (!n) {
                if (item.badge) { item.badge.remove(); item.badge = null; }
                return;
            }
            if (!item.badge) {
                item.badge = document.createElement('span');
                item.badge.className = 'ui-tray-badge';
                item.element.appendChild(item.badge);
            }
            // Трёхзначные счётчики значок не вмещает и не нужны: важно «много».
            item.badge.textContent = n > 99 ? '99+' : String(n);
        },

        /** Живое окно приложения или null. */
        findForm: function (appName) {
            if (!window.MySpace || typeof MySpace.listInstances !== 'function') return null;
            const open = MySpace.listInstances().filter(i => i.appName === appName);
            if (!open.length) return null;
            const inst = MySpace.getInstance(open[0].id);
            if (!inst) return null;
            return inst.form || inst;
        },

        isVisible: function (form) {
            return !!(form && form.element && form.element.style.display !== 'none');
        },

        /**
         * Клик по значку: окна нет — открыть; окно на экране — спрятать;
         * окно свёрнуто — показать. Ровно переключатель, как задумано владельцем:
         * второй клик по значку убирает окно с экрана.
         */
        toggleApp: function (appName) {
            const form = this.findForm(appName);
            if (!form) {
                if (window.MySpace && typeof MySpace.open === 'function') {
                    MySpace.open(appName).catch(err => console.error('[tray] open ' + appName, err));
                }
                return;
            }
            if (this.isVisible(form)) form.minimize();
            else form.restore();
        },

        updateAll: function () {
            this.items.forEach(item => {
                const form = this.findForm(item.appName);
                const pressed = this.isVisible(form);
                const el = item.element;
                if (pressed) {
                    el.style.borderTop = '1px solid #808080';
                    el.style.borderLeft = '1px solid #808080';
                    el.style.borderRight = '1px solid #ffffff';
                    el.style.borderBottom = '1px solid #ffffff';
                } else {
                    el.style.border = '1px solid transparent';
                }
            });
        }
    };

    window.MySpaceTray = Tray;

    // Панель задач и трей — два приложения одного бандла, и порядок их загрузки
    // задаётся apps.json. Слушаем событие готовности панели И пробуем собрать
    // сразу: так порядок перестаёт иметь значение.
    window.addEventListener('taskbar-ready', () => Tray.build());
    window.addEventListener('load', () => Tray.build());
})();
