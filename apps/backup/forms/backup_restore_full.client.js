// Клиентские функции формы «Полное восстановление базы».
//
// Файл грузится как исходный текст через loadScript() в init.js; плейсхолдер
// __SERVER_SCRIPT__ заменяется там на реальное имя серверного скрипта.
// Файл обязан заканчиваться `return { ... }` — этого требует loadScript().
//
// Здесь только специфика экрана §6.2б: пока администратор не убедился, что помнит
// аварийный пароль (или не получил новый), кнопка запуска остаётся выключенной.
// Шаг нельзя пропустить: после переключения обычный вход невозможен — вместе со
// старой схемой уходит таблица сессий, включая сессию самого администратора.

// Состояние экрана. Живёт в замыкании скрипта формы: это не данные записи, а
// выполненность предусловий, и в базу ему не место.
var _passwordReady = false;
var _inspected = false;

// Приватный ключ держится ЗДЕСЬ, а не в поле формы. Причина не в удобстве: значение
// поля попадает в набор данных формы, ездит в отладочных дампах и остаётся в разметке
// страницы. Ключ не должен оседать нигде — ни на сервере (там его нет по построению),
// ни в DOM. Он читается из файла, живёт в переменной и уходит одним вызовом.
var _privateKeyPem = '';
var _keyFileName = '';
// Аварийный пароль — там же, где приватный ключ, и по той же причине: в набор
// данных формы и в DOM он не попадает. Уходит на сервер при ЗАПУСКЕ, потому что
// проверять его обязан сам запуск: раньше сервер верил флагу `passwordReady`,
// который приходил с клиента, — то есть гейт стоял только в интерфейсе.
var _recoveryPassword = '';
// Копия из домашнего архива приходит расшифрованной — ключ для неё не нужен вовсе.
var _needsKey = true;

function collect(form) {
    return {
        fileName: form.getControlValue('fileName'),
        uploadName: form.getControlValue('uploadName'),
        privateKeyPem: _privateKeyPem,
        passwordReady: _passwordReady,
        restoreScope: form.getControlValue('restoreScope') || 'full',
        organizationId: form.getControlValue('organizationId') || '',
        // Отметки «взять из копии» по типам системных данных. Отдаются строками
        // таблицы целиком: сервер сам решает, какие коды считать применимыми, — с
        // клиента приходит выбор, а не список того, что существует.
        systemData: systemDataRows(form)
    };
}

/**
 * Выбрана копия, лежащая на сервере.
 *
 * Источники взаимоисключающие: загруженный файл и копия с сервера — это два разных
 * файла, и держать выбранными оба значит не понимать, что именно развернётся. Поэтому
 * выбор строки гасит загруженный файл, а загрузка гасит выбор строки (см. pickFile).
 */
function serverFilePicked(rowIndex, ctx) {
    var form = (ctx && ctx.form) || this;
    var tbl = form && form.getControl('serverFilesTable');
    var row = tbl && tbl.currentRow;
    if (!row || !row.fileName) return;

    form.setControlValue('fileName', row.fileName, row.fileName);
    form.setControlValue('uploadName', '', '');
    _inspected = false;
    refreshRunButton(form);
}

/** Снять выбор источника: анализ и готовность к запуску теряют силу вместе с ним. */
function clearSource(ev, ctx) {
    var form = ctx && ctx.form;
    form.setControlValue('fileName', '', '');
    form.setControlValue('uploadName', '', '');
    _inspected = false;
    refreshRunButton(form);
}

/** Строки таблицы системных данных. Пустой список = ничего не отмечено. */
function systemDataRows(form) {
    var tbl = form && form.getControl('systemDataTable');
    if (!tbl || typeof tbl.getRows !== 'function') return [];
    return (tbl.getRows() || []).map(function (r) {
        return { code: r.code, fromCopy: r.fromCopy === true || r.fromCopy === 'true' };
    });
}

/**
 * Кнопка запуска включается ТОЛЬКО когда выполнены все предусловия — и форма ГОВОРИТ,
 * каких именно не хватает.
 *
 * Выключенная кнопка без объяснения — это тупик: владелец не смог запустить
 * восстановление и не понял почему. Кнопку прятать нельзя (панель прыгает), но и
 * молчать нельзя тоже: рядом стоит строка «Готовность», где перечислено оставшееся.
 */
function refreshRunButton(form) {
    var isOrg = (form.getControlValue('restoreScope') || 'full') === 'organization';
    var missing = [];

    if (!form.getControlValue('fileName') && !form.getControlValue('uploadName')) {
        missing.push(__t('restore_full_need_source'));
    }
    if (isOrg && !form.getControlValue('organizationId')) missing.push(__t('restore_full_need_org'));
    if (_needsKey && !_privateKeyPem) missing.push(__t('restore_full_need_key'));
    if (!_inspected) missing.push(__t('restore_full_need_inspect'));
    // Аварийный пароль нужен ТОЛЬКО полному восстановлению: организация замещается в
    // живой базе, сервер не уходит в обслуживание, входить заново не придётся.
    if (!isOrg && !_passwordReady) missing.push(__t('restore_full_need_password'));

    form.setControlEnabled('btnRestore', missing.length === 0);
    form.setControlValue('runState', missing.length
        ? __t('restore_full_not_ready') + ' ' + missing.join('; ')
        : __t('restore_full_ready'));
}

