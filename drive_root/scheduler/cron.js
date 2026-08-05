'use strict';

/**
 * cron — расписание регламентного задания: сборка cron-строки из конструктора,
 * расчёт следующего срабатывания и расшифровка человеческим языком.
 *
 * ── О «единственном источнике правды» ───────────────────────────────────────
 * `scheduler_tasks.cronExpression` пересчитывается сервером ПРИ КАЖДОМ сохранении
 * из полей конструктора (кроме режима `cron`, где значение вводит пользователь) —
 * поэтому разъехаться с конструктором он не может.
 *
 * Но САМ РАСЧЁТ времени для конструктора идёт по полям, а не по cron-строке, и это
 * осознанное решение: cron не выражает часть режимов без искажения.
 *   • «каждые 90 минут» в cron невыразимо (шаг вне диапазона 0–59). Молча округлить
 *     до 60 или 45 — соврать пользователю.
 *   • «31 числа» в cron просто ПРОПУСКАЕТ февраль, тогда как по ТЗ значение больше
 *     числа дней месяца означает последний день месяца.
 * Для режима `cron` расчёт идёт через `cron-parser` — там строка и есть спецификация.
 *
 * Все расчёты — в таймзоне задачи (`timezone`), с учётом перехода на летнее время:
 * «ежедневно в 03:00 Europe/Berlin» остаётся 03:00 по стене круглый год.
 */

const log = require('../log');

// ── Работа с настенным временем в произвольной таймзоне ──────────────────────
// Intl даёт разложение UTC-момента на «стенные» части в нужной зоне; обратный
// переход (стена → UTC) делается подбором смещения в два прохода — этого хватает
// для любых реальных зон, включая переходы на летнее время.

function _wallParts(date, tz) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
    });
    const map = {};
    for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
    const DOW = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        year: Number(map.year),
        month: Number(map.month),          // 1..12
        day: Number(map.day),
        hour: Number(map.hour) % 24,
        minute: Number(map.minute),
        second: Number(map.second),
        dow: DOW[map.weekday] || 7          // 1 = понедельник … 7 = воскресенье
    };
}

