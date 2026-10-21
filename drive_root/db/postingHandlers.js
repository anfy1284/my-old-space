'use strict';

/**
 * postingHandlers — реестр ОБРАБОТЧИКОВ ПРОВЕДЕНИЯ приложений.
 *
 * ── Зачем отдельный реестр, если есть `entityHooks.register` ──────────────────
 * Потому что проведение выполняется в ДРУГОМ ПРОЦЕССЕ. Исполнитель очереди —
 * тип регламентной задачи, а задачи планировщика идут в форкнутом воркере
 * (`drive_root/scheduler/worker.js`). `init.js` приложения выполняет ТОЛЬКО
 * главный процесс, поэтому обработчик, зарегистрированный там императивно, в
 * воркере не существует, и проведение падает с «обработчик не зарегистрирован».
 * Поймано живым прогоном: документ ушёл в очередь, воркер его взял и отказался.
 *
 * Ровно та же причина, по которой типы регламентных задач объявляются файлом
 * `scheduler.handlers.js`, а не побочным эффектом `init.js` (см.
 * `drive_root/scheduler/registry.js`). Здесь — тот же приём для той же беды.
 *
 * ── Объявление ───────────────────────────────────────────────────────────────
 * Файл `apps/<app>/posting.handlers.js` — ЧИСТЫЙ МОДУЛЬ-ФАБРИКА без побочных
 * эффектов (его грузят оба процесса):
 *
 *     module.exports = function (modelsDB, Utilities) {
 *         return {
 *             'cash.postReceipt': postReceipt,     // именованные функции,
 *             'cash.postPayment': postPayment      // не анонимные замыкания
 *         };
 *     };
 *
 * Обработчик получает `(doc, ctx)` — см. `drive_root/db/posting.js`.
 *
 * `entityHooks.register` остаётся рабочим запасным путём: механизм проведения
 * ищет обработчика сначала здесь, потом там. Но полагаться на него нельзя —
 * в воркере его не будет.
 */

const appFactories = require('../appFactories');

const HANDLERS_FILE = 'posting.handlers.js';

let _handlers = null;   // Map<name, fn>

/**
 * Загрузить (или перечитать) реестр.
 *
 * Поиск каталогов приложений и вызов фабрик — ядро `drive_root/appFactories.js`:
 * тот же код жил здесь и в реестре регламентных задач дословно, а третьим
 * потребителем стали правила оповещений.
 *
 * @param {object} [modelsDB]
 * @param {object} [Utilities]
 * @returns {Map<string, Function>}
 */
function load(modelsDB, Utilities) {
    _handlers = appFactories.load({
        fileName: HANDLERS_FILE,
        tag: '[postingHandlers]',
        modelsDB, Utilities,
        accept: (name, fn) => (typeof fn === 'function')
            ? { value: fn }
            : { error: `"${name}" не функция` }
    });
    return _handlers;
}

function ensureLoaded(modelsDB, Utilities) {
    if (!_handlers) {
        // `Utilities` ОБЯЗАН доехать до фабрики, даже когда зовущий его не передал.
        // Объявленная сигнатура фабрики — `(modelsDB, Utilities)`, и приложение
        // вправе на неё полагаться; а `resolve()` — единственный реальный
        // вызывающий — зовёт `ensureLoaded()` БЕЗ аргументов. Дефект был
        // невидим, пока ни один обработчик не пользовался утилитами: счёт строит
        // движения из своих строк и `generateUID` не зовёт. Первый, кому
        // понадобилось, упал на `Cannot read properties of undefined` — и упал не
        // при загрузке, а при проведении, то есть в очереди, у 58 документов
        // подряд. Поэтому утилиты берутся из пакета, а не из доверия вызывающему.
        load(modelsDB || appFactories.defaultModels(),
             Utilities || appFactories.defaultUtilities());
    }
    return _handlers;
}

/**
 * Найти обработчик по имени. Сначала файловый реестр (виден обоим процессам),
 * затем `entityHooks` (императивная регистрация, видна только главному).
 * @param {string} name
 * @returns {Function|null}
 */
function resolve(name) {
    if (!name) return null;
    const reg = ensureLoaded();
    const fn = reg.get(name);
    if (fn) return fn;
    try {
        return require('../entityHooks').resolve(name);
    } catch (e) {
        return null;
    }
}

/** Имена всех объявленных обработчиков — для диагностики. */
function list() {
    return Array.from(ensureLoaded().keys());
}

module.exports = { HANDLERS_FILE, load, ensureLoaded, resolve, list };
