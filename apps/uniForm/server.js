// uniForm/server.js
// Универсальная форма фреймворка: список (params.dbTable) + редактирование записи (params.tableName + recordID).
// Объединяет функциональность бывших uniListForm и uniRecordForm.
// Backward-compat: layoutMemory проверяется также по именам 'uniListForm' и 'uniRecordForm'.

const { tForSession, tfForSession } = require('../../drive_forms/globalServerContext');

// UID generation utility
let _util = null;
try { _util = require('../../drive_root/db/utilites'); } catch(e) { console.warn('[uniForm] util load failed:', e && e.message); }

const memoryStore = require('../../drive_root/memory_store');
const { dataApp } = require('../../drive_forms/dataApp');
const config = require('./config.json');
const globalServerContext = require('../../drive_root/globalServerContext');

try { const dbg = memoryStore.debugKeysSync('datasets'); console.log('[uniForm] memoryStore init; datasetsCount=', dbg.count); } catch (e) {}

// ── Вспомогательная функция: проверить layoutMemory по нескольким именам приложений ──────────
// Порядок: сначала 'uniForm', потом старые имена для backward-compat.
const LAYOUT_APP_NAMES_LIST   = ['uniForm', 'uniListForm'];
const LAYOUT_APP_NAMES_RECORD = ['uniForm', 'uniRecordForm'];

async function findCustomLayout(appNames, mode, tableName, sessionID) {
    try {
        const layoutMemory = require('../../drive_root/layoutMemory');
        for (const appName of appNames) {
            if (!layoutMemory.hasRegistered(appName, tableName, mode)) continue;
            const userRole = await layoutMemory.getUserRoleBySession(sessionID);
            const layout = await layoutMemory.getLayoutForUser(appName, tableName, userRole, sessionID, mode);
            if (layout) return layout;
        }
    } catch(e) {
        console.error('[uniForm/findCustomLayout] error:', e && e.message || e);
    }
    return null;
}

function getData(params) {
    return [];
}

// ── getLayoutWithData ─────────────────────────────────────────────────────────────────────────
async function getLayoutWithData(params, sessionID) {
    try {
        const tableName = params && (params.tableName || params.dbTable || params.table);

        // ── РЕЖИМ СПИСКА: явный mode:'list', либо params.dbTable без recordID ─────────────────
        const isListMode = params.mode === 'list' ||
            (!params.mode && !!(params.dbTable && !params.recordID && !params.recordId && !params.id));
        if (isListMode) {
            const customLayout = await findCustomLayout(LAYOUT_APP_NAMES_LIST, 'list', tableName, sessionID);
            if (customLayout) {
                const clLayout = JSON.parse(JSON.stringify(customLayout.layout || customLayout));

                // Если лейаут имеет onLoadData — вызываем его (как в record-режиме),
                // чтобы виртуальные/синтетические списки могли наполнить данные.
                let listData = [];
                if (customLayout.events && customLayout.events.onLoadData) {
                    try {
                        const serverScriptStore = require('../../drive_root/serverScriptStore');
                        const layoutMemory2    = require('../../drive_root/layoutMemory');
                        const userRole = await layoutMemory2.getUserRoleBySession(sessionID);
                        const binding  = customLayout.events.onLoadData;
                        const entry    = serverScriptStore.getServerScript(binding.serverScript, userRole || '*');
                        const fn       = entry && entry.scriptObj && entry.scriptObj[binding.fn || 'onLoadData'];
                        if (typeof fn === 'function') {
                            const result = await fn({ tableName, params }, { sessionID });
                            listData = (result && result.data) || [];
                            if (result && result.caption && Array.isArray(clLayout) && clLayout[0]) {
                                clLayout[0].caption = result.caption;
                            }
                        }
                    } catch (e) {
                        console.error('[uniForm/getLayoutWithData] list onLoadData error:', e && e.message || e);
                    }
                }

                const payload = { layout: clLayout, data: listData, params: params || {} };
                const datasetId = dataApp.storeDataset(payload);
                return {
                    layout: clLayout, data: listData, datasetId,
                    clientScript: customLayout.clientScript || null,
                    formIcon: customLayout.formIcon || null,
                    windowState: customLayout.windowState || 'maximized'
                };
            }
            // Дефолтный лейаут списка: DynamicTable
            const layout = [{
                type: 'table',
                caption: tableName,
                properties: {
                    dynamicTable: true,
                    readOnly: params.readOnly !== false,
                    appName: config.name,
                    tableName: tableName,
                    visibleRows: 10,
                    editable: true,
                    showToolbar: true,
                    initialSort: [{ field: 'name', order: 'asc' }]
                }
            }];
            const payload = { layout, data: [], params: params || {} };
            const datasetId = dataApp.storeDataset(payload);
            const layoutMemory2 = require('../../drive_root/layoutMemory');
            const formIcon = (tableName && layoutMemory2.getTableIcon(tableName)) || '/apps/general_icons/resources/public/16x16/catalog.png';
            return { layout, data: [], datasetId, formIcon, windowState: 'maximized' };
        }

        // ── РЕЖИМ ЗАПИСИ ──────────────────────────────────────────────────────────────────────

        // Обновление данных после сохранения: datasetId без tableName
        if (params && params.datasetId && !params.tableName) {
            try {
                const dsObj = await dataApp.getDataset(params.datasetId);
                if (dsObj && dsObj.table) {
                    const resolvedParams = Object.assign({}, dsObj.params || {}, {
                        tableName: dsObj.table,
                        recordID:  dsObj.id || undefined
                    });
                    const spec = await generateFormSpec(resolvedParams.tableName, resolvedParams, sessionID);
                    return { layout: spec.layout, data: spec.data, datasetId: spec.datasetId,
                             clientScript: spec.clientScript || null, formIcon: spec.formIcon || null, windowState: spec.windowState || null };
                }
            } catch (e) {
                console.error('[uniForm/getLayoutWithData] datasetId refresh error:', e && e.message || e);
            }
        }

        if (params && params.tableName) {
            try {
                const spec = await generateFormSpec(params.tableName, params, sessionID);
                const datasetId = spec.datasetId || dataApp.storeDataset({
                    layout: spec.layout || [],
                    data: spec.data || [],
                    params: params || {},
                    table: params.tableName,
                    id: params.recordID || params.recordId || params.id
                });
                return { layout: spec.layout, data: spec.data, datasetId, clientScript: spec.clientScript || null, formIcon: spec.formIcon || null, windowState: spec.windowState || null };
            } catch (e) {
                console.error('[uniForm/getLayoutWithData] generateFormSpec error:', e && e.message || e);
            }
        }

        // Fallback
        const payload = { layout: [], data: [], params: params || {}, table: tableName };
        const datasetId = dataApp.storeDataset(payload);
        return { layout: [], data: [], datasetId };
    } catch (e) {
        return { layout: [], data: [], datasetId: null };
    }
}

