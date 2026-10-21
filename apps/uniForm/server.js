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
/**
 * Подпись регистра для заголовка окна — из его объявления (`registers.get`).
 * Лейаута у регистра нет (формы строит автогенератор), значит и в реестре
 * подписей его нет; без этого в заголовке стояло бы имя таблицы `reg_cash`.
 */
function getRegisterCaption(tableName) {
    try {
        const registers = require('../../drive_root/db/registers');
        const cfg = registers.get(tableName);
        return (cfg && cfg.caption) || null;
    } catch (e) { return null; }
}

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
 * ДАТА ДОКУМЕНТА — ЭТО МОМЕНТ, и форма показывает его со временем (решение
 * владельца 15.10.2026). Без времени поле прятало часть значения: документ,
 * созданный «сейчас», нёс 21:22, а форма показывала только день — и выбор дня в
 * календаре записывал полночь, которая в журнале читалась как «02:00».
 *
 * Делается здесь, а не в каждом лейауте: дату документу инъецирует ядро
 * (`entityDate`), значит и то, как она выглядит, — его дело. Автор лейаута, явно
 * написавший `properties.showTime`, побеждает. Колонки таблиц не трогаем — у
 * строк табличной части своей даты документа нет.
 */
function applyDocumentDateTime(layout) {
    const visit = (items) => {
        if (!Array.isArray(items)) return;
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            if (item.type === 'date' && item.data === 'date'
                && !(item.properties && item.properties.showTime !== undefined)) {
                const props = Object.assign({}, item.properties, { showTime: true });
                // «02.08.2026 15:30» в ширину голой даты не влезает.
                if (Number(props.width) > 0 && Number(props.width) < 150) props.width = 150;
                item.properties = props;
            }
            if (Array.isArray(item.layout)) visit(item.layout);
            if (Array.isArray(item.tabs)) item.tabs.forEach(t => t && visit(t.layout));
        }
    };
    visit(layout);
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
        // confirm — вопрос перед выполнением команды (кнопка с `command`).
        // Переводится ЗДЕСЬ, а не на клиенте: `__t()` в статических файлах —
        // маркер, заменяемый при выдаче, и с переменной он не работает.
        if (item.confirm && typeof item.confirm === 'object' && item.confirm.i18n) {
            try { item.confirm = await tForSession(item.confirm.i18n, sessionID); }
            catch(e) { item.confirm = item.confirm.i18n; }
        }
        // `enabledWhen.reason` — причина отказа у недоступной команды. Та же природа,
        // что у `confirm`: текст элемента, который клиент показывает как есть, значит
        // переводится здесь. Маркер `__t()` в статическом файле с переменной не работает.
        if (item.enabledWhen && typeof item.enabledWhen === 'object'
            && item.enabledWhen.reason && typeof item.enabledWhen.reason === 'object'
            && item.enabledWhen.reason.i18n) {
            try { item.enabledWhen.reason = await tForSession(item.enabledWhen.reason.i18n, sessionID); }
            catch(e) { item.enabledWhen.reason = item.enabledWhen.reason.i18n; }
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
 * Клиентские события формы (form-level) из её регистрации.
 *
 * Серверных событий здесь нет вовсе: событие — это МЕТОД ФОРМЫ с условленным
 * именем (`drive_root/formMethods.js`), и лейаут про серверную логику не знает.
 * Клиентские (`onReady`, `onChange`, `onPostingFinished`) объявлены рядом с
 * клиентским скриптом и принадлежат ФОРМЕ, а не представлению: переключение вида
 * их не теряет.
 *
 * Функция общая на все ветки ответа намеренно: ветка формы с собственным
 * `onLoadData` события просто не возвращала, и любое `onReady` в такой форме молча
 * не срабатывало (форма настроек: селекторы уровней не прятались, кнопка смены
 * пароля не гасла). Пока фильтр был написан в одном месте из двух, разойтись они
 * могли только так.
 */
function clientEventsOf(registration) {
    const ev = registration && registration.clientEvents;
    if (!ev || typeof ev !== 'object') return null;
    let out = null;
    for (const k of Object.keys(ev)) {
        const b = ev[k];
        if (!b) continue;
        // Короткая запись `onReady: 'onFormReady'` и полная `{ fn: '…' }` — одно и то же.
        (out = out || {})[k] = (typeof b === 'string') ? { fn: b } : b;
    }
    return out;
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

// ── АДРЕС ФОРМЫ ──────────────────────────────────────────────────────────────────────────────
//
// Форма ищется по адресу `приложение | имя формы | роль | представление`, а не по
// имени таблицы. Имя ТАБЛИЧНОЙ формы выводится из предмета одной функцией на весь
// фреймворк (`drive_root/formAddress.js`) — той же, которой пользуется регистрация.
// Приложение-владельца по табличному имени знает реестр: имя выведено из предмета и
// потому уникально (одна таблица — одна форма записи и один журнал).
const formAddress = require('../../drive_root/formAddress');
const formMethods = require('../../drive_root/formMethods');

/**
 * Адрес формы ТАБЛИЦЫ: { app, form } или null, если приложение её не регистрировало
 * (тогда форму строит автогенератор — это по-прежнему нормальный, а не особый случай).
 * Синхронно: горячий путь открытия любой формы.
 */
function subjectAddress(mode, tableName) {
    if (!tableName) return null;
    const layoutMemory = require('../../drive_root/layoutMemory');
    const form = formAddress.forSubject(mode, tableName);
    const app = layoutMemory.ownerOfSubjectForm(form);
    if (!app) return null;
    return { app, form };
}

/**
 * Регистрация формы ТАБЛИЦЫ для этого пользователя (лейаут + свойства формы),
 * либо null, если такой формы никто не объявлял.
 */
async function findCustomLayout(mode, tableName, sessionID, variant) {
    try {
        const addr = subjectAddress(mode, tableName);
        if (!addr) return null;
        const layoutMemory = require('../../drive_root/layoutMemory');
        const userRole = await layoutMemory.getUserRoleBySession(sessionID);
        return await layoutMemory.getLayoutForUser(addr.app, addr.form, userRole, sessionID, variant);
    } catch(e) {
        console.error('[uniForm/findCustomLayout] error:', e && e.message || e);
    }
    return null;
}

/**
 * Вызвать МЕТОД ФОРМЫ (он же её серверное событие) — одна точка на весь модуль.
 *
 * Возвращает `{ called: false }`, когда метода нет: у формы может не быть ни
 * `onLoadData`, ни `onSave`, и это не ошибка. Ошибку обработчика НЕ глотаем —
 * `onBeforeSave` обязан уметь отменить сохранение.
 *
 * @param {object} o
 * @param {string} o.app
 * @param {string} o.form
 * @param {string} o.method
 * @param {*}      o.payload
 * @param {string} o.sessionID
 * @param {string} [o.userRole]
 */
async function callFormMethod({ app, form, method, payload, sessionID, userRole }) {
    if (!app || !form) return { called: false, result: null };
    const layoutMemory = require('../../drive_root/layoutMemory');
    const role = userRole || await layoutMemory.getUserRoleBySession(sessionID);
    const fn = formMethods.resolve({ app, form, method, userRole: role || '*' });
    if (typeof fn !== 'function') return { called: false, result: null };
    const result = await fn(payload, await buildEventContext(sessionID, role));
    return { called: true, result };
}

function getData(params) {
    return [];
}

/**
 * Режим списка: явный `mode: 'list'` либо `dbTable` без записи.
 * У ИМЕНОВАННОЙ формы режима нет вовсе — она не список и не запись, она своя.
 */
function isListMode(params) {
    if (!params) return false;
    if (params.form) return false;
    return params.mode === 'list'
        || (!params.mode && !!(params.dbTable && !params.recordID && !params.recordId && !params.id));
}

/**
 * АДРЕС открываемой формы из параметров открытия.
 *
 * Два способа открыть форму, и они не смешиваются:
 *   { dbTable | tableName, mode?, recordID? }  — форма ТАБЛИЦЫ, адрес выводится из предмета
 *   { app, form, params? }                     — ИМЕНОВАННАЯ форма приложения
 *
 * Возвращает null, когда таблица открыта без зарегистрированной формы (её построит
 * автогенератор) или когда параметров не хватает.
 */
function addressOf(params) {
    if (!params) return null;
    if (params.form) {
        if (!params.app) return null;
        return { app: params.app, form: params.form };
    }
    const tableName = params.tableName || params.dbTable || params.table;
    if (!tableName) return null;
    return subjectAddress(isListMode(params) ? 'list' : 'record', tableName);
}

/**
 * Адрес формы, из которой пришёл датасет. Записан в датасет при сборке формы,
 * поэтому не зависит ни от выбранного представления, ни от угадывания по таблице.
 * Фолбэк на предмет — для датасетов, собранных автогенератором (своей формы нет).
 */
function datasetAddress(dsObj, tableName) {
    if (dsObj && dsObj.formApp && dsObj.formName) return { app: dsObj.formApp, form: dsObj.formName };
    if (tableName) return subjectAddress('record', tableName);
    return null;
}

// ── getLayoutWithData ─────────────────────────────────────────────────────────────────────────
//
// ПРЕДСТАВЛЕНИЯ. Форме можно зарегистрировать несколько лейаутов (`variant` в
// saveLayout); какой показать — приезжает в `params.view`. Список доступных
// пользователю прикладывается к ответу ОДНИМ местом, обёрткой ниже: ветвей
// возврата у сборки несколько (список свой, автосписок свой, запись своя), и
// дописывать поле в каждую значит однажды забыть про одну.
async function getLayoutWithData(params, sessionID) {
    const spec = await buildLayoutWithData(params, sessionID);
    if (!spec || typeof spec !== 'object') return spec;
    try {
        const addr = addressOf(params);
        if (!addr) return spec;
        const layoutMemory = require('../../drive_root/layoutMemory');
        const userRole = await layoutMemory.getUserRoleBySession(sessionID);
        const views = await layoutMemory.listViewsForUser(addr.app, addr.form, userRole, sessionID);
        if (views.length) {
            spec.views = views;
            // Текущее: запрошенное, иначе основное. Клиент рисует его на кнопке.
            const requested = params && params.view;
            const current = views.find(v => v.variant === requested) || views.find(v => v.isDefault) || views[0];
            spec.view = current.variant;
        }
    } catch (e) {
        console.error('[uniForm/getLayoutWithData] views error:', e && e.message || e);
    }
    return spec;
}

async function buildLayoutWithData(params, sessionID) {
    try {
        const tableName = params && (params.tableName || params.dbTable || params.table);

        // ── ИМЕНОВАННАЯ ФОРМА ПРИЛОЖЕНИЯ ────────────────────────────────────────────────────
        // Своё окно приложения: адрес есть, предмета может не быть. Лейаута нет —
        // ОШИБКА, а не автоформа: строить не из чего.
        if (params && params.form) {
            return await buildNamedForm(params, sessionID);
        }

        // ── РЕЖИМ СПИСКА: явный mode:'list', либо params.dbTable без recordID ─────────────────
        if (isListMode(params)) {
            const customLayout = await findCustomLayout('list', tableName, sessionID, params && params.view);

            // ПУСТОЙ ЛЕЙАУТ = «кастомного лейаута нет» — так же, как в режиме
            // записи (см. ту же проверку перед `if (!layout)` ниже). Раньше здесь
            // стоял просто `if (customLayout)`, и одно и то же объявление значило
            // в двух режимах ПРОТИВОПОЛОЖНОЕ: форма записи с пустым лейаутом
            // давала автоформу, а журнал с пустым лейаутом — ПУСТОЕ ОКНО.
            // Без колонок, без тулбара, без ошибки
            // в консоли: журнал просто не открывался, и выглядело это как «нет
            // записей». Так в приложении денежных документов оказались недоступны
            // справочник видов операции (то есть данные, которые решают, чем
            // становится каждый платёж) и проверочный документ каскада.
            //
            // Подпись и значок при этом не теряются: ветка автогенерации ниже
            // берёт их из `layoutMemory` (`getTableCaption`, `getTableListIcon`
            // внутри `getDefaultIconForTable`) — то есть ровно из того же
            // `saveLayout`. Поэтому регистрация «только ради заголовка и иконки»
            // продолжает работать, и именно так её и объявляют приложения.
            const hasCustomList = !!customLayout
                && !(Array.isArray(customLayout.layout) && customLayout.layout.length === 0);

            if (hasCustomList) {
                const clLayout = JSON.parse(JSON.stringify(customLayout.layout || customLayout));

                // Если лейаут имеет onLoadData — вызываем его (как в record-режиме),
                // чтобы виртуальные/синтетические списки могли наполнить данные.
                let listData = [];
                try {
                    const { called, result } = await callFormMethod({
                        app: customLayout.app, form: customLayout.formName, method: 'onLoadData',
                        payload: { tableName, form: customLayout.formName, params }, sessionID
                    });
                    if (called) {
                        listData = normalizeLoadedData(result && result.data, 'list');
                        if (result && result.caption && Array.isArray(clLayout) && clLayout[0]) {
                            clLayout[0].caption = result.caption;
                        }
                    }
                } catch (e) {
                    console.error('[uniForm/getLayoutWithData] list onLoadData error:', e && e.message || e);
                }

                // Журнал — список чужих записей: «ОК»/«Сохранить»/«Отменить» ему
                // не нужны, правки идут в форме записи. Правим КОПИЮ (`clLayout`),
                // которая и уедет клиенту, и делаем это ДО `storeDataset`: он
                // кладёт в хранилище глубокую копию, и всё, что изменено после
                // него, до клиента не доезжает.
                suppressStandardButtons(clLayout);
                const payload = { layout: clLayout, data: listData, params: params || {},
                                  formApp: customLayout.app, formName: customLayout.formName };
                const datasetId = dataApp.storeDataset(payload);
                const resolvedCaption = await resolveAppCaption(customLayout.appCaption, sessionID);
                // Translate all { i18n: 'key' } objects in list layout
                if (Array.isArray(clLayout)) {
                    await translateLayoutI18n(clLayout, sessionID);
                }
                return {
                    layout: clLayout, data: listData, datasetId,
                    clientScript: customLayout.clientScript || null,
                    events: clientEventsOf(customLayout),
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
                // Подписи у списка нет: её место занимает заголовок окна, а имя
                // таблицы в ней стояло бы служебным словом над данными.
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

            // РЕГИСТР: строк не добавляют и не удаляют — их пишет только
            // проведение. Кнопки, которых сервер всё равно не пустит, с панели
            // убираем: кнопка, обещающая отказ, хуже отсутствующей. И порядок по
            // умолчанию у движений — свежие сверху, а не по имени.
            try {
                const registerForms = require('../../drive_root/db/registerForms');
                if (registerForms.isRegisterTable(tableName)) {
                    layout[0].properties.hiddenButtons = ['recordAdd', 'recordDelete'];
                    layout[0].properties.initialSort = [{ field: 'period', order: 'desc' }];
                }
            } catch (e) { /* не регистр */ }
            const payload = { layout, data: [], params: params || {} };
            const datasetId = dataApp.storeDataset(payload);
            const formIcon = getDefaultIconForTable(tableName, 'list');
            const layoutMemory2 = require('../../drive_root/layoutMemory');
            let journalCaption = null;
            try {
                const jcfg = require('../../drive_root/db/journals').get(tableName);
                journalCaption = jcfg && jcfg.caption;
            } catch (e) { /* журналов нет */ }
            const rawCaption = layoutMemory2.getTableCaption(tableName)
                || getRegisterCaption(tableName) || journalCaption;
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
                // Форма БЕЗ ПРЕДМЕТА пересобирается по своему адресу: таблицы, по
                // которой её можно было бы найти, у неё нет. Без этой ветки после
                // сохранения она получала бы ПУСТОЙ ответ и новый пустой датасет —
                // то есть теряла бы и данные, и собственный адрес, и следующее
                // сохранение отвечало бы «нет контекста таблицы».
                if (dsObj && !dsObj.table && dsObj.formApp && dsObj.formName) {
                    return await buildNamedForm(Object.assign({}, dsObj.params || {}, {
                        app: dsObj.formApp, form: dsObj.formName,
                        current: (params.current && typeof params.current === 'object') ? params.current : null
                    }), sessionID);
                }
                if (dsObj && dsObj.table) {
                    const resolvedParams = Object.assign({}, dsObj.params || {}, {
                        tableName: dsObj.table,
                        recordID:  dsObj.id || undefined
                    });
                    const spec = await generateFormSpec(resolvedParams.tableName, resolvedParams, sessionID);
                    return { layout: spec.layout, data: spec.data, datasetId: spec.datasetId,
                             clientScript: spec.clientScript || null, formIcon: spec.formIcon || null, appCaption: spec.appCaption || null, windowState: spec.windowState || null, fkLookups: spec.fkLookups || null, isNew: !!spec.isNew, events: spec.events || null, prefilled: spec.prefilled || null, lock: spec.lock || null, rowTones: spec.rowTones || null, postingState: spec.postingState || null, postingCaptions: spec.postingCaptions || null, postingCanUnpost: !!spec.postingCanUnpost, postingMode: spec.postingMode || null, alerts: spec.alerts || null, formAttributes: spec.formAttributes || null, formApp: spec.formApp || null, formName: spec.formName || null, isRecordForm: !!spec.isRecordForm };
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
                return { layout: spec.layout, data: spec.data, datasetId, clientScript: spec.clientScript || null, formIcon: spec.formIcon || null, appCaption: spec.appCaption || null, windowState: spec.windowState || null, fkLookups: spec.fkLookups || null, isNew: !!spec.isNew, events: spec.events || null, prefilled: spec.prefilled || null, lock: spec.lock || null, rowTones: spec.rowTones || null, postingState: spec.postingState || null, postingCaptions: spec.postingCaptions || null, postingCanUnpost: !!spec.postingCanUnpost, postingMode: spec.postingMode || null, alerts: spec.alerts || null, formAttributes: spec.formAttributes || null, formApp: spec.formApp || null, formName: spec.formName || null, isRecordForm: !!spec.isRecordForm };
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

// ── РЕКВИЗИТЫ ФОРМЫ ───────────────────────────────────────────────────────────────────────────
//
// Данные, которые живут ТОЛЬКО в форме и в базу не попадают никогда (как реквизиты
// формы против реквизитов объекта в классических учётных системах). Диалогу аванса
// это «сумма» и «дата»: таких колонок нет ни в одной таблице, и заводить их ради
// окна — ровно та подмена адреса предметом, от которой эта работа и избавляется.
//
// РАЗЛИЧЕНИЕ поля записи и поля формы — явное, и спутать их нельзя:
//
//   у формы БЕЗ предмета полей записи не существует вовсе → всё, что пишет в
//     `_dataMap` (узел с `data`), это реквизит формы;
//   у формы С предметом реквизит объявляется ЯВНО — `"attribute": true` в узле
//     лейаута; без этой пометки поле относится к записи.
//
// Тип, подпись и значение по умолчанию объявлены там же, в узле: тип контрола
// (`type`), `caption`, `default`, `required`. Второго объявления нет.
function collectFormAttributes(layout, { allFields }) {
    const out = [];
    const seen = new Set();
    // ПОДПИСЬ поля бывает пустой намеренно: когда несколько контролов стоят в
    // группе под одной подписью («Предоплата: [поле] [кнопка]»), подпись носит
    // группа, а у поля `caption: ""`. Для реквизита формы это важно — его подпись
    // уходит человеку в сообщении «Заполните: …», и техническое имя колонки там
    // ему ничего не скажет. Поэтому пустая подпись наследуется от ближайшей
    // группы, у которой она есть.
    const walk = (nodes, inheritedCaption) => {
        if (!Array.isArray(nodes)) return;
        for (const node of nodes) {
            if (!node || typeof node !== 'object') continue;
            const key = node.data || node.name;
            const isAttr = allFields ? !!node.data : (node.attribute === true);
            if (isAttr && key && !seen.has(key)) {
                seen.add(key);
                out.push({
                    name: key,
                    type: node.type || 'textbox',
                    caption: node.caption || inheritedCaption || null,
                    required: !!node.required,
                    default: Object.prototype.hasOwnProperty.call(node, 'default') ? node.default : null
                });
            }
            // Внутрь КОЛОНОК и КНОПОК не спускаемся: колонка таблицы — не поле
            // формы, а её `data` это имя поля СТРОКИ. Сама таблица при этом полем
            // формы является: её `data` — ключ в `_dataMap`, и он собран выше.
            const ownCaption = (node.type === 'group' && node.caption) ? node.caption : inheritedCaption;
            for (const branch of ['layout', 'tabs']) {
                if (Array.isArray(node[branch])) walk(node[branch], ownCaption);
            }
        }
    };
    walk(layout, null);
    return out;
}

/** Стартовые значения реквизитов формы: объявленные умолчания. */
function attributeData(attributes) {
    return attributes.map(a => ({ name: a.name, value: a.default, tabularSection: false }));
}

/**
 * Объявление реквизитов для клиента: подписи резолвим здесь, а не полагаемся на
 * перевод лейаута. Подпись нужна в сообщении «Заполните: сумма, дата», а оно
 * собирается из объявления, а не из DOM.
 */
async function describeAttributes(attributes, sessionID) {
    if (!attributes.length) return null;
    const out = [];
    for (const a of attributes) {
        out.push({
            name: a.name,
            // Тип нужен клиенту не для показа, а для проверки «заполнено ли»:
            // у даты пустое значение — `0001-01-01`, а не NULL, и проверяется оно
            // своим способом. Прогонять через него строку или число нельзя —
            // «не дата» и «не заполнено» это разные ответы.
            type: a.type,
            required: a.required,
            caption: (await resolveAppCaption(a.caption, sessionID)) || a.name
        });
    }
    return out;
}

// ── ИМЕНОВАННАЯ ФОРМА ПРИЛОЖЕНИЯ ──────────────────────────────────────────────────────────────
/**
 * Своё окно приложения: что-то заполнить, что-то выполнить, закрыть.
 *
 * Адрес — `приложение | имя формы`; ПРЕДМЕТА может не быть вовсе, и тогда нет ни
 * сохранения, ни замка неизменности, ни команд документа, ни звёздочки
 * «есть несохранённое». Это следует из ОТСУТСТВИЯ ПРЕДМЕТА, а не из отдельного
 * объявления: два признака одного факта однажды разошлись бы.
 *
 * Лейаут не зарегистрирован → ВНЯТНАЯ ОШИБКА, а не пустое окно и не автоформа:
 * строить автоформу не из чего — модели у такой формы нет.
 */
async function buildNamedForm(params, sessionID) {
    const app = params.app;
    const form = params.form;
    const openParams = (params.params && typeof params.params === 'object') ? params.params : {};
    const layoutMemory = require('../../drive_root/layoutMemory');

    if (!app) {
        return { layout: [], data: [], datasetId: null,
                 error: await tfForSession('form_named_no_app', sessionID, { form }) };
    }

    const meta = layoutMemory.getFormMeta(app, form);
    if (!meta) {
        console.error(`[uniForm] форма «${form}» приложения «${app}» не зарегистрирована. ${formMethods.describe({ app, form })}`);
        return { layout: [], data: [], datasetId: null,
                 error: await tfForSession('form_not_registered', sessionID, { app, form }) };
    }

    // ИМЕНОВАННАЯ ФОРМА С ПРЕДМЕТОМ ведёт себя как форма записи — просто найдена по
    // имени, а не по таблице. Это законный случай: обработка над конкретным
    // справочником остаётся формой своей записи.
    if (meta.subject && meta.subject.kind === 'record') {
        const recordID = openParams.recordID || openParams.recordId || openParams.id;
        return await buildLayoutWithData(
            Object.assign({}, openParams, { tableName: meta.subject.table, recordID, view: params.view }),
            sessionID
        );
    }
    if (meta.subject && meta.subject.kind === 'list') {
        return await buildLayoutWithData(
            Object.assign({}, openParams, { dbTable: meta.subject.table, mode: 'list', view: params.view }),
            sessionID
        );
    }

    const userRole = await layoutMemory.getUserRoleBySession(sessionID);
    const registration = await layoutMemory.getLayoutForUser(app, form, userRole, sessionID, params.view);
    if (!registration) {
        return { layout: [], data: [], datasetId: null,
                 error: await tfForSession('form_not_available', sessionID, { app, form }) };
    }

    let layout = JSON.parse(JSON.stringify(registration.layout || []));
    let data = [];
    let caption = null;

    // onLoadData — метод формы. Кроме данных он вправе вернуть и ЛЕЙАУТ: есть формы,
    // вид которых зависит от параметров открытия (экран движений документа рисует
    // вкладку на каждый регистр, которых у разных документов разное число).
    // Объявить такой лейаут заранее нечем, а выдумывать ради него второй механизм —
    // значит строить рядом то, что уже есть.
    try {
        const { called, result } = await callFormMethod({
            app, form, method: 'onLoadData',
            // `current` — что было на форме, когда её перечитывают после сохранения
            // (null при открытии). Без него форма возвращалась к параметрам открытия.
            payload: { form, params: openParams, current: params.current || null }, sessionID, userRole
        });
        if (called && result) {
            if (Array.isArray(result.layout)) layout = JSON.parse(JSON.stringify(result.layout));
            data = normalizeLoadedData(result.data, 'namedForm');
            if (result.caption) caption = result.caption;
        }
    } catch (e) {
        console.error(`[uniForm] onLoadData формы ${app}/${form}:`, e && e.message || e);
        return { layout: [], data: [], datasetId: null, error: e && e.message ? e.message : String(e) };
    }

    // Стандартных «ОК»/«Сохранить»/«Отменить» у формы без предмета нет: записи,
    // которую они сохраняли бы, не существует. Кнопки объявляет приложение
    // («Выполнить», «Закрыть»).
    //
    // ИСКЛЮЧЕНИЕ, и оно выведено из ФАКТА, а не объявлено вторым флагом: форма
    // может сохранять СВОИМ методом `onSave` — так устроены экраны настроек и
    // резервного копирования, которые собирают данные из нескольких источников и
    // записывают их сами. Наличие метода и есть заявление «я сохраняю»; второе
    // объявление рядом с ним однажды разошлось бы с первым.
    //
    // Обратная сторона так же важна: форма БЕЗ `onSave` (обработка, диалог, экран
    // движений) кнопок не получает вовсе — раньше они на ней стояли и на нажатие
    // отвечали отказом «модель не найдена». Кнопка, обещающая действие и дающая
    // ошибку, хуже отсутствующей.
    const savesItself = !!formMethods.resolve({ app, form, method: 'onSave', userRole: userRole || '*' });
    if (!savesItself) suppressStandardButtons(layout);

    // Реквизиты формы: у формы без предмета полей записи нет, поэтому реквизит —
    // всё, что пишет в `_dataMap`.
    const attributes = collectFormAttributes(layout, { allFields: true });
    if (!data.length) data = attributeData(attributes);
    else {
        // onLoadData мог заполнить не все — недостающие берут объявленное умолчание.
        const filled = new Set(data.map(d => d && d.name));
        for (const entry of attributeData(attributes)) if (!filled.has(entry.name)) data.push(entry);
    }

    const datasetId = dataApp.storeDataset({
        layout, data, params: params || {},
        formApp: app, formName: form,
        formAttributes: attributes.map(a => a.name)
    });
    const attributeDecls = await describeAttributes(attributes, sessionID);

    const fkLookups = await buildFkLookups(layout, sessionID);
    await translateLayoutI18n(layout, sessionID);
    const resolvedCaption = caption
        || (await resolveAppCaption(registration.recordCaption || registration.appCaption, sessionID))
        || form;

    return {
        layout, data, datasetId,
        formApp: app, formName: form,
        formAttributes: attributeDecls,
        clientScript: registration.clientScript || null,
        events: clientEventsOf(registration),
        formIcon: registration.formIcon || null,
        appCaption: resolvedCaption,
        windowState: registration.windowState || 'centered',
        fkLookups,
        // Нет предмета — нет ни записи, ни замка, ни проведения. Звёздочка
        // «есть несохранённое» есть ровно у той формы, которой есть что сохранять,
        // то есть у той, что объявила `onSave`.
        isNew: false, prefilled: null, lock: null, rowTones: null,
        postingState: null, postingCaptions: null, isRecordForm: savesItself
    };
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
    // НАРУШЕНИЕ УНИКАЛЬНОСТИ (16.10.2026): текст базы на языке СЕРВЕРА БД («повторяющееся
    // значение ключа нарушает ограничение уникальности "bookings_pkey"») уходил
    // пользователю как есть — по-русски в немецком интерфейсе. Код ошибки PostgreSQL
    // 23505 одинаков на любом языке сервера.
    try {
        const code = (err && (err.original && err.original.code || err.parent && err.parent.code || err.code)) || '';
        if (code === '23505' || (err && err.name === 'SequelizeUniqueConstraintError')) {
            return await tForSession('record_save_duplicate', sessionID);
        }
    } catch (e) { /* дальше — общий разбор */ }
    try {
        let paths = [];
        // НЕВЕРНОЕ ЗНАЧЕНИЕ (валидатор поля: `isEmail` и т.п., 18.10.2026): Sequelize
        // отдаёт «Validation isEmail on email failed» — тот же английский технический
        // текст с именем колонки. Называем поле его подписью.
        let invalid = [];
        if (err && Array.isArray(err.errors)) {
            paths = err.errors
                .filter(it => it && it.path && (it.type === 'notNull Violation' || it.validatorKey === 'is_null'))
                .map(it => it.path);
            invalid = err.errors
                .filter(it => it && it.path && it.type === 'Validation error' && it.validatorKey !== 'is_null')
                .map(it => it.path);
        }
        if (!paths.length) {
            // Ошибка могла прийти уже «расплющенной» в строку (перезаворачивание слоями).
            const re = /notNull Violation:\s*\S+?\.(\w+)\s+cannot be null/g;
            let m;
            while ((m = re.exec(raw)) !== null) paths.push(m[1]);
        }
        if (!paths.length && !invalid.length) {
            const re = /Validation \w+ on (\w+) failed/g;
            let m;
            while ((m = re.exec(raw)) !== null) invalid.push(m[1]);
        }
        if (!paths.length && !invalid.length) return raw;

        let fields = {};
        try {
            const gCtx = require('../../drive_root/globalServerContext');
            const def = (gCtx.collectAllModelDefs().models || []).find(m => m.tableName === tableName);
            fields = (def && def.fields) || {};
        } catch (e) {}

        const labelsOf = async (list) => {
            const labels = [];
            for (const p of [...new Set(list)]) {
                const cap = fields[p] && fields[p].caption;
                let label = p;
                if (cap && typeof cap === 'object' && cap.i18n) label = await tForSession(cap.i18n, sessionID);
                else if (typeof cap === 'string' && cap) label = cap;
                if (labels.indexOf(label) < 0) labels.push(label);
            }
            return labels.join(', ');
        };
        if (!paths.length) return await tfForSession('invalid_field_values', sessionID, { fields: await labelsOf(invalid) });
        return await tfForSession('required_fields_missing', sessionID, { fields: await labelsOf(paths) });
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

        // ── ФОРМА БЕЗ ПРЕДМЕТА, сохраняющая СВОИМ методом ─────────────────────────
        // Экраны настроек и резервного копирования собирают данные из нескольких
        // источников и записывают их сами. Таблицы у них нет и быть не может, но
        // сохранение есть — и до проверки «есть ли таблица» оно обязано дойти:
        // иначе «Сохранить» на форме настроек отвечает «нет контекста таблицы».
        if (!tableName && dsObj.formApp && dsObj.formName) {
            const { called, result } = await callFormMethod({
                app: dsObj.formApp, form: dsObj.formName, method: 'onSave',
                payload: { changes, form: dsObj.formName, params: (dsObj.params && dsObj.params.params) || {} },
                sessionID
            });
            if (called) return result || { ok: true };
        }

        if (!tableName) {
            return { ok: false, error: await tForSession('no_table_context', sessionID) };
        }
        errTableName = tableName; // нужен в catch для подписей полей в тексте ошибки

        // ── РЕКВИЗИТЫ ФОРМЫ в базу не попадают НИКОГДА ────────────────────────────
        // Их значения живут только в форме и уходят в её серверный метод. Клиент их
        // и так не присылает (DataForm.collectData их отсекает), но здесь стоит
        // вторая проверка: сохранение — путь в базу, и «наверное, клиент не пришлёт»
        // для него не довод. Молча не выбрасываем — называем в журнале.
        if (changes && Array.isArray(dsObj.formAttributes) && dsObj.formAttributes.length) {
            for (const a of dsObj.formAttributes) {
                if (Object.prototype.hasOwnProperty.call(changes, a)) {
                    delete changes[a];
                    console.warn(`[uniForm] applyChanges: реквизит формы «${a}» пришёл в изменениях записи ${tableName} и отброшен — в базу реквизиты формы не пишутся`);
                }
            }
        }

        // ── onSave: МЕТОД ФОРМЫ (EAV и другие виртуальные таблицы) ─────────────────
        // Адрес формы приехал вместе с датасетом — он известен точно и не зависит
        // от того, какое представление сейчас выбрано. Метод формы и есть событие.
        try {
            const addr = datasetAddress(dsObj, tableName);
            if (addr) {
                const { called, result } = await callFormMethod({
                    app: addr.app, form: addr.form, method: 'onSave',
                    payload: { changes, tableName, form: addr.form }, sessionID
                });
                if (called) return result || { ok: true };
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
        const isNewRecord = !recordId || !!dsObj.isNew;

        // Встречный документ, открытый командой «Сторнировать»/«Скорректировать»
        // (drive_root/db/storno.js): форма пришла несохранённой, и природа документа
        // лежит в параметрах её открытия. Проверяется ЗАНОВО до всего остального —
        // между открытием и сохранением исходный документ могли уже сторнировать.
        // Только у НОВОЙ записи: у сохранённой ссылка уже в базе.
        let counter = null;
        if (isNewRecord && dsObj.params && dsObj.params.counterOf) {
            counter = await require('../../drive_root/db/storno').verifyCounter({
                table: tableName, counterOf: dsObj.params.counterOf, sessionID,
                t: (key) => tForSession(key, sessionID)
            });
        }

        // Документ-коррекция: собственная строковая часть — это РАЗНИЦА между
        // «как должно быть» (что правит пользователь) и уже выставленным.
        // Считает ядро, ДО прикладного onBeforeSave: приложение дальше работает
        // с готовыми строками, как с любыми другими (drive_root/db/difference.js).
        try {
            const difference = require('../../drive_root/db/difference');
            await difference.recalcOnSave({
                globalCtx: require('../../drive_root/globalServerContext'),
                table: tableName, changes,
                tabularSections: tabularSectionsData, parentUID, sessionID,
                counterOf: counter ? { kind: counter.kind, sourceUID: counter.sourceUID } : null
            });
        } catch (e) {
            console.error('[uniForm] difference recalc:', e && e.message || e);
            throw e;   // молча выставить коррекцию с неверной разницей нельзя
        }

        await dispatchServerEvent('onBeforeSave', {
            tableName,
            record:          null,
            changes,
            tabularSections: tabularSectionsData || {},
            parentUID,
            isNew:           isNewRecord,
            // Проверенная природа нового встречного документа — приложению для правил,
            // зависящих от знака (сумма сторно отрицательна). null у обычной записи.
            counterOf:       counter ? { kind: counter.kind, sourceUID: counter.sourceUID } : null
        }, { tableName, sessionID, formApp: dsObj.formApp, formName: dsObj.formName });

        // Ссылку и вид ставит ядро ПОСЛЕ прикладного обработчика: приложение вправе
        // вычищать эти поля из присланного формой (с формы им не верят).
        if (counter) require('../../drive_root/db/storno').stampCounter(changes, counter);

        if (recordId && !dsObj.isNew) {
            console.log(`[uniForm] Updating ${tableName} UID=${recordId} with`, changes);
            await applyDbGW.execute({ operation: 'update', table: tableName, data: changes, where: { UID: recordId }, context: { appName: 'uniForm', sessionID, deferPosting: true } });
        } else {
            if (dsObj.isNew && recordId && !changes.UID) {
                changes = Object.assign({}, changes, { UID: recordId });
            }
            console.log(`[uniForm] Creating new ${tableName} with`, changes);
            await applyDbGW.execute({ operation: 'create', table: tableName, data: changes, context: { appName: 'uniForm', sessionID, deferPosting: true } });
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

                    // ПОЛЯ ДОСТУПА — ОТ РОДИТЕЛЯ (16.10.2026). Строке табличной части нужна
                    // своя организация (валидатор RLS требует поле доступа у каждой
                    // таблицы), а взять её ей неоткуда, кроме записи-владельца. Раньше это
                    // делал хук каждой формы сам (бронь, прайс-лист, сезон), и форма без
                    // такого хука — услуга с разделением НДС — не сохраняла строки вовсе.
                    // Наследуются одноимённые ссылки на ту же таблицу, только если строка
                    // своё значение не принесла.
                    const parentModelDef = allModelDefs.find(m => m.tableName === tableName);
                    const parentFields = (parentModelDef && parentModelDef.fields) || {};
                    const inheritable = Object.keys(sectFields).filter(fn =>
                        fn !== parentField && sectFields[fn] && sectFields[fn].references &&
                        parentFields[fn] && parentFields[fn].references &&
                        parentFields[fn].references.model === sectFields[fn].references.model);
                    let parentValues = null;
                    if (inheritable.length) {
                        try {
                            const pr = await applyDbGW.execute({
                                operation: 'read', table: tableName, where: { UID: parentUID },
                                options: { raw: true, limit: 1 }, context: { appName: 'uniForm', sessionID }
                            });
                            parentValues = pr && pr[0] || null;
                        } catch (e) { parentValues = null; }
                    }

                    if (Array.isArray(rows)) {
                        for (let ri = 0; ri < rows.length; ri++) {
                            const row = rows[ri];
                            const rowData = Object.assign({}, row);
                            rowData[parentField] = parentUID;
                            if (parentValues) {
                                for (const fn of inheritable) {
                                    if (emptyValues.isEmptyValue(rowData[fn]) && !emptyValues.isEmptyValue(parentValues[fn])) {
                                        rowData[fn] = parentValues[fn];
                                    }
                                }
                            }

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

                            // Подписи для человека: «Zeile 3 der Tabelle «Gäste»: Feld
                            // «Gästetyp»», а не имена таблицы и колонки. Ниже на них
                            // ссылаются оба отказа — и обязательное поле, и чужая ссылка.
                            const captionOf = async (c, fallback) => {
                                if (c && typeof c === 'object' && c.i18n) {
                                    try { return await tForSession(c.i18n, sessionID); } catch (e) { return fallback; }
                                }
                                return (typeof c === 'string' && c) ? c : fallback;
                            };
                            const sectionCaption = await captionOf(tsDef.tabularSection && tsDef.tabularSection.caption, sectionTableName);

                            // ОБЯЗАТЕЛЬНАЯ ССЫЛКА НЕ ЗАПОЛНЕНА (тип гостя у пустой
                            // строки, добавленной «+»). Раньше строку пропускали до базы и
                            // показывали её отказ как есть: «notNull Violation:
                            // BookingGuests.guestTypeId cannot be null» — по-английски и
                            // именами колонок. Проверяем здесь и говорим словами.
                            let requiredOk = true;
                            for (const [fieldName, fieldDef] of Object.entries(sectFields)) {
                                if (!fieldDef || !fieldDef.references || fieldDef.allowNull !== false) continue;
                                if (fieldName === parentField) continue;
                                const v = rowData[fieldName];
                                if (v !== null && v !== undefined && v !== '') continue;
                                saveWarnings.push(await tfForSession('row_field_required', sessionID, {
                                    row: ri + 1, section: sectionCaption,
                                    field: await captionOf(fieldDef.caption, fieldName)
                                }));
                                requiredOk = false;
                                break;
                            }
                            if (!requiredOk) continue;

                            // Серверная валидация безопасности: межсекционные FK
                            let securityOk = true;
                            for (const [fieldName, fieldDef] of Object.entries(sectFields)) {
                                if (!fieldDef.references) continue;
                                const refTable = fieldDef.references.model;
                                if (!tsTableNames.has(refTable) || refTable === sectionTableName) continue;
                                const fkVal = rowData[fieldName];
                                if (!fkVal) {
                                    if (fieldDef.allowNull === true) continue;
                                    const msg = await tfForSession('row_field_required', sessionID, { row: ri + 1, section: sectionCaption, field: await captionOf(fieldDef.caption, fieldName) });
                                    console.warn('[uniForm TS_SECURITY]', msg);
                                    saveWarnings.push(msg);
                                    securityOk = false;
                                    break;
                                }
                                const validSet = validSiblingUIDs[refTable];
                                if (validSet && !validSet.has(fkVal)) {
                                    const msg = await tfForSession('row_field_fk_mismatch', sessionID, { row: ri + 1, section: sectionCaption, field: await captionOf(fieldDef.caption, fieldName) });
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
                                saveWarnings.push(await tfForSession('row_save_error', sessionID, { row: ri + 1, section: sectionCaption, error: errMsg }));
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

        // В очередь проведения — ТОЛЬКО теперь, когда записаны и шапка, и табличные
        // части (запись шапки шла с `deferPosting`). Иначе воркер проводил документ
        // без строк — «0 движений» (dbGateway.enqueueAfterSave).
        try {
            await applyDbGW.enqueueAfterSave(tableName, parentUID, sessionID);
        } catch (e) {
            console.error('[uniForm] постановка в очередь проведения после сохранения:', e && e.message || e);
        }

        // СЕРВЕРНОЕ СОБЫТИЕ «ЗАПИСЬ СОХРАНЕНА» (`onAfterSave`, метод формы, 19.10.2026).
        // Для того, что можно сделать только над УЖЕ записанным документом: оповещения
        // счёта, созданного «Rechnung erstellen», переписываются после первого
        // сохранения (до него документа нет). Отменить сохранение оно не может —
        // запись уже в базе, поэтому ошибка здесь только в журнал.
        try {
            await dispatchServerEvent('onAfterSave', {
                tableName, recordId: parentUID, isNew: isNewRecord,
                tabularSections: tabularSectionsData || {}
            }, { tableName, sessionID, formApp: dsObj.formApp, formName: dsObj.formName });
        } catch (e) {
            console.error('[uniForm] onAfterSave:', e && e.message || e);
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
    // `params.fields` — колонки, НАЗВАННЫЕ лейаутом списка. Служебный реквизит,
    // названный явно, обязан доехать: правило «не показывать» относится к
    // АВТОгенерации, а рукописный лейаут вправе показать что угодно
    // (drive_root/db/serviceFields.js). Без этого колонка «Проведение» в журнале
    // молча исчезала: и объявлена, и отфильтрована.
    const built = buildTableFieldsFromModel(tableName, Array.isArray(params.fields) ? params.fields : null);
    // Журнал регистра и форма его записи отвечают на РАЗНЫЕ вопросы, поэтому и
    // состав колонок у них разный: из журнала убираем то, что дублирует соседей
    // (drive_root/db/registerForms.js#hideInJournal).
    return Promise.resolve(built).then(fields => {
        try {
            return require('../../drive_root/db/registerForms').hideInJournal(tableName, fields);
        } catch (e) { return fields; }
    });
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
async function buildTableFieldsFromModel(tableName, keepService) {
    try {
        const globalCtx = require('../../drive_root/globalServerContext');
        const modelName = globalCtx.getModelNameForTable(tableName) || tableName;
        if (!modelName) return null;
        const metaAll = await globalCtx.getTableMetadata(modelName);
        if (!Array.isArray(metaAll)) return null;
        // Служебные реквизиты (момент времени, состояние проведения) в АВТОМАТИЧЕСКИ
        // построенный интерфейс не идут — ни полем формы записи, ни колонкой
        // табличной части. `UID` оставляем: он нужен данным формы, а прячется
        // отдельно там, где строятся контролы (drive_root/db/serviceFields.js).
        let keep = Array.isArray(keepService) ? keepService : [];
        // У РЕГИСТРА служебные поля — не внутренняя механика, а суть строки:
        // период, регистратор, номер строки и знак и есть движение. Правило
        // «служебное не показываем» писалось про реквизиты документа (момент
        // времени, состояние проведения), и распространять его сюда — значит
        // оставить форму записи регистра с пустыми полями.
        try {
            const registerForms = require('../../drive_root/db/registerForms');
            if (registerForms.isRegisterTable(tableName)) {
                keep = keep.concat(registerForms.HEAD);
            }
        } catch (e) { /* реестр регистров может быть не поднят */ }
        let meta = require('../../drive_root/db/serviceFields')
            .withoutService(metaAll, { keepUID: true, keep });
        // Канонический порядок полей регистра: когда → кто сделал → в каком
        // разрезе → сколько → подробности. Порядок ключей в `db.json` у двух
        // регистров случайно разный, а вопрос у читателя один и тот же.
        try {
            meta = require('../../drive_root/db/registerForms').orderFields(tableName, meta);
        } catch (e) { /* не регистр или реестр не поднят */ }

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

            // Умолчание, объявленное в db.json, — для НОВОЙ записи (см. ниже).
            if (f.declaredDefault !== undefined && f.declaredDefault !== null) {
                field.declaredDefault = f.declaredDefault;
            }
            // Умолчание из личной настройки пользователя — тоже для НОВОЙ записи.
            if (f.defaultFromSetting) field.defaultFromSetting = f.defaultFromSetting;

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
//
// Серверное событие формы — это её МЕТОД с условленным именем. Ищется по адресу
// формы, а не в объявлении лейаута: представление на обработку сохранения больше
// не влияет никак, потому что и не должно.
async function dispatchServerEvent(eventName, payload, { tableName, sessionID, formApp, formName }) {
    try {
        const addr = (formApp && formName)
            ? { app: formApp, form: formName }
            : subjectAddress('record', tableName);
        if (!addr) return;
        const { called } = await callFormMethod({
            app: addr.app, form: addr.form, method: eventName,
            payload, sessionID
        });
        if (called) console.log(`[uniForm] метод формы «${eventName}» выполнен для ${addr.app}/${addr.form}`);
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
            // Вкладки — тоже (16.10.2026): организация и отель брони лежат на вкладке
            // «Zusatz», и автозаполнение их не видело.
            if (Array.isArray(item.tabs)) for (const t of item.tabs) if (t && t.layout) walk(t.layout);
        }
    }
    walk(Array.isArray(layout) ? layout : [layout]);
}

/**
 * ЕДИНСТВЕННЫЙ ВАРИАНТ ПОДСТАВЛЯЕТСЯ САМ (16.10.2026).
 *
 * Новая запись, ОБЯЗАТЕЛЬНАЯ ссылка (`allowNull: false` в модели), пусто и после
 * автозаполнения пользователя, а по правам сотруднику видна ровно ОДНА запись нужной
 * таблицы — значит, другого ответа нет, и спрашивать его — лишний шаг с отказом
 * «заполните Organisation» в конце (прогон сценариев: новая услуга, новый сезон).
 * Типичный клиент — одна организация и один отель. Необязательные ссылки не трогаем:
 * пусто там — тоже ответ; исключение — реквизиты доступа (организация, отель), см. ниже.
 *
 * @param {Array} data — данные формы ({ name, value, selection })
 * @param {Array<{name, table}>} selectors — поля-ссылки формы
 * @param {string} tableName — таблица записи (откуда берём обязательность)
 * @returns {Promise<string[]>} — имена заполненных полей
 */
async function applySingleOptionDefaults(data, selectors, tableName, sessionID) {
    const filled = [];
    try {
        const globalCtx = require('../../drive_root/globalServerContext');
        const modelName = globalCtx.getModelNameForTable(tableName);
        const Model = modelName ? globalCtx.modelsDB[modelName] : null;
        const attrs = (Model && Model.rawAttributes) || {};
        // Кроме обязательных — ссылки-РЕКВИЗИТЫ ДОСТУПА (`required_access_fields`:
        // организация, отель), даже необязательные: это «чья запись», и при одном
        // отеле у сотрудника другого ответа нет. Пустой «Hotel» у новой услуги и
        // кассы при единственном отеле был лишним шагом (решение владельца
        // 19.10.2026, прогон 17.10.2026 S5/S8). Пользователей не касается: ссылка на
        // пользователя — не «где», а «кто».
        let accessFields = new Set();
        let identityTables = new Set();
        try {
            const scope = require('../../drive_root/backup/scope');
            accessFields = new Set(scope.accessConfig().requiredFields || []);
            identityTables = scope.IDENTITY_TABLES || new Set();
        } catch (e) { /* только обязательные */ }
        for (const sel of selectors) {
            const a = attrs[sel.name];
            if (!a || !sel.table) continue;
            const ownership = accessFields.has(sel.name) && !identityTables.has(sel.table);
            if (a.allowNull !== false && !ownership) continue;
            const item = data.find(d => d.name === sel.name);
            if (!item || (item.value !== null && item.value !== undefined && item.value !== '')) continue;
            let lk = null;
            try {
                lk = await globalCtx.getLookupList({ tableName: sel.table, firstRow: 0, visibleRows: 2, sessionID });
            } catch (e) { continue; }
            const rows = (lk && (lk.data || lk.rows)) || [];
            if (!lk || lk.totalRows !== 1 || rows.length !== 1) continue;
            item.value = rows[0].UID;
            item.selection = { id: rows[0].UID, display: rows[0].display };
            filled.push(sel.name);
        }
    } catch (e) {
        console.error('[uniForm/applySingleOptionDefaults]', e && e.message || e);
    }
    return filled;
}

/** Поля-ссылки лейаута (вместе с вкладками): [{ name, table }]. */
function selectorsOfLayout(layout) {
    const out = [];
    const walk = (items) => {
        if (!Array.isArray(items)) return;
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            if (item.type === 'recordSelector' && item.data) {
                const sel = item.properties && item.properties.selection;
                const t = sel && sel.table && !String(sel.table).includes('{') ? sel.table : null;
                if (t) out.push({ name: item.data, table: t });
            }
            if (item.layout) walk(item.layout);
            if (Array.isArray(item.tabs)) for (const t of item.tabs) if (t && t.layout) walk(t.layout);
        }
    };
    walk(Array.isArray(layout) ? layout : [layout]);
    return out;
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
/**
 * ФОРМА БЕЗ СОБСТВЕННЫХ ДАННЫХ не имеет «ОК», «Сохранить» и «Отменить».
 *
 * Три рода форм, и это не оттенки, а разные вещи (понятие взято у классических
 * учётных систем, где обработка — отдельный вид объекта):
 *
 *   ЗАПИСЬ    — у формы есть запись, её правят и сохраняют. Кнопки нужны.
 *   ЖУРНАЛ    — список чужих записей. Сохранять нечего: правки идут в форме записи.
 *   ОБРАБОТКА — у формы нет данных вообще, она ДЕЛАЕТ работу («Удаление
 *               помеченных объектов», «Движения документа»). Сохранять нечего
 *               тем более, и признак изменённости («звёздочка») ей тоже не нужен:
 *               галочка в списке — не «несохранённая правка», а выбор на один раз.
 *
 * Кнопка, которая ничего не делает, хуже отсутствующей: она обещает действие и
 * заставляет гадать, что произойдёт. Поэтому убирает их ЯДРО, по роду формы, а
 * не каждый лейаут своим `hiddenButtons`, о котором легко забыть.
 */
function suppressStandardButtons(layout, ids) {
    if (!Array.isArray(layout)) return layout;
    const STD = Array.isArray(ids) ? ids : ['ok', 'save', 'cancel'];
    for (const item of layout) {
        if (!item || item.type !== 'commandBar') continue;
        const had = Array.isArray(item.hiddenButtons) ? item.hiddenButtons : [];
        item.hiddenButtons = Array.from(new Set(had.concat(STD)));
    }
    return layout;
}

/**
 * ФОРМА, КОТОРУЮ ЦЕЛИКОМ НЕЛЬЗЯ ПРАВИТЬ, не предлагает сохранение.
 *
 * Это не то же самое, что обработка (у той нет данных вовсе). Здесь запись есть,
 * но заперта вся: строка регистра, документ в закрытом состоянии без единого
 * разрешённого поля. «Сохранить» на такой форме не делает ничего, а «Отмена»
 * называется не тем словом — отменять нечего, окно просто закрывают.
 *
 * Решает ЗАМОК, а не отдельное объявление: замок и так знает, что заперто, и
 * второй источник этого знания разошёлся бы с первым.
 */
function applyReadOnlyButtons(layout, lock) {
    if (!lock || !lock.closed) return false;
    if (Array.isArray(lock.editable) && lock.editable.length) return false;
    // У закрытого документа может остаться ЗАКОННЫЙ переход состояния
    // (выставлен → оплачен): его выбирают в поле состояния и записывают
    // «Сохранить». Убрать кнопку здесь значило бы запретить переход, оставив
    // список состояний на экране, — то есть предложить выбор без последствий.
    if (Array.isArray(lock.states) && lock.states.length > 1) return false;
    suppressStandardButtons(layout, ['ok', 'save']);
    for (const item of (Array.isArray(layout) ? layout : [])) {
        if (item && item.type === 'commandBar') item.cancelAsClose = true;
    }
    return true;
}

/**
 * Кнопки `"command": "storno" | "correct"` на САМОМ встречном документе.
 *
 * Сторно сторно (и коррекцию коррекции) ядро и так отвергает (`storno.checkAllowed`),
 * но только после «Ja» на вопрос «Wirklich stornieren?» — сначала человек
 * соглашается, потом узнаёт, что нельзя (прогон 17.10.2026, E7). Признак тот же, что
 * у отказа: заполнена ссылка `link` встречного документа этого вида. Тогда кнопка
 * получает отказ с объяснением (`enabledWhen` + `reason`) тем же текстом.
 */
function markCounterOfCounterCommands(layout, tableName, data) {
    if (!Array.isArray(layout) || !Array.isArray(data)) return;
    const modelName = globalServerContext.getModelNameForTable(tableName);
    const Model = modelName ? globalServerContext.modelsDB[modelName] : null;
    if (!Model || !Model.entityConfig) return;
    const storno = require('../../drive_root/db/storno');
    const valueOf = (name) => { const d = data.find(x => x && x.name === name); return d ? d.value : null; };
    const KIND = { storno: 'storno', correct: 'correction' };
    const REASON = { storno: 'storno_refuse_of_storno', correct: 'correction_refuse_of_counter' };
    const walk = (items) => {
        for (const it of items || []) {
            if (!it || typeof it !== 'object') continue;
            if (Array.isArray(it.extraButtons)) {
                for (const b of it.extraButtons) {
                    const kind = b && KIND[b.command];
                    if (!kind) continue;
                    const cfg = storno.counterConfig(Model, kind);
                    if (!cfg || !cfg.link) continue;
                    const v = valueOf(cfg.link);
                    if (v === null || v === undefined || v === '') continue;
                    b.enabledWhen = { field: cfg.link, in: [''], reason: { i18n: REASON[b.command] } };
                }
            }
            if (Array.isArray(it.layout)) walk(it.layout);
            if (Array.isArray(it.items)) walk(it.items);
            if (Array.isArray(it.tabs)) for (const t of it.tabs) walk(t && t.layout);
        }
    };
    walk(layout);
}

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
        let formAddr = null;
        try {
            formAddr = subjectAddress('record', tableName);
            if (formAddr) {
                const layoutMemory = require('../../drive_root/layoutMemory');
                const userRole = await layoutMemory.getUserRoleBySession(sessionID);
                customLayoutObj = await layoutMemory.getLayoutForUser(formAddr.app, formAddr.form, userRole, sessionID, params && params.view);
                if (customLayoutObj) {
                    clientScript = customLayoutObj.clientScript || null;
                    formIcon = customLayoutObj.formIcon || null;
                    windowState = customLayoutObj.windowState || null;
                    appCaption = customLayoutObj.appCaption || null;
                    recordCaption = customLayoutObj.recordCaption || null;
                }
            }
        } catch (e) {
            console.error('[uniForm/generateFormSpec] custom layout early check error:', e && e.message || e);
        }

        // onLoadData: данные загружает МЕТОД ФОРМЫ (виртуальные таблицы, экраны настроек)
        if (customLayoutObj && formAddr) {
            try {
                const { called, result } = await callFormMethod({
                    app: formAddr.app, form: formAddr.form, method: 'onLoadData',
                    payload: { tableName, form: formAddr.form, params }, sessionID
                });
                if (called) {
                    const layout = JSON.parse(JSON.stringify(customLayoutObj.layout || []));
                    const data = normalizeLoadedData(result && result.data, 'generateFormSpec');
                    if (result && result.caption && layout[0]) layout[0].caption = result.caption;
                    // Автозаполнение для новых записей
                    if (!params || (!params.recordID && !params.recordId && !params.id)) {
                        const dfltMap = await loadUserDefaultValues(sessionID);
                        if (Object.keys(dfltMap).length > 0) applyAutofillFromLayout(data, layout, dfltMap);
                        if (tableName) await applySingleOptionDefaults(data, selectorsOfLayout(layout), tableName, sessionID);
                    }
                    const datasetId = dataApp.storeDataset({
                        layout, data, params: params || {},
                        table: tableName,
                        formApp: formAddr.app, formName: formAddr.form,
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
                    return { layout, data, datasetId, clientScript, formIcon, appCaption: resolvedOnLoadCaption, windowState: windowState || 'centered', fkLookups,
                             events: clientEventsOf(customLayoutObj),
                             isRecordForm: true };
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

        // Умолчания НОВОЙ записи из личных настроек (`defaultFromSetting` поля):
        // пользователь, который обычно принимает наличные, не выбирает «Bar» каждый
        // раз. Читаются ОДИН раз на форму — полей с таким умолчанием единицы.
        const settingDefaults = {};
        if (!record) {
            const wanted = fields.filter(f => f && f.defaultFromSetting && f.defaultFromSetting.app && f.defaultFromSetting.key);
            if (wanted.length) {
                try {
                    const gCtxS = require('../../drive_root/globalServerContext');
                    const user = await gCtxS.getUserBySessionID(sessionID);
                    const settings = require('../../drive_root/settings');
                    for (const f of wanted) {
                        try {
                            const v = user ? await settings.getUserSetting(user.UID, f.defaultFromSetting.app, f.defaultFromSetting.key) : undefined;
                            if (v !== undefined && v !== null && v !== '') settingDefaults[f.name] = v;
                        } catch (e) {
                            console.error(`[uniForm/generateFormSpec] умолчание «${f.name}» из настройки`
                                + ` ${f.defaultFromSetting.app}.${f.defaultFromSetting.key}:`, e && e.message || e);
                        }
                    }
                } catch (e) { /* без настроек — объявленное умолчание поля */ }
            }
        }

        const data = await Promise.all(fields.map(async f => {
            const typeKey = (f.type || '').toUpperCase();
            // Значение НОВОЙ записи: сначала умолчание, объявленное автором поля
            // (`defaultValue` в db.json), и только если его нет — пустое по типу.
            // Прежде объявленное умолчание не доезжало до формы вовсе: новая
            // услуга открывалась с пустым «Berechnung» при `perBooking` в схеме,
            // и пустая строка уезжала в базу (прогон 16.10.2026, S5). Правило
            // общее: умолчание — свойство ПОЛЯ, а не одной формы.
            let defaultValue = null;
            if (Object.prototype.hasOwnProperty.call(settingDefaults, f.name)) defaultValue = settingDefaults[f.name];
            else if (f.declaredDefault !== undefined && f.declaredDefault !== null) defaultValue = f.declaredDefault;
            else if (typeKey === 'INTEGER' || typeKey === 'NUMBER') defaultValue = 0;
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
            const fieldSelectors = (fields || [])
                .filter(f => f && f.inputType === 'recordSelector')
                .map(f => ({ name: f.name, table: (f.foreignKey && f.foreignKey.table) || (f.properties && f.properties.selection && f.properties.selection.table) }))
                .filter(x => x.table && !String(x.table).includes('{'));
            for (const n of await applySingleOptionDefaults(data, fieldSelectors, tableName, sessionID)) prefilledFields.add(n);
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

        // РЕКВИЗИТЫ ФОРМЫ у формы С ПРЕДМЕТОМ объявляются явно (`attribute: true`):
        // рядом с полями записи их надо уметь отличить, иначе поле формы однажды
        // молча уедет в базу. Собираем ДО `storeDataset`: датасет хранит их список,
        // и `applyChanges` по нему отбрасывает всё, что реквизитам не место.
        const recordAttributes = collectFormAttributes(layout, { allFields: false });
        for (const a of recordAttributes) {
            if (!data.some(d => d && d.name === a.name)) {
                data.push({ name: a.name, value: a.default, tabularSection: false });
            }
        }

        // ── onLoadAttributes: ВЫЧИСЛЕННЫЕ значения реквизитов формы ────────────
        //
        // У формы с предметом данные записи приходят из её таблицы, а реквизит
        // формы в таблице не лежит — объявить его было чем, а посчитать нечем,
        // кроме объявленного умолчания. Этот метод и есть «чем»: он получает уже
        // прочитанную запись и возвращает `{ имя: значение }`.
        //
        // Ровно для таких величин, как предоплата брони: она не хранится, она
        // ЕСТЬ остаток регистра расчётов по этой броне. Считать её на клиенте
        // вторым запросом значило бы показать форму с пустым полем и дописать
        // цифру мгновением позже — то есть моргнуть данными на экране.
        //
        // Метод необязателен: нет его — реквизиты остаются с умолчаниями.
        if (recordAttributes.length && formAddr) {
            try {
                const { called, result } = await callFormMethod({
                    app: formAddr.app, form: formAddr.form, method: 'onLoadAttributes',
                    payload: { tableName, form: formAddr.form, recordID: effectiveRecordId,
                               isNew, record, params },
                    sessionID
                });
                if (called && result && typeof result === 'object') {
                    const known = new Set(recordAttributes.map(a => a.name));
                    for (const [name, value] of Object.entries(result)) {
                        // Отдать значение полю ЗАПИСИ этот метод не может: он про
                        // реквизиты формы, и молчаливая правка записи мимо
                        // сохранения была бы совсем другим механизмом.
                        if (!known.has(name)) {
                            console.warn(`[uniForm] onLoadAttributes формы ${formAddr.app}/${formAddr.form} вернул «${name}» — это не реквизит формы, значение отброшено`);
                            continue;
                        }
                        const entry = data.find(d => d && d.name === name);
                        if (entry) entry.value = value;
                        else data.push({ name, value, tabularSection: false });
                    }
                }
            } catch (e) {
                console.error('[uniForm/generateFormSpec] onLoadAttributes:', e && e.message || e);
            }
        }

        const datasetId = dataApp.storeDataset({
            table: tableName, id: effectiveRecordId, isNew: isNew,
            formApp: formAddr && formAddr.app, formName: formAddr && formAddr.form,
            formAttributes: recordAttributes.map(a => a.name),
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
        // У регистра лейаута нет (формы строит автогенератор), значит нет и
        // подписи в реестре — берём её из объявления регистра, иначе в заголовке
        // окна стоит имя таблицы.
        if (!resolvedCaption) {
            resolvedCaption = await resolveAppCaption(getRegisterCaption(tableName), sessionID);
        }
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
        // Тон записи (`entityConfig.rowTones`): те же правила, что красят строку журнала,
        // красят на форме поле состояния (DataForm.applyRecordTone).
        let rowTones = null;
        try {
            const gCtxLock = require('../../drive_root/globalServerContext');
            const lockModelName = gCtxLock.getModelNameForTable(tableName) || tableName;
            const LockModel = (gCtxLock.modelsDB || {})[lockModelName];
            if (LockModel && LockModel.entityConfig && Array.isArray(LockModel.entityConfig.rowTones)) {
                rowTones = LockModel.entityConfig.rowTones;
            }
            if (LockModel) {
                const immutable = require('../../drive_root/db/immutable');
                if (immutable.readConfig(LockModel)) {
                    const values = {};
                    for (const d of data) values[d.name] = d.value;

                    // СОСТОЯНИЕ ИЗ ЗАПИСИ, если его нет в данных формы.
                    //
                    // Замок читает состояние из значений формы, но у документа,
                    // чьё состояние — СЛУЖЕБНЫЙ реквизит (`postingState` у
                    // денежных документов), этого значения там ещё нет: служебные
                    // поля кладутся в данные ниже по коду. Итог был тихий и
                    // неприятный: `state: null` → `closed: false` → форма
                    // ПРОВЕДЁННОГО документа оставалась редактируемой, хотя
                    // объявление прямо это запрещает. У счёта не проявлялось —
                    // там поле состояния обычное и в данных есть.
                    const lockCfg = immutable.readConfig(LockModel);
                    const lockField = lockCfg && lockCfg.field;
                    if (lockField && values[lockField] === undefined && !isNew) {
                        const recUID = (data.find(d => d && d.name === 'UID') || {}).value;
                        if (recUID) {
                            try {
                                const lockGW = require('../../drive_root/dbGateway');
                                const lockRows = await lockGW.execute({
                                    operation: 'read', table: tableName, where: { UID: recUID },
                                    options: { raw: true, limit: 1, attributes: ['UID', lockField] },
                                    context: { sessionID }
                                });
                                if (lockRows && lockRows[0]) values[lockField] = lockRows[0][lockField];
                            } catch (e) {
                                console.error('[uniForm] состояние для замка не прочитано:', e && e.message || e);
                            }
                        }
                    }
                    // Администратор при включённой настройке — без замка (тот же
                    // признак, что снимает запрет записи в dbGateway).
                    const override = await immutable.adminOverride(sessionID);
                    lock = immutable.describeLock(LockModel, values, { override });
                    if (lock) applyLockToLayout(layout, lock);
                }
            }
            // СТРОКА РЕГИСТРА — всегда только чтение, и это не настройка, а
            // свойство таблицы: прямая запись в регистр отбивается middleware
            // (`registerWriteGuard`), писать вправе только проведение.
            // Редактируемая форма обещала бы то, в чём сервер откажет.
            {
                const registerForms = require('../../drive_root/db/registerForms');
                if (registerForms.isRegisterTable(tableName)) {
                    lock = registerForms.readOnlyLock();
                    applyLockToLayout(layout, lock);
                }
            }
            // Форму, запертую ЦЕЛИКОМ, не надо спрашивать «сохранить?»: сохранять
            // нечего, а «Отмена» называется не тем словом. Ставится ЗДЕСЬ, рядом с
            // замком: это единственная точка, правки лейаута из которой доезжают
            // до клиента (ниже по коду набор уже сохранён глубокой копией).
            applyReadOnlyButtons(layout, lock);
            if (getEntityTypeForTable(tableName) === 'document') applyDocumentDateTime(layout);
        } catch (e) {
            console.error('[uniForm/generateFormSpec] lock resolve error:', e && e.message || e);
        }

        // ── Состояние проведения ─────────────────────────────────────────────
        // «Служебный реквизит» значит «не строим по нему контрол автоматически»,
        // а НЕ «форма о нём не знает». Форме он нужен для двух вещей, и обе
        // читают значение ИЗ ДАННЫХ формы (`getControlValue` → `_dataMap`):
        //   - доступность команд (`enabledWhen: { field: "postingState" }`);
        //   - пометка «в очереди» / «ошибка» (`visibleWhen`).
        // Поэтому он кладётся и в `data` (как `UID`), и отдельным полем
        // спецификации — второе нужно, чтобы форма, открытая на уже стоящем в
        // очереди документе, заперлась с первой секунды.
        let postingState = null;
        let postingCaptions = null;
        let postingCanUnpost = false;
        // РЕЖИМ проведения едет на клиент отдельно от подписей команд: форме он
        // нужен не для кнопок (их в режиме `onSave` нет вовсе), а чтобы знать,
        // показывать ли человеку саму очередь — замок формы и фазу в заголовке.
        let postingMode = null;
        try {
            const posting = require('../../drive_root/db/posting');
            const gCtxPost = require('../../drive_root/globalServerContext');
            const modelNameP = gCtxPost.getModelNameForTable(tableName);
            const ModelP = modelNameP ? (gCtxPost.modelsDB || {})[modelNameP] : null;
            if (ModelP && posting.readConfig(ModelP)) {
                const rec = data.find(d => d && d.name === 'UID');
                const uidP = rec && rec.value;
                if (uidP && !isNew) {
                    const dbGW = require('../../drive_root/dbGateway');
                    const rowsP = await dbGW.execute({
                        operation: 'read', table: tableName, where: { UID: uidP },
                        options: { raw: true, limit: 1, attributes: ['UID', posting.STATE_FIELD] },
                        context: { sessionID }
                    });
                    if (rowsP && rowsP[0]) postingState = rowsP[0][posting.STATE_FIELD] || null;
                }
                if (!postingState) postingState = posting.STATE.NOT_POSTED;

                // Состояние проведения кладётся и В ДАННЫЕ ФОРМЫ — как `UID`.
                // «Служебный» значит «не строим по нему контрол автоматически», а
                // НЕ «форма о нём не знает»: по нему объявляется доступность команд
                // (`enabledWhen: { field: "postingState" }`) и видимость пометки, а
                // оба условия читают значение из данных формы. Без этой записи
                // условие всегда ложно — кнопки «Провести» стоят серыми у любого
                // документа, и выглядит это как поломка команды, а не как
                // недостающие данные.
                if (!data.some(d => d && d.name === posting.STATE_FIELD)) {
                    data.push({ name: posting.STATE_FIELD, value: postingState });
                }

                // Подписи команд проведения — ПОТАБЛИЧНЫЕ (ТЗ §5.1): счёт говорит
                // «Выставить», денежный документ — «Провести». Форме они нужны
                // потому, что стандартную кнопку «ОК» она переименовывает в
                // «<команда> и закрыть»: у документа «ОК» означает не «закрыть
                // окно», а «закончить с документом».
                const cfgP = posting.readConfig(ModelP);
                // Подписи отдаём ТОЛЬКО для ручного режима. В режиме `onSave` команд
                // проведения на форме нет вовсе — и кнопка «ОК» там обязана
                // остаться «Сохранить и закрыть»: документ уйдёт в очередь сам.
                const capsP = {};
                if (cfgP.mode !== 'manual') { postingCaptions = null; }
                else {
                    // Тексты команды: подписи и ПЕРЕСПРОСЫ. Переспрос объявлен у
                    // команды (ТЗ §14.1), поэтому едет вместе с подписями — и его
                    // покажет любая кнопка, которая команду выполняет.
                    const texts = Object.assign({}, cfgP.captions || {});
                    if (cfgP.confirm) texts.confirm = cfgP.confirm;
                    if (cfgP.unpostConfirm) texts.unpostConfirm = cfgP.unpostConfirm;
                    for (const [k, v] of Object.entries(texts)) {
                        if (v && typeof v === 'object' && v.i18n) {
                            try { capsP[k] = await tForSession(v.i18n, sessionID); }
                            catch (e) { capsP[k] = v.i18n; }
                        } else if (typeof v === 'string') {
                            capsP[k] = v;
                        }
                    }
                }
                if (cfgP.mode === 'manual') postingCaptions = capsP;
                postingMode = cfgP.mode;
                // Можно ли документ распровести ВООБЩЕ — вопрос об ОБЪЯВЛЕНИИ, не о
                // состоянии. Форме он нужен для кнопки «ОК»: документ, проведение
                // которого необратимо, не совмещает его с закрытием окна (ТЗ §14.1).
                postingCanUnpost = posting.canUnpostFrom(cfgP, null);

                // СТРОКА ОЧЕРЕДИ — элемент ядра, а не лейаута приложения.
                // «Документ стоит в очереди» — состояние, одинаковое у любого
                // проводимого документа, и объявлять его в каждом лейауте значило
                // бы двадцать раз списать один и тот же элемент, а потом найти
                // документ, где его забыли. Поэтому ядро вставляет строку само —
                // сразу под командной панелью, как просил владелец.
                if (Array.isArray(layout)) {
                    const already = layout.some(it => it && it.type === 'postingQueueLine');
                    if (!already) {
                        const line = {
                            type: 'postingQueueLine', name: '__postingQueue',
                            // В режиме `onSave` блок говорит ТОЛЬКО про неудачу.
                            // Строка «документ в очереди на проведение» вернула бы
                            // пользователю слово, которое из интерфейса убрали, и
                            // показывала бы его на каждое сохранение. А неудачу
                            // прятать нельзя: иначе тот, у кого нет кнопок, никак
                            // не узнает, что документ не в порядке (ТЗ §5.2).
                            properties: { errorsOnly: cfgP.mode === 'onSave' }
                        };
                        const barAt = layout.findIndex(it => it && it.type === 'commandBar');
                        layout.splice(barAt === -1 ? 0 : barAt + 1, 0, line);
                    }
                }
            }
        } catch (e) {
            console.error('[uniForm/generateFormSpec] posting state resolve error:', e && e.message || e);
        }

        // ── ОПОВЕЩЕНИЯ ПО ДОКУМЕНТУ (ТЗ «Оповещения по документам», §10) ──────
        // Панель оповещений — ЧАСТЬ РАМКИ ФОРМЫ, а не элемент лейаута: ядро
        // рисует её снаружи, и лейаут о ней не знает и не меняется. Обёртка над
        // лейаутом сломала бы вёрстку форм с таблицами во всю ширину, вкладками
        // и шахматкой, а объявление в каждом лейауте означало бы двадцать раз
        // списать один и тот же элемент и однажды найти документ, где его
        // забыли.
        //
        // Поэтому строки едут ОТДЕЛЬНЫМ полем спецификации, как состояние
        // проведения. Тексты уже переведены — на язык ЭТОЙ сессии: оповещение
        // адресовано человеку, который смотрит, а не организации и не тому, кто
        // вызвал пересчёт.
        // Панель едет только тем таблицам, у которых правила ОБЪЯВЛЕНЫ: пустая
        // панель на справочнике номеров — обещание сведений, которых не бывает.
        // И только сохранённой записи: у новой документа ещё нет, а значит нет и
        // того, про что можно что-то сказать.
        let alerts = null;
        try {
            const recUid = (data.find(d => d && d.name === 'UID') || {}).value;
            const hasRules = require('../../drive_root/db/alertRules').forTable(tableName).length > 0;
            if (recUid && !isNew && hasRules) {
                const documentAlerts = require('../../drive_root/db/documentAlerts');
                alerts = await documentAlerts.forDocument({
                    table: tableName, uid: recUid, sessionID
                });
            }
        } catch (e) {
            console.error('[uniForm/generateFormSpec] оповещения не прочитаны:', e && e.message || e);
        }

        try { markCounterOfCounterCommands(layout, tableName, data); }
        catch (e) { console.error('[uniForm/generateFormSpec] команды встречного документа:', e && e.message || e); }

        // Translate all { i18n: 'key' } objects in layout before sending to client
        if (Array.isArray(layout)) {
            await translateLayoutI18n(layout, sessionID);
        }

        // Клиентские события формы (form-level): доставляем на клиент только те
        // привязки из events, у которых НЕТ serverScript (серверные, напр. onBeforeSave,
        // обрабатываются на сервере и на клиент не отдаются). Напр. onChange — общее
        // событие «форма изменилась», которое DataForm дёргает из setModified.
        const clientEvents = clientEventsOf(customLayoutObj);

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

        return { data, layout, datasetId, clientScript, formIcon, appCaption: resolvedCaption, windowState: finalWindowState, fkLookups: await fkLookupsPromise, isNew: isNew, events: clientEvents, prefilled, lock, rowTones, postingState, postingCaptions, postingCanUnpost, postingMode, alerts, formAttributes: await describeAttributes(recordAttributes, sessionID), formApp: formAddr && formAddr.app, formName: formAddr && formAddr.form, isRecordForm: true };
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
// Кнопка «Удалить» в списке делает РАЗНОЕ, и это не двусмысленность, а правило
// (решение владельца 22.09.2026, как в классических учётных системах):
//
//   СУЩНОСТЬ (есть entityConfig.entityType) → ставит/снимает ПОМЕТКУ НА УДАЛЕНИЕ.
//       Сама запись не трогается. Удаляет помеченные отдельная обработка, которая
//       умеет проверить ссылки и сказать, кто мешает (drive_root/db/deletionMark.js).
//   ВСЁ ОСТАЛЬНОЕ (технические таблицы: задания планировщика, настройки) → удаляет
//       сразу, как раньше. Пометка у них не значила бы ничего: их не перечисляет
//       обработка, и удалять их безопасно.
//
// ДВА ВЫЗОВА НА ОДНО НАЖАТИЕ. Клиент сначала спрашивает `dryRun: true` — что
// произойдёт, — показывает соответствующий вопрос и только потом зовёт
// по-настоящему. Иначе текст вопроса пришлось бы вычислять на клиенте, то есть
// завести вторую копию правил о том, кого можно удалять; а они уже объявлены
// один раз — в `entityConfig.immutable`.
async function deleteRecord(params, sessionID) {
    let tableName = params && (params.tableName || params.table || params.dbTable);
    const recordId  = params && (params.recordId || params.recordID || params.id);
    if (!tableName) return { ok: false, error: await tForSession('no_table_context', sessionID) };
    if (!recordId)  return { ok: false, error: await tForSession('missing_recordId', sessionID) };

    // ЖУРНАЛ ДОКУМЕНТОВ своих строк не имеет: «удалить строку журнала» значит
    // пометить/удалить ДОКУМЕНТ её вида — тем же механизмом, что из его журнала.
    try {
        const journals = require('../../drive_root/db/journals');
        if (journals.isJournalTable(tableName)) {
            const docTable = await journals.documentOf(tableName, recordId, sessionID);
            if (!docTable) return { ok: false, error: await tForSession('missing_recordId', sessionID) };
            tableName = docTable;
        }
    } catch (e) { /* журналов нет */ }

    const modelName = globalServerContext.getModelNameForTable(tableName) || tableName;
    const Model = globalServerContext.modelsDB[modelName];
    if (!Model) return { ok: false, error: 'Model not found for table: ' + tableName + ' (model: ' + modelName + ')' };

    const deletionMark = require('../../drive_root/db/deletionMark');

    // ── Сущность: два способа удаления, и выбирает человек ───────────────────
    if (deletionMark.isEntityDef(Model)) {
        const policy = deletionMark.readPolicy(Model);
        const mode = (params && params.mode) || null;

        // Прямое удаление — только если объявление его разрешает. Проверка ЗДЕСЬ,
        // а не только на клиенте: кнопки на экране подсказывают, а не решают.
        if (mode === 'direct') {
            if (!policy.direct) {
                return { ok: false, action: 'refuse',
                    error: await tForSession('deletion_refuse_direct_off', sessionID) };
            }
            // ПРОВЕДЁННЫЙ документ сразу не удаляется: движения снимаются по
            // регистратору, и удаление документа мимо распроведения оставило бы
            // их сиротами в остатке регистра навсегда. Правило — в ядре
            // (`deletionMark.canDeleteDirectly`), проверка здесь, а не только на
            // клиенте: кнопки на экране подсказывают, а не решают.
            const directRows = await require('../../drive_root/dbGateway').execute({
                operation: 'read', table: tableName, where: { UID: recordId },
                options: { raw: true, limit: 1 }, context: { appName: 'uniForm', sessionID }
            });
            const directRow = directRows && directRows[0];
            if (!directRow) return { ok: false, error: await tForSession('record_not_found', sessionID) };
            if (!deletionMark.canDeleteDirectly(Model, directRow)) {
                return { ok: false, action: 'refuse',
                    error: await tForSession('deletion_refuse_posted_direct', sessionID) };
            }
            return await hardDeleteRecord({ tableName, recordId, sessionID });
        }
        if (mode === 'mark' || mode === null) {
            return await applyDeletionMark({
                Model, tableName, recordId, sessionID,
                dryRun: !!(params && params.dryRun),
                unpostFirst: !!(params && params.unpostFirst),
                policy
            });
        }
        return { ok: false, error: 'unknown delete mode: ' + mode };
    }
    if (params && params.dryRun) return { ok: true, action: 'delete', direct: true };
    return await hardDeleteRecord({ tableName, recordId, sessionID });
}

/**
 * НАСТОЯЩЕЕ удаление записи — вместе с её табличными частями, одной транзакцией.
 *
 * Отдельной функцией, потому что вызывающих двое и у них разные поводы:
 *   - `deleteRecord` — техническая таблица, у которой пометки нет и не нужно;
 *   - обработка «Удаление помеченных объектов» — второй шаг удаления сущности,
 *     после того как она проверила ссылки (drive_root/db/deleteMarked.js).
 * Замок неизменности и RLS стоят на шлюзе, поэтому здесь их копии нет: закрытый
 * документ не удалится и отсюда.
 */
/** «Удаление ничего не удалило» — свой тип, чтобы отличить его от отказа по ссылкам. */
class DeleteRemovedNothing extends Error {
    constructor(message) { super(message); this.name = 'DeleteRemovedNothing'; }
}

async function hardDeleteRecord(params, sessionIDFromRpc) {
    // СЕССИЯ ПРИХОДИТ ДВУМЯ ПУТЯМИ, и оба законны (найдено живым прогоном
    // 02.10.2026). Внутренние вызывающие (`deleteRecord`, обработка удаления
    // помеченных) передают её ВНУТРИ объекта; но функция экспортирована, то есть
    // вызывается и как метод приложения — а туда `sessionID` приходит ВТОРЫМ
    // аргументом (`invokeAppMethod`). Без этой строки такой вызов выполнялся без
    // пользователя: RLS сужала выборку до «ничего», удалялось ноль строк — и
    // функция отвечала «ok». Два обещания одной функции разошлись молча.
    const { tableName, recordId } = params || {};
    const sessionID = (params && params.sessionID) || sessionIDFromRpc || null;
    const globalServerContextLocal = globalServerContext;
    const modelName = globalServerContextLocal.getModelNameForTable(tableName) || tableName;
    const Model = globalServerContextLocal.modelsDB[modelName];
    if (!Model) return { ok: false, error: 'Model not found for table: ' + tableName };

    const delDbGW = require('../../drive_root/dbGateway');

    // Весь каскад + удаление родителя — в ОДНОЙ транзакции: всё или ничего. Если родитель
    // упрётся в RESTRICT (на него ссылаются чужие записи), уже удалённые дети откатятся.
    const t = await Model.sequelize.transaction();
    const affected = new Set();
    try {
        await cascadeDeleteChildren(tableName, [recordId], sessionID, { visited: new Set(), affected, transaction: t });
        // Оповещения документа — в той же транзакции, что и он сам. Внешнего
        // ключа у них нет (ссылка полиморфная: таблица + UID), поэтому снять их
        // обязано ядро — иначе остаются строки, говорящие про документ, которого
        // больше нет, и показать их будет негде и некому.
        try {
            const documentAlerts = require('../../drive_root/db/documentAlerts');
            await documentAlerts.clear({ table: tableName, uid: recordId, transaction: t });
            affected.add(documentAlerts.TABLE);
        } catch (e) {
            console.error('[uniForm] оповещения удаляемого документа не сняты:', e && e.message || e);
        }
        const removed = await delDbGW.execute({ operation: 'delete', table: tableName, where: { UID: recordId }, options: { transaction: t }, context: { appName: 'uniForm', sessionID } });
        // УДАЛЕНИЕ, НЕ УДАЛИВШЕЕ НИ ОДНОЙ СТРОКИ, — НЕ «ОК» (найдено живым
        // прогоном 02.10.2026). `destroy` возвращает число строк и НЕ бросает,
        // когда `where` не совпал ни с чем: запись могли уже удалить, а могла
        // сузить выборку построчная безопасность — и в обоих случаях функция
        // отвечала «ok: true, recordId», то есть врала. Цена этой лжи выросла
        // вместе с механизмами: в той же транзакции снимаются оповещения
        // документа, и «успешное» удаление оставляло ЖИВОЙ документ без них.
        //
        // Исключение здесь, а не `return`: откатить обязана вся транзакция —
        // вместе с удалением табличных частей и оповещений.
        if (!removed) {
            throw new DeleteRemovedNothing(`[uniForm] ${tableName}[${recordId}]: удаление не затронуло ни одной строки`);
        }
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
        if (e instanceof DeleteRemovedNothing) {
            return { ok: false, error: await tForSession('delete_removed_nothing', sessionID) };
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

/**
 * ОПОВЕЩЕНИЯ ОДНОГО ДОКУМЕНТА — для живого обновления панели формы.
 *
 * Открытая форма обязана увидеть новые оповещения без перезагрузки страницы:
 * документ провёлся в фоне (очередь), расхождение появилось или исчезло. Канал
 * тот же, что у списков (`notifyTableChange` по таблице оповещений), а данные —
 * этот метод: пересобирать ради двух строк всю спецификацию формы было бы
 * несоразмерно, а главное — она переписала бы и лейаут, и данные, которые
 * человек в этот момент правит.
 *
 * Читает под сессией ПОЛЬЗОВАТЕЛЯ: чужих оповещений он не увидит тем же кодом,
 * которым не видит чужих документов.
 */
async function documentAlerts(params, sessionID) {
    const tableName = params && (params.tableName || params.dbTable || params.table);
    const recordID = params && (params.recordID || params.recordId || params.uid);
    if (!tableName || !recordID) return { alerts: [] };
    try {
        const alertsApi = require('../../drive_root/db/documentAlerts');
        return { alerts: await alertsApi.forDocument({ table: tableName, uid: recordID, sessionID }) };
    } catch (e) {
        console.error('[uniForm/documentAlerts]', e && e.message || e);
        return { alerts: [] };
    }
}

/**
 * Поставить или снять пометку на удаление.
 *
 * Возвращает ДЕЙСТВИЕ, а не «ок/ошибка»: у нажатия четыре разных исхода, и
 * каждый требует своего вопроса пользователю.
 *
 *   mark           — пометить (запись свободна);
 *   unmark         — снять пометку (уже помечена);
 *   unpostThenMark — документ проведён: сначала снять движения через очередь,
 *                    потом пометить. Пометка поедет в строке очереди
 *                    (`posting_queue.thenMark`) и встанет в той же транзакции,
 *                    что и снятие движений;
 *   refuse         — нельзя вообще (выставленный счёт удалению не подлежит).
 */
async function applyDeletionMark(p) {
    const { Model, tableName, recordId, sessionID, dryRun, unpostFirst } = p;
    const delDbGW = require('../../drive_root/dbGateway');
    const deletionMark = require('../../drive_root/db/deletionMark');

    const rows = await delDbGW.execute({
        operation: 'read', table: tableName, where: { UID: recordId },
        options: { raw: true, limit: 1 }, context: { appName: 'uniForm', sessionID }
    });
    const row = rows && rows[0];
    if (!row) return { ok: false, error: await tForSession('record_not_found', sessionID) };

    const marked = !!row[deletionMark.FIELD];
    let decision = marked
        ? { action: 'unmark' }
        : deletionMark.intent(Model, row, true);

    // На объект ссылается закрытый документ — удалить его нельзя никогда, значит
    // и пометить нельзя (deleteMarked.closedReferrers, 16.10.2026). Проверка
    // асинхронная и потому не внутри `intent`: тому нужна только сама строка.
    if (!marked && decision.action !== 'refuse') {
        let closed = [];
        try {
            closed = await require('../../drive_root/db/deleteMarked').closedReferrers(tableName, recordId, sessionID);
        } catch (e) { closed = []; }
        if (closed.length) {
            decision = {
                action: 'refuse',
                reasonKey: 'deletion_refuse_closed_referrer',
                reasonVars: { docs: closed.slice(0, 3).map(c => c.name).join(', ')
                    + (closed.length > 3 ? ' …' : '') }
            };
        }
    }

    if (decision.action === 'refuse') {
        const msg = await tfForSession(decision.reasonKey, sessionID, decision.reasonVars || {});
        // Пометка запрещена, но прямое удаление может быть разрешено — тогда это
        // не отказ, а единственный оставшийся способ, и клиент обязан его увидеть.
        if (dryRun && deletionMark.canDeleteDirectly(Model, row)) {
            return { ok: true, action: null, marked, direct: true, markRefusal: msg };
        }
        return { ok: false, action: 'refuse', error: msg };
    }

    if (dryRun) {
        // Ответ описывает ОБА способа сразу: клиенту нужно решить, спрашивать ли
        // человека, а для этого он должен знать, есть ли из чего выбирать.
        // «Удалить сразу» спрашивается у ядра ВМЕСТЕ СО СТРОКОЙ: у проведённого
        // документа этого способа нет, как бы ни было объявлено у объекта.
        const direct = deletionMark.canDeleteDirectly(Model, row);
        const out = { ok: true, action: decision.action, marked, direct };
        // ПОЧЕМУ нельзя сразу — для Shift+Del, где человек затребовал именно этот
        // способ. Те же два довода и тексты, что у отказа в `deleteRecord`; без них
        // звучало голое «kann nicht direkt gelöscht werden» (прогон 17.10.2026, H2).
        if (!direct) {
            out.directRefusal = await tForSession(
                deletionMark.readPolicy(Model).direct ? 'deletion_refuse_posted_direct' : 'deletion_refuse_direct_off',
                sessionID);
        }
        return out;
    }

    // Проведённый документ: пометка едет вместе с распроведением, одной задачей.
    if (decision.action === 'unpostThenMark') {
        if (!unpostFirst) {
            // Без явного согласия человека распроведение не запускаем: это
            // учётная операция, а он нажимал «удалить».
            return { ok: false, action: 'unpostThenMark',
                error: await tForSession('deletion_needs_unpost', sessionID) };
        }
        const posting = require('../../drive_root/db/posting');
        const postingQueue = require('../../drive_root/db/postingQueue');
        let userId = null;
        try {
            const u = await globalServerContext.getUserBySessionID(sessionID);
            userId = (u && u.UID) || null;
        } catch (e) { userId = null; }
        await postingQueue.enqueue({
            table: tableName, uid: recordId, action: posting.ACTION.UNPOST,
            requestedBy: userId, byHuman: true, sessionID, thenMark: true
        });
        try { await postingQueue.kick(); } catch (e) { /* подберёт страхующий тик */ }
        try { dynamicTableMethods.notifyTableChange(tableName, 'update', recordId); } catch (e) {}
        return { ok: true, action: 'unpostThenMark', queued: true, recordId };
    }

    const next = !marked;
    await delDbGW.execute({
        operation: 'update', table: tableName, where: { UID: recordId },
        data: { [deletionMark.FIELD]: next },
        context: { appName: 'uniForm', sessionID }
    });
    // ОПОВЕЩЕНИЯ (ТЗ оповещений §6: пометка на удаление — повод пересчёта).
    // Помеченный объект приговорён: требовать по нему действий значит звать к
    // работе над тем, чего не будет. Снятие пометки — обратный повод: документ
    // снова жив, и его оповещения обязаны вернуться (а пуш по вернувшейся
    // причине — это новость, и он уйдёт заново).
    try {
        const documentAlerts = require('../../drive_root/db/documentAlerts');
        if (next) await documentAlerts.clear({ table: tableName, uid: recordId });
        else await documentAlerts.rebuild({ table: tableName, uid: recordId, sessionID });
        dynamicTableMethods.notifyTableChange(documentAlerts.TABLE, 'update', recordId);
    } catch (e) {
        console.error('[uniForm] оповещения при пометке не обновлены:', e && e.message || e);
    }
    try { dynamicTableMethods.notifyTableChange(tableName, 'update', recordId); } catch (e) {}
    return { ok: true, action: next ? 'mark' : 'unmark', marked: next, recordId };
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
    hardDeleteRecord,
    documentAlerts,
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
