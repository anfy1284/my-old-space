'use strict';

/**
 * registerForms — ФОРМЫ РЕГИСТРА, построенные из объявления.
 *
 * У регистра всё нужное для интерфейса уже объявлено в `db.json`: заголовок, вид
 * (`kind`), измерения, ресурсы, реквизиты. Значит, ни журнал, ни форму строки
 * приложению писать не надо — их строит ядро, одинаково для любого регистра
 * любой программы. Приложение объявляет регистр, интерфейс появляется сам.
 *
 * ТРИ ЭКРАНА, И У КАЖДОГО СВОЙ ВОПРОС:
 *   журнал регистра   — «что вообще лежит в регистре» (список с отбором);
 *   форма записи      — «что в этой одной строке» (все поля, ТОЛЬКО ЧТЕНИЕ);
 *   движения документа— «что сделал ЭТОТ документ» (см. documentCommands.movements).
 *
 * ПОЧЕМУ ТОЛЬКО ЧТЕНИЕ, И ПОЧЕМУ ЭТО НЕ ФЛАЖОК. Строки регистра не редактируются
 * никем: прямая запись отбивается middleware `registerWriteGuard`, писать вправе
 * только проведение. Редактируемая форма обещала бы то, в чём сервер откажет,
 * поэтому замок ставится ПО ПРИЗНАКУ ТАБЛИЦЫ, а не по настройке, которую можно
 * забыть выставить у следующего регистра.
 *
 * ПОРЯДОК КОЛОНОК КАНОНИЧЕСКИЙ — период, регистратор, измерения, ресурсы,
 * реквизиты. Он не «красивее», он отвечает порядку вопросов: когда → кто сделал →
 * в каком разрезе → сколько → подробности. Поэтому порядок задаёт ядро, а не
 * порядок ключей в `db.json`, который у двух регистров случайно разный.
 */

const registers = require('./registers');

/** Служебные поля строки регистра, которые показываем сами и в своём порядке. */
const HEAD = ['period', 'recorderTable', 'recorderUID', 'lineNo', 'sign'];

/**
 * Канонический ПОРЯДОК полей регистра.
 *
 * Порядок отвечает порядку вопросов: когда → кто сделал → в каком разрезе →
 * сколько → подробности. Задаёт его ядро, а не порядок ключей в `db.json`,
 * который у двух регистров случайно разный.
 *
 * Только имена: описания полей (тип, подпись, ссылка, набор значений) живут в
 * определении модели, и автоформа берёт их оттуда сама. Вторая копия подписей
 * здесь означала бы, что переименование реквизита не доезжает до журнала.
 *
 * @param {object} cfg — `registers.get(table)`
 * @returns {Array<string>} имена полей по порядку
 */
function fieldOrder(cfg) {
    return ['period', 'recorderUID', 'lineNo']
        .concat(cfg.dimensions || [], cfg.resources || [], cfg.attributes || []);
}

/**
 * Переставить поля регистра в канонический порядок. Поля, которых нет в
 * объявлении (появились позже, служебные), уходят в конец, а не пропадают:
 * механизм упорядочивает, а не решает, что показывать.
 *
 * @param {string} tableName
 * @param {Array} fields — набор полей/колонок
 */
function orderFields(tableName, fields) {
    if (!isRegisterTable(tableName) || !Array.isArray(fields)) return fields;
    const cfg = registers.get(tableName);
    if (!cfg) return fields;
    const order = fieldOrder(cfg);
    const nameOf = f => (typeof f === 'string') ? f : (f && (f.name || f.field || f.data));
    const rank = f => {
        const i = order.indexOf(nameOf(f));
        return i === -1 ? order.length : i;
    };
    return fields.slice().sort((a, b) => rank(a) - rank(b));
}

/** Замок «только чтение» для формы строки регистра. */
function readOnlyLock() {
    return {
        field: null,
        state: null,
        // `closed: true` + пустой `editable` = заперты ВСЕ поля
        // (DataForm._isFieldLocked).
        closed: true,
        closedStates: [],
        editable: [],
        states: null,
        manual: null
    };
}

/** Таблица — регистр? Тогда её форма записи только для чтения, всегда. */
function isRegisterTable(tableName) {
    try { return registers.isRegisterTable(tableName); } catch (e) { return false; }
}

/**
 * Подставить в строки регистра ПРЕДСТАВЛЕНИЕ регистратора.
 *
 * Регистратор ссылочный, но ссылка ПОЛИМОРФНАЯ (`recorderTable` + `recorderUID`),
 * внешнего ключа у неё нет и быть не может — а значит, обычный механизм подстановки
 * представлений по внешнему ключу до неё не достаёт. Без этого журнал регистра
 * показывает строку вида `cash_receipts` / `0muc7q…`, то есть не отвечает на вопрос
 * «кто это сделал», а заставляет задавать его заново.
 *
 * Читается ОДНИМ запросом на таблицу-регистратор (их на странице одна-две), через
 * тот же шлюз и ту же сессию — то есть под теми же RLS.
 *
 * @param {string} tableName
 * @param {Array<object>} rows — мутируются: добавляется `__recorder`
 * @param {string} sessionID
 */