// ── applyChanges ──────────────────────────────────────────────────────────────────────────────
async function applyChanges(payload, sessionID) {
    let datasetId = payload;
    let changes = null;
    try {
        console.log('[uniForm] applyChanges called.');
        if (payload && typeof payload === 'object' && (payload.datasetId !== undefined || payload.changes !== undefined)) {
            datasetId = payload.datasetId;
            changes = payload.changes;
        }

        let dsObj = null;
        try {
            dsObj = await dataApp.getDataset(datasetId);
        } catch (e) { console.log('[uniForm] dataset retrieval error', e); }

        if (!datasetId) {
            return { ok: false, error: await tForSession('missing_datasetId', sessionID) };
        } else if (!dsObj) {
            return { ok: false, error: 'unknown datasetId: ' + datasetId };
        }

        const tableName = dsObj.table || (dsObj.params && (dsObj.params.tableName || dsObj.params.dbTable || dsObj.params.table));
        const recordId = dsObj.id || (dsObj.params && (dsObj.params.recordID || dsObj.params.recordId || dsObj.params.id));

        if (!tableName) {
            return { ok: false, error: await tForSession('no_table_context', sessionID) };
        }

        // ── onSave: кастомный серверный скрипт (EAV и другие виртуальные таблицы) ──
        try {
            const layoutMemory = require('../../drive_root/layoutMemory');
            const serverScriptStore = require('../../drive_root/serverScriptStore');
            for (const appN of LAYOUT_APP_NAMES_RECORD) {
                if (!layoutMemory.hasRegistered(appN, tableName, 'record')) continue;
                const userRole = await layoutMemory.getUserRoleBySession(sessionID);
                const stored = await layoutMemory.getLayoutForUser(appN, tableName, userRole, sessionID, 'record');
                if (stored && stored.events && stored.events.onSave) {
                    const binding = stored.events.onSave;
                    const entry = serverScriptStore.getServerScript(binding.serverScript, userRole || '*');
                    const fn = entry && entry.scriptObj && entry.scriptObj[binding.fn || 'onSave'];
                    if (typeof fn === 'function') {
                        const result = await fn({ changes, tableName }, { sessionID });
                        return result || { ok: true };
                    }
                }
                break;
            }
        } catch (e) {
            console.error('[uniForm] onSave event error:', e && e.message || e);
        }

        const modelName = globalServerContext.getModelNameForTable(tableName) || tableName;
        const Model = globalServerContext.modelsDB[modelName];

        if (!Model) {
            return { ok: false, error: 'Model not found for table: ' + tableName + ' (model: ' + modelName + ')' };
        }

        const applyDbGW = require('../../drive_root/dbGateway');

        let tabularSectionsData = null;
        if (changes && typeof changes.__tabularSections === 'object' && changes.__tabularSections !== null) {
            tabularSectionsData = changes.__tabularSections;
            changes = Object.assign({}, changes);
            delete changes.__tabularSections;
        }

        const parentUID = recordId;

        await dispatchServerEvent('onBeforeSave', {
            tableName,
            record:          null,
            changes,
            tabularSections: tabularSectionsData || {},
            parentUID,
            isNew:           !recordId || !!dsObj.isNew
        }, { tableName, sessionID });

        if (recordId && !dsObj.isNew) {
            console.log(`[uniForm] Updating ${tableName} UID=${recordId} with`, changes);
            await applyDbGW.execute({ operation: 'update', table: tableName, data: changes, where: { UID: recordId }, context: { appName: 'uniForm', sessionID } });
        } else {
            if (dsObj.isNew && recordId && !changes.UID) {
                changes = Object.assign({}, changes, { UID: recordId });
            }
            console.log(`[uniForm] Creating new ${tableName} with`, changes);
            await applyDbGW.execute({ operation: 'create', table: tableName, data: changes, context: { appName: 'uniForm', sessionID } });
        }

        let parentRecord = null;
        if (tabularSectionsData && parentUID) {
            try {
                parentRecord = await applyDbGW.execute({
                    operation: 'findByPk', table: tableName, where: { UID: parentUID },
                    options: { raw: true }, context: { appName: 'uniForm', sessionID }
                });
            } catch(e) {
                console.warn('[uniForm] Could not load parent record:', e && e.message);
            }
        }

        const saveWarnings = [];
        if (tabularSectionsData && parentUID) {
            const tsDefs = getTabularSectionsForTable(tableName);
            const tsTableNames = new Set(tsDefs.map(d => d.tableName));

            let allModelDefs = [];
            try {
                const gCtx = require('../../drive_root/globalServerContext');
                allModelDefs = (gCtx.collectAllModelDefs().models) || [];
            } catch(e) { console.warn('[uniForm] Could not load model defs:', e && e.message); }

            const hasSiblingFKDeps = (sectName) => {
                const md = allModelDefs.find(m => m.tableName === sectName);
                if (!md || !md.fields) return false;
                return Object.values(md.fields).some(f =>
                    f.references && tsTableNames.has(f.references.model) && f.references.model !== sectName
                );
            };
            const sectionEntries = Object.entries(tabularSectionsData);
            sectionEntries.sort((a, b) => (hasSiblingFKDeps(a[0]) ? 1 : 0) - (hasSiblingFKDeps(b[0]) ? 1 : 0));

            const validSiblingUIDs = {};

            for (const [sectionTableName, rows] of sectionEntries) {
                try {
                    const tsDef = tsDefs.find(d => d.tableName === sectionTableName);
                    if (!tsDef) {
                        console.warn('[uniForm] tabularSection def not found for:', sectionTableName);
                        continue;
                    }
                    const parentField = tsDef.tabularSection.parentField;
                    const sectModelDef = allModelDefs.find(m => m.tableName === sectionTableName);
                    const sectFields = (sectModelDef && sectModelDef.fields) || {};

                    await applyDbGW.execute({
                        operation: 'delete', table: sectionTableName, where: { [parentField]: parentUID },
                        context: { appName: 'uniForm', sessionID }
                    });

                    if (Array.isArray(rows)) {
                        for (let ri = 0; ri < rows.length; ri++) {
                            const row = rows[ri];
                            const rowData = Object.assign({}, row);
                            rowData[parentField] = parentUID;

                            // Приведение пустых строк к null для числовых полей
                            for (const [fn, fd] of Object.entries(sectFields)) {
                                if (rowData[fn] === '' || rowData[fn] === undefined) {
                                    const t = (fd.type || '').toUpperCase();
                                    if (t === 'INTEGER' || t === 'FLOAT' || t === 'DECIMAL' || t === 'DOUBLE' || t === 'NUMBER' || t === 'REAL') {
                                        rowData[fn] = fd.defaultValue != null ? fd.defaultValue : null;
                                    }
                                }
                            }

                            // Серверная валидация безопасности: межсекционные FK
                            let securityOk = true;
                            for (const [fieldName, fieldDef] of Object.entries(sectFields)) {
                                if (!fieldDef.references) continue;
                                const refTable = fieldDef.references.model;
                                if (!tsTableNames.has(refTable) || refTable === sectionTableName) continue;
                                const fkVal = rowData[fieldName];
                                if (!fkVal) {
                                    if (fieldDef.allowNull === true) continue;
                                    const msg = await tfForSession('row_field_required', sessionID, { row: ri + 1, section: sectionTableName, field: fieldName });
                                    console.warn('[uniForm TS_SECURITY]', msg);
                                    saveWarnings.push(msg);
                                    securityOk = false;
                                    break;
                                }
                                const validSet = validSiblingUIDs[refTable];
                                if (validSet && !validSet.has(fkVal)) {
                                    const msg = await tfForSession('row_field_fk_mismatch', sessionID, { row: ri + 1, section: sectionTableName, field: fieldName });
                                    console.error('[uniForm TS_SECURITY]', msg, `(fkVal=${fkVal})`);
                                    saveWarnings.push(msg);
                                    securityOk = false;
                                    break;
                                }
                            }
                            if (!securityOk) continue;

                            try {
                                await applyDbGW.execute({
                                    operation: 'create', table: sectionTableName, data: rowData,
                                    context: { appName: 'uniForm', sessionID }
                                });
                            } catch (insertErr) {
                                const errMsg = insertErr && insertErr.message || String(insertErr);
                                console.error(`[uniForm] TS INSERT row[${ri}] FAILED:`, errMsg);
                                saveWarnings.push(await tfForSession('row_save_error', sessionID, { row: ri + 1, section: sectionTableName, error: errMsg }));
                            }
                        }
                    }

                    // Читаем актуальные UID для валидации зависимых секций
                    try {
                        const savedRows = await applyDbGW.execute({
                            operation: 'read', table: sectionTableName, where: { [parentField]: parentUID },
                            options: { raw: true }, context: { appName: 'uniForm', sessionID }
                        });
                        validSiblingUIDs[sectionTableName] = new Set((savedRows || []).map(r => r.UID).filter(Boolean));
                    } catch(e) {
                        validSiblingUIDs[sectionTableName] = new Set();
                    }

                    console.log(`[uniForm] TS saved: ${sectionTableName}, rows: ${Array.isArray(rows) ? rows.length : 0}`);
                } catch (e) {
                    console.error('[uniForm] TS save error for', sectionTableName, ':', e && e.message || e);
                }
            }
        }

        return saveWarnings.length > 0
            ? { ok: true, recordId: parentUID, warnings: saveWarnings }
            : { ok: true, recordId: parentUID };
    } catch (e) {
        console.error('[uniForm] applyChanges error:', e);
        return { ok: false, error: String(e) };
    }
}

