'use strict';

/**
 * Серверный модуль формы «Настройки».
 *
 * Одна форма на все уровни (см. tmp/ТЗ_НАСТРОЙКИ_ПРИЛОЖЕНИЙ.md, §9): сверху выбор уровня
 * и записи-владельца, ниже вкладки по приложениям. Состав полей берётся из реестра
 * объявлений (`drive_root/settings/registry`), значения — через серверный API
 * (`drive_root/settings`).
 *
 * ── Почему лейаут один, а вкладки прячутся ───────────────────────────────────
 * Смена уровня меняет весь состав полей. Перестраивать лейаут в рантайме форма не
 * умеет, поэтому лейаут содержит вкладки ВСЕХ уровней, а показывается та группа, что
 * соответствует выбранному уровню (`visibleWhen` вкладки — тот же механизм, что у
 * коррекции счёта). Значения при переключении догружаются одним RPC.
 *
 * ── Почему лейаутов два ──────────────────────────────────────────────────────
 * Администратору видны уровни «Система» и «Значения по умолчанию» и настройки с
 * `visibility: "admin"`; обычному пользователю — нет. Прятать их на клиенте нельзя:
 * подписи скрытых настроек всё равно уехали бы в браузер. Поэтому `init.js`
 * регистрирует лейаут дважды — полный для роли `admin` и урезанный для остальных.
 *
 * ── Права ────────────────────────────────────────────────────────────────────
 * Клиент присылает уровень и UID записи. Доверять им нельзя, поэтому:
 *   уровень `user`         — только сам пользователь, либо администратор;
 *   уровни `system`/`default` — только администратор;
 *   любой другой уровень   — запись проверяется ТЕМ ЖЕ RLS (`dbGateway.execute` с
 *                            сессией пользователя): не видна — значит нельзя. Своей
 *                            копии правил доступа здесь нет.
 *
 * @module apps/settings/forms/app_settings.server
 */

const registry     = require('../../../drive_root/settings/registry');
const settingsApi  = require('../../../drive_root/settings');
const globalRootCtx = require('../../../drive_root/globalServerContext');
const dbGateway    = require('../../../drive_root/dbGateway');
const log          = require('../../../drive_root/log');
const { tForSession, invalidateSessionContext } = require('../../../drive_forms/globalServerContext');

/** Виртуальные поля формы (не настройки, а выбор области действия). */
const SCOPE_FIELD = '__scope';
const AUTOFILL    = 'autofill';

/** Поле-селектор записи для уровня: у каждого уровня свой, показывается один. */
function recordField(scopeName) {
    return '__rec_' + scopeName;
}

/**
 * Имя поля настройки в форме. Ключ уникален в пределах приложения, поэтому пара
 * «приложение + ключ» уникальна во всей форме.
 */
function fieldName(appName, key) {
    return appName + '__' + key;
}

// ── Реестр → состав формы ────────────────────────────────────────────────────

/** Уровни, доступные роли и имеющие хоть одну видимую настройку. */
function visibleScopes(isAdmin) {
    const out = [];
    for (const scope of registry.getScopes()) {
        if (scope.broken) continue;
        if (scope.adminOnly && !isAdmin) continue;
        if (scope.name === 'default') { out.push(scope); continue; }   // дефолты всех настроек
        if (!scope.assignable) continue;
        if (settingsOfScope(scope.name, isAdmin).length) out.push(scope);
    }
    return out;
}

/** Настройки уровня, видимые роли. */
function settingsOfScope(scopeName, isAdmin) {
    const out = [];
    for (const app of registry.getApps()) {
        for (const decl of registry.getSettings(app.name)) {
            if (decl.scope !== scopeName) continue;
            if (decl.visibility === 'admin' && !isAdmin) continue;
            out.push(decl);
        }
    }
    return out;
}

/** Все настройки, видимые роли (для уровня «значения по умолчанию» и для сохранения). */
function allVisibleSettings(isAdmin) {
    const out = [];
    for (const app of registry.getApps()) {
        for (const decl of registry.getSettings(app.name)) {
            if (decl.visibility === 'admin' && !isAdmin) continue;
            out.push(decl);
        }
    }
    return out;
}

// ── Лейаут ───────────────────────────────────────────────────────────────────

