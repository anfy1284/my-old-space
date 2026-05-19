'use strict';

// Серверный модуль формы "Настройки по умолчанию".
//
// Экспортирует:
//   module.exports(modelsDB, Utilities) → { onLoadData_defaults, onSave_defaults, onLoadData_tableList }
//   module.exports.buildTableListLayout() → layout[]   — вызывается из init.js при старте

const globalRootCtx    = require('../../../drive_root/globalServerContext');
const { tForSession }  = require('../../../drive_forms/globalServerContext');

// Системные таблицы, которые не должны предлагаться для выбора
const SYSTEM_TABLES = new Set([
    'sessions', 'default_values', 'translations',
    'user_settings_types', 'user_settings_fields',
    'user_settings_string_values', 'user_settings_number_values',
    'user_settings_boolean_values', 'user_settings_date_values',
    'user_settings_defaults', 'user_settings_table_list',
    'user_organizations'
]);

// ── Вспомогательная функция: список всех таблиц с переводами ──────────────────────────────

async function buildTableList(sessionID) {
    const { models } = globalRootCtx.collectAllModelDefs();
    const result = [];
    const seenTableNames = new Set();   // дедупликация: одна запись на tableName
    for (const model of (models || [])) {
        if (!model.tableName) continue;
        if (SYSTEM_TABLES.has(model.tableName)) continue;
        if (seenTableNames.has(model.tableName)) continue;
        seenTableNames.add(model.tableName);

        let label = model.tableName;
        try {
            // Пробуем получить перевод по имени таблицы или по имени модели
            const byTable = await tForSession(model.tableName, sessionID);
            const byModel = model.name ? await tForSession(model.name, sessionID) : null;
            if (byTable && byTable !== model.tableName) {
                label = byTable;
            } else if (byModel && byModel !== model.name) {
                label = byModel;
            } else if (model.name) {
                label = model.name;
            }
        } catch (e) { /* ignore */ }

        result.push({ UID: model.tableName, tableLabel: label });
    }
    result.sort((a, b) => a.tableLabel.localeCompare(b.tableLabel));
    return result;
}

// ── Статический построитель лейаута для формы выбора таблицы ─────────────────────────────

async function buildTableListLayout() {
    return [
        {
            type: 'table',
            name: 'table_list',
            data: 'table_list',
            caption: { i18n: 'Select table' },
            properties: {
                readOnly:      true,
                editMode:      'row-activate',
                hiddenButtons: ['recordOpen']
            },
            columns: [
                { caption: { i18n: 'Table' }, data: 'tableLabel', width: 400 }
            ]
        }
    ];
}

// ── Модуль-фабрика ────────────────────────────────────────────────────────────────────────

module.exports = function factory(modelsDB, Utilities) {

    // Загрузка данных формы редактирования одной настройки по умолчанию
    async function onLoadData_defaults({ tableName, params }, ctx) {
        const user = await globalRootCtx.getUserBySessionID(ctx.sessionID);
        if (!user) return { data: [] };

        const recordId = params && (params.recordID || params.recordId || params.id);
        let record = null;

        if (recordId && recordId !== '__new__') {
            try {
                record = await modelsDB.UserSettingsDefaults.findOne({
                    where: { UID: recordId, userId: user.UID },
                    raw: true
                });
            } catch (e) {
                console.error('[UserSettingsDefaults] onLoadData error:', e && e.message);
            }
        }

        const data = [
            {
                name:           'tableName',
                value:          record ? record.tableName  : '',
                tabularSection: false,
                selection:      record ? { id: record.tableName, display: record.tableLabel || record.tableName } : null
            },
            { name: 'tableLabel',  value: record ? (record.tableLabel  || '') : '', tabularSection: false },
            { name: 'recordId',    value: record ? (record.recordId    || '') : '', tabularSection: false },
            { name: 'recordLabel', value: record ? (record.recordLabel || '') : '', tabularSection: false }
        ];

        return {
            data,
            caption: await tForSession('Default value', ctx.sessionID)
        };
    }

    // Сохранение настройки по умолчанию
    async function onSave_defaults({ changes }, ctx) {
        const user = await globalRootCtx.getUserBySessionID(ctx.sessionID);
        if (!user) return { ok: false, error: await tForSession('User not authorized', ctx.sessionID) };

        const { tableName: tbl, tableLabel, recordId, recordLabel } = changes || {};

        if (!tbl) {
            return { ok: false, error: await tForSession('Table not selected', ctx.sessionID) };
        }
        if (!recordId) {
            return { ok: false, error: await tForSession('Record not selected', ctx.sessionID) };
        }

        // Резолвим tableLabel если не передан
        let resolvedTableLabel = tableLabel;
        if (!resolvedTableLabel) {
            resolvedTableLabel = await tForSession(tbl, ctx.sessionID) || tbl;
        }

        // Резолвим recordLabel если не передан — берём поле name/displayName/title из целевой таблицы
        let resolvedRecordLabel = recordLabel;
        if (!resolvedRecordLabel && recordId) {
            try {
                const modelName = globalRootCtx.getModelNameForTable(tbl);
                const Model = modelName && modelsDB[modelName];
                if (Model) {
                    const rec = await Model.findByPk(recordId, { raw: true });
                    if (rec) {
                        resolvedRecordLabel = rec.name || rec.displayName || rec.title || rec.label || recordId;
                    }
                }
            } catch (e) {
                resolvedRecordLabel = recordId;
            }
        }

        try {
            await modelsDB.UserSettingsDefaults.upsert({
                userId:      user.UID,
                tableName:   tbl,
                tableLabel:  resolvedTableLabel || tbl,
                recordId:    recordId,
                recordLabel: resolvedRecordLabel || recordId
            });
        } catch (e) {
            console.error('[UserSettingsDefaults] onSave error:', e && e.message);
            return { ok: false, error: e.message };
        }

        return { ok: true };
    }

    // Загрузка списка таблиц для формы выбора (user_settings_table_list)
    async function onLoadData_tableList({ tableName, params }, ctx) {
        const tables = await buildTableList(ctx.sessionID);
        return {
            data: [
                {
                    name:           'table_list',
                    value:          tables,
                    tabularSection: true
                }
            ],
            caption: await tForSession('Select table', ctx.sessionID)
        };
    }

    return { onLoadData_defaults, onSave_defaults, onLoadData_tableList };
};

module.exports.buildTableListLayout = buildTableListLayout;
