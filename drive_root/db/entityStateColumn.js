'use strict';

/**
 * entityStateColumn — ПЕРВАЯ КОЛОНКА ЖУРНАЛА: состояние объекта одним значком.
 *
 * Как в классических учётных системах: слева от всего стоит узкая колонка без заголовка и без текста, и в
 * ней один значок, отвечающий на вопрос «что с этой строкой». Смысл именно в
 * том, что она ПЕРВАЯ и МОЛЧАЛИВАЯ: глаз пробегает по ней сверху вниз, не читая,
 * и видит неладное. Колонка с подписью «Verbuchung» и словами в ячейках этого не
 * даёт — слова надо читать, а читают их только когда уже что-то заподозрили.
 *
 * ОДНА КОЛОНКА НА ДВА СОСТОЯНИЯ (решение владельца 22.09.2026). Пометка на
 * удаление ПЕРЕБИВАЕТ состояние проведения: помеченный объект приговорён, и
 * знать, был ли он проведён, в списке уже незачем — а два значка в одной строке
 * заставляли бы решать, какой из них главный.
 *
 * Значки объявлены здесь, а не в лейауте приложения: состояние объекта — понятие
 * ядра, и выглядеть оно обязано одинаково в любом журнале любой программы.
 * Приложение, перечисляющее `postingState` в `properties.fields`, получало бы
 * вторую такую же колонку — поэтому дубль отсеивается.
 */

const deletionMark = require('./deletionMark');

/** Имя синтетической колонки. Начинается с двух подчёркиваний — она не поле модели. */
const COLUMN = '__entityState';

const ICONS = {
    marked: '/apps/general_icons/resources/public/16x16/deletion_mark.png',
    posted: '/apps/general_icons/resources/public/16x16/posted.png',
    queued: '/apps/general_icons/resources/public/16x16/queued.png',
    error: '/apps/general_icons/resources/public/16x16/post_error.png',
    notPosted: '/apps/general_icons/resources/public/16x16/not_posted.png'
};

/**
 * Дописать колонку состояния в начало набора колонок списка.
 *
 * @param {string} tableName
 * @param {Array} fields — набор колонок (мутируется не он, а копия)
 * @returns {Array} новый набор
 */
function prepend(tableName, fields) {
    if (!Array.isArray(fields)) return fields;

    const globalCtx = require('../globalServerContext');
    const modelName = globalCtx.getModelNameForTable(tableName) || tableName;
    const Model = modelName ? (globalCtx.modelsDB || {})[modelName] : null;
    if (!Model || !deletionMark.isEntityDef(Model)) return fields;

    // Уже стоит (повторный вызов) — ничего не делаем.
    if (fields.some(f => f && f.name === COLUMN)) return fields;

    const posting = require('./posting');
    const postable = !!posting.readConfig(Model);

    // У справочника состояния проведения нет — значок будет только у помеченных.
    const valueIcons = { '__marked': ICONS.marked };
    if (postable) {
        valueIcons[posting.STATE.POSTED] = ICONS.posted;
        valueIcons[posting.STATE.QUEUED] = ICONS.queued;
        valueIcons[posting.STATE.ERROR] = ICONS.error;
        valueIcons[posting.STATE.NOT_POSTED] = ICONS.notPosted;
    }

    const col = {
        name: COLUMN,
        // Значок берётся по значению ЭТОГО поля, а перебивается пометкой (ниже).
        data: posting.STATE_FIELD,
        caption: '',
        type: 'STRING',
        inputType: 'textbox',
        width: 26,
        source: 'field',
        editable: false,
        sortable: false,
        // Ни текста в ячейке, ни подписи в шапке — только картинка.
        iconOnly: true,
        valueIcons,
        // Пометка на удаление старше состояния проведения.
        iconOverride: { field: deletionMark.FIELD, value: '__marked' },
        // Подсказка при наведении: значок узнают не с первого дня.
        iconTitles: {
            '__marked': { i18n: 'deletion_mark_field' },
            [posting.STATE.POSTED]: { i18n: 'posting_state_posted' },
            [posting.STATE.QUEUED]: { i18n: 'posting_state_queued' },
            [posting.STATE.ERROR]: { i18n: 'posting_state_error' },
            [posting.STATE.NOT_POSTED]: { i18n: 'posting_state_not_posted' }
        }
    };

    // Колонка состояния проведения, если приложение перечислило её само, теперь
    // лишняя: тот же значок уже стоит первым, и вторая копия только шире журнал.
    const rest = fields.filter(f => !(f && (f.name === posting.STATE_FIELD)));
    return [col].concat(rest);
}

module.exports = { COLUMN, ICONS, prepend };
