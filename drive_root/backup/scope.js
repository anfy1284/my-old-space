'use strict';

/**
 * scope — область выгрузки: вся база либо одна организация (ТЗ §3.7).
 *
 * Классы таблиц ВЫВОДЯТСЯ ИЗ МОДЕЛЕЙ, а не перечисляются списком в коде. Список
 * устарел бы на первой же новой таблице, и обнаружилось бы это при восстановлении —
 * то есть в худший момент.
 *
 *   A. Данные организации  — есть `organizationId` ИЛИ `hotelId`
 *   B. Глобальные справочники — реквизита доступа нет вовсе
 *   C. Личное и системное — только `userId`
 *
 * Три правила, без которых классификация врёт (все проверены по коду проекта):
 *
 *  1. Отбор ТРАНЗИТИВЕН. `rooms` не имеет `organizationId`, только `hotelId`, поэтому
 *     фильтр идёт через отели организации. Хелпер `applyScopeOrganization` в
 *     `dbGateway` для этого не годится — он сам оговаривает, что таблицы без
 *     `organizationId` сузить нечем.
 *  2. Фильтр по ОДНОМУ реквизиту, а не по всем сразу. RLS склеивает реквизиты через
 *     OR — это правило ВИДИМОСТИ. Для ПРИНАДЛЕЖНОСТИ такая дизъюнкция притащила бы
 *     чужие организации того же пользователя. Приоритет: organizationId → hotelId.
 *  3. Класс определяется по значению реквизита В СТРОКЕ. `guest_types` лежит в
 *     `excluded_tables`, но имеет `organizationId`: её строки с организацией — класс A,
 *     строки с NULL — глобальные.
 */

const path = require('path');
const fs = require('fs');
const log = require('../log');

const CLASS_ORG = 'A';        // данные организации — выгружаем и восстанавливаем
const CLASS_GLOBAL = 'B';     // глобальные справочники — выгружаем, не восстанавливаем
const CLASS_PERSONAL = 'C';   // личное и системное — не выгружаем
const CLASS_IDENTITY = 'D';   // субъекты доступа — выгружаем, но НЕ перезаписываем

const ORG_FIELD = 'organizationId';
const HOTEL_FIELD = 'hotelId';
const USER_FIELD = 'userId';

/**
 * Сама таблица организаций — объект доступа, а не её носитель: реквизита
 * `organizationId` у неё нет, ключом служит собственный `UID`. Тот же спецслучай
 * есть и в RLS (`dbGateway`: `table === 'organizations'` → фильтр по `UID`).
 */
const ORG_TABLE = 'organizations';

/**
 * Субъекты доступа (класс D) — `users`.
 *
 * Учётные записи это ТАКИЕ ЖЕ данные организации, и восстанавливать их надо: если у
 * клиента снесли пользователей, восстановление организации обязано их вернуть. Но
 * писать их тем же способом, что и документы («удалить всё и вставить заново»),
 * нельзя по трём причинам:
 *
 *  - `users` — ЦЕЛЬ внешних ключей `userId` с `onDelete: CASCADE`. DELETE утащил бы
 *    сессии, личные настройки и регламентные задания, к организации не относящиеся;
 *  - принадлежность организациям описывает `user_organizations` (многие-ко-многим):
 *    сотрудник может работать в двух организациях, и одного `organizationId` в его
 *    строке для «принадлежит» недостаточно;
 *  - строка содержит хэш пароля: откат на состояние месячной давности вернёт прежний
 *    пароль и разлогинит того, кто его с тех пор менял.
 *
 * Поэтому режим записи не `replace`, а **`upsert`**: отсутствующие создаём,
 * существующие обновляем, НИЧЕГО не удаляем. Каскады при этом не срабатывают вовсе, а
 * последствия (сколько паролей будет откачено) показываются в отчёте до запуска —
 * это решение администратора, а не тихий пропуск.
 */
const IDENTITY_TABLES = new Set(['users']);

let _accessConfig = null;

