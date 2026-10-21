'use strict';

/**
 * listAttributes — ВЫЧИСЛЯЕМЫЕ РЕКВИЗИТЫ ЖУРНАЛА.
 *
 * ── Зачем ────────────────────────────────────────────────────────────────────
 * У формы ЗАПИСИ такой механизм уже есть: реквизит формы объявляется в лейауте,
 * а считает его метод `onLoadAttributes` (раздел 76.5). У журнала его не было, и
 * величину, которой нет в таблице, показать в колонке было нечем. А нужна она
 * ровно там же, где и на форме: предоплата брони — это остаток регистра, а не
 * поле; «выставлено больше, чем заказано» — тоже остаток.
 *
 * Запрос НА СТРОКУ для этого не годится: журнал открывает сотню строк, и сотня
 * запросов — это не «медленно», это другой порядок времени открытия окна.
 * Поэтому метод получает СРАЗУ ВСЕ строки страницы и отвечает одним запросом.
 *
 * ── Объявление ───────────────────────────────────────────────────────────────
 * `entityConfig.listAttributes` — там же, где `rowTones`: это правило
 * ПРЕДСТАВЛЕНИЯ журнала, и оно обязано действовать в любом журнале этой таблицы,
 * а не в одном лейауте. Клиент в объявлении не участвует намеренно: имя
 * серверного метода, присланное клиентом, было бы способом позвать любой метод.
 *
 *     "listAttributes": [
 *         { "name": "prepayment", "caption": { "i18n": "prepayment_field" },
 *           "type": "DECIMAL(12,2)" }
 *     ]
 *
 * Считает их метод `onLoadListAttributes` формы СПИСКА этой таблицы
 * (`list:<таблица>`, владелец — приложение, зарегистрировавшее форму):
 *
 *     async onLoadListAttributes({ tableName, ids, rows }, ctx)
 *         → { "<UID строки>": { "<имя реквизита>": значение } }
 *
 * Метода нет — колонок тоже нет: пустая колонка в журнале хуже отсутствующей.
 *
 * ── Чего эти реквизиты НЕ умеют ──────────────────────────────────────────────
 * Сортировки и отбора по ним нет, и это не недоделка: значения появляются ПОСЛЕ
 * выборки страницы, то есть сортировать ими можно было бы только внутри экрана —
 * а такая сортировка врёт, выглядя настоящей. Нужен отбор по величине — она
 * должна стать движением регистра или полем, а не колонкой-вычислением.
 */

const SYNTHETIC = true;

/** Объявление реквизитов журнала модели (всегда массив). */
function read(ModelOrDef) {
    const ec = ModelOrDef && ModelOrDef.entityConfig;
    const list = ec && ec.listAttributes;
    if (!Array.isArray(list)) return [];
    return list.filter(a => a && a.name);
}

/** Объявление по имени таблицы. */
function forTable(tableName) {
    try {
        const gCtx = require('../globalServerContext');
        const modelName = gCtx.getModelNameForTable(tableName);
        const Model = modelName ? gCtx.modelsDB[modelName] : null;
        return read(Model);
    } catch (e) {
        return [];
    }
}

/**
 * Добавить колонки реквизитов к списку полей.
 *
 * В КОНЕЦ, а не в начало: реквизиты — дополнение к журналу, а не его предмет;
 * первая колонка занята состоянием объекта (`entityStateColumn`).
 *
 * Как и колонка состояния, эти колонки добавляются ПОСЛЕ запроса данных: поля с
 * такими именами в модели нет, и попав в список атрибутов выборки, они уронили
 * бы запрос — журнал открылся бы пустым.
 */
/** Контрол ячейки по типу реквизита — как у автоколонок (uniForm buildTableFieldsFromModel). */
function inputTypeOf(type) {
    const t = String(type || '').toUpperCase();
    if (t === 'INTEGER') return 'integer';
    if (t === 'BOOLEAN') return 'checkbox';
    if (t === 'DATE' || t === 'DATEONLY') return 'date';
    return 'textbox';
}

