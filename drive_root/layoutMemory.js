// layoutMemory.js — реестр форм приложений (серверная сторона).
//
// ── АДРЕС И ПРЕДМЕТ ──────────────────────────────────────────────────────────
//
// Раньше форма адресовалась именем таблицы, и `tableName` делал две разные работы:
// был АДРЕСОМ (по какому ключу искать лейаут) и ПРЕДМЕТОМ (с чем форма работает:
// модель, запись, замок, сохранение, проведение). Форме без предмета — обычному
// прикладному диалогу — жить было негде, и приходилось выдумывать таблицу, которой
// в базе нет (так жило приложение «Удаление помеченных»).
//
// Теперь это две разные вещи:
//
//   АДРЕС   `приложение | имя формы | роль | представление`
//   ПРЕДМЕТ `{ table, kind }` — необязателен, приезжает при открытии формы
//
// Имя ТАБЛИЧНОЙ формы выводится из предмета (`drive_root/formAddress.js`):
// `record:bookings`, `list:bookings`. Руками его выписывать нельзя — один источник
// правды, иначе имя и таблица однажды разойдутся.
//
//   saveLayout({ app: 'booking', subject: { table: 'bookings', kind: 'record' }, … })
//   saveLayout({ app: 'booking', form: 'prepaymentDialog', … })
//
// Лейаут не найден: у табличной формы — автоформа из модели (лучшая функция
// механизма, она сохранена дословно), у именованной — ОШИБКА: строить не из чего.
//
// ── ЧТО СЮДА БОЛЬШЕ НЕ КЛАДУТ ────────────────────────────────────────────────
//
// `events` уехали отсюда в методы формы (`drive_root/formMethods.js`). Событие —
// это метод формы с условленным именем, а не часть её внешнего вида. Пока события
// объявлялись здесь, они формально принадлежали ПРЕДСТАВЛЕНИЮ, и приходилось
// держать заплатку «события читаются всегда из основного представления».
//
// Клиентские события (`clientEvents`) объявляются здесь же, где и клиентский скрипт,
// но на уровне ФОРМЫ, а не представления: переключение вида не должно их терять.
//
// Публичный API:
//   saveLayout({ app, subject|form, roles, layout, … })
//   getLayoutForUser(app, formName, userRole, sessionID, variant) → запись | null
//   getFormMeta(app, formName)        → метаданные формы (синхронно) | null
//   ownerOfSubjectForm(formName)      → приложение-владелец табличной формы | null
//   hasRegistered(app, formName)      → boolean (синхронно, горячий путь)
//   listViewsForUser(app, formName, userRole, sessionID)
//   getUserRoleBySession(sessionID)
//   getTableIcon / getTableCaption / getTableRecordCaption / getTableListIcon
//   registerListSort / getListSort

'use strict';

const memoryStore = require('./memory_store');
const formAddress = require('./formAddress');

const NAMESPACE = 'layouts';

// ── ПРЕДСТАВЛЕНИЯ ────────────────────────────────────────────────────────────
//
// Одной форме можно зарегистрировать НЕСКОЛЬКО лейаутов. Для пользователя это
// «представления»: если ему доступно больше одного, форма показывает в командной
// панели справа кнопку с названием текущего и списком остальных.
//
// Идентификатор представления — `variant` в `saveLayout`. Умолчание `main`, и оно
// входит в ключ НАРАВНЕ с остальными: исключение ради уцелевшего `memory_store`
// отменено — реестр всё равно перезаписывается при каждом старте, а устаревшие
// записи остаются безвредными сиротами.
//
// Доступ отдельным полем НЕ объявляется: для этого уже есть `roles` — то же самое,
// чем лейаут и так выбирается по роли. Второе поле доступа разошлось бы с первым.
//
// `auto` — синтетическое представление «как построит ядро»: та же регистрация, но с
// пустым лейаутом (пустой лейаут и означает «кастомного нет»). Предлагается ТОЛЬКО
// администратору: обычному пользователю выбор между своей формой и сырой
// автоформой ничего не объясняет, а сломать вид ему позволяет.
const MAIN_VARIANT = 'main';
const AUTO_VARIANT = 'auto';

// Какие адреса вообще зарегистрированы: `приложение|имя формы`.
// Проверяется синхронно до любой асинхронной работы — нулевая цена на горячем пути.
const _registeredPrefixes = new Set();

