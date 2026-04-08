'use strict';

/**
 * fileStore.js — хранилище клиентских файлов в MemoryStore.
 *
 * Публичный API:
 *   loadFile(text, role, fileType)  → Promise<uid>
 *   loadScript(text, role)          → Promise<uid>
 *   getFile(uid, userRole)          → string | null
 */

const memoryStore = require('./memory_store');
const { generateUID } = require('./db/utilites');

const FILE_STORE_NS = 'client_files';

/**
 * Проверка доступа: есть ли у пользователя требуемая роль.
 * userRole может быть строкой или массивом строк (несколько ролей).
 * admin всегда имеет доступ.
 * @param {string|string[]} userRole   - Роль(и) текущего пользователя
 * @param {string} requiredRole        - Роль, необходимая для доступа к файлу
 * @returns {boolean}
 */
function hasRoleAccess(userRole, requiredRole) {
    const roles = Array.isArray(userRole) ? userRole : [userRole];
    if (roles.includes('admin')) return true;
    return roles.includes(requiredRole);
}

/**
 * Оптимизирует JS-скрипт: удаляет комментарии, схлопывает пробелы,
 * делает код нечитаемым (однострочным, без форматирования).
 * @param {string} text - Исходный JS-текст
 * @returns {string}
 */
function optimizeJS(text) {
    let result = text;

    // Удалить блочные комментарии /* ... */
    result = result.replace(/\/\*[\s\S]*?\*\//g, '');

    // Удалить однострочные комментарии // ...
    result = result.replace(/\/\/[^\n]*/g, '');

    // Заменить все последовательности пробелов/переносов/табуляций одним пробелом
    result = result.replace(/\s+/g, ' ');

    // Убрать пробелы перед и после безопасных знаков пунктуации
    result = result.replace(/ *([{}\(\)\[\];,]) */g, '$1');

    // Убрать пробелы вокруг оператора присваивания и сравнения (безопасно для JS)
    result = result.replace(/ *(===|!==|==|!=|>=|<=|=>|&&|\|\||[=+\-*%<>!&|^~?:]) */g, '$1');

    return result.trim();
}

/**
 * Переводит текст на указанный язык.
 * TODO: реализовать перевод на разные языки.
 * @param {string} text
 * @param {string|null} language - Целевой язык (например 'ru', 'en')
 * @returns {string}
 */
function translateText(text, language) {
    // TODO: реализовать перевод на разные языки
    return text;
}

/**
 * Загружает текст файла в MemoryStore.
 * Для JS — предварительно минифицирует. Затем прогоняет через переводчик.
 *
 * @param {string} text        - Текст файла (или Buffer, будет конвертирован в строку)
 * @param {string} role        - Роль пользователя, которому разрешён доступ ('admin'|'user'|'public')
 * @param {string} fileType    - Тип (расширение) файла: 'js', 'css', 'html', и т.д.
 * @returns {Promise<string>}  - UID сохранённого файла
 */
async function loadFile(text, role, fileType) {
    if (Buffer.isBuffer(text)) text = text.toString('utf8');

    let content = text;

    if (fileType === 'js') {
        content = optimizeJS(content);
    }

    // Перевод (язык пока не передаётся — TODO)
    content = translateText(content, null);

    const uid = generateUID('file_store');

    await memoryStore.set(FILE_STORE_NS, uid, {
        text: content,
        role: role,
        fileType: fileType,
    });

    return uid;
}

/**
 * Загружает JS-скрипт в MemoryStore.
 * Обёртка над loadFile с типом 'js'.
 *
 * @param {string} text   - Текст скрипта
 * @param {string} role   - Роль пользователя, которому разрешён доступ
 * @returns {Promise<string>} - UID сохранённого файла
 */
async function loadScript(text, role) {
    return loadFile(text, role, 'js');
}

/**
 * Возвращает текст файла из MemoryStore по UID с проверкой роли.
 *
 * @param {string} uid       - UID файла
 * @param {string} userRole  - Роль текущего пользователя
 * @returns {{ text: string, fileType: string } | null}
 */
function getFile(uid, userRole) {
    const entry = memoryStore.getSync(FILE_STORE_NS, uid);
    if (!entry) return null;

    if (!hasRoleAccess(userRole, entry.role)) return null;

    return { text: entry.text, fileType: entry.fileType };
}

module.exports = {
    loadFile,
    loadScript,
    getFile,
};
