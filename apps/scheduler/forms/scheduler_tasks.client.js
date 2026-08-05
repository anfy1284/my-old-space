// Клиентские функции формы «Регламентное задание».
//
// Файл загружается как исходный текст через loadScript() в init.js; плейсхолдер
// __SERVER_SCRIPT__ заменяется там на реальное имя серверного скрипта.
//
// Сигнатура обработчиков: function(eventArgs..., ctx), ctx = { form, fnParams }.
// Файл обязан заканчиваться `return { ... }` — этого требует loadScript().

// Поля, показываемые в каждом режиме расписания. Остальные прячутся: пустая форма
// с семью полями «на все случаи» читается как список настроек, а не как расписание.
var SCHEDULE_FIELDS = {
    interval: ['intervalMinutes'],
    daily:    ['timeOfDay'],
    weekly:   ['timeOfDay', 'weekDays'],
    monthly:  ['timeOfDay', 'monthDay'],
    cron:     ['cronExpression']
};
var ALL_SCHEDULE_FIELDS = ['intervalMinutes', 'timeOfDay', 'weekDays', 'monthDay', 'cronExpression'];

function ctrl(form, name) {
    return (form && form.controlsMap && form.controlsMap[name]) || null;
}

function fieldValue(form, name) {
    var c = ctrl(form, name);
    if (c && typeof c.getValue === 'function') {
        try { return c.getValue(); } catch (e) { /* контрол ещё не готов */ }
    }
    var rec = form && form._dataMap && form._dataMap[name];
    return rec ? rec.value : null;
}

/** Собрать «задачу» из полей формы — ровно то, что нужно расшифровке расписания. */
function collectSchedule(form) {
    return {
        scheduleMode:    fieldValue(form, 'scheduleMode') || 'daily',
        intervalMinutes: fieldValue(form, 'intervalMinutes'),
        timeOfDay:       fieldValue(form, 'timeOfDay'),
        weekDays:        fieldValue(form, 'weekDays'),
        monthDay:        fieldValue(form, 'monthDay'),
        cronExpression:  fieldValue(form, 'cronExpression'),
        timezone:        fieldValue(form, 'timezone') || 'Europe/Berlin'
    };
}

function applyModeVisibility(form) {
    var mode = fieldValue(form, 'scheduleMode') || 'daily';
    var visible = SCHEDULE_FIELDS[mode] || [];
    for (var i = 0; i < ALL_SCHEDULE_FIELDS.length; i++) {
        var name = ALL_SCHEDULE_FIELDS[i];
        var c = ctrl(form, name);
        if (!c) continue;
        var show = visible.indexOf(name) >= 0;
        try {
            if (show && typeof c.setVisible === 'function') c.setVisible(true);
            else if (!show && typeof c.setHidden === 'function') c.setHidden(true);
        } catch (e) { /* контрол без поддержки скрытия — оставляем как есть */ }
    }
}

/** Обновить строку расшифровки («каждый день в 03:00, Europe/Berlin»). */
async function refreshDescription(form) {
    var box = ctrl(form, 'scheduleDescription');
    if (!box || typeof box.setValue !== 'function') return;
    try {
        var res = await callServer('__SERVER_SCRIPT__', 'describeSchedule', collectSchedule(form));
        if (res && res.text) box.setValue(res.text);
    } catch (e) { /* расшифровка — подсказка, её отказ не должен мешать работе */ }
}

/** Смена режима или любого поля расписания. */
async function onScheduleChanged(newVal, display, ctx) {
    var form = ctx && ctx.form;
    if (!form) return;
    applyModeVisibility(form);
    await refreshDescription(form);
}

/** Смена типа задачи: подставить в ТЧ «Параметры» ключи из схемы обработчика. */
async function onHandlerChanged(newVal, display, ctx) {
    var form = ctx && ctx.form;
    if (!form || !newVal) return;
    var tbl = ctrl(form, 'ts_scheduler_task_params');
    if (!tbl) return;

    var res = await callServer('__SERVER_SCRIPT__', 'getHandlerSchema', { handler: newVal });
    if (!res || !res.keys || !res.keys.length) return;

    var rows = tbl.data_getRows(tbl.dataKey) || [];
    var existing = {};
    for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].key) existing[rows[i].key] = true;

    var added = 0;
    for (var k = 0; k < res.keys.length; k++) {
        var spec = res.keys[k];
        if (existing[spec.key]) continue;
        var uid = await callServerMethod('drive_api', 'getNewUID', { tableName: 'scheduler_task_params' });
        rows.push({ UID: uid && uid.UID ? uid.UID : uid, key: spec.key, value: spec.defaultValue || '' });
        added++;
    }
    if (!added) return;

    tbl.data_updateValue(tbl.dataKey, rows);
    try { if (typeof tbl._invokeRenderBodyRows === 'function') tbl._invokeRenderBodyRows(); } catch (e) {}
    try { if (typeof form.setModified === 'function') form.setModified(true); } catch (e) {}
}

