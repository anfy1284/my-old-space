// Клиентские функции формы «Резервное копирование».
//
// Файл грузится как исходный текст через loadScript() в init.js; плейсхолдер
// __SERVER_SCRIPT__ заменяется там на реальное имя серверного скрипта.
// Сигнатура обработчиков: function(eventArgs..., ctx), ctx = { form, fnParams }.
// Файл обязан заканчиваться `return { ... }` — этого требует loadScript().

var selectedFileUID = null;
var selectedFileMissing = false;

function ctrl(form, name) {
    return (form && form.controlsMap && form.controlsMap[name]) || null;
}

function setStatusText(form, text) {
    var c = ctrl(form, 'statusText');
    if (c && typeof c.setValue === 'function' && text !== undefined && text !== null) {
        try { c.setValue(text); } catch (e) { /* контрол ещё не готов */ }
    }
}

function setEnabled(form, name, on) {
    var b = ctrl(form, name);
    if (b && typeof b.setEnabled === 'function') b.setEnabled(!!on);
}

/**
 * Скачивание — обычной навигацией браузера, а не fetch: файл может весить сотни
 * мегабайт, и тянуть его в память вкладки, чтобы потом отдать как blob, незачем.
 * Права проверяет сам роут, поэтому ссылка безопасна.
 */
function downloadViaBrowser(url) {
    var a = document.createElement('a');
    a.href = url;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { try { document.body.removeChild(a); } catch (e) {} }, 0);
}

/**
 * Текущая строка списка копий.
 *
 * Читается из самого контрола (`_activeRowIndex` + `dataCache`), а не хранится
 * параллельно в переменной формы: у `relatedList` нет события выбора строки, и своя
 * копия состояния всё равно разъезжалась бы с тем, что видит пользователь.
 * Правильное место для этого — свойство «текущая строка» у таблицы в ядре (задача B13).
 */
function currentFile(form) {
    var tbl = ctrl(form, 'backupFilesTable');
    if (!tbl) return null;
    var rows = tbl.dataCache || [];
    var idx = (typeof tbl._activeRowIndex === 'number' && tbl._activeRowIndex >= 0) ? tbl._activeRowIndex : -1;
    if (idx < 0 || idx >= rows.length) return null;
    return rows[idx] || null;
}

/** Строка журнала копий выбрана — включаем зависимые кнопки. */
function onFileSelected(row, ctx) {
    var form = ctx && ctx.form;
    var data = row && (row.data || row);
    selectedFileUID = (data && data.UID) || null;
    selectedFileMissing = !!(data && data.missing);
    // Кнопка неприменимого действия остаётся видимой и выключается, а не прячется:
    // иначе командная панель прыгает и непонятно, куда делось действие.
    setEnabled(form, 'btnDownload', !!selectedFileUID && !selectedFileMissing);
    setEnabled(form, 'btnDeleteFile', !!selectedFileUID);
}

/** Журнал перечитался (SSE) — прежняя выборка могла исчезнуть. */
function onFilesRefreshed(tbl, ctx) {
    var form = (ctx && ctx.form) || (tbl && tbl.appForm);
    if (!form) return;
    var rows = (tbl && tbl.dataCache) || [];
    var stillThere = false;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i] && rows[i].UID === selectedFileUID) { stillThere = true; selectedFileMissing = !!rows[i].missing; break; }
    }
    if (!stillThere) { selectedFileUID = null; selectedFileMissing = false; }
    // Кнопки доступны, пока в списке есть хоть одна копия: конкретную строку берём
    // в момент нажатия из самой таблицы (см. currentFile).
    setEnabled(form, 'btnDownload', rows.length > 0);
    setEnabled(form, 'btnDeleteFile', rows.length > 0);
}

function downloadSelected(ev, ctx) {
    var rec = currentFile(ctx && ctx.form);
    if (!rec || !rec.UID) { showAlert(__t('backup_err_no_selection')); return; }
    if (rec.missing) { showAlert(__t('backup_err_no_selection')); return; }
    downloadViaBrowser('/api/apps/backup/download/' + encodeURIComponent(rec.UID));
}

