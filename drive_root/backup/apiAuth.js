'use strict';

/**
 * apiAuth — вход внешнего приложения-хранилища ПО КРИПТОКЛЮЧУ (ТЗ §5).
 *
 * ЧЕМ ЭТО ЛУЧШЕ ДОЛГОЖИВУЩЕГО ТОКЕНА. Bearer-ключ — это пароль: он целиком уезжает
 * в каждом запросе, и любой, кто его увидел (обратный прокси, журнал, дамп памяти,
 * невнимательный `curl` в истории команд), получает полный доступ к архиву за всю
 * историю. Здесь по сети уходит только ПОДПИСЬ конкретного запроса: перехватчик не
 * может ни повторить её на другом адресе, ни воспользоваться ею завтра. Секрет —
 * приватный ключ — не покидает машину хранилища ВООБЩЕ, и на сервере его нет, значит
 * украденный дамп сервера не содержит ключей от других дампов.
 *
 * ПОЧЕМУ ОТДЕЛЬНАЯ ПАРА, А НЕ ТА, ЧТО ШИФРУЕТ КОПИИ. Ключ шифрования копий — главная
 * ценность всей схемы: потеряли его — потеряли архив за годы. Он обязан лежать
 * офлайн, под парольной фразой, и доставаться раз в год. Ключ входа, наоборот, нужен
 * каждый час и потому лежит распакованным в работающей службе. Свести их в один
 * значит заставить держать главный секрет системы горячим ради опроса списка файлов.
 * Отсюда: вход — Ed25519 (короткий, быстрый, без выбора параметров, которые можно
 * выбрать неправильно), шифрование копий — RSA-4096, как было.
 *
 * ГДЕ ЛЕЖИТ ПУБЛИЧНЫЙ КЛЮЧ КЛИЕНТА. В файле настроек (§2.1), а не в БД. В БД он уехал
 * бы внутри дампа, и восстановление годичной копии молча вернуло бы список клиентов
 * годичной давности: отозвало действующий доступ и воскресило отозванный. Для
 * механизма, чья работа — переживать восстановления, это дисквалифицирующее свойство.
 *
 * Подписываемая строка (UTF-8, разделитель LF, завершающего перевода строки нет):
 *
 *     MOSBAK2
 *     <МЕТОД заглавными>
 *     <путь вместе со строкой запроса, ровно как отправлен>
 *     <ts — секунды Unix>
 *     <nonce>
 *     <sha256-hex тела запроса; у запроса без тела — sha256 пустой строки>
 *
 * Подпись передаётся заголовком:
 *
 *     Authorization: MOSBAK2-Ed25519 keyId=<отпечаток>,ts=<…>,nonce=<…>,sig=<base64>
 *
 * Метод и путь входят в подпись НЕ для красоты: без них перехваченную подпись можно
 * предъявить другому роуту (подпись от `ping` сгодилась бы для `download`), а тело в
 * подписи закрывает подмену параметров `ack`.
 */

const crypto = require('crypto');

const log = require('../log');
const settingsStore = require('./settings');

/** Служебные обращения к собственным таблицам механизма: живой сессии здесь нет. */
const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';

// Версия протокола поднята до MOSBAK2 (решение владельца 11.08.2026). Криптография не
// изменилась ни в чём — изменились МАРШРУТЫ: копия адресуется именем файла вместо UID
// записи журнала, а подтверждение заменено командой удаления. Версия в схеме и в
// подписываемом тексте нужна затем, чтобы старый клиент получал внятный отказ
// авторизации, а не загадочный 404 по несуществующему идентификатору.
const SCHEME = 'MOSBAK2-Ed25519';

/** Допуск расхождения часов. Меньше — и клиент с плывущими часами не войдёт вовсе. */
const MAX_SKEW_SEC = 300;

/**
 * Сколько помнить nonce. ОБЯЗАНО быть больше окна допуска в обе стороны: иначе
 * подпись, у которой `ts` ещё действителен, а nonce уже забыт, повторно пройдёт.
 */
const NONCE_TTL_MS = (MAX_SKEW_SEC * 2 + 60) * 1000;

/** Ограничение частоты. Штатный клиент опрашивает раз в час — это запас в сотни раз. */
const RATE_MAX = 120;
const RATE_WINDOW_MS = 5 * 60 * 1000;

