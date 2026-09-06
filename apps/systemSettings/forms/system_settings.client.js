// Клиентские функции формы «Настройки системы».
//
// Загружается как исходный текст через loadScript() в init.js.
// Плейсхолдер __SERVER_SCRIPT__ заменяется на реальное имя серверного скрипта.

// Сохранение системных настроек.
async function applySettings(ev, ctx) {
    var form = ctx.form;
    var data = form.collectData();
    var result = await callServer('__SERVER_SCRIPT__', 'onSave', { changes: data, tableName: 'system_settings' });
    if (result && result.error) {
        showAlert(__t('Error: ') + result.error);
        return;
    }
    form.setModified(false);
    showAlert(__t('Settings saved'));
}

return { applySettings };
