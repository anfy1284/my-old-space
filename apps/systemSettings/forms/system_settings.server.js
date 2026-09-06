'use strict';

// Серверный модуль формы «Настройки системы».
//
// Третий уровень настроек: пользователь → организация → СИСТЕМА. Отличие от
// настроек организации ровно одно и оно определяет всю форму: у системной
// настройки нет области действия. Нет селектора организации, нет колонки
// scope в таблицах значений, одно значение на инсталляцию — и, как следствие,
// правит их только администратор.
//
// EAV-модель повторяет organizationSettings: system_settings_fields — описание
// настроек, значения — в таблицах по типу (system_settings_number_values и т.д.).
//
// Экспортирует:
//   module.exports(modelsDB, Utilities) → { onLoadData, onSave }
//   module.exports.buildLayout(modelsDB) → layout[]  — зовётся из init.js при старте

const globalRootCtx = require('../../../drive_root/globalServerContext');
const formsCtx = require('../../../drive_forms/globalServerContext');
const { tForSession } = formsCtx;

// PascalCase имя модели из имени таблицы.
function modelNameFromTable(tableName) {
    return tableName.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/**
 * Настройки системы правит только администратор.
 *
 * Проверка стоит в КАЖДОМ методе, а не только на регистрации лейаута: роль в
 * `saveLayout` решает, кому отдать форму, но RPC — отдельная дверь, и её надо
 * запирать своим ключом. Сама таблица от роли `user` скрыта (организация у неё
 * всегда NULL), однако читает форма напрямую через модели, мимо RLS.
 */
async function requireAdmin(sessionID) {
    const user = await globalRootCtx.getUserBySessionID(sessionID);
    if (!user) return null;
    const role = await formsCtx.getUserAccessRole(user);
    return role === 'admin' ? user : null;
}

// ── Чтение настроек из EAV-таблиц ────────────────────────────────────────────
// Возвращает массив { name, value, display } (display — для ссылочных полей).
async function getSettings(modelsDB) {
    if (!modelsDB || !modelsDB.SystemSettingsFields) return [];

    const settingsFields = await modelsDB.SystemSettingsFields.findAll({
        include: [{ model: modelsDB.SystemSettingsTypes, as: 'type', attributes: ['UID', 'name', 'valueTableName'] }],
        order: [['displayOrder', 'ASC'], ['UID', 'ASC']]
    });

    const fields = [];
    for (const field of settingsFields) {
        const valueTableName = field.type ? field.type.valueTableName : null;
        const typeName = field.type ? field.type.name : '';
        const opts = (field.options && typeof field.options === 'object' && !Array.isArray(field.options))
            ? field.options : null;
        let value = null;

        if (valueTableName) {
            const modelName = modelNameFromTable(valueTableName);
            if (modelsDB[modelName]) {
                const record = await modelsDB[modelName].findOne({ where: { settingsFieldId: field.UID } });
                value = record ? record.value : null;
            } else {
                console.warn('[SystemSettings] Модель не найдена:', modelName);
            }
        }

        // Значение не задано — показываем то, по которому механизм и работает
        // (значение по умолчанию из описания настройки). Пустое поле здесь врало
        // бы: администратор видел бы «ничего», а срок хранения при этом действует.
        if ((value === null || value === undefined || value === '') && opts && opts.default !== undefined) {
            value = opts.default;
        } else if ((value === null || value === undefined) && typeName === 'boolean') {
            value = false;
        }

        const out = { name: field.name, value: value, display: undefined };

        // Отображаемое значение ссылочных полей (referenceTable).
        if (opts && opts.referenceTable && value) {
            const refModelName = modelNameFromTable(opts.referenceTable);
            if (modelsDB[refModelName]) {
                try {
                    const refRecord = await modelsDB[refModelName].findByPk(value);
                    if (refRecord) out.display = refRecord[opts.displayField || 'name'];
                } catch (e) {
                    console.warn('[SystemSettings] резолв ссылки:', field.name, e.message);
                }
            }
        }
        fields.push(out);
    }
    return fields;
}

// ── Запись настроек в EAV-таблицы ────────────────────────────────────────────
async function saveSettings(params, sessionID, modelsDB) {
    if (!modelsDB || !modelsDB.SystemSettingsFields) {
        return { error: await tForSession('Database models not available', sessionID) };
    }

    const settingsFields = await modelsDB.SystemSettingsFields.findAll({
        include: [{ model: modelsDB.SystemSettingsTypes, as: 'type', attributes: ['UID', 'name', 'valueTableName'] }]
    });
    const fieldMap = {};
    settingsFields.forEach(f => { fieldMap[f.name] = f; });

    for (const [fieldName, value] of Object.entries(params)) {
        const field = fieldMap[fieldName];
        if (!field) continue; // не настройка — молча пропускаем

        const valueTableName = field.type ? field.type.valueTableName : null;
        if (!valueTableName) continue;

        const modelName = modelNameFromTable(valueTableName);
        if (!modelsDB[modelName]) { console.warn('[SystemSettings] Модель не найдена:', modelName); continue; }

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
            preparedValue = (value === null || value === undefined || value === '') ? null : String(value);
        }

        await modelsDB[modelName].upsert({ settingsFieldId: field.UID, value: preparedValue });
    }

    return { success: true };
}

