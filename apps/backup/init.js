'use strict';

// Точка регистрации формы «Резервное копирование» (приложение фреймворка).
// Вызывается фреймворком при старте по записи в drive_forms/apps.json.
//
// Структура (паттерн разделённых файлов, эталон — apps/scheduler):
//   forms/backup_settings.layout.json — форма: состояние, настройки, ключи, журнал копий
//   forms/backup_settings.server.js   — RPC (модуль-фабрика)
//   forms/backup_settings.client.js   — клиентский JS (__SERVER_SCRIPT__ плейсхолдер)
//   scheduler.handlers.js             — тип задачи backup.create (единственный запуск выгрузки)
//   server.js                         — роуты /api/apps/backup/…
//
// Настройки формы хранятся в ФАЙЛЕ (backupSettings.json), а не в БД, поэтому таблица
// `backup_settings` виртуальная: данные отдаёт onLoadData, принимает onSave.

const path = require('path');
const fs = require('fs');

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../');
        const layoutMemory = require('../../drive_root/layoutMemory');

        // Представление записи журнала копий объявлено ДЕКЛАРАТИВНО в модели
        // (`entityConfig.presentation: "fileName"`), а не регистрируется здесь:
        // записи создаёт регламентная задача в процессе-воркере, который init.js
        // не выполняет, и зарегистрированный тут билдер до него бы не доехал.

        const serverScriptName = loadServerScript(
            'backup.actions',
            require('./forms/backup_settings.server')(modelsDB, Utilities),
            'admin'
        );

        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/backup_settings.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, serverScriptName);
        const clientUID = await loadScript(clientSource, 'admin');

        const layout = JSON.parse(
            fs.readFileSync(path.join(__dirname, 'forms/backup_settings.layout.json'), 'utf8')
        );

        // Только admin: форма распоряжается копией всей базы и ключами шифрования.
        await layoutMemory.saveLayout({
            appName: 'uniForm',
            mode: 'record',
            tableName: 'backup_settings',
            roles: 'admin',
            layout,
            clientScript: clientUID,
            appCaption: { i18n: 'backup_app_caption' },
            recordCaption: { i18n: 'backup_app_caption' },
            formIcon: '/apps/general_icons/resources/public/16x16/backup.png',
            events: {
                onLoadData: { serverScript: serverScriptName, fn: 'onLoadData' },
                onSave: { serverScript: serverScriptName, fn: 'onSave' },
                onReady: { fn: 'onFormReady' }
            }
        });

        // Журнал копий отдельным списком — нужен, когда файлов много и форма тесна.
        await layoutMemory.saveLayout({
            appName: 'uniForm',
            mode: 'list',
            tableName: 'backup_files',
            roles: 'admin',
            layout: require('./forms/backup_files_list.layout.json'),
            appCaption: { i18n: 'backup_files_app_caption' },
            recordCaption: { i18n: 'backup_files_record_caption' },
            formIcon: '/apps/general_icons/resources/public/16x16/document.png',
            listIcon: '/apps/general_icons/resources/public/16x16/journal.png'
        });
        layoutMemory.registerListSort('backup_files', [{ field: 'date', order: 'desc' }]);

        const mainMenu = require('../main_menu/server.js');
        mainMenu.addMenuItems([{
            id: 'main',
            items: [{
                caption: { i18n: 'backup_app_caption' },
                action: 'open',
                singleton: true,
                appName: 'uniForm',
                order: 92,                       // рядом с планировщиком (90, 91)
                icon: '/apps/general_icons/resources/public/16x16/backup.png',
                roles: ['admin'],
                params: { mode: 'record', dbTable: 'backup_settings' }
            }]
        }]);

        console.log('[backup/init] Layouts registered');
    } catch (e) {
        console.error('[backup/init] Failed:', e && e.message || e);
    }
};
