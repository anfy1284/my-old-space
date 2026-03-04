// Project: my-old-space
// App: listSettings
// Description: Client-side logic for list settings form.

(function() {
    const APP_NAME = "listSettings";

    // Создаем дескриптор приложения
    const descriptor = {
        config: {
            allowMultipleInstances: true
        },

        /**
         * Фабрика создания экземпляров приложения.
         * @param {Object} params - Параметры открытия (appName, title).
         */
        createInstance: async function(params) {
            console.log("[listSettings] Creating instance with params:", params);
            
            // Создаем стандартную DataForm для этого приложения
            const appForm = new DataForm(APP_NAME);
            appForm.setWidth(400);
            appForm.setHeight(300);
            appForm.setModal(true); // настройки обычно модальные

            const instance = {
                appName: APP_NAME,
                form: appForm,

                /**
                 * Вызывается фреймворком при открытии.
                 */
                onOpen: async (openParams) => {
                    console.log("[listSettings] Opening for app:", openParams.appName);

                    // Устанавливаем заголовок
                    const targetTitle = openParams.title || openParams.appName || "списка";
                    appForm.setTitle("Настройки: " + targetTitle);

                    // Сохраняем контекст вызывающего приложения
                    appForm.params = openParams;

                    // Отрисовка формы (DataForm сама загрузит layout/data через callServerMethod)
                    // Важно: передаем openParams, чтобы сервер знал для какого приложения грузить данные
                    appForm.getLayoutWithData = async function() {
                        return await callServerMethod(APP_NAME, 'getLayoutWithData', openParams);
                    };

                    await appForm.Draw();
                },

                /**
                 * Обработка действий внутри формы.
                 */
                onAction: async (action, actionParams) => {
                    if (action === "save") {
                        const data = appForm.collectData();
                        console.log("[listSettings] Saving settings for " + appForm.params.appName + ":", data);
                        
                        try {
                            const res = await callServerMethod(APP_NAME, "applyChanges", { 
                                app: appForm.params.appName, 
                                changes: data 
                            });
                            
                            if (res && res.ok) {
                                appForm.setModified(false);
                                appForm.close();
                            } else {
                                alert("Ошибка сохранения: " + (res.error || "неизвестная ошибка"));
                            }
                        } catch (e) {
                            alert("Ошибка связи с сервером: " + e.message);
                        }
                        return true;
                    }
                },

                /**
                 * Очистка при закрытии.
                 */
                destroy: () => {
                    if (appForm) appForm.close();
                }
            };

            // Связываем форму с инстансом для doAction forwarding
            appForm.instance = instance;

            // Сразу инициируем открытие
            await instance.onOpen(params);

            return instance;
        }
    };

    // Регистрируем приложение в глобальном реестре MySpace
    if (window.MySpace) {
        window.MySpace.register(APP_NAME, descriptor);
        console.log("[listSettings] Registered in MySpace");
    } else {
        console.error("[listSettings] Critical error: window.MySpace not found!");
    }
})();