'use strict';

// Точка регистрации формы настроек пользователя.
// Автоматически вызывается фреймворком при старте.
//
// UserSettings использует EAV-модель: список полей — в UserSettingsFields,
// значения — в отдельных таблицах по типу (UserSettingsStringValues и т.д.).
// Лейаут строится динамически из БД в buildLayout().
//
// Структура:
//   forms/user_settings.server.js          — модуль-фабрика RPC + buildLayout()
//   forms/user_settings.client.js          — клиентский JS (__SERVER_SCRIPT__ плейсхолдер)
//   forms/user_settings_defaults.server.js — серверная логика "Настройки по умолчанию"
//   forms/user_settings_defaults.client.js — клиент для форм выбора таблицы и записи

const path = require('path');
const fs   = require('fs');

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../');
        const layoutMemory = require('../../drive_root/layoutMemory');

        // ── Форма "Настройки пользователя" ───────────────────────────────────────────────────

        const userSettingsServer = require('./forms/user_settings.server');

        const serverFns = userSettingsServer(modelsDB, Utilities);
        const serverScriptName = loadServerScript('userSettings.actions', serverFns, 'user');

        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/user_settings.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, serverScriptName);
        const clientUID = await loadScript(clientSource, 'user');

        const layout = await userSettingsServer.buildLayout(modelsDB);

        await layoutMemory.saveLayout({
            appName:   'uniForm',
            mode:      'record',
            tableName: 'user_settings',
            roles:     'user',
            layout,
            clientScript: clientUID,
            formIcon:  '/apps/general_icons/resources/public/16x16/settings.png',
            // Заголовок окна (иначе остаётся родовой «uniForm» — форма открывается через
            // onLoadData, где appCaption берётся только из saveLayout). Зеркало organizationSettings.
            appCaption: { i18n: 'user_settings_app_caption' },
            events: {
                onLoadData: { serverScript: serverScriptName, fn: 'onLoadData' },
                onSave:     { serverScript: serverScriptName, fn: 'onSave' }
            }
        });

        // ── Форма "Автозаполнение": выбор таблицы (user_settings_table_list) ─────────────────────

        const defaultsServer = require('./forms/user_settings_defaults.server');
        const defaultsFns    = defaultsServer(modelsDB, Utilities);
        const defaultsScriptName = loadServerScript('userSettings.defaults', defaultsFns, 'user');

        const defaultsClientSource = fs
            .readFileSync(path.join(__dirname, 'forms/user_settings_defaults.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, defaultsScriptName);
        const defaultsClientUID = await loadScript(defaultsClientSource, 'user');

        // Лейаут виртуальной формы выбора таблицы (user_settings_table_list)
        const tableListLayout = await defaultsServer.buildTableListLayout();

        await layoutMemory.saveLayout({
            appName:   'uniForm',
            mode:      'record',
            tableName: 'user_settings_table_list',
            roles:     'user',
            layout:       tableListLayout,
            clientScript: defaultsClientUID,
            events: {
                onLoadData: { serverScript: defaultsScriptName, fn: 'onLoadData_tableList' }
            }
        });

        // Тот же лейаут в режиме list — нужен чтобы recordSelector открывал его через dbTable:
        await layoutMemory.saveLayout({
            appName:   'uniForm',
            mode:      'list',
            tableName: 'user_settings_table_list',
            roles:     'user',
            layout:       tableListLayout,
            clientScript: defaultsClientUID,
            events: {
                onLoadData: { serverScript: defaultsScriptName, fn: 'onLoadData_tableList' }
            }
        });

        const mainMenu = require('../../apps/main_menu/server.js');
        mainMenu.addMenuItems([{
            id: 'main',
            items: [{
                caption: { i18n: 'user_settings_app_caption' },
                action: 'open',
                singleton: true,
                appName: 'uniForm',
                order: 100, // настройки — в конец списка меню (см. sortByOrder в main_menu/client.js)
                params: { mode: 'record', dbTable: 'user_settings' }
                // icon берётся автоматически из layoutMemory (formIcon у user_settings)
            }]
        }]);

        console.log('[UserSettings/init] All layouts registered');
    } catch (e) {
        console.error('[UserSettings/init] Failed:', e && e.message || e);
    }
};

