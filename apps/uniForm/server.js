// uniForm/server.js
// Универсальная форма фреймворка: список (params.dbTable) + редактирование записи (params.tableName + recordID).
// Объединяет функциональность бывших uniListForm и uniRecordForm.
// Backward-compat: layoutMemory проверяется также по именам 'uniListForm' и 'uniRecordForm'.

const { tForSession, tfForSession } = require('../../drive_forms/globalServerContext');

// UID generation utility
let _util = null;
try { _util = require('../../drive_root/db/utilites'); } catch(e) { console.warn('[uniForm] util load failed:', e && e.message); }

const memoryStore = require('../../drive_root/memory_store');
// Пустые значения по типам (NULL только у ссылок) — та же реализация,
// что применяется к схеме и в шлюзе. Второго набора правил быть не должно.
const emptyValues = require('../../drive_root/db/emptyValues');
const { dataApp } = require('../../drive_forms/dataApp');
const config = require('./config.json');
const globalServerContext = require('../../drive_root/globalServerContext');

try { const dbg = memoryStore.debugKeysSync('datasets'); console.log('[uniForm] memoryStore init; datasetsCount=', dbg.count); } catch (e) {}

// ── Иконки по умолчанию для типов сущностей ─────────────────────────────────────────────────
// Запись (одиночный объект) и список различаются: документ → лист / журнал,
// справочник → элемент / справочник.
const ICON_DOCUMENT  = '/apps/general_icons/resources/public/16x16/document.png'; // запись-документ
const ICON_JOURNAL   = '/apps/general_icons/resources/public/16x16/journal.png';  // список документов
const ICON_CATALOG   = '/apps/general_icons/resources/public/16x16/catalog.png';  // список справочника

/**
 * Контекст ВЫЗОВА серверного обработчика формы — тот же, что у обычного RPC.
 *
 * Событие формы (`onLoadData`, `onSave`, `onBeforeSave`) — такой же вызов прикладного
 * кода, как и `/server-call`, и обязано получать такой же `ctx`. Раньше сюда уезжал
 * один `sessionID`, поэтому проверка `ctx.role` в обработчике отвергала даже
 * администратора — и форма открывалась ПУСТЫМ окном без единого сообщения. Каждый
 * автор формы был вынужден дорезолвивать роль сам (заплатка `requireAdmin` в
 * `apps/backup`), то есть писать в прикладном коде то, что знает ядро.
 *
 * Роль всё равно резолвится рядом — она нужна для `getServerScript`; здесь просто
 * не выбрасывается.
 *
 * @param {string} sessionID
 * @param {string} [knownRole] — уже посчитанная роль (не резолвим второй раз)
 * @returns {Promise<{sessionID: string, user: Object|null, role: string|null}>}
 */
async function buildEventContext(sessionID, knownRole) {
    let user = null;
    let role = knownRole || null;
    try {
        const gCtx = require('../../drive_root/globalServerContext');
        user = sessionID ? await gCtx.getUserBySessionID(sessionID) : null;
        if (!role && user) {
            const formsCtx = require('../../drive_forms/globalServerContext');
            role = await formsCtx.getUserAccessRole(user);
        }
    } catch (e) {
        console.error('[uniForm/buildEventContext] error:', e && e.message || e);
    }
    return { sessionID, user, role };
}

/**
 * Данные формы от `onLoadData` → внутренняя форма (массив `{name, value}`).
 *
 * Обработчику разрешено вернуть ОБЫЧНЫЙ объект `{ поле: значение }` — это очевидная
 * запись, и именно её пишут по первому впечатлению. Раньше принимался только массив:
 * объект проходил без ошибки, `_dataMap` оставался пустым, и форма молча открывалась
 * пустой — контракт без диагностики. Теперь обе формы равноправны, а мусор (строка,
 * число) не проглатывается молча, а называется в журнале.
 *
 * @param {*} data — то, что вернул обработчик в поле `data`
 * @param {string} where — откуда вызвано, для сообщения в журнал
 * @returns {Array<Object>}
 */
function normalizeLoadedData(data, where) {
    if (data === null || data === undefined) return [];
    if (Array.isArray(data)) return data;
    if (typeof data === 'object') {
        return Object.entries(data).map(([name, value]) => {
            // Значение может быть уже полной записью ({value, selection, options…}) —
            // тогда берём её как есть, лишь проставив имя.
            if (value && typeof value === 'object' && !Array.isArray(value)
                && (Object.prototype.hasOwnProperty.call(value, 'value')
                    || Object.prototype.hasOwnProperty.call(value, 'selection')
                    || Object.prototype.hasOwnProperty.call(value, 'options'))) {
                return Object.assign({ name, tabularSection: false }, value);
            }
            return { name, value, tabularSection: false };
        });
    }
    console.error(`[uniForm/${where}] onLoadData вернул data типа ${typeof data} — ожидается объект { поле: значение } или массив [{name, value}]`);
    return [];
}

/**
 * Определяет иконку по умолчанию для таблицы с учётом режима (запись/список).
 * 1. Явно заданная иконка из layoutMemory (formIcon для записи, listIcon для списка).
 * 2. Иконка по entityType: документ → document/journal, справочник → catalog.
 * 3. Дефолт (catalog).
 * @param {string} tableName
 * @param {string} [mode] — 'record' (по умолчанию) | 'list'
 */
function getDefaultIconForTable(tableName, mode) {
    const isList = mode === 'list';
    try {
        const layoutMemory2 = require('../../drive_root/layoutMemory');
        const registered = isList
            ? (layoutMemory2.getTableListIcon(tableName) || layoutMemory2.getTableIcon(tableName))
            : layoutMemory2.getTableIcon(tableName);
        if (registered) return registered;
    } catch(e) {}

    const entityType = getEntityTypeForTable(tableName);
    if (entityType === 'document') return isList ? ICON_JOURNAL : ICON_DOCUMENT;
    if (entityType === 'catalog' || entityType === 'справочник' || entityType === 'directory') return ICON_CATALOG;
    return ICON_CATALOG; // дефолт для таблиц без entityConfig
}

/**
 * Читает entityConfig.entityType из db.json для таблицы.
 */
function getEntityTypeForTable(tableName) {
    try {
        const gCtx = require('../../drive_root/globalServerContext');
        const { models } = gCtx.collectAllModelDefs();
        const def = (models || []).find(m => m.tableName === tableName);
        return (def && def.entityConfig && def.entityConfig.entityType) || null;
    } catch(e) {
        return null;
    }
}

/**
 * Обходит все элементы дерева layout (те же ветви, что и translateLayoutI18n).
 * Вызывает `fn(item)` на каждом. Мутировать элемент внутри `fn` можно.
 */
function walkLayoutItems(items, fn) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        fn(item);
        if (Array.isArray(item.layout)) walkLayoutItems(item.layout, fn);
        if (Array.isArray(item.columns)) walkLayoutItems(item.columns, fn);
        if (Array.isArray(item.extraButtons)) walkLayoutItems(item.extraButtons, fn);
        if (Array.isArray(item.tabs)) {
            for (const tab of item.tabs) {
                if (tab && Array.isArray(tab.layout)) walkLayoutItems(tab.layout, fn);
            }
        }
    }
}

/**
 * Замок проведённого документа НА ФОРМЕ (`drive_root/db/immutable.js`).
 *
 * Здесь делается только то, что нельзя сделать на клиенте: сужается набор
 * состояний, доступных для ВЫБОРА. Сами поля гасит клиент — он же обязан запереть
 * форму, когда документ проводится командой из уже открытого окна.
 *
 * Список значений (`options`) при этом остаётся полным: им поле показывает подпись
 * состояния («Ausgestellt») вместо кода. Ограничение выражается отдельным
 * свойством `allowedValues`, а поле запирается совсем, когда выбирать не из чего:
 * единственное значение в выпадающем списке — не выбор, а обманка.
 */
function applyLockToLayout(layout, lock) {
    if (!lock || !Array.isArray(lock.states)) return;
    walkLayoutItems(layout, (item) => {
        if (item.data !== lock.field || !Array.isArray(item.options)) return;
        const props = Object.assign({}, item.properties, { allowedValues: lock.states.slice() });
        if (lock.states.length <= 1) props.locked = true;
        item.properties = props;
    });
}

/**
 * Рекурсивно переводит все { i18n: 'key' } объекты в дереве layout.
 * Обрабатывает: item.caption, item.options[].caption, item.columns[].caption,
 *               tab.caption, item.layout[], item.tabs[].layout[],
 *               item.extraButtons[] (+ их menu[]), item.menu[] (splitButton).
 * Набор ветвей ОБЯЗАН совпадать с layoutMemory.translateLayoutCaptions.
 * Мутирует объекты in-place.
 */
async function translateLayoutI18n(items, sessionID) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        // Translate item caption
        if (item.caption && typeof item.caption === 'object' && item.caption.i18n) {
            try { item.caption = await tForSession(item.caption.i18n, sessionID); }
            catch(e) { item.caption = item.caption.i18n; }
        }
        // tooltip — та же природа, что и caption (подсказка колонки-значка).
        if (item.tooltip && typeof item.tooltip === 'object' && item.tooltip.i18n) {
            try { item.tooltip = await tForSession(item.tooltip.i18n, sessionID); }
            catch(e) { item.tooltip = item.tooltip.i18n; }
        }
        // Translate options captions (emunList etc.)
        if (Array.isArray(item.options)) {
            for (const opt of item.options) {
                if (opt && opt.caption && typeof opt.caption === 'object' && opt.caption.i18n) {
                    try { opt.caption = await tForSession(opt.caption.i18n, sessionID); }
                    catch(e) { opt.caption = opt.caption.i18n; }
                }
            }
        }
        // Recurse into nested layout
        if (Array.isArray(item.layout)) {
            await translateLayoutI18n(item.layout, sessionID);
        }
        // Recurse into table columns (each column is a node with its own caption)
        if (Array.isArray(item.columns)) {
            await translateLayoutI18n(item.columns, sessionID);
        }
        // Кнопки commandBar (у каждой свой caption) и пункты меню splitButton
        if (Array.isArray(item.extraButtons)) {
            await translateLayoutI18n(item.extraButtons, sessionID);
        }
        if (Array.isArray(item.menu)) {
            await translateLayoutI18n(item.menu, sessionID);
        }
        // Recurse into tabs
        if (Array.isArray(item.tabs)) {
            for (const tab of item.tabs) {
                if (!tab || typeof tab !== 'object') continue;
                if (tab.caption && typeof tab.caption === 'object' && tab.caption.i18n) {
                    try { tab.caption = await tForSession(tab.caption.i18n, sessionID); }
                    catch(e) { tab.caption = tab.caption.i18n; }
                }
                if (Array.isArray(tab.layout)) {
                    await translateLayoutI18n(tab.layout, sessionID);
                }
            }
        }
    }
}

/**
 * Резолвит appCaption в строку для сессии.
 * Принимает строку или объект { i18n: 'key' }.
 */
async function resolveAppCaption(caption, sessionID) {
    if (!caption) return null;
    if (typeof caption === 'string') return caption;
    if (typeof caption === 'object' && caption.i18n) {
        try {
            return await tForSession(caption.i18n, sessionID);
        } catch(e) {
            return caption.i18n;
        }
    }
    return String(caption);
}

