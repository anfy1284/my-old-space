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
// таблица лейаута `backup_settings` остаётся ВИРТУАЛЬНОЙ: форма собирает данные из
// нескольких источников (настройки, состояние машины, каталог копий), поэтому их
// отдаёт onLoadData и принимает onSave, а не запись одной таблицы.

const path = require('path');
const fs = require('fs');

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../');
        const layoutMemory = require('../../drive_root/layoutMemory');

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
            // Разворачиваем на весь экран: на форме список копий, панель хода операции
            // и несколько блоков настроек — в окне по содержимому они читаются тесно.
            windowState: 'maximized',
            // `onReady` не объявлен намеренно: стартовую настройку клиенту делать нечем —
            // доступность кнопок ведёт ядро по `enabledWhen`, текущую строку списка —
            // сама таблица. Привязка к несуществующей функции была бы мёртвой конфигурацией.
            events: {
                onLoadData: { serverScript: serverScriptName, fn: 'onLoadData' },
                onSave: { serverScript: serverScriptName, fn: 'onSave' }
            }
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
        const fullScriptName = loadServerScript(
            'backup.restoreFull',
            require('./forms/backup_restore_full.server')(modelsDB, Utilities),
            'admin'
        );
        const fullClientSource = fs
            .readFileSync(path.join(__dirname, 'forms/backup_restore_full.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, fullScriptName);
        const fullClientUID = await loadScript(fullClientSource, 'admin');

        await layoutMemory.saveLayout({
            appName: 'uniForm',
            mode: 'record',
            tableName: 'backup_restore_full',
            roles: 'admin',
            layout: JSON.parse(fs.readFileSync(path.join(__dirname, 'forms/backup_restore_full.layout.json'), 'utf8')),
            clientScript: fullClientUID,
            appCaption: { i18n: 'restore_full_app_caption' },
            recordCaption: { i18n: 'restore_full_app_caption' },
            formIcon: '/apps/general_icons/resources/public/16x16/database.png',
            windowState: 'maximized',
            events: {
                onLoadData: { serverScript: fullScriptName, fn: 'onLoadData' },
                // Стартовая настройка формы (видимость полей по выбранной области) —
                // на form-level onReady, а не на onChange: до первой правки форма
                // стояла бы недонастроенной.
                onReady: 'onReady'
            }
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
                params: { mode: 'record', dbTable: 'backup_settings' }
            }, {
                caption: { i18n: 'restore_full_app_caption' },
                action: 'open',
                singleton: true,
                appName: 'uniForm',
                order: 93,
                icon: '/apps/general_icons/resources/public/16x16/restore.png',
                roles: ['admin'],
                params: { mode: 'record', dbTable: 'backup_restore_full' }
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
