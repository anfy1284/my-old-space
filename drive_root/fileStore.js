'use strict';

/**
 * fileStore.js — хранилище клиентских файлов в MemoryStore.
 *
 * Публичный API:
 *   loadFile(text, role, fileType)  → Promise<uid>
 *   loadScript(text, role)          → Promise<uid>
 *   getFile(uid, userRole)          → string | null
 */

const fs = require('fs');
const path = require('path');
const memoryStore = require('./memory_store');
const { generateUID } = require('./db/utilites');

const FILE_STORE_NS = 'client_files';

// Cache for files served from disk: key = `${filePath}|${role}|${language}` -> processed text
const _fileCache = new Map();

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
 * Оптимизирует JS-скрипт через terser.
 * @param {string} text - Исходный JS-текст
 * @returns {Promise<string>}
 */
async function optimizeJS(text) {
    try {
        const terser = require('terser');
        const result = await terser.minify(text, {
            compress: true,
            mangle: false,
            parse: { bare_returns: true }, // allow top-level return (CommonJS modules)
            output: { quote_style: 1 }, // force single quotes to preserve __t('key') pattern
        });
        if (result.error) throw result.error;
        return result.code;
    } catch (e) {
        console.warn('[optimizeJS] terser failed, returning original:', e.message);
        return text;
    }
}

/**
 * Заменяет маркеры __t('key') в JS-тексте переведёнными строками.
 * @param {string} text     - JS-текст с маркерами __t('...')
 * @param {string} language - Целевой язык (например 'ru', 'en')
 * @returns {string}
 */
function translateJsMarkers(text, language) {
    if (!text.includes('__t(')) return text;
    const i18n = require('./i18n');
    const effectiveLang = language || 'en';
    return text.replace(/__t\((['"])([^'"]+)\1\)/g, (_, _q, key) => JSON.stringify(i18n.t(key, effectiveLang)));
}

/**
 * Читает файл с диска, обрабатывает по расширению (JS: оптимизация + перевод),
 * кеширует результат по (filePath, role, language).
 * @param {string} filePath - Абсолютный путь к файлу
 * @param {string} role     - Роль пользователя (для ключа кеша)
 * @param {string} language - Язык пользователя
 * @returns {Promise<string>}
 */
async function serveFileFromPath(filePath, role, language) {
    const cacheKey = `${filePath}|${role}|${language}`;
    if (_fileCache.has(cacheKey)) return _fileCache.get(cacheKey);

    const raw = fs.readFileSync(filePath, 'utf8');
    const ext = path.extname(filePath).slice(1).toLowerCase();

    let result = raw;
    if (ext === 'js') {
        result = await optimizeJS(raw);
        result = translateJsMarkers(result, language);
    }

    _fileCache.set(cacheKey, result);
    return result;
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
        content = await optimizeJS(content);
    }

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
    translateJsMarkers,
    serveFileFromPath,
};
