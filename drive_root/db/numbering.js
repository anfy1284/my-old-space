'use strict';

/**
 * numbering — КОГДА ДОКУМЕНТ ПОЛУЧАЕТ НОМЕР.
 *
 * По умолчанию номер выдаётся при СОЗДАНИИ записи (`default.autoNumber`), и это
 * верно для справочника: он существует с момента, как его завели. Для документа
 * это спорно, и вот почему — случай живого клиента (05.11.2026):
 *
 *   сотрудница выписывала счёт сложной брони (гости уезжали частями), пробовала
 *   несколько вариантов и каждую попытку сохраняла. Каждый сохранённый ЧЕРНОВИК
 *   забрал себе номер. В итоге выставлены 1469, 1471, 1473, а 1467, 1468, 1470,
 *   1472 остались черновиками — и человек увидел «нумерация сломалась».
 *
 * Пропуски в нумерации сами по себе законны (§ 14 Abs. 4 Nr. 4 UStG требует
 * ОДНОКРАТНОСТИ номера, а не отсутствия дыр: UStAE 14.5 Abs. 10 — «eine
 * lückenlose Abfolge der ausgestellten Rechnungsnummern ist nicht zwingend»),
 * но объяснить их человеку нечем, а выглядят они как потерянные документы.
 *
 * ЭТО СВОЙСТВО ВИДА ДОКУМЕНТА, А НЕ НАСТРОЙКА ПОЛЬЗОВАТЕЛЯ (решение владельца
 * 05.11.2026). Момент выдачи номера объявляется в `entityConfig` модели — там
 * же, где `uniqueNumber`, `posting` и `immutable`, — и относится к виду
 * документа целиком, а не к вкусу конкретной организации. Счёт получает номер
 * при выставлении потому, что так устроен счёт, а не потому, что кто-то так
 * захотел; разрешить двум организациям в одной базе разный порядок значило бы
 * завести два разных вида документа под одним именем.
 *
 *     "entityConfig": {
 *         "entityType": "document",
 *         "numbering": { "onPost": true, "releaseOnUnpost": true }
 *     }
 *
 *   onPost          — номер присваивается ПРИ ПРОВЕДЕНИИ, а не при создании.
 *                     Черновик живёт без номера и ни одного не занимает.
 *   releaseOnUnpost — при РАСПРОВЕДЕНИИ номер снимается и возвращается в
 *                     оборот. Имеет смысл только вместе с `onPost` (иначе
 *                     снятый номер некому выдать заново) и поэтому им же и
 *                     обусловлен.
 *
 * ОБА ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНЫ: блока `numbering` в модели нет — документ ведёт
 * себя как прежде, номер при создании.
 *
 * ГРАНИЦА, КОТОРУЮ ОБЪЯВЛЕНИЕ НЕ ДВИГАЕТ: номер не снимается с документа, у
 * которого есть АРХИВНАЯ КОПИЯ печатной формы (`document_archive`). Копия
 * снимается в момент выставления и хранит номер, который ушёл клиенту (§ 14b
 * UStG). Освободить его — значит однажды выдать второму документу номер,
 * уже стоящий на бумаге у покупателя, а это как раз нарушение однократности
 * § 14 Abs. 4 Nr. 4 UStG. Поэтому проверка стоит в ядре и объявлением не
 * отключается: документ, который выходил из дома, свой номер оставляет себе.
 *
 * Область ответственности модуля — ТОЛЬКО момент выдачи. Как именно считается
 * следующий номер (область организации, префикс, ширина, занятые номера) знает
 * `default.autoNumber`, и второй копии этого знания здесь нет.
 */

/** Реквизит номера — тот же, что инъектирует `entityNumber`. */
const FIELD = 'number';

/**
 * Объявленный моментом выдачи порядок для этой модели.
 *
 * Читается из модели, без похода в базу: это часть ОПИСАНИЯ документа, оно
 * загружено вместе с ним. Кэш поэтому не нужен — в отличие от настроек
 * организации, за которыми пришлось бы ходить на каждое создание документа.
 *
 * @param {object} Model — Sequelize-модель
 * @returns {{onPost: boolean, releaseOnUnpost: boolean}}
 */
