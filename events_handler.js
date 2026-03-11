const { generateUID } = require('./drive_root/db/utilites');

/**
 * Базовый файл обработки событий фреймворка my-old-space.
 * Методы этого файла вызываются ПЕРЕД методами аналогичного файла проекта.
 */

module.exports = {
    /**
     * Вызывается после сбора всех определений моделей, но до инициализации Sequelize.
     * Позволяет модифицировать mergedModelsDef (поля, опции и т.д.)
     * @param {Object} context - { mergedModelsDef, allAssociations, sequelize, projectRoot }
     */
    onModelsPostCollect: async (context) => {
        const { mergedModelsDef } = context;
        if (!mergedModelsDef) return;

        for (const modelDef of mergedModelsDef) {
            if (modelDef.fields) {
                // 1. Проверяем, есть ли уже поле UID
                const hasUID = !!modelDef.fields.UID;

                // 2. Убираем признак primaryKey у всех существующих полей
                for (const fieldName in modelDef.fields) {
                    if (fieldName === 'UID') continue; // Не трогаем, если оно уже есть
                    if (modelDef.fields[fieldName].primaryKey) {
                        modelDef.fields[fieldName].primaryKey = false;
                    }
                }

                // 3. Добавляем или обновляем поле UID как Primary Key
                if (!hasUID) {
                    modelDef.fields.UID = {
                        type: 'STRING',
                        primaryKey: true,
                        allowNull: false,
                        defaultValue: () => generateUID(modelDef.name)
                    };
                } else {
                    // Если поле было, гарантируем, что оно PK
                    modelDef.fields.UID.primaryKey = true;
                    modelDef.fields.UID.allowNull = false;
                    if (!modelDef.fields.UID.defaultValue) {
                        modelDef.fields.UID.defaultValue = () => generateUID(modelDef.name);
                    }
                }

            }
        }
    },

    /**
     * Вызывается после завершения инициализации базы данных.
     * @param {Object} context - { sequelize, projectRoot, level }
     */
    onDatabasePostInit: async (context) => {
        // console.log('[framework:events_handler] Database post-initialization hook executed.');
    }
};
