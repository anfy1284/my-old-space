'use strict';

/**
 * Обработка «Проверка документов» — серверные функции (ТЗ оповещений §13).
 *
 * У формы НЕТ ПРЕДМЕТА: она собирает оповещения по всем видам документов сразу,
 * ничего не сохраняет и ничего не запирает. Поэтому данные отдаёт `onLoadData`,
 * а не чтение одной таблицы, и отборы — это РЕКВИЗИТЫ ФОРМЫ: на форме без
 * предмета всё, что пишет в данные, ими и является (см. `drive_root/formAddress.js`).
 *
 * Права нигде не проверяются отдельно и не должны: и список оповещений, и
 * чтение документов идут через `dbGateway` с сессией пользователя, то есть под
 * теми же RLS, что и любая другая работа. Сотрудник увидит оповещения только по
 * своей организации — это общее правило системы, а не особая настройка обработки.
 *
 * ОТКРЫТИЕ ФИКСИРУЕТСЯ (§14): от этой отметки зависит, уйдёт ли суточная сводка.
 * Пишет её СЕРВЕР, из `onLoadData`, а не клиент: значению, присланному с
 * клиента, здесь верить нельзя.
 */

const documentAlerts = require('../../../drive_root/db/documentAlerts');
const alertRules = require('../../../drive_root/db/alertRules');
const alertsRunner = require('../../../drive_root/db/alertsRunner');
const globalRoot = require('../../../drive_root/globalServerContext');
const dbGateway = require('../../../drive_root/dbGateway');
const { tForSession } = require('../../../drive_forms/globalServerContext');

/** Сколько строк показываем. Больше — не полезнее: разбираются сверху. */
const LIMIT = 500;