// ── Вспомогательная функция: проверить layoutMemory по нескольким именам приложений ──────────
// Порядок: сначала 'uniForm', потом старые имена для backward-compat.
const LAYOUT_APP_NAMES_LIST   = ['uniForm', 'uniListForm'];
const LAYOUT_APP_NAMES_RECORD = ['uniForm', 'uniRecordForm'];

async function findCustomLayout(appNames, mode, tableName, sessionID) {
    try {
        const layoutMemory = require('../../drive_root/layoutMemory');
        for (const appName of appNames) {
            if (!layoutMemory.hasRegistered(appName, tableName, mode)) continue;
            const userRole = await layoutMemory.getUserRoleBySession(sessionID);
            const layout = await layoutMemory.getLayoutForUser(appName, tableName, userRole, sessionID, mode);
            if (layout) return layout;
        }
    } catch(e) {
        console.error('[uniForm/findCustomLayout] error:', e && e.message || e);
    }
    return null;
}

function getData(params) {
    return [];
}

// ── getLayoutWithData ─────────────────────────────────────────────────────────────────────────
async function getLayoutWithData(params, sessionID) {
    try {
        const tableName = params && (params.tableName || params.dbTable || params.table);

        // ── РЕЖИМ СПИСКА: явный mode:'list', либо params.dbTable без recordID ─────────────────
        const isListMode = params.mode === 'list' ||
            (!params.mode && !!(params.dbTable && !params.recordID && !params.recordId && !params.id));
        if (isListMode) {
            const customLayout = await findCustomLayout(LAYOUT_APP_NAMES_LIST, 'list', tableName, sessionID);
            if (customLayout) {
                const clLayout = JSON.parse(JSON.stringify(customLayout.layout || customLayout));

                // Если лейаут имеет onLoadData — вызываем его (как в record-режиме),
                // чтобы виртуальные/синтетические списки могли наполнить данные.
                let listData = [];
                if (customLayout.events && customLayout.events.onLoadData) {
                    try {
                        const serverScriptStore = require('../../drive_root/serverScriptStore');
                        const layoutMemory2    = require('../../drive_root/layoutMemory');
                        const userRole = await layoutMemory2.getUserRoleBySession(sessionID);
                        const binding  = customLayout.events.onLoadData;
                        const entry    = serverScriptStore.getServerScript(binding.serverScript, userRole || '*');
                        const fn       = entry && entry.scriptObj && entry.scriptObj[binding.fn || 'onLoadData'];
                        if (typeof fn === 'function') {
                            const result = await fn({ tableName, params }, await buildEventContext(sessionID, userRole));
                            listData = normalizeLoadedData(result && result.data, 'list');
                            if (result && result.caption && Array.isArray(clLayout) && clLayout[0]) {
                                clLayout[0].caption = result.caption;
                            }
                        }
                    } catch (e) {
                        console.error('[uniForm/getLayoutWithData] list onLoadData error:', e && e.message || e);
                    }
                }

                const payload = { layout: clLayout, data: listData, params: params || {} };
                const datasetId = dataApp.storeDataset(payload);
                const resolvedCaption = await resolveAppCaption(customLayout.appCaption, sessionID);
                // Translate all { i18n: 'key' } objects in list layout
                if (Array.isArray(clLayout)) {
                    await translateLayoutI18n(clLayout, sessionID);
                }
                return {
                    layout: clLayout, data: listData, datasetId,
                    clientScript: customLayout.clientScript || null,
                    formIcon: customLayout.listIcon || customLayout.formIcon || getDefaultIconForTable(tableName, 'list'),
                    // Заголовок никогда не должен остаться родовым «uniForm». Если у таблицы
                    // нет зарегистрированной подписи — берём перевод по ключу = имя таблицы
                    // (tForSession вернёт само имя, если перевода нет). Тот же резолв в режиме
                    // записи и в дефолтном списке — форма выбора и форма списка совпадают.
                    appCaption: resolvedCaption || await tForSession(tableName, sessionID),
                    windowState: customLayout.windowState || 'maximized'
                };
            }
            // Дефолтный лейаут списка: DynamicTable.
            // Сортировка по умолчанию: берётся из реестра layoutMemory (если приложение
            // зарегистрировало её через registerListSort), иначе — по name по возрастанию.
            let _initialSort = [{ field: 'name', order: 'asc' }];
            try {
                const layoutMemoryLS = require('../../drive_root/layoutMemory');
                const regSort = layoutMemoryLS.getListSort(tableName);
                if (Array.isArray(regSort) && regSort.length) _initialSort = regSort;
            } catch (e) {}
            const layout = [{
                type: 'table',
                caption: tableName,
                properties: {
                    dynamicTable: true,
                    readOnly: params.readOnly !== false,
                    appName: config.name,
                    tableName: tableName,
                    visibleRows: 10,
                    // Автоматически построенный журнал документов/справочника —
                    // ТОЛЬКО ПРОСМОТР. Запись правится в своей форме, где действуют её
                    // проверки и кнопки «Сохранить»/«Отмена»; править сущность прямо в
                    // списке — не то, чего ждёт пользователь, открывая журнал.
                    // Прикладной лейаут может включить редактирование явно
                    // (`editable: true`) — тогда правка ячейки пишется в базу.
                    editable: false,
                    showToolbar: true,
                    initialSort: _initialSort
                }
            }];
            const payload = { layout, data: [], params: params || {} };
            const datasetId = dataApp.storeDataset(payload);
            const formIcon = getDefaultIconForTable(tableName, 'list');
            const layoutMemory2 = require('../../drive_root/layoutMemory');
            const rawCaption = layoutMemory2.getTableCaption(tableName);
            // Нет зарегистрированной подписи → перевод по ключу = имя таблицы (i18n.json),
            // tForSession вернёт само имя при отсутствии перевода. Никогда не «uniForm».
            const appCaption = (rawCaption ? await resolveAppCaption(rawCaption, sessionID) : null) || await tForSession(tableName, sessionID);
            return { layout, data: [], datasetId, formIcon, appCaption, windowState: 'maximized' };
        }

        // ── РЕЖИМ ЗАПИСИ ──────────────────────────────────────────────────────────────────────

        // Обновление данных после сохранения: datasetId без tableName
        if (params && params.datasetId && !params.tableName) {
            try {
                const dsObj = await dataApp.getDataset(params.datasetId);
                if (dsObj && dsObj.table) {
                    const resolvedParams = Object.assign({}, dsObj.params || {}, {
                        tableName: dsObj.table,
                        recordID:  dsObj.id || undefined
                    });
                    const spec = await generateFormSpec(resolvedParams.tableName, resolvedParams, sessionID);
                    return { layout: spec.layout, data: spec.data, datasetId: spec.datasetId,
                             clientScript: spec.clientScript || null, formIcon: spec.formIcon || null, appCaption: spec.appCaption || null, windowState: spec.windowState || null, fkLookups: spec.fkLookups || null, isNew: !!spec.isNew, events: spec.events || null, prefilled: spec.prefilled || null, lock: spec.lock || null };
                }
            } catch (e) {
                console.error('[uniForm/getLayoutWithData] datasetId refresh error:', e && e.message || e);
            }
        }

        if (params && params.tableName) {
            try {
                const spec = await generateFormSpec(params.tableName, params, sessionID);
                const datasetId = spec.datasetId || dataApp.storeDataset({
                    layout: spec.layout || [],
                    data: spec.data || [],
                    params: params || {},
                    table: params.tableName,
                    id: params.recordID || params.recordId || params.id
                });
                return { layout: spec.layout, data: spec.data, datasetId, clientScript: spec.clientScript || null, formIcon: spec.formIcon || null, appCaption: spec.appCaption || null, windowState: spec.windowState || null, fkLookups: spec.fkLookups || null, isNew: !!spec.isNew, events: spec.events || null, prefilled: spec.prefilled || null, lock: spec.lock || null };
            } catch (e) {
                console.error('[uniForm/getLayoutWithData] generateFormSpec error:', e && e.message || e);
            }
        }

        // Fallback
        const payload = { layout: [], data: [], params: params || {}, table: tableName };
        const datasetId = dataApp.storeDataset(payload);
        return { layout: [], data: [], datasetId };
    } catch (e) {
        return { layout: [], data: [], datasetId: null };
    }
}

// ── Человеческий текст ошибки сохранения ──────────────────────────────────────────────────────
// Sequelize отдаёт «notNull Violation: Bookings.checkIn cannot be null» — английская
// техническая строка с именами КОЛОНОК БД. Пользователю показывать такое нельзя:
// он не знает ни английского, ни имён колонок и не понимает, что делать. Переводим
// в «Заполните обязательные реквизиты: <подписи полей>» на языке сессии. Подписи
// берём из определения модели (fields[].caption), как их видит форма.
// Всё, что не распознали, возвращаем как есть — молча терять диагностику нельзя.
async function humanizeSaveError(err, tableName, sessionID) {
    const raw = (err && err.message) ? err.message : String(err);
    try {
        let paths = [];
        if (err && Array.isArray(err.errors)) {
            paths = err.errors
                .filter(it => it && it.path && (it.type === 'notNull Violation' || it.validatorKey === 'is_null'))
                .map(it => it.path);
        }
        if (!paths.length) {
            // Ошибка могла прийти уже «расплющенной» в строку (перезаворачивание слоями).
            const re = /notNull Violation:\s*\S+?\.(\w+)\s+cannot be null/g;
            let m;
            while ((m = re.exec(raw)) !== null) paths.push(m[1]);
        }
        if (!paths.length) return raw;

        let fields = {};
        try {
            const gCtx = require('../../drive_root/globalServerContext');
            const def = (gCtx.collectAllModelDefs().models || []).find(m => m.tableName === tableName);
            fields = (def && def.fields) || {};
        } catch (e) {}

        const labels = [];
        for (const p of [...new Set(paths)]) {
            const cap = fields[p] && fields[p].caption;
            let label = p;
            if (cap && typeof cap === 'object' && cap.i18n) label = await tForSession(cap.i18n, sessionID);
            else if (typeof cap === 'string' && cap) label = cap;
            if (labels.indexOf(label) < 0) labels.push(label);
        }
        return await tfForSession('required_fields_missing', sessionID, { fields: labels.join(', ') });
    } catch (e) {
        return raw;
    }
}