function configOf(Model) {
    const out = { onPost: false, releaseOnUnpost: false };
    const ec = Model && Model.entityConfig;
    const decl = ec && ec.numbering;
    if (!decl || typeof decl !== 'object') return out;
    out.onPost = decl.onPost === true;
    // Освобождение без отложенной выдачи оставило бы документ без номера
    // навсегда: выдать его заново было бы некому. Поэтому зависимое, а не
    // просто рядом стоящее объявление.
    out.releaseOnUnpost = out.onPost && decl.releaseOnUnpost === true;
    return out;
}

/**
 * Документ ли это, которому выдачу номера вообще можно отложить.
 *
 * Отложить можно только тому, у кого есть момент, когда номер выдать: это
 * ПРОВОДИМЫЙ ДОКУМЕНТ. Справочник (клиент, услуга) проведения не знает — ему
 * номер выдаётся при создании всегда. Объявление `numbering` на непроводимой
 * таблице — ошибка описания, и молчать о ней нельзя: снаружи это выглядит как
 * «настройку включили, а она не работает».
 */
function isDeferrable(Model) {
    const ec = Model && Model.entityConfig;
    if (!ec) return false;
    if (String(ec.entityType || '').toLowerCase() !== 'document') return false;
    let postable = false;
    try { postable = require('./posting').isPostable(Model); } catch (e) { postable = false; }
    if (!postable && ec.numbering && ec.numbering.onPost === true) {
        console.warn(`[numbering] "${Model.tableName}": объявлен numbering.onPost, но документ`
            + ' не проводится — момента выдать номер нет, объявление не действует');
    }
    return postable;
}

/**
 * Отложить ли выдачу номера этой записи при СОЗДАНИИ.
 * Зовётся из `default.autoNumber` — единственного места, где номер выдаётся.
 *
 * @param {object} Model — Sequelize-модель таблицы
 * @returns {boolean}
 */
function deferAtCreate(Model) {
    if (!isDeferrable(Model)) return false;
    return configOf(Model).onPost;
}

/**
 * Параметры автонумерации ИМЕННО ЭТОЙ таблицы (префикс, ширина, периодичность).
 * Берутся из объявления модели, а не придумываются здесь: иначе номер, выданный
 * проведением, отличался бы форматом от номера, выданного при создании.
 */
function numberParams(Model) {
    const hooks = (Model && Model.entityConfig && Model.entityConfig.hooks) || {};
    const list = [].concat(hooks.beforeCreate || [], hooks.beforeUpdate || []);
    const h = list.find(x => x && x.handler === 'default.autoNumber'
        && x.params && x.params.field === FIELD);
    return (h && h.params) || { field: FIELD, length: 5 };
}

/** Значение реквизита пусто? */
function isEmpty(v) {
    return v === null || v === undefined || v === '';
}

/** Модель таблицы или null. */
function modelOf(table) {
    const globalCtx = require('../globalServerContext');
    const modelName = globalCtx.getModelNameForTable(table);
    return modelName ? globalCtx.modelsDB[modelName] : null;
}

/**
 * ВЫДАТЬ НОМЕР ПРИ ПРОВЕДЕНИИ. Зовётся из `posting.runOne` ДО обработчика
 * приложения: обработчик счёта снимает архивную копию печатной формы, и номер
 * обязан уже стоять в документе.
 *
 * Ничего не делает, если номер уже есть (повторное проведение, каскад,
 * ручной ввод) или вид документа такого порядка не объявлял.
 *
 * @param {object} p — `{ table, uid, doc, transaction, sessionID }`; `doc`
 *        МУТИРУЕТСЯ: обработчик печатает из этой копии.
 * @returns {Promise<string|null>} выданный номер или null
 */
