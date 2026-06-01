// Клиентские функции формы "Настройки пользователя".
//
// Загружается как исходный текст через loadScript() в init.js.
// Плейсхолдер __SERVER_SCRIPT__ заменяется на реальное имя серверного скрипта при загрузке.

async function applySettings(ev, ctx) {
    var form = ctx.form;
    var data = form.collectData();
    // Включаем табличные части (автозаполнение)
    try {
        var tabularSections = {};
        if (form._dataMap) {
            for (var key in form._dataMap) {
                var entry = form._dataMap[key];
                if (entry && entry.tabularSection === true) {
                    tabularSections[entry.tableName || key] = Array.isArray(entry.value) ? entry.value : [];
                }
            }
        }
        if (Object.keys(tabularSections).length > 0) data.__tabularSections = tabularSections;
    } catch (_) {}
    var result = await callServer('__SERVER_SCRIPT__', 'onSave', { changes: data, tableName: 'user_settings' });
    if (result && result.error) {
        showAlert(__t('Error: ') + result.error);
        return;
    }
    form.setModified(false);
    showAlert(__t('Settings saved'));
}

// Открывает форму смены пароля из приложения login (mode: 'changePassword').
function openChangePassword(ev, ctx) {
    if (window.MySpace && typeof window.MySpace.open === 'function') {
        window.MySpace.open('login', { mode: 'changePassword' });
    } else {
        console.error('[UserSettings] MySpace.open is not available');
    }
}

return { applySettings, openChangePassword };
