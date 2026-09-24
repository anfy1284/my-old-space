'use strict';

/**
 * dates — ГРАНИЦЫ СУТОК. Общие функции ядра, доступные прикладному коду.
 *
 * Зачем они понадобились (24.09.2026, по требованию владельца — такие функции
 * есть в любой зрелой учётной системе и там ими пользуется прикладной программист).
 *
 * Дата, выбранная человеком в интерфейсе, и дата, собранная в коде
 * (`new Date(год, месяц, 1)`), — это ПОЛНОЧЬ. Момент документа — это метка
 * времени с часами. Поэтому «период по 30 сентября», записанное в лоб как
 * `период <= 30.09`, означает «по 30 сентября 00:00:00» и выбрасывает весь
 * последний день периода. Ровно на этом в один день поймались две вещи:
 *
 *   - кассовая книга за месяц теряла обороты 30-го числа целиком
 *     (§ 146 Abs. 1 Satz 2 AO — в книге обязаны быть поступления КАЖДОГО дня);
 *   - дата запрета редактирования «30.09» не закрывала 30 сентября.
 *
 * Лечить это на каждом месте вызова нельзя: `to + 1 день` читается как «мы
 * зачем-то прибавили сутки», и следующий человек его снимет как лишнее. Смысл
 * обязан быть НАЗВАН, поэтому граница периода пишется так:
 *
 *     const { startOfDay, endOfDay } = require('./dates');
 *     where.period = { [Op.between]: [startOfDay(from), endOfDay(to)] };
 *     if (documentDate <= endOfDay(closingDate)) { ... }
 *
 * СУТКИ — МЕСТНЫЕ. «30 сентября» для человека — это календарный день там, где
 * он живёт, а не сутки UTC. Остальной код этой системы считает так же
 * (`fmtDate` печатает `d.getDate()`), и вводить здесь второе понимание суток
 * значило бы развести печать и отбор на несколько часов.
 *
 * ПУСТАЯ ДАТА ОСТАЁТСЯ ПУСТОЙ. `0001-01-01` — это «не заполнено»
 * (`drive_root/db/emptyValues.js`), и растягивать её до конца тех суток
 * бессмысленно: вызывающий проверяет заполненность сам, а молча вернуть ему
 * «конец первого года нашей эры» — значит подсунуть в сравнение значение,
 * которое выглядит осмысленным. Возвращается `null`.
 *
 * Клиентское зеркало — `MySpace.startOfDay` / `MySpace.endOfDay`
 * (`drive_forms/resources/public/UI_classes.js`). Правило обязано быть одним на
 * обе стороны, иначе форма и сервер разойдутся на границе суток.
 */

const emptyValues = require('./emptyValues');

/**
 * Привести значение к `Date` или вернуть `null`.
 * Пустая дата системы (`0001-01-01`) — это «не заполнено», а не дата.
 */
function toDate(v) {
    if (v === null || v === undefined || v === '') return null;
    const d = (v instanceof Date) ? new Date(v.getTime()) : new Date(v);
    if (isNaN(d.getTime())) return null;
    if (emptyValues.isEmptyDate(d)) return null;
    return d;
}

/**
 * НАЧАЛО СУТОК — 00:00:00.000 того же местного дня.
 *
 * @param {Date|string|number} v
 * @returns {Date|null} `null`, если дата не заполнена или не разобрана
 */
function startOfDay(v) {
    const d = toDate(v);
    if (!d) return null;
    d.setHours(0, 0, 0, 0);
    return d;
}

/**
 * КОНЕЦ СУТОК — 23:59:59.999 того же местного дня.
 *
 * Именно 23:59:59.999, а не «начало следующего дня»: граница включающая, и
 * сравнение остаётся `<=`, как его и читают. Полночь следующего дня потребовала
 * бы строгого `<` у каждого вызывающего, а перепутать `<` и `<=` — это ровно та
 * ошибка, ради которой заведены эти функции.
 *
 * @param {Date|string|number} v
 * @returns {Date|null} `null`, если дата не заполнена или не разобрана
 */
function endOfDay(v) {
    const d = toDate(v);
    if (!d) return null;
    d.setHours(23, 59, 59, 999);
    return d;
}

/**
 * НАЧАЛО МЕСЯЦА — 1-е число, 00:00:00.000 местного времени.
 *
 * Пара к `endOfMonth`. Нужны там, где период задаётся не двумя датами, а
 * месяцем: кассовая книга ведётся по месяцам, отчёт «за сентябрь» не должен
 * собираться вычитанием тридцати суток.
 *
 * @param {Date|string|number} v — любая дата внутри месяца
 * @returns {Date|null}
 */
function startOfMonth(v) {
    const d = toDate(v);
    if (!d) return null;
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
}

/**
 * КОНЕЦ МЕСЯЦА — последний его день, 23:59:59.999 местного времени.
 *
 * Собирается через «нулевой день следующего месяца», поэтому длина месяца и
 * високосный февраль считаются сами. Приём `new Date(год, месяц + 1, 0)`,
 * написанный на месте вызова, даёт ПОЛНОЧЬ последнего дня — и именно из-за него
 * кассовая книга теряла обороты 30-го числа целиком.
 *
 * @param {Date|string|number} v — любая дата внутри месяца
 * @returns {Date|null}
 */
function endOfMonth(v) {
    const d = toDate(v);
    if (!d) return null;
    d.setDate(1);                       // сначала на 1-е: 31 января + 1 месяц дало бы март
    d.setMonth(d.getMonth() + 1, 0);    // нулевой день следующего месяца = последний этого
    d.setHours(23, 59, 59, 999);
    return d;
}

/**
 * Сдвиг на целое число МЕСЯЦЕВ, с прижатием к последнему дню.
 *
 * `setMonth` сам по себе переливается через край: 31 марта минус месяц даёт
 * 3 марта (31 февраля не существует). Здесь день прижимается к последнему
 * числу целевого месяца — 31 марта минус месяц = 28 (или 29) февраля.
 *
 * @param {Date|string|number} v
 * @param {number} months — может быть отрицательным
 * @returns {Date|null}
 */
function addMonths(v, months) {
    const d = toDate(v);
    if (!d) return null;
    const n = Number(months);
    if (!isFinite(n)) return d;
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + Math.trunc(n));
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
    return d;
}

/**
 * Тот же местный день? Сравнение по календарному дню, а не по метке времени.
 * @returns {boolean}
 */
function isSameDay(a, b) {
    const x = startOfDay(a);
    const y = startOfDay(b);
    if (!x || !y) return false;
    return x.getTime() === y.getTime();
}

/**
 * Сдвиг на целое число СУТОК. Не «плюс 86 400 000 мс»: при переходе на летнее
 * время в сутках 23 или 25 часов, и арифметика в миллисекундах дважды в год
 * даёт предыдущий или следующий день.
 *
 * @param {Date|string|number} v
 * @param {number} days — может быть отрицательным
 * @returns {Date|null}
 */
function addDays(v, days) {
    const d = toDate(v);
    if (!d) return null;
    const n = Number(days);
    if (!isFinite(n)) return d;
    d.setDate(d.getDate() + Math.trunc(n));
    return d;
}

module.exports = {
    startOfDay, endOfDay,
    startOfMonth, endOfMonth,
    isSameDay, addDays, addMonths,
    toDate
};