/** Отдельный счётчик НЕУДАЧНЫХ попыток по адресу: подбор ключа не должен быть дешёвым. */
const FAIL_MAX = 30;
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const FAIL_BLOCK_MS = 15 * 60 * 1000;

const EMPTY_BODY_SHA = crypto.createHash('sha256').update('').digest('hex');

const _nonces = new Map();      // nonce → срок годности
const _rate = new Map();        // отпечаток → { count, windowStart }
const _fails = new Map();       // ip → { count, first, blockedUntil }
const _lastSeenFlush = new Map(); // отпечаток → когда последний раз писали в файл

// ── Реестр клиентов ─────────────────────────────────────────────────────────────

/**
 * Отпечаток публичного ключа входа: SHA-256 его DER (SPKI).
 *
 * По DER, а не по тексту PEM, — тот же довод, что и у ключа шифрования (`keys.js`):
 * один и тот же ключ, пересохранённый с другими переводами строк, не должен
 * выглядеть другим клиентом.
 */
function fingerprint(publicKey) {
    const key = typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey;
    return 'sha256:' + crypto.createHash('sha256')
        .update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}

/**
 * Проверить PEM публичного ключа входа.
 * @returns {{ok: boolean, errorKey?: string, vars?: Object, fingerprint?: string}}
 */
function validateClientKey(pem) {
    const text = String(pem || '').trim();
    if (!text) return { ok: false, errorKey: 'backup_api_err_key_empty' };

    // Самая частая ошибка при настройке — вставить сюда приватный ключ. Сказать об этом
    // прямо: иначе человек получит «ключ не читается» и будет искать проблему в формате.
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
        return { ok: false, errorKey: 'backup_api_err_key_is_private' };
    }

    let key;
    try {
        key = crypto.createPublicKey(text);
    } catch (e) {
        return { ok: false, errorKey: 'backup_api_err_key_unparsable', vars: { message: e.message } };
    }
    if (key.asymmetricKeyType !== 'ed25519') {
        return { ok: false, errorKey: 'backup_api_err_key_not_ed25519', vars: { type: String(key.asymmetricKeyType) } };
    }
    return { ok: true, fingerprint: fingerprint(key) };
}

/**
 * Список зарегистрированных клиентов.
 *
 * СИНХРОННО и из кэша настроек — потому что зовётся из `verify()` на КАЖДЫЙ запрос
 * хранилища. Авторитет — таблица `backup_api_clients`; кэш наполняет
 * `settings.load()` при старте и после каждой правки реестра.
 */
function listClients() {
    const s = settingsStore.read();
    return Array.isArray(s.apiClients) ? s.apiClients : [];
}

/**
 * Зарегистрировать клиента.
 *
 * Повторная регистрация того же ключа — не ошибка, а ВКЛЮЧЕНИЕ обратно: администратор,
 * который отключил доступ и передумал, вставит тот же ключ, и ожидает, что он заработает,
 * а не что появится второй такой же. Отпечаток уникален в таблице, поэтому второй
 * такой же не появится и по ошибке.
 */
async function addClient(name, publicKeyPem) {
    const v = validateClientKey(publicKeyPem);
    if (!v.ok) return v;

    const pem = String(publicKeyPem).trim();
    const db = require('../dbGateway');
    const context = { sessionID: SYSTEM_SESSION_ID };

    const found = await db.execute({
        operation: 'read', table: settingsStore.CLIENTS_TABLE,
        where: { fingerprint: v.fingerprint }, options: { raw: true }, context
    }) || [];

    if (found.length) {
        await db.execute({
            operation: 'update', table: settingsStore.CLIENTS_TABLE,
            where: { UID: found[0].UID }, context,
            data: {
                name: String(name || found[0].name || '').trim() || found[0].name,
                disabled: false,
                publicKeyPem: pem
            }
        });
    } else {
        await db.execute({
            operation: 'create', table: settingsStore.CLIENTS_TABLE, context,
            data: {
                organizationId: null,
                name: String(name || '').trim() || v.fingerprint.slice(7, 19),
                publicKeyPem: pem,
                fingerprint: v.fingerprint,
                algorithm: 'ed25519',
                disabled: false
            }
        });
    }

    await settingsStore.load();
    log.info(`[backup/api] Зарегистрирован клиент ${v.fingerprint}`);
    return { ok: true, fingerprint: v.fingerprint, added: !found.length };
}