// ── applyChanges ──────────────────────────────────────────────────────────────────────────────
async function applyChanges(payload, sessionID) {
    let datasetId = payload;
    let changes = null;
    let errTableName = null;
    try {
        console.log('[uniForm] applyChanges called.');
        if (payload && typeof payload === 'object' && (payload.datasetId !== undefined || payload.changes !== undefined)) {
            datasetId = payload.datasetId;
            changes = payload.changes;
        }

        let dsObj = null;
        try {
            dsObj = await dataApp.getDataset(datasetId);
        } catch (e) { console.log('[uniForm] dataset retrieval error', e); }

        if (!datasetId) {
            return { ok: false, error: await tForSession('missing_datasetId', sessionID) };
        } else if (!dsObj) {
            // Серверный контекст формы (датасет) не найден — обычно форма провисела
            // открытой дольше жизни датасета. Пользователю нельзя показывать
            // «unknown datasetId: 9737c264...»: он не понимает ни текста, ни что
            // делать. Технический идентификатор оставляем в логе.
            console.error('[uniForm] applyChanges: unknown datasetId:', datasetId);
            return { ok: false, error: await tForSession('form_context_expired', sessionID) };
        }

        const tableName = dsObj.table || (dsObj.params && (dsObj.params.tableName || dsObj.params.dbTable || dsObj.params.table));
        const recordId = dsObj.id || (dsObj.params && (dsObj.params.recordID || dsObj.params.recordId || dsObj.params.id));

        if (!tableName) {
            return { ok: false, error: await tForSession('no_table_context', sessionID) };
        }
        errTableName = tableName; // нужен в catch для подписей полей в тексте ошибки

        // ── onSave: кастомный серверный скрипт (EAV и другие виртуальные таблицы) ──
        try {
            const layoutMemory = require('../../drive_root/layoutMemory');
            const serverScriptStore = require('../../drive_root/serverScriptStore');
            for (const appN of LAYOUT_APP_NAMES_RECORD) {
                if (!layoutMemory.hasRegistered(appN, tableName, 'record')) continue;
                const userRole = await layoutMemory.getUserRoleBySession(sessionID);
                const stored = await layoutMemory.getLayoutForUser(appN, tableName, userRole, sessionID, 'record');
                if (stored && stored.events && stored.events.onSave) {
                    const binding = stored.events.onSave;
                    const entry = serverScriptStore.getServerScript(binding.serverScript, userRole || '*');
                    const fn = entry && entry.scriptObj && entry.scriptObj[binding.fn || 'onSave'];
                    if (typeof fn === 'function') {
                        const result = await fn({ changes, tableName }, await buildEventContext(sessionID, userRole));
                        return result || { ok: true };
                    }
                }
                break;
            }
        } catch (e) {
            console.error('[uniForm] onSave event error:', e && e.message || e);
        }

        const modelName = globalServerContext.getModelNameForTable(tableName) || tableName;
        const Model = globalServerContext.modelsDB[modelName];

        if (!Model) {
            return { ok: false, error: 'Model not found for table: ' + tableName + ' (model: ' + modelName + ')' };
        }

        const applyDbGW = require('../../drive_root/dbGateway');

        let tabularSectionsData = null;
        if (changes && typeof changes.__tabularSections === 'object' && changes.__tabularSections !== null) {
            tabularSectionsData = changes.__tabularSections;
            changes = Object.assign({}, changes);
            delete changes.__tabularSections;
        }

        const parentUID = recordId;

        await dispatchServerEvent('onBeforeSave', {
            tableName,
            record:          null,
            changes,
            tabularSections: tabularSectionsData || {},
            parentUID,
            isNew:           !recordId || !!dsObj.isNew
        }, { tableName, sessionID });

        if (recordId && !dsObj.isNew) {
            console.log(`[uniForm] Updating ${tableName} UID=${recordId} with`, changes);
            await applyDbGW.execute({ operation: 'update', table: tableName, data: changes, where: { UID: recordId }, context: { appName: 'uniForm', sessionID } });
        } else {
            if (dsObj.isNew && recordId && !changes.UID) {
                changes = Object.assign({}, changes, { UID: recordId });
            }
            console.log(`[uniForm] Creating new ${tableName} with`, changes);
            await applyDbGW.execute({ operation: 'create', table: tableName, data: changes, context: { appName: 'uniForm', sessionID } });
        }

        let parentRecord = null;
        if (tabularSectionsData && parentUID) {
            try {
                parentRecord = await applyDbGW.execute({
                    operation: 'findByPk', table: tableName, where: { UID: parentUID },
                    options: { raw: true }, context: { appName: 'uniForm', sessionID }
                });
            } catch(e) {
                console.warn('[uniForm] Could not load parent record:', e && e.message);
            }
        }

        const saveWarnings = [];
        if (tabularSectionsData && parentUID) {
            const tsDefs = getTabularSectionsForTable(tableName);
            const tsTableNames = new Set(tsDefs.map(d => d.tableName));

            let allModelDefs = [];
            try {
                const gCtx = require('../../drive_root/globalServerContext');
                allModelDefs = (gCtx.collectAllModelDefs().models) || [];
            } catch(e) { console.warn('[uniForm] Could not load model defs:', e && e.message); }

            const hasSiblingFKDeps = (sectName) => {
                const md = allModelDefs.find(m => m.tableName === sectName);
                if (!md || !md.fields) return false;
                return Object.values(md.fields).some(f =>
                    f.references && tsTableNames.has(f.references.model) && f.references.model !== sectName
                );
            };
            const sectionEntries = Object.entries(tabularSectionsData);
            sectionEntries.sort((a, b) => (hasSiblingFKDeps(a[0]) ? 1 : 0) - (hasSiblingFKDeps(b[0]) ? 1 : 0));

            const validSiblingUIDs = {};

            for (const [sectionTableName, rows] of sectionEntries) {
                try {
                    const tsDef = tsDefs.find(d => d.tableName === sectionTableName);
                    if (!tsDef) {
                        console.warn('[uniForm] tabularSection def not found for:', sectionTableName);
                        continue;
                    }
                    const parentField = tsDef.tabularSection.parentField;
                    const sectModelDef = allModelDefs.find(m => m.tableName === sectionTableName);
                    const sectFields = (sectModelDef && sectModelDef.fields) || {};

                    await applyDbGW.execute({
                        operation: 'delete', table: sectionTableName, where: { [parentField]: parentUID },
                        context: { appName: 'uniForm', sessionID }
                    });

                    if (Array.isArray(rows)) {
                        for (let ri = 0; ri < rows.length; ri++) {
                            const row = rows[ri];
                            const rowData = Object.assign({}, row);
                            rowData[parentField] = parentUID;

                            // Пустые значения строк ТЧ приводятся ЕДИНЫМ правилом:
                            // NULL допустим только у полей-ссылок, у остальных типов
                            // своё пустое значение (число 0, строка "", булево false,
                            // дата 0001-01-01). Реализация — `drive_root/db/emptyValues`,
                            // применяется здесь и в `sanitizeData` шлюза.
                            //
                            // Раньше на этом месте была своя логика для чисел, и она
                            // разошлась со шлюзом: тот писал 0, этот — NULL. Строка
                            // прайс-листа с границами возраста NULL/NULL и строка с 0/0
                            // становились РАЗНЫМИ позициями, новая цена не заменяла
                            // старую, и услуга молча давала ноль. Второго набора правил
                            // быть не должно — только этот вызов.
                            for (const [fn, fd] of Object.entries(sectFields)) {
                                if (!emptyValues.isEmptyValue(rowData[fn])) continue;
                                if (emptyValues.isReferenceField(fd)) {
                                    if (rowData[fn] === '') rowData[fn] = null;
                                    continue;
                                }
                                const empty = emptyValues.emptyValueFor(fd);
                                if (empty === undefined) continue;
                                rowData[fn] = (rowData[fn] === undefined && fd.defaultValue != null)
                                    ? fd.defaultValue
                                    : empty;
                            }

                            // Серверная валидация безопасности: межсекционные FK
                            let securityOk = true;
                            for (const [fieldName, fieldDef] of Object.entries(sectFields)) {
                                if (!fieldDef.references) continue;
                                const refTable = fieldDef.references.model;
                                if (!tsTableNames.has(refTable) || refTable === sectionTableName) continue;
                                const fkVal = rowData[fieldName];
                                if (!fkVal) {
                                    if (fieldDef.allowNull === true) continue;
                                    const msg = await tfForSession('row_field_required', sessionID, { row: ri + 1, section: sectionTableName, field: fieldName });
                                    console.warn('[uniForm TS_SECURITY]', msg);
                                    saveWarnings.push(msg);
                                    securityOk = false;
                                    break;
                                }
                                const validSet = validSiblingUIDs[refTable];
                                if (validSet && !validSet.has(fkVal)) {
                                    const msg = await tfForSession('row_field_fk_mismatch', sessionID, { row: ri + 1, section: sectionTableName, field: fieldName });
                                    console.error('[uniForm TS_SECURITY]', msg, `(fkVal=${fkVal})`);
                                    saveWarnings.push(msg);
                                    securityOk = false;
                                    break;
                                }
                            }
                            if (!securityOk) continue;

                            try {
                                await applyDbGW.execute({
                                    operation: 'create', table: sectionTableName, data: rowData,
                                    context: { appName: 'uniForm', sessionID }
                                });
                            } catch (insertErr) {
                                const errMsg = insertErr && insertErr.message || String(insertErr);
                                console.error(`[uniForm] TS INSERT row[${ri}] FAILED:`, errMsg);
                                saveWarnings.push(await tfForSession('row_save_error', sessionID, { row: ri + 1, section: sectionTableName, error: errMsg }));
                            }
                        }
                    }

                    // Читаем актуальные UID для валидации зависимых секций
                    try {
                        const savedRows = await applyDbGW.execute({
                            operation: 'read', table: sectionTableName, where: { [parentField]: parentUID },
                            options: { raw: true }, context: { appName: 'uniForm', sessionID }
                        });
                        validSiblingUIDs[sectionTableName] = new Set((savedRows || []).map(r => r.UID).filter(Boolean));
                    } catch(e) {
                        validSiblingUIDs[sectionTableName] = new Set();
                    }

                    console.log(`[uniForm] TS saved: ${sectionTableName}, rows: ${Array.isArray(rows) ? rows.length : 0}`);
                } catch (e) {
                    console.error('[uniForm] TS save error for', sectionTableName, ':', e && e.message || e);
                }
            }
        }

        // Уведомляем подписанные формы списка/выбора об изменении — они обновятся через SSE
        // (broadcastTableChange → session-клиенты → DynamicTable.refresh). Покрывает обновление
        // списка после добавления и после закрытия формы записи, изменившей запись.
        try {
            const changeAction = (recordId && !dsObj.isNew) ? 'update' : 'create';
            dynamicTableMethods.notifyTableChange(tableName, changeAction, parentUID);
        } catch (e) {}

        return saveWarnings.length > 0
            ? { ok: true, recordId: parentUID, warnings: saveWarnings }
            : { ok: true, recordId: parentUID };
    } catch (e) {
        console.error('[uniForm] applyChanges error:', e);
        return { ok: false, error: await humanizeSaveError(e, errTableName, sessionID) };
    }
}

// ── registerDynamicTableMethods ───────────────────────────────────────────────────────────────
const { registerDynamicTableMethods } = require('../../drive_forms/dynamicTableRegistry');

function buildTableFields(params) {
    const tableName = params && (params.tableName || params.dbTable || params.table);
    if (!tableName) return null;
    return buildTableFieldsFromModel(tableName);
}

