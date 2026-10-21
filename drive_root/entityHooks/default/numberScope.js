'use strict';

/**
 * numberScope — область нумерации сущностей.
 *
 * Номера документов и справочников уникальны и непрерывны В РАЗРЕЗЕ ОРГАНИЗАЦИИ, а не
 * по всей инсталляции. Причина прикладная, а не техническая: инсталляция обслуживает
 * несколько арендаторов, и сквозная нумерация означала бы, что номер счёта клиента А
 * зависит от того, сколько документов завёл клиент Б. В журнале одной организации
 * номера шли бы с дырами через десятки, а попытка завести у себя документ с «занятым»
 * соседом номером отвергалась бы как дубликат. Ни того ни другого пользователь объяснить
 * себе не может.
 *
 * Модуль общий для `default.autoNumber` (какой номер выдать) и `default.uniqueNumber`
 * (с чем сверять на уникальность): обе стороны обязаны понимать область ОДИНАКОВО,
 * иначе автонумерация выдаст номер, который тут же отвергнет контроль уникальности.
 *
 * Таблицы без реквизита области (`scheduler_*`, `backup_config`, `db_versions` — ядро
 * фреймворка, где организации нет) нумеруются сквозным образом, как и раньше.
 */

const DEFAULT_SCOPE_FIELD = 'organizationId';
const FALLBACK_SCOPE_FIELD = 'hotelId';

/**
 * Есть ли у модели реквизит области.
 * @returns {boolean}
 */
function hasScopeField(Model, scopeField) {
    return !!(Model && Model.rawAttributes && scopeField && Model.rawAttributes[scopeField]);
}

/**
 * Значение области для сохраняемой записи.
 *
 * На создании оно уже лежит в данных (прикладной `onBeforeSave` заполняет организацию
 * первым делом). На обновлении его может не быть в `changes` — тогда читаем из самой
 * записи: перенумеровывать документ в чужую область недопустимо.
 *
 * @returns {Promise<{scoped: boolean, field?: string, value?: *}>}
 */
async function resolveScopeValue(request, Model, params = {}) {
    // `scopeField: null` в параметрах хука — осознанный отказ от сужения.
    const explicit = Object.prototype.hasOwnProperty.call(params, 'scopeField');
    let scopeField = explicit ? params.scopeField : DEFAULT_SCOPE_FIELD;
    // Нет организации, но есть гостиница (номера) — область = гостиница. То же правило,
    // что у области резервной копии (backup/scope.js). Без него номера комнат шли
    // сквозь все организации: новая получала 6, 7, 8, 9 (прогон 17.10.2026, S4).
    if (!explicit && !hasScopeField(Model, scopeField) && hasScopeField(Model, FALLBACK_SCOPE_FIELD)) {
        scopeField = FALLBACK_SCOPE_FIELD;
    }
    if (!scopeField) return { scoped: false };
    if (!hasScopeField(Model, scopeField)) return { scoped: false };

    const data = request.data || {};
    if (Object.prototype.hasOwnProperty.call(data, scopeField)) {
        return { scoped: true, field: scopeField, value: data[scopeField] };
    }

    const uid = data.UID || extractSelfUID(request.where);
    if (uid) {
        try {
            const row = await Model.findOne({ where: { UID: uid }, attributes: [scopeField], raw: true });
            if (row) return { scoped: true, field: scopeField, value: row[scopeField] };
        } catch (e) {
            // Не смогли прочитать — сужать наугад нельзя: номер уехал бы в чужую
            // область. Честнее вернуться к сквозной нумерации и не соврать.
            console.error(`[numberScope] Не удалось прочитать ${scopeField} записи ${uid}: ${e.message}`);
        }
    }
    return { scoped: false };
}

/**
 * UID текущей записи из `where`.
 *
 * К моменту запуска хука (root-уровень) app-level RLS-middleware мог обернуть исходный
 * `where` в `{ [Op.and]: [ {UID}, {Op.or:[…]} ] }`, поэтому прямого `where.UID` может не
 * быть — ищем рекурсивно.
 */
function extractSelfUID(where) {
    // Одно правило на всё ядро — drive_root/db/whereUid.js. Раньше здесь искали и
    // внутри Op.or, где RLS держит свои фильтры: так фильтр можно принять за запись.
    return require('../../db/whereUid').uidOf(where);
}

/**
 * Условие отбора по области нумерации — одно на автонумерацию и проверку
 * уникальности (16.10.2026). Пустая область (организации нет) хранится по-разному:
 * NULL или пустая строка, а в запрос приходила как `undefined` — Sequelize на это
 * бросает, исключение глоталось, номеров «не было», и все 4095 запусков задач
 * получили номер «00001» (проверка уникальности ломалась тем же способом).
 */
function scopeCondition(scope) {
    if (!scope || !scope.scoped) return {};
    const { Op } = require('sequelize');
    const v = scope.value;
    if (v === undefined || v === null || v === '') return { [scope.field]: { [Op.or]: [null, ''] } };
    return { [scope.field]: v };
}

module.exports = { resolveScopeValue, extractSelfUID, hasScopeField, scopeCondition, DEFAULT_SCOPE_FIELD };