/**
 * Смена области: организации не нужен аварийный пароль, полному восстановлению не
 * нужна организация. Лишние поля прячем — форма не должна спрашивать того, что к
 * выбранному сценарию не относится.
 */
function scopeChanged(value, caption, ctx) {
    var form = (ctx && ctx.form) || this;
    applyScope(form);
}

function applyScope(form) {
    var isOrg = (form.getControlValue('restoreScope') || 'full') === 'organization';
    var org = form.getControl('organizationId');
    var pwd = form.getControl('passwordState');
    if (org && typeof org.setHidden === 'function') org.setHidden(!isOrg);
    form.setControlEnabled('btnVerifyPwd', !isOrg);
    form.setControlEnabled('btnGeneratePwd', !isOrg);
    // Анализ перестаёт быть действительным: у другой области другой отчёт.
    _inspected = false;
    refreshRunButton(form);
}

/**
 * Выбрать ФАЙЛ приватного ключа.
 *
 * Ключ хранится файлом `.pem` — значит и спрашивать его надо файлом, а не «вставьте
 * текст». Вставка текста порождала самую частую ошибку: в поле попадал ПУБЛИЧНЫЙ ключ
 * из формы настроек копирования, потому что он на виду и тоже называется «ключ».
 *
 * Файл читается В БРАУЗЕРЕ и на сервер как файл НЕ загружается: приватного ключа на
 * сервере нет по построению, и заводить для него временный файл на диске значило бы
 * сломать это свойство ради удобства.
 */
async function pickKeyFile(ev, ctx) {
    var form = ctx && ctx.form;
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pem,.key,application/x-pem-file';
    input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = async function () {
            _privateKeyPem = String(reader.result || '');
            _keyFileName = file.name;
            form.setControlValue('keyState', _keyFileName);
            refreshRunButton(form);

            // Проверяем СРАЗУ: тип ключа и его принадлежность выбранной копии. Узнать
            // «это не тот ключ» в момент выбора файла, а не после запуска процедуры, —
            // разница между секундой и снятой впустую резервной копией.
            var res = await callServer('__SERVER_SCRIPT__', 'checkPrivateKey', collect(form));
            if (!res || res.error) {
                _privateKeyPem = '';
                form.setControlValue('keyState', '');
                refreshRunButton(form);
                showAlert(__t('Error: ') + ((res && res.error) || ''));
                return;
            }
            form.setControlValue('keyState', _keyFileName + ' — ' + (res.message || ''));
        };
        reader.onerror = function () { showAlert(__t('Error: ') + String(reader.error)); };
        reader.readAsText(file);
    });
    input.click();
}

/** Выбрать копию с диска: нужного архива на сервере обычно уже нет. */
async function pickFile(ev, ctx) {
    var form = ctx && ctx.form;
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.mosbak';
    input.addEventListener('change', async function () {
        var file = input.files && input.files[0];
        if (!file) return;
        form.setControlValue('reportText', __t('restore_full_uploading'));
        try {
            var resp = await fetch('/api/apps/backup/upload', { method: 'POST', body: file });
            var j = await resp.json();
            if (!j || !j.ok) {
                showAlert(__t('Error: ') + ((j && (j.errorKey || j.message)) || resp.status));
                return;
            }
            form.setControlValue('uploadName', j.uploadName);
            // Загруженный файл и копия с сервера — взаимоисключающие источники;
            // оставить оба значит не понимать, что именно развернётся.
            form.setControlValue('fileName', '', '');
            _inspected = false;
            refreshRunButton(form);
            await inspectFile(null, ctx);
        } catch (e) {
            showAlert(__t('Error: ') + e.message);
        }
    });
    input.click();
}

/**
 * Прочитать заголовок копии — без приватного ключа.
 * Всё, что надо знать до точки невозврата: версия структуры, область, режим.
 */
async function inspectFile(ev, ctx) {
    var form = ctx && ctx.form;
    _inspected = false;
    refreshRunButton(form);

    var res = await callServer('__SERVER_SCRIPT__', 'inspectFile', collect(form));
    if (!res || res.error) {
        form.setControlValue('reportText', (res && res.error) || '');
        showAlert(__t('Error: ') + ((res && res.error) || ''));
        return;
    }
    form.setControlValue('reportText', res.reportText || '');
    _inspected = !!res.ok;
    _needsKey = res.encrypted !== false;
    form.setControlEnabled('btnPickKey', _needsKey);
    refreshRunButton(form);
}

