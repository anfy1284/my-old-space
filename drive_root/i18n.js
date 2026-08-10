/**
 * i18n — internationalization registry for server-side translations.
 *
 * Usage:
 *   const { t } = require('./i18n');
 *   return { error: t('User not authorized', langCode) };
 *
 * Cascade load order (later files override earlier keys):
 *   drive_root/i18n.json
 *   → drive_forms/i18n.json
 *   → framework apps/<name>/i18n.json
 *   → project apps/<name>/i18n.json
 *   → project root i18n.json
 *
 * i18n.json format:
 * {
 *   "English key or semantic_key": {
 *     "en": "English string",
 *     "ru": "Русская строка",
 *     "de": "Deutsches Wort"
 *   }
 * }
 *
 * Base language is English. If a key has no entry in the registry,
 * the key itself is returned (graceful fallback).
 */

const fs = require('fs');
const path = require('path');

// Registry: { key: { langCode: translatedString } }
let _registry = {};

/**
 * Cascade-load all i18n.json files into the registry.
 * Must be called once at server startup (e.g. from drive_forms/init.js).
 * @param {string} [projectRoot] - absolute path to project root
 */
function loadI18n(projectRoot) {
    _registry = {};
    const filesToLoad = [];

    // 1. drive_root
    filesToLoad.push(path.join(__dirname, 'i18n.json'));

    // 2. drive_forms (appDir)
    try {
        const config = require(path.join(__dirname, '..', 'server.config.json'));
        const appDir = path.join(__dirname, '..', config.appDir);
        filesToLoad.push(path.join(appDir, 'i18n.json'));
    } catch (e) {
        console.error('[i18n] Could not resolve drive_forms path:', e.message);
    }

    // 3. Framework apps (in package/apps/)
    const fwAppsDir = path.join(__dirname, '..', 'apps');
    if (fs.existsSync(fwAppsDir)) {
        for (const appName of fs.readdirSync(fwAppsDir)) {
            const appI18nPath = path.join(fwAppsDir, appName, 'i18n.json');
            filesToLoad.push(appI18nPath);
        }
    }

    // 4. Project apps
    if (projectRoot) {
        try {
            const projectAppsJson = path.join(projectRoot, 'apps.json');
            if (fs.existsSync(projectAppsJson)) {
                const cfg = JSON.parse(fs.readFileSync(projectAppsJson, 'utf8'));
                const appsPath = (cfg.path || 'apps').replace(/^[/\\]+/, '');
                for (const app of (cfg.apps || [])) {
                    filesToLoad.push(path.join(projectRoot, appsPath, app.name, 'i18n.json'));
                }
            }
        } catch (e) {
            console.error('[i18n] Could not scan project apps:', e.message);
        }

        // 5. Project root i18n.json (lowest priority override for project-wide keys)
        filesToLoad.push(path.join(projectRoot, 'i18n.json'));
    }

    // Load and merge all files
    for (const filePath of filesToLoad) {
        if (!fs.existsSync(filePath)) continue;
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            for (const [key, translations] of Object.entries(data)) {
                if (!_registry[key]) _registry[key] = {};
                Object.assign(_registry[key], translations);
            }
            console.log(`[i18n] Loaded: ${filePath}`);
        } catch (e) {
            console.error(`[i18n] Error loading ${filePath}:`, e.message);
        }
    }

    console.log(`[i18n] Registry built: ${Object.keys(_registry).length} keys`);
}

/**
 * Translate a key to the target language.
 * Fallback chain: targetLang → 'en' → key itself
 * @param {string} key - translation key (English string or semantic key like 'save_button')
 * @param {string} [langCode='en'] - target language code
 * @returns {string}
 */
function t(key, langCode = 'en') {
    const entry = _registry[key];
    if (!entry) return key;
    const val = entry[langCode] || entry['en'] || key;
    // Значение с формами числа (объект) без счётчика показать нельзя — вернуть
    // «[object Object]» хуже, чем ключ: ключ хотя бы виден как незакрытый перевод.
    if (val && typeof val === 'object') return pickPluralForm(val, 1, langCode) || key;
    return val;
}

// ── Формы числа ──────────────────────────────────────────────────────
// Значение перевода может быть не строкой, а объектом форм:
//   "guests_count": {
//     "de": { "one": "{{count}} Gast",  "other": "{{count}} Gäste" },
//     "ru": { "one": "{{count}} гость", "few": "{{count}} гостя", "many": "{{count}} гостей" }
//   }
// Категорию выбирает `Intl.PluralRules` — она встроена в Node и знает правила
// каждого языка: у de/en две формы (one/other), у ru/pl четыре (one/few/many/other),
// причём «21 гость» относится к `one`, а «22 гостя» — к `few`. Написать это
// условиями на `count % 10` в прикладном коде — значит завести свою копию правил
// для каждого нового языка.
//
// Зачем вообще: без форм числа приходится либо печатать безграмотное «1 Gäste»,
// либо подменять существительное сокращением («2 Pers.», «3 ÜN»), которое
// склонения не требует. Второе и есть причина, по которой в счёте стояло «Pers.»
// вместо человеческого слова. Документ — лицо организации, в нём это заметно.
//
// Обратная совместимость: строковые значения (подавляющее большинство ключей)
// проходят прежним путём, `count` для них не нужен.
const _pluralRules = {};
function pluralCategory(count, langCode) {
    try {
        const pr = _pluralRules[langCode] || (_pluralRules[langCode] = new Intl.PluralRules(langCode));
        return pr.select(Number(count));
    } catch (_) {
        // Неизвестный язык — не повод падать: две формы покрывают большинство.
        return Number(count) === 1 ? 'one' : 'other';
    }
}

// Выбор формы с деградацией: точная категория → other → one → любая заданная.
// Автор перевода не обязан заполнять все категории своего языка (в русском
// `other` возникает только у дробных), и отсутствие одной не должно давать пустоту.
function pickPluralForm(forms, count, langCode) {
    const cat = pluralCategory(count, langCode);
    if (forms[cat] != null) return forms[cat];
    if (forms.other != null) return forms.other;
    if (forms.one != null) return forms.one;
    const first = Object.keys(forms)[0];
    return first != null ? forms[first] : null;
}

/**
 * Translate a key and substitute named placeholders {{varName}}.
 * Example: tf('row_field_required', 'ru', { row: 3, section: 'booking_rooms', field: 'roomId' })
 *
 * Формы числа: если значение ключа — объект форм, категорию выбирает переменная
 * `count` (`{ count: 1 }` → «1 Gast», `{ count: 2 }` → «2 Gäste»). Имя переменной
 * фиксированное: иначе каждый ключ пришлось бы сопровождать указанием, что в нём
 * считается, и рано или поздно они разошлись бы.
 *
 * @param {string} key
 * @param {string} [langCode='en']
 * @param {Object} [vars={}] — `count` дополнительно управляет выбором формы числа
 * @returns {string}
 */
function tf(key, langCode = 'en', vars = {}) {
    const entry = _registry[key];
    const raw = entry ? (entry[langCode] || entry['en']) : null;
    let str = (raw && typeof raw === 'object')
        ? (pickPluralForm(raw, vars.count != null ? vars.count : 1, langCode) || key)
        : t(key, langCode);
    // 5.7: split/join вместо `new RegExp` на каждую подстановку — без компиляции
    // регулярки и без экранирования спецсимволов в имени переменной.
    for (const [k, v] of Object.entries(vars)) {
        str = str.split(`{{${k}}}`).join(String(v));
    }
    return str;
}

module.exports = { loadI18n, t, tf, pluralCategory };