async function decorateRows(tableName, rows, sessionID) {
    if (!isRegisterTable(tableName) || !Array.isArray(rows) || !rows.length) return rows;
    const globalCtx = require('../globalServerContext');
    const dbGateway = require('../dbGateway');

    // Группируем по таблице-регистратору: один запрос на вид документа.
    const byTable = new Map();
    for (const r of rows) {
        const t = r && r.recorderTable;
        const uid = r && r.recorderUID;
        if (!t || !uid) continue;
        if (!byTable.has(t)) byTable.set(t, new Set());
        byTable.get(t).add(uid);
    }

    const display = new Map();   // "table|uid" → представление
    for (const [t, uids] of byTable.entries()) {
        try {
            const modelName = globalCtx.getModelNameForTable(t);
            const Model = modelName ? (globalCtx.modelsDB || {})[modelName] : null;
            if (!Model) continue;
            const field = globalCtx.presentationFieldOf(Model);
            const got = await dbGateway.execute({
                operation: 'read', table: t, where: { UID: Array.from(uids) },
                options: { raw: true }, context: { sessionID }
            });
            for (const row of (got || [])) {
                display.set(t + '|' + row.UID, globalCtx.pickDisplayValue(row, field, 'UID'));
            }
        } catch (e) {
            // Не прочиталось — покажем идентификатор: пустая колонка хуже некрасивой.
            console.error(`[registerForms] представление регистратора ${t}:`, e && e.message || e);
        }
    }

    // Ресурс регистра остатков показывается СО ЗНАКОМ. В базе сумма лежит
    // положительной, а направление — в `sign`; на экране это две ячейки, которые
    // читатель обязан сопоставлять. Перенос в 100,00 и приход 98,50 выглядят
    // одинаково «плюсом», хотя это расход и приход. Умножение на знак — не
    // украшение: движение и ЕСТЬ −100,00.
    const cfg = registers.get(tableName);
    const signed = cfg && cfg.kind === 'balances' ? (cfg.resources || []) : [];

    for (const r of rows) {
        if (!r) continue;
        const key = (r.recorderTable || '') + '|' + (r.recorderUID || '');
        r.__recorder = display.get(key) || r.recorderUID || '';
        if (signed.length && Number(r.sign) < 0) {
            for (const res of signed) {
                const v = r[res];
                if (v === null || v === undefined || v === '') continue;
                // Знак приписываем СТРОКОЙ, а не арифметикой: DECIMAL приезжает от
                // драйвера строкой («100.00»), и `Number(v)` превратил бы её в
                // `-100` — то есть потерял бы разряды и разошёлся с тем, как те же
                // деньги показаны везде.
                const str = String(v);
                if (str.charAt(0) === '-') continue;
                if (Number(str) === 0) continue;
                r[res] = '-' + str;
            }
        }
    }
    return rows;
}

/**
 * Колонка регистратора берёт значение из `__recorder` (представление), сохраняя
 * имя `recorderUID` — по нему её находят `fields` и `columnOverrides` лейаута.
 * Правка возможна потому, что явно заданное `data` больше не перебивается именем
 * (drive_forms/dynamicTableRegistry.js#normalizeColumnsFromFields).
 */
function remapRecorderColumn(tableName, fields) {
    if (!isRegisterTable(tableName) || !Array.isArray(fields)) return fields;
    return fields.map(f => {
        const name = f && (f.name || f.field || f.data);
        if (name !== 'recorderUID') return f;
        return Object.assign({}, f, { data: '__recorder' });
    });
}

/**
 * Поля, которые ЖУРНАЛУ не нужны, а форме записи нужны.
 *
 * Журнал отвечает на вопрос «что тут происходило», и в нём эти три колонки
 * дублируют соседние:
 *   `recorderTable` — вид документа уже читается из представления регистратора;
 *   `sign`          — направление уже видно по знаку ресурса (см. decorateRows);
 *   `name`          — у строки движения нет осмысленного представления.
 * Форма записи отвечает на другой вопрос — «что ИМЕННО в этой строке», — и там
 * они на месте: это подлинное содержимое записи, а не украшение.
 */
const JOURNAL_HIDDEN = ['recorderTable', 'sign', 'name'];

/** Убрать из набора колонок то, что дублирует соседей в журнале. */
function hideInJournal(tableName, fields) {
    if (!isRegisterTable(tableName) || !Array.isArray(fields)) return fields;
    const nameOf = f => (typeof f === 'string') ? f : (f && (f.name || f.field || f.data));
    return fields.filter(f => JOURNAL_HIDDEN.indexOf(nameOf(f)) === -1);
}

module.exports = {
    HEAD, JOURNAL_HIDDEN, fieldOrder, orderFields, hideInJournal,
    readOnlyLock, isRegisterTable, decorateRows, remapRecorderColumn
};