// Какие роли зарегистрировали лейаут по этому адресу. Нужен для подбора лейаута
// администратору: см. getLayoutForUser, шаг 3.
const _registeredRoles = new Map();

// prefix → Map(variant → { roles:Set<string>, caption, isDefault, order })
const _registeredViews = new Map();

// ФОРМА целиком (не представление и не роль): предмет, клиентский скрипт и его
// события, иконки, заголовки, состояние окна, род формы.
//
// Клиентский скрипт и клиентские события лежат ЗДЕСЬ, а не в записи представления,
// ровно по той же причине, по которой серверные события уехали в методы формы:
// переключение вида не должно отключать обработку.
//
// prefix (`приложение|имя формы`) → { app, formName, subject, clientScript,
//   clientEvents, formIcon, listIcon, appCaption, recordCaption, windowState, formKind }
const _formMeta = new Map();

// Имя ТАБЛИЧНОЙ формы → приложение-владелец. Имя выведено из предмета и потому
// уникально по построению: одна таблица — одна форма записи и один журнал.
// Нужен там, где адрес спрашивают, зная только таблицу (открытие записи по ссылке,
// FK-пикер, пункт меню «Администрирование»).
const _subjectOwners = new Map();

// Table-level реестры. Это свойства ТАБЛИЦЫ, а не формы: их спрашивают снаружи
// (главное меню строит пункты по таблицам, «Удаление помеченных» — подписи видов).
const _tableIcons = new Map();          // formIcon — значок записи
const _tableListIcons = new Map();      // listIcon — значок журнала
const _tableCaptions = new Map();       // appCaption — заголовок СПИСКА (мн. ч.)
const _tableRecordCaptions = new Map(); // recordCaption — заголовок ЗАПИСИ (ед. ч.)

// Table-level сортировка списка по умолчанию: tableName → [{ field, order }].
// Регистрируется приложением через registerListSort(); читается дефолтным списком
// uniForm (DynamicTable) как initialSort. Если не задана — список сортируется по name.
const _tableListSort = new Map();

// 5.2 — кэш ПЕРЕВЕДЁННОГО лейаута по ключу `storageKey|language`.
// getLayoutForUser при наличии sessionID делал на КАЖДОЕ открытие формы
// JSON.parse(JSON.stringify(result)) (глубокий клон) + рекурсивный перевод
// всех { i18n: key } captions. Результат детерминирован по (matchedKey, language),
// поэтому кэшируется. Возврат по ссылке безопасен: все потребители uniForm
// (apps/uniForm/server.js) обращаются с результатом как с read-only — поля
// clientScript/иконки/captions только читаются, а .layout перед мутацией повторно
// клонируется → закэшированный объект не мутируется. Кэш ограничен по смыслу
// (число лейаутов × число языков), инвалидируется целиком в saveLayout.
// Выключатель: LAYOUT_TRANSLATE_CACHE_DISABLE=1.
const _translatedCache = new Map();
const _TRANSLATE_CACHE_DISABLED = process.env.LAYOUT_TRANSLATE_CACHE_DISABLE === '1';

// Переведённые лейауты держат подписи на языке прежней базы (справочник `languages`
// и строки `translations` едут внутри дампа). Сами лейауты не сбрасываем: их
// регистрируют `init.js` приложений при старте процесса, а не база.
require('./dbLifecycle').onDatabaseReset('layoutMemory', () => {
    _translatedCache.clear();
});


/**
 * Ключ хранения — АДРЕС формы целиком, единообразно и без исключений.
 * @param {string} app
 * @param {string} formName
 * @param {string} role
 * @param {string} [variant]
 */
function makeKey(app, formName, role, variant) {
    return `${app}|${formName}|${role}|${variant || MAIN_VARIANT}`;
}

/** Адрес формы без роли и представления — им индексируются реестры формы. */
function makePrefix(app, formName) {
    return `${app}|${formName}`;
}

/**
 * Имя формы из объявления: либо выведено из предмета, либо выписано приложением.
 * Ровно одно из двух.
 */