/** Контрол по объявлению настройки. */
function controlFor(decl) {
    const name = fieldName(decl.app, decl.key);
    const ctrl = { name, data: name, caption: decl.caption };
    if (decl.hint) ctrl.tooltip = decl.hint;

    switch (decl.type) {
        case 'boolean':
            ctrl.type = 'checkbox';
            break;
        case 'number':
            ctrl.type = 'number';
            break;
        case 'date':
            ctrl.type = 'date';
            break;
        case 'text':
            ctrl.type = 'textarea';
            break;
        case 'enum':
            // Радио показывает все варианты сразу, список их прячет. Для двух-трёх
            // взаимоисключающих режимов это важнее компактности, поэтому выбор контрола
            // отдан объявлению (`control`), а не угадывается по числу вариантов.
            ctrl.type = (decl.control === 'radio') ? 'radioGroup' : 'emunList';
            ctrl.options = (decl.options || []).map(o => ({ value: o.value, caption: o.caption || String(o.value) }));
            break;
        case 'reference':
            ctrl.type = 'recordSelector';
            ctrl.properties = {
                selection: { table: decl.reference.table, idField: 'UID', displayField: decl.reference.displayField }
            };
            break;
        case 'money':
        case 'string':
        default:
            ctrl.type = 'textbox';
            break;
    }
    return ctrl;
}

/** Настройки приложения → группы контролов (по `group`, порядок — из объявлений). */
function groupsFor(settings) {
    const buckets = [];
    const index = new Map();
    for (const decl of settings) {
        const key = decl.group ? JSON.stringify(decl.group) : '';
        if (!index.has(key)) {
            const bucket = { caption: decl.group || null, controls: [] };
            index.set(key, bucket);
            buckets.push(bucket);
        }
        index.get(key).controls.push(controlFor(decl));
    }
    return buckets.map(b => ({
        type: 'group',
        caption: b.caption || undefined,
        orientation: 'vertical',
        alignFields: true,
        layout: b.controls
    }));
}

/**
 * Лейаут формы.
 * @param {boolean} isAdmin — полный вариант (уровни системы и дефолтов, скрытые настройки)
 */
function buildLayout(isAdmin) {
    const scopes = visibleScopes(isAdmin);
    const hasDefault = scopes.some(s => s.name === 'default');

    // Шапка: уровень + селекторы записи (по одному на уровень, показывается нужный).
    const header = [{
        type: 'emunList',
        name: SCOPE_FIELD,
        data: SCOPE_FIELD,
        caption: { i18n: 'settings_level' },
        options: scopes.map(s => ({ value: s.name, caption: s.caption })),
        events: { onChange: 'onScopeChanged' }
    }];

    for (const scope of scopes) {
        if (scope.ownerless) continue;
        const ctrl = {
            type: 'recordSelector',
            name: recordField(scope.name),
            data: recordField(scope.name),
            caption: scope.caption,
            properties: {
                selection: { table: scope.table, idField: 'UID', displayField: scope.displayField }
            },
            events: { onChange: 'onRecordChanged' }
        };
        // Обычный пользователь правит только свои настройки: селектор заблокирован и
        // показывает его самого. Проверка всё равно на сервере — это лишь честный вид.
        if (scope.name === 'user' && !isAdmin) ctrl.readOnly = true;
        header.push(ctrl);
    }

    // Вкладки: пара «уровень + приложение». На уровне «значения по умолчанию» видны все.
    const tabs = [];
    for (const scope of scopes) {
        if (scope.name === 'default' || !scope.assignable) continue;
        for (const app of registry.getApps()) {
            const settings = registry.getSettings(app.name)
                .filter(d => d.scope === scope.name)
                .filter(d => isAdmin || d.visibility !== 'admin');
            if (!settings.length) continue;
            const shownAt = hasDefault ? [scope.name, 'default'] : [scope.name];
            tabs.push({
                caption: app.caption,
                icon: app.icon || undefined,
                visibleWhen: { field: SCOPE_FIELD, in: shownAt },
                layout: groupsFor(settings)
            });
        }
    }

    // Автозаполнение — отдельный механизм (умолчания полей по таблицам), но живёт оно
    // у пользователя, поэтому и здесь на уровне пользователя. См. §9.3 ТЗ.
    tabs.push({
        caption: { i18n: 'Autofill' },
        icon: '/apps/general_icons/resources/public/16x16/edit.png',
        visibleWhen: { field: SCOPE_FIELD, in: ['user'] },
        layout: [{
            type: 'table',
            name: AUTOFILL,
            data: AUTOFILL,
            properties: { editMode: 'cell-immediate', visibleRows: 8, hiddenButtons: ['listSettings', 'recordOpen'] },
            columns: [
                {
                    caption: { i18n: 'Table' }, data: 'tableName', width: 250, inputType: 'recordSelector',
                    properties: {
                        showSelectionButton: true,
                        selection: { table: 'user_settings_table_list', idField: 'UID', displayField: 'tableLabel' }
                    }
                },
                {
                    caption: { i18n: 'Record' }, data: 'recordId', width: 300, inputType: 'recordSelector',
                    properties: {
                        showSelectionButton: true,
                        selection: { table: '{tableName}', idField: 'UID', displayField: 'name' }
                    }
                }
            ]
        }]
    });

    return [
        {
            type: 'commandBar',
            extraButtons: [
                {
                    name: 'btnApply',
                    caption: { i18n: 'Apply' },
                    icon: '/apps/general_icons/resources/public/16x16/save.png',
                    events: { onClick: 'applySettings' }
                },
                {
                    name: 'btnChangePassword',
                    caption: { i18n: 'cp_btn_open' },
                    icon: '/apps/general_icons/resources/public/16x16/user.png',
                    events: { onClick: 'openChangePassword' }
                }
            ]
        },
        {
            type: 'group',
            caption: { i18n: 'settings_target_group' },
            orientation: 'vertical',
            alignFields: true,
            layout: header
        },
        { type: 'tabs', name: 'settingsTabs', tabs }
    ];
}

