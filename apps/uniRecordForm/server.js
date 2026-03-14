const crypto = require('crypto');

// Use the generic framework memory store (namespace: 'datasets')
const memoryStore = require('../../drive_root/memory_store');
const { dataApp } = require('../../drive_forms/dataApp');
const { read } = require('fs');
const config = require('./config.json');
const globalServerContext = require('../../drive_root/globalServerContext');
try { const dbg = memoryStore.debugKeysSync('datasets'); console.log('[recordEditor] memoryStore init; datasetsCount=', dbg.count); } catch (e) {}

// use shared.storeDataset for dataset persistence

function getData(params) {
    // params may contain opening options; for now we ignore them
    // but keep the signature so callers can pass menu params.
    let data = [];
    return data;
}



function getLayout(params) {
    // params may be used to customise layout depending on how app is opened
    let layout = [
        {
            type: 'table',
            caption: 'Организации (БД)',
            // dynamicTable true signals client to construct a DynamicTable bound to a server table
            properties: { dynamicTable: true, appName: config.name, tableName: params.tableName, visibleRows: 10, editable: true, showToolbar: true, initialSort: [{ field: 'name', order: 'asc' }] }
        }
    ];

    return layout;
}

async function getLayoutWithData(params) {
    // Return layout and data together for atomic loading
    try {
        // If caller requested a tableName, prefer the generated form spec (async)
        if (params && params.tableName) {
            try {
                const spec = await generateFormSpec(params.tableName, params);
                const datasetId = spec.datasetId || dataApp.storeDataset({ 
                    layout: spec.layout || [], 
                    data: spec.data || [], 
                    params: params || {},
                    table: params.tableName,
                    id: params.recordID || params.recordId || params.id
                });
                return { layout: spec.layout, data: spec.data, datasetId };
            } catch (e) {
                // fallthrough to default behaviour on error
                console.error('[uniRecordForm/getLayoutWithData] generateFormSpec error:', e && e.message || e);
            }
        }

        const layout = getLayout(params);
        const data = getData(params);
        // Store the returned payload in server memory and expose a datasetId
        const payload = { 
            layout: layout || [], 
            data: data || [], 
            params: params || {},
            table: params && (params.tableName || params.table),
            id: params && (params.recordID || params.recordId || params.id)
        };
        const datasetId = dataApp.storeDataset(payload);
        return { layout: payload.layout, data: payload.data, datasetId };
    } catch (e) {
        return { layout: [], data: [], datasetId: null };
    }
}

async function applyChanges(datasetId, changes) {
    try {
        console.log('[uniRecordForm] applyChanges called.');
        if (datasetId && typeof datasetId === 'object' && (datasetId.datasetId !== undefined || datasetId.changes !== undefined)) {
            const payload = datasetId;
            datasetId = payload.datasetId;
            changes = payload.changes;
        }

        console.log('[uniRecordForm] incoming datasetId=', datasetId, 'changes=', JSON.stringify(changes));

        let dsObj = null;
        try {
            dsObj = await dataApp.getDataset(datasetId);
            console.log('[uniRecordForm] dataset present=', !!dsObj);
        } catch (e) { console.log('[uniRecordForm] dataset retrieval error', e); }

        if (!datasetId) {
            return { ok: false, error: 'missing datasetId' };
        } else if (!dsObj) {
            return { ok: false, error: 'unknown datasetId: ' + datasetId };
        }

        const tableName = dsObj.table || (dsObj.params && (dsObj.params.tableName || dsObj.params.table));
        const recordId = dsObj.id || (dsObj.params && (dsObj.params.recordID || dsObj.params.recordId || dsObj.params.id));

        if (!tableName) {
            return { ok: false, error: 'No table context found in dataset' };
        }

        const modelName = globalServerContext.getModelNameForTable(tableName) || tableName;
        const Model = globalServerContext.modelsDB[modelName];

        if (!Model) {
            return { ok: false, error: 'Model not found for table: ' + tableName + ' (model: ' + modelName + ')' };
        }

        const applyDbGW = require('../../drive_root/dbGateway');
        if (recordId) {
            // Update existing record
            console.log(`[uniRecordForm] Updating ${tableName} UID=${recordId} with`, changes);
            await applyDbGW.execute({ operation: 'update', table: tableName, data: changes, where: { UID: recordId }, context: { appName: 'uniRecordForm' } });
        } else {
            // Create new record
            console.log(`[uniRecordForm] Creating new ${tableName} with`, changes);
            await applyDbGW.execute({ operation: 'create', table: tableName, data: changes, context: { appName: 'uniRecordForm' } });
        }
        return { ok: true };
    } catch (e) {
        console.error('[uniRecordForm] applyChanges error:', e);
        return { ok: false, error: String(e) };
    }
}