function append(tableName, fields) {
    const decls = forTable(tableName);
    if (!decls.length || !Array.isArray(fields)) return fields;

    const nameOf = f => (typeof f === 'string') ? f : (f && (f.name || f.field || f.id || f.key));
    const out = fields.slice();
    for (const a of decls) {
        if (out.some(f => nameOf(f) === a.name)) continue;
        out.push(Object.assign({}, a, {
            name: a.name,
            // КОНТРОЛ ЯЧЕЙКИ. Клиент рисует ячейку контролом по `inputType`; у колонки
            // модели его ставит buildTableFieldsFromModel, а объявление реквизита
            // журнала знает только `type` — и ячейка выходила ПУСТОЙ при верном
            // значении в строке (21.10.2026: «Anzahlung» и «Zu viel abgerechnet»
            // в журнале броней не показали ни разу). Те же правила по типу.
            inputType: a.inputType || inputTypeOf(a.type),
            // Колонка только для чтения всегда: писать некуда — поля нет.
            readOnly: true,
            // И сортировать по ней нельзя — поля с таким именем в таблице нет.
            // Флаг объявляем (так же объявлена колонка состояния), но полагаться
            // на него нельзя: отбраковку `ORDER BY` по несуществующему полю
            // делает сервер (`getDynamicTableData`).
            sortable: false,
            synthetic: SYNTHETIC
        }));
    }
    return out;
}

/**
 * Посчитать и разложить значения по строкам.
 *
 * Мутирует строки на месте: строка — единственный источник правды для
 * отрисовки, и значение, лежащее рядом с ней, до клиента не доедет.
 */
async function compute(tableName, rows, sessionID) {
    const decls = forTable(tableName);
    if (!decls.length || !Array.isArray(rows) || !rows.length) return;

    const formAddress = require('../formAddress');
    const layoutMemory = require('../layoutMemory');
    const formMethods = require('../formMethods');

    const formName = formAddress.forSubject(formAddress.KIND_LIST, tableName);
    const app = layoutMemory.ownerOfSubjectForm(formName);
    if (!app) return;

    let role = null;
    try { role = await layoutMemory.getUserRoleBySession(sessionID); } catch (e) { /* скажем ниже */ }
    if (!role) {
        // Подставлять здесь `'*'` НЕЛЬЗЯ: в доступе к методам звёздочка не значит
        // «любая роль» (`methodStore.hasRoleAccess`), и подстановка дала бы
        // молчаливый отказ — колонки просто не появились бы, без единого слова.
        console.warn(`[listAttributes] ${tableName}: роль сессии не определена — реквизиты журнала не посчитаны`);
        return;
    }
    const fn = formMethods.resolve({ app, form: formName, method: 'onLoadListAttributes', userRole: role });
    if (typeof fn !== 'function') return;

    const ids = rows.map(r => r && r.UID).filter(Boolean);
    if (!ids.length) return;

    let user = null;
    try {
        const gCtx = require('../globalServerContext');
        user = sessionID ? await gCtx.getUserBySessionID(sessionID) : null;
    } catch (e) { /* реквизиты посчитаются или нет — журнал всё равно откроется */ }

    const result = await fn({ tableName, ids, rows }, { sessionID, user, role });
    if (!result || typeof result !== 'object') return;

    const known = new Set(decls.map(a => a.name));
    for (const row of rows) {
        const vals = row && row.UID ? result[row.UID] : null;
        if (!vals) continue;
        for (const [name, value] of Object.entries(vals)) {
            // Значение полю ЗАПИСИ этот метод отдать не может: он про реквизиты
            // журнала, и подмена поля записи по дороге к экрану была бы правкой
            // данных мимо сохранения — совсем другим механизмом.
            if (!known.has(name)) {
                console.warn(`[listAttributes] ${tableName}: «${name}» не объявлен в listAttributes — значение отброшено`);
                continue;
            }
            row[name] = value;
        }
    }
}

module.exports = { read, forTable, append, compute };