// ── Доступ ───────────────────────────────────────────────────────────────────

function isAdminCtx(ctx) {
    return String(ctx && ctx.role) === 'admin';
}

/**
 * Запись уровня, доступная пользователю по RLS.
 * @returns {Promise<Array<Object>>}
 */
async function scopeRecords(scope, sessionID, where) {
    try {
        const rows = await dbGateway.execute({
            operation: 'read',
            table: scope.table,
            where: where || {},
            context: { sessionID }
        });
        return Array.isArray(rows) ? rows : [];
    } catch (e) {
        log.error('[settings/form] чтение записей уровня', scope.name, e && e.message);
        return [];
    }
}

/** Проверка права работать с уровнем и записью. `null` — можно, строка — причина отказа. */
async function denyReason(scope, recordId, ctx) {
    if (!scope) return 'unknown_scope';
    if (scope.adminOnly && !isAdminCtx(ctx)) return 'not_admin';
    if (scope.ownerless) return null;
    if (!recordId) return 'no_record';

    if (scope.table === 'users' && !isAdminCtx(ctx)) {
        const user = await globalRootCtx.getUserBySessionID(ctx.sessionID);
        return (user && user.UID === recordId) ? null : 'not_own_user';
    }
    // Все прочие уровни — тем же RLS, каким система показывает сами записи.
    const rows = await scopeRecords(scope, ctx.sessionID, { UID: recordId });
    return rows.length ? null : 'record_not_visible';
}

/** Запись уровня по умолчанию при открытии формы. */
async function defaultRecordId(scope, ctx) {
    if (!scope || scope.ownerless) return null;
    if (scope.table === 'users') {
        const user = await globalRootCtx.getUserBySessionID(ctx.sessionID);
        return user ? user.UID : null;
    }
    const rows = await scopeRecords(scope, ctx.sessionID);
    return rows.length ? rows[0].UID : null;
}

/** Представление записи уровня (для селектора). */
async function recordDisplay(scope, recordId, ctx) {
    if (!scope || scope.ownerless || !recordId) return '';
    const rows = await scopeRecords(scope, ctx.sessionID, { UID: recordId });
    const row = rows[0];
    if (!row) return '';
    return row[scope.displayField] || row.name || recordId;
}

// ── Значения ─────────────────────────────────────────────────────────────────

/** Представление значения-ссылки (что показать в поле выбора). */
async function referenceDisplay(decl, value) {
    if (!value) return undefined;
    const models = globalRootCtx.modelsDB || {};
    for (const name of Object.keys(models)) {
        const model = models[name];
        if (!model || model.tableName !== decl.reference.table) continue;
        try {
            const rec = await model.findByPk(String(value), { raw: true });
            if (rec) return rec[decl.reference.displayField] || rec.name || undefined;
        } catch (e) {
            log.warn('[settings/form] представление ссылки', decl.app + '.' + decl.key, e && e.message);
        }
        break;
    }
    return undefined;
}

/**
 * Совпадают ли значения «как в форме» и «как сейчас в системе».
 *
 * Сравнение идёт по сериализованному виду: форма присылает строки («45», «true»), а
 * из механизма приходит типизированное значение. Сравнивать их напрямую нельзя —
 * каждое сохранение выглядело бы правкой.
 */