// ── Динамическая генерация лейаута из system_settings_fields ─────────────────
async function buildLayout(modelsDB) {
    const settingsFields = await modelsDB.SystemSettingsFields.findAll({
        include: [{ model: modelsDB.SystemSettingsTypes, as: 'type', attributes: ['UID', 'name', 'valueTableName'] }],
        order: [['displayOrder', 'ASC'], ['UID', 'ASC']]
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
        const objOpts = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : null;

        if (objOpts && objOpts.referenceTable) {
            ctrl.type = 'recordSelector';
            ctrl.properties = {
                selection: {
                    table:        objOpts.referenceTable,
                    idField:      'UID',
                    displayField: objOpts.displayField || 'name'
                }
            };
        } else if (typeName === 'boolean') {
            ctrl.type = 'checkbox';
        } else if (typeName === 'date') {
            ctrl.type = 'date';
        } else if (typeName === 'enum' && Array.isArray(opts)) {
            ctrl.type = 'emunList';
            ctrl.options = opts.map(o => (o && typeof o === 'object')
                ? { value: o.value, caption: o.caption || o.value }
                : { value: o, caption: o });
        } else if (typeName === 'number') {
            ctrl.type = 'number';
        } else if (objOpts && objOpts.multiline) {
            ctrl.type = 'textarea';
            if (typeof objOpts.rows === 'number') ctrl.rows = objOpts.rows;
            if (typeof objOpts.cols === 'number') ctrl.cols = objOpts.cols;
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
            caption:     { i18n: 'system_settings_app_caption' },
            orientation: 'vertical',
            alignFields: true,
            layout:      controls
        }
    ];
}

// ── Модуль-фабрика: RPC-функции для loadServerScript ─────────────────────────
module.exports = function factory(modelsDB, Utilities) {

    async function onLoadData({ tableName, params }, ctx) {
        if (!await requireAdmin(ctx.sessionID)) {
            return { data: [], error: await tForSession('User not authorized', ctx.sessionID) };
        }
        const fields = await getSettings(modelsDB);
        const data = fields.map(f => {
            const item = { name: f.name, value: f.value, tabularSection: false };
            if (f.display !== undefined && f.value) item.selection = { id: f.value, display: f.display };
            return item;
        });

        return {
            data,
            caption: await tForSession('system_settings_app_caption', ctx.sessionID)
        };
    }

    async function onSave({ changes }, ctx) {
        if (!await requireAdmin(ctx.sessionID)) {
            return { ok: false, error: await tForSession('User not authorized', ctx.sessionID) };
        }
        const plainChanges = Object.assign({}, changes || {});
        delete plainChanges.__tabularSections;

        const result = await saveSettings(plainChanges, ctx.sessionID, modelsDB);
        if (result.error) return { ok: false, error: result.error };
        return { ok: true };
    }

    return { onLoadData, onSave };
};

module.exports.buildLayout = buildLayout;
