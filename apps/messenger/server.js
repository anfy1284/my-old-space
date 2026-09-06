'use strict';

/**
 * HTTP-слой мессенджера — ровно один маршрут: выдача вложения.
 *
 * Почему он отдельно от `forms/messenger.server.js`, где лежит вся логика:
 * обычные методы формы ходят через `/server-call` и возвращают JSON, а картинку
 * в ленте браузер должен получить БИНАРНО, по адресу в `<img src>`. Такой ответ
 * умеет только маршрут приложения (`/app/<app>/<метод>`): туда приходят `req` и
 * `res`, и ответ можно записать самому, вернув `{ _handled: true }`.
 *
 * Права проверяет не этот слой, а `readAttachment` в модуле формы: вложение
 * отдаётся только участнику чата, которому принадлежит сообщение. Здесь —
 * только транспорт.
 */

const globalRoot = require('../../drive_root/globalServerContext');
const log = require('../../drive_root/log');

let _api = null;
function api() {
    if (!_api) {
        const Utilities = require('../../').Utilities;
        _api = require('./forms/messenger.server')(globalRoot.modelsDB, Utilities);
    }
    return _api;
}

/**
 * GET /app/messenger/attachment?uid=<UID>[&thumb=1]
 *
 * Кэширование: вложение неизменяемо (правки сообщений в системе нет), поэтому
 * его можно держать в кэше браузера долго — но `private`, чтобы промежуточные
 * кэши не раздавали чужую переписку.
 */
async function attachment(params, sessionID, req, res) {
    try {
        const uid = params && params.uid;
        if (!uid) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'uid not specified' }));
            return { _handled: true };
        }

        const user = await globalRoot.getUserBySessionID(sessionID);
        const found = await api().readAttachment(uid, { sessionID, user }, params.thumb === '1');
        if (!found || !found.body) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
            return { _handled: true };
        }

        const body = Buffer.isBuffer(found.body) ? found.body : Buffer.from(found.body);
        res.writeHead(200, {
            'Content-Type': found.mimeType || 'application/octet-stream',
            'Content-Length': body.length,
            'Cache-Control': 'private, max-age=86400',
            // Имя нужно, когда файл сохраняют; inline — чтобы картинка
            // показывалась в ленте, а не скачивалась.
            'Content-Disposition': 'inline; filename*=UTF-8\'\'' + encodeURIComponent(found.name || 'file')
        });
        res.end(body);
    } catch (e) {
        log.error('[messenger/attachment]', e && e.message);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal error' }));
        }
    }
    return { _handled: true };
}

module.exports = { attachment };