// ── registerDynamicTableMethods ───────────────────────────────────────────────────────────────
const { registerDynamicTableMethods } = require('../../drive_forms/dynamicTableRegistry');

function buildTableFields(params) {
    const tableName = params && (params.tableName || params.dbTable || params.table);
    if (!tableName) return null;
    return buildTableFieldsFromModel(tableName);
}

// Build table fields from global model metadata (единственная копия для uniForm)
async function buildTableFieldsFromModel(tableName) {
    try {
        const globalCtx = require('../../drive_root/globalServerContext');
        const modelName = globalCtx.getModelNameForTable(tableName) || tableName;
        if (!modelName) return null;
        const meta = await globalCtx.getTableMetadata(modelName);
        if (!Array.isArray(meta)) return null;

        const fields = meta.map(f => {
            const typeKey = f.type || '';
            let inputType = 'textbox';
            if (f.foreignKey) inputType = 'recordSelector';
            else if (f.isAddress) inputType = 'address';
            else if (typeKey === 'INTEGER') inputType = 'number';
            else if (typeKey === 'BOOLEAN') inputType = 'checkbox';
            else if (typeKey === 'DATE' || typeKey === 'DATEONLY') inputType = 'date';

            const field = {
                name: f.name,
                caption: f.caption || f.name,
                type: typeKey,
                inputType: inputType,
                width: f.width || 100,
                source: 'field',
                editable: !!f.editable
            };

            if (f.foreignKey) {
                field.foreignKey = f.foreignKey;
                field.properties = {
                    selection: { table: f.foreignKey.table, idField: f.foreignKey.field || 'UID', displayField: f.foreignKey.displayField || 'name' },
                    showSelectionButton: true,
                    listMode: true,
                    listSource: { app: config.name, table: f.foreignKey.table, idField: f.foreignKey.field || 'UID', displayField: f.foreignKey.displayField || 'name', limit: 50 }
                };
            }

            return field;
        });

        return fields;
    } catch (e) {
        console.error('[uniForm/buildTableFieldsFromModel] metadata build failed:', e && e.message || e);
        return null;
    }
}

