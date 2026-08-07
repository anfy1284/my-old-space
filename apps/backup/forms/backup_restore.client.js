// Клиентские функции формы «Восстановление организации».
//
// Файл грузится как исходный текст через loadScript() в init.js; плейсхолдер
// __SERVER_SCRIPT__ заменяется там на реальное имя серверного скрипта.
// Файл обязан заканчиваться `return { ... }` — этого требует loadScript().
//
// Здесь только специфика: собрать поля, показать отчёт, спросить подтверждение.
// Доступ к контролам и доступность кнопок — методы ядра (form.getControl* /
// form.setControlEnabled).

// Приватный ключ читается из ФАЙЛА и держится в замыкании, а не в поле формы:
// значение поля попадает в набор данных формы и остаётся в разметке страницы.
var _privateKeyPem = '';

/** Выбрать файл приватного ключа (.pem). Файл читается в браузере, на сервер как файл не уходит. */
async function pickKeyFile(ev, ctx) {
    var form = ctx && ctx.form;
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pem,.key,application/x-pem-file';
    input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
            _privateKeyPem = String(reader.result || '');
            form.setControlValue('keyState', file.name);
        };
        reader.onerror = function () { showAlert(__t('Error: ') + String(reader.error)); };
        reader.readAsText(file);
    });
    input.click();
}

/**
 * Загрузить копию с диска.
 *
 * Основной сценарий восстановления ОДНОЙ организации: ежедневные копии уезжают в
 * домашний архив и хранятся там расшифрованными, а когда организация «накосячила
 * позавчера», нужный файл лежит дома, а не на сервере.
 */
async function pickFile(ev, ctx) {
    var form = ctx && ctx.form;
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.mosbak';
    input.addEventListener('change', async function () {
        var file = input.files && input.files[0];
        if (!file) return;
        try {
            var resp = await fetch('/api/apps/backup/upload', { method: 'POST', body: file });
            var j = await resp.json();
            if (!j || !j.ok) { showAlert(__t('Error: ') + ((j && (j.errorKey || j.message)) || resp.status)); return; }
            form.setControlValue('uploadName', j.uploadName);
            // Источники взаимоисключающие: оставить оба значит не понимать, что развернётся.
            form.setControlValue('fileUID', '', '');
        } catch (e) { showAlert(__t('Error: ') + e.message); }
    });
    input.click();
}

function collect(form) {
    return {
        fileUID: form.getControlValue('fileUID') || '',
        uploadName: form.getControlValue('uploadName') || '',
        organizationId: form.getControlValue('organizationId'),
        privateKeyPem: _privateKeyPem,
        confirmName: form.getControlValue('confirmName')
    };
}

/** Анализ: что произойдёт. Ничего не меняет — кнопка «Восстановить» до него выключена. */
async function analyzeDump(ev, ctx) {
    var form = ctx && ctx.form;
    form.setControlEnabled('btnRestore', false);

    var res = await callServer('__SERVER_SCRIPT__', 'analyzeDump', collect(form));
    if (!res || res.error) {
        form.setControlValue('reportText', (res && res.error) || '');
        showAlert(__t('Error: ') + ((res && res.error) || ''));
        return;
    }
    form.setControlValue('reportText', res.reportText || '');
    form.setControlEnabled('btnRestore', !!res.ok);
    if (res.ok && res.confirmHint) showAlert(res.confirmHint);
}

/**
 * Восстановление. Подтверждение — вводом наименования организации руками; проверяет
 * его СЕРВЕР, здесь только последнее предупреждение о необратимости замещения.
 */
async function runRestore(ev, ctx) {
    var form = ctx && ctx.form;
    var ok = await showConfirm(__t('restore_final_confirm'));
    if (!ok) return;

    form.setControlEnabled('btnRestore', false);
    form.setControlEnabled('btnAnalyze', false);
    try {
        var res = await callServer('__SERVER_SCRIPT__', 'runRestore', collect(form));
        if (!res || res.error) {
            if (res && res.reportText) form.setControlValue('reportText', res.reportText);
            showAlert(__t('Error: ') + ((res && res.error) || ''));
            return;
        }
        form.setControlValue('reportText', res.message || '');
        showAlert(res.message || '');
    } finally {
        form.setControlEnabled('btnAnalyze', true);
    }
}

return { analyzeDump, runRestore, pickKeyFile, pickFile };
