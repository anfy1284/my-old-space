'use strict';

/**
 * Стратегия системных данных для таблицы настроек (`settings_values`).
 *
 * ── Что делает по умолчанию ──────────────────────────────────────────────────
 * НИЧЕГО: настройки восстанавливаются из копии целиком, все уровни. Решение
 * владельца (10.09.2026): копия должна разворачиваться полностью, а с нюансами
 * разбирается тот специалист, который её восстанавливает.
 *
 * Стратегия при этом зарегистрирована, а не выброшена, по двум причинам:
 *   1) умолчание механизма — «побеждает текущее целиком» (`carryOver`), и без
 *      собственной стратегии помеченная таблица вела бы себя ровно наоборот;
 *   2) выборочное поведение уже написано и проверено — оно включается одной
 *      константой ниже, если однажды понадобится.
 *
 * ── Что включает KEEP_SYSTEM_SCOPE ───────────────────────────────────────────
 * Строки уровня `__system` (сроки хранения, лимиты — описание ЭТОЙ инсталляции)
 * остаются текущими, все прочие уровни приходят из копии. Смысл: восстановив
 * копию с другого сервера, не получить его лимиты молча — та же причина, по
 * которой настройки бэкапа переехали в базу. Выключено намеренно.
 *
 * @module drive_root/backup/systemDataSettings
 */

const log = require('../log');
const systemData = require('./systemData');

const SYSTEM_SCOPE_TABLE = '__system';

/** Оставлять ли настройки уровня «система» текущими. По умолчанию — нет. */
const KEEP_SYSTEM_SCOPE = false;

/**
 * @param {Object} opts — { sequelize, q, shadow, live, tables, report }
 */
async function restoreSettings({ sequelize, q, shadow, live, tables, report }) {
    if (!KEEP_SYSTEM_SCOPE) {
        // Строки копии уже лежат в теневой схеме — восстановление это они и есть.
        for (const table of tables) {
            log.info(`[restore/systemData] ${table}: восстановлено из копии полностью (все уровни настроек)`);
            report && report(`${table}: из копии полностью`);
        }
        return;
    }

    for (const table of tables) {
        const dst = shadow ? `${q(shadow)}.${q(table)}` : q(table);
        const src = shadow ? `${q(live)}.${q(table)}` : q(table);
        if (dst === src) {
            log.warn(`[restore/systemData] ${table}: теневой схемы нет — строки уровня «система» уже текущие`);
            continue;
        }

        // Колонки сопоставляем ПО ИМЕНИ: в схеме из копии они лежат в алфавитном
        // порядке, а в живой — в историческом, и `SELECT *` разложил бы значения по
        // чужим колонкам (см. commonColumns в systemData.js).
        const cols = await systemData.commonColumns(sequelize, shadow || systemData.LIVE_SCHEMA, live, table);
        if (!cols.length) {
            log.warn(`[restore/systemData] ${table}: нет общих колонок со схемой ${live} — пропущена`);
            continue;
        }
        const colList = cols.map(q).join(', ');

        const [, del] = await sequelize.query(
            `DELETE FROM ${dst} WHERE ${q('scopeTable')} = '${SYSTEM_SCOPE_TABLE}'`
        );
        const [, ins] = await sequelize.query(
            `INSERT INTO ${dst} (${colList}) SELECT ${colList} FROM ${src} WHERE ${q('scopeTable')} = '${SYSTEM_SCOPE_TABLE}'`
        );

        log.info(`[restore/systemData] ${table}: настройки инсталляции оставлены текущими `
            + `(из копии убрано ${systemData.affected(del)}, перенесено ${systemData.affected(ins)})`);
        report && report(`${table}: уровень «система» — текущий, остальные уровни — из копии`);
    }
}

module.exports = { restoreSettings, KEEP_SYSTEM_SCOPE, SYSTEM_SCOPE_TABLE };
