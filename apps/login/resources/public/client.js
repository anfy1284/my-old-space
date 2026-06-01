// Точка входа приложения "login" (autoStart для роли nologged).
//
// Бандлится сервером (loadApps) и выполняется при загрузке страницы до входа.
// Строит окно входа и рендерит серверный лейаут штатной системой DataForm.renderLayout:
//   1. callServer('login.actions','getFormSpec')  → { layout, clientScript }
//   2. form._clientScript = clientScript           — чтобы events.onClick в лейауте
//      резолвились в обработчики forms/login.client.js
//   3. form.renderLayout(content, layout)          — отрисовка через renderItem
//
// Никакой ручной вёрстки DOM — только framework-классы и серверный лейаут.

(function () {
    'use strict';

    async function showLoginForm() {
        var spec;
        try {
            spec = await callServer('login.actions', 'getFormSpec', {});
        } catch (e) {
            console.error('[login] getFormSpec failed:', e);
            return;
        }
        if (!spec || !Array.isArray(spec.layout)) {
            console.error('[login] empty form spec');
            return;
        }

        var form = new DataForm('login');
        form._clientScript = spec.clientScript || null;
        form.setTitle(__t('login_app_title'));
        form.setWidth(320);
        form.setHeight(360);
        form.setAnchorToWindow('center');
        if (typeof form.setResizable === 'function') form.setResizable(false); else form.resizable = false;
        form.Draw(document.body);

        var content = form.getContentArea();
        if (!content) { console.error('[login] no content area'); return; }
        await form.renderLayout(content, spec.layout);

        // Стартовое состояние формы — режим входа: повтор пароля и «Отмена» скрыты.
        try { if (form.controlsMap.confirmPassword) form.controlsMap.confirmPassword.setHidden(true); } catch (e) {}
        try { if (form.controlsMap.btnCancel) form.controlsMap.btnCancel.setHidden(true); } catch (e) {}

        window._loginForm = form;
    }

    try { showLoginForm(); } catch (e) { console.error('[login] init error:', e); }
})();
