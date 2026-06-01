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
        async function buildForm(mode) {
            var isCp = (mode === 'changePassword');
            var form = new DataForm('login');
            form._mode = mode;
            form._forcedChange = false; // ручная смена по умолчанию; принудительную ставит login.client.js

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
            form.setHeight(isCp ? 320 : 300);
            form.setAnchorToWindow('center');
            if (typeof form.setResizable === 'function') form.setResizable(false); else form.resizable = false;
            await form.Draw(document.body); // loadLayout() + renderLayout() выполняются внутри Draw

            // __t резолвится статически только для строк-литералов — поэтому без тернарника внутри.
            form.setTitle(isCp ? __t('cp_app_title') : __t('login_app_title'));
            return form;
        }

        var app = new App('login', { config: { allowMultipleInstances: false } });

        app.createInstance = async function (params) {
            var instanceId = this.generateInstanceId();
            var mode = (params && params.mode) || 'login';
            var form = await buildForm(mode);
            return {
                id: instanceId,
                appName: 'login',
                form: form,
                onOpen: async function (openParams) {
                    var m = (openParams && openParams.mode) || 'login';
                    // Окно закрыли — пересоздаём в нужном режиме.
                    if (!this.form || !this.form.element || !document.contains(this.form.element)) {
                        this.form = await buildForm(m);
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
            }
        } catch (e) {
            console.error('[login] boot check failed:', e);
        }
    })();
} catch (error) {
    console.error('[login] init error:', error);
}
