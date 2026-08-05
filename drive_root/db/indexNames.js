'use strict';

/**
 * indexNames — детерминированное ИМЯ у каждого объявленного индекса.
 *
 * Зачем. Sequelize, если имя индекса не задано, генерирует его сам из имени таблицы
 * и колонок, а СУБД обрезает идентификатор по своему пределу (PostgreSQL — 63 байта).
 * Дальше на каждом старте `Model.sync()` сравнивает своё ПОЛНОЕ имя с ОБРЕЗАННЫМ
 * именем в базе, не находит совпадения и пытается создать индекс заново — Postgres
 * снова обрезает имя и отвечает «отношение … уже существует».
 *
 * Реальный случай: `organization_settings_string_values` + `organizationId` +
 * `settingsFieldId` даёт имя в 69 символов; в базе лежало обрезанное до 63, и четыре
 * таблицы настроек организации сыпали ошибкой при КАЖДОМ запуске сервера.
 *
 * Решение: имя задаётся явно и заведомо помещается в предел. Длинное имя
 * укорачивается с хвостом-хэшем от полного имени — так оно остаётся уникальным и
 * воспроизводимым (одинаковым на всех инсталляциях), а не зависит от того, где
 * СУБД решила обрезать строку.
 *
 * Инъекция — в тех же двух точках, что `number`/`date`/`name`:
 *   1. Миграция: корневой `events_handler.js` → onModelsPostCollect;
 *   2. Рантайм:  `globalServerContext.collectAllModelDefs`.
 * Идемпотентно: явное имя, заданное автором модели, не трогается.
 */

const crypto = require('crypto');

// Предел идентификатора PostgreSQL. Берём его как общий: он самый строгий из
// поддерживаемых диалектов, а имя обязано совпадать во всех.
const MAX_IDENTIFIER_LEN = 63;

/**
 * Каноническое имя индекса. Совпадает с тем, что сгенерировал бы Sequelize, пока
 * помещается в предел; иначе — усечение + 8 символов md5 от полного имени.
 * @param {string} tableName
 * @param {Array<string|{name:string}>} fields
 * @returns {string}
 */
function buildIndexName(tableName, fields) {
    const cols = (fields || []).map(f => (typeof f === 'string' ? f : (f && f.name) || '')).filter(Boolean);
    // Sequelize приводит имя к snake_case — повторяем, чтобы у уже существующих
    // коротких индексов имя не изменилось и они не пересоздавались.
    const snake = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const full = [tableName, ...cols.map(snake)].join('_');
    if (Buffer.byteLength(full) <= MAX_IDENTIFIER_LEN) return full;

    const hash = crypto.createHash('md5').update(full).digest('hex').slice(0, 8);
    const keep = MAX_IDENTIFIER_LEN - hash.length - 1;
    return `${full.slice(0, keep)}_${hash}`;
}

/**
 * Проставить имена индексам одной модели.
 * @param {object} def — определение модели (мутируется in-place)
 * @returns {number} скольким индексам имя добавлено
 */
function injectIndexName(def) {
    const indexes = def && def.options && def.options.indexes;
    if (!Array.isArray(indexes)) return 0;
    let n = 0;
    for (const idx of indexes) {
        if (!idx || typeof idx !== 'object') continue;
        if (idx.name) continue;                       // автор задал своё — уважаем
        if (!Array.isArray(idx.fields) || !idx.fields.length) continue;
        idx.name = buildIndexName(def.tableName || def.name, idx.fields);
        n++;
    }
    return n;
}

/**
 * Применить ко всему массиву определений моделей.
 * @param {Array<object>} defs
 * @returns {number} сколько индексов получило имя
 */
function injectIndexNames(defs) {
    if (!Array.isArray(defs)) return 0;
    let n = 0;
    for (const def of defs) n += injectIndexName(def);
    return n;
}

module.exports = { injectIndexName, injectIndexNames, buildIndexName, MAX_IDENTIFIER_LEN };
