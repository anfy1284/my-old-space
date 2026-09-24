'use strict';

/**
 * postingCascade — КАСКАД ПЕРЕПРОВЕДЕНИЯ (ТЗ «Проведение документов», §11).
 *
 * Зачем. Документ, который ЧИТАЕТ регистр при проведении (например, считает остаток
 * кассы), зависит от всего, что легло в этот регистр РАНЬШЕ него. Стоит исправить
 * документ задним числом — и все последующие посчитаны по устаревшим данным. Каскад
 * ставит их в очередь заново.
 *
 * ЧТО ДЕЛАЕТ (§11.2):
 *   1. берёт регистры, в которые документ писал или из которых движения сняты, вместе
 *      с ФАКТИЧЕСКИМИ значениями измерений этих движений;
 *   2. находит документы, которые (а) объявили `depends` на этих регистрах,
 *      (б) совпадают по значениям измерений, (в) имеют момент времени СТРОГО БОЛЬШЕ
 *      точки отсчёта, (г) находятся в состоянии `posted`;
 *   3. ставит их в очередь. Рекурсия произойдёт сама: каждый из них при
 *      перепроведении поставит тех, кто позже него.
 *
 * Зависимость объявляется С ИЗМЕРЕНИЯМИ — иначе одна правка задним числом подняла бы
 * всю базу:
 *
 *     "depends": [ { "register": "reg_cash", "dimensions": { "cashboxId": "cashboxId" } } ]
 *
 * Слева — измерение регистра, справа — реквизит документа, откуда берётся значение.
 *
 * ЗАВЕРШАЕМОСТЬ держится на ОДНОМ условии: каскад идёт только ВПЕРЁД по времени.
 * Документ ставит в очередь исключительно тех, кто строго позже него. Отсюда жёсткий
 * запрет, нарушение которого превращает каскад в бесконечный: **перепроведение не
 * имеет права менять `date` и `seq`**. Дату меняет человек, каскад — никогда.
 * На уровне регистров зависимость при этом циклична (расход читает кассу и сам в неё
 * пишет) — это нормально и безопасно: порядок по времени разрывает цикл.
 *
 * ЗАКРЫТЫЙ ПЕРИОД каскад НЕ СМОТРИТ (§11.4). Если замок уже пробит администратором,
 * недоперепроведённый учёт хуже изменённого закрытого периода. Но весь такой каскад
 * пишется в журнал целиком — это ответ проверяющему на вопрос, почему движения
 * прошлого года изменились в мае.
 */

const { Op } = require('sequelize');
const posting = require('./posting');
const entityMoment = require('./entityMoment');

const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';

/**
 * Точка отсчёта — НАИМЕНЬШИЙ затронутый момент времени.
 *
 * Снятые движения несут СТАРЫЙ момент документа, записанные — новый. Поэтому минимум
 * по объединению автоматически покрывает случай «дата документа изменилась», где идти
 * нужно от двух точек (§11.1): от более ранней из них видно обе.
 *
 * @param {Array<object>} movements — движения со своими `period`/`seq`
 * @param {object} own — момент самого документа
 * @returns {{date: Date, seq: string}|null}
 */
function earliestMoment(movements, own) {
    const points = [];
    for (const m of movements || []) {
        if (!m) continue;
        points.push({ date: m.period, seq: String(m.seq || 0) });
    }
    if (own && own.date) points.push({ date: own.date, seq: String(own.seq || 0) });
    if (!points.length) return null;

    let best = null;
    for (const p of points) {
        if (!p.date) continue;
        if (!best) { best = p; continue; }
        const t = new Date(p.date).getTime();
        const bt = new Date(best.date).getTime();
        if (t < bt || (t === bt && BigInt(p.seq) < BigInt(best.seq))) best = p;
    }
    return best;
}

/**
 * Условие «момент СТРОГО ПОЗЖЕ точки отсчёта», выраженное средствами Sequelize.
 * Литералом писать нельзя: это `where` ещё будет склеиваться с фильтрами RLS.
 */
function laterThan(moment) {
    const seq = String(moment.seq || 0);
    return {
        [Op.or]: [
            { [entityMoment.DATE_FIELD]: { [Op.gt]: moment.date } },
            {
                [Op.and]: [
                    { [entityMoment.DATE_FIELD]: moment.date },
                    { [entityMoment.FIELD]: { [Op.gt]: seq } }
                ]
            }
        ]
    };
}

/**
 * Разрезы, которых коснулись движения: `register → [ {измерение: значение}, ... ]`.
 * Берутся ФАКТИЧЕСКИЕ значения из строк регистра, а не намерение обработчика:
 * второй источник правды о движениях завёл бы расхождение ровно там, где его
 * невозможно заметить.
 */
