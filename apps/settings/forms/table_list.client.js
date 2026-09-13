// Клиентские функции формы выбора таблицы (user_settings_table_list).
//
// Переехало из apps/UserSettings при его удалении: механизм автозаполнения не менялся.

// Двойной клик по строке = нажать «Выбрать».
function selectTableByDblClick(ev, ctx) {
    var form = ctx.form;
    if (form && typeof form.doAction === 'function') {
        form.doAction('select');
    }
}

return { selectTableByDblClick };
