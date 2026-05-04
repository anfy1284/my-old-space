'use strict';

const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';
const READ_OPS = new Set(['read', 'findOne', 'findByPk']);

let _cache = null;

function _buildCache() {
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
        console.error('[translationMW] Error building cache:', e.message);
    }
    return map;
}

function _getCache() {
    if (!_cache) _cache = _buildCache();
    return _cache;
}

async function _getLanguage(sessionID) {
    try {
        const ctx = require('../drive_forms/globalServerContext');
        const { language } = await ctx.getSessionContext(sessionID);
        return language || 'en';
    } catch (e) { return 'en'; }
}

async function _applyTranslations(plainRows, tableName, fieldNames, language, modelsDB) {
    if (!plainRows.length || !modelsDB.Translations) return plainRows;
    const { Op } = require('sequelize');
    const recordIds = plainRows.map(r => r && r.UID).filter(Boolean);
    if (!recordIds.length) return plainRows;
    let tRows;
    try {
        tRows = await modelsDB.Translations.findAll({
            where: {
                tableName,
                fieldName: { [Op.in]: fieldNames },
                language,
                recordId: { [Op.in]: recordIds }
            },
            raw: true
        });
    } catch (e) {
        console.error('[translationMW] DB error:', e.message);
        return plainRows;
    }
    if (!tRows || !tRows.length) return plainRows;
    const lookup = new Map();
    for (const t of tRows) lookup.set(`${t.recordId}|${t.fieldName}`, t.value);
    return plainRows.map(row => {
        const id = row && row.UID;
        if (!id) return row;
        const newRow = { ...row };
        let changed = false;
        for (const f of fieldNames) {
            const val = lookup.get(`${id}|${f}`);
            if (val !== undefined) { newRow[f] = val; changed = true; }
        }
        return changed ? newRow : row;
    });
}

async function translationMiddleware(request, next) {
    const result = await next(request);
    const { operation, table, context = {} } = request;
    const { sessionID } = context;
    if (!READ_OPS.has(operation)) return result;
    if (!sessionID || sessionID === SYSTEM_SESSION_ID) return result;
    if (!result) return result;
    const fieldNames = _getCache().get(table);
    if (!fieldNames || !fieldNames.length) return result;
    try {
        const language = await _getLanguage(sessionID);
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

function invalidateCache() { _cache = null; }

module.exports = { install, invalidateCache };
