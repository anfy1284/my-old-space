'use strict';

/**
 * HTTP-роуты приложения резервного копирования.
 *
 * Ядро маршрутизирует сюда всё из `/api/apps/backup/…` (drive_root/server.js:152).
 * Хардкодить пути в ядре не нужно — механизм роутов приложений уже есть.
 *
 * ДВА РОДА ГОСТЕЙ, ОДИН НАБОР АДРЕСОВ:
 *   · администратор из интерфейса — сессия + роль `admin`;
 *   · внешнее приложение-хранилище — подпись Ed25519 (`drive_root/backup/apiAuth.js`).
 *
 * Разводятся они по наличию заголовка подписи, а не по разным адресам: ресурс один и
 * тот же, различаются только права предъявителя и то, под каким именем уедет файл.
 *
 * В режиме обслуживания сюда не попадает ничего: гейт стоит первой строкой
 * `drive_root/server.js#handleRequest` и отдаёт 503 (ТЗ §5, приёмка §9 п. 30).
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
 * Сессия внешнего API для собственного журнала копий.
 *
 * За внешним хранилищем НЕ СТОИТ пользователь: это машина, забирающая файлы, и
 * служебную сессию (§33) ей выдать не от чьего имени. Каталог копий — служебные
 * таблица самого механизма копирования, и это ровно тот случай, для которого
 * `__SYS_INTERNAL__` и предназначен. Права предъявителя проверены подписью выше;
 * доступ здесь не «расширяется», а обходится RLS, которому нечего фильтровать —
 * у таблицы `organizationId` всегда `NULL`.
 */
const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';

function sendJSON(res, status, obj, extraHeaders) {
    const body = JSON.stringify(obj);
    res.writeHead(status, Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    }, extraHeaders || {}));
    res.end(body);
}

