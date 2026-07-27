// Точка входа приложения "login" (autoStart).
//
// Регистрирует MySpace-приложение 'login' с двумя режимами (mode):
//   - 'login'          — форма входа; авто-открывается для неавторизованной сессии;
//   - 'changePassword' — форма смены пароля; открывается принудительно после входа
//                        (внутри формы, см. login.client.js) или вручную через
//                        MySpace.open('login', { mode: 'changePassword' }) из параметров пользователя.
//
// Лейаут берётся с сервера (getFormSpec) и рисуется штатным DataForm.renderLayout —
// никакой ручной вёрстки DOM.

try {
    (async function () {
        'use strict';

        // Строит и отрисовывает окно формы для указанного режима.
        //
        // DataForm.Draw() сам вызывает loadLayout() → renderLayout(); loadLayout берёт
        // лейаут из form.getLayoutWithData(). Переопределяем этот метод, чтобы отдать
        // серверный лейаут нашего приложения (getFormSpec) и передать режим (form._mode).
        async function buildForm(mode, forced, params) {
            var isCp = (mode === 'changePassword');
            var isRp = (mode === 'resetPassword');
            var form = new DataForm('login');
            form._mode = mode;
            // Принудительную смену задаёт вызывающий: после входа (login.client.js) или
            // boot при mustChangePassword. По умолчанию — ручная смена (forced=false).
            form._forcedChange = isCp && !!forced;
            // Целевой пользователь режима 'resetPassword' (сброс пароля администратором):
            // задаётся при открытии из формы записи справочника «Пользователи».
            form._targetUserId   = (params && params.userId)   || null;
            form._targetUserName = (params && params.userName) || '';

            form.getLayoutWithData = async function () {
                var spec;
                try {
                    spec = await callServer('login.actions', 'getFormSpec', { mode: form._mode });
                } catch (e) {
                    console.error('[login] getFormSpec failed:', e);
                    return { layout: [], data: [] };
                }
                if (!spec || !Array.isArray(spec.layout)) return { layout: [], data: [] };
                return { layout: spec.layout, clientScript: spec.clientScript, data: [] };
            };

            form.setWidth(320);
            if (typeof form.setResizable === 'function') form.setResizable(false); else form.resizable = false;
            await form.Draw(document.body); // loadLayout() + renderLayout() выполняются внутри Draw

            // __t резолвится статически только для строк-литералов — поэтому без тернарника внутри.
            var title = __t('login_app_title');
            if (isCp) title = __t('cp_app_title');
            if (isRp) title = __t('rp_app_title') + (form._targetUserName ? ' — ' + form._targetUserName : '');
            form.setTitle(title);

            // При принудительной смене старый пароль не нужен — скрываем поле.
            // Окно делаем модальным: оверлей блокирует клики по десктопу, чтобы нельзя
            // было пользоваться системой в обход смены пароля (серверный гейт — основная
            // защита, модальность — UI-блок поверх него).
            if (isCp && forced) {
                try { if (form.controlsMap && form.controlsMap.oldPassword) form.controlsMap.oldPassword.setHidden(true); } catch (e) {}
                try { if (typeof form.setModal === 'function') form.setModal(true); } catch (e) {}
            }

            // Якорь центрирования ставим ДО подгонки размера: setSizeToContent
            // перецентрирует окно только если anchorToWindow уже задан.
            form.setAnchorToWindow('center');
            // Подгоняем высоту окна под контент — иначе под кнопкой остаётся пустое место
            // (фиксированная высота не учитывала реальное число полей). Ширину держим 320.
            if (typeof form.setSizeToContent === 'function') form.setSizeToContent({ minWidth: 320, padH: 12 });
            return form;
        }

        var app = new App('login', { config: { allowMultipleInstances: false } });

        app.createInstance = async function (params) {
            var instanceId = this.generateInstanceId();
            var mode = (params && params.mode) || 'login';
            var form = await buildForm(mode, params && params.forced, params);
            return {
                id: instanceId,
                appName: 'login',
                form: form,
                onOpen: async function (openParams) {
                    var m = (openParams && openParams.mode) || 'login';
                    var alive = !!(this.form && this.form.element && document.contains(this.form.element));
                    // Открыли в другом режиме (или сброс пароля для ДРУГОГО пользователя) —
                    // старое окно закрываем: иначе активируется форма с прежней целью.
                    if (alive) {
                        var sameTarget = (this.form._mode === m) &&
                            (m !== 'resetPassword' || this.form._targetUserId === (openParams && openParams.userId));
                        if (!sameTarget) {
                            try { this.form._modified = false; this.form.close(); } catch (e) {}
                            alive = false;
                        }
                    }
                    // Окно закрыли — пересоздаём в нужном режиме.
                    if (!alive) {
                        this.form = await buildForm(m, openParams && openParams.forced, openParams);
                    } else if (typeof this.form.activate === 'function') {
                        try { this.form.activate(); } catch (e) {}
                    }
                },
                destroy: function () { try { if (this.form && this.form.close) this.form.close(); } catch (e) {} }
            };
        };

        try { app.register(); } catch (e) { console.error('[login] register failed:', e); }

        // Авто-показ формы входа только для неавторизованной сессии.
        try {
            var boot = await callServer('login.actions', 'getBootInfo', {});
            if (!boot || !boot.authenticated) {
                await window.MySpace.open('login', { mode: 'login' });
            } else if (boot.mustChangePassword) {
                // Сессия уже привязана к пользователю, но пароль ещё не сменён. После
                // перезагрузки страницы принудительно показываем форму смены пароля —
                // иначе пользователь попадёт в систему в обход обязательной смены.
                await window.MySpace.open('login', { mode: 'changePassword', forced: true });
            }
        } catch (e) {
            console.error('[login] boot check failed:', e);
        }
    })();
} catch (error) {
    console.error('[login] init error:', error);
}
