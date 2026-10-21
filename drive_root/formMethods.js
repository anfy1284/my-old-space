'use strict';

/**
 * formMethods.js — МЕТОДЫ формы и МЕТОДЫ приложения.
 *
 * Второй потребитель ядра `methodStore.js` (первый — `serverScriptStore`,
 * скрипты по имени). Разница в адресации, а не в механизме:
 *
 *   методы ФОРМЫ       — принадлежат одной форме, находятся по её адресу;
 *   методы ПРИЛОЖЕНИЯ  — общие для нескольких его форм.
 *
 * До этого места такого не было вовсе: общий метод оседал в скрипте случайной
 * формы, а событие формы объявлялось в `saveLayout` и потому формально
 * принадлежало ПРЕДСТАВЛЕНИЮ. Отсюда была заплатка «события читаются всегда из
 * основного представления»: иначе переключение вида отключило бы обработку
 * сохранения. Заплатка снята вместе с причиной.
 *
 * СОБЫТИЕ ФОРМЫ — это её метод с условленным именем, объявленный там же, где
 * остальные. Лейаут описывает внешний вид и про серверную логику не знает.
 * Условленные имена (зовёт ядро, `apps/uniForm/server.js`):
 *
 *   onLoadData({ tableName, form, params }, ctx) → { data, caption }
 *       данные загружает приложение (виртуальные списки, экраны настроек, диалоги)
 *   onBeforeSave({ changes, tableName, ... }, ctx)
 *       точка валидации: исключение отменяет сохранение
 *   onSave({ changes, tableName }, ctx) → { ok, error }
 *       сохранение целиком на приложении (EAV и другие виртуальные таблицы)
 *
 * Разрешение метода: сначала СВОЙ метод формы, потом общий метод приложения.
 * Так форма переопределяет общий метод, не переименовывая его у всех остальных.
 *
 * Публичный API:
 *   register({ app, subject | form, methods, roles })  → адрес формы
 *   registerApp({ app, methods, roles })               → имя приложения
 *   resolve({ app, form, method, userRole })           → function | null
 *   describe({ app, form })                            → строка для сообщения об ошибке
 */

const methodStore = require('./methodStore');
const formAddress = require('./formAddress');

/** Область методов формы. */
function formScope(app, formName) {
    return `form:${app}|${formName}`;
}

/** Область общих методов приложения. */
function appScope(app) {
    return `app:${app}`;
}

/**
 * Имя формы из объявления: либо выведено из предмета, либо выписано приложением.
 * Ровно одно из двух — два адреса у одной формы однажды разойдутся.
 */
function resolveFormName({ subject, form }) {
    const hasSubject = !!(subject && subject.table);
    if (hasSubject && form) {
        throw new Error('[formMethods] укажите либо subject (табличная форма), либо form (именованная) — но не оба');
    }
    if (hasSubject) return formAddress.forSubject(subject.kind, subject.table);
    return formAddress.assertNamed(form);
}

/**
 * Серверные методы ФОРМЫ.
 *
 * @param {object}          o
 * @param {string}          o.app      — приложение-владелец ('booking')
 * @param {object}          [o.subject]— { table, kind } для табличной формы
 * @param {string}          [o.form]   — имя именованной формы
 * @param {object}          o.methods  — { имяМетода: fn }
 * @param {string|string[]} o.roles    — кому разрешён вызов (НЕ '*': см. methodStore)
 * @returns {string} имя формы
 */
function register({ app, subject, form, methods, roles }) {
    if (!app || typeof app !== 'string') throw new Error('[formMethods.register] app (string) required');
    const formName = resolveFormName({ subject, form });
    methodStore.register(formScope(app, formName), methods, roles || 'user');
    return formName;
}

/**
 * ОБЩИЕ методы приложения — то, что нужно нескольким его формам.
 *
 * @param {object}          o
 * @param {string}          o.app
 * @param {object}          o.methods
 * @param {string|string[]} o.roles
 * @returns {string} имя приложения
 */
function registerApp({ app, methods, roles }) {
    if (!app || typeof app !== 'string') throw new Error('[formMethods.registerApp] app (string) required');
    methodStore.register(appScope(app), methods, roles || 'user');
    return app;
}

/**
 * Метод формы по имени: сначала свой, потом общий метод приложения.
 *
 * Возвращает `null` и когда метода нет, и когда роль не пускает — различать их
 * вызывающему не нужно: в обоих случаях «этого метода для тебя нет».
 *
 * @param {object} o
 * @param {string} o.app
 * @param {string} o.form     — имя формы (канон `record:<таблица>` или своё)
 * @param {string} o.method
 * @param {string|string[]} o.userRole
 * @returns {Function|null}
 */
function resolve({ app, form, method, userRole }) {
    if (!app || !form || !method) return null;
    const own = methodStore.get(formScope(app, form), userRole);
    if (own && typeof own.methods[method] === 'function') return own.methods[method];
    const shared = methodStore.get(appScope(app), userRole);
    if (shared && typeof shared.methods[method] === 'function') return shared.methods[method];
    return null;
}

/** Есть ли у формы хоть какие-то свои методы (без проверки роли). */
function hasFormMethods(app, formName) {
    return methodStore.has(formScope(app, formName));
}

/** Текст для сообщения об ошибке: что вообще зарегистрировано у этого адреса. */
function describe({ app, form }) {
    const own = methodStore.has(formScope(app, form));
    const shared = methodStore.has(appScope(app));
    return `методы формы: ${own ? 'есть' : 'НЕ зарегистрированы'}; общие методы приложения «${app}»: ${shared ? 'есть' : 'НЕ зарегистрированы'}`;
}

module.exports = { register, registerApp, resolve, hasFormMethods, describe, formScope, appScope };
