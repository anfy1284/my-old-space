'use strict';

/**
 * alertRules — РЕЕСТР ПРАВИЛ ОПОВЕЩЕНИЙ (ТЗ «Оповещения по документам», §5).
 *
 * Правило — ИМЕНОВАННАЯ ФУНКЦИЯ приложения с кодом и уровнем важности. Оно
 * отвечает на один вопрос: «что я хочу сказать человеку про ЭТОТ документ
 * СЕЙЧАС», и возвращает массив строк. Правило ничего не удаляет и не знает, что
 * было раньше: старые строки снимает ядро (`documentAlerts.rebuild`) — ровно как
 * с движениями регистров.
 *
 * ── Объявление ───────────────────────────────────────────────────────────────
 * Файл `apps/<app>/alerts.rules.js` — ЧИСТАЯ ФАБРИКА без побочных эффектов, его
 * грузят ОБА процесса (главный и форкнутый воркер планировщика). Регистрация
 * через `init.js` не годится: `init.js` выполняет только главный процесс, а
 * пересчёт идёт внутри проведения, то есть в воркере.
 *
 *     module.exports = function (modelsDB, Utilities) {
 *         const rules = require('./hooks/alerts')(modelsDB, Utilities);
 *         return {
 *             'booking.overInvoiced': {
 *                 severity: 'error',
 *                 table: 'bookings',
 *                 build: rules.buildOverInvoiced       // именованная функция
 *             },
 *             'booking.notInvoiced': {
 *                 severity: 'warning',
 *                 table: 'bookings',
 *                 timeDependent: true,                 // пересчёт раз в сутки
 *                 select: rules.selectDeparted,        // какие документы смотреть
 *                 build: rules.buildNotInvoiced
 *             }
 *         };
 *     };
 *
 * ── Что значат поля объявления ───────────────────────────────────────────────
 * | `severity`      | `info` / `warning` / `error` — перечисление ЯДРА (§9)        |
 * | `table`         | документная таблица, к которой правило относится             |
 * | `build`         | `(doc, ctx) => Array<alert>` — что сказать человеку           |
 * | `onMovements`   | пересчитывать при изменении движений (умолчание — да)        |
 * | `timeDependent` | пересчитывать раз в сутки регламентным заданием (нет)        |
 * | `select`        | `(ctx) => Array<{table,uid}|uid>` — чьи документы смотреть    |
 *
 * **Почему `onMovements` — отдельный ключ.** Поводов пересчёта в ТЗ два
 * (движения и время), но есть правило, у которого повод третий: предупреждения
 * расчёта счёта порождаются ЗАПОЛНЕНИЕМ (§15). Пересчитывать их при проведении
 * нельзя — заново считать состав брони по уже выставленному счёту значит
 * показать владелице предупреждение про услугу, которую она изменила ПОСЛЕ
 * выставления и исправить в этом счёте всё равно не может. Поэтому такое правило
 * объявляет `onMovements: false` и переписывается ровно тем действием, которое
 * его породило.
 *
 * **Почему `select` принадлежит правилу.** Гонять по времени все документы
 * подряд — лишняя работа, а не гонять вовсе — значит никогда не заметить
 * забытый счёт (§6). Кто попадает под правило, знает только оно само: «гость
 * выехал, а счёта нет» отбирается по дате выезда, которой ядро не знает.
 */

const appFactories = require('../appFactories');

const RULES_FILE = 'alerts.rules.js';
const SEVERITIES = new Set(['info', 'warning', 'error']);

let _rules = null;   // Map<code, declaration>

/** Проверка объявления. Кривое правило лучше отбросить с криком, чем промолчать. */
function validate(code, decl) {
    if (!decl || typeof decl !== 'object') return `правило "${code}": объявление должно быть объектом`;
    if (typeof decl.build !== 'function') return `правило "${code}": нет функции build()`;
    if (!decl.table || typeof decl.table !== 'string') return `правило "${code}": не указана таблица документа`;
    if (decl.severity && !SEVERITIES.has(decl.severity)) {
        return `правило "${code}": неизвестная важность "${decl.severity}"`;
    }
    if (decl.timeDependent && typeof decl.select !== 'function') {
        return `правило "${code}": timeDependent без select() — отбирать документы некому`;
    }
    if (decl.select && typeof decl.select !== 'function') return `правило "${code}": select должен быть функцией`;
    return null;
}

/**
 * Загрузить (или перечитать) реестр.
 * @param {object} [modelsDB]
 * @param {object} [Utilities]
 * @returns {Map<string, object>}
 */
function load(modelsDB, Utilities) {
    _rules = appFactories.load({
        fileName: RULES_FILE,
        tag: '[alertRules]',
        modelsDB: modelsDB || appFactories.defaultModels(),
        Utilities: Utilities || appFactories.defaultUtilities(),
        accept: (code, decl, appName) => {
            const err = validate(code, decl);
            if (err) return { error: err };
            return {
                value: Object.assign({
                    code,
                    appName,
                    severity: 'warning',
                    onMovements: true,
                    timeDependent: false,
                    select: null
                }, decl)
            };
        }
    });
    return _rules;
}

function ensureLoaded(modelsDB, Utilities) {
    if (!_rules) load(modelsDB, Utilities);
    return _rules;
}

/** Правило по коду или `null` (правило могло исчезнуть вместе с приложением). */
function get(code) {
    return ensureLoaded().get(code) || null;
}

/** Все правила. */
function all() {
    return Array.from(ensureLoaded().values());
}

/**
 * Правила одной таблицы.
 * @param {string} table
 * @param {object} [filter] — `{ onMovements: true }` / `{ timeDependent: true }`
 */
function forTable(table, filter) {
    return all().filter(r => r.table === table
        && (!filter || !filter.onMovements || r.onMovements)
        && (!filter || !filter.timeDependent || r.timeDependent));
}

/** Правила, зависящие от времени (суточный проход). */
function timeDependent() {
    return all().filter(r => r.timeDependent);
}

/** Коды всех объявленных правил — для диагностики. */
function list() {
    return Array.from(ensureLoaded().keys());
}

module.exports = { RULES_FILE, SEVERITIES, load, ensureLoaded, get, all, forTable, timeDependent, list };
