'use strict';

// Регистрация обработки «Проверка документов» (приложение фреймворка).
//
// ТЗ `tmp/ТЗ_ОПОВЕЩЕНИЯ_ПО_ДОКУМЕНТАМ.md` §13. На форме документа видны только
// ЕГО оповещения, а вопрос «где вообще непорядок» задают не документу —
// поэтому есть одно место, где видно всё сразу.
//
// У формы НЕТ ПРЕДМЕТА: список разнородный (брони, счета, денежные документы),
// сохранять нечего, запирать нечего. Адрес у неё собственный: приложение
// `documentCheck`, имя формы `documentCheck` — выдумывать таблицу ради адреса
// запрещено (`drive_root/formAddress.js`).
//
// Роль `'*'`, а не `'user'`: `'user'` — это роль, а форма нужна всем, кто вообще
// работает с документами. Кого именно он увидит, решают RLS.

const path = require('path');
const fs = require('fs');

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../');
        const layoutMemory = require('../../drive_root/layoutMemory');
        const formMethods  = require('../../drive_root/formMethods');
        const APP  = 'documentCheck';
        const FORM = 'documentCheck';
        const ICON = '/apps/general_icons/resources/public/16x16/document_check.png';

        const fns = require('./forms/document_check.server')(modelsDB, Utilities);
        // Методы ФОРМЫ — здесь же её серверное событие `onLoadData`.
        formMethods.register({ app: APP, form: FORM, methods: fns, roles: ['user', 'admin'] });
        // Имя скрипта остаётся: клиентский код формы зовёт её методы через него.
        const serverScriptName = loadServerScript('documentCheck.actions', fns, 'user');

        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/document_check.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, serverScriptName);
        const clientUID = await loadScript(clientSource, 'user');

        const layout = JSON.parse(
            fs.readFileSync(path.join(__dirname, 'forms/document_check.layout.json'), 'utf8')
        );

        await layoutMemory.saveLayout({
            app:  APP,
            form: FORM,
            roles: '*',
            // Ни «ОК»/«Сохранить»/«Отменить», ни звёздочки несохранённого: это
            // следует из ОТСУТСТВИЯ ПРЕДМЕТА, объявлять отдельно нечего.
            layout,
            clientScript: clientUID,
            appCaption: { i18n: 'dc_app_caption' },
            recordCaption: { i18n: 'dc_app_caption' },
            formIcon: ICON,
            // Список разнородный, с длинными текстами оповещений — в окне по
            // содержимому они обрезались бы на первом же десятке строк.
            windowState: 'maximized'
        });

        // Пункт меню — в «Сервис»: это обслуживание данных, а не работа с
        // отдельным документом.
        try {
            const mainMenu = require(path.resolve(__dirname, '../main_menu/server.js'));
            mainMenu.addMenuItems([
                {
                    id: 'main',
                    items: [
                        {
                            caption: { i18n: 'dc_app_caption' },
                            icon: ICON,
                            action: 'open',
                            appName: 'uniForm',
                            params: { app: APP, form: FORM }
                        }
                    ]
                }
            ], 'start');
        } catch (e) {
            console.error('[documentCheck/init] пункт меню не добавлен:', e && e.message || e);
        }

        console.log('[documentCheck/init] форма «Проверка документов» зарегистрирована');
    } catch (e) {
        console.error('[documentCheck/init] регистрация не выполнена:', e && e.message || e);
    }
};
