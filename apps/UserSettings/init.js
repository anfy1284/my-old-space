'use strict';

// Регистрация лейаута и серверных/клиентских скриптов для формы настроек пользователя.
// Этот файл автоматически вызывается фреймворком (drive_forms/init.js).
//
// UserSettings использует EAV-модель (Entity-Attribute-Value): список полей хранится
// в таблице UserSettingsFields, а значения — в отдельных таблицах по типу
// (UserSettingsStringValues, UserSettingsNumberValues и т.д.).
// Реальной таблицы «user_settings» в БД нет, поэтому загрузка и сохранение данных
// выполняются кастомными серверными событиями onLoadData / onSave.

module.exports = async function (modelsDB) {
    try {
        const layoutMemory = require('../../drive_root/layoutMemory');
        const { loadScript, loadServerScript } = require('../../');
        const serverModule = require('./server');

        // ─────────────────────────────────────────────────────────────────
        //  Серверный скрипт: функции формы настроек.
        //  Функции получают (params, ctx) где ctx = { sessionID }
        // ─────────────────────────────────────────────────────────────────
        const serverScriptName = loadServerScript('userSettings.actions', {

            // Загрузка данных формы (вызывается из generateFormSpec через onLoadData)
            async onLoadData({ tableName, params }, ctx) {
                const result = await serverModule.getSettings(params, ctx.sessionID);
                if (result.error) return { data: [] };

                const data = [];
                if (result.fields) {
                    for (const field of result.fields) {
                        const item = { name: field.name, value: field.value, tabularSection: false };
                        // Для ссылочных полей добавляем selection с отображаемым значением
                        if (field.referenceDisplay !== undefined && field.value) {
                            item.selection = { id: field.value, display: field.referenceDisplay };
                        }
                        data.push(item);
                    }
                }

                return {
                    data: data,
                    caption: 'Настройки пользователя' + (result.userName ? ' — ' + result.userName : '')
                };
            },

            // Сохранение данных формы (вызывается из applyChanges через onSave)
            async onSave({ changes, tableName }, ctx) {
                const result = await serverModule.saveSettings(changes, ctx.sessionID);
                if (result.error) return { ok: false, error: result.error };
                return { ok: true };
            }

        }, 'user');

        // ─────────────────────────────────────────────────────────────────
        //  Клиентские функции формы настроек.
        //  serverUID встраивается в текст скрипта при загрузке (template literal).
        //  callServer() — глобальный хелпер, доступен в любом клиентском скрипте.
        // ─────────────────────────────────────────────────────────────────
        const clientUID = await loadScript(`
            async function saveAndClose(ev, ctx) {
                var form = ctx.form;
                var data = form.collectData();
                var result = await callServer('${serverScriptName}', 'onSave', { changes: data, tableName: 'user_settings' });
                if (result && result.error) {
                    showAlert('Ошибка: ' + result.error);
                    return;
                }
                form._modified = false;
                form.close();
            }

            async function applySettings(ev, ctx) {
                var form = ctx.form;
                var data = form.collectData();
                var result = await callServer('${serverScriptName}', 'onSave', { changes: data, tableName: 'user_settings' });
                if (result && result.error) {
                    showAlert('Ошибка: ' + result.error);
                    return;
                }
                form.setModified(false);
                showAlert('Настройки сохранены');
            }

            function cancelSettings(ev, ctx) {
                ctx.form._modified = false;
                ctx.form.close();
            }

            return { saveAndClose, applySettings, cancelSettings };
        `, 'user');

        // ─────────────────────────────────────────────────────────────────
        //  Построение layout на основе полей настроек из БД.
        //
        //  Поля загружаются при старте сервера из таблицы UserSettingsFields.
        //  Тип контрола определяется по typeId:
        //    1 = string  → textbox
        //    2 = number  → textbox
        //    3 = boolean → checkbox
        //    4 = date    → date
        //    5 = enum    → emunList (закрытый список)
        // ─────────────────────────────────────────────────────────────────
        const settingsFields = await modelsDB.UserSettingsFields.findAll({
            include: [{
                model: modelsDB.UserSettingsTypes,
                as: 'type',
                attributes: ['UID', 'name', 'valueTableName']
            }],
            order: [['UID', 'ASC']]
        });

        const controls = [];
        for (const field of settingsFields) {
            const typeName = field.type ? field.type.name : '';
            const ctrl = {
                name: field.name,
                data: field.name,
                caption: field.displayName || field.name
            };

            // Ссылочное поле (options содержит referenceTable) → recordSelector
            const opts = field.options;
            if (opts && typeof opts === 'object' && !Array.isArray(opts) && opts.referenceTable) {
                ctrl.type = 'recordSelector';
                ctrl.properties = {
                    showSelectionButton: true,
                    selection: {
                        table: opts.referenceTable,
                        idField: 'UID',
                        displayField: opts.displayField || 'name'
                    }
                };
            } else if (typeName === 'boolean') {
                ctrl.type = 'checkbox';
            } else if (typeName === 'date') {
                ctrl.type = 'date';
            } else if (typeName === 'enum' && field.options) {
                ctrl.type = 'emunList';
                const enumOpts = Array.isArray(field.options) ? field.options :
                    (typeof field.options === 'string' ? JSON.parse(field.options) : []);
                ctrl.options = enumOpts.map(function (o) { return { value: o, caption: o }; });
            } else {
                ctrl.type = 'textbox';
            }

            controls.push(ctrl);
        }

        const settingsLayout = [
            {
                type: 'group',
                caption: 'Настройки пользователя',
                orientation: 'vertical',
                layout: controls
            },
            {
                type: 'group',
                caption: '',
                orientation: 'horizontal',
                layout: [
                    {
                        type: 'button',
                        name: 'btnOK',
                        caption: 'OK',
                        icon: '/apps/general_icons/resources/public/16x16/save.png',
                        events: { onClick: 'saveAndClose' }
                    },
                    {
                        type: 'button',
                        name: 'btnApply',
                        caption: 'Применить',
                        icon: '/apps/general_icons/resources/public/16x16/save.png',
                        events: { onClick: 'applySettings' }
                    },
                    {
                        type: 'button',
                        name: 'btnCancel',
                        caption: 'Отмена',
                        icon: '/apps/general_icons/resources/public/16x16/cancel.png',
                        events: { onClick: 'cancelSettings' }
                    }
                ]
            }
        ];

        await layoutMemory.saveLayout({
            appName: 'uniForm',
            mode:    'record',
            tableName: 'user_settings',
            roles: 'user',
            layout: settingsLayout,
            clientScript: clientUID,
            events: {
                onLoadData: { serverScript: serverScriptName, fn: 'onLoadData' },
                onSave:     { serverScript: serverScriptName, fn: 'onSave' }
            }
        });

        console.log('[UserSettings/init] Layout registered for uniForm');
        console.log('[UserSettings/init] serverScriptName:', serverScriptName);
        console.log('[UserSettings/init] clientUID:', clientUID);
    } catch (e) {
        console.error('[UserSettings/init] Failed to register layouts:', e && e.message || e);
    }
};
