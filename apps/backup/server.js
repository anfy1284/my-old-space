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

/**
 * Имя, под которым файл уедет пользователю.
 *
 * Если администратор дал копии своё наименование («перед миграцией цен») — скачивается
 * оно; иначе техническое имя файла. Файл НА ДИСКЕ при этом не переименовывается: его
 * имя несёт область выгрузки и версию структуры (ТЗ §9 п.12), по нему копию опознают
 * без расшифровки, и на него же смотрит внешнее хранилище. Наименование — это ярлык
 * для человека, а не идентичность файла.
 */
function buildDownloadName(rec) {
    const raw = String((rec && rec.title) || '').trim();
    if (!raw) return rec.fileName;
    // Заменяем ТОЛЬКО недопустимое в имени файла (Windows и POSIX). Пробелы и дефисы
    // законны и сохраняются — иначе осмысленное имя превращается в кашу из подчёркиваний.
    // Управляющие символы отсеиваются посимвольно: держать их в регулярке значит держать
    // в исходнике настоящие управляющие БАЙТЫ, а файл после этого не текстовый.
    const safe = Array.from(raw)
        .filter(ch => ch.charCodeAt(0) >= 32)
        .join('')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/\.+$/, '')
        .trim()
        .slice(0, 120);
    if (!safe) return rec.fileName;
    return safe.toLowerCase().endsWith('.mosbak') ? safe : safe + '.mosbak';
}