function resolveFormName({ subject, form }) {
    const hasSubject = !!(subject && subject.table);
    if (hasSubject && form) {
        throw new Error('[layoutMemory.saveLayout] укажите либо subject (табличная форма), либо form (именованная) — но не оба: два адреса у одной формы однажды разойдутся');
    }
    if (hasSubject) return formAddress.forSubject(subject.kind, subject.table);
    if (!form) {
        throw new Error('[layoutMemory.saveLayout] нужен subject { table, kind } (табличная форма) или form (имя именованной формы)');
    }
    return formAddress.assertNamed(form);
}

/**
 * Зарегистрировать форму приложения.
 *
 * @param {object}          o
 * @param {string}          o.app            — приложение-ВЛАДЕЛЕЦ ('booking', 'deleteMarked')
 * @param {object}          [o.subject]      — ПРЕДМЕТ формы: { table, kind: 'record'|'list' }
 * @param {string}          [o.form]         — имя именованной формы (форма без предмета)
 * @param {string|string[]} o.roles          — роль(и) или '*' для любой
 * @param {Array}           [o.layout]       — лейаут. Можно НЕ передавать, если задан
 *   `extraButtons`: тогда форма остаётся автогенерируемой (uniForm строит её из модели),
 *   а регистрация добавляет к ней только прикладные кнопки. Это единственный способ
 *   дополнить автоформу таблицы, состав полей которой дописывают другие слои
 *   (напр. `users`: фреймворк + `organizationId` из проекта) — ручной лейаут их потерял бы.
 * @param {Array}           [o.extraButtons] — прикладные кнопки для `commandBar` автоформы
 * @param {string}          [o.clientScript] — UID клиентского скрипта (loadScript)
 * @param {object}          [o.clientEvents] — события формы, обрабатываемые КЛИЕНТОМ:
 *   { onReady: 'onFormReady', onChange: 'onFormChange' }. Серверные события — это
 *   методы формы (`drive_root/formMethods.js`), здесь их нет.
 * @param {string}          [o.formIcon]     — значок записи
 * @param {string}          [o.listIcon]     — значок журнала
 * @param {string|object}   [o.appCaption]   — заголовок списка (строка или { i18n })
 * @param {string|object}   [o.recordCaption]— заголовок записи
 * @param {string}          [o.windowState]  — 'maximized' | 'centered'
 * @param {string}          [o.formKind]     — род формы (внешний вид и заголовки).
 *   Поведением «сохранять/запирать» НЕ управляет: это следует из наличия предмета.
 * @param {string}          [o.variant]      — представление (умолчание 'main')
 * @param {string|object}   [o.viewCaption]  — подпись представления
 * @param {boolean}         [o.isDefault]    — представление по умолчанию
 * @returns {Promise<string>} имя формы (адрес без роли и представления)
 */
