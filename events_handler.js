/**
 * Файл для обработки событий фреймворка my-old-space.
 * Сюда будут добавляться обработчики жизненного цикла приложений, 
 * событий форм и взаимодействия с данными.
 */

const path = require('path');

// Placeholder для будущих обработчиков
module.exports = {
    /**
     * Вызывается после сбора и слияния моделей, но до инициализации в Sequelize.
     * @param {Object} context - { mergedModelsDef, allAssociations, sequelize, projectRoot }
     */
    onModelsPostCollect: async (context) => {
        const { mergedModelsDef, projectRoot } = context;
        if (!mergedModelsDef) return;

        const fs = require('fs');
        let requiredFields = [];
        let excludedTables = [];

        // Загружаем настройки из app.config.json в проекте
        if (projectRoot) {
            const configPath = path.join(projectRoot, 'app.config.json');
            if (fs.existsSync(configPath)) {
                try {
                    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    requiredFields = config.required_access_fields || [];
                    excludedTables = config.excluded_tables || [];
                } catch (e) {
                    console.error(`[events_handler] Error reading app.config.json: ${e.message}`);
                }
            }
        }

        const missingFieldsTables = [];

        for (const def of mergedModelsDef) {
            // Валидация наличия хотя бы одного из обязательных реквизитов
            if (requiredFields.length > 0 && !excludedTables.includes(def.tableName)) {
                const hasRequiredField = requiredFields.some(field => def.fields && def.fields[field]);
                if (!hasRequiredField) {
                    missingFieldsTables.push(def.tableName);
                }
            }
        }

        if (missingFieldsTables.length > 0) {
            console.error('\x1b[31m%s\x1b[0m', '----------------------------------------------------------');
            console.error('\x1b[31m%s\x1b[0m', '[FRAMEWORK ERROR] Ошибка валидации обязательных реквизитов!');
            console.error('\x1b[31m%s\x1b[0m', `Таблицы должны содержать хотя бы один из: ${requiredFields.join(', ')}`);
            console.error('\x1b[31m%s\x1b[0m', 'Следующие таблицы не прошли проверку:');
            missingFieldsTables.forEach(table => console.error('\x1b[31m%s\x1b[0m', ` - ${table}`));
            console.error('\x1b[31m%s\x1b[0m', 'Исправьте модели или исключите таблицы. Остановка сервера...');
            console.error('\x1b[31m%s\x1b[0m', '----------------------------------------------------------');
            process.exit(1);
        }

        for (const def of mergedModelsDef) {
            // Удаляем старые primaryKey у всех полей
            for (const [fieldName, fieldDef] of Object.entries(def.fields || {})) {
                if (fieldName !== 'UID' && fieldDef.primaryKey) {
                    delete fieldDef.primaryKey;
                }
            }

            // Энжектим UID как единственный Primary Key  
            if (!def.fields) def.fields = {};
            
            // Функция генерации UID
            const uidGenerator = function() {
                try {
                    // Используем путь относительно этого файла или абсолютный путь в рамках фреймворка
                    const util = require('./drive_root/db/utilites');
                    return util.generateUID(def.name || def.tableName || 'model');
                } catch(e) {
                    const crypto = require('crypto');
                    const time = Date.now().toString(36).padStart(9, '0').slice(-9);
                    const hash = '0000000';
                    const random = crypto.randomBytes(6).readUIntBE(0, 6).toString(36).padStart(7, '0').slice(-7);
                    return `${time}-${hash}-${random}`;
                }
            };

            if (!def.fields.UID) {
                def.fields.UID = {
                    type: "STRING",
                    allowNull: false,
                    primaryKey: true,
                    defaultValue: uidGenerator
                };
            } else {
                def.fields.UID.primaryKey = true;
                def.fields.UID.allowNull = false;
                def.fields.UID.type = "STRING";
                if (!def.fields.UID.defaultValue || def.fields.UID.defaultValue === "GENERATE_UID") {
                    def.fields.UID.defaultValue = uidGenerator;
                }
            }
        }
        console.log('[Framework events_handler] Models post-collect hook executed. UID injected.');
    },

    /**
     * Вызывается после завершения каскадного формирования базы данных (миграций и сидов).
     * @param {Object} context - Контекст инициализации (sequelize instance и т.д.)
     */
    onDatabasePostInit: async (context) => {
        console.log('[Framework events_handler] Database post-initialization hook executed.');
    },
};