async function deleteSelected(ev, ctx) {
    var form = ctx && ctx.form;
    var rec = currentFile(form);
    if (!rec || !rec.UID) { showAlert(__t('backup_err_no_selection')); return; }
    var ok = await showConfirm(__t('backup_delete_confirm'));
    if (!ok) return;
    var res = await callServer('__SERVER_SCRIPT__', 'deleteBackup', { uid: rec.UID });
    if (!res || res.error) { showAlert(__t('Error: ') + ((res && res.error) || '')); return; }
}

/** Общая часть запуска: несохранённые настройки сначала сохраняем. */
async function startBackup(form, scope, organizationId) {
    if (form && form.needsSave && form.needsSave()) {
        var ok = await showConfirm(__t('backup_save_before_run_msg'));
        if (!ok) return;
        await form.doAction('save');
        if (form.needsSave()) return;   // сохранение не удалось, ошибка уже показана
    }
    var res = await callServer('__SERVER_SCRIPT__', 'createNow', { scope: scope, organizationId: organizationId });
    if (!res || res.error) { showAlert(__t('Error: ') + ((res && res.error) || '')); return; }
    showAlert(res.message || __t('backup_run_started_msg'));
}

async function createFull(ev, ctx) {
    await startBackup(ctx && ctx.form, 'full', null);
}

/**
 * Выгрузка одной организации.
 *
 * Организация берётся из штатного поля-селектора на форме, а не из самодельного
 * диалога: выбор ссылочной записи — это `recordSelector`, и своя реализация выбора
 * была бы параллельной логикой мимо фреймворка.
 */
async function createForOrganization(ev, ctx) {
    var form = ctx && ctx.form;
    var c = ctrl(form, 'scopeOrganizationId');
    var orgId = c && typeof c.getValue === 'function' ? c.getValue() : null;
    if (!orgId) {
        showAlert(__t('backup_err_scope_org_required'));
        if (c && typeof c.focus === 'function') { try { c.focus(); } catch (e) {} }
        return;
    }
    var confirmed = await showConfirm(__t('backup_org_scope_confirm'));
    if (!confirmed) return;
    await startBackup(form, 'organization', orgId);
}

/**
 * Сгенерировать пару ключей. Приватный ключ отдаётся ОДИН раз — поэтому сначала
 * предупреждаем, а после генерации сразу инициируем скачивание.
 */
async function generateKeys(ev, ctx) {
    var form = ctx && ctx.form;
    var ok = await showConfirm(__t('backup_generate_keys_confirm'));
    if (!ok) return;

    var res = await callServer('__SERVER_SCRIPT__', 'generateKeys', {});
    if (!res || res.error) { showAlert(__t('Error: ') + ((res && res.error) || '')); return; }

    var pub = ctrl(form, 'publicKeyPem');
    if (pub && typeof pub.setValue === 'function') pub.setValue(res.publicKeyPem);
    var fp = ctrl(form, 'keyFingerprint');
    if (fp && typeof fp.setValue === 'function') fp.setValue(res.keyFingerprint);
    setStatusText(form, res.statusText);

    downloadViaBrowser(res.downloadUrl);
    showAlert(__t('backup_private_key_saved_msg'));
}

/** Расписание живёт в планировщике — открываем его задание, а не дублируем поля. */
async function openSchedule(ev, ctx) {
    var res = await callServer('__SERVER_SCRIPT__', 'getTaskUID', {});
    if (!res || res.error) { showAlert(__t('Error: ') + ((res && res.error) || '')); return; }
    if (window.MySpace && typeof window.MySpace.open === 'function') {
        await window.MySpace.open('uniForm', { mode: 'record', dbTable: 'scheduler_tasks', recordId: res.taskUID });
    }
}

/** Стартовая настройка формы — form-level onReady, а не onChange. */
async function onFormReady(ctx) {
    var form = ctx && ctx.form;
    if (!form) return;
    // Кнопки не гасим: события таблицы могут не прийти, а строка всё равно
    // читается в момент нажатия (currentFile). Выключенная навсегда кнопка хуже,
    // чем кнопка, честно сказавшая «сначала выберите копию».
}

return {
    onFormReady, onFileSelected, onFilesRefreshed,
    createFull, createForOrganization, downloadSelected, deleteSelected,
    generateKeys, openSchedule
};