async function saveLayout({ app, subject, form, roles, layout, extraButtons, clientScript, clientEvents,
                            formIcon, appCaption, recordCaption, listIcon, windowState, formKind,
                            variant, viewCaption, isDefault }) {
    if (!app || typeof app !== 'string') {
        throw new Error('[layoutMemory.saveLayout] app (string) required — это приложение-ВЛАДЕЛЕЦ формы');
    }
    if (!Array.isArray(layout) && !Array.isArray(extraButtons)) {
        throw new Error('[layoutMemory.saveLayout] нужен layout (Array) или extraButtons (Array) для автогенерируемой формы');
    }
    const formName = resolveFormName({ subject, form });
    const subj = (subject && subject.table)
        ? { table: subject.table, kind: subject.kind === formAddress.KIND_LIST ? formAddress.KIND_LIST : formAddress.KIND_RECORD }
        : null;

    const roleList = Array.isArray(roles) ? roles : (roles ? [String(roles)] : ['*']);
    // layout всегда пишем массивом (потребители различают «нет кастомного лейаута» по
    // пустому массиву, а `undefined` сломал бы разбор записи в getLayoutForUser).
    const storedLayout = Array.isArray(layout) ? layout : [];
    const effectiveVariant = variant || MAIN_VARIANT;
    const prefix = makePrefix(app, formName);

    for (const role of roleList) {
        await memoryStore.set(NAMESPACE, makeKey(app, formName, role, effectiveVariant), {
            layout: storedLayout,
            extraButtons: Array.isArray(extraButtons) ? extraButtons : null
        });
    }

    _registeredPrefixes.add(prefix);

    if (!_registeredRoles.has(prefix)) _registeredRoles.set(prefix, new Set());
    for (const role of roleList) _registeredRoles.get(prefix).add(role);

    if (!_registeredViews.has(prefix)) _registeredViews.set(prefix, new Map());
    const views = _registeredViews.get(prefix);
    const known = views.get(effectiveVariant) || { roles: new Set(), caption: null, isDefault: false, order: views.size };
    for (const role of roleList) known.roles.add(role);
    // Подпись представления необязательна: одиночному лейауту она не нужна —
    // кнопка выбора у него всё равно не появится.
    if (viewCaption) known.caption = viewCaption;
    if (isDefault) known.isDefault = true;
    views.set(effectiveVariant, known);

    // Свойства ФОРМЫ. Пишутся поверх прежних: регистрации разных ролей и представлений
    // одной формы обычно приносят одни и те же значения (см. `common` в приложениях),
    // а пустое поле не должно затирать заполненное.
    const meta = _formMeta.get(prefix) || { app, formName, subject: subj };
    meta.app = app;
    meta.formName = formName;
    if (subj) meta.subject = subj;
    if (clientScript) meta.clientScript = clientScript;
    if (clientEvents) meta.clientEvents = clientEvents;
    if (formIcon) meta.formIcon = formIcon;
    if (listIcon) meta.listIcon = listIcon;
    if (appCaption) meta.appCaption = appCaption;
    if (recordCaption) meta.recordCaption = recordCaption;
    if (windowState) meta.windowState = windowState;
    if (formKind) meta.formKind = formKind;
    _formMeta.set(prefix, meta);

    if (subj) {
        const prevOwner = _subjectOwners.get(formName);
        if (prevOwner && prevOwner !== app) {
            // Две формы записи одной таблицы — это не «последняя побеждает», это ошибка
            // конфигурации, и молча она стоила бы часов поиска.
            console.error(`[layoutMemory] форму «${formName}» регистрируют два приложения: «${prevOwner}» и «${app}». Победит последнее — у таблицы одна форма записи и один журнал.`);
        }
        _subjectOwners.set(formName, app);

        // Значки и заголовки ТАБЛИЦЫ — их спрашивают снаружи, зная только таблицу.
        if (formIcon) _tableIcons.set(subj.table, formIcon);
        if (listIcon) _tableListIcons.set(subj.table, listIcon);
        if (appCaption) _tableCaptions.set(subj.table, appCaption);
        if (recordCaption) _tableRecordCaptions.set(subj.table, recordCaption);
    }

    // 5.2 — лейаут пересохранён → переведённые клоны для его ключей устарели.
    // saveLayout вызывается на старте (и редко в рантайме), поэтому чистим целиком.
    _translatedCache.clear();

    console.log(`[layoutMemory] форма ${app}/${formName} зарегистрирована roles=[${roleList.join(',')}]${effectiveVariant !== MAIN_VARIANT ? ' variant=' + effectiveVariant : ''}`);
    return formName;
}

/**
 * Recursively translate all { i18n: 'key' } caption objects in a layout node tree.
 * Mutates nodes in-place (call only on a deep-cloned layout).
 * @param {Array|object} nodes - layout array or single node
 * @param {Function} tFn - synchronous translate function: (key) => string
 */
