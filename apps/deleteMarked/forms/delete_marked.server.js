'use strict';

/**
 * Обработка «Удаление помеченных объектов» — серверные функции.
 *
 * Таблица лейаута `delete_marked` ВИРТУАЛЬНАЯ: записи с таким именем нет, форма
 * собирает список из всех сущностей сразу. Поэтому данные отдаёт `onLoadData`, а
 * не чтение одной таблицы.
 *
 * ДВА НАБОРА, а не один: `marked` — что помечено, `refs` — кто на это ссылается.
 * Второй набор содержит ссылки на ВСЕ помеченные объекты сразу и делится полем
 * `ownerKey`; какие строки показать, решает на клиенте штатная связь
 * «главная таблица → подчинённая» (`masterFor`). Класть в форму только ссылки на
 * текущий объект и дочитывать их при каждом перемещении курсора было бы вторым
 * механизмом рядом с уже существующим.
 *
 * Права нигде не проверяются отдельно и не должны: и список, и удаление идут
 * через `dbGateway` с сессией пользователя, то есть под теми же RLS, что и любая
 * другая работа. Сотрудник увидит помеченных только в своей организации — это не
 * особая настройка обработки, а общее правило системы.
 */

const deleteMarked = require('../../../drive_root/db/deleteMarked');
const { tForSession, tfForSession } = require('../../../drive_forms/globalServerContext');

/**
 * Сколько ссылающихся объектов класть в форму на один помеченный объект.
 *
 * Это ПОКАЗ, а не проверка: удалять или нет, решает счётчик в колонке «на него
 * ссылаются», он считает всё. Список нужен, чтобы дойти до мешающего документа и
 * открыть его, и для этого тысяча строк не полезнее сотни — она только заставляет
 * ждать при открытии формы.
 */
const REFS_PER_OBJECT = 100;

