'use strict';

/**
 * systemDataUsers — стратегия слияния пользователей при полном восстановлении.
 *
 * ПОЧЕМУ У ПОЛЬЗОВАТЕЛЕЙ ОТДЕЛЬНАЯ СТРАТЕГИЯ. У остальных типов системных данных
 * побеждает текущее целиком, а здесь так нельзя ни в одну сторону:
 *
 *   • взять только из копии — администратор, выполняющий восстановление, теряет
 *     собственный вход посреди операции, если его завели после снятия копии;
 *   • взять только текущих — восстановленные данные ссылаются на пользователей из
 *     копии (`userId` в бронях, документах, журналах), и ссылки повисают.
 *
 * Решение владельца 11.08.2026: **сначала из копии, затем поверх текущие**, слияние по
 * UID, ничего не удаляется. Тогда обе стороны целы: пользователи копии есть — ссылки
 * держатся; текущие поверх — вход не теряется; заведённые после копии просто
 * добавляются.
 *
 * ЧТО К ЭТОМУ ПРИШЛОСЬ ДОБАВИТЬ, ЧТОБЫ ОНО НЕ СТАЛО ДЫРОЙ.
 *
 * 1. **Воскрешённые возвращаются ВЫКЛЮЧЕННЫМИ.** «Ничего не удаляем» в чистом виде
 *    означает, что каждое восстановление тихо оживляет все когда-либо отозванные
 *    учётные записи — вместе с их паролями и правами. Уволенный сотрудник получает
 *    рабочий вход, и никто об этом не узнает. Поэтому пользователь, которого нет в
 *    текущей базе, приходит с `disabled = true`: ссылочная целостность та же (мы
 *    по-прежнему ничего не удалили), а доступа нет. Включить — решение администратора.
 *
 * 2. **Дубли адресов гасятся.** У `users.email` нет уникального индекса, поэтому база
 *    молча примет две записи с одним адресом. А это бытовой случай: сотрудник ушёл,
 *    учётку удалили, позже завели новую на тот же адрес. После слияния в базе оказались
 *    бы два пользователя с одним адресом — и один из них со СТАРЫМ паролем и старыми
 *    правами, причём вход выбирал бы между ними недетерминированно. Адрес остаётся у
 *    текущего, у воскрешённого двойника гасится, и оба попадают в отчёт операции.
 *
 * 3. **Сессии не сливаются, а чистятся.** Решение владельца: `sessions` при
 *    восстановлении обнуляются. Иначе администратор теряет собственную сессию посреди
 *    операции, которой сам управляет, а служебные сессии планировщика (`kind='service'`)
 *    заменяются годичными и начинают ссылаться на несуществующие запуски.
 *
 * Всё это выполняется в ТЕНЕВОЙ схеме, читая ещё живую, — до атомарного переключения.
 *
 * @module backup/systemDataUsers
 */

const log = require('../log');
const dialect = require('./dialect');

const USERS = 'users';
const SESSIONS = 'sessions';

/**
 * Таблицы этого типа, которые ведут себя как «привязка к пользователю»: сливаются
 * победой текущего по указанным ключевым колонкам.
 *
 * `users` и `sessions` обрабатываются особо и в этот список не входят.
 */
const LINK_TABLES = {
    user_systems: ['userId', 'systemId'],
    user_settings_string_values: ['userId', 'fieldId'],
    user_settings_number_values: ['userId', 'fieldId'],
    user_settings_boolean_values: ['userId', 'fieldId'],
    user_settings_date_values: ['userId', 'fieldId']
};

/**
 * Справочники этого типа, которые ведут себя как конфигурация: побеждает текущее
 * целиком. Роли и подсистемы пересоздаются при старте из приложений, и годичный набор
 * ролей описывает не эту сборку.
 */
const CONFIG_TABLES = new Set(['access_roles', 'systems']);

/**
 * Слить пользователей: копия внизу, текущие поверх.
 *
 * @param {Object} ctx — из `systemData.applyAll`
 */