/** `app.config.json` проекта: обязательные реквизиты доступа и исключённые таблицы. */
function accessConfig() {
    if (_accessConfig) return _accessConfig;
    const root = process.env.PROJECT_ROOT
        || (function () { try { return require('../globalServerContext').getProjectRoot(); } catch (e) { return null; } })()
        || process.cwd();
    let cfg = {};
    try {
        const p = path.join(root, 'app.config.json');
        if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    } catch (e) {
        log.warn(`[backup/scope] app.config.json не прочитан: ${e.message}`);
    }
    _accessConfig = {
        requiredFields: cfg.required_access_fields || [ORG_FIELD, USER_FIELD, HOTEL_FIELD],
        excludedTables: new Set(cfg.excluded_tables || [])
    };
    return _accessConfig;
}

/** Сбросить кэш конфигурации (для будущего события `onDatabaseReset`). */
function resetCache() { _accessConfig = null; }

/**
 * Классифицировать таблицу по её полям.
 * @param {Object} modelDef — определение модели (с `fields`)
 * @returns {{cls: string, scopeField: string|null, hasOrg: boolean, hasHotel: boolean, hasUser: boolean}}
 */
function classify(modelDef) {
    const fields = (modelDef && modelDef.fields) || {};
    const table = modelDef && modelDef.tableName;
    const hasOrg = Object.prototype.hasOwnProperty.call(fields, ORG_FIELD);
    const hasHotel = Object.prototype.hasOwnProperty.call(fields, HOTEL_FIELD);
    const hasUser = Object.prototype.hasOwnProperty.call(fields, USER_FIELD);

    // Спецслучай: организация принадлежит себе. Без него её собственная строка
    // не попала бы в выгрузку, и восстановление получило бы висячие ссылки.
    if (table === ORG_TABLE) return { cls: CLASS_ORG, scopeField: 'UID', hasOrg, hasHotel, hasUser };
    // Субъекты доступа — до общего правила: у `users` есть organizationId, и без
    // этой проверки он уехал бы в класс A со всеми последствиями (см. IDENTITY_TABLES).
    if (IDENTITY_TABLES.has(table)) {
        return { cls: CLASS_IDENTITY, scopeField: hasOrg ? ORG_FIELD : null, hasOrg, hasHotel, hasUser };
    }

    // Приоритет реквизита — правило 2. Никакого OR.
    if (hasOrg) return { cls: CLASS_ORG, scopeField: ORG_FIELD, hasOrg, hasHotel, hasUser };
    if (hasHotel) return { cls: CLASS_ORG, scopeField: HOTEL_FIELD, hasOrg, hasHotel, hasUser };
    if (hasUser) return { cls: CLASS_PERSONAL, scopeField: null, hasOrg, hasHotel, hasUser };
    return { cls: CLASS_GLOBAL, scopeField: null, hasOrg, hasHotel, hasUser };
}

/**
 * Построить план выгрузки: какие таблицы и с каким отбором.
 *
 * @param {Array<Object>} models — СЛИТЫЕ определения (`collectMergedModelDefs().models`).
 *   Именно слитые: `collectAllModelDefs()` отдаёт слои по отдельности, и `users`
 *   приходит дважды — из ядра (без реквизитов доступа) и из `apps/common`
 *   (с `organizationId`). Дедупликация «по первому вхождению» отнесла бы его к
 *   глобальным справочникам.
 * @param {Object} scope — `{ type: 'full' }` либо `{ type: 'organization', organizationId }`
 * @returns {{tables: Array, warnings: Array<Object>, byClass: Object}}
 */
