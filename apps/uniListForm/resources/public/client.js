/**
 * myNewApp Application - Client Side
 */

try {
    (async function() {
        let APP_NAME = 'uniListForm'
        const APP_CONFIG = {};

        // Use framework `App` helper to build descriptor; override instance creation
        const app = new App(APP_NAME, { config: { allowMultipleInstances: true } });

        // Provide app-specific createInstance that sets up the DataForm.
        app.createInstance = async function(params) {
            const instanceId = this.generateInstanceId();
            const container = null; // App decides not to create per-instance container
            // Preserve any onSelect callback passed via MySpace.open(params)
            const initialOnSelectCallBack = (params && typeof params.onSelectCallBack === 'function') ? params.onSelectCallBack : null;

            const appForm = new DataForm(APP_NAME);
            appForm.setTitle(APP_NAME);
            appForm.setWidth(800);
            appForm.setHeight(600);
            appForm.setX(100);
            appForm.setY(100);

            function instanceOnOpen(dbTable) {
                appForm.dbTable = dbTable || null;
                if (!dbTable) {
                    if (typeof showAlert === 'function') showAlert('Не указана таблица базы данных!');
                    return false;
                }
                return true;
            }

            appForm.getCurrentRow = function() {
                try {
                    // Prefer table-like controls in controlsMap
                    const cm = this.controlsMap || {};
                    for (const k in cm) {
                        const ctrl = cm[k];
                        if (!ctrl) continue;
                        // If control exposes active row index, prefer DynamicTable-style mapping
                        if (typeof ctrl._activeRowIndex === 'number') {
                            const localIdx = ctrl._activeRowIndex | 0;
                            // If control exposes firstVisibleRow (DynamicTable), compute global index
                            const first = (typeof ctrl.firstVisibleRow === 'number') ? (ctrl.firstVisibleRow | 0) : (typeof ctrl.firstRow === 'number' ? (ctrl.firstRow|0) : null);
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
                            // Fallback: try to get from rows array if control exposes data_getRows (some tables return full array)
                            try {
                                if (typeof ctrl.data_getRows === 'function') {
                                    const rows = ctrl.data_getRows(ctrl.dataKey || ctrl.data);
                                    if (Array.isArray(rows) && localIdx >= 0 && localIdx < rows.length) return rows[localIdx];
                                }
                            } catch (e) {}
                        }
                        // If control provides getSelectedRows/getSelected, try those
                        if (typeof ctrl.getSelectedRows === 'function') {
                            const sel = ctrl.getSelectedRows();
                            if (Array.isArray(sel) && sel.length) {
                                // If array contains indices, map to dataCache/all rows
                                if (typeof sel[0] === 'number') {
                                    const idx = sel[0] | 0;
                                    const first = (typeof ctrl.firstVisibleRow === 'number') ? (ctrl.firstVisibleRow|0) : 0;
                                    const global = first + idx;
                                    if (ctrl.dataCache && ctrl.dataCache[global] && ctrl.dataCache[global].loaded) return ctrl.dataCache[global];
                                    try { const all = (typeof ctrl.data_getRows === 'function') ? ctrl.data_getRows(ctrl.dataKey || ctrl.data) : null; if (Array.isArray(all) && all[global]) return all[global]; } catch(e){}
                                }
                                // otherwise assume it's array of row objects
                                return sel[0];
                            }
                        }
                        if (typeof ctrl.getSelected === 'function') {
                            const s = ctrl.getSelected();
                            if (s) return s;
                        }
                    }

                    // Fallback: inspect appForm._dataMap for selected flag or first row in first array
                    // Try to find DynamicTable instances registered globally (when table had no name)
                    try {
                        if (typeof window !== 'undefined' && window._dynamicTableSubscribers && this.appName) {
                            const subsIter = window._dynamicTableSubscribers.values();
                            for (const s of subsIter) {
                                try {
                                    for (const tbl of s) {
                                        try {
                                            if (!tbl) continue;
                                            if ((tbl.appName === this.appName || tbl.appName === APP_NAME) && (tbl.tableName === (this.dbTable || this.tableName || ''))) {
                                                // map active row
                                                const local = (typeof tbl._activeRowIndex === 'number') ? (tbl._activeRowIndex|0) : -1;
                                                const first = (typeof tbl.firstVisibleRow === 'number') ? (tbl.firstVisibleRow|0) : (typeof tbl.firstRow === 'number' ? (tbl.firstRow|0) : 0);
                                                const global = first + local;
                                                if (tbl.dataCache && tbl.dataCache[global] && tbl.dataCache[global].loaded) return tbl.dataCache[global];
                                                try { const arr = (typeof tbl.data_getRows === 'function') ? tbl.data_getRows(tbl.dataKey || tbl.data) : null; if (Array.isArray(arr) && arr[global]) return arr[global]; } catch(e){}
                                            }
                                        } catch(e){}
                                    }
                                } catch(e){}
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
                    try { console.error('[uniListForm] getCurrentRow error', e); } catch (__) {}
                }
                return null;
            }

            const instance = {
                id: instanceId,
                appName: APP_NAME,
                container,
                form: appForm,
                initialOnSelectCallBack: initialOnSelectCallBack,

                async onSelect(callParams) {
                    let currentRecord = null;
                    try { currentRecord = appForm.getCurrentRow(); } catch (_) {}

                    try {
                        const cb = (callParams && typeof callParams.onSelectCallBack === 'function') ? callParams.onSelectCallBack : (typeof instance.initialOnSelectCallBack === 'function' ? instance.initialOnSelectCallBack : null);
                        if (cb) {
                            try { cb(currentRecord, instance); } catch (e) { try { console.error && console.error('[uniListForm] callback error', e); } catch(_){} }
                        } else {
                            try {  } catch(_){ }
                        }

                        try {
                            if (instance && typeof instance.destroy === 'function') {
                                try { instance.destroy(); } catch (_) {}
                            } else if (typeof window !== 'undefined' && window.MySpace && instance && instance.id && typeof window.MySpace.close === 'function') {
                                try { window.MySpace.close(instance.id); } catch (_) {}
                            }
                        } catch (e) { try { console.error && console.error('[uniListForm] close error', e); } catch(_){} }
                    } catch (e) {
                        try { console.error && console.error('[uniListForm] onSelect error', e); } catch (_) {}
                    }
                },

                async onOpen(params) {
                    const tableName = params && (params.dbTable || params.table);
                    if (!instanceOnOpen(tableName)) return;
                    const openParams = Object.assign({}, params || {});
                    openParams.tableName = openParams.tableName || openParams.dbTable || openParams.table || '';

                    try {
                        appForm.appName = APP_NAME;
                        appForm.getLayoutWithData = async function() {
                            try { return await callServerMethod(APP_NAME, 'getLayoutWithData', openParams); } catch (e) { throw e; }
                        };
                        appForm.loadData = async function() {
                            try {
                                const d = await callServerMethod(APP_NAME, 'getData', openParams);
                                this._dataMap = {};
                                if (d && Array.isArray(d)) {
                                    for (const rec of d) {
                                        if (rec && rec.name) this._dataMap[rec.name] = rec;
                                    }
                                }
                            } catch (e) {
                                this._dataMap = {};
                            }
                        };
                    } catch (e) {
                        console.error('[uniListForm] failed to override DataForm loaders', e);
                    }

                    try { appForm.Draw(); } catch (e) { console.error(e); }
                },
                onAction(action, params) {
                    // Support framework calling instance.onAction('open', params)
                    if (action === 'select') {
                        try { if (typeof this.onSelect === 'function') this.onSelect(params); } catch (e) { console.error(e); }
                        return;
                    }
                    if (action === 'open') {
                        try { if (typeof this.onOpen === 'function') this.onOpen(params); } catch (e) { console.error(e); }
                        return;
                    }
                    if (typeof appForm.doAction === 'function') {
                        try { appForm.doAction(action, params); } catch (e) { console.error(e); }
                    }
                },
                destroy() {
                    try { if (typeof appForm.destroy === 'function') appForm.destroy(); } catch (e) {}
                    try { if (typeof appForm.close === 'function') appForm.close(); } catch (e) {}
                }
            };

            // Attach instance to the form so Form.doAction forwards to instance.onAction
            appForm.instance = instance;

            if (params && (params.dbTable || params.table)) instance.onOpen(params);
            return instance;
        };

        try { app.register(); } catch (e) { console.error('Failed to register app descriptor', e); }

        // Background config fetch disabled: this app works with server-provided
        // settings and the project doesn't host /apps/recordEditor/config.json.
        // If you later want to enable external overrides, restore the fetch
        // from /apps/recordEditor/config.json and merge into `APP_CONFIG`.

        console.log('[' + APP_NAME + '] Client descriptor registered via App helper');

    })();
} catch (error) {
    console.error('[recordEditor] Error initializing client descriptor:', error);
}
