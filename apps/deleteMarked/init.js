'use strict';

// Регистрация обработки «Удаление помеченных объектов» (приложение фреймворка).
//
// Второй шаг удаления: первый — пометка (drive_root/db/deletionMark.js), она
// обратима и стоит одно нажатие; здесь объект исчезает навсегда, поэтому здесь и
// только здесь проверяются ссылки.
//
// Таблица `delete_marked` ВИРТУАЛЬНАЯ — записи с таким именем нет, список
// собирается из всех сущностей сразу (см. forms/delete_marked.server.js).
//
// Роль `'*'`, а не `'user'`: `'user'` — это роль, а форма нужна всем, кто вообще
// может удалять. Кого именно он увидит, решают RLS, а не роль (раздел 66
// АРХИТЕКТУРА_ПРОЕКТА.md).

const path = require('path');
const fs = require('fs');

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../');
        const layoutMemory = require('../../drive_root/layoutMemory');

        const serverScriptName = loadServerScript(
            'deleteMarked.actions',
            require('./forms/delete_marked.server')(modelsDB, Utilities),
            'user'
        );

        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/delete_marked.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, serverScriptName);
        const clientUID = await loadScript(clientSource, 'user');

        const layout = JSON.parse(
            fs.readFileSync(path.join(__dirname, 'forms/delete_marked.layout.json'), 'utf8')
        );

        await layoutMemory.saveLayout({
            appName: 'uniForm',
            mode: 'record',
            tableName: 'delete_marked',
            roles: '*',
            // ОБРАБОТКА, а не форма записи: своих данных у неё нет, сохранять
            // нечего — ядро уберёт «ОК»/«Сохранить»/«Отменить» и звёздочку.
            formKind: 'processing',
            layout,
            clientScript: clientUID,
            appCaption: { i18n: 'dm_app_caption' },
            recordCaption: { i18n: 'dm_app_caption' },
            formIcon: '/apps/general_icons/resources/public/16x16/deletion_mark.png',
            // Список разнородный и с колонкой «что мешает» — в окне по содержимому
            // она обрезается на первом же клиенте с десятком броней.
            windowState: 'maximized',
            events: {
                onLoadData: { serverScript: serverScriptName, fn: 'onLoadData' }
            }
        });

        // Пункт меню — в «Сервис»: это обслуживание базы, а не работа с документами.
        try {
            const mainMenu = require(path.resolve(__dirname, '../main_menu/server.js'));
            mainMenu.addMenuItems([
                {
                    id: 'main',
                    items: [
                        {
                            caption: { i18n: 'dm_app_caption' },
                            icon: '/apps/general_icons/resources/public/16x16/deletion_mark.png',
                            action: 'open',
                            appName: 'uniForm',
                            params: { mode: 'record', dbTable: 'delete_marked' }
                        }
                    ]
                }
            ], 'start');
        } catch (e) {
            console.error('[deleteMarked/init] пункт меню не добавлен:', e && e.message || e);
        }

        console.log('[deleteMarked/init] форма «Удаление помеченных объектов» зарегистрирована');
    } catch (e) {
        console.error('[deleteMarked/init] регистрация не выполнена:', e && e.message || e);
    }
};
