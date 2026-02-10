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
                    console.log('[getCurrentRow] instanceId:', instanceId);
                    
                    // SIMPLE FIX: If we have stored current record, return it!
                    if (this._currentRecord) {
                        console.log('[getCurrentRow] returning stored _currentRecord:', this._currentRecord);
                        return this._currentRecord;
                    }
                    
                    console.log('[getCurrentRow] no stored record, this.controlsMap keys:', Object.keys(this.controlsMap || {}));
                    
                    // CRITICAL FIX: If we have a direct reference to our DynamicTable, use it first!
                    if (this._dynamicTableInstance) {
                        console.log('[getCurrentRow] using stored _dynamicTableInstance');
                        const tbl = this._dynamicTableInstance;
                        const local = (typeof tbl._activeRowIndex === 'number') ? (tbl._activeRowIndex|0) : -1;
                        const first = (typeof tbl.firstVisibleRow === 'number') ? (tbl.firstVisibleRow|0) : (typeof tbl.firstRow === 'number' ? (tbl.firstRow|0) : 0);
                        const global = first + local;
                        console.log('[getCurrentRow] from stored table - local:', local, 'first:', first, 'global:', global);
                        if (local >= 0) {
                            if (tbl.dataCache && tbl.dataCache[global] && tbl.dataCache[global].loaded) {
                                console.log('[getCurrentRow] returning from stored table dataCache:', tbl.dataCache[global]);
                                return tbl.dataCache[global];
                            }
                            try { 
                                const arr = (typeof tbl.data_getRows === 'function') ? tbl.data_getRows(tbl.dataKey || tbl.data) : null; 
                                if (Array.isArray(arr) && arr[global]) {
                                    console.log('[getCurrentRow] returning from stored table data_getRows:', arr[global]);
                                    return arr[global];
                                }
                            } catch(e){}
                        }
                    }
                    
                    // Prefer table-like controls in controlsMap
                    const cm = this.controlsMap || {};
                    for (const k in cm) {
                        const ctrl = cm[k];
                        if (!ctrl) continue;
                        console.log('[getCurrentRow] checking control:', k, 'has _activeRowIndex:', typeof ctrl._activeRowIndex === 'number', 'value:', ctrl._activeRowIndex);
                        // If control exposes active row index, prefer DynamicTable-style mapping
                        if (typeof ctrl._activeRowIndex === 'number') {
                            const localIdx = ctrl._activeRowIndex | 0;
                            console.log('[getCurrentRow] found table control, localIdx:', localIdx);
                            // If control exposes firstVisibleRow (DynamicTable), compute global index
                            const first = (typeof ctrl.firstVisibleRow === 'number') ? (ctrl.firstVisibleRow | 0) : (typeof ctrl.firstRow === 'number' ? (ctrl.firstRow|0) : null);
                            if (first !== null) {
                                const globalIdx = first + localIdx;
                                console.log('[getCurrentRow] globalIdx:', globalIdx, 'firstVisibleRow:', first);
                                try {
                                    if (ctrl.dataCache && Object.prototype.hasOwnProperty.call(ctrl.dataCache, globalIdx) && ctrl.dataCache[globalIdx] && ctrl.dataCache[globalIdx].loaded) {
                                        console.log('[getCurrentRow] returning from dataCache:', ctrl.dataCache[globalIdx]);
                                        return ctrl.dataCache[globalIdx];
                                    }
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
                        console.log('[getCurrentRow] fallback: checking window._dynamicTableSubscribers');
                        if (typeof window !== 'undefined' && window._dynamicTableSubscribers && this.appName) {
                            console.log('[getCurrentRow] this.appName:', this.appName, 'this.dbTable:', this.dbTable, 'instanceId:', instanceId);
                            const subsIter = window._dynamicTableSubscribers.values();
                            
                            // First pass: try to find table with matching _uniListFormId
                            for (const s of subsIter) {
                                try {
                                    console.log('[getCurrentRow] checking subscriber set, size:', s.size);
                                    for (const tbl of s) {
                                        try {
                                            if (!tbl) continue;
                                            console.log('[getCurrentRow] checking table, appName:', tbl.appName, 'tableName:', tbl.tableName, '_activeRowIndex:', tbl._activeRowIndex, '_uniListFormId:', tbl._uniListFormId);
                                            // CRITICAL: Match by instanceId first!
                                            if (tbl._uniListFormId === instanceId && (tbl.appName === this.appName || tbl.appName === APP_NAME) && (tbl.tableName === (this.dbTable || this.tableName || ''))) {
                                                console.log('[getCurrentRow] MATCHED table by instanceId!');
                                                // map active row
                                                const local = (typeof tbl._activeRowIndex === 'number') ? (tbl._activeRowIndex|0) : -1;
                                                const first = (typeof tbl.firstVisibleRow === 'number') ? (tbl.firstVisibleRow|0) : (typeof tbl.firstRow === 'number' ? (tbl.firstRow|0) : 0);
                                                const global = first + local;
                                                console.log('[getCurrentRow] local:', local, 'first:', first, 'global:', global);
                                                if (tbl.dataCache && tbl.dataCache[global] && tbl.dataCache[global].loaded) {
                                                    console.log('[getCurrentRow] returning from matched table dataCache:', tbl.dataCache[global]);
                                                    return tbl.dataCache[global];
                                                }
                                                try { const arr = (typeof tbl.data_getRows === 'function') ? tbl.data_getRows(tbl.dataKey || tbl.data) : null; if (Array.isArray(arr) && arr[global]) return arr[global]; } catch(e){}
                                            }
                                        } catch(e){}
                                    }
                                } catch(e){}
                            }
                            
                            // Second pass: if not found by instanceId, take any unassigned table
                            console.log('[getCurrentRow] no table matched by instanceId, trying unassigned tables');
                            const subsIter2 = window._dynamicTableSubscribers.values();
                            for (const s of subsIter2) {
                                try {
                                    for (const tbl of s) {
                                        try {
                                            if (!tbl) continue;
                                            if (!tbl._uniListFormId && (tbl.appName === this.appName || tbl.appName === APP_NAME) && (tbl.tableName === (this.dbTable || this.tableName || ''))) {
                                                console.log('[getCurrentRow] Found unassigned table, claiming it');
                                                tbl._uniListFormId = instanceId; // Claim it
                                                // map active row
                                                const local = (typeof tbl._activeRowIndex === 'number') ? (tbl._activeRowIndex|0) : -1;
                                                const first = (typeof tbl.firstVisibleRow === 'number') ? (tbl.firstVisibleRow|0) : (typeof tbl.firstRow === 'number' ? (tbl.firstRow|0) : 0);
                                                const global = first + local;
                                                console.log('[getCurrentRow] local:', local, 'first:', first, 'global:', global);
                                                if (tbl.dataCache && tbl.dataCache[global] && tbl.dataCache[global].loaded) {
                                                    console.log('[getCurrentRow] returning from claimed table dataCache:', tbl.dataCache[global]);
                                                    return tbl.dataCache[global];
                                                }
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
                    console.log('[onSelect] called for instance:', instanceId);
                    console.log('[onSelect] callParams:', callParams);
                    console.log('[onSelect] has callParams.onSelectCallBack:', !!(callParams && callParams.onSelectCallBack));
                    console.log('[onSelect] has instance.initialOnSelectCallBack:', !!instance.initialOnSelectCallBack);
                    
                    let currentRecord = null;
                    try { currentRecord = appForm.getCurrentRow(); } catch (_) {}
                    console.log('[onSelect] currentRecord:', currentRecord);
                    
                    if (!currentRecord) {
                        console.log('[onSelect] NO CURRENT RECORD - ABORTING');
                        return;
                    }

                    try {
                        // IMPORTANT: Always use callParams.onSelectCallBack if present,
                        // only fall back to instance.initialOnSelectCallBack if callParams is empty.
                        // This ensures that when multiple instances are open, each uses its own callback.
                        const cb = (callParams && typeof callParams.onSelectCallBack === 'function') ? callParams.onSelectCallBack : (typeof instance.initialOnSelectCallBack === 'function' ? instance.initialOnSelectCallBack : null);
                        console.log('[uniListForm] using callback:', cb ? 'found' : 'NOT FOUND');
                        if (cb) {
                            try { 
                                console.log('[uniListForm] calling callback with record:', currentRecord);
                                cb(currentRecord, instance); 
                            } catch (e) { try { console.error && console.error('[uniListForm] callback error', e); } catch(_){} }
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
                    // Respect selectMode from openParams; default to false when absent
                    appForm.selectMode = openParams.selectMode || false;

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
                    
                    // Таблица автоматически связана с формой через DataForm.renderItem
                    // При клике на строку таблица обновит appForm._currentRecord
                    // Ничего настраивать не нужно!
                    console.log('[uniListForm] form opened, table:', appForm.table ? 'connected' : 'not found');
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
                    if (action === 'recordOpen') {
                        try {
                            console.log('[recordOpen] Getting current row...');
                            const row = appForm.getCurrentRow();
                            console.log('[recordOpen] row:', row);
                            console.log('[recordOpen] row.id:', row ? row.id : 'row is null');
                            
                            // Also log table state
                            const cm = appForm.controlsMap || {};
                            for (const k in cm) {
                                const ctrl = cm[k];
                                if (ctrl && typeof ctrl._activeRowIndex === 'number') {
                                    console.log('[recordOpen] table._activeRowIndex:', ctrl._activeRowIndex);
                                    console.log('[recordOpen] table.firstVisibleRow:', ctrl.firstVisibleRow);
                                    console.log('[recordOpen] table.firstRow:', ctrl.firstRow);
                                }
                            }
                            
                            if (!row || !row.id) {
                                if (typeof showAlert === 'function') showAlert('Выберите запись');
                                return;
                            }
                            const tableName = appForm.dbTable || params.tableName || '';
                            console.log('[recordOpen] Opening uniRecordForm with tableName:', tableName, 'recordID:', row.id);
                            if (window.MySpace && typeof window.MySpace.open === 'function') {
                                window.MySpace.open('uniRecordForm', { tableName, recordID: row.id });
                            }
                        } catch (e) { console.error('[recordOpen] error:', e); }
                        return;
                    }
                    if (typeof appForm.doAction === 'function') {
                        try { appForm.doAction(action, params); } catch (e) { console.error(e); }
                    }
                },
                destroy() {
                    console.log('[uniListForm] destroy called for instance:', instanceId);
                    
                    // Cleanup не нужен - таблица умрет вместе с формой
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