/** Включить/выключить клиента. Действует сразу: реестр читается на каждом запросе. */
async function setClientDisabled(id, disabled) {
    const c = listClients().find(x => x.id === id || x.fingerprint === id);
    if (!c) return { ok: false, errorKey: 'backup_api_err_client_unknown' };

    await require('../dbGateway').execute({
        operation: 'update', table: settingsStore.CLIENTS_TABLE,
        where: { UID: c.id }, data: { disabled: !!disabled },
        context: { sessionID: SYSTEM_SESSION_ID }
    });
    await settingsStore.load();
    log.info(`[backup/api] Клиент ${c.fingerprint} ${disabled ? 'отключён' : 'включён'}`);
    return { ok: true };
}

/** Удалить клиента насовсем. */
async function removeClient(id) {
    const c = listClients().find(x => x.id === id || x.fingerprint === id);
    if (!c) return { ok: false, errorKey: 'backup_api_err_client_unknown' };

    await require('../dbGateway').execute({
        operation: 'delete', table: settingsStore.CLIENTS_TABLE,
        where: { UID: c.id }, context: { sessionID: SYSTEM_SESSION_ID }
    });
    await settingsStore.load();
    log.info(`[backup/api] Клиент ${c.fingerprint} удалён`);
    return { ok: true };
}

/**
 * Отметить, что клиент выходил на связь.
 *
 * Не чаще раза в минуту: это диагностика («архив молчит третий день»), а не учёт, и
 * превращать её в запись на каждый запрос незачем. В памяти держать нельзя — после
 * перезапуска отметка нужна как раз больше всего: именно тогда и выясняют, кто перестал
 * приходить.
 *
 * Вызывается БЕЗ ожидания из синхронного `verify()`: отметка о визите не важнее самого
 * визита, и запрос обязан пройти, даже если её не удалось записать.
 */
const LAST_SEEN_FLUSH_MS = 60 * 1000;

function noteSeen(client, ip) {
    const prev = _lastSeenFlush.get(client.fingerprint) || 0;
    if (Date.now() - prev < LAST_SEEN_FLUSH_MS) return;
    _lastSeenFlush.set(client.fingerprint, Date.now());

    Promise.resolve()
        .then(async () => {
            await require('../dbGateway').execute({
                operation: 'update', table: settingsStore.CLIENTS_TABLE,
                where: { UID: client.id },
                data: { lastSeenAt: new Date(), lastSeenIp: String(ip || '') },
                context: { sessionID: SYSTEM_SESSION_ID }
            });
            await settingsStore.load();
        })
        .catch((e) => log.warn(`[backup/api] Отметка о визите не записана: ${e.message}`));
}

// ── Проверка запроса ────────────────────────────────────────────────────────────

