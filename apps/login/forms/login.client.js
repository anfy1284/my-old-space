// Клиентские обработчики формы входа.
//
// Загружается как clientScript-модуль через loadScript() в init.js; плейсхолдер
// __SERVER_SCRIPT__ заменяется на имя серверного скрипта ('login.actions').
// Фреймворк скачивает этот модуль по /files/<uid> при первом срабатывании события
// и вызывает обработчик как fn(eventArgs..., ctx), где ctx.form — текущий DataForm.
//
// Файл должен заканчиваться return { ... } — этого требует loadScript().

// Текущий режим формы: false — вход, true — создание аккаунта (виден повтор пароля).
var _createMode = false;

function _value(form, name) {
    var ctrl = form.controlsMap && form.controlsMap[name];
    if (!ctrl) return '';
    var v = (typeof ctrl.getValue === 'function') ? ctrl.getValue()
          : (typeof ctrl.getText === 'function') ? ctrl.getText()
          : '';
    return v || '';
}

async function onLogin(ev, ctx) {
    var form = ctx.form;
    var username = _value(form, 'username');
    var password = _value(form, 'password');
    if (!username || !password) { showAlert(__t('login_err_required')); return; }

    var res = await callServer('__SERVER_SCRIPT__', 'login', { username: username, password: password });
    if (res && res.success) { location.reload(); }
    else { showAlert((res && res.error) || __t('login_err_failed')); }
}

async function onCreate(ev, ctx) {
    var form = ctx.form;

    // Первый клик — переход в режим создания: показать повтор пароля и кнопку отмены.
    if (!_createMode) {
        _createMode = true;
        form.controlsMap.confirmPassword.setHidden(false);
        form.controlsMap.btnCancel.setHidden(false);
        form.controlsMap.btnLogin.setHidden(true);
        form.controlsMap.btnGuest.setHidden(true);
        form.controlsMap.btnCreate.setCaption(__t('login_btn_confirm_create'));
        return;
    }

    // Второй клик — собственно создание аккаунта.
    var username = _value(form, 'username');
    var password = _value(form, 'password');
    var confirm  = _value(form, 'confirmPassword');
    if (!username || !password) { showAlert(__t('login_err_required')); return; }
    if (password !== confirm)   { showAlert(__t('login_err_mismatch')); return; }

    var res = await callServer('__SERVER_SCRIPT__', 'createUser', { username: username, password: password });
    if (res && res.success) { location.reload(); }
    else { showAlert((res && res.error) || __t('login_err_failed')); }
}

function onCancel(ev, ctx) {
    var form = ctx.form;
    _createMode = false;
    var confirmCtrl = form.controlsMap.confirmPassword;
    confirmCtrl.setHidden(true);
    if (typeof confirmCtrl.setValue === 'function') confirmCtrl.setValue('');
    form.controlsMap.btnCancel.setHidden(true);
    form.controlsMap.btnLogin.setHidden(false);
    form.controlsMap.btnGuest.setHidden(false);
    form.controlsMap.btnCreate.setCaption(__t('login_btn_create'));
}

async function onGuest(ev, ctx) {
    var res = await callServer('__SERVER_SCRIPT__', 'loginAsGuest', {});
    if (res && res.success) { location.reload(); }
    else { showAlert((res && res.error) || __t('login_err_failed')); }
}

return { onLogin, onCreate, onGuest, onCancel };
