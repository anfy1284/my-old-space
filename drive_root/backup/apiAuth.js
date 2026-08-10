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
 *     MOSBAK1
 *     <МЕТОД заглавными>
 *     <путь вместе со строкой запроса, ровно как отправлен>
 *     <ts — секунды Unix>
 *     <nonce>
 *     <sha256-hex тела запроса; у запроса без тела — sha256 пустой строки>
 *
 * Подпись передаётся заголовком:
 *
 *     Authorization: MOSBAK1-Ed25519 keyId=<отпечаток>,ts=<…>,nonce=<…>,sig=<base64>
 *
 * Метод и путь входят в подпись НЕ для красоты: без них перехваченную подпись можно
 * предъявить другому роуту (подпись от `ping` сгодилась бы для `download`), а тело в
 * подписи закрывает подмену параметров `ack`.
 */

const crypto = require('crypto');

const log = require('../log');
const settingsStore = require('./settings');

const SCHEME = 'MOSBAK1-Ed25519';

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

/** Список зарегистрированных клиентов (как лежит в файле настроек). */
function listClients() {
    const s = settingsStore.read();
    return Array.isArray(s.apiClients) ? s.apiClients : [];
}

/**
 * Зарегистрировать клиента.
 *
 * Повторная регистрация того же ключа — не ошибка, а ВКЛЮЧЕНИЕ обратно: администратор,
 * который отключил доступ и передумал, вставит тот же ключ, и ожидает, что он заработает,
 * а не что появится второй такой же.
 */
function addClient(name, publicKeyPem) {
    const v = validateClientKey(publicKeyPem);
    if (!v.ok) return v;

    const clients = listClients().slice();
    const pem = String(publicKeyPem).trim();
    const existing = clients.find(c => c.fingerprint === v.fingerprint);
    if (existing) {
        existing.name = String(name || existing.name || '').trim() || existing.name;
        existing.disabled = false;
        existing.publicKeyPem = pem;
    } else {
        clients.push({
            id: crypto.randomBytes(8).toString('hex'),
            name: String(name || '').trim() || v.fingerprint.slice(7, 19),
            publicKeyPem: pem,
            fingerprint: v.fingerprint,
            algorithm: 'ed25519',
            createdAt: new Date().toISOString(),
            disabled: false,
            lastSeenAt: '',
            lastSeenIp: ''
        });
    }
    settingsStore.write({ apiClients: clients });
    log.info(`[backup/api] Зарегистрирован клиент ${v.fingerprint}`);
    return { ok: true, fingerprint: v.fingerprint, added: !existing };
}

/** Включить/выключить клиента. Отключение мгновенно: реестр читается на каждом запросе. */
function setClientDisabled(id, disabled) {
    const clients = listClients().slice();
    const c = clients.find(x => x.id === id || x.fingerprint === id);
    if (!c) return { ok: false, errorKey: 'backup_api_err_client_unknown' };
    c.disabled = !!disabled;
    settingsStore.write({ apiClients: clients });
    log.info(`[backup/api] Клиент ${c.fingerprint} ${disabled ? 'отключён' : 'включён'}`);
    return { ok: true };
}

/** Удалить клиента насовсем. */
function removeClient(id) {
    const clients = listClients();
    const next = clients.filter(x => x.id !== id && x.fingerprint !== id);
    if (next.length === clients.length) return { ok: false, errorKey: 'backup_api_err_client_unknown' };
    settingsStore.write({ apiClients: next });
    log.info(`[backup/api] Клиент ${id} удалён`);
    return { ok: true };
}

/**
 * Отметить, что клиент выходил на связь.
 *
 * Пишется в файл настроек, но НЕ чаще раза в минуту: это диагностика («архив молчит
 * третий день»), а не учёт, и превращать её в запись файла на каждый запрос незачем.
 * В памяти держать нельзя — после перезапуска сервера отметка нужна как раз больше
 * всего: именно тогда и выясняют, кто перестал приходить.
 */
const LAST_SEEN_FLUSH_MS = 60 * 1000;

function noteSeen(client, ip) {
    const prev = _lastSeenFlush.get(client.fingerprint) || 0;
    if (Date.now() - prev < LAST_SEEN_FLUSH_MS) return;
    _lastSeenFlush.set(client.fingerprint, Date.now());
    try {
        const clients = listClients().slice();
        const c = clients.find(x => x.fingerprint === client.fingerprint);
        if (!c) return;
        c.lastSeenAt = new Date().toISOString();
        c.lastSeenIp = String(ip || '');
        settingsStore.write({ apiClients: clients });
    } catch (e) {
        // Отметка о визите не важнее самого визита: запрос обязан пройти и без неё.
        log.warn(`[backup/api] Отметка о визите не записана: ${e.message}`);
    }
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
        'MOSBAK1',
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
