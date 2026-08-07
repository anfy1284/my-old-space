// Клиентские функции формы «Резервное копирование».
//
// Файл грузится как исходный текст через loadScript() в init.js; плейсхолдер
// __SERVER_SCRIPT__ заменяется там на реальное имя серверного скрипта.
// Сигнатура обработчиков: function(eventArgs..., ctx), ctx = { form, fnParams }.
// Файл обязан заканчиваться `return { ... }` — этого требует loadScript().
//
// Здесь только СПЕЦИФИКА этой формы: создать копию, сгенерировать ключи, скачать
// выбранное, удалить, открыть расписание. Обвязка (доступ к контролам, текущая
// строка таблицы, доступность кнопок по выбору, скачивание файла) — в ядре:
// form.getControl / table.currentRow / "enabledWhen" в лейауте / MySpace.downloadFile.

/** Копия, выбранная в журнале. Текущую строку ведёт сама таблица. */
function selectedFile(form) {
    var tbl = form && form.getControl('backupFilesTable');
    return tbl ? tbl.currentRow : null;
}

/** Общая часть запуска: несохранённые настройки сначала сохраняем. */
async function startBackup(form, scope, organizationId) {
    if (form && form.needsSave && form.needsSave()) {
        var ok = await showConfirm(__t('backup_save_before_run_msg'));
        if (!ok) return;
        await form.doAction('save');
        if (form.needsSave()) return;   // сохранение не удалось, ошибка уже показана
    }

    // Лимит копий уже занят — новая вытеснит старую. Пользователь должен узнать об
    // этом ДО запуска и по имени файла, а не обнаружить пропажу потом.
    var prev = await callServer('__SERVER_SCRIPT__', 'previewRetention', {});
    if (prev && prev.willDelete && prev.willDelete.length) {
        var names = prev.willDelete.map(function (f) { return '• ' + f.fileName; }).join('\n');
        var agreed = await showConfirm(__t('backup_retention_warn_msg') + '\n\n' + names);
        if (!agreed) return;
    }

    var res = await callServer('__SERVER_SCRIPT__', 'createNow', { scope: scope, organizationId: organizationId });
    if (!res || res.error) { showAlert(__t('Error: ') + ((res && res.error) || '')); return; }
    // Сообщения «запущено» больше нет: ход операции виден в самой форме (runLog),
    // и модальное окно поверх него только мешает смотреть.
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
    var orgId = form && form.getControlValue('scopeOrganizationId');
    if (!orgId) {
        showAlert(__t('backup_err_scope_org_required'));
        var c = form && form.getControl('scopeOrganizationId');
        if (c && typeof c.focus === 'function') { try { c.focus(); } catch (e) {} }
        return;
    }
    var confirmed = await showConfirm(__t('backup_org_scope_confirm'));
    if (!confirmed) return;
    await startBackup(form, 'organization', orgId);
}

function downloadSelected(ev, ctx) {
    var rec = selectedFile(ctx && ctx.form);
    if (!rec || !rec.UID) { showAlert(__t('backup_err_no_selection')); return; }
    MySpace.downloadFile('/api/apps/backup/download/' + encodeURIComponent(rec.UID));
}

async function deleteSelected(ev, ctx) {
    var rec = selectedFile(ctx && ctx.form);
    if (!rec || !rec.UID) { showAlert(__t('backup_err_no_selection')); return; }
    var ok = await showConfirm(__t('backup_delete_confirm'));
    if (!ok) return;
    var res = await callServer('__SERVER_SCRIPT__', 'deleteBackup', { uid: rec.UID });
    if (!res || res.error) { showAlert(__t('Error: ') + ((res && res.error) || '')); return; }
}

/**
 * Восстановить организацию из выбранной копии.
 *
 * Форму подтверждения открывает ядро (uniForm), данные для неё готовит сервер: здесь
 * только повод. Приватный ключ вводит администратор — на сервере его нет и быть не должно.
 */
async function restoreOrganization(ev, ctx) {
    var rec = selectedFile(ctx && ctx.form);
    if (!rec || !rec.UID) { showAlert(__t('backup_err_no_selection')); return; }
    await MySpace.open('uniForm', { mode: 'record', dbTable: 'backup_restore_full', fileUID: rec.UID });
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

    form.setControlValue('publicKeyPem', res.publicKeyPem);
    form.setControlValue('keyFingerprint', res.keyFingerprint);
    form.setControlValue('statusText', res.statusText);

    MySpace.downloadFile(res.downloadUrl, 'backup-private-key.pem');
    showAlert(__t('backup_private_key_saved_msg'));
}

/** Расписание живёт в планировщике — открываем его задание, а не дублируем поля. */
async function openSchedule(ev, ctx) {
    var res = await callServer('__SERVER_SCRIPT__', 'getTaskUID', {});
    if (!res || res.error) { showAlert(__t('Error: ') + ((res && res.error) || '')); return; }
    await MySpace.open('uniForm', { mode: 'record', dbTable: 'scheduler_tasks', recordId: res.taskUID });
}

/**
 * Задать аварийный пароль восстановления (ТЗ §6.2а, путь 1).
 * Введённое значение сразу стирается из поля: показывать его дальше незачем, а хранить
 * в разметке формы — тем более.
 */
async function setRecoveryPassword(ev, ctx) {
    var form = ctx && ctx.form;
    var res = await callServer('__SERVER_SCRIPT__', 'setRecoveryPassword', {
        recoveryPassword: form.getControlValue('recoveryPassword')
    });
    form.setControlValue('recoveryPassword', '');
    if (!res || res.error) { showAlert(__t('Error: ') + ((res && res.error) || '')); return; }
    form.setControlValue('recoveryState', res.state || '');
    showAlert(res.message || '');
}

/**
 * Незашифрованная копия — сразу в скачивание, на сервере не сохраняется.
 *
 * Предупреждение обязательно и стоит ПЕРЕД действием: файл уедет с сервера открытым
 * и будет лежать в архиве годами. Пользователь должен согласиться осознанно, а не
 * обнаружить это через год.
 */
async function createPlain(ev, ctx) {
    var ok = await showConfirm(__t('backup_create_plain_confirm'));
    if (!ok) return;
    MySpace.downloadFile('/api/apps/backup/download-plain?scope=full', 'backup-plain.mosbak');
}

return {
    createFull, createPlain, createForOrganization, downloadSelected, deleteSelected,
    restoreOrganization, generateKeys, openSchedule, setRecoveryPassword
};
