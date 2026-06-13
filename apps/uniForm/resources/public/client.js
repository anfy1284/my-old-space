/**
 * uniForm — Универсальная форма фреймворка.
 * Режим списка: открывается с params.dbTable → DynamicTable, поддерживает selectMode / onSelectCallBack.
 * Режим записи: открывается с params.tableName (+ опционально params.recordID) → DataForm с полями.
 * В обоих случаях DataForm.Draw() отрисовывает лейаут, возвращённый сервером.
 */

try {
    (async function() {
        let APP_NAME = 'uniForm';
        const APP_CONFIG = {};

        const app = new App(APP_NAME, { config: { allowMultipleInstances: true } });

        app.createInstance = async function(params) {
            const instanceId = this.generateInstanceId();
            const container = null;
            const initialOnSelectCallBack = (params && typeof params.onSelectCallBack === 'function') ? params.onSelectCallBack : null;
            const initialOnAfterSave = (params && typeof params.onAfterSave === 'function') ? params.onAfterSave : null;

            const appForm = new DataForm(APP_NAME);
            appForm.setTitle(APP_NAME);
            // Ни размер, ни позицию НЕ хардкодим: режим записи центрируется и подгоняется под
            // контент (windowState:'centered' → setSizeToContent в DataForm.Draw), режим списка
            // разворачивается (windowState:'maximized'). Финальный шаг позиционирования —
            // каскад окон (Form._resolveOverlap) в DataForm.Draw.

            // ── getCurrentRow: нужна для режима списка (selectMode / FK-пикер) ──────────────
            appForm.getCurrentRow = function() {
                try {
                    if (this._currentRecord) return this._currentRecord;

                    if (this._dynamicTableInstance) {
                        const tbl = this._dynamicTableInstance;
                        const local = (typeof tbl._activeRowIndex === 'number') ? (tbl._activeRowIndex | 0) : -1;
                        const first = (typeof tbl.firstVisibleRow === 'number') ? (tbl.firstVisibleRow | 0) : (typeof tbl.firstRow === 'number' ? (tbl.firstRow | 0) : 0);
                        const global = first + local;
                        if (local >= 0) {
                            if (tbl.dataCache && tbl.dataCache[global] && tbl.dataCache[global].loaded) return tbl.dataCache[global];
                            try { const arr = (typeof tbl.data_getRows === 'function') ? tbl.data_getRows(tbl.dataKey || tbl.data) : null; if (Array.isArray(arr) && arr[global]) return arr[global]; } catch(e) {}
                        }
                    }

                    const cm = this.controlsMap || {};
                    for (const k in cm) {
                        const ctrl = cm[k];
                        if (!ctrl) continue;
                        if (typeof ctrl._activeRowIndex === 'number') {
                            const localIdx = ctrl._activeRowIndex | 0;
                            const first = (typeof ctrl.firstVisibleRow === 'number') ? (ctrl.firstVisibleRow | 0) : (typeof ctrl.firstRow === 'number' ? (ctrl.firstRow | 0) : null);
                            if (first !== null) {
                                const globalIdx = first + localIdx;
                                try {
                                    if (ctrl.dataCache && Object.prototype.hasOwnProperty.call(ctrl.dataCache, globalIdx) && ctrl.dataCache[globalIdx] && ctrl.dataCache[globalIdx].loaded) return ctrl.dataCache[globalIdx];
                                } catch (e) {}
                                try {
                                    const all = (typeof ctrl.data_getRows === 'function') ? ctrl.data_getRows(ctrl.dataKey || ctrl.data) : null;
                                    if (Array.isArray(all) && all[globalIdx]) return all[globalIdx];
                                } catch (e) {}
                            }
                            try {
                                if (typeof ctrl.data_getRows === 'function') {
                                    const rows = ctrl.data_getRows(ctrl.dataKey || ctrl.data);
                                    if (Array.isArray(rows) && localIdx >= 0 && localIdx < rows.length) return rows[localIdx];
                                }
                            } catch (e) {}
                        }
                        if (typeof ctrl.getSelectedRows === 'function') {
                            const sel = ctrl.getSelectedRows();
                            if (Array.isArray(sel) && sel.length) {
                                if (typeof sel[0] === 'number') {
                                    const idx = sel[0] | 0;
                                    const first = (typeof ctrl.firstVisibleRow === 'number') ? (ctrl.firstVisibleRow | 0) : 0;
                                    const global = first + idx;
                                    if (ctrl.dataCache && ctrl.dataCache[global] && ctrl.dataCache[global].loaded) return ctrl.dataCache[global];
                                    try { const all = (typeof ctrl.data_getRows === 'function') ? ctrl.data_getRows(ctrl.dataKey || ctrl.data) : null; if (Array.isArray(all) && all[global]) return all[global]; } catch(e) {}
                                }
                                return sel[0];
                            }
                        }
                        if (typeof ctrl.getSelected === 'function') {
                            const s = ctrl.getSelected();
                            if (s) return s;
                        }
                    }

                    // Поиск DynamicTable по window._dynamicTableSubscribers
                    try {
                        if (typeof window !== 'undefined' && window._dynamicTableSubscribers) {
                            const subsIter = window._dynamicTableSubscribers.values();
                            for (const s of subsIter) {
                                try {
                                    for (const tbl of s) {
                                        try {
                                            if (!tbl) continue;
                                            if (tbl._uniFormId === instanceId && (tbl.appName === APP_NAME) && (tbl.tableName === (this.dbTable || this.tableName || ''))) {
                                                const local = (typeof tbl._activeRowIndex === 'number') ? (tbl._activeRowIndex | 0) : -1;
                                                const first = (typeof tbl.firstVisibleRow === 'number') ? (tbl.firstVisibleRow | 0) : 0;
                                                const global = first + local;
                                                if (tbl.dataCache && tbl.dataCache[global] && tbl.dataCache[global].loaded) return tbl.dataCache[global];
                                                try { const arr = (typeof tbl.data_getRows === 'function') ? tbl.data_getRows(tbl.dataKey || tbl.data) : null; if (Array.isArray(arr) && arr[global]) return arr[global]; } catch(e) {}
                                            }
                                        } catch(e) {}
                                    }
                                } catch(e) {}
                            }
                            // Второй проход: незакреплённые таблицы
                            const subsIter2 = window._dynamicTableSubscribers.values();
                            for (const s of subsIter2) {
                                try {
                                    for (const tbl of s) {
                                        try {
                                            if (!tbl) continue;
                                            if (!tbl._uniFormId && (tbl.appName === APP_NAME) && (tbl.tableName === (this.dbTable || this.tableName || ''))) {
                                                tbl._uniFormId = instanceId;
                                                const local = (typeof tbl._activeRowIndex === 'number') ? (tbl._activeRowIndex | 0) : -1;
                                                const first = (typeof tbl.firstVisibleRow === 'number') ? (tbl.firstVisibleRow | 0) : 0;
                                                const global = first + local;
                                                if (tbl.dataCache && tbl.dataCache[global] && tbl.dataCache[global].loaded) return tbl.dataCache[global];
                                                try { const arr = (typeof tbl.data_getRows === 'function') ? tbl.data_getRows(tbl.dataKey || tbl.data) : null; if (Array.isArray(arr) && arr[global]) return arr[global]; } catch(e) {}
                                            }
                                        } catch(e) {}
                                    }
                                } catch(e) {}
                            }
                        }
                    } catch (e) {}

                    if (this._dataMap && typeof this._dataMap === 'object') {
                        for (const key in this._dataMap) {
                            const entry = this._dataMap[key];
                            if (!entry) continue;
                            if (Array.isArray(entry.value)) {
                                const found = entry.value.find(r => r && (r._selected || r.selected || r.checked));
                                if (found) return found;
                                if (entry.value.length) return entry.value[0];
                            }
                        }
                    }
                } catch (e) {
                    try { console.error('[uniForm] getCurrentRow error', e); } catch (__) {}
                }
                return null;
            };

            const instance = {
                id: instanceId,
                appName: APP_NAME,
                container,
                form: appForm,
                initialOnSelectCallBack,
                initialOnAfterSave,

                // ── onSelect: вызывается фреймворком при action='select' (режим FK-пикера) ──
                async onSelect(callParams) {
                    let currentRecord = null;
                    try { currentRecord = appForm.getCurrentRow(); } catch (_) {}
                    if (!currentRecord) return;

                    const cb = (callParams && typeof callParams.onSelectCallBack === 'function')
                        ? callParams.onSelectCallBack
                        : (typeof instance.initialOnSelectCallBack === 'function' ? instance.initialOnSelectCallBack : null);

                    if (cb) {
                        try { cb(currentRecord, instance); } catch(e) { console.error('[uniForm] onSelect callback error', e); }
                    }

                    try {
                        if (typeof instance.destroy === 'function') instance.destroy();
                        else if (typeof window !== 'undefined' && window.MySpace && instance.id && typeof window.MySpace.close === 'function') window.MySpace.close(instance.id);
                    } catch(e) {}
                },

                async onOpen(params) {
                    const openParams = Object.assign({}, params || {});

                    // Нормализуем tableName: для режима списка берём из dbTable
                    if (!openParams.tableName && (openParams.dbTable || openParams.table)) {
                        openParams.tableName = openParams.dbTable || openParams.table;
                    }

                    appForm.dbTable    = openParams.dbTable || openParams.tableName || null;
                    appForm.selectMode = openParams.selectMode || false;

                    try {
                        appForm.appName = APP_NAME;
                        appForm.getLayoutWithData = async function() {
                            try { return await callServerMethod(APP_NAME, 'getLayoutWithData', openParams); } catch(e) { throw e; }
                        };
                        appForm.loadData = async function() {
                            try {
                                const d = await callServerMethod(APP_NAME, 'getData', openParams);
                                this._dataMap = {};
                                if (d && Array.isArray(d)) {
                                    for (const rec of d) { if (rec && rec.name) this._dataMap[rec.name] = rec; }
                                }
                            } catch(e) { this._dataMap = {}; }
                        };
                    } catch(e) {
                        console.error('[uniForm] failed to override DataForm loaders', e);
                    }

                    // ── onAfterSave: intercept applyChanges when onAfterSave callback is provided ──
                    if (typeof instance.initialOnAfterSave === 'function') {
                        const origApplyChanges = appForm.applyChanges ? appForm.applyChanges.bind(appForm) : null;
                        appForm.applyChanges = async function(changes) {
                            let res = null;
                            try {
                                if (origApplyChanges) {
                                    res = await origApplyChanges(changes);
                                } else {
                                    res = await callServerMethod(APP_NAME, 'applyChanges', changes);
                                }
                            } catch(e) {
                                throw e;
                            }
                            if (res && res.ok && typeof instance.initialOnAfterSave === 'function') {
                                try {
                                    let nameVal = '';
                                    try {
                                        const nameCtrl = appForm.controlsMap && appForm.controlsMap['name'];
                                        if (nameCtrl && nameCtrl.element) nameVal = nameCtrl.element.value || '';
                                        else if (appForm._dataMap && appForm._dataMap['name']) nameVal = String(appForm._dataMap['name'].value || '');
                                    } catch(_) {}
                                    instance.initialOnAfterSave({ UID: res.recordId, name: nameVal });
                                } catch(e) { console.error('[uniForm] onAfterSave callback error', e); }
                                try { setTimeout(() => { try { instance.destroy(); } catch(_){} }, 0); } catch(_){}
                            }
                            return res;
                        };
                    }

                    // await: дожидаемся полной отрисовки (loadLayout + renderLayout +
                    // загрузка данных с сервера). Без await onOpen резолвится мгновенно,
                    // createInstance/MySpace.open «считают» окно открытым, и бегущий
                    // прогрессбар гаснет раньше, чем форма реально нарисована.
                    try { await appForm.Draw(); } catch(e) { console.error(e); }
                },

                onAction(action, params) {
                    if (action === 'select') {
                        try { if (typeof this.onSelect === 'function') this.onSelect(params); } catch(e) { console.error(e); }
                        return;
                    }
                    if (action === 'open') {
                        try { if (typeof this.onOpen === 'function') this.onOpen(params); } catch(e) { console.error(e); }
                        return;
                    }
                    // Защита от рекурсии: не вызываем appForm.doAction обратно
                },

                destroy() {
                    // Программный teardown инстанса (MySpace.close, авто-закрытие после
                    // onAfterSave/выбора записи) НЕ должен показывать интерактивное
                    // подтверждение "Discard unsaved changes?". Выставляем _closing ДО
                    // appForm.close(), чтобы DataForm.close() сразу ушёл в super.close()
                    // без вопроса. Пользовательское закрытие крестиком идёт другим путём
                    // (Form.close через титлбар) и подтверждение там сохраняется.
                    try { appForm._closing = true; } catch(e) {}
                    try { if (typeof appForm.destroy === 'function') appForm.destroy(); } catch(e) {}
                    try { if (typeof appForm.close === 'function') appForm.close(); } catch(e) {}
                }
            };

            // Привязываем instance к форме для форвардинга action
            appForm.instance = instance;

            // await: createInstance должен резолвиться только когда форма реально
            // отрисована — тогда MySpace.open держит бегущий прогрессбар до конца
            // открытия, а не гасит его на пустом объекте instance.
            if (params && (params.dbTable || params.tableName || params.table)) await instance.onOpen(params);
            return instance;
        };

        try { app.register(); } catch(e) { console.error('[uniForm] Failed to register app descriptor', e); }

        // Таблицы-исключения для дедупликации окон. По умолчанию MySpace._openInternal
        // держит одну форму списка на таблицу и одну форму записи на запись (UID); таблицы
        // из этой карты разрешают несколько окон (entityConfig.allowMultipleListForms /
        // allowMultipleRecordForms). До загрузки карты действует безопасный дефолт (дедуп вкл).
        try {
            callServerMethod(APP_NAME, 'getMultiInstanceTables', {})
                .then(map => { if (map && typeof map === 'object') window.MySpaceMultiInstanceTables = map; })
                .catch(() => {});
        } catch (e) {}

        console.log('[uniForm] Client descriptor registered');
    })();
} catch (error) {
    console.error('[uniForm] Error initializing client descriptor:', error);
}
