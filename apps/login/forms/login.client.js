// Клиентские обработчики приложения "login" (форма входа и форма смены пароля).
//
// Загружается как clientScript-модуль через loadScript() в init.js; плейсхолдер
// __SERVER_SCRIPT__ заменяется на имя серверного скрипта ('login.actions').
// Фреймворк скачивает этот модуль по /files/<uid> при первом срабатывании события
// и вызывает обработчик как fn(eventArgs..., ctx), где ctx.form — текущий DataForm.
//
// Файл должен заканчиваться return { ... } — этого требует loadScript().
//
// ВНИМАНИЕ: гостевой вход и саморегистрация ОТКЛЮЧЕНЫ — у нас ERP, пользователи
// заводятся только администратором. Код гостевого входа сохранён ниже закомментированным.

function _value(form, name) {
    var ctrl = form.controlsMap && form.controlsMap[name];
    if (!ctrl) return '';
    var v = (typeof ctrl.getValue === 'function') ? ctrl.getValue()
          : (typeof ctrl.getText === 'function') ? ctrl.getText()
          : '';
    return v || '';
}

// Перерисовывает содержимое текущей формы в указанный режим ('login' | 'changePassword'),
// не пересоздавая окно. Используется для принудительной смены пароля сразу после входа.
// Меняем form._mode и переиспользуем штатные loadLayout()/renderLayout() формы
// (getLayoutWithData переопределён в точке входа и читает form._mode).
async function _renderMode(form, mode, forced) {
    form._mode = mode;
    form._forcedChange = !!forced;

    var content = form.getContentArea();
    if (content) content.innerHTML = '';
    form.controlsMap = {};

    await form.loadLayout();
    await form.renderLayout();

    // __t резолвится статически только для строк-литералов — поэтому без тернарника внутри.
    form.setTitle(mode === 'changePassword' ? __t('cp_app_title') : __t('login_app_title'));

    // При принудительной смене старый пароль не нужен — скрываем поле, а окно делаем
    // модальным (оверлей блокирует десктоп до завершения смены пароля).
    if (mode === 'changePassword' && forced) {
        try { if (form.controlsMap.oldPassword) form.controlsMap.oldPassword.setHidden(true); } catch (e) {}
        try { if (typeof form.setModal === 'function') form.setModal(true); } catch (e) {}
    }

    // Контент сменился (другое число полей) — подгоняем высоту окна под него и центрируем,
    // чтобы не оставалось пустого места под кнопкой.
    try {
        // Якорь — ДО подгонки размера: setSizeToContent центрирует только при заданном anchor.
        if (typeof form.setAnchorToWindow === 'function') form.setAnchorToWindow('center');
        if (typeof form.setSizeToContent === 'function') form.setSizeToContent({ minWidth: 320, padH: 12 });
    } catch (e) {}
}

async function onLogin(ev, ctx) {
    var form = ctx.form;
    var username = _value(form, 'username');
    var password = _value(form, 'password');
    if (!username || !password) { showAlert(__t('login_err_required')); return; }

    var res = await callServer('__SERVER_SCRIPT__', 'login', { username: username, password: password });
    if (!res || !res.success) { showAlert((res && res.error) || __t('login_err_failed')); return; }

    // Сессия уже привязана к пользователю. Если требуется смена пароля —
    // переключаем эту же форму в режим смены (без reload), иначе входим.
    if (res.mustChangePassword) { await _renderMode(form, 'changePassword', true); }
    else { location.reload(); }
}

async function onSubmitChangePassword(ev, ctx) {
    var form = ctx.form;
    var oldCtrl = form.controlsMap && form.controlsMap.oldPassword;
    var oldShown = oldCtrl && (typeof oldCtrl.getHidden !== 'function' || !oldCtrl.getHidden());

    var oldPassword = _value(form, 'oldPassword');
    var newPassword = _value(form, 'newPassword');
    var confirm     = _value(form, 'confirmPassword');

    if (oldShown && !oldPassword) { showAlert(__t('cp_err_old_required')); return; }
    if (!newPassword)             { showAlert(__t('cp_err_new_required')); return; }
    if (newPassword !== confirm)  { showAlert(__t('login_err_mismatch')); return; }

    var res = await callServer('__SERVER_SCRIPT__', 'changePassword', {
        oldPassword: oldPassword, newPassword: newPassword
    });
    if (!res || !res.success) { showAlert((res && res.error) || __t('login_err_failed')); return; }

    // Принудительная смена после входа — перезагружаем (входим на рабочий стол).
    // Добровольная смена (с рабочего стола) — закрываем окно с уведомлением.
    if (form._forcedChange) {
        location.reload();
    } else {
        showAlert(__t('cp_success'));
        try { form._modified = false; form.close(); } catch (e) {}
    }
}

// ── Гостевой вход временно отключён ───────────────────────────────────────────
// Чтобы вернуть: верни кнопку btnGuest в forms/login.layout.json
// (events.onClick: 'onGuest'), включи loginAsGuest в forms/login.server.js
// и добавь onGuest в экспорт ниже.
//
// async function onGuest(ev, ctx) {
//     var res = await callServer('__SERVER_SCRIPT__', 'loginAsGuest', {});
//     if (res && res.success) { location.reload(); }
//     else { showAlert((res && res.error) || __t('login_err_failed')); }
// }

return { onLogin, onSubmitChangePassword };
