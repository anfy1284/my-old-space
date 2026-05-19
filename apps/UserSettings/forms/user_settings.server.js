'use strict';

// Серверный модуль формы "Настройки пользователя".
//
// Экспортирует:
//   module.exports(modelsDB, Utilities) → { onLoadData, onSave }   — RPC-функции (loadServerScript)
//   module.exports.buildLayout(modelsDB) → layout[]                — вызывается из init.js при старте

const globalRootCtx    = require('../../../drive_root/globalServerContext');
const { invalidateSessionContext, tForSession } = require('../../../drive_forms/globalServerContext');

// ── Бизнес-логика: чтение настроек из EAV-таблиц ─────────────────────────────────────────

async function getSettings(params, sessionID) {
    try {
        const { modelsDB } = globalRootCtx;
        if (!modelsDB || !modelsDB.UserSettingsFields) {
            return { error: await tForSession('Database models not available', sessionID) };
        }

        const user = await globalRootCtx.getUserBySessionID(sessionID);
        if (!user) return { error: await tForSession('User not authorized', sessionID) };

        const settingsFields = await modelsDB.UserSettingsFields.findAll({
            include: [{ model: modelsDB.UserSettingsTypes, as: 'type', attributes: ['UID', 'name', 'valueTableName'] }],
            order: [['UID', 'ASC']]
        });

        const fields = [];
        for (const field of settingsFields) {
            const fieldData = { id: field.UID, name: field.name, displayName: field.displayName, typeId: field.typeId };
            if (field.options) fieldData.options = field.options;

            const valueTableName = field.type ? field.type.valueTableName : null;
            if (!valueTableName) { fieldData.value = null; fields.push(fieldData); continue; }

            const modelName = valueTableName.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
            let value = null;
            if (modelsDB[modelName]) {
                const record = await modelsDB[modelName].findOne({ where: { userId: user.UID, settingsFieldId: field.UID } });
                const typeName = field.type ? field.type.name : '';
                value = record ? record.value : (typeName === 'boolean' ? false : null);
            } else {
                console.warn('[UserSettings] Model not found:', modelName);
            }
            fieldData.value = value;

            // Резолв отображаемого значения для ссылочных полей
            if (field.options && typeof field.options === 'object' && !Array.isArray(field.options) && field.options.referenceTable && value) {
                const refModelName = field.options.referenceTable.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
                if (modelsDB[refModelName]) {
                    try {
                        const refRecord = await modelsDB[refModelName].findByPk(value);
                        if (refRecord) fieldData.referenceDisplay = refRecord[field.options.displayField || 'name'];
                    } catch (e) {
                        console.warn('[UserSettings] Failed to resolve reference for field:', field.name, e.message);
                    }
                }
            }
            fields.push(fieldData);
        }

        return { fields, userName: user.name };
    } catch (e) {
        console.error('[UserSettings] getSettings error:', e);
        return { error: e.message };
    }
}

// ── Бизнес-логика: запись настроек в EAV-таблицы ─────────────────────────────────────────

async function saveSettings(params, sessionID) {
    try {
        const { modelsDB } = globalRootCtx;
        if (!modelsDB || !modelsDB.UserSettingsFields) {
            return { error: await tForSession('Database models not available', sessionID) };
        }

        const user = await globalRootCtx.getUserBySessionID(sessionID);
        if (!user) return { error: await tForSession('User not authorized', sessionID) };

        const settingsFields = await modelsDB.UserSettingsFields.findAll({
            include: [{ model: modelsDB.UserSettingsTypes, as: 'type', attributes: ['UID', 'name', 'valueTableName'] }]
        });
        const fieldMap = {};
        settingsFields.forEach(f => { fieldMap[f.name] = f; });

        for (const [fieldName, value] of Object.entries(params)) {
            const field = fieldMap[fieldName];
            if (!field) { console.warn('[UserSettings] Unknown field:', fieldName); continue; }

            const valueTableName = field.type ? field.type.valueTableName : null;
            if (!valueTableName) continue;

            const modelName = valueTableName.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
            if (!modelsDB[modelName]) { console.warn('[UserSettings] Model not found:', modelName); continue; }

            const typeName = field.type ? field.type.name : 'string';
            let preparedValue = value;
            if (typeName === 'number') {
                if (value === null || value === undefined || value === '') { preparedValue = null; }
                else {
                    const num = (typeof value === 'number') ? value : Number(value);
                    preparedValue = Number.isFinite(num) ? num : null;
                }
            } else if (typeName === 'boolean') {
                preparedValue = value === true || value === 'true';
            } else if (typeName === 'date') {
                if (!value || value === '' || value === 'Invalid date') { preparedValue = null; }
                else {
                    const date = new Date(value);
                    preparedValue = isNaN(date.getTime()) ? null : date;
                }
            } else {
                preparedValue = String(value);
            }

            await modelsDB[modelName].upsert({ userId: user.UID, settingsFieldId: field.UID, value: preparedValue });
        }

        invalidateSessionContext(sessionID);
        return { success: true };
    } catch (e) {
        console.error('[UserSettings] saveSettings error:', e);
        return { error: e.message };
    }
}