/** Смещение зоны (мс) в конкретный момент времени. */
function _tzOffsetMs(date, tz) {
    const p = _wallParts(date, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - date.getTime();
}

/** Настенное время зоны → момент UTC. */
function _wallToUtc({ year, month, day, hour = 0, minute = 0 }, tz) {
    const target = Date.UTC(year, month - 1, day, hour, minute, 0);
    let ts = target - _tzOffsetMs(new Date(target), tz);
    ts = target - _tzOffsetMs(new Date(ts), tz);   // второй проход — уточнение около перехода DST
    return new Date(ts);
}

function daysInMonth(year, month /* 1..12 */) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 'HH:MM' → { hour, minute }; мусор и пустое → 00:00. */
function parseTimeOfDay(value) {
    const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(String(value || ''));
    if (!m) return { hour: 0, minute: 0 };
    return {
        hour: Math.min(23, Math.max(0, Number(m[1]))),
        minute: Math.min(59, Math.max(0, Number(m[2])))
    };
}

/** '1,3,5' → [1,3,5] (1 = понедельник). Пустое → все дни. */
function parseWeekDays(value) {
    const days = String(value || '')
        .split(/[,\s]+/)
        .map(x => Number(x))
        .filter(n => Number.isInteger(n) && n >= 1 && n <= 7);
    const uniq = Array.from(new Set(days)).sort((a, b) => a - b);
    return uniq.length ? uniq : [1, 2, 3, 4, 5, 6, 7];
}

// ── cron-строка ──────────────────────────────────────────────────────────────

/**
 * Собрать cron-строку из полей конструктора. Для режима `cron` возвращает
 * пользовательское выражение как есть.
 * @returns {string} выражение или '' если режим в cron невыразим (см. шапку файла)
 */
function buildCronExpression(task) {
    const mode = task && task.scheduleMode;
    const { hour, minute } = parseTimeOfDay(task && task.timeOfDay);

    switch (mode) {
        case 'cron':
            return String((task && task.cronExpression) || '').trim();
        case 'interval': {
            const n = Number(task && task.intervalMinutes) || 0;
            if (n > 0 && n < 60) return `*/${n} * * * *`;
            if (n >= 60 && n % 60 === 0 && n / 60 < 24) return `0 */${n / 60} * * *`;
            return ''; // невыразимо в cron — расчёт идёт по intervalMinutes
        }
        case 'weekly': {
            const days = parseWeekDays(task && task.weekDays).map(d => (d === 7 ? 0 : d));
            return `${minute} ${hour} * * ${days.join(',')}`;
        }
        case 'monthly': {
            const day = Math.min(31, Math.max(1, Number(task && task.monthDay) || 1));
            return `${minute} ${hour} ${day} * *`;
        }
        case 'daily':
        default:
            return `${minute} ${hour} * * *`;
    }
}

/** Загрузка cron-parser: нужен ТОЛЬКО для режима «расширенно (cron)». */
let _cronParser = null;
let _cronParserMissingLogged = false;
function _getCronParser() {
    if (_cronParser) return _cronParser;
    try {
        const mod = require('cron-parser');
        // v5: { CronExpressionParser.parse }, v4: { parseExpression }
        if (mod && mod.CronExpressionParser && typeof mod.CronExpressionParser.parse === 'function') {
            _cronParser = (expr, opts) => mod.CronExpressionParser.parse(expr, opts);
        } else if (mod && typeof mod.parseExpression === 'function') {
            _cronParser = (expr, opts) => mod.parseExpression(expr, opts);
        } else {
            throw new Error('неизвестный API пакета cron-parser');
        }
    } catch (e) {
        if (!_cronParserMissingLogged) {
            _cronParserMissingLogged = true;
            log.error('[scheduler/cron] Пакет cron-parser недоступен — режим «расширенно (cron)» отключён: '
                + (e && e.message || e));
        }
        return null;
    }
    return _cronParser;
}

/**
 * Проверить cron-выражение.
 * @returns {{ok: boolean, errorKey?: string, vars?: Object}}
 */
function validateCron(expression, timezone) {
    const expr = String(expression || '').trim();
    if (!expr) return { ok: false, errorKey: 'sched_err_cron_empty' };
    const parse = _getCronParser();
    if (!parse) return { ok: false, errorKey: 'sched_err_cron_unavailable' };
    try {
        parse(expr, { currentDate: new Date(), tz: timezone || 'UTC' });
        return { ok: true };
    } catch (e) {
        return { ok: false, errorKey: 'sched_err_cron_invalid', vars: { message: e && e.message || String(e) } };
    }
}

// ── Расчёт следующего срабатывания ───────────────────────────────────────────

/**
 * Следующее срабатывание задачи СТРОГО после `from`.
 * @param {Object} task — запись scheduler_tasks
 * @param {Date} [from=new Date()]
 * @returns {Date|null} null, если расписание нерасчётно (битый cron и т.п.)
 */
function computeNextRun(task, from) {
    const tz = (task && task.timezone) || 'Europe/Berlin';
    const base = (from instanceof Date && !isNaN(from.getTime())) ? from : new Date();
    const mode = (task && task.scheduleMode) || 'daily';

    if (mode === 'cron') {
        const parse = _getCronParser();
        if (!parse) return null;
        try {
            const it = parse(String(task.cronExpression || '').trim(), { currentDate: base, tz });
            const next = it.next();
            return next instanceof Date ? next : next.toDate();
        } catch (e) {
            log.error(`[scheduler/cron] Не разобрано выражение "${task && task.cronExpression}": ${e && e.message || e}`);
            return null;
        }
    }

    if (mode === 'interval') {
        const n = Number(task && task.intervalMinutes) || 0;
        if (n <= 0) return null;
        return new Date(base.getTime() + n * 60 * 1000);
    }

    const { hour, minute } = parseTimeOfDay(task && task.timeOfDay);
    const nowParts = _wallParts(base, tz);

    if (mode === 'weekly') {
        const days = parseWeekDays(task && task.weekDays);
        // Ищем ближайший подходящий день в пределах двух недель — с запасом на DST.
        for (let add = 0; add <= 14; add++) {
            const probe = _addDaysWall(nowParts, add);
            const dow = _dowOfWall(probe);
            if (!days.includes(dow)) continue;
            const candidate = _wallToUtc({ ...probe, hour, minute }, tz);
            if (candidate.getTime() > base.getTime()) return candidate;
        }
        return null;
    }

    if (mode === 'monthly') {
        const wanted = Math.min(31, Math.max(1, Number(task && task.monthDay) || 1));
        let { year, month } = nowParts;
        for (let i = 0; i < 24; i++) {
            const day = Math.min(wanted, daysInMonth(year, month)); // > числа дней → последний день
            const candidate = _wallToUtc({ year, month, day, hour, minute }, tz);
            if (candidate.getTime() > base.getTime()) return candidate;
            month++;
            if (month > 12) { month = 1; year++; }
        }
        return null;
    }

    // daily (и любой нераспознанный режим — самый безобидный вариант)
    for (let add = 0; add <= 2; add++) {
        const probe = _addDaysWall(nowParts, add);
        const candidate = _wallToUtc({ ...probe, hour, minute }, tz);
        if (candidate.getTime() > base.getTime()) return candidate;
    }
    return null;
}

/** Сдвиг настенной даты на N суток (через UTC-полдень — не спотыкается о DST). */
function _addDaysWall(parts, addDays) {
    const noon = Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0) + addDays * 86400000;
    const d = new Date(noon);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** День недели настенной даты: 1 = понедельник … 7 = воскресенье. */
function _dowOfWall(parts) {
    const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
    return d.getUTCDay() === 0 ? 7 : d.getUTCDay();
}

// ── Расшифровка человеческим языком ──────────────────────────────────────────

/**
 * Расшифровать расписание («каждый день в 03:00, Europe/Berlin»).
 * @param {Object} task
 * @param {Function} tf — переводчик (key, vars) => string
 */
function describeSchedule(task, tf) {
    const tz = (task && task.timezone) || 'Europe/Berlin';
    const mode = (task && task.scheduleMode) || 'daily';
    const { hour, minute } = parseTimeOfDay(task && task.timeOfDay);
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

    switch (mode) {
        case 'interval': {
            const n = Number(task && task.intervalMinutes) || 0;
            if (n <= 0) return tf('sched_desc_not_set', {});
            return tf('sched_desc_interval', { minutes: n, tz });
        }
        case 'weekly': {
            const names = parseWeekDays(task && task.weekDays).map(d => tf(`sched_dow_${d}`, {}));
            return tf('sched_desc_weekly', { days: names.join(', '), time, tz });
        }
        case 'monthly': {
            const day = Math.min(31, Math.max(1, Number(task && task.monthDay) || 1));
            return tf('sched_desc_monthly', { day, time, tz });
        }
        case 'cron':
            return tf('sched_desc_cron', { expression: String((task && task.cronExpression) || '').trim(), tz });
        case 'daily':
        default:
            return tf('sched_desc_daily', { time, tz });
    }
}

module.exports = {
    buildCronExpression,
    computeNextRun,
    describeSchedule,
    validateCron,
    parseTimeOfDay,
    parseWeekDays,
    daysInMonth
};
