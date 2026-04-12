/**
 * drive_api — системный API фреймворка, доступный клиенту.
 * Содержит только базовые утилиты, явно разрешённые для вызова через callServerMethod.
 * Произвольный доступ к серверным модулям не предоставляется.
 */
const { generateUID } = require('../../drive_root/db/utilites');

/**
 * Генерирует новый UID серверным алгоритмом (тот же что в dbGateway).
 * @param {{ tableName?: string }} params
 * @returns {{ uid: string }}
 */
async function getNewUID(params) {
    const tableName = (params && params.tableName) || 'row';
    return { uid: generateUID(tableName) };
}

module.exports = {
    getNewUID
};