function touchedSlices(movements) {
    const registersModule = require('./registers');
    const byRegister = new Map();
    for (const m of movements || []) {
        const regName = m && m.__register;
        if (!regName) continue;
        const cfg = registersModule.get(regName);
        if (!cfg) continue;
        const slice = {};
        for (const d of cfg.dimensions) slice[d] = m[d] === undefined ? null : m[d];
        const key = regName + '|' + JSON.stringify(slice);
        if (!byRegister.has(regName)) byRegister.set(regName, new Map());
        byRegister.get(regName).set(key, slice);
    }
    const out = new Map();
    for (const [reg, map] of byRegister) out.set(reg, Array.from(map.values()));
    return out;
}

/**
 * Найти и поставить в очередь документы, которые надо перепровести.
 *
 * @param {object} p — `{ result, requestedBy, sessionID }`, где `result` — то, что
 *   вернул `posting.runOne` (движения записанные и снятые, момент документа)
 * @returns {Promise<{queued: Array<{table,uid}>, from: object|null}>}
 */
async function run(p) {
    const dbGateway = require('../dbGateway');
    const postingQueue = require('./postingQueue');
    const result = p && p.result;
    if (!result) return { queued: [], from: null };

    const all = [].concat(result.movements || [], result.removed || []);
    const from = earliestMoment(all, result.moment);
    if (!from) return { queued: [], from: null };

    const slices = touchedSlices(all);
    if (!slices.size) return { queued: [], from };

    const queued = [];
    for (const { table, config } of posting.postableTablesOfProcess()) {
        if (!config.depends.length) continue;          // независимый — никого не ждёт

        for (const dep of config.depends) {
            const regSlices = slices.get(dep.register);
            if (!regSlices || !regSlices.length) continue;

            // Соответствие «измерение регистра → реквизит документа». Пусто —
            // зависимость без разреза: такой документ зависит от ЛЮБОГО движения
            // в регистре. Это законно, но дорого, и объявляется осознанно.
            const map = dep.dimensions || {};
            const orConditions = [];
            for (const slice of regSlices) {
                const cond = {};
                for (const [regDim, docField] of Object.entries(map)) {
                    cond[docField] = slice[regDim];
                }
                if (Object.keys(cond).length) orConditions.push(cond);
            }

            const where = {
                [Op.and]: [
                    { [posting.STATE_FIELD]: posting.STATE.POSTED },
                    laterThan(from)
                ]
            };
            if (orConditions.length) where[Op.and].push({ [Op.or]: orConditions });

            let rows;
            try {
                rows = await dbGateway.execute({
                    operation: 'read', table, where,
                    options: { raw: true, attributes: ['UID'], order: [['date', 'ASC'], ['seq', 'ASC']] },
                    context: { sessionID: SYSTEM_SESSION_ID }
                });
            } catch (e) {
                console.error(`[postingCascade] ${table}: поиск зависимых не выполнен: ${e.message}`);
                continue;
            }

            for (const row of rows || []) {
                if (table === result.table && row.UID === result.uid) continue;   // себя не ставим
                if (queued.some(q => q.table === table && q.uid === row.UID)) continue;
                await postingQueue.enqueue({
                    table, uid: row.UID,
                    action: posting.ACTION.POST,
                    requestedBy: p.requestedBy || null,
                    // Каскад — не действие человека: он не сбрасывает разрежение
                    // повторов и не вызывает уведомлений.
                    byHuman: false
                });
                queued.push({ table, uid: row.UID });
            }
        }
    }

    if (queued.length) {
        // Каскад, задевший закрытый период, логируется ЦЕЛИКОМ — кто инициировал,
        // с какого момента, сколько документов и какие. Разделять «задел» и «не
        // задел» здесь не надо: запись дешёвая, а вопрос проверяющего «почему
        // движения прошлого года изменились» приходит один раз и про всё сразу.
        try {
            await require('./auditLog').append({
                documentTable: result.table,
                documentUID: result.uid,
                organizationId: null,
                operation: 'cascade',
                changedAt: new Date().toISOString(),
                userId: p.requestedBy || null,
                userName: null,
                before: JSON.stringify({ from: { date: from.date, seq: from.seq } }),
                after: JSON.stringify({ count: queued.length, documents: queued.slice(0, 200) })
            });
        } catch (e) {
            console.error('[postingCascade] Запись в журнал не выполнена:', e && e.message || e);
        }
    }

    return { queued, from };
}

module.exports = { run, earliestMoment, laterThan, touchedSlices };
