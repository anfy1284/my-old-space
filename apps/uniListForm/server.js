const crypto = require('crypto');

// Use the generic framework memory store (namespace: 'datasets')
const memoryStore = require('../../drive_root/memory_store');
const { dataApp } = require('../../drive_forms/dataApp');
const { read } = require('fs');
const config = require('./config.json');
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
        { type: 'group', caption: 'Действия', orientation: 'horizontal', layout: [ { type: 'button', action: 'select', caption: 'Выбрать' }, { type: 'button', action: 'cancel', caption: 'Отмена' }, { type: 'button', action: 'recordOpen', caption: 'Открыть' } ] },
        {           
            type: 'table',
            caption: 'Организации (БД)',
            // dynamicTable true signals client to construct a DynamicTable bound to a server table
            properties: { dynamicTable: true, readOnly: true, appName: config.name, tableName: params.tableName, visibleRows: 10, editable: true, showToolbar: true, initialSort: [{ field: 'name', order: 'asc' }] }
        }
    ];

    return layout;
}

function getLayoutWithData(params) {
    // Return layout and data together for atomic loading
    try {
        const layout = getLayout(params);
        const data = getData(params);
        // Store the returned payload in server memory and expose a datasetId
        const payload = { layout: layout || [], data: data || [], params: params || {} };
        const datasetId = dataApp.storeDataset(payload);
        return { layout: payload.layout, data: payload.data, datasetId };
    } catch (e) {
        return { layout: [], data: [], datasetId: null };
    }
}

async function applyChanges(datasetId, changes) {
    try {
        console.log('[recordEditor] applyChanges called. process.pid=', process && process.pid ? process.pid : 'no-pid', 'module.id=', module && module.id ? module.id : 'no-module-id');
        // Accept RPC that may pass params object as first argument (framework passes params and sessionID separately)
        // If the first argument looks like a payload object, unpack it.
        if (datasetId && typeof datasetId === 'object' && (datasetId.datasetId !== undefined || datasetId.changes !== undefined)) {
            const payload = datasetId;
            datasetId = payload.datasetId;
            changes = payload.changes;
        }

        try {
            const dbg = memoryStore.debugKeysSync ? memoryStore.debugKeysSync('datasets') : { count: 0, keys: [] };
            console.log('[recordEditor] memoryStore datasets count=', dbg.count, 'keysSample=', dbg.keys);
        } catch (e) { console.log('[recordEditor] memoryStore inspect error', e); }
        console.log('[recordEditor] incoming datasetId=', datasetId);

        let dsObj = null;
        try {
            // Delegate dataset retrieval to dataApp helper (handles sync/async store backends)
            dsObj = await dataApp.getDataset(datasetId);
            console.log('[recordEditor] dataset present=', !!dsObj);
        } catch (e) { console.log('[recordEditor] dataset presence check error', e); }

        console.log('[recordEditor] changes payload keys=', changes && typeof changes === 'object' ? Object.keys(changes) : typeof changes);
        // For now, only log changes. In future this should validate and apply to stored dataset.
        if (!datasetId) {
            console.warn('[recordEditor] applyChanges: missing datasetId');
        } else if (!dsObj) {
            console.warn('[recordEditor] applyChanges: unknown datasetId', datasetId);
        }
        return { ok: true };
    } catch (e) {
        console.error('[recordEditor] applyChanges error:', e);
        return { ok: false, error: String(e) };
    }
}

const { registerDynamicTableMethods } = require('../../drive_forms/dynamicTableRegistry');

// Регистрация стандартных методов для работы с таблицами (копия конфигурации из apps/organizations)
// Поддерживаем функцию-резолверы для `tables` и `tableFields`, чтобы они могли
// возвращать разные конфигурации в зависимости от входных `params`.
// Helper to build field definitions based on opening params
function buildTableFields(params) {
    const tableName = params && (params.tableName || params.dbTable || params.table);
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
                    selection: { table: f.foreignKey.table, idField: f.foreignKey.field || 'id', displayField: f.foreignKey.displayField || 'name' },
                    showSelectionButton: true,
                    listMode: true,
                    listSource: { app: config.name, table: f.foreignKey.table, idField: f.foreignKey.field || 'id', displayField: f.foreignKey.displayField || 'name', limit: 50 }
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
// Helper to resolve model name (table -> model) based on params
function buildTableModel(params) {
    const tableName = params && (params.tableName || params.dbTable || params.table);
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
        const tableName = params && (params.tableName || params.dbTable || params.table);
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

    // Dynamic table helpers used by UI controls (preload/dropdowns etc.)
    getDynamicTableData: dynamicTableMethods.getDynamicTableData,
    getLookupList: dynamicTableMethods.getLookupList,
    subscribeToTable: dynamicTableMethods.subscribeToTable,
    saveClientState: dynamicTableMethods.saveClientState,
    recordTableEdit: dynamicTableMethods.recordTableEdit,
    commitTableEdits: dynamicTableMethods.commitTableEdits
};