module.exports = function (modelsDB, Utilities) {

    /**
     * Подпись вида объекта — та же, что в заголовке журнала («Бронирования»).
     * Берётся из реестра лейаутов (`appCaption`), потому что там она уже есть и
     * уже переведена; имя таблицы показывается только когда журнала нет вовсе.
     */
    async function kindCaptionOf(table, sessionID) {
        // ТАБЛИЧНАЯ ЧАСТЬ — не самостоятельный объект, и называть её своим именем
        // значит показывать человеку внутренность («invoice_lines: 19»). Мешает
        // ему не строка, а ДОКУМЕНТ, которому она принадлежит, — его и называем.
        try {
            const globalCtx = require('../../../drive_root/globalServerContext');
            const defs = (globalCtx.collectAllModelDefs().models) || [];
            const def = defs.find(d => d.tableName === table);
            if (def && def.tabularSection && def.tabularSection.parentTable) {
                return await kindCaptionOf(def.tabularSection.parentTable, sessionID);
            }
        } catch (e) { /* определений нет — пойдём обычным путём */ }
        // РЕГИСТР своего лейаута не имеет (формы строит автогенератор), подпись —
        // в его объявлении.
        try {
            const registers = require('../../../drive_root/db/registers');
            const rcfg = registers.get(table);
            if (rcfg && rcfg.caption) {
                return rcfg.caption.i18n
                    ? await tForSession(rcfg.caption.i18n, sessionID)
                    : String(rcfg.caption);
            }
        } catch (e) { /* не регистр */ }
        try {
            const layoutMemory = require('../../../drive_root/layoutMemory');
            const cap = layoutMemory.getTableCaption(table);
            if (cap && typeof cap === 'object' && cap.i18n) {
                return await tForSession(cap.i18n, sessionID);
            }
            if (cap) return String(cap);
        } catch (e) { /* реестр может не знать таблицу — ищем дальше */ }
        // У справочника с АВТОМАТИЧЕСКИМ списком зарегистрированного лейаута нет,
        // и заголовка в реестре тоже. Но перевод обычно есть — по ключу, равному
        // имени таблицы («clients» → «Kunden»). Иначе в обработке стояло бы
        // «clients» рядом с «Rechnungen», и выглядело бы это как недоделка.
        try {
            const t = await tForSession(table, sessionID);
            if (t && t !== table) return t;
        } catch (e) { /* перевода нет — покажем имя таблицы */ }
        return table;
    }

    /** «Брони: 12, Счета: 3» — кто мешает удалить. */
    async function blockersTextOf(blockers, sessionID) {
        if (!Array.isArray(blockers) || !blockers.length) return '';
        // Две табличные части одного документа дают ОДНО название — складываем,
        // иначе в строке стоит «Счета: 19, Счета: 3» и читатель решает ребус.
        const byCaption = new Map();
        for (const b of blockers) {
            const cap = await kindCaptionOf(b.table, sessionID);
            const prev = byCaption.get(cap);
            if (b.count === null || prev === null) byCaption.set(cap, null);
            else byCaption.set(cap, (prev || 0) + b.count);
        }
        return Array.from(byCaption.entries())
            .map(([cap, n]) => cap + ': ' + (n === null ? '?' : n))
            .join(', ');
    }

    /**
     * КОНТРОЛЬ — оба набора строк формы.
     *
     * Контроль и показ — одно и то же действие: проверить ссылки и есть
     * единственная работа этой формы до удаления. Отдельной «проверки», которая
     * ничего не показывает, не существует.
     *
     * @returns {Promise<{marked: Array, refs: Array}>}
     */
    async function buildData(sessionID) {
        const items = await deleteMarked.list({ sessionID, withRefs: true });
        const marked = [];
        const refs = [];

        for (const it of items) {
            const key = it.table + '|' + it.uid;
            marked.push({
                key,
                table: it.table,
                uid: it.uid,
                kindCaption: await kindCaptionOf(it.table, sessionID),
                name: it.name,
                blockersText: await blockersTextOf(it.blockers, sessionID),
                blocked: Array.isArray(it.blockers) && it.blockers.length > 0
            });

            // Ссылки читаем только у того, на кого вообще ссылаются: у остальных
            // запрос вернул бы пустоту, а объектов в списке бывает много.
            if (!Array.isArray(it.blockers) || !it.blockers.length) continue;
            const referrers = await deleteMarked.referrersOf(it.table, it.uid, sessionID, REFS_PER_OBJECT);
            for (const r of referrers) {
                refs.push({
                    ownerKey: key,
                    // `__table` — строка называет свою таблицу сама: список
                    // разнородный, и ядро открывает по нему запись двойным
                    // щелчком и кнопкой «Открыть».
                    __table: r.table,
                    UID: r.uid,
                    kindCaption: await kindCaptionOf(r.table, sessionID),
                    name: r.name
                });
            }
        }
        return { marked, refs };
    }

    return {
        /**
         * Данные формы.
         *
         * Обёртка `{ data: … }` обязательна: ядро ждёт именно её, а не сам набор
         * значений. Без неё форма открывается с пустой таблицей — молча, потому
         * что «нет данных» и «данные не там» выглядят на экране одинаково.
         */
        async onLoadData(params, ctx) {
            const sessionID = ctx && ctx.sessionID;
            return { data: await buildData(sessionID) };
        },

        /** Контроль: перечитать помеченные и их ссылки. */
        async control(params, ctx) {
            const sessionID = ctx && ctx.sessionID;
            const data = await buildData(sessionID);
            return { ok: true, marked: data.marked, refs: data.refs };
        },

        /**
         * КОНТРОЛЬ И УДАЛЕНИЕ.
         *
         * Проверка ссылок идёт ПЕРЕД каждым удалением, а не только при показе:
         * между открытием формы и нажатием кнопки могла появиться новая ссылка, и
         * список на экране про неё не знает.
         *
         * Каждый объект удаляется ОТДЕЛЬНО, и неудача одного не отменяет
         * остальных: список разнородный, и «или всё, или ничего» здесь означало
         * бы, что один занятый клиент не даёт вычистить сорок черновиков.
         */
        async removeSelected(params, ctx) {
            const sessionID = ctx && ctx.sessionID;
            const items = (params && params.items) || [];
            const uniForm = require('../../uniForm/server.js');
            let deleted = 0;
            let failed = 0;

            for (const it of items) {
                if (!it || !it.table || !it.uid) continue;
                const blockers = await deleteMarked.blockersOf(it.table, it.uid, sessionID);
                if (blockers.length) { failed++; continue; }
                const res = await uniForm.hardDeleteRecord({
                    tableName: it.table, recordId: it.uid, sessionID
                });
                if (res && res.ok) deleted++;
                else {
                    failed++;
                    console.error(`[deleteMarked] не удалён ${it.table}[${it.uid}]:`, (res && res.error) || '');
                }
            }

            // Итог — одной короткой фразой. Что именно помешало, стоит в таблицах:
            // у оставшихся объектов видно и «на него ссылаются», и сами ссылки.
            const message = failed
                ? await tfForSession('dm_result', sessionID, { deleted, failed })
                : await tfForSession('dm_result_ok', sessionID, { deleted });
            const data = await buildData(sessionID);
            return { ok: true, deleted, failed, message, marked: data.marked, refs: data.refs };
        },

        /** Снять пометку с выбранных — передумал. */
        async unmarkSelected(params, ctx) {
            const sessionID = ctx && ctx.sessionID;
            const items = (params && params.items) || [];
            const dbGateway = require('../../../drive_root/dbGateway');
            const deletionMark = require('../../../drive_root/db/deletionMark');
            let n = 0;
            for (const it of items) {
                if (!it || !it.table || !it.uid) continue;
                try {
                    await dbGateway.execute({
                        operation: 'update', table: it.table, where: { UID: it.uid },
                        data: { [deletionMark.FIELD]: false },
                        context: { sessionID }
                    });
                    n++;
                } catch (e) {
                    console.error(`[deleteMarked] пометка не снята ${it.table}[${it.uid}]:`, e && e.message);
                }
            }
            const message = await tfForSession('dm_unmarked', sessionID, { count: n });
            const data = await buildData(sessionID);
            return { ok: true, unmarked: n, message, marked: data.marked, refs: data.refs };
        }
    };
};
