'use strict';

/**
 * deletionMark — ПОМЕТКА НА УДАЛЕНИЕ (решение владельца 22.09.2026, как в классических учётных системах).
 *
 * ЗАЧЕМ. Раньше «Удалить» в журнале означало немедленный `DELETE` с каскадом по
 * табличным частям. Это плохо по двум причинам, и обе видны только в работе:
 *   1. нажатие необратимо, а стоит оно ровно столько же, сколько любое другое —
 *      одна клавиша, и строки нет;
 *   2. удалить обычно НЕЛЬЗЯ: на запись ссылаются другие (клиент — из броней,
 *      услуга — из счетов), и пользователь получал отказ внешнего ключа вместо
 *      понятного «вот кто мешает».
 * Поэтому удаление разделено на два шага, как в классических учётных системах: человек ПОМЕЧАЕТ объект, а
 * удаляет отдельная обработка, которая перед этим проверяет ссылки.
 *
 * ЧТО ЭТО ТЕХНИЧЕСКИ. Служебный реквизит `deletionMark` (BOOLEAN) у КАЖДОЙ
 * сущности — и у документов, и у справочников. Именно в справочниках он нужнее
 * всего: документ обычно удаляется без помех, а клиента, на которого ссылаются
 * брони, не удалить никогда — но пометить и разобраться потом можно.
 *
 * ГЛАВНОЕ ПРАВИЛО: **помеченным можно быть только тому, кого можно удалить.**
 * Пометка — не «жалоба», а обещание: обработка придёт и удалит. Обещать удаление
 * проведённого документа или выставленного счёта нельзя, поэтому право на
 * пометку совпадает с правом на удаление и берётся из ОДНОГО объявления —
 * `entityConfig.immutable` (`deletable` / `when`). Второй копии правила нет.
 *
 * ОТСЮДА СЛЕДУЕТ СЦЕНАРИЙ «ПРОВЕДЁННЫЙ ДОКУМЕНТ». Пометить его нельзя, и об
 * этом надо сказать — но простой отказ оставил бы человека делать вручную то,
 * что очевидно из его намерения. Поэтому `intent()` отвечает не «да/нет», а
 * тремя вариантами: пометить сразу, нельзя совсем, либо СНАЧАЛА РАСПРОВЕСТИ —
 * и тогда пометка ставится задачей очереди (`posting_queue.thenMark`), после
 * того как движения сняты. Пометка и снятие движений не расходятся, потому что
 * происходят в одной транзакции проведения.
 *
 * ИНЪЕКЦИЯ — в тех же двух точках, что `number`/`date`/`seq`/`postingState`:
 *   1. Миграция: корневой `events_handler.js` → `onModelsPostCollect`;
 *   2. Рантайм:  `globalServerContext.collectAllModelDefs`.
 * Обе идемпотентны.
 *
 * ОБЪЯВЛЯТЬ `deletionMark` ВРУЧНУЮ В `db.json` ЗАПРЕЩЕНО — как `UID` и `seq`.
 */

const serviceFields = require('./serviceFields');

/** Имя реквизита. */
const FIELD = 'deletionMark';

/** Сущность (документ, справочник, каталог) — у неё есть пометка. */
function isEntityDef(def) {
    const et = def && def.entityConfig && def.entityConfig.entityType;
    if (!et) return false;
    // Табличная часть — не самостоятельный объект: она живёт и умирает вместе с
    // владельцем, и помечать её отдельно нечем и незачем. Объявление лежит на
    // ВЕРХНЕМ уровне определения (`def.tabularSection`), а не в `entityConfig` —
    // проверка не того места молча пропустила бы секции и завела им пометку,
    // которую никто никогда не снимет.
    if (def.tabularSection || (def.entityConfig && def.entityConfig.tabularSection)) return false;
    return true;
}

// ── Инъекция в определения моделей ───────────────────────────────────────────

/**
 * Гарантирует у сущности реквизит `deletionMark`.
 * @param {object} def — определение модели (мутируется in-place)
 * @returns {boolean} true если инъекция применена
 */
