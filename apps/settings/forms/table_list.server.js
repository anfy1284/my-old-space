'use strict';

/**
 * Форма выбора таблицы (`user_settings_table_list`) — служебная форма автозаполнения.
 *
 * Автозаполнение («значение по умолчанию для таблицы») — механизм отдельный от настроек:
 * он хранит не значение параметра, а запись, которой заполняется поле новой формы
 * (см. `loadUserDefaultValues` в apps/uniForm). Форма настроек показывает его табличной
 * частью на уровне пользователя, и в первой колонке нужен выбор ТАБЛИЦЫ — записей в базе
 * для такого списка нет, он собирается из определений моделей.
 *
 * Переехало сюда из `apps/UserSettings` при его удалении: сам механизм не менялся.
 *
 * @module apps/settings/forms/table_list.server
 */

const globalRootCtx   = require('../../../drive_root/globalServerContext');
const { tForSession } = require('../../../drive_forms/globalServerContext');

/**
 * Таблицы, которые в списке не предлагаются: заполнять поля формы их записями
 * бессмысленно (служебные) либо опасно (сессии).
 */
const SYSTEM_TABLES = new Set([
    'sessions', 'default_values', 'translations',
    'settings_values', 'user_settings_defaults', 'user_settings_table_list',
    'user_organizations'
]);

/** Список таблиц с переводами: [{ UID: tableName, tableLabel }]. */
async function buildTableList(sessionID) {
    const { models } = globalRootCtx.collectAllModelDefs();
    const result = [];
    const seen = new Set();
    for (const model of (models || [])) {
        if (!model.tableName) continue;
        if (SYSTEM_TABLES.has(model.tableName)) continue;
        if (seen.has(model.tableName)) continue;
        seen.add(model.tableName);

        let label = model.tableName;
        try {
            const byTable = await tForSession(model.tableName, sessionID);
            const byModel = model.name ? await tForSession(model.name, sessionID) : null;
            if (byTable && byTable !== model.tableName) label = byTable;
            else if (byModel && byModel !== model.name) label = byModel;
            else if (model.name) label = model.name;
        } catch (e) { /* без перевода — имя таблицы */ }

        result.push({ UID: model.tableName, tableLabel: label });
    }
    result.sort((a, b) => a.tableLabel.localeCompare(b.tableLabel));
    return result;
}

/** Лейаут формы выбора (одна таблица со списком). */
function buildTableListLayout() {
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

module.exports = function factory(modelsDB, Utilities) {
    async function onLoadData_tableList({ tableName, params }, ctx) {
        return {
            data: [{ name: 'table_list', value: await buildTableList(ctx.sessionID), tabularSection: true }],
            caption: await tForSession('Select table', ctx.sessionID)
        };
    }
    return { onLoadData_tableList };
};

module.exports.buildTableListLayout = buildTableListLayout;
