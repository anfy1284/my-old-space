const global = require('../../drive_root/globalServerContext');
const { modelsDB } = global;

// Get settings schema and user values from DB
async function getSettings(params, sessionID) {
    try {
        if (!modelsDB || !modelsDB.UserSettingsFields) {
            console.error('[UserSettings] Models not available. modelsDB:', !!modelsDB);
            if (modelsDB) {
                console.error('[UserSettings] Available models:', Object.keys(modelsDB).join(', '));
            }
            return { error: 'Database models not available' };
        }

        // Get user from session
        const user = await global.getUserBySessionID(sessionID);
        if (!user) {
            return { error: 'User not authorized' };
        }

        console.log('[UserSettings] Loading settings for user:', user.name, 'id:', user.id);

        // Load all settings fields with type information
        const settingsFields = await modelsDB.UserSettingsFields.findAll({
            include: [{
                model: modelsDB.UserSettingsTypes,
                as: 'type',
                attributes: ['id', 'name', 'valueTableName']
            }],
            order: [['id', 'ASC']]
        });

        // Build fields array
        const fields = [];
        for (const field of settingsFields) {
            const typeId = field.typeId;
            const fieldData = {
                id: field.id,
                name: field.name, // Original name for data keys
                displayName: field.displayName, // Display name for UI labels
                typeId: typeId
            };

            // Add options for enum type
            if (typeId === 5 && field.options) {
                fieldData.options = field.options; // Already JSON in SQLite
            }

            // Get value table name from type
            const valueTableName = field.type ? field.type.valueTableName : null;
            if (!valueTableName) {
                console.warn('[UserSettings] No valueTableName for field:', field.name);
                fieldData.value = null;
                fields.push(fieldData);
                continue;
            }

            // Convert table name to model name (e.g. user_settings_string_values -> UserSettingsStringValues)
            const modelName = valueTableName.split('_').map(part =>
                part.charAt(0).toUpperCase() + part.slice(1)
            ).join('');

            // Load user value from appropriate table
            let value = null;
            if (modelsDB[modelName]) {
                const record = await modelsDB[modelName].findOne({
                    where: { userId: user.id, settingsFieldId: field.id }
                });
                value = record ? record.value : (typeId === 3 ? false : null);
                console.log('[UserSettings] Field:', field.name, '| Model:', modelName, '| Value:', value);
            } else {
                console.warn('[UserSettings] Model not found:', modelName);
            }

            fieldData.value = value;
            fields.push(fieldData);
        }

        return {
            fields,
            userName: user.name
        };
    } catch (e) {
        console.error('[UserSettings] getSettings error:', e);
        return { error: e.message };
    }
}

// Save settings values to DB
async function saveSettings(params, sessionID) {
    try {
        if (!modelsDB || !modelsDB.UserSettingsFields) {
            return { error: 'Database models not available' };
        }

        // Get user from session
        const user = await global.getUserBySessionID(sessionID);
        if (!user) {
            return { error: 'User not authorized' };
        }

        console.log('[UserSettings] Saving settings for user:', user.name, params);

        // Load all settings fields with type information
        const settingsFields = await modelsDB.UserSettingsFields.findAll({
            include: [{
                model: modelsDB.UserSettingsTypes,
                as: 'type',
                attributes: ['id', 'name', 'valueTableName']
            }]
        });

        // Map by name only
        const fieldMap = {};
        settingsFields.forEach(f => {
            fieldMap[f.name] = f;
        });

        // Save each setting
        for (const [fieldName, value] of Object.entries(params)) {
            const field = fieldMap[fieldName];
            if (!field) {
                console.warn('[UserSettings] Unknown field:', fieldName);
                continue;
            }

            const valueTableName = field.type ? field.type.valueTableName : null;
            if (!valueTableName) {
                console.warn('[UserSettings] No valueTableName for field:', field.name);
                continue;
            }

            // Convert table name to model name
            const modelName = valueTableName.split('_').map(part =>
                part.charAt(0).toUpperCase() + part.slice(1)
            ).join('');

            if (!modelsDB[modelName]) {
                console.warn('[UserSettings] Model not found:', modelName);
                continue;
            }

            // Prepare value based on type
            let preparedValue = value;
            const typeId = Number(field.typeId);
            if (typeId === 2) {
                // Number: parse and handle invalid numbers (avoid NaN stored in DB)
                if (value === null || value === undefined || value === '') {
                    preparedValue = null;
                } else {
                    const num = (typeof value === 'number') ? value : Number(value);
                    if (!Number.isFinite(num)) {
                        console.warn('[UserSettings] Invalid number value for field:', field.name, value);
                        preparedValue = null;
                    } else {
                        preparedValue = num;
                    }
                }
            } else if (typeId === 3) {
                // Boolean
                preparedValue = value === true || value === 'true';
            } else if (field.typeId === 4) {
                // Date - validate and handle empty/invalid dates
                if (!value || value === '' || value === 'Invalid date') {
                    preparedValue = null;
                } else {
                    const date = new Date(value);
                    if (isNaN(date.getTime())) {
                        console.warn('[UserSettings] Invalid date value for field:', field.name, value);
                        preparedValue = null;
                    } else {
                        preparedValue = date;
                    }
                }
            } else {
                // String
                preparedValue = String(value);
            }

            // Upsert value
            await modelsDB[modelName].upsert({
                userId: user.id,
                settingsFieldId: field.id,
                value: preparedValue
            });
        }

        console.log('[UserSettings] Settings saved successfully');
        return { success: true };
    } catch (e) {
        console.error('[UserSettings] saveSettings error:', e);
        return { error: e.message };
    }
}

module.exports = {
    getSettings,
    saveSettings
};