// Подписи допустимых значений полей (db.json → options[].caption = { i18n }) —
// перевести ДО того, как поля разойдутся по потребителям формы: и в data-записи
// (`item.options`), и в автоконтролы (`ctrl.options`). Клиент подставляет caption
// как есть — непереведённый `{ i18n: ... }` печатается как «[object Object]»
// (так сломалось поле «Статус» формы счёта, когда список значений переехал в модель).
// Это тот же набор ветвей, что переводит translateColumnsI18n для колонок списков.
async function translateFieldOptions(fields, sessionID) {
    if (!sessionID || !Array.isArray(fields)) return fields;
    for (const f of fields) {
        if (!f || !Array.isArray(f.options)) continue;
        for (const opt of f.options) {
            if (opt && opt.caption && typeof opt.caption === 'object' && opt.caption.i18n) {
                try { opt.caption = await tForSession(opt.caption.i18n, sessionID); }
                catch (e) { opt.caption = opt.caption.i18n; }
            }
        }
    }
    return fields;
}

// Build table fields from global model metadata (единственная копия для uniForm)
async function buildTableFieldsFromModel(tableName) {
    try {
        const globalCtx = require('../../drive_root/globalServerContext');
        const modelName = globalCtx.getModelNameForTable(tableName) || tableName;
        if (!modelName) return null;
        const meta = await globalCtx.getTableMetadata(modelName);
        if (!Array.isArray(meta)) return null;

        const fields = meta.map(f => {
            const typeKey = f.type || '';
            // Явный inputType из db.json (метаданные getTableMetadata) имеет приоритет:
            // поле может задать кастомный контрол (напр. "color"), не завязываясь на тип.
            let inputType = f.inputType || 'textbox';
            if (f.inputType) { /* явный контрол — по типу не переопределяем */ }
            else if (f.foreignKey) inputType = 'recordSelector';
            else if (f.isAddress) inputType = 'address';
            else if (typeKey === 'INTEGER') inputType = 'integer';
            else if (typeKey === 'BOOLEAN') inputType = 'checkbox';
            else if (typeKey === 'DATE' || typeKey === 'DATEONLY') inputType = 'date';

            const field = {
                name: f.name,
                caption: f.caption || f.name,
                type: typeKey,
                inputType: inputType,
                width: f.width || 100,
                source: 'field',
                editable: !!f.editable
            };

            // Набор допустимых значений поля (db.json → options) едет до колонки
            // списка и до автоформы: без него ячейка печатает сырое значение из БД
            // («issued» вместо «Ausgestellt»), потому что расшифровка жила только
            // в ручном лейауте формы записи.
            if (Array.isArray(f.options)) field.options = f.options;

            // Время у поля-даты в автоформе: `DATE` хранит момент времени, и раз
            // лейаут никто не писал — показываем значение целиком (см. getTableMetadata).
            if (f.showTime) field.properties = Object.assign({}, field.properties, { showTime: true });

            if (f.foreignKey) {
                field.foreignKey = f.foreignKey;
                // No explicit showSelectionButton/showListButton → the client auto-decides:
                // a small option set (RLS-filtered < 10) renders an inline dropdown, a large
                // one the "..." selector form. Same UX as the hand-built booking layout.
                field.properties = Object.assign({}, field.properties, {
                    selection: { table: f.foreignKey.table, idField: f.foreignKey.field || 'UID', displayField: f.foreignKey.displayField || 'name' }
                });
            }

            return field;
        });

        return fields;
    } catch (e) {
        console.error('[uniForm/buildTableFieldsFromModel] metadata build failed:', e && e.message || e);
        return null;
    }
}

// Map inputType to UI control type
function mapInputTypeToControl(inputType) {
    const t = (inputType || '').toString().toLowerCase();
    if (t === 'textbox' || t === 'string') return 'textbox';
    if (t === 'integer') return 'integer';
    if (t === 'number') return 'number';
    if (t === 'checkbox' || t === 'boolean') return 'checkbox';
    if (t === 'date' || t === 'dateonly') return 'date';
    if (t === 'recordselector') return 'recordSelector';
    if (t === 'address') return 'address';
    if (t === 'textarea' || t === 'text') return 'textarea';
    if (t === 'enum' || t === 'emunlist' || t === 'emunlist') return 'emunList';
    if (t === 'color') return 'color';
    return 'textbox';
}

// Динамический резолвер моделей: использует globalServerContext, не хардкодит таблицы
const dynamicTableMethods = registerDynamicTableMethods('uniForm', {
    tables: (params) => {
        const tableName = params && (params.tableName || params.dbTable || params.table);
        if (!tableName) return null;
        try {
            const globalCtx = require('../../drive_root/globalServerContext');
            return globalCtx.getModelNameForTable(tableName) || tableName;
        } catch(e) {
            return tableName;
        }
    },
    tableFields: (params) => {
        return buildTableFields(params);
    },
    accessCheck: async (user, tableName, action) => {
        return true;
    }
});

// ── Вспомогательные функции для работы с ТЧ ─────────────────────────────────────────────────

function getTabularSectionsForTable(parentTableName) {
    try {
        const globalCtx = require('../../drive_root/globalServerContext');
        const { models } = globalCtx.collectAllModelDefs();
        return (models || []).filter(def =>
            def.tabularSection &&
            def.tabularSection.parentTable === parentTableName
        );
    } catch (e) {
        console.error('[uniForm] getTabularSectionsForTable error:', e && e.message);
        return [];
    }
}

const _beforeSaveTSRowHooks = new Map();

function registerBeforeSaveTSRow(parentTableName, hook) {
    if (typeof parentTableName !== 'string' || typeof hook !== 'function') {
        throw new Error('registerBeforeSaveTSRow: parentTableName (string) and hook (function) are required');
    }
    _beforeSaveTSRowHooks.set(parentTableName, hook);
}

// ── dispatchServerEvent ───────────────────────────────────────────────────────────────────────
async function dispatchServerEvent(eventName, payload, { tableName, sessionID }) {
    try {
        const layoutMemory = require('../../drive_root/layoutMemory');
        const serverScriptStore = require('../../drive_root/serverScriptStore');
        for (const appN of LAYOUT_APP_NAMES_RECORD) {
            if (!layoutMemory.hasRegistered(appN, tableName, 'record')) continue;
            const userRole = await layoutMemory.getUserRoleBySession(sessionID);
            const stored = await layoutMemory.getLayoutForUser(appN, tableName, userRole, sessionID, 'record');
            const binding = stored && stored.events && stored.events[eventName];
            if (!binding || !binding.serverScript) break;
            const entry = serverScriptStore.getServerScript(binding.serverScript, userRole || '*');
            const fn = entry && entry.scriptObj && entry.scriptObj[binding.fn || eventName];
            if (typeof fn === 'function') {
                await fn(payload, await buildEventContext(sessionID, userRole));
                console.log(`[uniForm] server event "${eventName}" handled for ${tableName}`);
            }
            break;
        }
    } catch(e) {
        console.error(`[uniForm] event "${eventName}" dispatch error:`, e && e.message || e);
        // Пробрасываем ошибку: серверное событие (onBeforeSave) — это точка валидации,
        // которая ДОЛЖНА уметь отменить сохранение (напр. контроль дат брони). applyChanges
        // ловит исключение и возвращает { ok:false, error } — клиент показывает сообщение.
        throw e;
    }
}

// ── Автозаполнение: загрузка и применение дефолтов пользователя ──────────────────────────────

async function loadUserDefaultValues(sessionID) {
    try {
        const globalCtx = require('../../drive_root/globalServerContext');
        const user = await globalCtx.getUserBySessionID(sessionID);
        if (!user) return {};
        const Model = globalCtx.modelsDB && globalCtx.modelsDB.UserSettingsDefaults;
        if (!Model) return {};
        const rows = await Model.findAll({ where: { userId: user.UID }, raw: true });
        const map = {};
        for (const r of rows) {
            if (r.tableName && r.recordId) map[r.tableName] = { recordId: r.recordId, recordLabel: r.recordLabel || r.recordId };
        }
        return map;
    } catch (e) {
        console.error('[uniForm/loadUserDefaultValues] error:', e && e.message);
        return {};
    }
}

// Возвращает имена полей, которые реально были заполнены — вызывающий код
// регистрирует их как «программно заполненные» (spec.prefilled.fields), чтобы
// клиент прогнал по ним обработчики «при изменении».
function applyAutofillFromFields(data, fields, defaultsMap) {
    const filled = [];
    for (const f of fields) {
        if (f.inputType !== 'recordSelector') continue;
        const targetTable = (f.foreignKey && f.foreignKey.table) ||
            (f.properties && f.properties.selection && f.properties.selection.table);
        if (!targetTable) continue;
        const def = defaultsMap[targetTable];
        if (!def) continue;
        const item = data.find(d => d.name === f.name);
        if (!item || item.value) continue;
        item.value = def.recordId;
        item.selection = { id: def.recordId, display: def.recordLabel };
        filled.push(f.name);
    }
    return filled;
}

function applyAutofillFromLayout(data, layout, defaultsMap) {
    function walk(items) {
        if (!Array.isArray(items)) return;
        for (const item of items) {
            if (item.type === 'recordSelector' && item.data) {
                const sel = item.properties && item.properties.selection;
                const targetTable = sel && sel.table && !sel.table.includes('{') ? sel.table : null;
                if (targetTable) {
                    const def = defaultsMap[targetTable];
                    if (def) {
                        const dataItem = data.find(d => d.name === item.data);
                        if (dataItem && !dataItem.value) {
                            dataItem.value = def.recordId;
                            dataItem.selection = { id: def.recordId, display: def.recordLabel };
                        }
                    }
                }
            }
            if (item.layout) walk(item.layout);
        }
    }
    walk(Array.isArray(layout) ? layout : [layout]);
}

// ── Серверный префетч FK-lookup'ов лейаута ───────────────────────────────────────────────────
// Клиентский рендер для каждого recordSelector в AUTO-режиме (без явных флагов
// showSelectionButton/showListButton) делает RPC getLookupList — на форме с N FK-таблиц
// это N ПОСЛЕДОВАТЕЛЬНЫХ round-trip'ов, пока окно ещё скрыто. Сервер собирает те же
// lookup'ы параллельно (БД рядом) и кладёт их в ответ getLayoutWithData полем fkLookups;
// клиент засеивает ими _fkLookupCache, и рендер обходится без единого доп. запроса.

// Сбор уникальных selection.table из лейаута — зеркало клиентской логики renderItem:
// readOnly → кнопок нет (lookup не нужен); явные флаги → нужен только при showListButton;
// без флагов (AUTO) → нужен всегда. Обходятся и поля (layout), и колонки таблиц (columns),
// и вкладки (tabs). Динамические ссылки ('{tableName}') пропускаются.
function collectSelectionTables(layout) {
    const tables = new Set();
    const considerProps = (props) => {
        if (!props || props.readOnly) return;
        const sel = props.selection;
        const table = sel && sel.table;
        if (!table || typeof table !== 'string' || table.includes('{')) return;
        const hasSelFlag  = Object.prototype.hasOwnProperty.call(props, 'showSelectionButton');
        const hasListFlag = Object.prototype.hasOwnProperty.call(props, 'showListButton');
        if (hasSelFlag || hasListFlag) {
            if (props.showListButton) tables.add(table);
        } else {
            tables.add(table);
        }
    };
    const walk = (items) => {
        if (!Array.isArray(items)) return;
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            considerProps(item.properties);
            if (Array.isArray(item.columns)) {
                for (const col of item.columns) {
                    if (col && typeof col === 'object') considerProps(col.properties);
                }
            }
            if (item.layout) walk(item.layout);
            if (Array.isArray(item.tabs)) {
                for (const tab of item.tabs) { if (tab && tab.layout) walk(tab.layout); }
            }
        }
    };
    walk(Array.isArray(layout) ? layout : [layout]);
    return [...tables];
}