function sameValue(decl, a, b) {
    const types = settingsApi.types;
    const sa = types.serialize(decl, a);
    const sb = types.serialize(decl, b);
    if (sa instanceof Date || sb instanceof Date) return String(sa) === String(sb);
    return String(sa === null || sa === undefined ? '' : sa) === String(sb === null || sb === undefined ? '' : sb);
}

/** Одно значение настройки на выбранном уровне. */
async function readValue(decl, scopeName, recordId) {
    if (scopeName === 'default') return settingsApi.getDefault(decl.app, decl.key);
    if (decl.scope === 'system') return settingsApi.getSystemSetting(decl.app, decl.key);
    return settingsApi.getRecordSetting(decl.scope, recordId, decl.app, decl.key);
}

/**
 * Значения для выбранного уровня: [{ name, value, display }].
 * На уровне «значения по умолчанию» отдаются дефолты ВСЕХ настроек — вкладки там видны все.
 */
async function collectValues(scopeName, recordId, isAdmin) {
    const declarations = (scopeName === 'default')
        ? allVisibleSettings(isAdmin)
        : settingsOfScope(scopeName, isAdmin);

    const out = [];
    for (const decl of declarations) {
        let value = null;
        try {
            value = await readValue(decl, scopeName, recordId);
        } catch (e) {
            log.error('[settings/form] чтение', decl.app + '.' + decl.key, e && e.message);
        }
        const item = { name: fieldName(decl.app, decl.key), value };
        if (decl.type === 'date' && value instanceof Date) item.value = value.toISOString();
        if (decl.type === 'reference') {
            const display = await referenceDisplay(decl, value);
            if (display !== undefined) item.display = display;
        }
        out.push(item);
    }
    return out;
}

// ── Автозаполнение (существующий механизм, значения по таблицам) ─────────────

async function loadAutofill(userId, modelsDB) {
    if (!userId || !modelsDB || !modelsDB.UserSettingsDefaults) return [];
    try {
        const rows = await modelsDB.UserSettingsDefaults.findAll({
            where: { userId }, order: [['tableLabel', 'ASC']], raw: true
        });
        for (const r of rows) {
            r.__tableName_display = r.tableLabel || r.tableName;
            r.__recordId_display  = r.recordLabel || r.recordId;
        }
        return rows;
    } catch (e) {
        log.error('[settings/form] автозаполнение, чтение:', e && e.message);
        return [];
    }
}

async function saveAutofill(userId, rows, modelsDB) {
    if (!userId || !modelsDB || !modelsDB.UserSettingsDefaults) return;
    await modelsDB.UserSettingsDefaults.destroy({ where: { userId } });
    for (const row of (rows || [])) {
        if (!row.tableName || !row.recordId) continue;
        await modelsDB.UserSettingsDefaults.create({
            UID:         row.UID,
            userId:      userId,
            tableName:   row.tableName,
            tableLabel:  row.__tableName_display || row.tableLabel || row.tableName,
            recordId:    row.recordId,
            recordLabel: row.__recordId_display  || row.recordLabel || row.recordId
        });
    }
}

// ── Модуль-фабрика: RPC ──────────────────────────────────────────────────────