/** Тело запроса целиком — оно нужно ДО проверки подписи: его хэш в неё входит. */
function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) { req.destroy(); reject(new Error('body too large')); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

const API_BODY_MAX = 64 * 1024;

/**
 * Впустить внешнее хранилище.
 *
 * Отказ отдаётся ОДИНАКОВО для «ключ не тот» и «ключ отключён» — иначе перебором
 * выясняется список зарегистрированных отпечатков. Расхождение часов и повтор названы
 * прямо: они ничего не выдают о содержимом сервера, а без них настройка нового
 * хранилища превращается в гадание.
 *
 * @returns {Promise<Object|null>} клиент либо `null` (ответ уже отправлен)
 */
async function requireApiClient(req, res, body) {
    const apiAuth = backup.apiAuth;

    // Реестр хранилищ живёт в кэше настроек, а кэш наполняется из базы. Проверка
    // подписи синхронна и ждать не умеет, поэтому прогреваем ЗДЕСЬ — иначе запрос,
    // пришедший раньше прогрева, получил бы «ключ неизвестен» при исправном ключе, и
    // хранилище ушло бы разбираться с часами и отпечатками вместо ожидания.
    await backup.settings.ensureLoaded();

    const v = apiAuth.verify(req, body);
    if (v.ok) return v.client;

    audit(`API_DENY ${req.method} ${req.url} reason=${v.error} ip=${apiAuth.clientIp(req)}`);
    const headers = v.retryAfter ? { 'Retry-After': String(v.retryAfter) } : {};
    sendJSON(res, v.status || 401, { ok: false, error: v.error }, headers);
    return null;
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

/** Аудит-лог — в ФАЙЛ: он должен пережить подмену базы (ТЗ §6.5). Общий модуль. */
const { audit } = require('../../drive_root/backup/audit');

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
 * Диапазон из заголовка `Range` — ОДИН, вида `bytes=a-b` (допустимы `a-` и `-b`).
 *
 * Множественные диапазоны сознательно не поддержаны: они нужны для медиа, а здесь
 * единственный сценарий — докачка оборвавшегося файла, и он всегда однодиапазонный.
 * Заявлять `multipart/byteranges` ради него значит писать код, который никто не
 * позовёт и никто не проверит.
 *
 * @returns {{start: number, end: number}|null|'invalid'} `null` — заголовка нет
 */
function parseRange(header, size) {
    const raw = String(header || '').trim();
    if (!raw) return null;
    const m = raw.match(/^bytes=(\d*)-(\d*)$/);
    if (!m || (!m[1] && !m[2])) return 'invalid';

    let start, end;
    if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Number(m[2]) : size - 1;
    } else {
        // `-N` — последние N байт. Для докачки не используется, но это часть формата,
        // и молча отдать вместо них начало файла было бы хуже, чем не поддержать вовсе.
        start = Math.max(0, size - Number(m[2]));
        end = size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid';
    return { start, end: Math.min(end, size - 1) };
}

/**
 * `GET /api/apps/backup/download/:fileName`
 *
 * Идентификатор — ИМЯ ФАЙЛА (MOSBAK2): таблицы журнала больше нет, каталог и есть
 * источник истины. Имя приходит снаружи и превращается в путь, поэтому проходит
 * проверку белым списком в `catalog.safeName` — без неё подписанный запрос читал бы
 * произвольный файл с диска сервера.
 *
 * Два предъявителя: администратор из интерфейса (сессия + роль) и внешнее хранилище
 * (подпись). Проверка — ЗДЕСЬ, а не скрытием кнопки в форме: адрес угадывается, а файл
 * содержит персональные данные всех клиентов. Отдаётся потоком: дамп может весить
 * больше, чем разумно держать в памяти.
 *
 * Докачка (`Range`) — не украшение: копия может весить гигабайты, а домашний канал
 * рвётся. Без неё оборванная на 90% загрузка начинается сначала, и хранилище на
 * плохом канале не догоняет сервер никогда. Соответствие файла проверяется по `ETag`
 * (это SHA-256 шифротекста, он же в списке) — клиент обязан сверить его перед
 * продолжением, иначе склеит куски разных копий.
 */
async function handleDownload(req, res, fileNameArg) {
    const apiAuth = backup.apiAuth;
    const viaApi = apiAuth.hasSignature(req);

    let who = null, client = null;
    if (viaApi) {
        client = await requireApiClient(req, res, null);
        if (!client) return;
    } else {
        who = await resolveAdmin(req);
        if (!who) {
            audit(`DENY download file=${fileNameArg} ip=${clientIp(req)}`);
            return deny(res);
        }
    }

    const rec = backup.catalog.find(fileNameArg);
    // Одинаковый отказ на «имя не прошло проверку» и «такой копии нет»: различать их
    // значит подтверждать существование файлов тому, кто их перебирает.
    if (!rec) return deny(res);
    const filePath = rec.filePath;

    const stat = fs.statSync(filePath);
    // Внешнему хранилищу — техническое имя файла: по нему копия опознаётся без
    // расшифровки и по нему же ведётся каталог. Наименование, данное администратором,
    // это ярлык для человека, и подменять им идентичность файла в архиве нельзя.
    const downloadName = viaApi ? rec.fileName : buildDownloadName(rec);
    const etag = rec.sha256 ? `"${rec.sha256}"` : undefined;

    const range = parseRange(req.headers && req.headers['range'], stat.size);
    if (range === 'invalid') {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Cache-Control': 'no-store' });
        return res.end();
    }

    const who_ = viaApi ? `client=${client.fingerprint.slice(7, 19)}` : `user=${who.user.UID}`;
    audit(`DOWNLOAD file=${rec.fileName} as="${downloadName}" `
        + `scope=${rec.scopeType}${rec.scopeOrganizationId ? ':' + rec.scopeOrganizationId : ''} `
        + `${who_} ip=${clientIp(req)} size=${stat.size}${range ? ` range=${range.start}-${range.end}` : ''}`);
    log.info(`[backup] Скачивание ${rec.fileName} (${viaApi ? 'внешнее хранилище' : who.user.UID})`);

    const headers = {
        'Content-Type': 'application/octet-stream',
        // Имя в кавычках: в нём есть дефисы и точки, а некоторые клиенты режут строку.
        // Нелатинские имена — вторым параметром `filename*` (RFC 5987), иначе браузер
        // получит вопросительные знаки вместо букв.
        'Content-Disposition': `attachment; filename="${asciiFallback(downloadName)}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes'
    };
    if (etag) headers['ETag'] = etag;

    if (range) {
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
        headers['Content-Length'] = range.end - range.start + 1;
        res.writeHead(206, headers);
    } else {
        headers['Content-Length'] = stat.size;
        res.writeHead(200, headers);
    }

    const stream = fs.createReadStream(filePath, range ? { start: range.start, end: range.end } : {});
    stream.on('error', (e) => {
        log.error(`[backup] Ошибка чтения ${rec.fileName}: ${e.message}`);
        res.destroy();
    });
    stream.pipe(res);
}

// ── Внешнее API хранилища (ТЗ §5) ───────────────────────────────────────────────

/**
 * `GET /api/apps/backup/ping`
 *
 * Роут для НАСТРОЙКИ, а не для работы. Без него первое подключение нового хранилища
 * выглядит так: «список пустой — это ключ не тот, часы разошлись или копий правда
 * нет?». Здесь ответ прямой: подпись принята, вот кем тебя видят и вот время сервера
 * (по нему клиент сам обнаружит расхождение часов до того, как оно всё сломает).
 * Ничего, кроме собственного имени клиента, не выдаёт.
 */
async function handleApiPing(req, res) {
    const client = await requireApiClient(req, res, null);
    if (!client) return;
    sendJSON(res, 200, {
        ok: true,
        client: client.name,
        keyFingerprint: client.fingerprint,
        serverTime: new Date().toISOString(),
        maxSkewSec: backup.apiAuth.MAX_SKEW_SEC,
        api: 'mosbak-backup-1'
    });
}

/**
 * `GET /api/apps/backup/list`
 *
 * Список строится ЧТЕНИЕМ КАТАЛОГА (MOSBAK2): таблицы журнала больше нет, и записей о
 * файлах, которых не существует, теперь не бывает по построению — прежняя оговорка про
 * `missing` исчезла вместе с причиной.
 *
 * Что отдаётся и почему именно это:
 *   · `fileName` — ИДЕНТИФИКАТОР копии: им же адресуются `download` и `delete`;
 *   · `sha256` — по ШИФРОТЕКСТУ: хранилище обязано проверить целостность, не имея
 *     приватного ключа, то есть не расшифровывая. Берётся из спутника; пустой означает
 *     «сумма недоступна», и хранилищу решать, забирать ли такую копию;
 *   · `scope` — копия одной организации не является поколением архива, и прореживать
 *     по ней нельзя (ТЗ §3.7). Различать обязано хранилище, а для этого нужно поле, а
 *     не догадки по имени файла;
 *   · `keyFingerprint` — каким из своих приватных ключей эту копию потом расшифровывать;
 *   · `dbVersion`/`configHash` — по ним видно, что структура базы менялась.
 */
async function handleApiList(req, res) {
    const client = await requireApiClient(req, res, null);
    if (!client) return;

    const files = backup.catalog.list().map(r => ({
        fileName: r.fileName,
        createdAt: r.createdAt.toISOString(),
        size: r.size,
        sha256: r.sha256,
        dbVersion: r.dbVersion,
        configHash: r.configHash,
        keyFingerprint: r.keyFingerprint,
        scope: r.scopeType === 'organization'
            ? { type: 'organization', organizationId: r.scopeOrganizationId, organizationName: r.scopeOrganizationName }
            : { type: 'full' },
        triggeredBy: r.triggeredBy,
        title: r.title,
        rows: r.rowsTotal
    }));

    audit(`API_LIST client=${client.fingerprint.slice(7, 19)} ip=${backup.apiAuth.clientIp(req)} files=${files.length}`);
    sendJSON(res, 200, { ok: true, serverTime: new Date().toISOString(), files });
}

/**
 * `POST /api/apps/backup/delete/:fileName` — тело: `{}` либо `{"sha256":"<хэш>"}`
 *
 * ЗАМЕНИЛ `ack`. Прежде хранилище подтверждало приём, а сервер это запоминал и берёг
 * неподтверждённые копии от прореживания. Решение владельца 11.08.2026 сняло всю эту
 * конструкцию: сервер — перевалочный буфер, он намеренно не следит, что уехало, и
 * помнить подтверждения ему негде и незачем. Осталось одно осмысленное действие —
 * «файл у меня и он цел, можешь удалять».
 *
 * Проверка суммы СОХРАНЕНА и стала важнее, чем была: раньше ошибочный `ack` лишь
 * разрешал ретеншну удалить копию когда-нибудь, теперь запрос удаляет её немедленно.
 * Прислал сумму — она обязана совпасть; не прислал — удаляем по слову хранилища, и
 * ответственность за это на нём.
 *
 * Тело входит в подпись (её хэш — часть подписываемой строки), поэтому подменить сумму
 * по дороге нельзя.
 */
async function handleApiDelete(req, res, fileNameArg) {
    const body = await readBody(req);
    const client = await requireApiClient(req, res, body);
    if (!client) return;

    const rec = backup.catalog.find(fileNameArg);
    if (!rec) return sendJSON(res, 404, { ok: false, error: 'not_found' });

    let claimed = '';
    try { claimed = String((JSON.parse(body.toString('utf8') || '{}') || {}).sha256 || '').toLowerCase(); }
    catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad_body' }); }

    // Сумма могла быть не посчитана (копия снята до появления спутников). Это НЕ повод
    // пропустить проверку: раньше пустая сумма означала «удаляем не проверяя», то есть
    // ровно там, где проверка нужнее всего, её и не было. Считаем сейчас — операция
    // редкая, файл один, а результат кладётся в спутник и больше не пересчитывается.
    let actual = rec.sha256;
    if (claimed && !actual) {
        try { actual = await backup.catalog.computeSha256(rec.fileName); }
        catch (e) { log.error(`[backup/api] Сумма ${rec.fileName} не посчитана: ${e.message}`); }
        if (!actual) {
            audit(`API_DELETE_REFUSED file=${rec.fileName} reason=checksum_unavailable `
                + `client=${client.fingerprint.slice(7, 19)} ip=${backup.apiAuth.clientIp(req)}`);
            return sendJSON(res, 409, { ok: false, error: 'checksum_unavailable' });
        }
    }

    if (claimed && actual && claimed !== actual) {
        audit(`API_DELETE_REFUSED file=${rec.fileName} client=${client.fingerprint.slice(7, 19)} `
            + `ip=${backup.apiAuth.clientIp(req)} claimed=${claimed.slice(0, 16)} actual=${actual.slice(0, 16)}`);
        return sendJSON(res, 409, { ok: false, error: 'checksum_mismatch', expected: actual });
    }

    // Файл, из которого идёт восстановление, не удаляется ни по чьей команде: операция
    // читает его прямо сейчас (см. markInUse). Это отказ, а не ошибка хранилища —
    // пусть попробует позже.
    if (rec.inUse) {
        return sendJSON(res, 409, { ok: false, error: 'in_use' });
    }

    backup.catalog.remove(rec.fileName);
    audit(`API_DELETE file=${rec.fileName} client=${client.fingerprint.slice(7, 19)} `
        + `ip=${backup.apiAuth.clientIp(req)} verified=${claimed ? 'yes' : 'no'}`);
    log.info(`[backup/api] Копия ${rec.fileName} удалена по команде хранилища`);
    sendJSON(res, 200, { ok: true });
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
 * В каталоге копия НЕ появляется: файла на сервере нет вовсе, а запись без
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
        // Внешнее хранилище (ТЗ §5) — вход по подписи, проверяется внутри обработчиков.
        if (req.method === 'GET' && action === 'ping') return await handleApiPing(req, res);
        if (req.method === 'GET' && action === 'list') return await handleApiList(req, res);
        // `ack` заменён на `delete` (MOSBAK2): приложение намеренно не отслеживает,
        // что уехало в хранилище, поэтому подтверждать ему нечего — хранилищу нужна
        // одна команда «файл у меня, он цел, можешь удалять».
        if (req.method === 'POST' && action === 'delete' && arg) return await handleApiDelete(req, res, arg);
    } catch (e) {
        log.error(`[backup] Ошибка роута ${action}: ${e && e.stack || e}`);
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Internal Server Error'); }
        return;
    }
    return deny(res);
}

module.exports = { handleDirectRequest, stashPrivateKey, uploadDir, sweepUploads, UPLOAD_DIR_NAME };
