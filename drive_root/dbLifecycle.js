'use strict';

/**
 * dbLifecycle — событие `onDatabaseReset` (ТЗ §6.2).
 *
 * ЗАЧЕМ СОБЫТИЕ, А НЕ СПИСОК МЕСТ. По фреймворку размазаны кэши уровня модуля:
 * контекст доступа в `dbGateway`, `_lookupCache` в `getLookupList`, `_fileCache` в
 * `fileStore`, реестр `defaultValues`, лейауты, namespace'ы `memory_store`. Перечислить
 * их в коде восстановления — значит получить список, который устареет через неделю, а
 * пропущенный кэш даст СУБТИЛЬНО неправильную систему (справочник на прежнем языке,
 * права от прежней базы). Это хуже честного падения. Поэтому каждый владелец кэша
 * подписывается САМ, рядом с объявлением своего кэша, а вызывающий знает только
 * `notifyDatabaseReset()`.
 *
 * ЗОВЁТСЯ И ПРИ ОБЫЧНОМ СТАРТЕ, а не только после восстановления. Причина не в том,
 * что при старте кэши грязные (в свежем процессе они пусты), а в том, что
 * `memory_store` — ОТДЕЛЬНЫЙ ПРОЦЕСС и может пережить перезапуск сервера, унеся сессии,
 * роли и справочники предыдущей базы. Плюс единообразие: старт и восстановление идут
 * одним путём.
 *
 * Отсюда требование к подписчикам: **идемпотентность** и безопасность вызова, когда
 * ещё ничего не инициализировано.
 */

const eventBus = require('./eventBus');
const log = require('./log');

const EVENT = 'onDatabaseReset';

/**
 * Подписаться на сброс. Зовётся модулем-владельцем кэша рядом с его объявлением.
 * @param {string} name — чей кэш (для журнала; помогает найти виновника падения)
 * @param {Function} handler — async (ctx) => void
 */
function onDatabaseReset(name, handler) {
    eventBus.on(EVENT, async (ctx) => {
        try {
            await handler(ctx || {});
        } catch (e) {
            // Отказ одного подписчика не должен оставить остальные кэши протухшими:
            // «половина сброшена» — худшее из состояний.
            log.error(`[dbLifecycle] Сброс кэша "${name}" не удался: ${e && e.message || e}`);
        }
    });
}

/**
 * Объявить, что база сменилась (старт, восстановление, сидер).
 * @param {Object} [ctx] — `{ reason: 'startup'|'restore'|'seed' }`
 */
async function notifyDatabaseReset(ctx = {}) {
    const reason = ctx.reason || 'unknown';
    log.info(`[dbLifecycle] Сброс кэшей (${reason})`);
    await eventBus.emit(EVENT, Object.assign({ reason }, ctx));
}

module.exports = { onDatabaseReset, notifyDatabaseReset, EVENT };