// Параллельный префетч: те же параметры, что у клиентского _fetchFkLookup
// (firstRow 0, visibleRows 50), тот же формат результата { totalRows, items }.
// Ошибка по таблице — не фатальна: таблица просто не попадает в ответ, клиент
// сходит за ней сам (fallback-путь _fetchFkLookup сохранён).
async function buildFkLookups(layout, sessionID) {
    try {
        const tables = collectSelectionTables(layout);
        if (tables.length === 0) return null;
        const globalCtx = require('../../drive_root/globalServerContext');
        const result = {};
        await Promise.all(tables.map(async (table) => {
            try {
                const modelName = globalCtx.getModelNameForTable(table);
                if (!modelName) return;
                const raw = await globalCtx.getLookupList({ modelName, tableName: table, firstRow: 0, visibleRows: 50, sessionID });
                const rows = (raw && raw.data) || [];
                result[table] = {
                    totalRows: (raw && typeof raw.totalRows === 'number') ? raw.totalRows : rows.length,
                    items: rows.map(r => ({ value: r.UID, caption: r.display }))
                };
            } catch (e) { /* таблица недоступна — клиент сходит сам */ }
        }));
        return Object.keys(result).length > 0 ? result : null;
    } catch (e) {
        return null;
    }
}

// ── generateFormSpec ──────────────────────────────────────────────────────────────────────────
async function generateFormSpec(tableName, params, sessionID) {
    try {
        if (!tableName) return { data: [], layout: [] };

        // Проверяем кастомный лейаут ДО загрузки модели (поддержка виртуальных таблиц)
        let customLayoutObj = null;
        let clientScript = null;
        let formIcon = null;
        let appCaption = null;
        let recordCaption = null;
        let windowState = null;
        try {
            const layoutMemory = require('../../drive_root/layoutMemory');
            for (const appN of LAYOUT_APP_NAMES_RECORD) {
                if (!layoutMemory.hasRegistered(appN, tableName, 'record')) continue;
                const userRole = await layoutMemory.getUserRoleBySession(sessionID);
                customLayoutObj = await layoutMemory.getLayoutForUser(appN, tableName, userRole, sessionID, 'record');
                if (customLayoutObj) {
                    clientScript = customLayoutObj.clientScript || null;
                    formIcon = customLayoutObj.formIcon || null;
                    windowState = customLayoutObj.windowState || null;
                    appCaption = customLayoutObj.appCaption || null;
                    recordCaption = customLayoutObj.recordCaption || null;
                    break;
                }
            }
        } catch (e) {
            console.error('[uniForm/generateFormSpec] custom layout early check error:', e && e.message || e);
        }

        // onLoadData: данные загружает прикладной серверный скрипт
        if (customLayoutObj && customLayoutObj.events && customLayoutObj.events.onLoadData) {
            try {
                const serverScriptStore = require('../../drive_root/serverScriptStore');
                const layoutMemory = require('../../drive_root/layoutMemory');
                const userRole = await layoutMemory.getUserRoleBySession(sessionID);
                const binding = customLayoutObj.events.onLoadData;
                const entry = serverScriptStore.getServerScript(binding.serverScript, userRole || '*');
                const fn = entry && entry.scriptObj && entry.scriptObj[binding.fn || 'onLoadData'];
                if (typeof fn === 'function') {
                    const result = await fn({ tableName, params }, await buildEventContext(sessionID, userRole));
                    const layout = JSON.parse(JSON.stringify(customLayoutObj.layout || []));
                    const data = normalizeLoadedData(result && result.data, 'generateFormSpec');
                    if (result && result.caption && layout[0]) layout[0].caption = result.caption;
                    // Автозаполнение для новых записей
                    if (!params || (!params.recordID && !params.recordId && !params.id)) {
                        const dfltMap = await loadUserDefaultValues(sessionID);
                        if (Object.keys(dfltMap).length > 0) applyAutofillFromLayout(data, layout, dfltMap);
                    }
                    const datasetId = dataApp.storeDataset({
                        layout, data, params: params || {},
                        table: tableName,
                        id: params && (params.recordID || params.recordId || params.id)
                    });
                    const fkLookups = await buildFkLookups(layout, sessionID);
                    // Без явного windowState центрируем и подгоняем размер под контент — как и
                    // основная ветка generateFormSpec. Иначе форма (напр. настройки организации/
                    // пользователя на onLoadData) осталась бы 0×0 в углу: хардкод размера в
                    // uniForm/client.js убран.
                    // Фолбэк заголовка — как в режиме списка и в модельной ветке: если у
                    // кастомного лейаута нет appCaption, переводим по ключу = имя таблицы
                    // (tForSession вернёт само имя при отсутствии перевода). Заголовок никогда
                    // не должен остаться родовым «uniForm» (форма через onLoadData).
                    const resolvedOnLoadCaption = (await resolveAppCaption(appCaption, sessionID)) || await tForSession(tableName, sessionID);
                    return { layout, data, datasetId, clientScript, formIcon, appCaption: resolvedOnLoadCaption, windowState: windowState || 'centered', fkLookups };
                }
            } catch (e) {
                console.error('[uniForm/generateFormSpec] onLoadData dispatch error:', e && e.message || e);
            }
        }

        const fields = await buildTableFieldsFromModel(tableName);
        if (!Array.isArray(fields)) return { data: [], layout: [] };
        await translateFieldOptions(fields, sessionID);

        let record = null;
        const recordId = params && (params.recordID || params.recordId || params.id);

        try {
            const globalCtx = require('../../drive_root/globalServerContext');
            const modelName = globalCtx.getModelNameForTable(tableName) || tableName;
            const Model = (globalCtx.modelsDB || {})[modelName];
            if (Model && recordId !== undefined && recordId !== null) {
                const specDbGW = require('../../drive_root/dbGateway');
                record = await specDbGW.execute({ operation: 'findByPk', table: tableName, where: { UID: recordId }, options: { raw: true }, context: { appName: 'uniForm', sessionID } });
            }
        } catch (e) {
            console.error('[uniForm/generateFormSpec] globalCtx lookup error:', e && e.message || e);
        }

        const data = await Promise.all(fields.map(async f => {
            const typeKey = (f.type || '').toUpperCase();
            let defaultValue = null;
            if (typeKey === 'INTEGER' || typeKey === 'NUMBER') defaultValue = 0;
            else if (typeKey === 'BOOLEAN') defaultValue = false;
            else defaultValue = '';

            const item = {
                name: f.name,
                caption: f.caption || f.name,
                valueType: typeKey || 'STRING',
                editable: !!f.editable,
                value: defaultValue
            };

            if (record && Object.prototype.hasOwnProperty.call(record, f.name)) {
                item.value = record[f.name];
            }

            if (item.value != null && f.properties && f.properties.selection) {
                try {
                    const targetTable = f.properties.selection.table || (f.foreignKey && f.foreignKey.table);
                    const displayField = f.properties.selection.displayField || (f.foreignKey && f.foreignKey.displayField) || 'name';
                    if (targetTable) {
                        const fkDbGW = require('../../drive_root/dbGateway');
                        const trg = await fkDbGW.execute({ operation: 'findByPk', table: targetTable, where: { UID: item.value }, options: { raw: true }, context: { appName: 'uniForm', sessionID } });
                        if (trg) {
                            item.selection = { id: trg.UID, display: trg[displayField] || String(trg.UID) };
                        }
                    }
                } catch (e) { /* ignore FK resolution errors */ }
            }

            if (f.options) item.options = f.options;
            if (f.properties && !item.selection) item.properties = f.properties;
            return item;
        }));

        // UID — системный первичный ключ; в автогенерируемой форме записи его как
        // редактируемое поле не показываем (значение остаётся в data для pre-gen/save).
        const controls = fields.filter(f => f.name !== 'UID').map(f => {
            const ctrlType = mapInputTypeToControl(f.inputType || 'textbox');
            const ctrl = { type: ctrlType, name: f.name, data: f.name, caption: f.caption || f.name };
            if (f.properties) ctrl.properties = f.properties;
            if (f.options) ctrl.options = f.options;
            return ctrl;
        });

        // Пустой layout у зарегистрированной записи = «кастомного лейаута нет»: таблица
        // зарегистрирована только ради extraButtons (см. layoutMemory.saveLayout) —
        // форма строится автоматически из модели, кнопки вклеиваются в её commandBar ниже.
        let layout;
        if (customLayoutObj) {
            const rawCustom = Array.isArray(customLayoutObj.layout) ? customLayoutObj.layout : customLayoutObj;
            if (!Array.isArray(rawCustom) || rawCustom.length) {
                layout = JSON.parse(JSON.stringify(rawCustom));
            }
        }

        // Pre-генерация UID для новой записи
        let effectiveRecordId = recordId;
        let isNew = false;
        if (!effectiveRecordId) {
            isNew = true;
            try {
                const globalCtxForUID = require('../../drive_root/globalServerContext');
                const modelNameForUID = globalCtxForUID.getModelNameForTable(tableName) || tableName;
                if (_util && typeof _util.generateUID === 'function') {
                    effectiveRecordId = _util.generateUID(modelNameForUID);
                } else {
                    const time = Date.now().toString(36).padStart(9, '0').slice(-9);
                    const random = require('crypto').randomBytes(6).readUIntBE(0, 6).toString(36).padStart(7, '0').slice(-7);
                    effectiveRecordId = `${time}-0000000-${random}`;
                }
                const uidField = data.find(d => d.name === 'UID');
                if (uidField) uidField.value = effectiveRecordId;
            } catch(e) {
                console.error('[uniForm/generateFormSpec] UID pre-generation failed:', e && e.message);
            }
        }

        // Реестр ПРОГРАММНО заполненных значений новой записи (автозаполнение по
        // умолчаниям пользователя, prefill, prefillTabular). Отдаётся клиенту в
        // spec.prefilled — после отрисовки формы DataForm прогоняет по этим полям
        // те же обработчики «при изменении», что сработали бы при ручном вводе
        // (см. DataForm._firePrefilledChangeEvents). Без этого программное
        // заполнение — «немое»: напр. бронь из календаря приходила с выбранной
        // комнатой, но без её услуг, т.к. onChange колонки roomId не срабатывал.
        //   fields  — имена скалярных полей формы
        //   tabular — dataKey ТЧ → [{ rowIndex, fields: [...] }]
        const prefilledFields = new Set();
        const prefilledTabular = {};
        // Реквизиты строки, реально пришедшие из prefillTabular (UID генерируем мы,
        // `__<fk>_display` — резолв display, оба «изменением» не являются).
        const registerPrefilledRows = (dataKey, rows) => {
            if (!Array.isArray(rows) || !rows.length) return;
            prefilledTabular[dataKey] = rows.map((r, i) => ({
                rowIndex: i,
                fields: Object.keys(r || {}).filter(k => k !== 'UID' && k.indexOf('__') !== 0)
            })).filter(e => e.fields.length);
        };

        // Автозаполнение для новых записей
        if (isNew) {
            const dfltMap = await loadUserDefaultValues(sessionID);
            if (Object.keys(dfltMap).length > 0) {
                for (const n of applyAutofillFromFields(data, fields, dfltMap)) prefilledFields.add(n);
            }
        }

        // Prefill: явные начальные значения скалярных полей новой записи
        // (params.prefill = { field: value }). Имеет приоритет над автозаполнением.
        // Для FK-полей резолвим display, чтобы поле сразу показало имя, а не UID.
        if (isNew && params && params.prefill && typeof params.prefill === 'object') {
            for (const [k, v] of Object.entries(params.prefill)) {
                const item = data.find(d => d.name === k);
                if (!item) continue;
                item.value = v;
                prefilledFields.add(k);
                const sel = item.properties && item.properties.selection;
                if (sel && sel.table && v != null && v !== '') {
                    try {
                        const pfDbGW = require('../../drive_root/dbGateway');
                        const trg = await pfDbGW.execute({ operation: 'findByPk', table: sel.table, where: { UID: v }, options: { raw: true }, context: { appName: 'uniForm', sessionID } });
                        if (trg) item.selection = { id: trg.UID, display: trg[sel.displayField || 'name'] || String(trg.UID) };
                    } catch (e) { /* без display — поле покажет UID до перезагрузки */ }
                }
            }
        }

        if (!layout) {
            // Прикладные кнопки автоформы (layoutMemory.saveLayout({ extraButtons })).
            // Клонируем: translateLayoutI18n переводит лейаут in-place, а объект пришёл
            // из кэша layoutMemory — мутировать его нельзя (испортит другие языки).
            const autoExtraButtons = (customLayoutObj && Array.isArray(customLayoutObj.extraButtons) && customLayoutObj.extraButtons.length)
                ? JSON.parse(JSON.stringify(customLayoutObj.extraButtons))
                : null;
            layout = [
                autoExtraButtons ? { type: 'commandBar', extraButtons: autoExtraButtons } : { type: 'commandBar' },
                // alignFields: captions and controls render as a 2-column grid so labels
                // and fields line up (same polish as the hand-built booking form).
                // noBorder + no caption: the record isn't wrapped in a visible frame with a
                // raw table-name legend — the window title already names the record.
                { type: 'group', orientation: 'vertical', alignFields: true, noBorder: true, layout: controls }
            ];

            // Автоматические табличные части
            try {
                const tsDefs = getTabularSectionsForTable(tableName);
                if (tsDefs.length > 0) {
                    // 3.4: независимые табличные части грузятся ПАРАЛЛЕЛЬНО (Promise.all),
                    // а не последовательным for-циклом — форма с несколькими ТЧ (booking:
                    // гости + услуги) больше не ждёт каждую секцию по очереди. Внутри
                    // секции независимые чтения (строки ТЧ и метаданные полей) тоже идут
                    // конкурентно, как и резолв разных FK-таблиц. Порядок секций (для
                    // вкладок) сохраняется — Promise.all не меняет порядок массива.
                    const tsResults = await Promise.all(tsDefs.map(async (tsDef) => {
                        const tsTableName = tsDef.tableName;
                        const tsParentField = tsDef.tabularSection && tsDef.tabularSection.parentField;
                        if (!tsTableName || !tsParentField) return null;

                        // prefillTabular: для новой записи можно предзаполнить строки ТЧ
                        // (напр. календарь добавляет бронь с уже выбранной комнатой).
                        const prefillRows = (isNew && params && params.prefillTabular && Array.isArray(params.prefillTabular[tsTableName]))
                            ? params.prefillTabular[tsTableName].map(r => Object.assign(
                                { UID: (_util && typeof _util.generateUID === 'function') ? _util.generateUID(tsDef.name) : undefined },
                                r))
                            : null;
                        if (prefillRows) registerPrefilledRows('__ts_' + tsTableName, prefillRows);

                        // Строки ТЧ и метаданные полей независимы → читаем параллельно.
                        const tsRowsP = (effectiveRecordId && !isNew)
                            ? (async () => {
                                try {
                                    const tsDbGW = require('../../drive_root/dbGateway');
                                    const fetched = await tsDbGW.execute({
                                        operation: 'read', table: tsTableName, where: { [tsParentField]: effectiveRecordId },
                                        options: { raw: true }, context: { appName: 'uniForm', sessionID }
                                    });
                                    return Array.isArray(fetched) ? fetched : [];
                                } catch (e) {
                                    console.error('[uniForm/generateFormSpec] TS load error for', tsTableName, ':', e && e.message);
                                    return [];
                                }
                            })()
                            : Promise.resolve(prefillRows || []);

                        const tsFieldsP = (async () => {
                            try {
                                const tsFields = await buildTableFieldsFromModel(tsTableName);
                                await translateFieldOptions(tsFields, sessionID);
                                return Array.isArray(tsFields) ? tsFields : [];
                            } catch (e) {
                                console.error('[uniForm/generateFormSpec] TS fields error for', tsTableName, ':', e && e.message);
                                return [];
                            }
                        })();

                        const [tsRows, tsFields] = await Promise.all([tsRowsP, tsFieldsP]);

                        const tsColumns = tsFields
                            .filter(f => f.name !== tsParentField && f.name !== 'UID')
                            .map(f => {
                                const col = {
                                    caption: f.caption || f.name,
                                    data: f.name,
                                    width: f.width || 120,
                                    inputType: mapInputTypeToControl(f.inputType || 'textbox')
                                };
                                if (f.properties) col.properties = f.properties;
                                if (f.foreignKey) col.foreignKey = f.foreignKey;
                                return col;
                            });
                        const tsFkFields = tsFields.filter(f =>
                            f.name !== tsParentField && f.name !== 'UID' &&
                            f.foreignKey && f.foreignKey.table
                        );

                        // Резолвим FK display-значения в строках ТЧ: один запрос на
                        // FK-таблицу, разные FK-таблицы — параллельно.
                        if (tsRows.length > 0 && tsFkFields.length > 0) {
                            try {
                                const resolveDbGW = require('../../drive_root/dbGateway');
                                await Promise.all(tsFkFields.map(async (fkField) => {
                                    const fkTable = fkField.foreignKey.table;
                                    const fkIdField = fkField.foreignKey.field || 'UID';
                                    const fkDispField = fkField.foreignKey.displayField || 'name';
                                    const fkValues = [...new Set(tsRows.map(r => r[fkField.name]).filter(v => v !== null && v !== undefined && v !== ''))];
                                    if (fkValues.length === 0) return;
                                    try {
                                        const lookupRows = await resolveDbGW.execute({
                                            operation: 'read', table: fkTable, where: { [fkIdField]: fkValues },
                                            options: { raw: true }, context: { appName: 'uniForm', sessionID }
                                        });
                                        if (Array.isArray(lookupRows)) {
                                            const dispMap = {};
                                            for (const lr of lookupRows) dispMap[lr[fkIdField]] = lr[fkDispField] || lr[fkIdField];
                                            const dispKey = '__' + fkField.name + '_display';
                                            for (const row of tsRows) {
                                                if (row[fkField.name] !== undefined && row[fkField.name] !== null) {
                                                    row[dispKey] = dispMap[row[fkField.name]] || row[fkField.name];
                                                }
                                            }
                                        }
                                    } catch (e) {
                                        console.warn('[uniForm/generateFormSpec] FK resolve error for', fkField.name, ':', e && e.message);
                                    }
                                }));
                            } catch (e) {
                                console.warn('[uniForm/generateFormSpec] TS FK resolve outer error:', e && e.message);
                            }
                        }

                        const dataKey = '__ts_' + tsTableName;
                        const tsName = 'ts_' + tsTableName;
                        const tsCaption = (tsDef.tabularSection && tsDef.tabularSection.caption) || tsDef.name || tsTableName;
                        return {
                            dataEntry: {
                                name: dataKey, value: tsRows, tabularSection: true,
                                tableName: tsTableName, parentField: tsParentField
                            },
                            layoutItem: {
                                type: 'group', caption: tsCaption, orientation: 'vertical',
                                layout: [{
                                    type: 'table', name: tsName, data: dataKey,
                                    columns: tsColumns,
                                    properties: { editMode: 'cell-immediate', visibleRows: 5 }
                                }]
                            }
                        };
                    }));

                    const tsLayoutItems = [];
                    for (const r of tsResults) {
                        if (!r) continue;
                        data.push(r.dataEntry);
                        tsLayoutItems.push(r.layoutItem);
                    }

                    if (tsLayoutItems.length > 0) {
                        const actionsIdx = layout.findIndex(item =>
                            item.type === 'group' && Array.isArray(item.layout) && item.layout.some(i => i.action === 'save')
                        );
                        const insertIdx = actionsIdx >= 0 ? actionsIdx : layout.length;
                        if (tsLayoutItems.length === 1) {
                            layout.splice(insertIdx, 0, tsLayoutItems[0]);
                        } else {
                            layout.splice(insertIdx, 0, {
                                type: 'tabs',
                                tabs: tsLayoutItems.map(item => ({ caption: item.caption, layout: [item] }))
                            });
                        }
                    }
                }
            } catch (e) {
                console.error('[uniForm/generateFormSpec] tabular sections error:', e && e.message || e);
            }
        }

        // Префетч FK-lookup'ов стартует здесь (лейаут финален) и идёт ПАРАЛЛЕЛЬНО
        // с загрузкой tabularFilter-таблиц; await — перед самым return.
        const fkLookupsPromise = buildFkLookups(layout, sessionID);

        // tabularFilter: декларативная загрузка данных для table-элементов
        try {
            const collectTableItems = (items) => {
                const result = [];
                if (!Array.isArray(items)) return result;
                for (const item of items) {
                    if (!item) continue;
                    if (item.type === 'table' && item.properties && item.properties.tabularFilter && item.data) result.push(item);
                    if (item.layout) result.push(...collectTableItems(item.layout));
                    if (item.tabs) { for (const tab of item.tabs) { if (tab.layout) result.push(...collectTableItems(tab.layout)); } }
                }
                return result;
            };
            // Таблицы tabularFilter независимы → грузим ПАРАЛЛЕЛЬНО (как 3.4 для
            // авто-ТЧ): booking (4 ТЧ) больше не ждёт каждую по очереди. Внутри
            // таблицы FK-таблицы тоже резолвятся параллельно. Дедуп-проверка по
            // data — ДО параллельной фазы (data в ней не меняется), push результатов
            // — после, в исходном порядке.
            const tableItemsWithFilter = collectTableItems(layout)
                .filter(item => !data.find(d => d.name === item.data));
            const tfEntries = await Promise.all(tableItemsWithFilter.map(async (item) => {
                const targetTable = item.data;
                const rawFilter = item.properties.tabularFilter;
                const resolvedFilter = {};
                for (const [k, v] of Object.entries(rawFilter)) {
                    if (typeof v === 'string') {
                        resolvedFilter[k] = v
                            .replace(/\{UID\}/g, effectiveRecordId || '')
                            .replace(/\{(\w+)\}/g, (_, fn) => (record && record[fn] !== undefined ? record[fn] : ''));
                    } else {
                        resolvedFilter[k] = v;
                    }
                }
                let rows = [];
                if (effectiveRecordId && !isNew) {
                    try {
                        const tblDbGW = require('../../drive_root/dbGateway');
                        const fetched = await tblDbGW.execute({
                            operation: 'read', table: targetTable, where: resolvedFilter,
                            options: { raw: true }, context: { appName: 'uniForm', sessionID }
                        });
                        if (Array.isArray(fetched)) rows = fetched;
                    } catch (e) {
                        console.error('[uniForm/generateFormSpec] tabularFilter load error for', targetTable, ':', e && e.message);
                    }
                } else if (isNew && params && params.prefillTabular && Array.isArray(params.prefillTabular[targetTable])) {
                    // prefillTabular для КАСТОМНЫХ лейаутов («создать на основании»):
                    // новая запись открывается с предзаполненными строками ТЧ — данные
                    // живут только на форме, в БД попадут при сохранении (applyChanges).
                    // Зеркало prefillRows авто-ТЧ выше; UID строк генерируем здесь же,
                    // FK display-значения дорезолвит общий блок ниже (rows.length > 0).
                    try {
                        const globalCtxPT = require('../../drive_root/globalServerContext');
                        const tsModelName = globalCtxPT.getModelNameForTable(targetTable) || targetTable;
                        rows = params.prefillTabular[targetTable].map(r => Object.assign(
                            { UID: (_util && typeof _util.generateUID === 'function') ? _util.generateUID(tsModelName) : undefined },
                            r));
                        registerPrefilledRows(item.data, rows);
                    } catch (e) {
                        console.error('[uniForm/generateFormSpec] tabularFilter prefill error for', targetTable, ':', e && e.message);
                    }
                }
                if (rows.length > 0) {
                    try {
                        const tfFields = await buildTableFieldsFromModel(targetTable);
                        const tfFkFields = Array.isArray(tfFields) ? tfFields.filter(f => f.foreignKey && f.foreignKey.table) : [];
                        await Promise.all(tfFkFields.map(async (fkField) => {
                            const fkTable = fkField.foreignKey.table;
                            const fkIdField = fkField.foreignKey.field || 'UID';
                            const fkDispField = fkField.foreignKey.displayField || 'name';
                            const fkValues = [...new Set(rows.map(r => r[fkField.name]).filter(v => v != null && v !== ''))];
                            if (fkValues.length === 0) return;
                            try {
                                const fkDbGW = require('../../drive_root/dbGateway');
                                const lookupRows = await fkDbGW.execute({
                                    operation: 'read', table: fkTable, where: { [fkIdField]: fkValues },
                                    options: { raw: true }, context: { appName: 'uniForm', sessionID }
                                });
                                if (Array.isArray(lookupRows)) {
                                    const dispMap = {};
                                    for (const lr of lookupRows) dispMap[lr[fkIdField]] = lr[fkDispField] || lr[fkIdField];
                                    const dispKey = '__' + fkField.name + '_display';
                                    for (const row of rows) {
                                        if (row[fkField.name] != null) row[dispKey] = dispMap[row[fkField.name]] || row[fkField.name];
                                    }
                                }
                            } catch (e) {
                                console.warn('[uniForm/generateFormSpec] tabularFilter FK resolve error:', fkField.name, e && e.message);
                            }
                        }));
                    } catch (e) {
                        console.warn('[uniForm/generateFormSpec] tabularFilter FK resolve outer error:', e && e.message);
                    }
                }
                return { name: item.data, value: rows, tabularSection: true, tableName: targetTable };
            }));
            for (const entry of tfEntries) data.push(entry);
        } catch (e) {
            console.error('[uniForm/generateFormSpec] tabularFilter scan error:', e && e.message || e);
        }

        const datasetId = dataApp.storeDataset({
            table: tableName, id: effectiveRecordId, isNew: isNew,
            params: params, time: Date.now()
        });

        if (!formIcon) {
            formIcon = getDefaultIconForTable(tableName, 'record');
        }

        // Заголовок окна записи = подпись в ЕДИНСТВЕННОМ числе (recordCaption) + представление
        // записи (поле name). Для новой записи (name пуст) — только подпись.
        // Fallback на appCaption (множественное), затем на имя таблицы — заголовок никогда
        // не должен остаться родовым «uniForm».
        let resolvedCaption = await resolveAppCaption(recordCaption || appCaption, sessionID);
        // Тот же фолбэк, что и в режиме списка: перевод по ключу = имя таблицы (i18n.json),
        // иначе само имя. Заголовок формы записи совпадает с заголовком формы списка.
        if (!resolvedCaption) resolvedCaption = await tForSession(tableName, sessionID);
        const presentation = (record && record.name != null) ? String(record.name).trim() : '';
        if (presentation) {
            resolvedCaption = resolvedCaption + ' ' + presentation;
        }

        // Форма записи без явного windowState: СУЩНОСТИ (документы/справочники,
        // entityConfig.entityType) по умолчанию разворачиваются на весь экран —
        // это «рабочие» окна уровня ERP (бронь, счёт, прайс-лист). Прочие формы
        // (настройки, простые виртуальные) — по центру экрана с подгонкой размера
        // под контент (DataForm.Draw, windowState:'centered'); иначе при отсутствии
        // хардкода размера/позиции окно оказалось бы 0×0 в углу.
        let finalWindowState = windowState || (getEntityTypeForTable(tableName) ? 'maximized' : 'centered');

        // ── Замок проведённого документа ─────────────────────────────────────
        // Состояние берём из ЗНАЧЕНИЙ ФОРМЫ, а не из записи: у новой записи записи
        // ещё нет, а значение по умолчанию («черновик») уже есть — иначе на новой
        // форме список состояний остался бы полным и «выставлено» выбиралось бы
        // прямо в нём, мимо команды.
        let lock = null;
        try {
            const gCtxLock = require('../../drive_root/globalServerContext');
            const lockModelName = gCtxLock.getModelNameForTable(tableName) || tableName;
            const LockModel = (gCtxLock.modelsDB || {})[lockModelName];
            if (LockModel) {
                const values = {};
                for (const d of data) values[d.name] = d.value;
                lock = require('../../drive_root/db/immutable').describeLock(LockModel, values);
                if (lock) applyLockToLayout(layout, lock);
            }
        } catch (e) {
            console.error('[uniForm/generateFormSpec] lock resolve error:', e && e.message || e);
        }

        // Translate all { i18n: 'key' } objects in layout before sending to client
        if (Array.isArray(layout)) {
            await translateLayoutI18n(layout, sessionID);
        }

        // Клиентские события формы (form-level): доставляем на клиент только те
        // привязки из events, у которых НЕТ serverScript (серверные, напр. onBeforeSave,
        // обрабатываются на сервере и на клиент не отдаются). Напр. onChange — общее
        // событие «форма изменилась», которое DataForm дёргает из setModified.
        let clientEvents = null;
        if (customLayoutObj && customLayoutObj.events) {
            for (const k of Object.keys(customLayoutObj.events)) {
                const b = customLayoutObj.events[k];
                if (b && !b.serverScript) { (clientEvents = clientEvents || {})[k] = b; }
            }
        }

        // Программно заполненные значения — только для НОВОЙ записи (для существующей
        // «изменения» не было). Пустой реестр на клиент не отдаём.
        let prefilled = null;
        if (isNew) {
            const pfFields = [...prefilledFields];
            const hasTabular = Object.keys(prefilledTabular).length > 0;
            if (pfFields.length || hasTabular) {
                prefilled = { fields: pfFields, tabular: prefilledTabular };
            }
        }

        return { data, layout, datasetId, clientScript, formIcon, appCaption: resolvedCaption, windowState: finalWindowState, fkLookups: await fkLookupsPromise, isNew: isNew, events: clientEvents, prefilled, lock };
    } catch (e) {
        console.error('[uniForm/generateFormSpec] failed:', e && e.message || e);
        return { data: [], layout: [] };
    }
}