function clientIp(req) {
    return String((req.headers && (req.headers['x-forwarded-for'] || '')) || '').split(',')[0].trim()
        || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function sweepNonces() {
    const now = Date.now();
    for (const [n, exp] of _nonces) if (exp < now) _nonces.delete(n);
}

function blocked(ip) {
    const rec = _fails.get(ip);
    if (!rec) return false;
    if (rec.blockedUntil && Date.now() < rec.blockedUntil) return true;
    if (rec.blockedUntil) { _fails.delete(ip); return false; }
    return false;
}

function noteFailure(ip) {
    const now = Date.now();
    const rec = _fails.get(ip) || { count: 0, first: now };
    if (now - rec.first > FAIL_WINDOW_MS) { rec.count = 0; rec.first = now; }
    rec.count++;
    if (rec.count >= FAIL_MAX) rec.blockedUntil = now + FAIL_BLOCK_MS;
    _fails.set(ip, rec);
}

function rateExceeded(fp) {
    const now = Date.now();
    const rec = _rate.get(fp);
    if (!rec || now - rec.windowStart > RATE_WINDOW_MS) {
        _rate.set(fp, { count: 1, windowStart: now });
        return false;
    }
    rec.count++;
    return rec.count > RATE_MAX;
}

/** Разбор заголовка `Authorization`. Пропущенное поле — не исключение, а отказ. */
function parseAuthHeader(raw) {
    const text = String(raw || '').trim();
    if (!text.toUpperCase().startsWith(SCHEME.toUpperCase() + ' ')) return null;
    const params = {};
    for (const part of text.slice(SCHEME.length + 1).split(',')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const k = part.slice(0, eq).trim();
        // Кавычки вокруг значения допускаются: их ставят и руками, и половина
        // http-библиотек — отвергать запрос из-за них было бы чистым буквоедством.
        const v = part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
        if (k) params[k] = v;
    }
    if (!params.keyId || !params.ts || !params.nonce || !params.sig) return null;
    return params;
}

/** Есть ли в запросе вообще попытка входа по ключу (чтобы отличить его от админского). */
function hasSignature(req) {
    return String((req.headers && req.headers['authorization']) || '')
        .toUpperCase().startsWith(SCHEME.toUpperCase() + ' ');
}

/**
 * Проверить подписанный запрос.
 *
 * Различаются ТОЛЬКО те причины отказа, которые ничего не выдают о содержимом сервера:
 * расхождение часов и повтор. «Ключ неизвестен», «ключ отключён» и «подпись неверна»
 * сливаются в одно `auth_failed` — иначе перебором выясняется список зарегистрированных
 * отпечатков. Зато расхождение часов названо прямо: без этого настройка нового
 * хранилища превращается в гадание, а узнать время сервера можно и из заголовка `Date`.
 *
 * @param {http.IncomingMessage} req
 * @param {Buffer|string} [body] — уже прочитанное тело (для POST); не передано — считается пустым
 * @returns {{ok: boolean, client?: Object, status?: number, error?: string, retryAfter?: number}}
 */
function verify(req, body) {
    const ip = clientIp(req);
    if (blocked(ip)) return { ok: false, status: 429, error: 'too_many_attempts', retryAfter: Math.ceil(FAIL_BLOCK_MS / 1000) };

    const params = parseAuthHeader(req.headers && req.headers['authorization']);
    if (!params) { noteFailure(ip); return { ok: false, status: 401, error: 'auth_failed' }; }

    const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(params.ts));
    if (!Number.isFinite(skew) || skew > MAX_SKEW_SEC) {
        noteFailure(ip);
        return { ok: false, status: 401, error: 'clock_skew' };
    }

    sweepNonces();
    if (_nonces.has(params.nonce)) {
        noteFailure(ip);
        return { ok: false, status: 401, error: 'replay' };
    }

    const client = listClients().find(c => c.fingerprint === params.keyId && !c.disabled);
    if (!client) { noteFailure(ip); return { ok: false, status: 401, error: 'auth_failed' }; }

    const bodySha = (body && body.length)
        ? crypto.createHash('sha256').update(body).digest('hex')
        : EMPTY_BODY_SHA;

    const signed = [
        'MOSBAK2',
        String(req.method || '').toUpperCase(),
        String(req.url || ''),
        String(params.ts),
        String(params.nonce),
        bodySha
    ].join('\n');

    let valid = false;
    try {
        valid = crypto.verify(
            null,                                   // Ed25519 подписывает сообщение целиком, без предварительного хэша
            Buffer.from(signed, 'utf8'),
            crypto.createPublicKey(client.publicKeyPem),
            Buffer.from(String(params.sig), 'base64')
        );
    } catch (e) {
        valid = false;                              // битая подпись — тот же отказ, что и неверная
    }
    if (!valid) { noteFailure(ip); return { ok: false, status: 401, error: 'auth_failed' }; }

    // Nonce запоминается ТОЛЬКО после успешной проверки: иначе любой желающий сможет
    // «сжечь» чужой nonce, отправив его с мусорной подписью раньше настоящего клиента.
    _nonces.set(params.nonce, Date.now() + NONCE_TTL_MS);

    if (rateExceeded(client.fingerprint)) {
        return { ok: false, status: 429, error: 'rate_limited', retryAfter: Math.ceil(RATE_WINDOW_MS / 1000) };
    }

    noteSeen(client, ip);
    return { ok: true, client, ip };
}

module.exports = {
    verify, hasSignature, clientIp,
    listClients, addClient, setClientDisabled, removeClient, validateClientKey, fingerprint,
    SCHEME, MAX_SKEW_SEC, RATE_MAX, RATE_WINDOW_MS
};
