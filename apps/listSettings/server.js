/**
 * Серверная часть приложения listSettings.
 * Отвечает за предоставление метаданных (layout) и данных для настройки списков.
 */
module.exports = {
    /**
     * Возвращает описание интерфейса формы настроек.
     * @returns {Object} Layout объекта формы.
     */
    getLayout: async () => {
        return {
            layout: [
                {
                    type: "group",
                    caption: "Основные параметры",
                    orientation: "vertical",
                    layout: [
                        {
                            type: "textbox",
                            caption: "Имя конфигурации (заглушка)",
                            data: "dummy_name"
                        },
                        {
                            type: "checkbox",
                            caption: "Показывать скрытые записи",
                            data: "show_hidden"
                        }
                    ]
                },
                {
                    type: "group",
                    orientation: "horizontal",
                    layout: [
                        {
                            type: "button",
                            caption: "Сохранить",
                            action: "save",
                            isStandard: false // Обработка в client.js
                        },
                        {
                            type: "button",
                            caption: "Отмена",
                            action: "cancel",
                            isStandard: true
                        }
                    ]
                }
            ]
        };
    },

    /**
     * Возвращает текущие настройки для конкретного приложения.
     * @param {Object} params - Параметры запроса (например, appName).
     * @returns {Array} Список значений полей.
     */
    getData: async (params) => {
        console.log("[listSettings] Fetching data for:", params);
        // В будущем здесь будет запрос к БД или db/settings.json
        return [
            { name: "dummy_name", value: "По умолчанию" },
            { name: "show_hidden", value: false }
        ];
    },

    /**
     * Сохраняет изменения настроек.
     */
    applyChanges: async (payload) => {
        console.log("[listSettings] Applying changes:", payload);
        // Логика сохранения в БД
        return { ok: true };
    }
};