// ── Google Places config — exposes API key to authorised browser clients ─────────────────────
async function getPlacesConfig(params, sessionID) {
    const user = await globalServerContext.getUserBySessionID(sessionID);
    if (!user) throw new Error('User not authorized');
    return { apiKey: process.env.GOOGLE_PLACES_API_KEY || '' };
}

// ── Quick search for recordSelector typeahead ─────────────────────────────────────────────────
async function quickSearch({ tableName, searchText, limit, displayField: requestedDisplayField }, sessionID) {
    const user = await globalServerContext.getUserBySessionID(sessionID);
    if (!user) throw new Error('User not authorized');

    const modelName = globalServerContext.getModelNameForTable(tableName);
    if (!modelName) throw new Error('Unknown table: ' + tableName);

    const dbGW = require('../../drive_root/dbGateway');
    const { Op } = require('sequelize');

    const safeText = String(searchText || '').replace(/[%_\\]/g, c => '\\' + c);
    const lim = Math.max(1, Math.min(limit || 10, 20));

    // Determine display field:
    //   1) explicit requestedDisplayField (if it's a real STRING attribute — e.g. rooms.number)
    //   2) 'name' if present
    //   3) first STRING attribute that isn't UID/timestamps
    //   4) 'UID' as last resort
    // Note: ILIKE requires a text column, so a requested non-STRING field is ignored.
    const SKIP = new Set(['UID', 'createdAt', 'updatedAt', 'deletedAt']);
    // Honour a requested displayField even if attribute introspection fails.
    let displayField = requestedDisplayField || 'name';
    try {
        const gsCtx = globalServerContext;
        const models = gsCtx.getModels ? gsCtx.getModels() : null;
        const attrs = (models && models[modelName] && models[modelName].rawAttributes) || {};
        const isString = (k) => {
            try {
                const ty = attrs[k] && attrs[k].type;
                const t = String((ty && (ty.key || (ty.constructor && ty.constructor.key))) || '').toUpperCase();
                return t === 'STRING' || t === 'TEXT' || t.indexOf('CHAR') >= 0;
            } catch (e) { return false; }
        };
        if (Object.keys(attrs).length) {
            if (requestedDisplayField && attrs[requestedDisplayField]) {
                displayField = requestedDisplayField;                 // trust the form's display field
            } else if (attrs['name']) {
                displayField = 'name';
            } else {
                displayField = Object.keys(attrs).find(k => !SKIP.has(k) && isString(k))
                    || Object.keys(attrs).find(k => !SKIP.has(k))
                    || 'UID';
            }
        }
    } catch (e) { /* keep requestedDisplayField || 'name' */ }

    const rows = await dbGW.execute({
        operation: 'read',
        table: tableName,
        where: { [displayField]: { [Op.iLike]: `%${safeText}%` } },
        options: {
            attributes: ['UID', displayField],
            limit: lim,
            order: [[displayField, 'ASC']],
            raw: true
        },
        context: { sessionID }
    });

    const items = (Array.isArray(rows) ? rows : []).map(r => ({ UID: r.UID, name: r[displayField] || '' }));
    return { items, displayField };
}

