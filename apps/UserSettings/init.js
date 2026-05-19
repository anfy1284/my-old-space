'use strict';

// Точка регистрации формы настроек пользователя.
// Автоматически вызывается фреймворком при старте.
//
// UserSettings использует EAV-модель: список полей — в UserSettingsFields,
// значения — в отдельных таблицах по типу (UserSettingsStringValues и т.д.).
// Лейаут строится динамически из БД в buildLayout().
//
// Структура:
//   forms/user_settings.server.js  — модуль-фабрика RPC + buildLayout()
//   forms/user_settings.client.js  — клиентский JS (__SERVER_SCRIPT__ плейсхолдер)
//   server.js                      — чистая бизнес-логика (getSettings / saveSettings)

const path = require('path');
const fs   = require('fs');

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../');
        const layoutMemory = require('../../drive_root/layoutMemory');

        const userSettingsServer = require('./forms/user_settings.server');

        // ── Серверный скрипт ──────────────────────────────────────────────
        const serverFns = userSettingsServer(modelsDB, Utilities);
        const serverScriptName = loadServerScript('userSettings.actions', serverFns, 'user');

        // ── Клиентский скрипт ─────────────────────────────────────────────
        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/user_settings.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, serverScriptName);
        const clientUID = await loadScript(clientSource, 'user');

        // ── Лейаут (динамический, строится из UserSettingsFields) ─────────
        const layout = await userSettingsServer.buildLayout(modelsDB);

        await layoutMemory.saveLayout({
            appName:   'uniForm',
            mode:      'record',
            tableName: 'user_settings',
            roles:     'user',
            layout,
            clientScript: clientUID,
            events: {
                onLoadData: { serverScript: serverScriptName, fn: 'onLoadData' },
                onSave:     { serverScript: serverScriptName, fn: 'onSave' }
            }
        });

        console.log('[UserSettings/init] Layout registered');
    } catch (e) {
        console.error('[UserSettings/init] Failed:', e && e.message || e);
    }
};