function injectDeletionMark(def) {
    if (!isEntityDef(def)) return false;
    if (!def.fields) def.fields = {};

    // Реквизит принадлежит ЯДРУ целиком, поэтому объявление приложения
    // перекрывается, а не уважается (как у `seq`): неверный тип здесь ломает не
    // запись, а право на удаление — молча.
    const existing = def.fields[FIELD];
    if (existing && String(existing.type || '').toUpperCase() !== 'BOOLEAN') {
        console.warn(`[deletionMark] Таблица "${def.tableName || def.name}" объявляет реквизит`
            + ` "${FIELD}" типа ${existing.type} — это запрещено, объявление перекрыто BOOLEAN.`);
    }
    def.fields[FIELD] = {
        type: 'BOOLEAN',
        allowNull: false,
        // Пустое значение типа, а не NULL — как у всех прочих (emptyValues.js).
        defaultValue: false,
        service: true,
        caption: { i18n: 'deletion_mark_field' }
    };
    serviceFields.markService(def.fields[FIELD]);

    // Индекс: обработка «Удаление помеченных объектов» спрашивает у КАЖДОЙ
    // таблицы «покажи помеченных», и без индекса это скан всей базы.
    def.options = def.options || {};
    const indexes = Array.isArray(def.options.indexes) ? def.options.indexes : [];
    const already = indexes.some(i => Array.isArray(i.fields) && i.fields.length === 1
        && (typeof i.fields[0] === 'string' ? i.fields[0] : i.fields[0] && i.fields[0].name) === FIELD);
    def.options.indexes = indexes;
    if (!already) def.options.indexes.push({ fields: [FIELD] });
    return true;
}

/** Применить ко всему массиву определений. @returns {number} */
function injectDeletionMarks(defs) {
    if (!Array.isArray(defs)) return 0;
    let n = 0;
    for (const def of defs) if (injectDeletionMark(def)) n++;
    return n;
}

// ── Политика удаления: два способа и когда какой доступен ───────────────────

/**
 * Способов удалить объект ДВА, и они объявляются раздельно:
 *
 *     "deletion": { "direct": true, "mark": true }
 *
 *   `mark`   — пометить и удалить потом, обработкой, с проверкой ссылок (путь учётных систем);
 *   `direct` — удалить сразу, без второго шага.
 *
 * Оба по умолчанию разрешены. Когда доступны оба, программа СПРАШИВАЕТ, каким
 * именно способом удалять, — потому что это разные по последствиям действия, и
 * выбирать за человека здесь нечем. Кто может делать что — вопрос прав, и когда
 * права будут сделаны всерьёз, обычно останется один способ; механизм рассчитан
 * на это заранее.
 *
 * @returns {{direct: boolean, mark: boolean}}
 */
function readPolicy(ModelOrDef) {
    const ec = (ModelOrDef && ModelOrDef.entityConfig) || {};
    const d = ec.deletion || {};
    return {
        direct: d.direct !== false,
        mark: d.mark !== false
    };
}

/**
 * ПРАВИЛО ССЫЛОК: на объект, на который может ссылаться другая таблица, прямое
 * удаление запрещается — независимо от того, что написано в `db.json`.
 *
 * Решает СТРУКТУРА базы, а не содержимое: проверка идёт один раз при старте, по
 * объявлениям моделей. Спрашивать «а есть ли прямо сейчас ссылающиеся строки»
 * здесь нельзя — ответ меняется каждую секунду, а кнопка на форме обязана
 * означать одно и то же. Наличие строк проверяет обработка, перед самим
 * удалением (drive_root/db/deleteMarked.js).
 *
 * Собственные табличные части объекта ссылками не считаются: они принадлежат ему
 * и уезжают вместе с ним, иначе любой документ со строками объявил бы сам себя
 * неудаляемым.
 *
 * @param {Array} defs — все определения моделей (мутируются in-place)
 * @returns {number} у скольких объектов прямое удаление отключено
 */
function applyReferenceRule(defs) {
    if (!Array.isArray(defs)) return 0;

    // Кто на кого ссылается: таблица → есть ли ВНЕШНИЕ ссылки.
    const referenced = new Set();
    for (const def of defs) {
        const fields = def.fields || {};
        for (const [name, f] of Object.entries(fields)) {
            const ref = f && f.references;
            const refTable = ref && (ref.model || ref.table);
            if (!refTable) continue;
            const isOwnSection = !!(def.tabularSection
                && def.tabularSection.parentTable === refTable
                && def.tabularSection.parentField === name);
            if (!isOwnSection) referenced.add(refTable);
        }
    }

    let n = 0;
    for (const def of defs) {
        if (!isEntityDef(def)) continue;
        if (!referenced.has(def.tableName)) continue;
        const ec = def.entityConfig;
        ec.deletion = Object.assign({}, ec.deletion || {}, { direct: false });
        n++;
    }
    return n;
}