const { registerDynamicTableMethods } = require('../../drive_forms/dynamicTableRegistry');

// Регистрация стандартных методов для работы с таблицами (копия конфигурации из apps/organizations)
// Поддерживаем функцию-резолверы для `tables` и `tableFields`, чтобы они могли
// возвращать разные конфигурации в зависимости от входных `params`.
// Helper to build field definitions based on opening params
function buildTableFields(params) {
    const tableName = params && (params.tableName || params.tableName || params.table);
    if (!tableName) return null;
    return buildTableFieldsFromModel(tableName);
}

// Build table fields from global model metadata (async helper)
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
            else if (typeKey === 'INTEGER') inputType = (f.name === 'id') ? 'number' : 'number';
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
        console.error('[uniListForm/buildTableFieldsFromModel] metadata build failed:', e && e.message || e);
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
    if (t === 'recordselector' || t === 'recordSelector') return 'recordSelector';
    if (t === 'textarea' || t === 'text') return 'textarea';
    if (t === 'enum' || t === 'emunlist' || t === 'emunList') return 'emunList';
    return 'textbox';
}

// Автоматическая функция: по имени таблицы возвращает объекты `data` и `layout`
// Параметр: tableName (string)
// Возвращает: { data: Array, layout: Array }
// params may include { recordID }
async function generateFormSpec(tableName, params) {
    console.log('[generateFormSpec] called with tableName:', tableName, 'params:', params);
    try {
        if (!tableName) return { data: [], layout: [] };
        const fields = await buildTableFieldsFromModel(tableName);
        if (!Array.isArray(fields)) return { data: [], layout: [] };

        // Attempt to load record by ID if provided
        let record = null;
        const recordId = params && (params.recordID || params.recordId || params.id);

        try {
            // Get globalCtx
            const globalCtx = require('../../drive_root/globalServerContext');
            
            const modelName = globalCtx.getModelNameForTable(tableName) || tableName;
            console.log('[generateFormSpec] modelName:', modelName);
            const models = globalCtx.modelsDB || {};
            console.log('[generateFormSpec] available models:', Object.keys(models));
            const Model = models[modelName];
            console.log('[generateFormSpec] Model found:', !!Model);
            console.log('[generateFormSpec] recordId extracted:', recordId);
            if (Model && recordId !== undefined && recordId !== null) {
                try {
                    console.log('[generateFormSpec] Fetching record with id:', recordId);
                    const specDbGW = require('../../drive_root/dbGateway');
                    record = await specDbGW.execute({ operation: 'findByPk', table: tableName, where: { UID: recordId }, options: { raw: true }, context: { appName: 'uniRecordForm' } });
                    console.log('[generateFormSpec] Fetched record:', record);
                } catch (e) {
                    console.error('[generateFormSpec] Model.findByPk error:', e && e.message || e);
                    record = null;
                }
            } else {
                console.log('[generateFormSpec] Skipping record fetch. Model:', !!Model, 'recordId:', recordId);
            }
        } catch (e) {
            // ignore lookup errors and proceed with defaults
            console.error('[generateFormSpec] globalCtx lookup error:', e && e.message || e);
        }

        const data = await Promise.all(fields.map(async f => {
            const typeKey = (f.type || '').toUpperCase();
            let defaultValue = null;
            if (typeKey === 'INTEGER' || typeKey === 'NUMBER') defaultValue = 0;
            else if (typeKey === 'BOOLEAN') defaultValue = false;
            else if (typeKey === 'DATE' || typeKey === 'DATEONLY') defaultValue = null;
            else defaultValue = '';

            const item = {
                name: f.name,
                caption: f.caption || f.name,
                valueType: typeKey || 'STRING',
                editable: !!f.editable,
                value: defaultValue
            };

            // If we have a record, populate the value
            if (record && Object.prototype.hasOwnProperty.call(record, f.name)) {
                item.value = record[f.name];
            }

            // Resolve FK display if selection metadata present
            if (item.value != null && f.properties && f.properties.selection) {
                try {
                    const globalCtx = require('../../drive_root/globalServerContext');
                    const targetTable = f.properties.selection.table || f.properties.selection.tableName || f.foreignKey && f.foreignKey.table;
                    const displayField = f.properties.selection.displayField || f.foreignKey && f.foreignKey.displayField || 'name';
                    if (targetTable) {
                        const fkDbGW = require('../../drive_root/dbGateway');
                        const trg = await fkDbGW.execute({ operation: 'findByPk', table: targetTable, where: { UID: item.value }, options: { raw: true }, context: { appName: 'uniRecordForm' } });
                        if (trg) {
                            // Provide selection object for recordSelector controls
                            item.selection = { id: trg.UID, display: trg[displayField] || String(trg.UID) };
                        }
                    }
                } catch (e) {
                    // ignore FK resolution errors
                }
            }

            if (f.options) item.options = f.options;
            if (f.properties && !item.selection) item.properties = f.properties;
            return item;
        }));

        const controls = fields.map(f => {
            const ctrlType = mapInputTypeToControl(f.inputType || f.input || 'textbox');
            const ctrl = { type: ctrlType, name: f.name, data: f.name, caption: f.caption || f.name };
            if (f.properties) ctrl.properties = f.properties;
            if (f.options) ctrl.options = f.options;
            return ctrl;
        });

        const layout = [
            { type: 'group', caption: tableName, orientation: 'vertical', layout: controls },
            { type: 'group', caption: 'Действия', orientation: 'horizontal', layout: [ { type: 'button', action: 'save', caption: 'Сохранить' }, { type: 'button', action: 'cancel', caption: 'Отмена' } ] }
        ];

        const datasetId = dataApp.storeDataset({
            table: tableName,
            id: recordId,
            params: params,
            time: Date.now()
        });

        return { data, layout, datasetId };
    } catch (e) {
        console.error('[uniRecordForm/generateFormSpec] failed:', e && e.message || e);
        return { data: [], layout: [] };
    }
}
// Helper to resolve model name (table -> model) based on params
function buildTableModel(params) {
    const tableName = params && (params.tableName || params.tableName || params.table);
    if (!tableName) return null;
    if (tableName === 'organizations') { return 'Organizations'; }
    if (tableName === 'users') { return 'Users'; }
    if (tableName === 'accommodation_types') { return 'AccommodationTypes'; }
    return null;
}
const dynamicTableMethods = registerDynamicTableMethods('recordEditor', {
    // Маппинг таблиц на модели — может быть функцией или объектом
    // Resolver signature: (params) => modelName
    tables: (params) => {
        const tableName = params && (params.tableName || params.tableName || params.table);
        const map = {
            'organizations': 'Organizations',
            'users': 'Users',
            'accommodation_types': 'AccommodationTypes'
        };
        // Example: allow overriding via params (if params.sourceModel)
        if (params && params.sourceModel && tableName && map[tableName]) {
            return params.sourceModel;
        }
        return tableName ? map[tableName] : null;
    },

    // Конфигурация полей для каждой таблицы (может быть функцией)
    tableFields: (params) => {
        // Delegate to builder so caller can later call separate assembler if needed
        return buildTableFields(params);
    },

    // Опциональная проверка доступа
    accessCheck: async (user, tableName, action) => {
        return true;
    }
});

module.exports = {
    getLayout,
    getData,
    getLayoutWithData,
    applyChanges,
    // Возвращает спецификацию формы по имени таблицы
    generateFormSpec,

    // Dynamic table helpers used by UI controls (preload/dropdowns etc.)
    getDynamicTableData: dynamicTableMethods.getDynamicTableData,
    getLookupList: dynamicTableMethods.getLookupList,
    subscribeToTable: dynamicTableMethods.subscribeToTable,
    saveClientState: dynamicTableMethods.saveClientState,
    recordTableEdit: dynamicTableMethods.recordTableEdit,
    commitTableEdits: dynamicTableMethods.commitTableEdits
};