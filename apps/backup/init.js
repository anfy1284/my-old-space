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
            // Разворачиваем на весь экран: на форме журнал копий с десятком колонок и
            // панель хода операции — в окне по содержимому они читаются тесно.
            windowState: 'maximized',
            // `onReady` не объявлен намеренно: стартовую настройку клиенту делать нечем —
            // доступность кнопок ведёт ядро по `enabledWhen`, текущую строку журнала —
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

        // Сверка журнала копий с каталогом при старте (ТЗ §2.1). Файл могли удалить
        // мимо системы, а после полного восстановления журнал вообще приезжает изнутри
        // дампа и описывает каталог чужого момента. Откладываем: при старте база ещё
        // синхронизируется, а сверка не должна задерживать подъём сервера.
        setTimeout(() => {
            require('../../drive_root/backup').reconcileJournal()
                .catch(e => console.warn('[backup/init] Журнал копий не сверен:', e && e.message || e));
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
