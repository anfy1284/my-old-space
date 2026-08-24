'use strict';

// ─────────────────────────────────────────────────────────────────────
// ДЕНЬГИ: единая арифметика сумм.
//
// Правило проекта: денежное поле — `DECIMAL(12,2)`, не `FLOAT`
// (ИНСТРУКЦИИ_ДЛЯ_AI.md, «Правовое соответствие»; GoBD требует
// воспроизводимости расчёта). Этот модуль — вторая половина правила:
// хранение точное, но считает всё равно JavaScript, где число — двоичная
// дробь и 0.1 + 0.2 даёт 0.30000000000000004.
//
// Поэтому здесь всё считается в ЦЕЛЫХ ЦЕНТАХ: сложение и вычитание тогда
// точны абсолютно, а округление остаётся ровно в двух местах — умножение
// и процент.
//
// Отдельно про округление. Привычное `Math.round(v * 100) / 100` неверно
// на границе половины цента: `1.005 * 100` в двоичном виде равно
// 100.49999999999999, и `Math.round` даёт 100 вместо 101. Здесь разбор
// идёт по ДЕСЯТИЧНОЙ ЗАПИСИ числа (`String(n)` — кратчайшая запись,
// однозначно задающая это число), поэтому 1.005 округляется до 1.01, как
// и ожидает человек, считающий налог.
//
// Округление — «половина от нуля» (kaufmännisches Runden): 1.005 → 1.01,
// −1.005 → −1.01. Так считает бухгалтерия, и так же обязан считать счёт.
//
// Про чтение из базы. `DECIMAL` возвращается драйвером postgres СТРОКОЙ
// («123.45»), а не числом — иначе точность терялась бы ровно там, где её
// хранили. Любая функция этого модуля принимает и строку, и число.
// ─────────────────────────────────────────────────────────────────────

const SCALE = 2;          // знаков после запятой у денег
const FACTOR = 100;       // центов в единице

/**
 * Точный разбор ДЕСЯТИЧНОЙ записи в центы, с округлением половины от нуля.
 * Работает со строкой, поэтому двоичное представление ни на что не влияет.
 */
function centsFromDecimalString(s) {
    const m = String(s).trim().match(/^([+-]?)(\d*)(?:[.,](\d*))?$/);
    if (!m) return NaN;

    const sign = m[1] === '-' ? -1 : 1;
    const intPart = m[2] || '0';
    const frac = m[3] || '';

    if (intPart === '' && frac === '') return NaN;

    const head = (frac.slice(0, SCALE) || '').padEnd(SCALE, '0');
    const tail = frac.slice(SCALE);

    let cents = Number(intPart) * FACTOR + Number(head);
    // Половина и больше — вверх по модулю. Смотрим первую отброшенную цифру.
    if (tail && tail.charCodeAt(0) >= 53 /* '5' */) cents += 1;

    return sign * cents;
}

/**
 * Любое денежное значение → целые центы.
 * Пустое значение (null, undefined, "", NaN) — это 0, а не ошибка:
 * по правилу проекта пустое число равно нулю (`emptyValues.js`).
 */
function cents(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'string') {
        const c = centsFromDecimalString(v);
        return isFinite(c) ? c : 0;
    }
    const n = Number(v);
    if (!isFinite(n)) return 0;

    const s = String(n);
    // Экспоненциальная запись (очень крупные/мелкие числа) — десятичного
    // разбора не выйдет; такие значения деньгами не бывают, считаем грубо.
    if (/e/i.test(s)) return Math.round(n * FACTOR);
    return centsFromDecimalString(s);
}

/** Центы → обычное число с двумя знаками. */
function fromCents(c) {
    return Math.round(c) / FACTOR;
}

/** Нормализованное денежное число (для расчётов, JSON, сравнения). */
function num(v) {
    return fromCents(cents(v));
}

/** Округление до цента. Синоним `num`, названный по действию. */
function round(v) {
    return fromCents(cents(v));
}

/** Сумма любого количества значений. Складывается в центах — точно. */
function add(...vals) {
    let c = 0;
    for (const v of vals) c += cents(v);
    return fromCents(c);
}

/** Разность: a − b − … */
function sub(a, ...rest) {
    let c = cents(a);
    for (const v of rest) c -= cents(v);
    return fromCents(c);
}

/** Сумма массива (или массива объектов по имени поля). */
function sum(arr, field) {
    if (!Array.isArray(arr)) return 0;
    let c = 0;
    for (const item of arr) {
        c += cents(field ? (item && item[field]) : item);
    }
    return fromCents(c);
}

/**
 * Деньги × множитель (количество, коэффициент).
 * Единственное место, кроме процента, где появляется округление.
 */
function mul(amount, factor) {
    const f = Number(factor);
    if (!isFinite(f)) return 0;
    return fromCents(roundHalfAwayFromZero(cents(amount) * f));
}

/** Процент от суммы: amount × percent / 100. */
function pct(amount, percent) {
    const p = Number(percent);
    if (!isFinite(p)) return 0;
    return fromCents(roundHalfAwayFromZero(cents(amount) * p / 100));
}

/**
 * Округление половины от нуля для промежуточного (уже центового) значения.
 * `Math.round` округляет половину ВВЕРХ (−0.5 → −0), что на отрицательных
 * суммах — а они появляются в сторно — расходится с бухгалтерским правилом.
 */
function roundHalfAwayFromZero(x) {
    return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * Значение для записи в колонку `DECIMAL` — строка с двумя знаками.
 * Строкой, а не числом: так значение доходит до базы ровно таким, каким
 * его посчитали, без обратного превращения в двоичную дробь.
 */
function db(v) {
    return (cents(v) / FACTOR).toFixed(SCALE);
}

/** Ноль ли это (с точностью до цента). */
function isZero(v) {
    return cents(v) === 0;
}

/** Сравнение: −1, 0, 1 — по центам, а не по двоичным дробям. */
function cmp(a, b) {
    const ca = cents(a), cb = cents(b);
    return ca < cb ? -1 : (ca > cb ? 1 : 0);
}

module.exports = {
    SCALE,
    cents,
    fromCents,
    num,
    round,
    add,
    sub,
    sum,
    mul,
    pct,
    db,
    isZero,
    cmp
};
