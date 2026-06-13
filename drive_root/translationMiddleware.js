'use strict';

const { Op } = require('sequelize');

const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';
const READ_OPS = new Set(['read', 'findOne', 'findByPk']);

// Cache of translatable fields per tableName: Map<tableName, string[]>
let _fieldsCache = null;

// Cache of translation values: Map<"tableName|language", Map<"recordId|fieldName", value>>
// Populated lazily per (table, language) pair; cleared by invalidateCache()
const _valueCache = new Map();

function _buildFieldsCache() {
    const map = new Map();
    try {
        const { collectAllModelDefs } = require('./globalServerContext');
        const { models } = collectAllModelDefs();
        for (const def of models) {
            const fields = [];
            for (const [fieldName, fieldDef] of Object.entries(def.fields || {})) {
                if (fieldDef && fieldDef.translatable === true) fields.push(fieldName);
            }
            if (fields.length > 0) map.set(def.tableName, fields);
        }
        console.log('[translationMW] Translatable tables:', [...map.keys()].join(', ') || '(none)');
    } catch (e) {
        console.error('[translationMW] Error building fields cache:', e.message);
    }
    return map;
}

function _getFieldsCache() {
    if (!_fieldsCache) _fieldsCache = _buildFieldsCache();
    return _fieldsCache;
}

async function _getLanguage(sessionID) {
    try {
        const ctx = require('../drive_forms/globalServerContext');
        const { language } = await ctx.getSessionContext(sessionID);
        return language || 'en';
    } catch (e) { return 'en'; }
}

/**
 * Returns lookup Map for (tableName, language).
 * Queries DB once per (tableName, language) pair, then caches indefinitely.
 * Cache is invalidated by invalidateCache().
 */
async function _getLookup(tableName, fieldNames, language, modelsDB) {
    const cacheKey = `${tableName}|${language}`;
    if (_valueCache.has(cacheKey)) return _valueCache.get(cacheKey);

    const lookup = new Map();
    if (!modelsDB.Translations) {
        _valueCache.set(cacheKey, lookup);
        return lookup;
    }
    try {
        const rows = await modelsDB.Translations.findAll({
            where: { tableName, fieldName: { [Op.in]: fieldNames }, language },
            attributes: ['recordId', 'fieldName', 'value'],
            raw: true
        });
        for (const r of rows) lookup.set(`${r.recordId}|${r.fieldName}`, r.value);
    } catch (e) {
        console.error('[translationMW] DB error loading translations:', e.message);
    }
    _valueCache.set(cacheKey, lookup);
    return lookup;
}

async function _applyTranslations(plainRows, tableName, fieldNames, language, modelsDB) {
    if (!plainRows.length) return plainRows;
    const lookup = await _getLookup(tableName, fieldNames, language, modelsDB);
    if (!lookup.size) return plainRows;
    return plainRows.map(row => {
        const id = row && row.UID;
        if (!id) return row;
        let newRow = null;
        for (const f of fieldNames) {
            const val = lookup.get(`${id}|${f}`);
            if (val !== undefined) {
                if (!newRow) newRow = { ...row };
                newRow[f] = val;
            }
        }
        return newRow || row;
    });
}

async function translationMiddleware(request, next) {
    const result = await next(request);
    const { operation, table, context = {} } = request;
    const { sessionID } = context;
    if (!READ_OPS.has(operation)) return result;
    if (!sessionID || sessionID === SYSTEM_SESSION_ID) return result;
    if (!result) return result;
    const fieldNames = _getFieldsCache().get(table);
    if (!fieldNames || !fieldNames.length) return result;
    try {
        const language = await _getLanguage(sessionID);
        if (language === 'en') return result; // 'en' is native language — no translation needed
        const globalCtx = require('./globalServerContext');
        const modelsDB = globalCtx.modelsDB;
        const isArray = Array.isArray(result);
        const raw = isArray ? result : [result];
        const plainRows = raw.map(r => (r && typeof r.get === 'function') ? r.get({ plain: true }) : r);
        const translated = await _applyTranslations(plainRows, table, fieldNames, language, modelsDB);
        return isArray ? translated : (translated[0] || result);
    } catch (e) {
        console.error('[translationMW] Error:', e.message);
        return result;
    }
}

function install() {
    require('./dbGateway').use('root', translationMiddleware);
    console.log('[translationMW] Installed at dbGateway root level.');
}

function invalidateCache() {
    _fieldsCache = null;
    _valueCache.clear();
}

/**
 * Translatable field names for a table, or null if none.
 * @param {string} tableName
 * @returns {string[]|null}
 */
function getTranslatableFields(tableName) {
    return _getFieldsCache().get(tableName) || null;
}

/**
 * Translation lookup Map for (tableName, language): key `${recordId}|${fieldName}` → value.
 * Reuses the same per-(table,language) cache as the read middleware. Returns null if the
 * table has no translatable fields.
 * @param {string} tableName
 * @param {string} language
 * @param {object} [modelsDB] — defaults to globalServerContext.modelsDB
 * @returns {Promise<Map|null>}
 */
async function getTranslationLookup(tableName, language, modelsDB) {
    const fields = getTranslatableFields(tableName);
    if (!fields || !fields.length) return null;
    const mdb = modelsDB || require('./globalServerContext').modelsDB;
    if (!mdb) return null;
    return await _getLookup(tableName, fields, language, mdb);
}

module.exports = { install, invalidateCache, getTranslatableFields, getTranslationLookup };
