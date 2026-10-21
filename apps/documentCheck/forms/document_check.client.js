/**
 * Обработка «Проверка документов» — клиентская часть (ТЗ оповещений §13).
 *
 * ФОРМАТ ФАЙЛА: это ТЕЛО ФУНКЦИИ, а не модуль — `return { … }` обязан стоять на
 * ВЕРХНЕМ уровне. Имя серверного скрипта подставляется при регистрации
 * (`__SERVER_SCRIPT__`), хардкодить его нельзя: `loadScript` выдаёт новый UID на
 * каждом старте процесса.
 *
 * Действие строки выполняет ЯДРО (`MySpace.alerts.run`) — то же самое, что
 * делает гиперссылка в панели формы документа и клик по пуш-уведомлению. Своей
 * копии разбора здесь нет намеренно: три копии однажды повели бы себя
 * по-разному на одном и том же оповещении.
 */

/**
 * Форма из аргументов обработчика.
 *
 * Контекст приходит ПОСЛЕДНИМ аргументом, а своих аргументов у события столько,
 * сколько их у этого элемента: у кнопки — один, у списка значений — три
 * (`onRoomSelected(rowIndex, newVal, displayVal, ctx)`). Поэтому брать `ctx`
 * вторым параметром нельзя: на `onChange` списка вторым приходит значение, и
 * обработчик падал на `form.getControl is not a function` — ровно это и
 * показал живой прогон 02.10.2026.
 */
function formOf(args) {
    var last = args && args.length ? args[args.length - 1] : null;
    if (last && last.form) return last.form;
    var first = args && args.length ? args[0] : null;
    if (first && first.form) return first.form;
    return (first && typeof first.getControl === 'function') ? first : null;
}

/** Текущая строка таблицы или null. */
function activeRow(form) {
    var tbl = form && form.getControl('alertsTable');
    if (!tbl) return null;
    try {
        var rows = (typeof tbl.data_getRows === 'function') ? tbl.data_getRows(tbl.dataKey) : [];
        var idx = tbl._activeRowIndex;
        if (idx === null || idx === undefined || idx < 0) return null;
        return rows[idx] || null;
    } catch (e) {
        return null;
    }
}

/** Значение реквизита формы (отбора). */
function attr(form, name) {
    var rec = form && form._dataMap && form._dataMap[name];
    return (rec && rec.value) || '';
}

/** Перечитать список по текущему отбору. */
async function refresh() {
    var form = formOf(arguments);
    if (!form) return;
    try {
        var res = await window.callServer('__SERVER_SCRIPT__', 'load', {
            severity: attr(form, 'fSeverity'),
            documentTable: attr(form, 'fTable')
        });
        if (res && res.ok) {
            var tbl = form.getControl('alertsTable');
            if (tbl && typeof tbl.setRowsData === 'function') tbl.setRowsData(res.rows || []);
        }
    } catch (e) {
        console.error('[documentCheck] список не перечитан:', e && e.message);
        showAlert(__t('Error: ') + (e && e.message || ''));
    }
}

/** Выполнить действие текущего оповещения. */
async function runAction() {
    var form = formOf(arguments);
    var row = activeRow(form);
    if (!row) { showAlert(__t('Nothing is selected')); return; }
    if (!row.action || !row.action.kind) { showAlert(__t('This notice has no action')); return; }
    await window.MySpace.alerts.run(row.action);
}

/** Открыть сам документ — он нужен и тогда, когда действия у оповещения нет. */
async function openDocument() {
    var form = formOf(arguments);
    var row = activeRow(form);
    if (!row) { showAlert(__t('Nothing is selected')); return; }
    await window.MySpace.open('uniForm', {
        mode: 'record', tableName: row.__table, recordID: row.UID
    });
}

return { refresh, runAction, openDocument };
