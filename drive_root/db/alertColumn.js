'use strict';

/**
 * alertColumn — КОЛОНКА ОПОВЕЩЕНИЙ В ЖУРНАЛЕ (ТЗ «Оповещения по документам», §11).
 *
 * Своя узкая колонка СЛЕВА от колонки состояния: значок уровня самого важного
 * оповещения по строке, пусто — если оповещений нет. Подсказка при наведении —
 * сами тексты.
 *
 * ── Почему отдельная колонка, а не значок в колонке состояния ────────────────
 * Это РАЗНЫЕ ФАКТЫ. Состояние объекта («проведён», «помечен») — то, что с
 * документом сделали; оповещение — то, что про него думает программа. Сложив их
 * в одну колонку, мы получили бы непредсказуемые сортировку и отбор по
 * проведённости: значок в ячейке перестал бы соответствовать её значению.
 *
 * ── Почему значения считаются одним запросом ─────────────────────────────────
 * Журнал открывает сотню строк. Запрос на строку — это не «медленнее», это
 * другой порядок времени открытия окна (то же правило, что у вычисляемых
 * реквизитов журнала, `listAttributes`).
 *
 * ── Почему колонки нет у таблицы без правил ──────────────────────────────────
 * Пустая колонка в журнале хуже отсутствующей: она занимает место и обещает
 * сведения, которых не бывает.
 */

const documentAlerts = require('./documentAlerts');
const alertRules = require('./alertRules');

/** Синтетические поля строки. Двойное подчёркивание — они не поля модели. */
const COLUMN = '__documentAlert';
const TITLE_FIELD = '__documentAlertText';

/** Есть ли у таблицы хоть одно правило оповещений. */
function hasRules(tableName) {
    try { return alertRules.forTable(tableName).length > 0; } catch (e) { return false; }
}

/**
 * Дописать колонку оповещений в начало набора колонок.
 *
 * Зовётся ПОСЛЕ `entityStateColumn.prepend`, поэтому и оказывается слева от
 * колонки состояния — порядок вызовов и есть порядок колонок.
 *
 * @param {string} tableName
 * @param {Array} fields
 * @returns {Array} новый набор
 */
function prepend(tableName, fields) {
    if (!Array.isArray(fields) || !hasRules(tableName)) return fields;
    if (fields.some(f => f && f.name === COLUMN)) return fields;

    const valueIcons = {};
    const iconTitles = {};
    for (const s of Object.values(documentAlerts.SEVERITY)) {
        valueIcons[s] = documentAlerts.ICONS[s];
        iconTitles[s] = { i18n: 'alert_severity_' + s };
    }

    const col = {
        name: COLUMN,
        data: COLUMN,
        caption: '',
        type: 'STRING',
        inputType: 'textbox',
        width: 26,
        source: 'field',
        editable: false,
        readOnly: true,
        // Сортировать по ней нельзя: поля с таким именем в таблице нет, значения
        // появляются после выборки страницы. Отбраковку `ORDER BY` по
        // несуществующему полю делает сервер — на добросовестность клиента в
        // имени столбца полагаться всё равно нельзя.
        sortable: false,
        synthetic: true,
        iconOnly: true,
        valueIcons,
        iconTitles,
        // Подсказка — САМИ ТЕКСТЫ оповещений этой строки, а не название уровня:
        // «Предупреждение» человек и так видит по цвету, а знать ему надо, что
        // именно не в порядке. Поле строки, потому что текст у каждой свой.
        iconTitleField: TITLE_FIELD
    };
    return [col].concat(fields);
}

/**
 * Разложить значения по строкам страницы — ОДНИМ запросом.
 *
 * Мутирует строки на месте: строка — единственный источник правды для
 * отрисовки, и значение, лежащее рядом с ней, до клиента не доедет.
 */
async function decorateRows(tableName, rows, sessionID) {
    if (!Array.isArray(rows) || !rows.length || !hasRules(tableName)) return;
    const uids = rows.map(r => r && r.UID).filter(Boolean);
    if (!uids.length) return;

    const byDoc = await documentAlerts.forDocuments({ table: tableName, uids, sessionID });
    for (const row of rows) {
        const info = row && row.UID ? byDoc[row.UID] : null;
        // Пустая строка, а не null: «нечего смотреть» — это пустая ячейка, и
        // значок по пустому значению не ищется.
        row[COLUMN] = (info && info.severity) || '';
        row[TITLE_FIELD] = (info && info.texts && info.texts.length) ? info.texts.join('\n') : '';
    }
}

module.exports = { COLUMN, TITLE_FIELD, prepend, decorateRows };