function translateLayoutCaptions(nodes, tFn) {
    if (!nodes) return;
    const arr = Array.isArray(nodes) ? nodes : [nodes];
    for (const node of arr) {
        if (!node || typeof node !== 'object') continue;
        if (node.caption && typeof node.caption === 'object' && node.caption.i18n) {
            node.caption = tFn(node.caption.i18n);
        }
        // tooltip — та же природа, что и caption (подпись колонки-значка и т.п.).
        if (node.tooltip && typeof node.tooltip === 'object' && node.tooltip.i18n) {
            node.tooltip = tFn(node.tooltip.i18n);
        }
        // confirm — вопрос перед выполнением команды (кнопка с `command`). Тоже
        // пользовательская строка элемента: перевести её на клиенте нельзя —
        // `__t()` там не функция, а маркер, заменяемый при выдаче файла, и с
        // переменной он не работает (см. fileStore.applyTranslations).
        if (node.confirm && typeof node.confirm === 'object' && node.confirm.i18n) {
            node.confirm = tFn(node.confirm.i18n);
        }
        // enabledWhen.reason — причина отказа у недоступной команды. Та же природа,
        // что confirm: строка элемента, которую клиент показывает как есть.
        if (node.enabledWhen && typeof node.enabledWhen === 'object'
            && node.enabledWhen.reason && typeof node.enabledWhen.reason === 'object'
            && node.enabledWhen.reason.i18n) {
            node.enabledWhen.reason = tFn(node.enabledWhen.reason.i18n);
        }
        if (Array.isArray(node.layout))       translateLayoutCaptions(node.layout, tFn);
        if (Array.isArray(node.columns))       translateLayoutCaptions(node.columns, tFn);
        if (Array.isArray(node.options))       translateLayoutCaptions(node.options, tFn);
        if (Array.isArray(node.extraButtons))  translateLayoutCaptions(node.extraButtons, tFn);
        // menu[] — пункты выпадающего меню (splitButton), у каждого свой caption.
        // При добавлении новой контейнерной ветви — обнови и uniForm.translateLayoutI18n!
        if (Array.isArray(node.menu))          translateLayoutCaptions(node.menu, tFn);
        // tabs[] hold their content in tab.layout / tab.caption — recurse so
        // captions inside tabs (groups, fields AND table columns) get translated.
        if (Array.isArray(node.tabs))          translateLayoutCaptions(node.tabs, tFn);
    }
}

/**
 * Запись формы для роли: лейаут, прикладные кнопки и свойства формы.
 * Возвращает `null`, если по адресу ничего не зарегистрировано.
 *
 * Быстрый путь: если по адресу не сохраняли ничего — синхронный возврат,
 * ни запросов в базу, ни HTTP.
 *
 * @param {string} app
 * @param {string} formName
 * @param {string|null} userRole
 * @param {string} [sessionID] — когда задан, подписи { i18n } переводятся
 * @param {string} [variant]
 * @returns {Promise<object|null>}
 */
async function getLayoutForUser(app, formName, userRole, sessionID, variant) {
    if (!app || !formName) return null;
    const prefix = makePrefix(app, formName);

    // Быстрый путь: по этому адресу ничего не зарегистрировано
    if (!_registeredPrefixes.has(prefix)) return null;

    // Представление «как построит ядро»: та же запись, но с ПУСТЫМ лейаутом —
    // пустой лейаут и означает «кастомного нет». Кнопки, иконки и заголовки
    // остаются: автоформа без них потеряла бы команды приложения.
    if (variant === AUTO_VARIANT) {
        const base = await getLayoutForUser(app, formName, userRole, sessionID, MAIN_VARIANT);
        if (!base) return null;
        const copy = JSON.parse(JSON.stringify(base));
        copy.layout = [];
        return copy;
    }

    const meta = _formMeta.get(prefix) || {};
    let stored = null;
    let matchedKey = null;

    // 1. Точное совпадение роли (in-memory Map → мгновенно)
    if (userRole) {
        const k = makeKey(app, formName, userRole, variant);
        const found = memoryStore.getSync(NAMESPACE, k);
        if (found) { stored = found; matchedKey = k; }
    }

    // 2. Любая роль ('*')
    if (!stored) {
        const k = makeKey(app, formName, '*', variant);
        const found = memoryStore.getSync(NAMESPACE, k);
        if (found) { stored = found; matchedKey = k; }
    }

    // 3. Администратор: любой зарегистрированный лейаут, если своего и общего нет.
    //
    // Права администратора уже сквозные везде: серверные скрипты и файлы отдаются ему
    // без проверки роли, RLS он обходит. Подбор лейаута был строже всего остального,
    // и приложение, объявившее форму как `roles: 'user'` (а так объявлено большинство:
    // имелось в виду «для всех», а не «для роли user»), администратору показывало
    // generic-таблицу вместо своей формы — список броней без вкладки «Календарь»,
    // карточку брони без вкладок. Лечить это в каждом приложении значит ждать, пока
    // каждое следующее наступит на те же грабли.
    //
    // Осознанно РАЗНЫЕ лейауты по ролям это не ломает: у администратора в таком случае
    // есть собственная запись, и она находится точным совпадением на шаге 1.
    if (!stored && String(userRole) === 'admin') {
        const roles = _registeredRoles.get(prefix);
        if (roles && roles.size) {
            // 'user' первым: это конвенция проекта для «формы для всех».
            const candidates = roles.has('user') ? ['user', ...roles] : Array.from(roles);
            for (const role of candidates) {
                if (role === 'admin' || role === '*') continue;
                const k = makeKey(app, formName, role, variant);
                const found = memoryStore.getSync(NAMESPACE, k);
                if (!found) continue;
                stored = found; matchedKey = k;
                break;
            }
        }
    }

    if (!stored) return null;

    // Свойства формы приезжают из `_formMeta`, а не из записи представления:
    // переключение вида не должно терять клиентский скрипт и его события.
    const result = {
        app, formName,
        subject: meta.subject || null,
        layout: Array.isArray(stored.layout) ? stored.layout : [],
        extraButtons: stored.extraButtons || null,
        clientScript: meta.clientScript || null,
        clientEvents: meta.clientEvents || null,
        formIcon: meta.formIcon || null,
        listIcon: meta.listIcon || null,
        appCaption: meta.appCaption || null,
        recordCaption: meta.recordCaption || null,
        windowState: meta.windowState || null,
        formKind: meta.formKind || null
    };

    // Перевод подписей { i18n: 'key' }, когда известна сессия
    if (sessionID) {
        try {
            const formsCtx = require('../drive_forms/globalServerContext');
            const { language } = await formsCtx.getSessionContext(sessionID);
            // 5.2 — переведённый результат детерминирован по (matchedKey, language) → кэш.
            const cacheKey = matchedKey + '|' + (language || '');
            if (!_TRANSLATE_CACHE_DISABLED) {
                const hit = _translatedCache.get(cacheKey);
                if (hit) return hit;
            }
            const i18n = require('./i18n');
            // Глубокий клон: закэшированный оригинал мутировать нельзя
            const cloned = JSON.parse(JSON.stringify(result));
            translateLayoutCaptions(cloned.layout, (key) => i18n.t(key, language));
            if (!_TRANSLATE_CACHE_DISABLED) _translatedCache.set(cacheKey, cloned);
            return cloned;
        } catch (e) {
            console.error('[layoutMemory.getLayoutForUser] i18n translation error:', e && e.message || e);
        }
    }

    return result;
}

