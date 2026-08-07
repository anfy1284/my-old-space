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

// 0.3 (оптимизация): раздельный кэш минификации и перевода с инвалидацией по mtime.
//  _minCache:  filePath          → { mtimeMs, text }  — минифицированный (или сырой) базовый текст
//  _langCache: `${filePath}|${language}` → { mtimeMs, text } — базовый + наложенный перевод __t()
// Минификация НЕ зависит от языка/роли (зависит только перевод!), поэтому базовый
// текст кэшируется один раз на файл. Раньше ключ был filePath|role|language —
// терсер гонялся заново для каждого языка/роли, а кэш был вечным (правка файла
// требовала рестарта).
const _minCache = new Map();
const _langCache = new Map();

// Тексты уже переведены под язык, а переводы (справочник `languages`, строки i18n
// реестра) относятся к прежней базе. Подписка — рядом с кэшем; см. dbLifecycle.
require('./dbLifecycle').onDatabaseReset('fileStore', () => {
    _minCache.clear();
    _langCache.clear();
});

// На слабом CPU terser (особенно для UI_classes.js ~505KB) — секунды чистого CPU
// и блокировка event loop. После внедрения gzip (0.4) минификация даёт мало:
// gzip жмёт сильнее и на порядок дешевле. Поэтому в рантайме по умолчанию НЕ
// минифицируем; включить — MINIFY_JS=1.
const MINIFY_JS = process.env.MINIFY_JS === '1';

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
    // mtime файла — ключ инвалидации: правка файла больше не требует рестарта.
    // 5.6: async-I/O вместо statSync/readFileSync — не блокируем event loop на
    // медленном диске (особенно крупный UI_classes.js). Функция уже async.
    let mtimeMs;
    try {
        mtimeMs = (await fs.promises.stat(filePath)).mtimeMs;
    } catch (e) {
        mtimeMs = 0;
    }

    const ext = path.extname(filePath).slice(1).toLowerCase();

    // Не-JS: ни минификации, ни перевода — отдаём сырой текст (кэш базы).
    if (ext !== 'js') {
        const base = _minCache.get(filePath);
        if (base && base.mtimeMs === mtimeMs) return base.text;
        const raw = await fs.promises.readFile(filePath, 'utf8');
        _minCache.set(filePath, { mtimeMs, text: raw });
        return raw;
    }

    // JS: уровень 2 — готовый (база + перевод) по языку.
    const langKey = `${filePath}|${language}`;
    const cachedLang = _langCache.get(langKey);
    if (cachedLang && cachedLang.mtimeMs === mtimeMs) return cachedLang.text;

    // Уровень 1 — базовый текст (минифицированный или сырой), один на файл.
    let base = _minCache.get(filePath);
    if (!base || base.mtimeMs !== mtimeMs) {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        const text = MINIFY_JS ? await optimizeJS(raw) : raw;
        base = { mtimeMs, text };
        _minCache.set(filePath, base);
    }

    // Перевод __t() накладываем поверх базы и кэшируем по языку.
    const out = translateJsMarkers(base.text, language);
    _langCache.set(langKey, { mtimeMs, text: out });
    return out;
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
