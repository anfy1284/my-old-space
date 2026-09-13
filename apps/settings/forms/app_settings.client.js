// Клиентские функции формы «Настройки».
//
// Загружается как исходный текст через loadScript() в init.js; плейсхолдер
// __SERVER_SCRIPT__ заменяется на имя серверного скрипта при загрузке.
//
// Форма содержит вкладки ВСЕХ уровней сразу — видимой остаётся группа выбранного
// уровня (`visibleWhen` вкладки). Отсюда две обязанности клиента при смене уровня:
// показать нужный селектор записи и попросить ядро пересчитать видимость вкладок.

var SCOPE_FIELD = '__scope';
var REC_PREFIX  = '__rec_';

/** Имена всех селекторов записи в форме (по одному на уровень). */
function recordFields(form) {
    var names = [];
    for (var key in (form.controlsMap || {})) {
        if (key.indexOf(REC_PREFIX) === 0) names.push(key);
    }
    return names;
}

function currentScope(form) {
    return form.getControlValue(SCOPE_FIELD) || '';
}

function currentRecordId(form) {
    var scope = currentScope(form);
    if (!scope) return null;
    return form.getControlValue(REC_PREFIX + scope) || null;
}

/** Показать селектор записи выбранного уровня, остальные спрятать. */
function applyScopeVisibility(form) {
    var scope = currentScope(form);
    var names = recordFields(form);
    for (var i = 0; i < names.length; i++) {
        var ctrl = form.getControl(names[i]);
        if (!ctrl) continue;
        var show = (names[i] === REC_PREFIX + scope);
        try {
            if (show && typeof ctrl.setVisible === 'function') ctrl.setVisible(true);
            else if (!show && typeof ctrl.setHidden === 'function') ctrl.setHidden(true);
        } catch (e) { /* контрол без поддержки скрытия — оставляем как есть */ }
    }
    // Вкладки уровня показывает ядро по `visibleWhen`; после программной смены
    // значения пересчёт нужно попросить явно.
    try { form.refreshEnabledWhen(); } catch (e) {}
}

/**
 * «Сменить пароль» — только себе: смена своего пароля требует старого, а сброса пароля
 * администратором у нас нет. На чужом пользователе кнопка гаснет, но остаётся видимой —
 * иначе непонятно, что она вообще есть.
 */
function applyPasswordButton(form) {
    var me = form.__settingsMe;
    if (!me) return;
    var scope = currentScope(form);
    var target = form.getControlValue(REC_PREFIX + 'user');
    var own = (scope !== 'user') ? true : (String(target || '') === String(me));
    try { form.setControlEnabled('btnChangePassword', own); } catch (e) {}
}

/** Разложить значения, пришедшие с сервера, по контролам. */
function applyValues(form, values) {
    for (var i = 0; i < (values || []).length; i++) {
        var v = values[i];
        var ctrl = form.controlsMap && form.controlsMap[v.name];
        if (ctrl && typeof ctrl.setValue === 'function') ctrl.setValue(v.value, v.display);
    }
}

/** Перечитать значения выбранного уровня и записи. */
async function reloadValues(form) {
    var scope = currentScope(form);
    if (!scope) return;
    var res = await callServer('__SERVER_SCRIPT__', 'loadForScope', {
        scope: scope,
        recordId: currentRecordId(form)
    });
    if (!res || res.error) {
        if (res && res.error) showAlert(__t('Error: ') + res.error);
        return;
    }
    applyValues(form, res.values);

    // Автозаполнение принадлежит пользователю — при смене пользователя таблица
    // обязана показать ЕГО строки, иначе администратор сохранит чужие.
    if (res.autofill) {
        var table = form.getControl('autofill');
        if (table && typeof table.setRowsData === 'function') {
            try { table.setRowsData(res.autofill); } catch (e) {}
        }
    }

    applyPasswordButton(form);
    // Переключение области действия — не правка данных.
    try { form.setModified(false); } catch (e) {}
}

/** Форма отрисована: спрятать лишние селекторы и узнать, кто мы. */
async function onFormReady(ctx) {
    var form = ctx && ctx.form;
    if (!form) return;
    applyScopeVisibility(form);
    try {
        var state = await callServer('__SERVER_SCRIPT__', 'formState', {});
        form.__settingsMe = state && state.me;
        form.__settingsAdmin = !!(state && state.isAdmin);
    } catch (e) { /* без этого гаснет только кнопка пароля */ }
    applyPasswordButton(form);
}

/** Смена уровня. */
async function onScopeChanged(val, display, ctx) {
    var form = ctx.form;
    applyScopeVisibility(form);
    await reloadValues(form);
}

/** Смена записи-владельца (пользователь, организация, гостиница). */
async function onRecordChanged(val, display, ctx) {
    await reloadValues(ctx.form);
}

/** Сохранение настроек выбранного уровня. */
async function applySettings(ev, ctx) {
    var form = ctx.form;
    var data = form.collectData();

    // Табличные части (автозаполнение) в collectData не попадают.
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
    } catch (e) {}

    var result = await callServer('__SERVER_SCRIPT__', 'onSave', { changes: data, tableName: 'app_settings' });
    if (result && result.error) {
        showAlert(__t('Error: ') + result.error);
        return;
    }
    form.setModified(false);

    // Свой язык интерфейса сменился — бандлы переводятся на сервере под язык сессии,
    // поэтому новый язык виден только после перезагрузки страницы.
    if (result && result.languageChanged) {
        window.location.reload();
        return;
    }
    showAlert(__t('Settings saved'));
}

/** Форма смены пароля из приложения login. */
function openChangePassword(ev, ctx) {
    if (window.MySpace && typeof window.MySpace.open === 'function') {
        window.MySpace.open('login', { mode: 'changePassword' });
    } else {
        console.error('[settings] MySpace.open is not available');
    }
}

return { onFormReady, onScopeChanged, onRecordChanged, applySettings, openChangePassword };
