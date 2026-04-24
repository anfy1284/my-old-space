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
    return entry[langCode] || entry['en'] || key;
}

/**
 * Translate a key and substitute named placeholders {{varName}}.
 * Example: tf('row_field_required', 'ru', { row: 3, section: 'booking_rooms', field: 'roomId' })
 * @param {string} key
 * @param {string} [langCode='en']
 * @param {Object} [vars={}]
 * @returns {string}
 */
function tf(key, langCode = 'en', vars = {}) {
    let str = t(key, langCode);
    for (const [k, v] of Object.entries(vars)) {
        str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
    }
    return str;
}

module.exports = { loadI18n, t, tf };