// Map inputType to UI control type
function mapInputTypeToControl(inputType) {
    const t = (inputType || '').toString().toLowerCase();
    if (t === 'textbox' || t === 'string') return 'textbox';
    if (t === 'number' || t === 'integer') return 'number';
    if (t === 'checkbox' || t === 'boolean') return 'checkbox';
    if (t === 'date' || t === 'dateonly') return 'date';
    if (t === 'recordselector') return 'recordSelector';
    if (t === 'address') return 'address';
    if (t === 'textarea' || t === 'text') return 'textarea';
    if (t === 'enum' || t === 'emunlist' || t === 'emunlist') return 'emunList';
    return 'textbox';
}

// Динамический резолвер моделей: использует globalServerContext, не хардкодит таблицы
const dynamicTableMethods = registerDynamicTableMethods('uniForm', {
    tables: (params) => {
        const tableName = params && (params.tableName || params.dbTable || params.table);
        if (!tableName) return null;
        try {
            const globalCtx = require('../../drive_root/globalServerContext');
            return globalCtx.getModelNameForTable(tableName) || tableName;
        } catch(e) {
            return tableName;
        }
    },
    tableFields: (params) => {
        return buildTableFields(params);
    },
    accessCheck: async (user, tableName, action) => {
        return true;
    }
});

// ── Вспомогательные функции для работы с ТЧ ─────────────────────────────────────────────────

function getTabularSectionsForTable(parentTableName) {
    try {
        const globalCtx = require('../../drive_root/globalServerContext');
        const { models } = globalCtx.collectAllModelDefs();
        return (models || []).filter(def =>
            def.tabularSection &&
            def.tabularSection.parentTable === parentTableName
        );
    } catch (e) {
        console.error('[uniForm] getTabularSectionsForTable error:', e && e.message);
        return [];
    }
}

const _beforeSaveTSRowHooks = new Map();

function registerBeforeSaveTSRow(parentTableName, hook) {
    if (typeof parentTableName !== 'string' || typeof hook !== 'function') {
        throw new Error('registerBeforeSaveTSRow: parentTableName (string) and hook (function) are required');
    }
    _beforeSaveTSRowHooks.set(parentTableName, hook);
}

// ── dispatchServerEvent ───────────────────────────────────────────────────────────────────────
async function dispatchServerEvent(eventName, payload, { tableName, sessionID }) {
    try {
        const layoutMemory = require('../../drive_root/layoutMemory');
        const serverScriptStore = require('../../drive_root/serverScriptStore');
        for (const appN of LAYOUT_APP_NAMES_RECORD) {
            if (!layoutMemory.hasRegistered(appN, tableName, 'record')) continue;
            const userRole = await layoutMemory.getUserRoleBySession(sessionID);
            const stored = await layoutMemory.getLayoutForUser(appN, tableName, userRole, sessionID, 'record');
            const binding = stored && stored.events && stored.events[eventName];
            if (!binding || !binding.serverScript) break;
            const entry = serverScriptStore.getServerScript(binding.serverScript, userRole || '*');
            const fn = entry && entry.scriptObj && entry.scriptObj[binding.fn || eventName];
            if (typeof fn === 'function') {
                await fn(payload, { sessionID });
                console.log(`[uniForm] server event "${eventName}" handled for ${tableName}`);
            }
            break;
        }
    } catch(e) {
        console.error(`[uniForm] event "${eventName}" dispatch error:`, e && e.message || e);
    }
}

