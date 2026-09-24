/**
 * Обработка «Удаление помеченных объектов» — клиентская часть.
 *
 * ФОРМАТ ФАЙЛА: это ТЕЛО ФУНКЦИИ, а не модуль — `return { … }` обязан стоять на
 * ВЕРХНЕМ уровне. Имя серверного скрипта подставляется при регистрации
 * (`__SERVER_SCRIPT__`), хардкодить его нельзя: `loadScript` выдаёт новый UID на
 * каждом старте процесса.
 *
 * ДВЕ ТАБЛИЦЫ, СВЯЗЬ ШТАТНАЯ. Верхняя — помеченные объекты, нижняя — кто на
 * текущий из них ссылается. Связь объявлена в лейауте (`masterFor` +
 * `masterField`/`detailField`), то есть её ведёт ядро: клиент не подписывается на
 * перемещение курсора и ничего не дочитывает. Здесь остаётся только вернуть
 * связь в исходное состояние после замены строк.
 */

/**
 * Выделенные строки верхней таблицы.
 *
 * Выделение ведёт САМА ТАБЛИЦА: отметки в первой колонке, пробел, Ctrl/Shift,
 * кнопки «выделить все / снять / инвертировать» на её панели.
 */
function selectedItems(form) {
    var tbl = form && form.getControl('markedTable');
    if (!tbl || typeof tbl.selectedRows === 'undefined') return [];
    return (tbl.selectedRows || []).map(function (r) {
        return { table: r.table, uid: r.uid, name: r.name };
    });
}

/**
 * Переложить пришедшие с сервера строки в обе таблицы.
 *
 * Порядок важен: сначала подчинённая (иначе связь наведётся на старые ссылки),
 * потом главная, и только потом активация первой строки — она и включает связь.
 */
function applyData(form, res) {
    if (!form || !res) return;
    var refs = form.getControl('refsTable');
    var marked = form.getControl('markedTable');
    if (refs && typeof refs.setRowsData === 'function') refs.setRowsData(res.refs || []);
    if (marked && typeof marked.setRowsData === 'function') marked.setRowsData(res.marked || []);
    syncRefs(form);
}

/**
 * Навести нижнюю таблицу на текущий объект.
 *
 * Строки заменены — активной строки больше нет, а значит нет и события, которым
 * ядро наводит связь. Ставим курсор на первую строку сами; если помеченных не
 * осталось, связь наводится на заведомо несуществующий объект, иначе внизу
 * остались бы ссылки на уже удалённое.
 */
function syncRefs(form) {
    var marked = form && form.getControl('markedTable');
    var refs = form && form.getControl('refsTable');
    if (!marked || !refs) return;
    var rows = (typeof marked.data_getRows === 'function') ? marked.data_getRows(marked.dataKey) : [];
    if (rows && rows.length) {
        try { marked.activateRow(0); } catch (e) {}
    } else if (typeof refs.setFilter === 'function') {
        refs.setFilter('ownerKey', '__none__', { type: 'client', visibility: 'hidden', operator: '=' });
    }
}

/** КОНТРОЛЬ — перечитать помеченные и их ссылки. */
async function runControl(ev, ctx) {
    var form = (ctx && ctx.form) || ev;
    try {
        var res = await window.callServer('__SERVER_SCRIPT__', 'control', {});
        if (res && res.ok) applyData(form, res);
    } catch (e) {
        console.error('[deleteMarked] контроль:', e && e.message);
        showAlert(__t('Error: ') + (e && e.message || ''));
    }
}

/**
 * КОНТРОЛЬ И УДАЛЕНИЕ.
 *
 * Переспрос обязателен и называет количество: это единственное необратимое
 * действие во всей цепочке удаления, и «сколько именно» — то, что человек
 * проверяет перед тем, как согласиться. Итог — короткой фразой в диалоге; что
 * именно помешало, видно в таблицах: объект остался, и внизу перечислено, кто на
 * него ссылается.
 */
async function controlAndDelete(ev, ctx) {
    var form = (ctx && ctx.form) || ev;
    var items = selectedItems(form);
    if (!items.length) { showAlert(__t('Nothing is selected')); return; }

    var question = __t('Permanently delete the selected objects? This cannot be undone.')
        + ' (' + items.length + ')';
    window.showConfirm(question, async function () {
        try {
            var res = await window.callServer('__SERVER_SCRIPT__', 'removeSelected', { items: items });
            if (res && res.ok) {
                applyData(form, res);
                showAlert(res.message);
            } else if (res && res.error) {
                showAlert(res.error);
            }
        } catch (e) {
            console.error('[deleteMarked] удаление:', e && e.message);
            showAlert(__t('Error: ') + (e && e.message || ''));
        }
    });
}

/** Снять пометку с отмеченных — передумал. Переспроса не требует: обратимо. */
async function unmarkSelected(ev, ctx) {
    var form = (ctx && ctx.form) || ev;
    var items = selectedItems(form);
    if (!items.length) { showAlert(__t('Nothing is selected')); return; }
    try {
        var res = await window.callServer('__SERVER_SCRIPT__', 'unmarkSelected', { items: items });
        if (res && res.ok) {
            applyData(form, res);
            showAlert(res.message);
        }
    } catch (e) {
        console.error('[deleteMarked] снятие пометки:', e && e.message);
    }
}

return { runControl, controlAndDelete, unmarkSelected };
