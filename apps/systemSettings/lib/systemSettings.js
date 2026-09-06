'use strict';

/**
 * Чтение системных настроек серверным кодом.
 *
 * Третий уровень настроек рядом с уже существующими: настройки ПОЛЬЗОВАТЕЛЯ
 * (apps/UserSettings) и настройки ОРГАНИЗАЦИИ (apps/organizationSettings).
 * Системные — общие для всей инсталляции и правит их только администратор:
 * сроки хранения, лимиты, поведение механизмов ядра.
 *
 * ── Где живёт значение по умолчанию ──────────────────────────────────────────
 * НЕ в коде. Значение по умолчанию — часть ОПИСАНИЯ настройки и лежит в
 * `system_settings_fields.options.default` (db/defaultValues.json). Причина
 * практическая: строки `defaultValues.json` пересеваются при КАЖДОМ старте
 * (createDB.js обновляет предопределённые записи по UID), поэтому засеять
 * значение в таблицу значений нельзя — пересев вернул бы 30 поверх правки
 * администратора при первом же перезапуске. Описание настройки пересевать
 * можно и нужно, значение — нельзя.
 *
 * ── Почему нет кэша ──────────────────────────────────────────────────────────
 * Кэш настроек уже один раз выстрелил в этом проекте: у воркера планировщика
 * СВОЙ процесс и свой кэш, наполненный при старте, и задача неделями работала
 * по настройкам, которые администратор давно поменял (см. backup.settings.load
 * в apps/backup/scheduler.handlers.js). Системные настройки читаются редко —
 * два запроса дешевле, чем этот класс ошибок.
 */

const globalRoot = require('../../../drive_root/globalServerContext');
const log = require('../../../drive_root/log');

// PascalCase имя модели из имени таблицы:
// system_settings_number_values → SystemSettingsNumberValues
function modelNameFromTable(tableName) {
    return tableName.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/**
 * Значение системной настройки по имени.
 *
 * Обращение идёт напрямую к моделям (как в organizationSettings): это описание
 * инсталляции, а не данные арендатора, и фильтровать его по организации нечем.
 *
 * @param {string} name — имя настройки (`system_settings_fields.name`)
 * @returns {Promise<*>} значение, значение по умолчанию из описания, либо null
 */
async function get(name) {
    const modelsDB = globalRoot.modelsDB;
    if (!modelsDB || !modelsDB.SystemSettingsFields) return null;

    let field;
    try {
        field = await modelsDB.SystemSettingsFields.findOne({
            where: { name: name },
            include: [{
                model: modelsDB.SystemSettingsTypes,
                as: 'type',
                attributes: ['UID', 'name', 'valueTableName']
            }]
        });
    } catch (e) {
        log.error('[systemSettings] чтение описания настройки', name, e && e.message);
        return null;
    }
    if (!field) return null;

    const opts = field.options && typeof field.options === 'object' && !Array.isArray(field.options)
        ? field.options : null;
    const fallback = (opts && opts.default !== undefined) ? opts.default : null;

    const valueTableName = field.type ? field.type.valueTableName : null;
    if (!valueTableName) return fallback;

    const modelName = modelNameFromTable(valueTableName);
    if (!modelsDB[modelName]) {
        log.error('[systemSettings] модель значений не найдена:', modelName);
        return fallback;
    }

    try {
        const row = await modelsDB[modelName].findOne({ where: { settingsFieldId: field.UID } });
        if (!row || row.value === null || row.value === undefined || row.value === '') return fallback;
        return row.value;
    } catch (e) {
        log.error('[systemSettings] чтение значения настройки', name, e && e.message);
        return fallback;
    }
}

/**
 * Числовая системная настройка. `fallback` — последняя линия обороны на случай,
 * когда описания настройки в базе нет вовсе (не досеялось, чужая инсталляция):
 * механизм обязан продолжить работать, а не встать.
 */
async function getNumber(name, fallback) {
    const raw = await get(name);
    const num = (typeof raw === 'number') ? raw : Number(raw);
    if (Number.isFinite(num)) return num;
    return (fallback === undefined) ? null : fallback;
}

module.exports = { get, getNumber };
