// Клиентский обработчик кнопки «Сменить пароль» в форме записи справочника «Пользователи».
//
// Форма записи users — автогенерируемая (состав полей собирается из модели, которую
// дополняют и проект, и фреймворк), поэтому лейаут здесь не переопределяется: init.js
// регистрирует ТОЛЬКО кнопку (layoutMemory.saveLayout({ extraButtons })).
//
// Сама смена пароля выполняется формой приложения login (режим 'resetPassword') —
// тем же способом, каким «Настройки пользователя» открывают смену своего пароля.
//
// Файл должен заканчиваться return { ... } — этого требует loadScript().

function openResetPassword(ev, ctx) {
    var form = ctx.form;

    // Пароль назначается существующей записи: у несохранённой UID уже сгенерирован,
    // но строки в БД ещё нет — сервер такого пользователя не найдёт.
    if (typeof form.needsSave === 'function' && form.needsSave()) {
        showAlert(__t('rp_err_save_user_first'));
        return;
    }

    var uidEntry = form._dataMap && form._dataMap['UID'];
    var userId = uidEntry && uidEntry.value;
    if (!userId) { showAlert(__t('rp_err_save_user_first')); return; }

    var nameCtrl = form.controlsMap && form.controlsMap['name'];
    var userName = (nameCtrl && typeof nameCtrl.getValue === 'function') ? (nameCtrl.getValue() || '') : '';

    if (window.MySpace && typeof window.MySpace.open === 'function') {
        window.MySpace.open('login', { mode: 'resetPassword', userId: userId, userName: userName });
    } else {
        console.error('[users] MySpace.open is not available');
    }
}

return { openResetPassword };