/** «Выполнить сейчас»: несохранённую задачу сначала сохраняем. */
async function runNow(ev, ctx) {
    var form = ctx && ctx.form;
    var uidEntry = form && form._dataMap && form._dataMap['UID'];
    var taskUID = uidEntry && uidEntry.value;
    if (!taskUID) { showAlert(__t('sched_save_first_msg')); return; }

    if (form.needsSave()) {
        var ok = await showConfirm(__t('sched_save_before_run_msg'));
        if (!ok) return;
        await form.doAction('save');
        if (form.needsSave()) return; // сохранение не удалось, ошибка уже показана
    }

    var res = await callServer('__SERVER_SCRIPT__', 'runNow', { taskUID: taskUID });
    if (!res || res.error) { showAlert(__t('Error: ') + ((res && res.error) || '')); return; }
    await refreshRunState(form);
    showAlert(res.message || __t('sched_run_started_msg'));
}

/** «Остановить» выполняющуюся задачу. */
async function stopRun(ev, ctx) {
    var form = ctx && ctx.form;
    var uidEntry = form && form._dataMap && form._dataMap['UID'];
    var taskUID = uidEntry && uidEntry.value;
    if (!taskUID) { showAlert(__t('sched_save_first_msg')); return; }

    var res = await callServer('__SERVER_SCRIPT__', 'stopRun', { taskUID: taskUID });
    if (!res || res.error) { showAlert(__t('Error: ') + ((res && res.error) || '')); return; }
    showAlert(res.message || __t('sched_cancel_requested_msg'));
}

/** «История запусков» — полный журнал (на форме есть и вкладка со связанным списком). */
async function openHistory(ev, ctx) {
    if (window.MySpace && typeof window.MySpace.open === 'function') {
        await window.MySpace.open('uniForm', { mode: 'list', dbTable: 'scheduler_runs' }, { singleton: true });
    }
}

function setStopEnabled(form, running) {
    var btn = ctrl(form, 'btnStop');
    if (btn && typeof btn.setEnabled === 'function') btn.setEnabled(!!running);
}

/** «Остановить» доступна, только пока задание выполняется. */
async function refreshRunState(form) {
    var uidEntry = form && form._dataMap && form._dataMap['UID'];
    var taskUID = uidEntry && uidEntry.value;
    if (!taskUID) { setStopEnabled(form, false); return; }
    try {
        var st = await callServer('__SERVER_SCRIPT__', 'getTaskState', { taskUID: taskUID });
        setStopEnabled(form, st && st.running);
    } catch (e) { setStopEnabled(form, false); }
}

// Журнал запусков живёт на SSE: как только запуск завершился, вкладка «История»
// перечитывает данные — по ним и определяем состояние кнопки «Остановить».
// Отдельный RPC не нужен: признак «выполняется» уже лежит в загруженных строках
// (см. раздел 31 архитектуры — зависимое состояние из onDataRefreshed).
function onRunsRefreshed(tbl, ctx) {
    var form = (ctx && ctx.form) || (tbl && tbl.appForm);
    if (!form) return;
    var rows = (tbl && tbl.dataCache) || [];
    var running = false;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i] && rows[i].status === 'running') { running = true; break; }
    }
    setStopEnabled(form, running);
}

/** Форма отрисована (form-level событие onReady): режим полей, расшифровка, состояние. */
async function onFormReady(ctx) {
    var form = ctx && ctx.form;
    if (!form) return;
    applyModeVisibility(form);
    await refreshDescription(form);
    await refreshRunState(form);
}

return { onScheduleChanged, onHandlerChanged, runNow, stopRun, openHistory, onFormReady, onRunsRefreshed };