function buildPlan(models, scope) {
    const cfg = accessConfig();
    const isOrgScope = scope && scope.type === 'organization';
    const tables = [];
    const byClass = { [CLASS_ORG]: [], [CLASS_GLOBAL]: [], [CLASS_PERSONAL]: [], [CLASS_IDENTITY]: [] };
    const warnings = [];

    const seen = new Set();
    for (const m of (models || [])) {
        const table = m && m.tableName;
        if (!table || seen.has(table)) continue;   // collectAllModelDefs даёт дубли — дедуплицируем
        seen.add(table);

        const info = classify(m);
        byClass[info.cls].push(table);

        // Сигнал — НЕ сам факт попадания в класс B: `excluded_tables` заполняется
        // осознанно, и предупреждать о каждой его строке значит утопить сообщение в
        // шуме. Интересно обратное: таблица без реквизитов доступа, которой в
        // исключениях НЕТ. Она обязана была уронить стартовый валидатор — раз не
        // уронила, валидатор её не видит, и её данные не защищены RLS.
        if (info.cls === CLASS_GLOBAL && !cfg.excludedTables.has(table)) {
            warnings.push({ kind: 'no_access_field_not_excluded', table });
        }

        if (!isOrgScope) {
            tables.push({ table, model: m, cls: info.cls, filter: null });
            continue;
        }

        if (info.cls === CLASS_ORG) {
            tables.push({
                table, model: m, cls: info.cls,
                filter: { field: info.scopeField, via: info.scopeField === HOTEL_FIELD ? 'hotels' : null }
            });
        } else if (info.cls === CLASS_GLOBAL) {
            // Класс B едет целиком: он нужен для сверки ссылок при восстановлении,
            // но восстановлением НЕ пишется (§6.6).
            tables.push({ table, model: m, cls: info.cls, filter: null });
        } else if (info.cls === CLASS_IDENTITY) {
            // Класс D: только пользователи этой организации, и только для сверки.
            tables.push({
                table, model: m, cls: info.cls,
                filter: info.scopeField ? { field: info.scopeField, via: null } : null
            });
        }
        // Класс C в выгрузку организации не входит вовсе.
    }

    return { tables, warnings, byClass };
}

/**
 * SQL-условие отбора строк таблицы по организации.
 *
 * Возвращает готовый фрагмент и параметры. Транзитивный случай (`hotelId`) —
 * подзапросом по отелям организации, чтобы не тащить их список в память и не
 * зависеть от того, успели ли мы прочитать `hotels` раньше.
 *
 * @param {Object} filter — из `buildPlan`
 * @param {string} organizationId
 * @param {string} q — функция цитирования идентификатора диалекта
 * @returns {{sql: string, params: Object}|null}
 */
function buildWhere(filter, organizationId, q) {
    if (!filter) return null;
    const quote = q || ((s) => `"${s}"`);
    if (filter.field === 'UID') {
        return { sql: `${quote('UID')} = :scopeOrgId`, params: { scopeOrgId: organizationId } };
    }
    if (filter.field === ORG_FIELD) {
        return { sql: `${quote(ORG_FIELD)} = :scopeOrgId`, params: { scopeOrgId: organizationId } };
    }
    if (filter.field === HOTEL_FIELD) {
        return {
            sql: `${quote(HOTEL_FIELD)} IN (SELECT ${quote('UID')} FROM ${quote('hotels')} WHERE ${quote(ORG_FIELD)} = :scopeOrgId)`,
            params: { scopeOrgId: organizationId }
        };
    }
    return null;
}

/**
 * Строка принадлежит выгружаемой организации?
 *
 * Нужно там, где отбор идёт не запросом, а по уже прочитанной строке: правило 3 —
 * запись класса A с NULL в реквизите доступа глобальная (как в `guest_types`) и в
 * выгрузку организации не входит.
 */
function rowBelongsToOrg(row, filter, organizationId, hotelIds) {
    if (!filter) return true;
    const v = row[filter.field];
    if (v === null || v === undefined || v === '') return false;
    if (filter.field === ORG_FIELD) return String(v) === String(organizationId);
    if (filter.field === HOTEL_FIELD) return !!(hotelIds && hotelIds.has(String(v)));
    return false;
}

/**
 * Как частичное восстановление пишет таблицу этого класса.
 *
 *   `replace` — удалить строки организации и вставить из дампа (состояние становится
 *               ровно таким, как в копии);
 *   `upsert`  — создать недостающие, обновить существующие, НИЧЕГО не удалять;
 *   `none`    — не писать (глобальные справочники — общие; личное и системное к
 *               организации не относится).
 * @returns {'replace'|'upsert'|'none'}
 */
function restoreMode(cls) {
    if (cls === CLASS_ORG) return 'replace';
    if (cls === CLASS_IDENTITY) return 'upsert';
    return 'none';
}

/** Пишет ли частичное восстановление в таблицу этого класса. */
function isRestorable(cls) { return restoreMode(cls) !== 'none'; }

module.exports = {
    classify, buildPlan, buildWhere, rowBelongsToOrg, accessConfig, resetCache,
    isRestorable, restoreMode,
    CLASS_ORG, CLASS_GLOBAL, CLASS_PERSONAL, CLASS_IDENTITY,
    ORG_FIELD, HOTEL_FIELD, USER_FIELD, ORG_TABLE, IDENTITY_TABLES
};
