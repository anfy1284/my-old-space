'use strict';

/**
 * formAddress.js — АДРЕС формы.
 *
 * У формы две разные вещи, которые раньше делало одно поле `tableName`:
 *
 *   АДРЕС   — по какому ключу искать лейаут;
 *   ПРЕДМЕТ — с чем форма работает (модель, запись, замок, сохранение, проведение).
 *
 * Пока адрес собирался из предмета, форма без предмета была невозможна: приходилось
 * выдумывать таблицу, которой нет в базе (так жило приложение «Удаление помеченных»).
 * Здесь адрес объявлен сам по себе.
 *
 * Адрес формы = `приложение | имя формы | роль | представление`.
 *
 * Имя формы у ТАБЛИЧНОЙ формы строится канонически и выписывать его руками нельзя:
 * иначе имя и таблица однажды разойдутся, и найти это будет нечем. Поэтому функция
 * построения ровно одна на весь фреймворк, и ей пользуются оба конца — и место
 * регистрации (`layoutMemory.saveLayout`), и место подбора (`apps/uniForm/server.js`).
 *
 *   record:bookings   форма записи
 *   list:bookings     журнал
 *
 * Имя формы БЕЗ предмета — произвольная строка приложения (`prepaymentDialog`).
 * Двоеточие в ней запрещено: оно занято каноном табличных имён.
 */

const KIND_RECORD = 'record';
const KIND_LIST   = 'list';

/**
 * Каноническое имя формы таблицы.
 * @param {string} kind  — 'record' (по умолчанию) | 'list'
 * @param {string} table — имя таблицы
 * @returns {string}     — 'record:bookings'
 */
function forSubject(kind, table) {
    if (!table || typeof table !== 'string') {
        throw new Error('[formAddress.forSubject] table (string) required');
    }
    const k = kind === KIND_LIST ? KIND_LIST : KIND_RECORD;
    return `${k}:${table}`;
}

/**
 * Разбор канонического имени. Для именованной формы возвращает null —
 * предмета у неё нет, и выдумывать его по имени нельзя.
 * @param {string} formName
 * @returns {{kind:string, table:string}|null}
 */
function parse(formName) {
    if (!formName || typeof formName !== 'string') return null;
    const i = formName.indexOf(':');
    if (i <= 0) return null;
    const kind = formName.slice(0, i);
    const table = formName.slice(i + 1);
    if ((kind !== KIND_RECORD && kind !== KIND_LIST) || !table) return null;
    return { kind, table };
}

/** Имя формы выведено из предмета (а не придумано приложением)? */
function isSubjectName(formName) {
    return !!parse(formName);
}

/**
 * Проверка имени, которое приложение выписало руками.
 * Бросает, если имя занято каноном табличных форм или пустое.
 * @param {string} formName
 */
function assertNamed(formName) {
    if (!formName || typeof formName !== 'string') {
        throw new Error('[formAddress] form (string) required');
    }
    if (formName.indexOf(':') >= 0) {
        throw new Error(`[formAddress] имя формы «${formName}» содержит «:» — двоеточие занято каноном табличных форм (record:<таблица> / list:<таблица>). Табличную форму объявляют предметом: saveLayout({ subject: { table, kind } })`);
    }
    if (formName.indexOf('|') >= 0) {
        throw new Error(`[formAddress] имя формы «${formName}» содержит «|» — этим символом разделяются части адреса`);
    }
    return formName;
}

module.exports = { forSubject, parse, isSubjectName, assertNamed, KIND_RECORD, KIND_LIST };