// ── Автозаполнение: загрузка и применение дефолтов пользователя ──────────────────────────────

async function loadUserDefaultValues(sessionID) {
    try {
        const globalCtx = require('../../drive_root/globalServerContext');
        const user = await globalCtx.getUserBySessionID(sessionID);
        if (!user) return {};
        const Model = globalCtx.modelsDB && globalCtx.modelsDB.UserSettingsDefaults;
        if (!Model) return {};
        const rows = await Model.findAll({ where: { userId: user.UID }, raw: true });
        const map = {};
        for (const r of rows) {
            if (r.tableName && r.recordId) map[r.tableName] = { recordId: r.recordId, recordLabel: r.recordLabel || r.recordId };
        }
        return map;
    } catch (e) {
        console.error('[uniForm/loadUserDefaultValues] error:', e && e.message);
        return {};
    }
}

function applyAutofillFromFields(data, fields, defaultsMap) {
    for (const f of fields) {
        if (f.inputType !== 'recordSelector') continue;
        const targetTable = (f.foreignKey && f.foreignKey.table) ||
            (f.properties && f.properties.selection && f.properties.selection.table);
        if (!targetTable) continue;
        const def = defaultsMap[targetTable];
        if (!def) continue;
        const item = data.find(d => d.name === f.name);
        if (!item || item.value) continue;
        item.value = def.recordId;
        item.selection = { id: def.recordId, display: def.recordLabel };
    }
}

function applyAutofillFromLayout(data, layout, defaultsMap) {
    function walk(items) {
        if (!Array.isArray(items)) return;
        for (const item of items) {
            if (item.type === 'recordSelector' && item.data) {
                const sel = item.properties && item.properties.selection;
                const targetTable = sel && sel.table && !sel.table.includes('{') ? sel.table : null;
                if (targetTable) {
                    const def = defaultsMap[targetTable];
                    if (def) {
                        const dataItem = data.find(d => d.name === item.data);
                        if (dataItem && !dataItem.value) {
                            dataItem.value = def.recordId;
                            dataItem.selection = { id: def.recordId, display: def.recordLabel };
                        }
                    }
                }
            }
            if (item.layout) walk(item.layout);
        }
    }
    walk(Array.isArray(layout) ? layout : [layout]);
}

