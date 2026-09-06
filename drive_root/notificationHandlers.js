'use strict';

/**
 * Реестр клиентских скриптов, в которых лежат обработчики клика по уведомлению.
 *
 * ЗАЧЕМ ОН ВООБЩЕ НУЖЕН.
 * Уведомление живёт в базе и переживает перезапуск сервера, а обработчик у него —
 * функция в клиентском скрипте. Положить в базу UID скрипта нельзя: `loadScript`
 * (drive_root/fileStore.js) кладёт текст в memory_store и выдаёт СВЕЖИЙ UID на
 * каждом старте процесса — сохранённый вчера UID сегодня уже никуда не ведёт.
 * Поэтому в базе лежит то, что не протухает: ИМЯ ПРИЛОЖЕНИЯ и ИМЯ ФУНКЦИИ, а
 * текущий UID скрипта подставляется здесь, в момент выдачи уведомления клиенту.
 *
 * Такова же логика привязки событий в лейаутах (`events: { onClick: 'fn' }`):
 * живой программист пишет обычную именованную функцию в
 * `forms/<table>.client.js` своего приложения и указывает её ИМЯ — ни замыканий,
 * ни сгенерированных идентификаторов в прикладном коде.
 *
 * КАК ПОЛЬЗОВАТЬСЯ (в `apps/<app>/init.js`, после loadScript):
 *
 *     const clientUID = await loadScript(clientSource, 'user');
 *     require('.../drive_root/notificationHandlers').register('messenger', clientUID);
 *
 * а при постановке уведомления указывается только имя функции:
 *
 *     notify({ userId, appName: 'messenger', title, text,
 *              onClick: { fn: 'openChat', fnParams: { chatId } } });
 */

const log = require('./log');

// appName → UID клиентского скрипта в fileStore (действителен в пределах процесса).
const _scripts = new Map();

/**
 * Объявить, в каком клиентском скрипте искать обработчики приложения.
 * @param {string} appName — имя приложения (как в apps.json)
 * @param {string} clientScriptUID — UID, возвращённый loadScript()
 */
function register(appName, clientScriptUID) {
    if (!appName || !clientScriptUID) {
        log.error('[notificationHandlers] register: нужны appName и UID скрипта');
        return;
    }
    _scripts.set(appName, clientScriptUID);
}

/**
 * UID клиентского скрипта приложения — или null, если приложение обработчиков
 * не объявляло. Null здесь не ошибка: уведомление без обработчика допустимо,
 * оно просто не реагирует на клик.
 */
function getScriptUID(appName) {
    if (!appName) return null;
    return _scripts.get(appName) || null;
}

/** Список приложений, объявивших обработчики (диагностика). */
function listApps() {
    return Array.from(_scripts.keys());
}

module.exports = { register, getScriptUID, listApps };