module.exports = function factory(modelsDB, Utilities) {

    /** Стартовое состояние формы: уровень, запись, значения, автозаполнение. */
    async function onLoadData({ params }, ctx) {
        registry.ensureLoaded();
        const isAdmin = isAdminCtx(ctx);
        const scopes = visibleScopes(isAdmin);
        if (!scopes.length) return { data: [], caption: await tForSession('settings_app_caption', ctx.sessionID) };

        const wanted = params && params.scope;
        const scope = scopes.find(s => s.name === wanted) || scopes[0];
        const recordId = (params && params.recordId) || await defaultRecordId(scope, ctx);

        const data = [{ name: SCOPE_FIELD, value: scope.name }];

        for (const s of scopes) {
            if (s.ownerless) continue;
            const id = (s.name === scope.name) ? recordId : await defaultRecordId(s, ctx);
            const display = await recordDisplay(s, id, ctx);
            const item = { name: recordField(s.name), value: id || null };
            if (id) item.selection = { id, display };
            data.push(item);
        }

        const reason = await denyReason(scope, recordId, ctx);
        if (!reason) {
            for (const v of await collectValues(scope.name, recordId, isAdmin)) {
                const item = { name: v.name, value: v.value };
                if (v.display !== undefined && v.value) item.selection = { id: v.value, display: v.display };
                data.push(item);
            }
        }

        const user = await globalRootCtx.getUserBySessionID(ctx.sessionID);
        const autofillUser = (scope.name === 'user' && recordId) ? recordId : (user ? user.UID : null);
        data.push({ name: AUTOFILL, tableName: AUTOFILL, tabularSection: true, value: await loadAutofill(autofillUser, modelsDB) });

        return {
            data,
            caption: await tForSession('settings_app_caption', ctx.sessionID)
        };
    }

    /** Кто я и админ ли — клиенту, чтобы гасить «Сменить пароль» на чужом пользователе. */
    async function formState(_params, ctx) {
        const user = await globalRootCtx.getUserBySessionID(ctx.sessionID);
        return { me: user ? user.UID : null, isAdmin: isAdminCtx(ctx) };
    }

    /** Перезагрузка значений под выбранные уровень и запись (клиент: смена селекторов). */
    async function loadForScope({ scope: scopeName, recordId }, ctx) {
        registry.ensureLoaded();
        const isAdmin = isAdminCtx(ctx);
        const scope = registry.getScope(scopeName);
        const reason = await denyReason(scope, recordId, ctx);
        if (reason) return { error: await tForSession('User not authorized', ctx.sessionID), reason };

        const result = {
            scope: scopeName,
            recordId: recordId || null,
            values: await collectValues(scopeName, recordId, isAdmin)
        };
        if (scopeName === 'user' && recordId) result.autofill = await loadAutofill(recordId, modelsDB);
        return result;
    }

    /** Сохранение настроек выбранного уровня. */
    async function onSave({ changes }, ctx) {
        registry.ensureLoaded();
        const isAdmin = isAdminCtx(ctx);
        const plain = Object.assign({}, changes || {});
        const tabular = plain.__tabularSections || {};
        delete plain.__tabularSections;

        const scopeName = plain[SCOPE_FIELD];
        const scope = registry.getScope(scopeName);
        const recordId = scope && !scope.ownerless ? plain[recordField(scopeName)] : null;

        const reason = await denyReason(scope, recordId, ctx);
        if (reason) {
            log.warn('[settings/form] отказ в сохранении:', reason, 'уровень', scopeName, 'запись', recordId);
            return { ok: false, error: await tForSession('User not authorized', ctx.sessionID) };
        }

        const declarations = (scopeName === 'default')
            ? allVisibleSettings(isAdmin)
            : settingsOfScope(scopeName, isAdmin);

        const user = await globalRootCtx.getUserBySessionID(ctx.sessionID);
        let languageChanged = false;

        for (const decl of declarations) {
            const field = fieldName(decl.app, decl.key);
            if (!(field in plain)) continue;
            const value = plain[field];

            // Форма присылает ВСЕ поля уровня, а не только изменённые. Записывать их все
            // нельзя: настройка, которую никто не трогал, получила бы собственное значение,
            // равное текущему умолчанию, и правка умолчания её больше не касалась бы —
            // «пусто = работает дефолт» перестало бы работать после первого же сохранения.
            // Поэтому сравниваем с тем, что форма показывала, и молчащие поля пропускаем.
            let before = null;
            try { before = await readValue(decl, scopeName, recordId); } catch (e) { before = null; }
            if (sameValue(decl, value, before)) continue;

            // Смена языка интерфейса СЕБЕ — клиенту придётся перезагрузить страницу
            // (бандлы переводятся под язык сессии). Чужому пользователю страницу не
            // перезагружаем: он увидит новый язык при следующем входе.
            const isOwnLanguage = decl.app === registry.CORE_APP && decl.key === 'language'
                && scopeName === 'user' && user && user.UID === recordId;

            try {
                if (scopeName === 'default') {
                    await settingsApi.setDefault(decl.app, decl.key, value);
                } else if (decl.scope === 'system') {
                    await settingsApi.setSystemSetting(decl.app, decl.key, value);
                } else {
                    await settingsApi.setRecordSetting(decl.scope, recordId, decl.app, decl.key, value);
                }
            } catch (e) {
                log.error('[settings/form] запись', decl.app + '.' + decl.key, e && e.message);
                return { ok: false, error: e.message };
            }

            if (isOwnLanguage) languageChanged = true;
        }

        if (scopeName === 'user' && recordId && Array.isArray(tabular[AUTOFILL])) {
            await saveAutofill(recordId, tabular[AUTOFILL], modelsDB);
        }

        if (languageChanged) invalidateSessionContext(ctx.sessionID);
        return { ok: true, languageChanged };
    }

    return { onLoadData, loadForScope, onSave, formState };
};

module.exports.buildLayout = buildLayout;
module.exports.SCOPE_FIELD = SCOPE_FIELD;
module.exports.recordField = recordField;
module.exports.fieldName = fieldName;
