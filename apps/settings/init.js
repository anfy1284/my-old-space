'use strict';

// Точка регистрации формы «Настройки» — единой формы настроек всех уровней.
// Вызывается фреймворком при старте (по записи в drive_forms/apps.json).
//
// Состав формы берётся из реестра объявлений (`drive_root/settings/registry`), значения —
// через серверный API (`drive_root/settings`). ТЗ: tmp/ТЗ_НАСТРОЙКИ_ПРИЛОЖЕНИЙ.md, §9.
//
// Структура (паттерн разделённых файлов):
//   forms/app_settings.server.js — модуль-фабрика RPC + buildLayout(isAdmin)
//   forms/app_settings.client.js — клиентский JS (__SERVER_SCRIPT__ плейсхолдер)
//
// Лейаут регистрируется ДВАЖДЫ: полный для роли `admin` (уровни «Система» и «Значения
// по умолчанию», настройки с `visibility: "admin"`) и урезанный для всех остальных.
// Прятать эти поля на клиенте нельзя — их подписи всё равно уехали бы в браузер.

const path = require('path');
const fs   = require('fs');

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../');
        const layoutMemory = require('../../drive_root/layoutMemory');
        const registry = require('../../drive_root/settings/registry');

        registry.ensureLoaded();

        const settingsServer = require('./forms/app_settings.server');
        const serverFns = settingsServer(modelsDB, Utilities);
        const serverScriptName = loadServerScript('settings.actions', serverFns, 'user');

        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/app_settings.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, serverScriptName);
        const clientUID = await loadScript(clientSource, 'user');

        const common = {
            appName:   'uniForm',
            mode:      'record',
            tableName: 'app_settings',
            clientScript: clientUID,
            formIcon:  '/apps/general_icons/resources/public/16x16/settings.png',
            appCaption:    { i18n: 'settings_app_caption' },
            recordCaption: { i18n: 'settings_app_caption' },
            events: {
                onLoadData: { serverScript: serverScriptName, fn: 'onLoadData' },
                onSave:     { serverScript: serverScriptName, fn: 'onSave' },
                onReady:    { fn: 'onFormReady' }
            }
        };

        await layoutMemory.saveLayout(Object.assign({}, common, {
            roles:  'admin',
            layout: settingsServer.buildLayout(true)
        }));
        await layoutMemory.saveLayout(Object.assign({}, common, {
            roles:  ['user', '*'],
            layout: settingsServer.buildLayout(false)
        }));

        const mainMenu = require('../main_menu/server.js');
        mainMenu.addMenuItems([{
            id: 'main',
            items: [{
                caption: { i18n: 'settings_app_caption' },
                action: 'open',
                singleton: true,
                appName: 'uniForm',
                order: 99, // перед старыми пунктами настроек (100–102), пока те живы
                params: { mode: 'record', dbTable: 'app_settings' }
            }]
        }]);

        console.log('[settings/init] Layout registered (admin + user)');
    } catch (e) {
        console.error('[settings/init] Failed:', e && e.message || e);
    }
};
