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
                    type: "tabs",
                    tabs: [
                        {
                            caption: "Поля",
                            layout: [
                                {
                                    type: "group",
                                    caption: "Настройка колонок",
                                    layout: []
                                }
                            ]
                        },
                        {
                            caption: "Фильтры",
                            layout: [
                                {
                                    type: "group",
                                    caption: "Условия фильтрации",
                                    layout: []
                                }
                            ]
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