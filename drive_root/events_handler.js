/**
 * Базовый обработчик событий фреймворка my-old-space (drive_root).
 */
const { generateUID } = require('./db/utilites');

module.exports = {
    /**
     * Инъектирует поле UID во все определения моделей, где оно отсутствует.
     * Вызывается в контексте createDB.js до инициализации Sequelize-моделей.
     */
    onModelsPostCollect: async function(context) {
        const { mergedModelsDef } = context;
        if (!Array.isArray(mergedModelsDef)) return;

        for (const def of mergedModelsDef) {
            if (!def.fields) def.fields = {};

            // Remove any other primary keys (besides UID)
            for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
                if (fieldName !== 'UID' && fieldDef && fieldDef.primaryKey) {
                    delete fieldDef.primaryKey;
                }
            }

            // Inject UID as the sole primary key if missing
            if (!def.fields.UID) {
                def.fields.UID = {
                    type: "STRING",
                    allowNull: false,
                    primaryKey: true,
                    defaultValue: "GENERATE_UID"
                };
            } else {
                def.fields.UID.primaryKey = true;
                def.fields.UID.allowNull = false;
                def.fields.UID.type = "STRING";
                if (!def.fields.UID.defaultValue) {
                    def.fields.UID.defaultValue = "GENERATE_UID";
                }
            }
        }
        console.log(`[drive_root:events_handler] UID injected into ${mergedModelsDef.length} model definitions.`);
    },

    /**
     * Добавляет поле UID во все таблицы, где оно отсутствует.
     */
    _injectUID: async function(sequelize) {
        const queryInterface = sequelize.getQueryInterface();
        const { Sequelize } = sequelize;
        
        try {
            const tables = await queryInterface.showAllTables();
            for (const tableName of tables) {
                // Пропускаем системные таблицы SQLite если нужно, но обычно обрабатываем все пользовательские
                if (tableName === 'sqlite_sequence') continue;

                const tableDesc = await queryInterface.describeTable(tableName);
                
                if (!tableDesc.UID) {
                    console.log(`[drive_root:events_handler] Adding UID column to table: ${tableName}`);
                    
                    // Добавляем колонку. Длина 16 символов.
                    await queryInterface.addColumn(tableName, 'UID', {
                        type: Sequelize.STRING(16),
                        allowNull: true, // Сначала разрешаем null для существующих данных
                    });

                    // Генерируем UID для существующих записей
                    const [records] = await sequelize.query(`SELECT "UID" FROM "${tableName}"`);
                    for (const record of records) {
                        const uid = generateUID();
                        await sequelize.query(
                            `UPDATE "${tableName}" SET "UID" = :uid WHERE id = :id`,
                            { replacements: { uid, UID: record.UID } }
                        );
                    }

                    // Делаем поле NOT NULL и UNIQUE после заполнения
                    // В некоторых диалектах изменение на NOT NULL требует разных подходов, 
                    // но для базовой реализации на текущем этапе:
                    try {
                        await queryInterface.changeColumn(tableName, 'UID', {
                            type: Sequelize.STRING(16),
                            allowNull: false,
                            unique: true
                        });
                    } catch (changeErr) {
                        console.error(`[drive_root:events_handler] Could not set UID to NOT NULL/UNIQUE on ${tableName}:`, changeErr.message);
                    }
                }
            }
        } catch (error) {
            console.error('[drive_root:events_handler] Error during UID injection:', error);
        }
    },

    /**
     * Вызывается после завершения каскадного формирования базы данных (миграций и сидов).
     * Это самый нижний уровень обработки, вызывается первым.
     * @param {Object} context - Контекст инициализации (sequelize instance и т.д.)
     */
    onDatabasePostInit: async function(context) {
        console.log('[drive_root:events_handler] Database post-initialization hook executed.');
        const { sequelize } = context;
        
        // Внедряем UID во все таблицы
        await this._injectUID(sequelize);
    },
};
