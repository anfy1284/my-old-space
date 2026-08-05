'use strict';

// Точка регистрации форм приложения «Регламентные задания» (планировщик фреймворка).
// Вызывается фреймворком при старте (drive_forms/init.js).
//
// Структура (паттерн разделённых файлов, эталон — apps/booking проекта):
//   forms/scheduler_tasks.layout.json       — форма записи задания
//   forms/scheduler_tasks_list.layout.json  — список заданий
//   forms/scheduler_runs_list.layout.json   — журнал запусков (только чтение)
//   forms/scheduler_tasks.server.js         — серверные функции (модуль-фабрика)
//   forms/scheduler_tasks.client.js         — клиентский JS (__SERVER_SCRIPT__)
//   scheduler.handlers.js                   — типы задач самого планировщика
//   i18n.json                               — переводы (en/ru/de/pl)

const path = require('path');
const fs = require('fs');

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../');
        const layoutMemory = require('../../drive_root/layoutMemory');
        const entityHooks = require('../../drive_root/entityHooks');
        const registry = require('../../drive_root/scheduler/registry');

        // ── Представление задания (поле name) ─────────────────────────────
        // Справочник: представление — пользовательское наименование задания.
        entityHooks.registerPresentation('scheduler_tasks', async (data) => {
            return String(data.caption || data.number || '').trim();
        });
        // Представление записи журнала: номер + статус (в списках и окнах выбора).
        entityHooks.registerPresentation('scheduler_runs', async (data) => {
            return [data.number, data.status].filter(Boolean).join(' ');
        });

        // ── Реестр типов задач ────────────────────────────────────────────
        // Нужен уже здесь: выпадашка «тип задачи» строится из него при регистрации
        // лейаута. Движок при старте перечитает реестр сам (registry.load идемпотентен).
        registry.load(modelsDB, Utilities);
        const handlerOptions = registry.list().map(h => ({ value: h.code, caption: h.caption || h.code }));

        // ── Форма записи ──────────────────────────────────────────────────
        const serverScriptName = loadServerScript(
            'scheduler.actions',
            require('./forms/scheduler_tasks.server')(modelsDB, Utilities),
            'user'
        );

        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/scheduler_tasks.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, serverScriptName);
        const clientUID = await loadScript(clientSource, 'user');

        const recordLayout = JSON.parse(
            fs.readFileSync(path.join(__dirname, 'forms/scheduler_tasks.layout.json'), 'utf8')
        );

        // Варианты типа задачи — из реестра (в JSON их положить нельзя: состав
        // приложений известен только в рантайме).
        (function injectHandlerOptions(items) {
            if (!Array.isArray(items)) return;
            for (const it of items) {
                if (it && it.name === 'handler') it.options = handlerOptions;
                if (it && Array.isArray(it.layout)) injectHandlerOptions(it.layout);
                if (it && Array.isArray(it.tabs)) for (const t of it.tabs) injectHandlerOptions(t.layout);
            }
        })(recordLayout);

        // Владельца задачи меняет только admin: обычному пользователю поле не нужно,
        // сервер всё равно проставит его самого (см. onBeforeSave).
        const userLayout = JSON.parse(JSON.stringify(recordLayout));
        (function dropOwnerField(items) {
            if (!Array.isArray(items)) return;
            for (const it of items) {
                if (it && Array.isArray(it.layout)) {
                    it.layout = it.layout.filter(x => !(x && x.name === 'userId'));
                    dropOwnerField(it.layout);
                }
                if (it && Array.isArray(it.tabs)) for (const t of it.tabs) dropOwnerField(t.layout);
            }
        })(userLayout);

        const commonLayoutProps = {
            appName: 'uniForm',
            mode: 'record',
            tableName: 'scheduler_tasks',
            clientScript: clientUID,
            appCaption: { i18n: 'scheduler_app_caption' },
            recordCaption: { i18n: 'scheduler_task_record_caption' },
            formIcon: '/apps/general_icons/resources/public/16x16/clock.png',
            listIcon: '/apps/general_icons/resources/public/16x16/catalog.png',
            events: {
                onBeforeSave: { serverScript: serverScriptName, fn: 'onBeforeSave' },
                onReady: { fn: 'onFormReady' }
            }
        };

        await layoutMemory.saveLayout(Object.assign({}, commonLayoutProps, { roles: 'admin', layout: recordLayout }));
        await layoutMemory.saveLayout(Object.assign({}, commonLayoutProps, { roles: 'user', layout: userLayout }));

        // ── Список заданий ────────────────────────────────────────────────
        await layoutMemory.saveLayout({
            appName: 'uniForm',
            mode: 'list',
            tableName: 'scheduler_tasks',
            roles: '*',
            layout: require('./forms/scheduler_tasks_list.layout.json'),
            appCaption: { i18n: 'scheduler_app_caption' },
            listIcon: '/apps/general_icons/resources/public/16x16/catalog.png'
        });
        layoutMemory.registerListSort('scheduler_tasks', [{ field: 'number', order: 'desc' }]);

        // ── Журнал запусков (только чтение) ───────────────────────────────
        await layoutMemory.saveLayout({
            appName: 'uniForm',
            mode: 'list',
            tableName: 'scheduler_runs',
            roles: '*',
            layout: require('./forms/scheduler_runs_list.layout.json'),
            appCaption: { i18n: 'scheduler_runs_app_caption' },
            recordCaption: { i18n: 'scheduler_runs_record_caption' },
            formIcon: '/apps/general_icons/resources/public/16x16/document.png',
            listIcon: '/apps/general_icons/resources/public/16x16/journal.png'
        });
        layoutMemory.registerListSort('scheduler_runs', [{ field: 'number', order: 'desc' }]);

        // ── Пункты главного меню ──────────────────────────────────────────
        const mainMenu = require('../main_menu/server.js');
        mainMenu.addMenuItems([{
            id: 'main',
            items: [{
                caption: { i18n: 'scheduler_app_caption' },
                action: 'open',
                singleton: true,
                appName: 'uniForm',
                order: 90,
                icon: '/apps/general_icons/resources/public/16x16/clock.png',
                params: { mode: 'list', dbTable: 'scheduler_tasks' }
            }, {
                caption: { i18n: 'scheduler_runs_app_caption' },
                action: 'open',
                singleton: true,
                appName: 'uniForm',
                order: 91,
                icon: '/apps/general_icons/resources/public/16x16/journal.png',
                params: { mode: 'list', dbTable: 'scheduler_runs' }
            }]
        }]);

        console.log('[scheduler/init] Layouts registered');
    } catch (e) {
        console.error('[scheduler/init] Failed:', e && e.message || e);
    }
};