// ── generateFormSpec ──────────────────────────────────────────────────────────────────────────
async function generateFormSpec(tableName, params, sessionID) {
    try {
        if (!tableName) return { data: [], layout: [] };

        // Проверяем кастомный лейаут ДО загрузки модели (поддержка виртуальных таблиц)
        let customLayoutObj = null;
        let clientScript = null;
        let formIcon = null;
        let windowState = null;
        try {
            const layoutMemory = require('../../drive_root/layoutMemory');
            for (const appN of LAYOUT_APP_NAMES_RECORD) {
                if (!layoutMemory.hasRegistered(appN, tableName, 'record')) continue;
                const userRole = await layoutMemory.getUserRoleBySession(sessionID);
                customLayoutObj = await layoutMemory.getLayoutForUser(appN, tableName, userRole, sessionID, 'record');
                if (customLayoutObj) {
                    clientScript = customLayoutObj.clientScript || null;
                    formIcon = customLayoutObj.formIcon || null;
                    windowState = customLayoutObj.windowState || null;
                    break;
                }
            }
        } catch (e) {
            console.error('[uniForm/generateFormSpec] custom layout early check error:', e && e.message || e);
        }

        // onLoadData: данные загружает прикладной серверный скрипт
        if (customLayoutObj && customLayoutObj.events && customLayoutObj.events.onLoadData) {
            try {
                const serverScriptStore = require('../../drive_root/serverScriptStore');
                const layoutMemory = require('../../drive_root/layoutMemory');
                const userRole = await layoutMemory.getUserRoleBySession(sessionID);
                const binding = customLayoutObj.events.onLoadData;
                const entry = serverScriptStore.getServerScript(binding.serverScript, userRole || '*');
                const fn = entry && entry.scriptObj && entry.scriptObj[binding.fn || 'onLoadData'];
                if (typeof fn === 'function') {
                    const result = await fn({ tableName, params }, { sessionID });
                    const layout = JSON.parse(JSON.stringify(customLayoutObj.layout || []));
                    const data = (result && result.data) || [];
                    if (result && result.caption && layout[0]) layout[0].caption = result.caption;
                    // Автозаполнение для новых записей
                    if (!params || (!params.recordID && !params.recordId && !params.id)) {
                        const dfltMap = await loadUserDefaultValues(sessionID);
                        if (Object.keys(dfltMap).length > 0) applyAutofillFromLayout(data, layout, dfltMap);
                    }
                    const datasetId = dataApp.storeDataset({
                        layout, data, params: params || {},
                        table: tableName,
                        id: params && (params.recordID || params.recordId || params.id)
                    });
                    return { layout, data, datasetId, clientScript, formIcon, windowState };
                }
            } catch (e) {
                console.error('[uniForm/generateFormSpec] onLoadData dispatch error:', e && e.message || e);
            }
        }

        const fields = await buildTableFieldsFromModel(tableName);
        if (!Array.isArray(fields)) return { data: [], layout: [] };

        let record = null;
        const recordId = params && (params.recordID || params.recordId || params.id);

        try {
            const globalCtx = require('../../drive_root/globalServerContext');
            const modelName = globalCtx.getModelNameForTable(tableName) || tableName;
            const Model = (globalCtx.modelsDB || {})[modelName];
            if (Model && recordId !== undefined && recordId !== null) {
                const specDbGW = require('../../drive_root/dbGateway');
                record = await specDbGW.execute({ operation: 'findByPk', table: tableName, where: { UID: recordId }, options: { raw: true }, context: { appName: 'uniForm', sessionID } });
            }
        } catch (e) {
            console.error('[uniForm/generateFormSpec] globalCtx lookup error:', e && e.message || e);
        }

        const data = await Promise.all(fields.map(async f => {
            const typeKey = (f.type || '').toUpperCase();
            let defaultValue = null;
            if (typeKey === 'INTEGER' || typeKey === 'NUMBER') defaultValue = 0;
            else if (typeKey === 'BOOLEAN') defaultValue = false;
            else defaultValue = '';

            const item = {
                name: f.name,
                caption: f.caption || f.name,
                valueType: typeKey || 'STRING',
                editable: !!f.editable,
                value: defaultValue
            };

            if (record && Object.prototype.hasOwnProperty.call(record, f.name)) {
                item.value = record[f.name];
            }

            if (item.value != null && f.properties && f.properties.selection) {
                try {
                    const targetTable = f.properties.selection.table || (f.foreignKey && f.foreignKey.table);
                    const displayField = f.properties.selection.displayField || (f.foreignKey && f.foreignKey.displayField) || 'name';
                    if (targetTable) {
                        const fkDbGW = require('../../drive_root/dbGateway');
                        const trg = await fkDbGW.execute({ operation: 'findByPk', table: targetTable, where: { UID: item.value }, options: { raw: true }, context: { appName: 'uniForm', sessionID } });
                        if (trg) {
                            item.selection = { id: trg.UID, display: trg[displayField] || String(trg.UID) };
                        }
                    }
                } catch (e) { /* ignore FK resolution errors */ }
            }

            if (f.options) item.options = f.options;
            if (f.properties && !item.selection) item.properties = f.properties;
            return item;
        }));

        const controls = fields.map(f => {
            const ctrlType = mapInputTypeToControl(f.inputType || 'textbox');
            const ctrl = { type: ctrlType, name: f.name, data: f.name, caption: f.caption || f.name };
            if (f.properties) ctrl.properties = f.properties;
            if (f.options) ctrl.options = f.options;
            return ctrl;
        });

        let layout;
        if (customLayoutObj) {
            layout = JSON.parse(JSON.stringify(customLayoutObj.layout || customLayoutObj));
        }

        // Pre-генерация UID для новой записи
        let effectiveRecordId = recordId;
        let isNew = false;
        if (!effectiveRecordId) {
            isNew = true;
            try {
                const globalCtxForUID = require('../../drive_root/globalServerContext');
                const modelNameForUID = globalCtxForUID.getModelNameForTable(tableName) || tableName;
                if (_util && typeof _util.generateUID === 'function') {
                    effectiveRecordId = _util.generateUID(modelNameForUID);
                } else {
                    const time = Date.now().toString(36).padStart(9, '0').slice(-9);
                    const random = require('crypto').randomBytes(6).readUIntBE(0, 6).toString(36).padStart(7, '0').slice(-7);
                    effectiveRecordId = `${time}-0000000-${random}`;
                }
                const uidField = data.find(d => d.name === 'UID');
                if (uidField) uidField.value = effectiveRecordId;
            } catch(e) {
                console.error('[uniForm/generateFormSpec] UID pre-generation failed:', e && e.message);
            }
        }

        // Автозаполнение для новых записей
        if (isNew) {
            const dfltMap = await loadUserDefaultValues(sessionID);
            if (Object.keys(dfltMap).length > 0) applyAutofillFromFields(data, fields, dfltMap);
        }

        if (!layout) {
            layout = [
                { type: 'commandBar' },
                { type: 'group', caption: tableName, orientation: 'vertical', layout: controls }
            ];

            // Автоматические табличные части
            try {
                const tsDefs = getTabularSectionsForTable(tableName);
                if (tsDefs.length > 0) {
                    const tsLayoutItems = [];
                    for (const tsDef of tsDefs) {
                        const tsTableName = tsDef.tableName;
                        const tsParentField = tsDef.tabularSection && tsDef.tabularSection.parentField;
                        if (!tsTableName || !tsParentField) continue;

                        let tsRows = [];
                        if (effectiveRecordId && !isNew) {
                            try {
                                const tsDbGW = require('../../drive_root/dbGateway');
                                const fetched = await tsDbGW.execute({
                                    operation: 'read', table: tsTableName, where: { [tsParentField]: effectiveRecordId },
                                    options: { raw: true }, context: { appName: 'uniForm', sessionID }
                                });
                                if (Array.isArray(fetched)) tsRows = fetched;
                            } catch (e) {
                                console.error('[uniForm/generateFormSpec] TS load error for', tsTableName, ':', e && e.message);
                            }
                        }

                        let tsColumns = [];
                        let tsFkFields = [];
                        try {
                            const tsFields = await buildTableFieldsFromModel(tsTableName);
                            if (Array.isArray(tsFields)) {
                                tsColumns = tsFields
                                    .filter(f => f.name !== tsParentField && f.name !== 'UID')
                                    .map(f => {
                                        const col = {
                                            caption: f.caption || f.name,
                                            data: f.name,
                                            width: f.width || 120,
                                            inputType: mapInputTypeToControl(f.inputType || 'textbox')
                                        };
                                        if (f.properties) col.properties = f.properties;
                                        if (f.foreignKey) col.foreignKey = f.foreignKey;
                                        return col;
                                    });
                                tsFkFields = tsFields.filter(f =>
                                    f.name !== tsParentField && f.name !== 'UID' &&
                                    f.foreignKey && f.foreignKey.table
                                );
                            }
                        } catch (e) {
                            console.error('[uniForm/generateFormSpec] TS fields error for', tsTableName, ':', e && e.message);
                        }

                        // Резолвим FK display-значения в строках ТЧ
                        if (tsRows.length > 0 && tsFkFields.length > 0) {
                            try {
                                const resolveDbGW = require('../../drive_root/dbGateway');
                                for (const fkField of tsFkFields) {
                                    const fkTable = fkField.foreignKey.table;
                                    const fkIdField = fkField.foreignKey.field || 'UID';
                                    const fkDispField = fkField.foreignKey.displayField || 'name';
                                    const fkValues = [...new Set(tsRows.map(r => r[fkField.name]).filter(v => v !== null && v !== undefined && v !== ''))];
                                    if (fkValues.length === 0) continue;
                                    try {
                                        const lookupRows = await resolveDbGW.execute({
                                            operation: 'read', table: fkTable, where: { [fkIdField]: fkValues },
                                            options: { raw: true }, context: { appName: 'uniForm', sessionID }
                                        });
                                        if (Array.isArray(lookupRows)) {
                                            const dispMap = {};
                                            for (const lr of lookupRows) dispMap[lr[fkIdField]] = lr[fkDispField] || lr[fkIdField];
                                            const dispKey = '__' + fkField.name + '_display';
                                            for (const row of tsRows) {
                                                if (row[fkField.name] !== undefined && row[fkField.name] !== null) {
                                                    row[dispKey] = dispMap[row[fkField.name]] || row[fkField.name];
                                                }
                                            }
                                        }
                                    } catch (e) {
                                        console.warn('[uniForm/generateFormSpec] FK resolve error for', fkField.name, ':', e && e.message);
                                    }
                                }
                            } catch (e) {
                                console.warn('[uniForm/generateFormSpec] TS FK resolve outer error:', e && e.message);
                            }
                        }

                        const dataKey = '__ts_' + tsTableName;
                        data.push({
                            name: dataKey, value: tsRows, tabularSection: true,
                            tableName: tsTableName, parentField: tsParentField
                        });

                        const tsName = 'ts_' + tsTableName;
                        const tsCaption = (tsDef.tabularSection && tsDef.tabularSection.caption) || tsDef.name || tsTableName;
                        tsLayoutItems.push({
                            type: 'group', caption: tsCaption, orientation: 'vertical',
                            layout: [{
                                type: 'table', name: tsName, data: dataKey,
                                columns: tsColumns,
                                properties: { editMode: 'cell-immediate', visibleRows: 5 }
                            }]
                        });
                    }

                    if (tsLayoutItems.length > 0) {
                        const actionsIdx = layout.findIndex(item =>
                            item.type === 'group' && Array.isArray(item.layout) && item.layout.some(i => i.action === 'save')
                        );
                        const insertIdx = actionsIdx >= 0 ? actionsIdx : layout.length;
                        if (tsLayoutItems.length === 1) {
                            layout.splice(insertIdx, 0, tsLayoutItems[0]);
                        } else {
                            layout.splice(insertIdx, 0, {
                                type: 'tabs',
                                tabs: tsLayoutItems.map(item => ({ caption: item.caption, layout: [item] }))
                            });
                        }
                    }
                }
            } catch (e) {
                console.error('[uniForm/generateFormSpec] tabular sections error:', e && e.message || e);
            }
        }

        // tabularFilter: декларативная загрузка данных для table-элементов
        try {
            const collectTableItems = (items) => {
                const result = [];
                if (!Array.isArray(items)) return result;
                for (const item of items) {
                    if (!item) continue;
                    if (item.type === 'table' && item.properties && item.properties.tabularFilter && item.data) result.push(item);
                    if (item.layout) result.push(...collectTableItems(item.layout));
                    if (item.tabs) { for (const tab of item.tabs) { if (tab.layout) result.push(...collectTableItems(tab.layout)); } }
                }
                return result;
            };
            const tableItemsWithFilter = collectTableItems(layout);
            for (const item of tableItemsWithFilter) {
                if (data.find(d => d.name === item.data)) continue;
                const targetTable = item.data;
                const rawFilter = item.properties.tabularFilter;
                const resolvedFilter = {};
                for (const [k, v] of Object.entries(rawFilter)) {
                    if (typeof v === 'string') {
                        resolvedFilter[k] = v
                            .replace(/\{UID\}/g, effectiveRecordId || '')
                            .replace(/\{(\w+)\}/g, (_, fn) => (record && record[fn] !== undefined ? record[fn] : ''));
                    } else {
                        resolvedFilter[k] = v;
                    }
                }
                let rows = [];
                if (effectiveRecordId && !isNew) {
                    try {
                        const tblDbGW = require('../../drive_root/dbGateway');
                        const fetched = await tblDbGW.execute({
                            operation: 'read', table: targetTable, where: resolvedFilter,
                            options: { raw: true }, context: { appName: 'uniForm', sessionID }
                        });
                        if (Array.isArray(fetched)) rows = fetched;
                    } catch (e) {
                        console.error('[uniForm/generateFormSpec] tabularFilter load error for', targetTable, ':', e && e.message);
                    }
                }
                if (rows.length > 0) {
                    try {
                        const tfFields = await buildTableFieldsFromModel(targetTable);
                        const tfFkFields = Array.isArray(tfFields) ? tfFields.filter(f => f.foreignKey && f.foreignKey.table) : [];
                        for (const fkField of tfFkFields) {
                            const fkTable = fkField.foreignKey.table;
                            const fkIdField = fkField.foreignKey.field || 'UID';
                            const fkDispField = fkField.foreignKey.displayField || 'name';
                            const fkValues = [...new Set(rows.map(r => r[fkField.name]).filter(v => v != null && v !== ''))];
                            if (fkValues.length === 0) continue;
                            try {
                                const fkDbGW = require('../../drive_root/dbGateway');
                                const lookupRows = await fkDbGW.execute({
                                    operation: 'read', table: fkTable, where: { [fkIdField]: fkValues },
                                    options: { raw: true }, context: { appName: 'uniForm', sessionID }
                                });
                                if (Array.isArray(lookupRows)) {
                                    const dispMap = {};
                                    for (const lr of lookupRows) dispMap[lr[fkIdField]] = lr[fkDispField] || lr[fkIdField];
                                    const dispKey = '__' + fkField.name + '_display';
                                    for (const row of rows) {
                                        if (row[fkField.name] != null) row[dispKey] = dispMap[row[fkField.name]] || row[fkField.name];
                                    }
                                }
                            } catch (e) {
                                console.warn('[uniForm/generateFormSpec] tabularFilter FK resolve error:', fkField.name, e && e.message);
                            }
                        }
                    } catch (e) {
                        console.warn('[uniForm/generateFormSpec] tabularFilter FK resolve outer error:', e && e.message);
                    }
                }
                data.push({ name: item.data, value: rows, tabularSection: true, tableName: targetTable });
            }
        } catch (e) {
            console.error('[uniForm/generateFormSpec] tabularFilter scan error:', e && e.message || e);
        }

        const datasetId = dataApp.storeDataset({
            table: tableName, id: effectiveRecordId, isNew: isNew,
            params: params, time: Date.now()
        });

        if (!formIcon) {
            const layoutMemory2 = require('../../drive_root/layoutMemory');
            formIcon = layoutMemory2.getTableIcon(tableName) || '/apps/general_icons/resources/public/16x16/catalog.png';
        }

        return { data, layout, datasetId, clientScript, formIcon, windowState };
    } catch (e) {
        console.error('[uniForm/generateFormSpec] failed:', e && e.message || e);
        return { data: [], layout: [] };
    }
}

