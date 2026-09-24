'use strict';

/**
 * movementsForm — ЭКРАН «ДВИЖЕНИЯ ДОКУМЕНТА».
 *
 * Отвечает на один вопрос: что этот документ сделал с учётом. До него ответить
 * на него было нечем — движения лежали в регистре, куда пользователь не ходит, а
 * проведённый документ на форме отличался от непроведённого только словом.
 *
 * СВОЕЙ ТАБЛИЦЫ У ЭКРАНА НЕТ. Каждая вкладка — обыкновенный ЖУРНАЛ РЕГИСТРА,
 * тот же самый, что открывается из меню, с отбором по регистратору. Отсюда всё
 * даром и без единой строки на вкладку: колонки из модели, канонический порядок,
 * представление регистратора, знак у ресурса, переводы, RLS. Написать здесь свои
 * таблицы значило бы завести второй набор колонок, который разойдётся с первым в
 * тот день, когда в регистр добавят измерение.
 *
 * ВКЛАДКА НА РЕГИСТР, а не одна таблица с колонкой «регистр» (решение владельца
 * 22.09.2026): у каждого регистра свои измерения и ресурсы, и общей сеткой их
 * честно не показать — пришлось бы либо свалить все колонки в одну широкую с
 * пустотами, либо показывать только то, что есть у всех.
 *
 * ПУСТАЯ ВКЛАДКА — ЗАКОННОЕ ЗРЕЛИЩЕ и ради него всё и затевалось: «документ
 * проведён, а движений нет» — это то, что человек обязан увидеть, а не то, от
 * чего его надо уберечь. Поэтому кнопка не гаснет у непроведённого документа и
 * вкладка не прячется, когда строк нет.
 */

const registers = require('./registers');
const posting = require('./posting');

/** Имя виртуальной таблицы экрана. Записи с таким именем нет. */
const TABLE = 'document_movements';

/**
 * Построить спецификацию формы движений.
 *
 * @param {object} p — `{ table, uid, sessionID }`
 * @returns {Promise<object|null>} `{ layout, data, caption }` либо null
 */
async function buildSpec(p) {
    const globalCtx = require('../globalServerContext');
    const dbGateway = require('../dbGateway');
    const forms = require('../../drive_forms/globalServerContext');

    const table = p && p.table;
    const uid = p && p.uid;
    const sessionID = p && p.sessionID;
    if (!table || !uid) return null;

    const modelName = globalCtx.getModelNameForTable(table);
    const Model = modelName ? (globalCtx.modelsDB || {})[modelName] : null;
    if (!Model) return null;
    const cfg = posting.readConfig(Model);
    if (!cfg) return null;

    // Шапка: чем документ представляется и в какой он точке времени. Момент
    // показывается потому, что именно он, а не дата создания, определяет место
    // движений в остатке — а увидеть его больше негде.
    let doc = null;
    try {
        const rows = await dbGateway.execute({
            operation: 'read', table, where: { UID: uid },
            options: { raw: true, limit: 1 }, context: { sessionID }
        });
        doc = rows && rows[0];
    } catch (e) { /* документа не видно — покажем пустой экран, а не ошибку */ }

    const presentation = doc
        ? globalCtx.pickDisplayValue(doc, globalCtx.presentationFieldOf(Model), 'UID')
        : uid;

    const t = async (key, vars) => {
        try { return await forms.tfForSession(key, sessionID, vars || {}); }
        catch (e) { return key; }
    };

    const layout = [];

    // Строка-шапка: представление, момент, состояние проведения — одной строкой,
    // потому что это три ответа на один вопрос «о каком документе речь».
    const stateKey = 'posting_state_' + ({
        posted: 'posted', queued: 'queued', error: 'error', notPosted: 'not_posted'
    }[(doc && doc[posting.STATE_FIELD]) || 'notPosted'] || 'not_posted');
    const momentDate = doc && doc.date ? new Date(doc.date) : null;
    const head = presentation
        + (momentDate ? '   ' + await t('reg_moment_label') + ': '
            + momentDate.toLocaleDateString() + ' (' + (doc.seq || 0) + ')' : '')
        + '   ' + await t(stateKey);

    layout.push({
        type: 'infoLine',
        name: 'movementsHead',
        caption: head,
        properties: { tone: (doc && doc[posting.STATE_FIELD]) === 'posted' ? 'green' : 'yellow' }
    });

    // Вкладка на регистр. Один регистр — вкладки не заводим: рамка с одним
    // ярлычком ничего не сообщает, а место занимает.
    const regs = (cfg.writes || []).filter(r => registers.isRegisterTable(r));
    const tabFor = (regTable) => ({
        type: 'table',
        name: 'mv_' + regTable,
        properties: {
            dynamicTable: true,
            appName: 'uniForm',
            tableName: regTable,
            readOnly: true,
            visibleRows: 15,
            showToolbar: true,
            hiddenButtons: ['recordAdd', 'recordDelete'],
            // Отбор по регистратору объявлен ЛЕЙАУТОМ (`initialFilter`, парное к
            // `initialSort`): список сразу читает срез,
            // а не всю таблицу с последующим уточнением. Скрытый — это не выбор
            // пользователя, а смысл окна.
            initialFilter: [
                { field: 'recorderTable', value: table, visibility: 'hidden' },
                { field: 'recorderUID', value: uid, visibility: 'hidden' }
            ],
            initialSort: [{ field: 'lineNo', order: 'asc' }]
        }
    });

    if (regs.length === 1) {
        layout.push(tabFor(regs[0]));
    } else if (regs.length > 1) {
        const tabs = [];
        for (const regTable of regs) {
            const rcfg = registers.get(regTable);
            tabs.push({
                caption: (rcfg && rcfg.caption) || regTable,
                layout: [tabFor(regTable)]
            });
        }
        layout.push({ type: 'tabs', name: 'movementTabs', tabs });
    } else {
        layout.push({
            type: 'infoLine', name: 'noRegisters',
            caption: await t('mv_no_registers'), properties: { tone: 'gray' }
        });
    }

    return {
        layout,
        data: [{ name: 'UID', value: uid }],
        caption: await t('mv_caption')
    };
}

module.exports = { TABLE, buildSpec };
