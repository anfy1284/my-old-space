'use strict';

// Точка регистрации формы «Настройки системы» (приложение фреймворка).
// Вызывается фреймворком при старте по записи в drive_forms/apps.json.
//
// Третий уровень настроек рядом с настройками пользователя и организации:
// общие для всей инсталляции параметры, которые правит только администратор
// (сроки хранения, лимиты, поведение механизмов ядра). Первая настройка —
// срок хранения пуш-уведомлений.
//
// Структура (паттерн разделённых файлов, эталон — apps/organizationSettings):
//   forms/system_settings.server.js — модуль-фабрика RPC + buildLayout()
//   forms/system_settings.client.js — клиентский JS (__SERVER_SCRIPT__ плейсхолдер)
//   db/db.json                      — EAV-схема без области действия
//   db/defaultValues.json           — типы значений + описания настроек
//   lib/systemSettings.js           — чтение настроек серверным кодом

const path = require('path');
const fs   = require('fs');

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../');
        const layoutMemory = require('../../drive_root/layoutMemory');

        const settingsServer = require('./forms/system_settings.server');
        const serverFns = settingsServer(modelsDB, Utilities);
        // Роль 'admin' и у серверного скрипта, и у клиентского, и у лейаута:
        // системные настройки — не «настройки для всех», их правит только админ.
        const serverScriptName = loadServerScript('systemSettings.actions', serverFns, 'admin');

        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/system_settings.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, serverScriptName);
        const clientUID = await loadScript(clientSource, 'admin');

        const layout = await settingsServer.buildLayout(modelsDB);

        await layoutMemory.saveLayout({
            appName:   'uniForm',
            mode:      'record',
            tableName: 'system_settings',
            roles:     'admin',
            layout,
            clientScript: clientUID,
            formIcon:  '/apps/general_icons/resources/public/16x16/settings.png',
            appCaption: { i18n: 'system_settings_app_caption' },
            recordCaption: { i18n: 'system_settings_app_caption' },
            events: {
                onLoadData: { serverScript: serverScriptName, fn: 'onLoadData' },
                onSave:     { serverScript: serverScriptName, fn: 'onSave' }
            }
        });

        const mainMenu = require('../main_menu/server.js');
        mainMenu.addMenuItems([{
            id: 'main',
            items: [{
                caption: { i18n: 'system_settings_app_caption' },
                action: 'open',
                singleton: true,
                appName: 'uniForm',
                icon: '/apps/general_icons/resources/public/16x16/settings.png',
                roles: ['admin'],
                order: 102, // после настроек организации (101)
                params: { mode: 'record', dbTable: 'system_settings' }
            }]
        }]);

        console.log('[systemSettings/init] Layout registered');
    } catch (e) {
        console.error('[systemSettings/init] Failed:', e && e.message || e);
    }
};