module.exports = function (modelsDB, Utilities) {

    /**
     * Подпись вида документа — та же, что в заголовке его журнала.
     *
     * Берётся из реестра лейаутов, потому что там она уже есть и уже переведена;
     * имя таблицы показывается только когда журнала нет вовсе (тогда пробуем
     * перевод по ключу, равному имени таблицы, — иначе в списке стояло бы
     * «bookings» рядом с «Rechnungen», и выглядело бы это как недоделка).
     */
    async function kindCaptionOf(table, sessionID) {
        try {
            const layoutMemory = require('../../../drive_root/layoutMemory');
            const cap = layoutMemory.getTableCaption(table);
            if (cap && typeof cap === 'object' && cap.i18n) return await tForSession(cap.i18n, sessionID);
            if (cap) return String(cap);
        } catch (e) { /* реестр может не знать таблицу */ }
        try {
            const t = await tForSession(table, sessionID);
            if (t && t !== table) return t;
        } catch (e) { /* перевода нет */ }
        return table;
    }

    /** Дата документа — на локали ПОЛЬЗОВАТЕЛЯ: это экран, а не документ. */
    function dateTextOf(value, locale) {
        const emptyValues = require('../../../drive_root/db/emptyValues');
        if (emptyValues.isEmptyDate(value)) return '';
        const d = new Date(value);
        if (isNaN(d.getTime())) return '';
        try {
            return d.toLocaleDateString(locale || 'de-DE',
                { day: '2-digit', month: '2-digit', year: 'numeric' });
        } catch (e) {
            return d.toISOString().slice(0, 10);
        }
    }

    /**
     * Прочитать документы ПАЧКОЙ — по одному запросу на вид документа, а не на
     * строку: оповещений в списке бывает несколько сотен.
     */
    async function readDocuments(byTable, sessionID) {
        const out = {};
        for (const [table, uids] of byTable.entries()) {
            const modelName = globalRoot.getModelNameForTable(table);
            const Model = modelName ? globalRoot.modelsDB[modelName] : null;
            if (!Model) continue;
            const displayField = globalRoot.presentationFieldOf(Model);
            let rows = [];
            try {
                rows = await dbGateway.execute({
                    operation: 'read', table, where: { UID: [...uids] },
                    options: { raw: true },
                    context: { appName: 'documentCheck', sessionID }
                }) || [];
            } catch (e) {
                console.error(`[documentCheck] ${table}: документы не прочитаны:`, e && e.message || e);
            }
            for (const r of rows) {
                out[table + '|' + r.UID] = {
                    name: globalRoot.pickDisplayValue(r, displayField, 'UID'),
                    date: r.date || null
                };
            }
        }
        return out;
    }

    /** Строки списка по отбору. */
    async function buildRows(params, sessionID) {
        const severity = (params && params.severity) || null;
        const documentTable = (params && params.documentTable) || null;

        const alerts = await documentAlerts.listVisible({
            sessionID, severity, documentTable, limit: LIMIT
        });
        if (!alerts.length) return [];

        const byTable = new Map();
        for (const a of alerts) {
            if (!byTable.has(a.documentTable)) byTable.set(a.documentTable, new Set());
            byTable.get(a.documentTable).add(a.documentUID);
        }
        const docs = await readDocuments(byTable, sessionID);

        const kinds = {};
        for (const table of byTable.keys()) kinds[table] = await kindCaptionOf(table, sessionID);
        const severityCaptions = {};
        for (const s of Object.values(documentAlerts.SEVERITY)) {
            severityCaptions[s] = await tForSession('alert_severity_' + s, sessionID);
        }
        const locale = await localeOf(sessionID);

        const rows = alerts.map(a => {
            const doc = docs[a.documentTable + '|' + a.documentUID] || null;
            return {
                alertUID: a.UID,
                // `__table` — строка называет свою таблицу сама: список
                // разнородный, и ядро открывает по нему запись двойным щелчком.
                __table: a.documentTable,
                UID: a.documentUID,
                severity: a.severity,
                severityCaption: severityCaptions[a.severity] || a.severity,
                kindCaption: kinds[a.documentTable] || a.documentTable,
                documentName: (doc && doc.name) || a.documentUID,
                dateText: doc ? dateTextOf(doc.date, locale) : '',
                sortDate: (doc && doc.date) ? String(doc.date) : '',
                text: a.text,
                actionCaption: (a.action && a.action.caption) || '',
                action: a.action || null
            };
        });

        // Порядок — по важности, затем по дате документа (ТЗ §13). Внутри одной
        // даты порядок уже задан чтением оповещений.
        rows.sort((x, y) => {
            const d = documentAlerts.severityRank(y.severity) - documentAlerts.severityRank(x.severity);
            if (d) return d;
            return String(y.sortDate).localeCompare(String(x.sortDate));
        });
        return rows;
    }

    /** Локаль пользователя для формата даты на экране. */
    async function localeOf(sessionID) {
        const MAP = { ru: 'ru-RU', de: 'de-DE', en: 'en-GB', pl: 'pl-PL' };
        try {
            const user = sessionID ? await globalRoot.getUserBySessionID(sessionID) : null;
            const forms = require('../../../drive_forms/globalServerContext');
            const lang = user ? await forms.languageOfUser(user.UID) : 'de';
            return MAP[lang] || 'de-DE';
        } catch (e) {
            return 'de-DE';
        }
    }

    /** Варианты отбора по уровню. Пустое значение — «все». */
    async function severityOptions(sessionID) {
        const out = [{ value: '', caption: await tForSession('dc_filter_all', sessionID) }];
        // Порядок — от самого важного: его и ищут первым.
        for (const s of [documentAlerts.SEVERITY.ERROR, documentAlerts.SEVERITY.WARNING,
                         documentAlerts.SEVERITY.INFO]) {
            out.push({ value: s, caption: await tForSession('alert_severity_' + s, sessionID) });
        }
        return out;
    }

    /**
     * Варианты отбора по виду документа — из ОБЪЯВЛЕННЫХ правил, а не из того,
     * что сейчас лежит в таблице: список отборов, меняющийся вместе с данными,
     * заставляет искать пропавший пункт.
     */
    async function tableOptions(sessionID) {
        const out = [{ value: '', caption: await tForSession('dc_filter_all', sessionID) }];
        const tables = [...new Set(alertRules.all().map(r => r.table))];
        for (const t of tables) out.push({ value: t, caption: await kindCaptionOf(t, sessionID) });
        out.sort((a, b) => (a.value === '' ? -1 : b.value === '' ? 1 : String(a.caption).localeCompare(String(b.caption))));
        return out;
    }

    return {
        /**
         * Данные формы.
         *
         * Обёртка `{ data: … }` обязательна: ядро ждёт именно её, а не сам набор
         * значений. Без неё форма открывается с пустой таблицей — молча.
         */
        async onLoadData(params, ctx) {
            const sessionID = ctx && ctx.sessionID;
            // ОТМЕТКА ОБ ОСМОТРЕ (§14): человек зашёл и посмотрел — напоминать
            // ему сводкой больше не о чем, даже если он ничего не исправил.
            try {
                const user = sessionID ? await globalRoot.getUserBySessionID(sessionID) : null;
                if (user) await alertsRunner.markChecked(user.UID);
            } catch (e) {
                console.error('[documentCheck] отметка об осмотре не записана:', e && e.message || e);
            }

            return {
                data: {
                    fSeverity: { value: '', options: await severityOptions(sessionID) },
                    fTable: { value: '', options: await tableOptions(sessionID) },
                    rows: await buildRows({}, sessionID)
                }
            };
        },

        /** Перечитать список по текущему отбору. */
        async load(params, ctx) {
            const sessionID = ctx && ctx.sessionID;
            return { ok: true, rows: await buildRows(params || {}, sessionID) };
        }
    };
};