/** Проверка пароля: администратор убеждается, что не заблокирует себя. */
async function verifyRecoveryPassword(ev, ctx) {
    var form = ctx && ctx.form;
    var params = collect(form);
    params.recoveryPassword = form.getControlValue('recoveryPassword');
    var res = await callServer('__SERVER_SCRIPT__', 'verifyRecoveryPassword', params);
    if (!res || !res.ok) {
        _passwordReady = false;
        _recoveryPassword = '';
        refreshRunButton(form);
        showAlert(__t('Error: ') + ((res && res.error) || ''));
        return;
    }
    _passwordReady = true;
    _recoveryPassword = params.recoveryPassword;
    form.setControlValue('recoveryPassword', '');
    form.setControlValue('passwordState', res.message || '');
    refreshRunButton(form);
    showAlert(res.message || '');
}

/**
 * Новый пароль с однократным показом.
 *
 * Хэш необратим: повторно узнать пароль невозможно. Поэтому показываем его один раз и
 * требуем явной отметки «записал» — без неё предусловие не считается выполненным.
 */
async function generateRecoveryPassword(ev, ctx) {
    var form = ctx && ctx.form;
    var res = await callServer('__SERVER_SCRIPT__', 'generateRecoveryPassword', collect(form));
    if (!res || !res.ok) {
        showAlert(__t('Error: ') + ((res && res.error) || ''));
        return;
    }
    form.setControlValue('recoveryPassword', res.password);
    form.setControlValue('passwordState', res.message || '');

    var saved = await showConfirm(__t('restore_full_pwd_saved_confirm') + '\n\n' + res.password);
    _passwordReady = !!saved;
    _recoveryPassword = saved ? res.password : '';
    refreshRunButton(form);
    if (!saved) showAlert(__t('restore_full_pwd_not_saved'));
}

/**
 * Запуск.
 *
 * Ввод имени базы руками убран по решению владельца; последнее предупреждение перед
 * необратимой операцией остаётся — дальше сервер уходит в обслуживание и перестаёт
 * отвечать, а ход операции виден на странице обслуживания.
 */
async function runFullRestore(ev, ctx) {
    var form = ctx && ctx.form;

    // Отдельное предупреждение о пользователях, ДО общего подтверждения.
    //
    // «Взять из копии» для пользователей — единственная отметка на этой форме, которая
    // способна отнять доступ у того, кто её ставит: в базе окажется список учётных
    // записей на дату копии, и если администратор заведён позже, его там нет. Прятать
    // это в общий текст «операция необратима» нельзя — он про данные, а тут про вход,
    // и заметить разницу постфактум будет уже неоткуда.
    var picked = systemDataRows(form).filter(function (r) { return r.fromCopy; });
    if (picked.length) {
        var usersPicked = picked.some(function (r) { return r.code === 'users_and_roles'; });
        var warn = usersPicked
            ? __t('restore_full_sysdata_users_confirm')
            : __t('restore_full_sysdata_confirm');
        var agreed = await showConfirm(warn);
        if (!agreed) return;
    }

    var ok = await showConfirm(__t('restore_full_final_confirm'));
    if (!ok) return;

    form.setControlEnabled('btnRestore', false);
    form.setControlEnabled('btnInspect', false);
    form.setControlEnabled('btnPickFile', false);

    var res;
    try {
        var runParams = collect(form);
        runParams.recoveryPassword = _recoveryPassword;
        res = await callServer('__SERVER_SCRIPT__', 'runFullRestore', runParams);
        _recoveryPassword = '';
    } catch (e) {
        // Обрыв связи здесь — норма, а не сбой: сервер уходит в режим обслуживания и
        // перестаёт отвечать. Состояние операции видно на странице обслуживания.
        window.location.href = '/maintenance';
        return;
    }

    if (!res || res.error) {
        form.setControlValue('reportText', (res && res.error) || '');
        showAlert(__t('Error: ') + ((res && res.error) || ''));
        if (res && res.maintenance) { window.location.href = '/maintenance'; return; }
        form.setControlEnabled('btnInspect', true);
        form.setControlEnabled('btnPickFile', true);
        refreshRunButton(form);
        return;
    }

    await showAlert(res.message || '');
    // Организацию восстановили в живой базе — сервер работает, сессия цела, уходить
    // со страницы незачем. После ПОЛНОГО восстановления сессии ушли вместе со старой
    // схемой, и работать в открытой странице не с чем.
    if (res.scope === 'organization') {
        form.setControlEnabled('btnInspect', true);
        form.setControlEnabled('btnPickFile', true);
        _inspected = false;
        refreshRunButton(form);
        return;
    }
    window.location.href = '/';
}

/** Стартовое состояние формы: видимость полей по выбранной области. */
function onReady(ctx) {
    var form = (ctx && ctx.form) || this;
    applyScope(form);
}

return {
    onReady, scopeChanged, pickFile, pickKeyFile, inspectFile,
    serverFilePicked, clearSource,
    verifyRecoveryPassword, generateRecoveryPassword, runFullRestore
};