async function mergeUsers({ sequelize, q, shadow, live, tables, report }) {
    const has = new Set(tables);
    const stats = { updated: 0, added: 0, disabled: 0, emailCleared: 0 };

    if (has.has(USERS)) {
        const dst = dialect.qualify(q, USERS, shadow);
        const src = dialect.qualify(q, USERS, live);
        const uid = q('UID');

        // 1. Кого нет среди текущих — выключаем. ДО вливания текущих: после него
        //    сравнивать будет не с чем, обе стороны сойдутся.
        const [disabled] = await sequelize.query(
            `UPDATE ${dst} SET ${q('disabled')} = true
              WHERE ${uid} NOT IN (SELECT ${uid} FROM ${src})`
        );
        stats.disabled = (disabled && disabled.rowCount) || 0;

        // 2. Текущие поверх: совпавших по UID обновляем, новых добавляем.
        //    Колонки перечисляются явно — набор у `users` небольшой и стабильный, а
        //    `SELECT *` здесь опасен: он затёр бы вычисленный на шаге 1 `disabled`
        //    значением из живой схемы для тех, кто есть в обеих.
        // `createdAt`/`updatedAt` перечислены наравне с остальными: у модели включены
        // `timestamps`, Sequelize создаёт эти колонки NOT NULL без умолчания на стороне
        // БД, и сырой INSERT без них падает на ограничении.
        const cols = ['UID', 'email', 'name', 'password_hash', 'isGuest', 'language',
                      'mustChangePassword', 'disabled', 'createdAt', 'updatedAt'];
        const colList = cols.map(q).join(', ');
        const setList = cols.filter(c => c !== 'UID')
            .map(c => `${q(c)} = EXCLUDED.${q(c)}`).join(', ');

        const [merged] = await sequelize.query(
            `INSERT INTO ${dst} (${colList}) SELECT ${colList} FROM ${src}
             ON CONFLICT (${uid}) DO UPDATE SET ${setList}`
        );
        stats.updated = (merged && merged.rowCount) || 0;

        // 3. Дубли адресов: адрес остаётся у ТЕКУЩЕГО, у воскрешённого гасится.
        //    Отличаем по тому же признаку, что и на шаге 1, — воскрешённый выключен.
        const [cleared] = await sequelize.query(
            `UPDATE ${dst} d SET ${q('email')} = NULL
              WHERE d.${q('disabled')} = true
                AND d.${q('email')} IS NOT NULL
                AND EXISTS (SELECT 1 FROM ${dst} c
                             WHERE c.${q('email')} = d.${q('email')}
                               AND c.${uid} <> d.${uid}
                               AND c.${q('disabled')} = false)`
        );
        stats.emailCleared = (cleared && cleared.rowCount) || 0;

        report && report(`${USERS}: слито с текущими, выключено ${stats.disabled}, `
            + `погашено адресов ${stats.emailCleared}`);
    }

    // Сессии — не пользователи: чистим полностью, живые остаются жить в своей схеме
    // только до переключения, после которого их всё равно нет.
    if (has.has(SESSIONS)) {
        await sequelize.query(`DELETE FROM ${dialect.qualify(q, SESSIONS, shadow)}`);
        report && report(`${SESSIONS}: очищены`);
    }

    // Привязки к пользователю: побеждает текущая. Без этого учётная запись уцелела бы,
    // а её права заменились бы годичными — тот же самый потерянный доступ, просто
    // одной таблицей левее.
    for (const [table, keys] of Object.entries(LINK_TABLES)) {
        if (!has.has(table)) continue;
        const dst = dialect.qualify(q, table, shadow);
        const src = dialect.qualify(q, table, live);
        const cond = keys.map(k => `d.${q(k)} = s.${q(k)}`).join(' AND ');
        await sequelize.query(`DELETE FROM ${dst} d WHERE EXISTS (SELECT 1 FROM ${src} s WHERE ${cond})`);
        await sequelize.query(`INSERT INTO ${dst} SELECT * FROM ${src}`);
        report && report(`${table}: текущие привязки поверх восстановленных`);
    }

    for (const table of tables) {
        if (!CONFIG_TABLES.has(table)) continue;
        const dst = dialect.qualify(q, table, shadow);
        const src = dialect.qualify(q, table, live);
        await sequelize.query(`DELETE FROM ${dst}`);
        await sequelize.query(`INSERT INTO ${dst} SELECT * FROM ${src}`);
        report && report(`${table}: перенесено из текущей базы`);
    }

    log.info(`[restore/systemData] Пользователи слиты: выключено ${stats.disabled}, `
        + `погашено адресов ${stats.emailCleared}`);
    return stats;
}

module.exports = { mergeUsers, LINK_TABLES, CONFIG_TABLES };