// ── cascadeDeleteChildren ───────────────────────────────────────────────────────────────────
// Каскадное удаление по ОТНОШЕНИЮ ВЛАДЕНИЯ (tabularSection.parentTable/parentField), а НЕ по
// произвольным FK — иначе удаление клиента снесло бы его брони. Удаляет дочерние строки всех
// табличных частей, у которых parentTable = удаляемая таблица, где parentField ∈ parentIds.
// Учитывает межсекционные FK (booking_room_services.bookingRoomId → booking_rooms): таблицы,
// ссылающиеся на «соседей», удаляются ПЕРВЫМИ. Рекурсивно спускается в более глубокие ТЧ.
// ВСЁ выполняется в ОДНОЙ транзакции (ctx.transaction): если хоть одно удаление (или сам
// родитель) упадёт — откатывается весь каскад, осиротевших строк не остаётся. Ошибки НЕ
// глушатся — пробрасываются вверх, чтобы deleteRecord сделал rollback. SSE-уведомления шлёт
// deleteRecord ПОСЛЕ commit (ctx.affected — список затронутых таблиц).
async function cascadeDeleteChildren(tableName, parentIds, sessionID, ctx) {
    if (!Array.isArray(parentIds) || parentIds.length === 0) return;

    let allModels = [];
    try {
        const gCtx = require('../../drive_root/globalServerContext');
        allModels = (gCtx.collectAllModelDefs().models) || [];
    } catch (e) { return; }

    const childDefs = allModels.filter(d =>
        d.tabularSection && d.tabularSection.parentTable === tableName && d.tabularSection.parentField
    );
    if (childDefs.length === 0) return;

    // Порядок: дочерняя таблица, ссылающаяся на другую дочернюю (сосед), удаляется раньше.
    const childTableNames = new Set(childDefs.map(d => d.tableName));
    const hasSiblingFKDeps = (sectName) => {
        const md = allModels.find(m => m.tableName === sectName);
        if (!md || !md.fields) return false;
        return Object.values(md.fields).some(f =>
            f.references && childTableNames.has(f.references.model) && f.references.model !== sectName
        );
    };
    childDefs.sort((a, b) => (hasSiblingFKDeps(b.tableName) ? 1 : 0) - (hasSiblingFKDeps(a.tableName) ? 1 : 0));

    const cdGW = require('../../drive_root/dbGateway');
    const t = ctx.transaction;
    for (const cd of childDefs) {
        const childTable = cd.tableName;
        const pf = cd.tabularSection.parentField;
        const key = childTable + '::' + pf;
        if (ctx.visited.has(key)) continue;
        ctx.visited.add(key);

        // UID дочерних строк нужны для рекурсии в более глубокие ТЧ.
        let childIds = [];
        try {
            const rows = await cdGW.execute({
                operation: 'read', table: childTable, where: { [pf]: parentIds },
                options: { attributes: ['UID'], raw: true, transaction: t }, context: { appName: 'uniForm', sessionID }
            });
            childIds = (rows || []).map(r => r.UID).filter(Boolean);
        } catch (e) { /* нет доступа/строк — пропускаем чтение, удаление ниже всё равно отработает */ }

        if (childIds.length) await cascadeDeleteChildren(childTable, childIds, sessionID, ctx);

        // Ошибку НЕ глушим — пусть всплывёт в deleteRecord для rollback всей транзакции.
        await cdGW.execute({
            operation: 'delete', table: childTable, where: { [pf]: parentIds },
            options: { transaction: t }, context: { appName: 'uniForm', sessionID }
        });
        ctx.affected.add(childTable);
    }
}