/**
 * Свойства формы без учёта роли и представления — синхронно.
 * Нужны до подбора лейаута: по ним ядро узнаёт ПРЕДМЕТ формы (есть он или нет).
 * @param {string} app
 * @param {string} formName
 * @returns {object|null}
 */
function getFormMeta(app, formName) {
    if (!app || !formName) return null;
    return _formMeta.get(makePrefix(app, formName)) || null;
}

/**
 * Приложение-владелец ТАБЛИЧНОЙ формы. Имя выведено из предмета и уникально по
 * построению, поэтому владелец находится, когда известна только таблица.
 * @param {string} formName — 'record:bookings' | 'list:bookings'
 * @returns {string|null}
 */
function ownerOfSubjectForm(formName) {
    return _subjectOwners.get(formName) || null;
}

/**
 * Utility: resolve the role name for a given session ID.
 * Caching is handled inside getUserBySessionID and getUserAccessRole themselves.
 *
 * @param {string} sessionID
 * @returns {Promise<string|null>}
 */
async function getUserRoleBySession(sessionID) {
    if (!sessionID) return null;
    try {
        const globalCtx = require('./globalServerContext');
        const formsCtx = require('../drive_forms/globalServerContext');
        const user = await globalCtx.getUserBySessionID(sessionID);
        if (!user) return null;
        return await formsCtx.getUserAccessRole(user);
    } catch (e) {
        console.error('[layoutMemory.getUserRoleBySession] error:', e && e.message || e);
        return null;
    }
}

/**
 * Синхронная проверка: регистрировали ли что-нибудь по этому адресу?
 * Если нет — асинхронной работы не начинаем вовсе.
 * @param {string} app
 * @param {string} formName
 * @returns {boolean}
 */
function hasRegistered(app, formName) {
    if (!app || !formName) return false;
    return _registeredPrefixes.has(makePrefix(app, formName));
}

/**
 * Get the icon registered for a table (set by any saveLayout with formIcon).
 * @param {string} tableName
 * @returns {string|null}
 */
function getTableIcon(tableName) {
    return _tableIcons.get(tableName) || null;
}

/**
 * Get the caption registered for a table (set by any saveLayout with appCaption).
 * Returns the raw value (string or { i18n: 'key' }) — caller must resolve i18n.
 * @param {string} tableName
 * @returns {string|object|null}
 */
