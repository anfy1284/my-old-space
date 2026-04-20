/**
 * UserSettings — клиентский дескриптор приложения.
 * Делегирует отображение формы в uniRecordForm.
 * Лейаут, серверные и клиентские скрипты зарегистрированы в init.js.
 */

try {
    (async function () {
        var APP_NAME = 'UserSettings';

        var app = new App(APP_NAME, { config: { allowMultipleInstances: false } });

        app.createInstance = async function (params) {
            var instanceId = this.generateInstanceId();

            // Открываем uniRecordForm с виртуальной таблицей user_settings.
            // generateFormSpec найдёт кастомный лейаут из layoutMemory,
            // данные загрузит через событие onLoadData.
            var formId = await window.MySpace.open('uniRecordForm', { tableName: 'user_settings' });

            return {
                id: instanceId,
                appName: APP_NAME,
                _formId: formId,
                onOpen: async function () {
                    // Повторное открытие: uniRecordForm мог быть закрыт, открываем заново
                    this._formId = await window.MySpace.open('uniRecordForm', { tableName: 'user_settings' });
                },
                destroy: function () {}
            };
        };

        try { app.register(); } catch (e) { console.error('[UserSettings] Failed to register:', e); }

        console.log('[UserSettings] Client descriptor registered (delegates to uniRecordForm)');
    })();
} catch (error) {
    console.error('[UserSettings] Error initializing client descriptor:', error);
}