// ── deleteRecord ────────────────────────────────────────────────────────────────────────────
// Удаление записи из формы списка (кнопка «Удалить»). Раньше клиент слал в applyChanges
// datasetId объектом { table, id } + changes:{_deleted:true}; applyChanges ждёт строковый
// datasetId (резолв через dataApp.getDataset) и НЕ умеет удалять — запись молча не удалялась.
// Теперь удаление — отдельная операция через dbGateway (RLS соблюдается).
async function deleteRecord(params, sessionID) {
    const tableName = params && (params.tableName || params.table || params.dbTable);
    const recordId  = params && (params.recordId || params.recordID || params.id);
    if (!tableName) return { ok: false, error: await tForSession('no_table_context', sessionID) };
    if (!recordId)  return { ok: false, error: await tForSession('missing_recordId', sessionID) };

    const modelName = globalServerContext.getModelNameForTable(tableName) || tableName;
    const Model = globalServerContext.modelsDB[modelName];
    if (!Model) return { ok: false, error: 'Model not found for table: ' + tableName + ' (model: ' + modelName + ')' };

    const delDbGW = require('../../drive_root/dbGateway');

    // Весь каскад + удаление родителя — в ОДНОЙ транзакции: всё или ничего. Если родитель
    // упрётся в RESTRICT (на него ссылаются чужие записи), уже удалённые дети откатятся.
    const t = await Model.sequelize.transaction();
    const affected = new Set();
    try {
        await cascadeDeleteChildren(tableName, [recordId], sessionID, { visited: new Set(), affected, transaction: t });
        await delDbGW.execute({ operation: 'delete', table: tableName, where: { UID: recordId }, options: { transaction: t }, context: { appName: 'uniForm', sessionID } });
        affected.add(tableName);
        await t.commit();
    } catch (e) {
        try { await t.rollback(); } catch (_) {}
        console.error('[uniForm] deleteRecord error:', e);
        // FK RESTRICT: на запись ссылаются ДРУГИЕ записи (не её ТЧ — те владеет каскад), напр.
        // удаляемый клиент используется в бронях (bookings.clientId → clients). Это не баг,
        // а защита целостности — показываем понятное сообщение вместо сырого SQL-текста.
        if (isForeignKeyError(e)) {
            return { ok: false, error: await tForSession('delete_fk_restricted', sessionID) };
        }
        return { ok: false, error: String(e) };
    }

    // Уведомляем формы списка/выбора ПОСЛЕ commit — иначе refresh прочитал бы ещё не
    // зафиксированные изменения. Шлём по всем затронутым таблицам (родитель + дети).
    for (const tbl of affected) {
        try { dynamicTableMethods.notifyTableChange(tbl, 'delete', null); } catch (e) {}
    }
    return { ok: true, recordId };
}

// Распознаёт нарушение внешнего ключа (PostgreSQL code 23503) сквозь обёртки Sequelize.
function isForeignKeyError(e) {
    if (!e) return false;
    if (e.name === 'SequelizeForeignKeyConstraintError') return true;
    const code = (e.original && e.original.code) || (e.parent && e.parent.code) || e.code;
    if (code === '23503') return true;
    return /foreign key|RESTRICT|23503|внешн|ограничени/i.test(String(e.message || e));
}

// ── getMultiInstanceTables ──────────────────────────────────────────────────────────────────
// Таблицы-исключения для дедупликации окон (см. MySpace._openInternal): по умолчанию одна
// форма списка на таблицу и одна форма записи на запись (UID). Таблица может разрешить
// несколько окон через entityConfig в db.json: allowMultipleListForms / allowMultipleRecordForms.
// Клиент (uniForm/client.js, autoStart) забирает карту в window.MySpaceMultiInstanceTables.
function getMultiInstanceTables() {
    const map = {};
    try {
        const gCtx = require('../../drive_root/globalServerContext');
        const { models } = gCtx.collectAllModelDefs();
        for (const def of (models || [])) {
            const ec = def && def.entityConfig;
            if (!ec) continue;
            const list = !!ec.allowMultipleListForms;
            const record = !!ec.allowMultipleRecordForms;
            if (list || record) map[def.tableName || def.name] = { list, record };
        }
    } catch (e) {
        console.error('[uniForm] getMultiInstanceTables error:', e && e.message || e);
    }
    return map;
}

/**
 * Обновить отдельные поля ОДНОЙ записи по её UID.
 *
 * Нужен редактируемому списку: у него нет формы записи и кнопки «Сохранить», а правка
 * ячейки обязана попадать в базу. Идёт через `dbGateway`, то есть под теми же RLS,
 * хуками и оповещением, что и обычное сохранение, — собственного пути записи у списка
 * быть не должно.
 */
async function updateRow(params, sessionID) {
    const { tableName, recordId, changes } = params || {};
    if (!tableName || !recordId || !changes || typeof changes !== 'object') {
        return { ok: false, error: await tForSession('no_table_context', sessionID) };
    }
    try {
        const dbGW = require('../../drive_root/dbGateway');
        // Правка из списка проходит ТУ ЖЕ проверку, что и сохранение формы: иначе у
        // записи появляется второй путь в базу, мимо контроля прикладного кода
        // (`onBeforeSave` умеет отменить сохранение — напр. контроль дат брони).
        await dispatchServerEvent('onBeforeSave', {
            tableName, record: null, changes, parentUID: recordId, isNew: false
        }, { tableName, sessionID });

        await dbGW.execute({
            operation: 'update', table: tableName,
            where: { UID: recordId }, data: changes,
            context: { sessionID }
        });
        // Списки в других окнах обязаны увидеть правку.
        try { dynamicTableMethods.notifyTableChange(tableName, 'update', recordId); } catch (e) {}
        return { ok: true };
    } catch (e) {
        console.error('[uniForm/updateRow] error:', e && e.message || e);
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

module.exports = {
    getData,
    getLayoutWithData,
    applyChanges,
    updateRow,
    deleteRecord,
    getMultiInstanceTables,
    generateFormSpec,
    // Экспортируется ради самопроверки (tmp/2026-09-03_formlock_selftest.js):
    // копия этой функции в тесте разошлась бы с оригиналом и перестала его проверять.
    applyLockToLayout,
    registerBeforeSaveTSRow,
    quickSearch,
    getPlacesConfig,

    // Dynamic table helpers
    getDynamicTableData: dynamicTableMethods.getDynamicTableData,
    getLookupList: dynamicTableMethods.getLookupList,
    subscribeToTable: dynamicTableMethods.subscribeToTable,
    saveClientState: dynamicTableMethods.saveClientState,
    recordTableEdit: dynamicTableMethods.recordTableEdit,
    commitTableEdits: dynamicTableMethods.commitTableEdits,
    // SSE-оповещение об изменении таблицы — для серверного кода, меняющего данные
    // мимо applyChanges (программное создание/перезаполнение документов): подписанные
    // DynamicTable/relatedList обновятся так же, как после сохранения формы.
    /**
     * Оповестить открытые списки об изменении таблицы.
     *
     * В ПРОЦЕССЕ-ВОРКЕРЕ рассылать некому: SSE-подключения браузеров живут в главном
     * процессе, и вызов здесь просто уходил в пустоту — из-за этого список копий
     * появлялся в форме только после её перезагрузки. Поэтому воркер не рассылает, а
     * ПЕРЕДАЁТ событие главному процессу тем же каналом, что и ход выполнения.
     *
     * Разводка сидит ЗДЕСЬ, в единственной точке, а не у вызывающих: обработчик
     * регламентной задачи пишет один и тот же код независимо от того, где он исполняется.
     */
    notifyTableChange(tableName, action, rowId, rowData = null) {
        if (process.env.MOS_SCHEDULER_WORKER === '1' && typeof process.send === 'function') {
            try { process.send({ type: 'notifyTable', table: tableName, action, rowId: rowId || null }); } catch (e) {}
            return;
        }
        return dynamicTableMethods.notifyTableChange(tableName, action, rowId, rowData);
    }
};
