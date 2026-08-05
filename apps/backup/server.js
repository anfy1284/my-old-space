'use strict';

/**
 * HTTP-роуты приложения резервного копирования.
 *
 * Ядро маршрутизирует сюда всё из `/api/apps/backup/…` (drive_root/server.js:152).
 * Хардкодить пути в ядре не нужно — механизм роутов приложений уже есть.
 *
 * Сейчас реализовано скачивание копии администратором. Внешнее API для
 * приложения-хранилища (list/download/ack по Bearer-ключу) — этап 2.3.
 */

const fs = require('fs');
const path = require('path');

const log = require('../../drive_root/log');
const dbGateway = require('../../drive_root/dbGateway');
const backup = require('../../drive_root/backup');

/** Единый отказ: «нет прав» и «нет файла» снаружи неразличимы. */
function deny(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
}

/**
 * Кто пришёл. Сессия берётся ТОЛЬКО через единую точку — она же отсекает служебные
 * сессии, которые не должны работать как логин.
 */
async function resolveAdmin(req) {
    const globalCtx = require('../../drive_root/globalServerContext');
    const formsCtx = require('../../drive_forms/globalServerContext');
    const sessionID = await globalCtx.getSessionIdFromRequest(req);
    if (!sessionID) return null;
    const user = await globalCtx.getUserBySessionID(sessionID);
    if (!user) return null;
    const role = await formsCtx.getUserAccessRole(user);
    return role === 'admin' ? { sessionID, user, role } : null;
}

/** Аудит-лог — в ФАЙЛ: он должен пережить подмену базы (ТЗ §6.5). */
function audit(line) {
    try {
        const dir = backup.settings.storagePath();
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'backup-audit.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch (e) {
        log.error(`[backup] Не удалось записать аудит: ${e.message}`);
    }
}

function clientIp(req) {
    return String((req.headers && (req.headers['x-forwarded-for'] || '')) || '').split(',')[0].trim()
        || (req.socket && req.socket.remoteAddress) || '';
}

/**
 * `GET /api/apps/backup/download/:uid`
 *
 * Проверка роли — ЗДЕСЬ, а не скрытием кнопки в форме: адрес угадывается, а файл
 * содержит персональные данные всех клиентов. Отдаётся потоком: дамп может весить
 * больше, чем разумно держать в памяти.
 */
async function handleDownload(req, res, uid) {
    const who = await resolveAdmin(req);
    if (!who) {
        audit(`DENY download uid=${uid} ip=${clientIp(req)}`);
        return deny(res);
    }

    let rows;
    try {
        rows = await dbGateway.execute({
            operation: 'read', table: 'backup_files',
            where: { UID: uid }, options: { raw: true },
            context: { sessionID: who.sessionID }
        });
    } catch (e) {
        log.error(`[backup] download: ${e.message}`);
        return deny(res);
    }
    const rec = rows && rows[0];
    if (!rec) return deny(res);

    const filePath = path.join(backup.settings.storagePath(), rec.fileName);
    if (!fs.existsSync(filePath)) {
        // Запись есть, файла нет — обычное дело после восстановления чужого дампа
        // (список копий едет внутри него). Помечаем, а не отдаём битую ссылку.
        try {
            await dbGateway.execute({
                operation: 'update', table: 'backup_files',
                where: { UID: uid }, data: { missing: true },
                context: { sessionID: who.sessionID }
            });
        } catch (e) { /* пометка не важнее ответа */ }
        return deny(res);
    }

    const stat = fs.statSync(filePath);
    audit(`DOWNLOAD uid=${uid} file=${rec.fileName} scope=${rec.scopeType}${rec.scopeOrganizationId ? ':' + rec.scopeOrganizationId : ''} user=${who.user.UID} ip=${clientIp(req)} size=${stat.size}`);
    log.info(`[backup] Скачивание ${rec.fileName} пользователем ${who.user.UID}`);

    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        // Имя в кавычках: в нём есть дефисы и точки, а некоторые клиенты режут строку.
        'Content-Disposition': `attachment; filename="${rec.fileName}"`,
        'Cache-Control': 'no-store'
    });
    const stream = fs.createReadStream(filePath);
    stream.on('error', (e) => {
        log.error(`[backup] Ошибка чтения ${rec.fileName}: ${e.message}`);
        res.destroy();
    });
    stream.pipe(res);
}

/**
 * `GET /api/apps/backup/private-key/:token`
 *
 * Одноразовая отдача приватного ключа сразу после генерации пары. Ключ живёт в памяти
 * процесса до первого скачивания или до истечения короткого срока и НИКОГДА не пишется
 * на диск и не попадает в журнал: хэш необратим, а приватный ключ — тем более не
 * восстановим, поэтому механизм обязан показать его ровно один раз (ТЗ §2).
 */
const pendingKeys = new Map();   // token → { pem, expires, userUID }
const KEY_TTL_MS = 5 * 60 * 1000;

function stashPrivateKey(token, pem, userUID) {
    pendingKeys.set(token, { pem, expires: Date.now() + KEY_TTL_MS, userUID });
    // Таймер не держит процесс: забытый ключ обязан исчезнуть сам.
    const t = setTimeout(() => pendingKeys.delete(token), KEY_TTL_MS);
    if (t.unref) t.unref();
}

async function handlePrivateKey(req, res, token) {
    const who = await resolveAdmin(req);
    if (!who) return deny(res);

    const entry = pendingKeys.get(token);
    pendingKeys.delete(token);                       // одноразовость — до всех проверок
    if (!entry || entry.expires < Date.now() || entry.userUID !== who.user.UID) return deny(res);

    audit(`PRIVATE_KEY_DOWNLOAD user=${who.user.UID} ip=${clientIp(req)}`);
    res.writeHead(200, {
        'Content-Type': 'application/x-pem-file',
        'Content-Disposition': 'attachment; filename="backup-private-key.pem"',
        'Cache-Control': 'no-store'
    });
    res.end(entry.pem);
}

/**
 * Точка входа роутов приложения.
 * @param {Array<string>} pathParts — часть пути после `/api/apps/backup/`
 */
async function handleDirectRequest(req, res, pathParts) {
    const action = pathParts[0];
    const arg = pathParts[1] ? String(pathParts[1]).split('?')[0] : '';

    try {
        if (req.method === 'GET' && action === 'download' && arg) return await handleDownload(req, res, arg);
        if (req.method === 'GET' && action === 'private-key' && arg) return await handlePrivateKey(req, res, arg);
    } catch (e) {
        log.error(`[backup] Ошибка роута ${action}: ${e && e.stack || e}`);
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Internal Server Error'); }
        return;
    }
    return deny(res);
}

module.exports = { handleDirectRequest, stashPrivateKey };