/** Запасное ASCII-имя для клиентов, не понимающих `filename*`. */
function asciiFallback(name) {
    const s = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    return s.trim() || 'backup.mosbak';
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
    const downloadName = buildDownloadName(rec);
    audit(`DOWNLOAD uid=${uid} file=${rec.fileName} as="${downloadName}" scope=${rec.scopeType}${rec.scopeOrganizationId ? ':' + rec.scopeOrganizationId : ''} user=${who.user.UID} ip=${clientIp(req)} size=${stat.size}`);
    log.info(`[backup] Скачивание ${rec.fileName} пользователем ${who.user.UID}`);

    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        // Имя в кавычках: в нём есть дефисы и точки, а некоторые клиенты режут строку.
        // Нелатинские имена — вторым параметром `filename*` (RFC 5987), иначе браузер
        // получит вопросительные знаки вместо букв.
        'Content-Disposition': `attachment; filename="${asciiFallback(downloadName)}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
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
 * `POST /api/apps/backup/upload`
 *
 * Загрузка копии С ДИСКА АДМИНИСТРАТОРА для полного восстановления (ТЗ §6).
 *
 * Зачем: обычно нужного архива на сервере уже нет — там хранятся только последние
 * копии, а нужна, например, июньская из внешнего хранилища. Без этого пути
 * восстановление умеет разворачивать лишь то, что и так лежит рядом.
 *
 * Файл кладётся во ВРЕМЕННЫЙ каталог и проверяется по открытому заголовку (magic,
 * версия формата) ДО всего остального; не прошёл — удаляется сразу. По завершении
 * процедуры временный файл удаляется (ТЗ, приёмка п. 28).
 */
const UPLOAD_DIR_NAME = 'uploads';
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024 * 1024;

function uploadDir() {
    const dir = path.join(backup.settings.storagePath(), UPLOAD_DIR_NAME);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Убрать заброшенные загрузки.
 *
 * Загруженный файл удаляется по завершении процедуры восстановления — но администратор
 * мог загрузить копию и передумать, и тогда она осталась бы навсегда. Это не мусор в
 * общем смысле: файл содержит персональные данные ВСЕХ клиентов, и держать его на
 * диске без причины нельзя. Срок — сутки: дольше подготовка к восстановлению не длится.
 */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

function sweepUploads() {
    let removed = 0;
    try {
        const dir = uploadDir();
        for (const f of fs.readdirSync(dir)) {
            const p = path.join(dir, f);
            try {
                if (Date.now() - fs.statSync(p).mtimeMs < UPLOAD_TTL_MS) continue;
                fs.unlinkSync(p);
                removed++;
            } catch (e) { /* занятый файл уберём в следующий раз */ }
        }
    } catch (e) { /* каталога может не быть */ }
    if (removed) {
        audit(`UPLOAD_SWEEP removed=${removed}`);
        log.info(`[backup] Удалено заброшенных загрузок: ${removed}`);
    }
    return removed;
}

async function handleUpload(req, res) {
    const who = await resolveAdmin(req);
    if (!who) { audit(`DENY upload ip=${clientIp(req)}`); return deny(res); }
    sweepUploads();          // заодно убираем брошенное с прошлых заходов

    const name = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${backup.FILE_EXT}`;
    const target = path.join(uploadDir(), name);
    const out = fs.createWriteStream(target);
    let size = 0;
    let aborted = false;

    await new Promise((resolve) => {
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > UPLOAD_MAX_BYTES && !aborted) { aborted = true; req.destroy(); out.destroy(); }
        });
        req.on('error', () => { aborted = true; resolve(); });
        out.on('error', () => { aborted = true; resolve(); });
        req.pipe(out);
        out.on('finish', resolve);
        out.on('close', resolve);
    });

    if (aborted) {
        try { fs.unlinkSync(target); } catch (e) {}
        res.writeHead(413, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, errorKey: 'restore_err_upload_too_large' }));
    }

    // Проверка ДО всего остального: заголовок открытым текстом, ключ не нужен.
    // Не наш файл не должен даже доехать до процедуры восстановления.
    try {
        backup.restore.readHeader(target);
    } catch (e) {
        try { fs.unlinkSync(target); } catch (e2) {}
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, errorKey: 'restore_err_not_a_backup', message: e.message }));
    }

    audit(`UPLOAD file=${name} size=${size} user=${who.user.UID} ip=${clientIp(req)}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uploadName: name, size }));
}

/**
 * `GET /api/apps/backup/download-plain?scope=full|organization&org=<UID>`
 *
 * НЕЗАШИФРОВАННАЯ копия — потоком, без записи на диск сервера.
 *
 * Сценарий владельца: перед рискованной операцией нужна копия, из которой можно
 * восстановиться немедленно, не доставая приватный ключ из домашнего архива. Долгий
 * архив дома и так хранит копии расшифрованными, поэтому режим не создаёт нового
 * класса риска — но на сервере такой файл лежать не должен, и он там не появляется:
 * байты идут из снимка сразу в ответ (см. `backup.createPlainStream`).
 *
 * В журнал `backup_files` запись НЕ добавляется: файла на сервере нет, а запись без
 * файла — это ссылка в никуда. Факт создания пишется в аудит-лог.
 */
async function handleDownloadPlain(req, res) {
    const who = await resolveAdmin(req);
    if (!who) { audit(`DENY download-plain ip=${clientIp(req)}`); return deny(res); }

    const url = new URL(req.url, 'http://localhost');
    const scopeType = url.searchParams.get('scope') === 'organization' ? 'organization' : 'full';
    const orgId = String(url.searchParams.get('org') || '').trim();
    if (scopeType === 'organization' && !orgId) return deny(res);

    const globalCtx = require('../../drive_root/globalServerContext');
    const sequelize = require('../../drive_root/db/sequelize_instance');
    const { models } = globalCtx.collectMergedModelDefs();

    let orgName = '';
    if (scopeType === 'organization') {
        const rows = await dbGateway.execute({
            operation: 'read', table: 'organizations', where: { UID: orgId },
            options: { raw: true }, context: { sessionID: who.sessionID }
        });
        if (!rows || !rows.length) return deny(res);
        orgName = rows[0].name || '';
    }

    let made;
    try {
        const dbVersions = require('../../drive_root/db/dbVersions');
        let version = null;
        try { version = await dbVersions.latest(sequelize); } catch (e) { version = null; }

        made = await backup.createPlainStream({
            sequelize, models,
            scope: scopeType === 'organization'
                ? { type: 'organization', organizationId: orgId, organizationName: orgName }
                : { type: 'full' },
            meta: {
                appVersion: process.env.npm_package_version || '',
                frameworkVersion: (function () { try { return require('../../package.json').version; } catch (e) { return ''; } })(),
                dbVersion: version ? Number(version.number) || 0 : 0,
                actualHash: (version && version.actualHash) || ''
            }
        });
    } catch (e) {
        log.error(`[backup] Незашифрованная выгрузка: ${e.stack || e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, errorKey: e.errorKey || 'backup_err_plain_failed', message: e.message }));
    }

    audit(`DOWNLOAD_PLAIN scope=${scopeType}${orgId ? ':' + orgId : ''} user=${who.user.UID} ip=${clientIp(req)} file=${made.fileName}`);
    log.warn(`[backup] Создана НЕЗАШИФРОВАННАЯ копия ${made.fileName} (потоком, на сервере не сохранена)`);

    // Длина неизвестна заранее — поток. Отдаём chunked; браузер это принимает.
    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${asciiFallback(made.fileName)}"; filename*=UTF-8''${encodeURIComponent(made.fileName)}`,
        'Cache-Control': 'no-store'
    });
    made.stream.on('error', (e) => {
        log.error(`[backup] Обрыв незашифрованной выгрузки: ${e.message}`);
        res.destroy();
    });
    made.stream.pipe(res);
}

/**
 * Точка входа роутов приложения.
 * @param {Array<string>} pathParts — часть пути после `/api/apps/backup/`
 */
async function handleDirectRequest(req, res, pathParts) {
    // Строка запроса отрезается и от ДЕЙСТВИЯ, а не только от аргумента: ядро режет путь
    // по «/», поэтому у роута без аргумента (`/download-plain?scope=full`) параметры
    // приклеиваются прямо к имени действия, и роут молча не находится.
    const action = pathParts[0] ? String(pathParts[0]).split('?')[0] : '';
    const arg = pathParts[1] ? String(pathParts[1]).split('?')[0] : '';

    try {
        if (req.method === 'GET' && action === 'download' && arg) return await handleDownload(req, res, arg);
        if (req.method === 'GET' && action === 'private-key' && arg) return await handlePrivateKey(req, res, arg);
        if (req.method === 'POST' && action === 'upload') return await handleUpload(req, res);
        if (req.method === 'GET' && action === 'download-plain') return await handleDownloadPlain(req, res);
    } catch (e) {
        log.error(`[backup] Ошибка роута ${action}: ${e && e.stack || e}`);
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Internal Server Error'); }
        return;
    }
    return deny(res);
}

module.exports = { handleDirectRequest, stashPrivateKey, uploadDir, sweepUploads, UPLOAD_DIR_NAME };
