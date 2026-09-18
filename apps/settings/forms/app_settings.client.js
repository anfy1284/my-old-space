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

/**
 * Разложить значения, пришедшие с сервера, по контролам.
 *
 * Через `form.setControlValue`, а не напрямую в контрол: он же обновляет ДАННЫЕ формы
 * и гасит флаг изменённости. Прямая запись в контрол разводила данные и экран — и
 * первая же перерисовка возвращала на экран значения предыдущего пользователя.
 */
function applyValues(form, values) {
    for (var i = 0; i < (values || []).length; i++) {
        var v = values[i];
        form.setControlValue(v.name, v.value, v.display);
    }
}

/**
 * Перечитать значения выбранного уровня и записи.
 *
 * Ответы приходят в произвольном порядке: пока идёт запрос по одному пользователю,
 * администратор успевает переключиться на другого. Метка запроса отсекает опоздавший
 * ответ — иначе на экране оказались бы настройки того, кто уже не выбран.
 */
async function reloadValues(form) {
    var scope = currentScope(form);
    if (!scope) return;
    var recordId = currentRecordId(form);

    var token = (form.__settingsToken || 0) + 1;
    form.__settingsToken = token;

    var res = await callServer('__SERVER_SCRIPT__', 'loadForScope', {
        scope: scope,
        recordId: recordId
    });
    if (form.__settingsToken !== token) return;   // ответ опоздал, выбрано уже другое

    if (!res || res.error) {
        if (res && res.error) showAlert(__t('Error: ') + res.error);
        return;
    }
    applyValues(form, res.values);

    // Чьи значения сейчас на экране. Правки принадлежат ИМ, а не тому, что окажется
    // выбрано в шапке потом (см. flushPending).
    form.__settingsLoaded = { scope: scope, recordId: recordId || null };

    // Служебные данные — админская таблица; приходит вместе с уровнем.
    if (res.stateRows) {
        var stateTable = form.getControl('stateRows');
        if (stateTable && typeof stateTable.setRowsData === 'function') {
            try { stateTable.setRowsData(res.stateRows); } catch (e) {}
        }
    }

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
    // Что показано при открытии — тоже «загруженная запись»: без этого первая же
    // правка до переключения оказалась бы без адресата.
    form.__settingsLoaded = { scope: currentScope(form), recordId: currentRecordId(form) };
    try {
        var state = await callServer('__SERVER_SCRIPT__', 'formState', {});
        form.__settingsMe = state && state.me;
        form.__settingsAdmin = !!(state && state.isAdmin);
    } catch (e) { /* без этого гаснет только кнопка пароля */ }
    applyPasswordButton(form);
}

/**
 * Закрыть правки ПРЕЖНЕЙ записи перед переключением.
 *
 * Форма показывает настройки одного уровня и одной записи. Уйти с неё с
 * несохранёнными правками нельзя: «потом сохраню» здесь превращается в «записал
 * чужому пользователю» — в шапке к этому моменту уже выбран другой. Поэтому вопрос
 * задаётся сразу и ровно один: сохранить или отказаться от правок.
 *
 * Решение владельца 13.09.2026 — так вместо того, чтобы держать в памяти правки по
 * всем записям сразу.
 */
async function flushPending(form) {
    if (!form || typeof form.isModified !== 'function' || !form.isModified()) return;
    var target = form.__settingsLoaded;
    if (!target || !target.scope) { form.setModified(false); return; }

    var save = await showConfirm(__t('settings_switch_save_confirm'));
    if (!save) { form.setModified(false); return; }   // правки уйдут при перечитывании
    await saveTo(form, target);
}

/** Смена уровня. */
async function onScopeChanged(val, display, ctx) {
    var form = ctx.form;
    await flushPending(form);
    applyScopeVisibility(form);
    await reloadValues(form);
}

/** Смена записи-владельца (пользователь, организация, гостиница). */
async function onRecordChanged(val, display, ctx) {
    await flushPending(ctx.form);
    await reloadValues(ctx.form);
}

/**
 * Записать то, что на форме, В УКАЗАННУЮ запись.
 *
 * Адресат передаётся явно, а не берётся из шапки: при переключении пользователя
 * шапка уже показывает СЛЕДУЮЩЕГО, а сохранить надо правки предыдущего.
 *
 * @param {Object} form
 * @param {{scope: string, recordId: string}} target
 * @returns {Promise<Object|null>} ответ сервера (или null при ошибке)
 */
async function saveTo(form, target) {
    var data = form.collectData();
    data[SCOPE_FIELD] = target.scope;
    if (target.recordId) data[REC_PREFIX + target.scope] = target.recordId;

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
        return null;
    }
    form.setModified(false);
    return result || {};
}

/** Сохранение настроек выбранного уровня. */
async function applySettings(ev, ctx) {
    var form = ctx.form;
    var target = form.__settingsLoaded
        || { scope: currentScope(form), recordId: currentRecordId(form) };

    var result = await saveTo(form, target);
    if (!result) return;

    // Свой язык интерфейса сменился — бандлы переводятся на сервере под язык сессии,
    // поэтому новый язык виден только после перезагрузки страницы.
    if (result && result.languageChanged) {
        window.location.reload();
        return;
    }

    await refreshPersonalSnapshots();
    showAlert(__t('Settings saved'));
}

/**
 * Перечитать то личное, что клиент держит снимком: список выключенных приложений
 * и значения настроек уровня `user`.
 *
 * Оба снимка приезжают ОДИН раз при загрузке страницы (в бандл личное класть
 * нельзя — он кэшируется по ключу «роль|язык»), и сразу после записи настроек они
 * устарели. Без этого выключатель приложения срабатывал бы только после
 * перезагрузки страницы — а настройка, которая «не сработала», читается как
 * поломка. Перезагружать всю страницу ради этого не нужно: язык — особый случай,
 * там переводятся сами бандлы.
 */
async function refreshPersonalSnapshots() {
    if (!window.MySpace) return;
    try {
        if (MySpace.appAvailability) await MySpace.appAvailability.load();
        if (MySpace.settings) await MySpace.settings.load();
        window.dispatchEvent(new CustomEvent('app-settings-changed'));
    } catch (e) {
        console.warn('[settings] снимки не перечитаны:', e && e.message);
    }
}

/** Стереть всё запомненное состояние интерфейса (кнопка администратора). */
async function clearState(ev, ctx) {
    var form = ctx.form;
    showConfirm(__t('settings_state_clear_confirm'), async function () {
        var res = await callServer('__SERVER_SCRIPT__', 'clearState', {});
        if (!res || res.error) {
            showAlert(__t('Error: ') + ((res && res.error) || ''));
            return;
        }
        var table = form.getControl('stateRows');
        if (table && typeof table.setRowsData === 'function') {
            try { table.setRowsData(res.stateRows || []); } catch (e) {}
        }
        showAlert(__t('settings_state_cleared') + ' ' + (res.removed || 0));
    });
}

/** Форма смены пароля из приложения login. */
function openChangePassword(ev, ctx) {
    if (window.MySpace && typeof window.MySpace.open === 'function') {
        window.MySpace.open('login', { mode: 'changePassword' });
    } else {
        console.error('[settings] MySpace.open is not available');
    }
}

return { onFormReady, onScopeChanged, onRecordChanged, applySettings, openChangePassword, clearState };
