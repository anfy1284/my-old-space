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
        const formMethods = require('../../drive_root/formMethods');
        const APP = 'settings';
        // Имя формы выбора таблицы вынесено в константу: на него ссылается
        // объявление поля в `app_settings.server.js` (`selection.form`), и разойтись
        // этим двум местам нельзя.
        const TABLE_PICKER_FORM = require('./forms/table_list.server').FORM;
        // Методы ФОРМЫ настроек — здесь же её серверные события (onLoadData, onSave).
        formMethods.register({ app: APP, form: 'appSettings', methods: serverFns, roles: ['user', 'admin'] });
        // Имя скрипта остаётся: клиентский код формы зовёт её методы через него.
        const serverScriptName = loadServerScript('settings.actions', serverFns, 'user');

        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/app_settings.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, serverScriptName);
        const clientUID = await loadScript(clientSource, 'user');

        // ПРЕДМЕТА у формы настроек нет: значения лежат в `settings_values`, но
        // форма не запись этой таблицы — она собирает уровни, приложения и вкладки.
        // Раньше ради адреса выдумывалась таблица `app_settings`, которой в базе нет.
        const common = {
            app:  APP,
            form: 'appSettings',
            clientScript: clientUID,
            formIcon:  '/apps/general_icons/resources/public/16x16/settings.png',
            appCaption:    { i18n: 'settings_app_caption' },
            recordCaption: { i18n: 'settings_app_caption' },
            // Серверные события — методы формы (зарегистрированы выше). Здесь только
            // клиентское: стартовая настройка вида.
            clientEvents: { onReady: 'onFormReady', onAfterSave: 'onAfterSave' }
        };

        await layoutMemory.saveLayout(Object.assign({}, common, {
            roles:  'admin',
            layout: settingsServer.buildLayout(true)
        }));
        await layoutMemory.saveLayout(Object.assign({}, common, {
            roles:  ['user', '*'],
            layout: settingsServer.buildLayout(false)
        }));

        // ── Служебная форма выбора таблицы для автозаполнения ────────────────────────
        // Список таблиц собирается из определений моделей, записей в базе для него нет,
        // и «таблицы» у формы тоже нет — она ИМЕНОВАННАЯ. Раньше её приходилось
        // регистрировать ДВАЖДЫ, на `record` и на `list`: адрес выводился из режима, и
        // recordSelector, открывающий выбор как журнал, иначе её не находил. Режима у
        // именованной формы нет — регистрация одна.
        const tableListServer = require('./forms/table_list.server');
        const tableListFns = tableListServer(modelsDB, Utilities);
        const tableListScript = loadServerScript('settings.tableList', tableListFns, 'user');

        const tableListClient = fs
            .readFileSync(path.join(__dirname, 'forms/table_list.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, tableListScript);
        const tableListClientUID = await loadScript(tableListClient, 'user');

        const tableListLayout = tableListServer.buildTableListLayout();
        formMethods.register({
            app: APP, form: TABLE_PICKER_FORM,
            // Имя метода — условленное `onLoadData`: событие формы это её метод.
            methods: { onLoadData: tableListFns.onLoadData_tableList },
            roles: ['user', 'admin']
        });
        await layoutMemory.saveLayout({
            app:  APP,
            form: TABLE_PICKER_FORM,
            // Роль '*', а не 'user': подбор лейаута идёт точным совпадением роли, а
            // затем '*'. Со старой регистрацией на 'user' администратор получал
            // generic-лейаут списка.
            roles:     '*',
            layout:       tableListLayout,
            clientScript: tableListClientUID,
            appCaption:   { i18n: 'settings_table_picker_caption' },
            recordCaption:{ i18n: 'settings_table_picker_caption' }
        });

        const mainMenu = require('../main_menu/server.js');
        mainMenu.addMenuItems([{
            id: 'main',
            items: [{
                caption: { i18n: 'settings_app_caption' },
                action: 'open',
                singleton: true,
                appName: 'uniForm',
                order: 99, // перед старыми пунктами настроек (100–102), пока те живы
                params: { app: APP, form: 'appSettings' }
            }, {
                // Выход — последним пунктом (16.10.2026). Раньше выйти было нельзя:
                // cookie сессии HttpOnly, второй человек за тем же компьютером работал
                // под чужим именем. Действие обслуживает меню и сервер (POST /logout).
                caption: { i18n: 'logout_menu' },
                action: 'logout',
                order: 10000,
                icon: '/apps/general_icons/resources/public/16x16/logout.png'
            }]
        }]);

        console.log('[settings/init] Layout registered (admin + user)');
    } catch (e) {
        console.error('[settings/init] Failed:', e && e.message || e);
    }
};