// ── Право на пометку ─────────────────────────────────────────────────────────

/**
 * Что делать по нажатию «пометить на удаление».
 *
 * Отвечает не «можно/нельзя», а НАМЕРЕНИЕМ — потому что у «нельзя» есть два
 * совершенно разных случая, и валить их в один отказ значит врать в одном из них:
 *
 *   `{ action: 'mark' }`          — пометить прямо сейчас;
 *   `{ action: 'unpostThenMark' }`— документ проведён, распроведение разрешено:
 *                                   снять движения через очередь, потом пометить;
 *   `{ action: 'refuse', reasonKey, reasonVars }` — нельзя совсем (выставленный
 *                                   счёт: он удалению не подлежит вообще).
 *
 * Снятие пометки (`on === false`) не проверяется ничем: вернуть объект в работу
 * можно всегда, и запрещать это не за что.
 *
 * @param {object} Model — модель Sequelize
 * @param {object} row   — прочитанная строка (нужны поле состояния и postingState)
 * @param {boolean} on   — ставим (true) или снимаем (false)
 */
function intent(Model, row, on) {
    if (!on) return { action: 'mark' };
    // Пометка может быть выключена объявлением: у объекта, который удаляют
    // только сразу, второй шаг был бы обещанием, которое никто не выполнит.
    if (!readPolicy(Model).mark) {
        return { action: 'refuse', reasonKey: 'deletion_refuse_mark_off', reasonVars: {} };
    }

    const ec = (Model && Model.entityConfig) || {};
    const imm = ec.immutable;
    const posting = require('./posting');
    const pcfg = posting.readConfig(Model);

    // Право на пометку = право на удаление. Одно объявление, одно правило.
    if (imm && imm.field) {
        const state = row ? row[imm.field] : undefined;
        const closed = Array.isArray(imm.when) && imm.when.indexOf(state) !== -1;
        const deletable = Array.isArray(imm.deletable)
            ? imm.deletable.indexOf(state) !== -1
            : !closed;

        if (!deletable) {
            // Мешает ПРОВЕДЕНИЕ, и его разрешено отменить? Тогда это не отказ, а
            // работа в два шага — человек хотел именно этого, просто не знал,
            // что сначала нужно снять движения.
            const blockedByPosting = pcfg && pcfg.statusIsPostingState
                ? state === posting.STATE.POSTED
                : (row && row[posting.STATE_FIELD]) === posting.STATE.POSTED;
            if (blockedByPosting && pcfg && canUnpostFrom(pcfg, row)) {
                return { action: 'unpostThenMark' };
            }
            return {
                action: 'refuse',
                reasonKey: 'deletion_refuse_state',
                reasonVars: { state: String(state === undefined ? '' : state) }
            };
        }
    }

    // Замка неизменности нет, но документ проведён — движения обязаны быть сняты
    // раньше пометки: помеченный объект не должен ничего значить для учёта.
    if (pcfg && row && row[posting.STATE_FIELD] === posting.STATE.POSTED) {
        if (canUnpostFrom(pcfg, row)) return { action: 'unpostThenMark' };
        return { action: 'refuse', reasonKey: 'deletion_refuse_posted', reasonVars: {} };
    }

    return { action: 'mark' };
}

/**
 * Распроведение разрешено из текущего делового состояния?
 * Та же проверка, что в `posting.runOne`: сравнивать `unpost` можно только с
 * ДЕЛОВЫМ состоянием, а у документа, у которого его нет (денежный), ограничивать
 * нечем — там распроведение разрешено.
 */
function canUnpostFrom(pcfg, row) {
    if (!pcfg || !pcfg.unpost || !pcfg.unpost.length) return false;
    if (pcfg.statusIsPostingState) return true;
    if (!row || !Object.prototype.hasOwnProperty.call(row, pcfg.statusField)) return true;
    return pcfg.unpost.indexOf(row[pcfg.statusField]) !== -1;
}

module.exports = {
    FIELD,
    isEntityDef,
    readPolicy,
    applyReferenceRule,
    injectDeletionMark,
    injectDeletionMarks,
    intent,
    canUnpostFrom
};
