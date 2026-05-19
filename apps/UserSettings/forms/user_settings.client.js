// Клиентские функции формы "Настройки пользователя".
//
// Загружается как исходный текст через loadScript() в init.js.
// Плейсхолдер __SERVER_SCRIPT__ заменяется на реальное имя серверного скрипта при загрузке.
//
// Сигнатура обработчиков: function(eventArgs..., ctx)
//   ctx.form    — DataForm текущей формы
//   ctx.fnParams — параметры из лейаута
//
// Стандартные кнопки OK (сохранить + закрыть) и Отмена рендерятся через commandBar —
// их поведение встроено в DataForm.doAction и обрабатывается uniForm-пайплайном (onSave).
// Здесь только кнопка "Применить" (сохранить без закрытия).

async function applySettings(ev, ctx) {
    var form = ctx.form;
    var data = form.collectData();
    var result = await callServer('__SERVER_SCRIPT__', 'onSave', { changes: data, tableName: 'user_settings' });
    if (result && result.error) {
        showAlert(__t('Error: ') + result.error);
        return;
    }
    form.setModified(false);
    showAlert(__t('Settings saved'));
}

return { applySettings };
