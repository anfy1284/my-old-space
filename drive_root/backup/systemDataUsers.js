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
 *
 * Колонка настроек называется `settingsFieldId`, а не `fieldId`: имена здесь —
 * фактические имена колонок, а не то, как поле называется в разговоре. Первая редакция
 * списка ошиблась ровно в этом и ошибка прожила незамеченной, потому что стратегия не
 * была зарегистрирована в исполняющем процессе и список не исполнялся вовсе. Поэтому
 * ниже имена ещё и СВЕРЯЮТСЯ с обеими схемами перед подстановкой в SQL.
 */
const LINK_TABLES = {
    user_systems: ['userId', 'systemId'],
    user_settings_string_values: ['userId', 'settingsFieldId'],
    user_settings_number_values: ['userId', 'settingsFieldId'],
    user_settings_boolean_values: ['userId', 'settingsFieldId'],
    user_settings_date_values: ['userId', 'settingsFieldId']
};

/**
 * Справочники этого типа, которые ведут себя как конфигурация: побеждает текущее
 * целиком. Роли и подсистемы пересоздаются при старте из приложений, и годичный набор
 * ролей описывает не эту сборку.
 */
const CONFIG_TABLES = new Set(['access_roles', 'systems']);

// Примитивы переноса между схемами — из механизма: сопоставление колонок по имени
// и замена справочника без разрыва ссылок нужны не только этой стратегии.
const { affected, columnsOf, commonColumns, foreignKeysOf, replaceReferenced } = require('./systemData');

/**
 * Слить пользователей: копия внизу, текущие поверх.
 *
 * @param {Object} ctx — из `systemData.applyAll`
 */
