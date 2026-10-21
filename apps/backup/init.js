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
// Настройки копирования хранятся в БД (`backup_config`, `backup_api_clients`), но
// ПРЕДМЕТА у формы нет: она собирает данные из нескольких источников (настройки,
// состояние машины, каталог копий), поэтому их отдаёт `onLoadData` и принимает
// `onSave`, а не запись одной таблицы. Раньше ради адреса выдумывалась таблица
// `backup_settings`, которой в базе нет; теперь это ИМЕНОВАННЫЕ формы приложения.

const path = require('path');
const fs = require('fs');

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../');
        const layoutMemory = require('../../drive_root/layoutMemory');
        const formMethods  = require('../../drive_root/formMethods');
        const APP = 'backup';

        const backupFns = require('./forms/backup_settings.server')(modelsDB, Utilities);
        // Методы ФОРМЫ: сюда же попадают её серверные события (onLoadData, onSave).
        formMethods.register({ app: APP, form: 'backupSettings', methods: backupFns, roles: 'admin' });
        // Имя скрипта остаётся: клиентский код формы зовёт её методы через него.
        const serverScriptName = loadServerScript('backup.actions', backupFns, 'admin');

        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/backup_settings.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, serverScriptName);
        const clientUID = await loadScript(clientSource, 'admin');

        const layout = JSON.parse(
            fs.readFileSync(path.join(__dirname, 'forms/backup_settings.layout.json'), 'utf8')
        );

        // Только admin: форма распоряжается копией всей базы и ключами шифрования.
        await layoutMemory.saveLayout({
            app: APP,
            form: 'backupSettings',
            roles: 'admin',
            layout,
            clientScript: clientUID,
            appCaption: { i18n: 'backup_app_caption' },
            recordCaption: { i18n: 'backup_app_caption' },
            formIcon: '/apps/general_icons/resources/public/16x16/backup.png',
            // Разворачиваем на весь экран: на форме список копий, панель хода операции
            // и несколько блоков настроек — в окне по содержимому они читаются тесно.
            windowState: 'maximized',
            // `onReady` не объявлен намеренно: стартовую настройку клиенту делать нечем —
            // доступность кнопок ведёт ядро по `enabledWhen`, текущую строку списка —
            // сама таблица. Привязка к несуществующей функции была бы мёртвой конфигурацией.
            // Серверные события (`onLoadData`, `onSave`) здесь НЕ объявляются: это
            // методы формы, зарегистрированные выше.
        });

        // Восстановление ОДНОЙ организации больше НЕ отдельная форма (решение владельца
        // 2026-08-07): для пользователя восстановление из копии — одна задача, а область
        // (вся база / одна организация) — её параметр. Разводка по механизмам живёт в коде
        // объединённой формы ниже. Файлы forms/backup_restore.* оставлены до удаления в
        // апстриме и НЕ регистрируются: два пути к одному действию — это два поведения,
        // которые однажды разойдутся.

        // Полное восстановление базы (ТЗ §6.1–§6.5) — ТРЕТЬЯ форма, а не режим двух
        // предыдущих. У неё другой предмет (вся база, а не организация), другие
        // гарантии (живая база не разрушается, но сервер уходит в обслуживание) и
        // обязательный экран перед запуском (§6.2б), которого у остальных нет.
        const fullFns = require('./forms/backup_restore_full.server')(modelsDB, Utilities);
        formMethods.register({ app: APP, form: 'restoreFull', methods: fullFns, roles: 'admin' });
        const fullScriptName = loadServerScript('backup.restoreFull', fullFns, 'admin');
        const fullClientSource = fs
            .readFileSync(path.join(__dirname, 'forms/backup_restore_full.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, fullScriptName);
        const fullClientUID = await loadScript(fullClientSource, 'admin');

        await layoutMemory.saveLayout({
            app: APP,
            form: 'restoreFull',
            roles: 'admin',
            layout: JSON.parse(fs.readFileSync(path.join(__dirname, 'forms/backup_restore_full.layout.json'), 'utf8')),
            clientScript: fullClientUID,
            appCaption: { i18n: 'restore_full_app_caption' },
            recordCaption: { i18n: 'restore_full_app_caption' },
            formIcon: '/apps/general_icons/resources/public/16x16/database.png',
            windowState: 'maximized',
            // Стартовая настройка формы (видимость полей по выбранной области) —
            // на form-level onReady, а не на onChange: до первой правки форма
            // стояла бы недонастроенной. Это КЛИЕНТСКОЕ событие, поэтому объявлено
            // рядом с клиентским скриптом; серверное `onLoadData` — метод формы.
            clientEvents: { onReady: 'onReady' }
        });

        // Отдельного списка журнала копий БОЛЬШЕ НЕТ: таблица `backup_files` удалена,
        // источник истины — каталог (`drive_root/backup/catalog.js`). Список копий
        // живёт только на форме резервного копирования и строится чтением каталога.


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
                params: { app: APP, form: 'backupSettings' }
            }, {
                caption: { i18n: 'restore_full_app_caption' },
                action: 'open',
                singleton: true,
                appName: 'uniForm',
                order: 93,
                icon: '/apps/general_icons/resources/public/16x16/restore.png',
                roles: ['admin'],
                params: { app: APP, form: 'restoreFull' }
            }]
        }]);

        // Отложенная инициализация механизма. Откладываем потому, что при старте база
        // ещё синхронизируется, а подъём сервера задерживать нечем.
        setTimeout(async () => {
            // Настройки читаются из базы в кэш ПЕРВЫМ делом: всё остальное — сверка,
            // проверка ключа, вход внешнего хранилища — спрашивает их синхронно и без
            // наполненного кэша работало бы на умолчаниях, то есть без ключа шифрования.
            // Здесь же выполняется однократный перенос из прежнего backupSettings.json.
            try {
                await require('../../drive_root/backup').settings.load();
            } catch (e) {
                console.error('[backup/init] Настройки копирования не загружены:', e && e.message || e);
            }

            // Досчёт контрольных сумм у копий без спутника: хранилищу они нужны, чтобы
            // проверить скачанное, не имея приватного ключа. Фоном и без ожидания —
            // хэширование гигабайтов не должно задерживать ничего.
            require('../../drive_root/backup').catalog.backfillSidecars()
                .then(r => { if (r.done) console.log('[backup/init] Досчитано контрольных сумм:', r.done); })
                .catch(e => console.warn('[backup/init] Досчёт сумм:', e && e.message || e));

            // Заброшенные загрузки: администратор мог загрузить копию и передумать.
            // Файл содержит персональные данные всех клиентов — лежать без причины
            // он не должен.
            try { require('./server.js').sweepUploads(); } catch (e) {}
        }, 5000).unref();

        console.log('[backup/init] Layouts registered');
    } catch (e) {
        console.error('[backup/init] Failed:', e && e.message || e);
    }
};