// ── Динамическая генерация лейаута из таблицы UserSettingsFields ──────────────────────────
//
// Тип контрола по typeId:
//   string  → textbox
//   number  → textbox (number)
//   boolean → checkbox
//   date    → date
//   enum    → emunList
//   + ссылочное поле (options.referenceTable) → recordSelector

async function buildLayout(modelsDB) {
    const settingsFields = await modelsDB.UserSettingsFields.findAll({
        include: [{
            model: modelsDB.UserSettingsTypes,
            as: 'type',
            attributes: ['UID', 'name', 'valueTableName']
        }],
        order: [['UID', 'ASC']]
    });

    const controls = [];
    for (const field of settingsFields) {
        const typeName = field.type ? field.type.name : '';
        const ctrl = {
            name:    field.name,
            data:    field.name,
            caption: { i18n: field.displayName || field.name }
        };

        const opts = field.options;
        if (opts && typeof opts === 'object' && !Array.isArray(opts) && opts.referenceTable) {
            ctrl.type = 'recordSelector';
            ctrl.properties = {
                showSelectionButton: true,
                selection: {
                    table:        opts.referenceTable,
                    idField:      'UID',
                    displayField: opts.displayField || 'name'
                }
            };
        } else if (typeName === 'boolean') {
            ctrl.type = 'checkbox';
        } else if (typeName === 'date') {
            ctrl.type = 'date';
        } else if (typeName === 'enum' && field.options) {
            ctrl.type = 'emunList';
            const enumOpts = Array.isArray(field.options) ? field.options
                : (typeof field.options === 'string' ? JSON.parse(field.options) : []);
            ctrl.options = enumOpts.map(o => ({ value: o, caption: o }));
        } else if (typeName === 'number') {
            ctrl.type = 'number';
        } else {
            ctrl.type = 'textbox';
        }

        controls.push(ctrl);
    }

    return [
        {
            type: 'commandBar',
            extraButtons: [
                {
                    name:    'btnApply',
                    caption: { i18n: 'Apply' },
                    icon:    '/apps/general_icons/resources/public/16x16/save.png',
                    events:  { onClick: 'applySettings' }
                }
            ]
        },
        {
            type:        'group',
            caption:     { i18n: 'User settings' },
            orientation: 'vertical',
            layout:      controls
        }
    ];
}

// ── Модуль-фабрика: RPC-функции для loadServerScript ─────────────────────────────────────

module.exports = function factory(modelsDB, Utilities) {

    // Загрузка данных формы (вызывается из generateFormSpec через onLoadData)
    async function onLoadData({ tableName, params }, ctx) {
        const result = await getSettings(params, ctx.sessionID);
        if (result.error) return { data: [] };

        const data = [];
        if (result.fields) {
            for (const field of result.fields) {
                const item = { name: field.name, value: field.value, tabularSection: false };
                if (field.referenceDisplay !== undefined && field.value) {
                    item.selection = { id: field.value, display: field.referenceDisplay };
                }
                data.push(item);
            }
        }

        return {
            data,
            caption: await tForSession('User settings', ctx.sessionID) + (result.userName ? ' — ' + result.userName : '')
        };
    }

    // Сохранение данных формы (вызывается из applyChanges через onSave)
    async function onSave({ changes, tableName }, ctx) {
        const result = await saveSettings(changes, ctx.sessionID);
        if (result.error) return { ok: false, error: result.error };
        return { ok: true };
    }

    return { onLoadData, onSave };
};

module.exports.buildLayout = buildLayout;