function getTableCaption(tableName) {
    return _tableCaptions.get(tableName) || null;
}

/**
 * Get the singular record-caption registered for a table (saveLayout recordCaption).
 * Used as the record window title prefix (before the record's presentation/name).
 * Returns the raw value (string or { i18n: 'key' }).
 * @param {string} tableName
 * @returns {string|object|null}
 */
function getTableRecordCaption(tableName) {
    return _tableRecordCaptions.get(tableName) || null;
}

/**
 * Get the list-mode icon registered for a table (saveLayout listIcon).
 * @param {string} tableName
 * @returns {string|null}
 */
function getTableListIcon(tableName) {
    return _tableListIcons.get(tableName) || null;
}

/**
 * Register a default list sort for a table (used by the auto-generated DynamicTable list).
 * @param {string} tableName
 * @param {Array<{field:string, order:string}>} sort — e.g. [{ field: 'number', order: 'desc' }]
 */
function registerListSort(tableName, sort) {
    if (!tableName || !Array.isArray(sort)) return;
    _tableListSort.set(tableName, sort);
}

/**
 * Get the default list sort for a table, or null.
 * @param {string} tableName
 * @returns {Array<{field:string, order:string}>|null}
 */
function getListSort(tableName) {
    return _tableListSort.get(tableName) || null;
}

/**
 * Представления, доступные этому пользователю для формы.
 *
 * Возвращает ПУСТОЙ массив, когда выбирать не из чего (одно представление): кнопка
 * выбора не должна появляться там, где она ничего не делает.
 *
 * Администратор видит все зарегистрированные представления и вдобавок
 * «автоматическое» — форму, какой её построит ядро из модели. Именно так он
 * сравнивает свою форму с тем, что даёт ядро, не правя конфигурацию.
 *
 * @param {string} app
 * @param {string} formName
 * @param {string|null} userRole
 * @param {string} [sessionID] — когда задан, подписи { i18n } переводятся
 * @returns {Promise<Array<{variant:string, caption:string, isDefault:boolean}>>}
 */
async function listViewsForUser(app, formName, userRole, sessionID) {
    if (!app || !formName) return [];
    const views = _registeredViews.get(makePrefix(app, formName));
    if (!views || !views.size) return [];

    const isAdmin = String(userRole) === 'admin';
    const out = [];
    for (const [variant, info] of views) {
        // Доступ — тот же `roles`, которым лейаут и выбирается. Администратор видит
        // всё: его права сквозные везде, и подбор лейаута уже устроен так же.
        if (!isAdmin && !info.roles.has(userRole) && !info.roles.has('*')) continue;
        out.push({
            variant,
            caption: info.caption || { i18n: variant === MAIN_VARIANT ? 'view_main' : ('view_' + variant) },
            isDefault: !!info.isDefault,
            order: info.order
        });
    }
    if (!out.length) return [];
    if (isAdmin) {
        out.push({ variant: AUTO_VARIANT, caption: { i18n: 'view_auto' }, isDefault: false, order: 9999 });
    }
    // Одно представление — выбирать не из чего.
    if (out.length < 2) return [];

    out.sort((a, b) => a.order - b.order);
    // Ни одно не объявлено основным — основным считается первое зарегистрированное.
    if (!out.some(v => v.isDefault)) out[0].isDefault = true;

    let language = null;
    if (sessionID) {
        try {
            const formsCtx = require('../drive_forms/globalServerContext');
            language = (await formsCtx.getSessionContext(sessionID)).language;
        } catch (e) { /* без сессии отдадим ключи как есть */ }
    }
    const i18n = require('./i18n');
    return out.map(v => ({
        variant: v.variant,
        caption: (v.caption && typeof v.caption === 'object' && v.caption.i18n)
            ? (language ? i18n.t(v.caption.i18n, language) : v.caption.i18n)
            : String(v.caption),
        isDefault: v.isDefault
    }));
}

module.exports = {
    saveLayout, getLayoutForUser, getFormMeta, ownerOfSubjectForm,
    listViewsForUser, getUserRoleBySession, hasRegistered,
    getTableIcon, getTableCaption, getTableRecordCaption, getTableListIcon,
    registerListSort, getListSort,
    MAIN_VARIANT, AUTO_VARIANT
};