async function mergeUsers({ sequelize, q, shadow, live, tables, report }) {
    const has = new Set(tables);
    const stats = { updated: 0, added: 0, disabled: 0, emailCleared: 0 };
    // На разрушающем пути теневой схемы нет: `shadow === null` означает «прямо в живой».
    // В SQL это правильный null, но интроспекции нужно настоящее имя схемы — иначе
    // запрос вернёт пусто и слияние молча выродится в ничто. См. `replaceReferenced`.
    const shadowSchema = shadow || 'public';

    if (has.has(USERS)) {
        const dst = dialect.qualify(q, USERS, shadow);
        const src = dialect.qualify(q, USERS, live);
        const uid = q('UID');

        // 1. Кого нет среди текущих — выключаем. ДО вливания текущих: после него
        //    сравнивать будет не с чем, обе стороны сойдутся.
        const [, disabled] = await sequelize.query(
            `UPDATE ${dst} SET ${q('disabled')} = true
              WHERE ${uid} NOT IN (SELECT ${uid} FROM ${src})`
        );
        stats.disabled = affected(disabled);

        // 2. Текущие поверх: совпавших по UID обновляем, новых добавляем.
        //
        // Колонки берутся из ПЕРЕСЕЧЕНИЯ схем, а не из списка в коде. Список здесь был, и
        // в нём не хватало `organizationId`: пользователь, заведённый после снятия копии,
        // приезжал бы без организации, то есть с молча сломанным разграничением доступа —
        // он входит, но своих данных не видит. Колонка nullable, поэтому база смолчала бы.
        // Список колонок обязан следовать за моделью, а не повторять её по памяти.
        //
        // Вычисленный на шаге 1 `disabled` при этом не страдает: шаг 1 выключает только
        // тех, кого в живой схеме НЕТ, а такие строки в источнике отсутствуют и под
        // `ON CONFLICT` не попадают.
        const liveUserCols = new Set(await columnsOf(sequelize, live, USERS));
        const cols = (await columnsOf(sequelize, shadowSchema, USERS)).filter(c => liveUserCols.has(c));
        if (!cols.includes('UID')) {
            const e = new Error(`users: колонки UID нет в обеих схемах`);
            e.errorKey = 'restore_err_system_data';
            throw e;
        }
        const colList = cols.map(q).join(', ');
        const setList = cols.filter(c => c !== 'UID')
            .map(c => `${q(c)} = EXCLUDED.${q(c)}`).join(', ');

        // Ссылка текущего пользователя может вести туда, чего в копии нет: организацию
        // завели после снятия. Пользователя из-за этого терять нельзя — он и есть тот,
        // кто выполняет восстановление. Поэтому неразрешимая ссылка ГАСИТСЯ (поле
        // nullable), пользователь остаётся со входом, а факт попадает в отчёт: привязку
        // к организации придётся проставить руками.
        const nulled = [];
        const fks = (await foreignKeysOf(sequelize, shadowSchema, USERS)).filter(f => cols.includes(f.column));
        const selectList = cols.map(c => {
            const fk = fks.find(f => f.column === c);
            if (!fk) return `s.${q(c)}`;
            nulled.push(c);
            return `CASE WHEN s.${q(c)} IS NULL OR EXISTS (SELECT 1 FROM `
                + `${dialect.qualify(q, fk.parentTable, shadow)} p `
                + `WHERE p.${q(fk.parentColumn)} = s.${q(c)}) THEN s.${q(c)} ELSE NULL END`;
        }).join(', ');

        // Сколько из них ДОБАВИТСЯ, видно только до вставки: после неё обе стороны
        // сойдутся. Поле `added` в отчёте было всегда нулевым — считаем его здесь, иначе
        // отчёт утверждает, что новых учётных записей не появилось, что неправда.
        const [newcomers] = await sequelize.query(
            `SELECT COUNT(*) AS n FROM ${src} s
              WHERE NOT EXISTS (SELECT 1 FROM ${dst} d WHERE d.${uid} = s.${uid})`,
            { type: sequelize.QueryTypes.SELECT }
        );
        stats.added = Number(dialect.scalarOf([newcomers])) || 0;

        const [, merged] = await sequelize.query(
            `INSERT INTO ${dst} (${colList}) SELECT ${selectList} FROM ${src} s
             ON CONFLICT (${uid}) DO UPDATE SET ${setList}`
        );
        stats.updated = affected(merged) - stats.added;

        for (const c of nulled) {
            const [lost] = await sequelize.query(
                `SELECT COUNT(*) AS n FROM ${src} s WHERE s.${q(c)} IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM ${dialect.qualify(q, USERS, shadow)} d
                                    WHERE d.${uid} = s.${uid} AND d.${q(c)} IS NOT NULL)`,
                { type: sequelize.QueryTypes.SELECT }
            );
            const n = Number(dialect.scalarOf([lost])) || 0;
            if (!n) continue;
            log.warn(`[restore/systemData] users.${c}: у ${n} текущих пользователей ссылка `
                + 'погашена — того, на что она указывала, в копии нет');
            report && report(`users.${c}: погашено ссылок ${n} (нет в копии)`);
        }

        // 3. Дубли адресов: адрес остаётся у ТЕКУЩЕГО, у воскрешённого гасится.
        //    Отличаем по тому же признаку, что и на шаге 1, — воскрешённый выключен.
        const [, cleared] = await sequelize.query(
            `UPDATE ${dst} d SET ${q('email')} = NULL
              WHERE d.${q('disabled')} = true
                AND d.${q('email')} IS NOT NULL
                AND EXISTS (SELECT 1 FROM ${dst} c
                             WHERE c.${q('email')} = d.${q('email')}
                               AND c.${uid} <> d.${uid}
                               AND c.${q('disabled')} = false)`
        );
        stats.emailCleared = affected(cleared);

        report && report(`${USERS}: слито с текущими (обновлено ${stats.updated}, `
            + `добавлено ${stats.added}), выключено ${stats.disabled}, `
            + `погашено адресов ${stats.emailCleared}`);
    }

    // Сессии — не пользователи: чистим полностью, живые остаются жить в своей схеме
    // только до переключения, после которого их всё равно нет.
    if (has.has(SESSIONS)) {
        await sequelize.query(`DELETE FROM ${dialect.qualify(q, SESSIONS, shadow)}`);
        report && report(`${SESSIONS}: очищены`);
    }

    // Справочники — ДО привязок, и порядок здесь содержательный, а не косметический:
    // текущая строка `user_systems` ссылается на текущие роль и подсистему, и если их
    // ещё нет в теневой схеме, вставка привязки падает на внешнем ключе. Обратный
    // порядок работал бы ровно до первой роли, заведённой после снятия копии.
    for (const table of tables) {
        if (!CONFIG_TABLES.has(table)) continue;
        await replaceReferenced({ sequelize, q, shadow, live, table, report });
    }

    // Привязки к пользователю: побеждает текущая. Без этого учётная запись уцелела бы,
    // а её права заменились бы годичными — тот же самый потерянный доступ, просто
    // одной таблицей левее.
    for (const [table, keys] of Object.entries(LINK_TABLES)) {
        if (!has.has(table)) continue;
        const dst = dialect.qualify(q, table, shadow);
        const src = dialect.qualify(q, table, live);

        // Колонки — пересечение схем, а не `SELECT *`: копия может быть старше живой
        // структуры, и порядок колонок у двух схем совпадает лишь по случайности.
        const liveCols = new Set(await columnsOf(sequelize, live, table));
        const cols = (await columnsOf(sequelize, shadowSchema, table)).filter(c => liveCols.has(c));
        if (!cols.length) {
            log.warn(`[restore/systemData] ${table}: нет общих колонок со схемой ${live} — пропущена`);
            continue;
        }
        const colList = cols.map(q).join(', ');

        // Ключ слияния СВЕРЯЕТСЯ с фактическими колонками обеих схем. Имя из списка выше
        // попадает прямо в SQL, и опечатка в нём — не «неверный ключ», а падение всего
        // восстановления на середине с сообщением про несуществующий столбец. Колонки
        // может не быть и законно: копия старше поля. Тогда сливаем по тем ключам, что
        // есть, а если не осталось ни одного — по `UID`; и то и другое громко.
        const keyCols = keys.filter(k => cols.includes(k));
        const missing = keys.filter(k => !cols.includes(k));
        if (missing.length) {
            log.warn(`[restore/systemData] ${table}: колонок ${missing.join(', ')} нет в обеих схемах — `
                + `слияние по ${keyCols.length ? keyCols.join(', ') : 'UID'}`);
            report && report(`${table}: ключ слияния сокращён (нет ${missing.join(', ')})`);
        }
        const cond = (keyCols.length ? keyCols : ['UID'])
            .map(k => `d.${q(k)} = s.${q(k)}`).join(' AND ');
        await sequelize.query(`DELETE FROM ${dst} d WHERE EXISTS (SELECT 1 FROM ${src} s WHERE ${cond})`);

        // Строки-сироты отсеиваем ЗАРАНЕЕ, а не ловим отказом внешнего ключа. Текущая
        // привязка ссылается на текущий справочник (поле настроек, роль), а копия может
        // быть старше него: одна настройка, заведённая после снятия копии, иначе валит
        // всё восстановление сообщением про чужую таблицу. Перенести такую строку
        // некуда — того, на что она ссылается, в восстановленной базе не существует.
        const guards = [];
        for (const fk of await foreignKeysOf(sequelize, shadowSchema, table)) {
            if (!cols.includes(fk.column)) continue;
            guards.push(`(s.${q(fk.column)} IS NULL OR EXISTS (SELECT 1 FROM `
                + `${dialect.qualify(q, fk.parentTable, shadow)} p `
                + `WHERE p.${q(fk.parentColumn)} = s.${q(fk.column)}))`);
        }
        const where = guards.length ? ` WHERE ${guards.join(' AND ')}` : '';

        const [, ins] = await sequelize.query(
            `INSERT INTO ${dst} (${colList}) SELECT ${colList} FROM ${src} s${where}`);
        const moved = affected(ins);
        const total = await dialect.countRows(sequelize, { table, schema: live });
        if (total > moved) {
            log.warn(`[restore/systemData] ${table}: не перенесено ${total - moved} текущих строк — `
                + 'ссылаются на то, чего нет в восстановленной базе');
            report && report(`${table}: не перенесено ${total - moved} строк (ссылки вне копии)`);
        }
        report && report(`${table}: текущие привязки поверх восстановленных (${moved})`);
    }

    log.info(`[restore/systemData] Пользователи слиты: выключено ${stats.disabled}, `
        + `погашено адресов ${stats.emailCleared}`);
    return stats;
}

module.exports = { mergeUsers, LINK_TABLES, CONFIG_TABLES };