async function assignOnPost(p) {
    const { table, uid, doc, transaction, sessionID } = p || {};
    if (!doc || !isEmpty(doc[FIELD])) return null;

    const Model = modelOf(table);
    if (!Model || !isDeferrable(Model)) return null;
    if (!configOf(Model).onPost) return null;

    const globalCtx = require('../globalServerContext');
    const params = numberParams(Model);
    const autoNumber = require('../entityHooks/default/autoNumber');
    // Синтетический запрос — тот же вид, что видит хук: по нему считается область
    // нумерации (организация) и занятые номера.
    const probe = {
        operation: 'update',
        table,
        data: Object.assign({}, doc),
        where: { UID: uid },
        context: { sessionID }
    };
    const next = await autoNumber.computeNext(probe, Model, params, {
        modelsDB: globalCtx.modelsDB,
        dbGateway: require('../dbGateway'),
        sessionID
    });
    if (isEmpty(next)) return null;

    await writeNumber({ table, uid, value: next, transaction, sessionID });
    doc[FIELD] = next;
    console.log(`[numbering] ${table}[${uid}] получил номер "${next}" при проведении`);
    return next;
}

/**
 * ОСВОБОДИТЬ НОМЕР ПРИ РАСПРОВЕДЕНИИ. Зовётся из `posting.runOne` ПОСЛЕ возврата
 * документа в исходное состояние (`statusOnUnpost`): к этому моменту замок
 * неизменности уже открыт, и запись идёт по обычным правилам.
 *
 * НЕ снимает номер с документа, у которого есть архивная копия печатной формы:
 * этот номер уже у клиента на бумаге (см. шапку модуля).
 *
 * @param {object} p — `{ table, uid, doc, transaction, sessionID }`; `doc` мутируется
 * @returns {Promise<string|null>} освобождённый номер или null
 */
async function releaseOnUnpost(p) {
    const { table, uid, doc, transaction, sessionID } = p || {};
    if (!doc || isEmpty(doc[FIELD])) return null;

    const Model = modelOf(table);
    if (!Model || !isDeferrable(Model)) return null;
    if (!configOf(Model).releaseOnUnpost) return null;

    let archived = false;
    try {
        archived = await require('./documentArchive').exists(table, uid);
    } catch (e) {
        // Не смогли спросить архив — считаем, что копия есть. Ошибиться в эту
        // сторону значит оставить лишний номер; ошибиться в другую — выдать
        // второму документу номер, который уже напечатан.
        console.error(`[numbering] Архив ${table}[${uid}] не опрошен, номер оставлен: ${e.message}`);
        archived = true;
    }
    if (archived) {
        console.log(`[numbering] ${table}[${uid}]: номер "${doc[FIELD]}" не освобождён —`
            + ' документ выходил из дома (есть архивная копия печатной формы)');
        return null;
    }

    const released = doc[FIELD];
    await writeNumber({ table, uid, value: null, transaction, sessionID });
    doc[FIELD] = null;
    console.log(`[numbering] ${table}[${uid}]: номер "${released}" освобождён при распроведении`);
    return released;
}

/**
 * Запись номера ядром.
 *
 * Идёт через `dbGateway`, а не мимо него: по дороге стоит пересчёт представления
 * (`applyPresentation`) — в представлении документа номер первым словом, и мимо
 * шлюза оно осталось бы старым. Право — токен ядра (`coreWrite`) на два поля:
 * момент выдачи номера механизму принадлежит, а человеку в закрытом документе
 * нет. Токен же служит меткой «пишет механизм», без которой документ вернулся бы
 * в очередь и проводился бы бесконечно.
 */
async function writeNumber(p) {
    const { table, uid, value, transaction, sessionID } = p;
    const coreWrite = require('./coreWrite');
    await require('../dbGateway').execute({
        operation: 'update',
        table,
        where: { UID: uid },
        data: { [FIELD]: value },
        options: { transaction },
        context: {
            sessionID,
            transaction,
            coreWrite: coreWrite.grant([FIELD, 'name'])
        }
    });
}

module.exports = {
    FIELD,
    configOf,
    isDeferrable,
    deferAtCreate,
    assignOnPost,
    releaseOnUnpost
};
