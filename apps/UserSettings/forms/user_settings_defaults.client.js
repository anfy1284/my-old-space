// Клиентские функции формы выбора таблицы (user_settings_table_list).

// ── Форма выбора таблицы (user_settings_table_list) ─────────────────────────────────────

// Вызывается двойным кликом по строке в таблице выбора.
// Эмулирует нажатие кнопки "Выбрать" (select action).
function selectTableByDblClick(ev, ctx) {
    var form = ctx.form;
    if (form && typeof form.doAction === 'function') {
        form.doAction('select');
    }
}

return { selectTableByDblClick };