// ── Google Places config — exposes API key to authorised browser clients ─────────────────────
async function getPlacesConfig(params, sessionID) {
    const user = await globalServerContext.getUserBySessionID(sessionID);
    if (!user) throw new Error('User not authorized');
    return { apiKey: process.env.GOOGLE_PLACES_API_KEY || '' };
}

// ── Quick search for recordSelector typeahead ─────────────────────────────────────────────────
async function quickSearch({ tableName, searchText, limit }, sessionID) {
    const user = await globalServerContext.getUserBySessionID(sessionID);
    if (!user) throw new Error('User not authorized');

    const modelName = globalServerContext.getModelNameForTable(tableName);
    if (!modelName) throw new Error('Unknown table: ' + tableName);

    const dbGW = require('../../drive_root/dbGateway');
    const { Op } = require('sequelize');

    const safeText = String(searchText || '').replace(/[%_\\]/g, c => '\\' + c);
    const lim = Math.max(1, Math.min(limit || 10, 20));

    // Determine display field (prefer 'name', fallback to first string attribute, then 'UID')
    let displayField = 'name';
    try {
        const gsCtx = globalServerContext;
        const models = gsCtx.getModels ? gsCtx.getModels() : null;
        if (models && models[modelName]) {
            const attrs = models[modelName].rawAttributes || {};
            if (!attrs['name']) {
                displayField = Object.keys(attrs).find(k => {
                    try {
                        const t = attrs[k].type ? (attrs[k].type.key || attrs[k].type.constructor.key) : '';
                        return t === 'STRING';
                    } catch (e) { return false; }
                }) || 'UID';
            }
        }
    } catch (e) { /* use 'name' as default */ }

    const rows = await dbGW.execute({
        operation: 'read',
        table: tableName,
        where: { [displayField]: { [Op.iLike]: `%${safeText}%` } },
        options: {
            attributes: ['UID', displayField],
            limit: lim,
            order: [[displayField, 'ASC']],
            raw: true
        },
        context: { sessionID }
    });

    const items = (Array.isArray(rows) ? rows : []).map(r => ({ UID: r.UID, name: r[displayField] || '' }));
    return { items };
}

module.exports = {
    getData,
    getLayoutWithData,
    applyChanges,
    generateFormSpec,
    registerBeforeSaveTSRow,
    quickSearch,
    getPlacesConfig,

    // Dynamic table helpers
    getDynamicTableData: dynamicTableMethods.getDynamicTableData,
    getLookupList: dynamicTableMethods.getLookupList,
    subscribeToTable: dynamicTableMethods.subscribeToTable,
    saveClientState: dynamicTableMethods.saveClientState,
    recordTableEdit: dynamicTableMethods.recordTableEdit,
    commitTableEdits: dynamicTableMethods.commitTableEdits
};
