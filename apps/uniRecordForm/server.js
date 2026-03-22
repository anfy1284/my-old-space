const crypto = require('crypto');

// Use the generic framework memory store (namespace: 'datasets')
const memoryStore = require('../../drive_root/memory_store');

// UID generation utility
let _util = null;
try { _util = require('../../drive_root/db/utilites'); } catch(e) { console.warn('[uniRecordForm] util load failed:', e && e.message); }
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

async function getLayoutWithData(params, sessionID) {
    // Return layout and data together for atomic loading
    try {
        // If caller requested a tableName, prefer the generated form spec (async)
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

async function applyChanges(payload, sessionID) {
    let datasetId = payload;
    let changes = null;
    try {
        console.log('[uniRecordForm] applyChanges called.');
        if (payload && typeof payload === 'object' && (payload.datasetId !== undefined || payload.changes !== undefined)) {
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

        // Извлекаем данные табличных частей из changes до сохранения основной записи
        let tabularSectionsData = null;
        if (changes && typeof changes.__tabularSections === 'object' && changes.__tabularSections !== null) {
            tabularSectionsData = changes.__tabularSections;
            changes = Object.assign({}, changes);
            delete changes.__tabularSections;
        }

        const parentUID = recordId;
        if (recordId && !dsObj.isNew) {
            // Update existing record
            console.log(`[uniRecordForm] Updating ${tableName} UID=${recordId} with`, changes);
            await applyDbGW.execute({ operation: 'update', table: tableName, data: changes, where: { UID: recordId }, context: { appName: 'uniRecordForm', sessionID } });
        } else {
            // Create new record
            // Если запись новая и UID был заранее сгенерирован — передаём его в changes
            // чтобы dbGateway не перегенерировал (условие if (!data.UID) в executor)
            if (dsObj.isNew && recordId && !changes.UID) {
                changes = Object.assign({}, changes, { UID: recordId });
            }
            console.log(`[uniRecordForm] Creating new ${tableName} with`, changes);
            await applyDbGW.execute({ operation: 'create', table: tableName, data: changes, context: { appName: 'uniRecordForm', sessionID } });
        }

        // Сохраняем табличные части (стратегия: DELETE по фильтру родителя + INSERT текущих строк)
        if (tabularSectionsData && parentUID) {
            const tsDefs = getTabularSectionsForTable(tableName);
            for (const [sectionTableName, rows] of Object.entries(tabularSectionsData)) {
                try {
                    const tsDef = tsDefs.find(d => d.tableName === sectionTableName);
                    if (!tsDef) {
                        console.warn('[uniRecordForm] tabularSection def not found for:', sectionTableName);
                        continue;
                    }
                    const parentField = tsDef.tabularSection.parentField;

                    // Удаляем все строки ТЧ данного родителя
                    await applyDbGW.execute({
                        operation: 'delete',
                        table: sectionTableName,
                        where: { [parentField]: parentUID },
                        context: { appName: 'uniRecordForm', sessionID }
                    });

                    // Вставляем текущие строки
                    if (Array.isArray(rows)) {
                        for (const row of rows) {
                            const rowData = Object.assign({}, row);
                            delete rowData.UID; // Сервер сгенерирует новый UID
                            rowData[parentField] = parentUID;
                            // Наследуем поля родительской записи, которых нет в строке ТЧ
                            // или которые остались пустыми (напр. organizationId обязателен,
                            // но не редактируется пользователем в ТЧ — пустая строка по умолчанию).
                            if (changes && typeof changes === 'object') {
                                for (const [k, v] of Object.entries(changes)) {
                                    if (k !== 'UID' && k !== parentField) {
                                        const cur = rowData[k];
                                        if (cur === undefined || cur === null || cur === '') {
                                            rowData[k] = v;
                                        }
                                    }
                                }
                            }
                            await applyDbGW.execute({
                                operation: 'create',
                                table: sectionTableName,
                                data: rowData,
                                context: { appName: 'uniRecordForm', sessionID }
                            });
                        }
                    }
                    console.log(`[uniRecordForm] TS saved: ${sectionTableName}, rows: ${Array.isArray(rows) ? rows.length : 0}`);
                } catch (e) {
                    console.error('[uniRecordForm] TS save error for', sectionTableName, ':', e && e.message || e);
                }
            }
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

// Helper: найти все модели-определения, являющиеся табличными частями указанной родительской таблицы.
// Определение ТЧ: в db.json у модели должно быть поле tabularSection: { parentTable, parentField, caption? }.
function getTabularSectionsForTable(parentTableName) {
    try {
        const globalCtx = require('../../drive_root/globalServerContext');
        const { models } = globalCtx.collectAllModelDefs();
        return (models || []).filter(def =>
            def.tabularSection &&
            def.tabularSection.parentTable === parentTableName
        );
    } catch (e) {
        console.error('[uniRecordForm] getTabularSectionsForTable error:', e && e.message);
        return [];
    }
}

// Автоматическая функция: по имени таблицы возвращает объекты `data` и `layout`
// Параметр: tableName (string)
// Возвращает: { data: Array, layout: Array }
// params may include { recordID }
async function generateFormSpec(tableName, params, sessionID) {
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
                    record = await specDbGW.execute({ operation: 'findByPk', table: tableName, where: { UID: recordId }, options: { raw: true }, context: { appName: 'uniRecordForm', sessionID } });
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
                        const trg = await fkDbGW.execute({ operation: 'findByPk', table: targetTable, where: { UID: item.value }, options: { raw: true }, context: { appName: 'uniRecordForm', sessionID } });
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

        // Для новой записи генерируем UID заранее и включаем его в данные формы
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
                console.log('[generateFormSpec] New record, pre-generated UID:', effectiveRecordId);
                // Вставляем UID в данные формы (поле UID)
                const uidField = data.find(d => d.name === 'UID');
                if (uidField) uidField.value = effectiveRecordId;
            } catch(e) {
                console.error('[generateFormSpec] UID pre-generation failed:', e && e.message);
            }
        }

        // ========================
        // ТАБЛИЧНЫЕ ЧАСТИ (Tabular Sections)
        // ========================
        try {
            const tsDefs = getTabularSectionsForTable(tableName);
            if (tsDefs.length > 0) {
                const tsLayoutItems = [];
                for (const tsDef of tsDefs) {
                    const tsTableName = tsDef.tableName;
                    const tsParentField = tsDef.tabularSection && tsDef.tabularSection.parentField;
                    if (!tsTableName || !tsParentField) continue;

                    // Загружаем строки ТЧ (только для существующей записи)
                    let tsRows = [];
                    if (effectiveRecordId && !isNew) {
                        try {
                            const tsDbGW = require('../../drive_root/dbGateway');
                            const fetched = await tsDbGW.execute({
                                operation: 'read',
                                table: tsTableName,
                                where: { [tsParentField]: effectiveRecordId },
                                options: { raw: true },
                                context: { appName: 'uniRecordForm', sessionID }
                            });
                            if (Array.isArray(fetched)) tsRows = fetched;
                        } catch (e) {
                            console.error('[generateFormSpec] TS load error for', tsTableName, ':', e && e.message);
                        }
                    }

                    // Строим колонки таблицы из метаданных модели ТЧ
                    let tsColumns = [];
                    let tsFkFields = []; // FK-поля для резолва display-значений
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
                                    return col;
                                });
                            // Собираем FK-поля для последующего резолва display-имён
                            tsFkFields = tsFields.filter(f =>
                                f.name !== tsParentField && f.name !== 'UID' &&
                                f.foreignKey && f.foreignKey.table
                            );
                        }
                    } catch (e) {
                        console.error('[generateFormSpec] TS fields error for', tsTableName, ':', e && e.message);
                    }

                    // Резолвим display-значения для FK-полей в строках ТЧ
                    if (tsRows.length > 0 && tsFkFields.length > 0) {
                        try {
                            const resolveDbGW = require('../../drive_root/dbGateway');
                            for (const fkField of tsFkFields) {
                                const fkTable = fkField.foreignKey.table;
                                const fkIdField = fkField.foreignKey.field || 'UID';
                                const fkDispField = fkField.foreignKey.displayField || 'name';
                                // Собираем уникальные FK-значения из строк
                                const fkValues = [...new Set(
                                    tsRows.map(r => r[fkField.name]).filter(v => v !== null && v !== undefined && v !== '')
                                )];
                                if (fkValues.length === 0) continue;
                                try {
                                    const lookupRows = await resolveDbGW.execute({
                                        operation: 'read',
                                        table: fkTable,
                                        where: { [fkIdField]: fkValues },
                                        options: { raw: true },
                                        context: { appName: 'uniRecordForm', sessionID }
                                    });
                                    if (Array.isArray(lookupRows)) {
                                        const dispMap = {};
                                        for (const lr of lookupRows) {
                                            if (lr[fkIdField] !== undefined) dispMap[lr[fkIdField]] = lr[fkDispField] || lr[fkIdField];
                                        }
                                        const dispKey = '__' + fkField.name + '_display';
                                        for (const row of tsRows) {
                                            if (row[fkField.name] !== undefined && row[fkField.name] !== null) {
                                                row[dispKey] = dispMap[row[fkField.name]] || row[fkField.name];
                                            }
                                        }
                                    }
                                } catch (e) {
                                    console.warn('[generateFormSpec] FK resolve error for', fkField.name, ':', e && e.message);
                                }
                            }
                        } catch (e) {
                            console.warn('[generateFormSpec] TS FK resolve outer error:', e && e.message);
                        }
                    }

                    // Добавляем запись в data
                    const dataKey = '__ts_' + tsTableName;
                    data.push({
                        name: dataKey,
                        value: tsRows,
                        tabularSection: true,
                        tableName: tsTableName,
                        parentField: tsParentField
                    });

                    // layout-элемент ТЧ: стандартная группа + обычная table
                    const tsName = 'ts_' + tsTableName;
                    const tsCaption = (tsDef.tabularSection && tsDef.tabularSection.caption) || tsDef.name || tsTableName;
                    tsLayoutItems.push({
                        type: 'group',
                        caption: tsCaption,
                        orientation: 'vertical',
                        layout: [
                            {
                                type: 'table',
                                name: tsName,
                                data: dataKey,
                                columns: tsColumns,
                                properties: { editMode: 'cell-immediate', visibleRows: 5 }
                            }
                        ]
                    });
                }

                if (tsLayoutItems.length > 0) {
                    // Вставляем ТЧ перед группой действий (Сохранить/Отмена)
                    const actionsIdx = layout.findIndex(item =>
                        item.type === 'group' &&
                        Array.isArray(item.layout) &&
                        item.layout.some(i => i.action === 'save')
                    );
                    const insertIdx = actionsIdx >= 0 ? actionsIdx : layout.length;

                    if (tsLayoutItems.length === 1) {
                        // Одна ТЧ — показываем inline
                        layout.splice(insertIdx, 0, tsLayoutItems[0]);
                    } else {
                        // Несколько ТЧ — оборачиваем в Tabs
                        layout.splice(insertIdx, 0, {
                            type: 'tabs',
                            tabs: tsLayoutItems.map(item => ({
                                caption: item.caption,
                                layout: [item]
                            }))
                        });
                    }
                }
            }
        } catch (e) {
            console.error('[generateFormSpec] tabular sections error:', e && e.message || e);
        }
        // ========================

        const datasetId = dataApp.storeDataset({
            table: tableName,
            id: effectiveRecordId,
            isNew: isNew,
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