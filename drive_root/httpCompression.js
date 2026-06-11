/**
 * httpCompression — прозрачное gzip/brotli-сжатие ответов (ТЗ «Оптимизация
 * фреймворка», п. 0.4).
 *
 * Проблема: клиент при каждом заходе качает несжатыми UI_classes.js (505KB),
 * client.js, бандл /app/loadApps, style.css, JSON-лейауты форм (десятки KB).
 * На медленном канале это и есть «тормоза».
 *
 * Решение без переписывания ~30 мест `res.writeHead`/`res.end`: единая обёртка
 * `install(req, res)`, поставленная в requestListener (drive_root/createServer).
 * И drive_root, и drive_forms, и handleDirectRequest приложений пишут в ОДИН и
 * тот же `res` (drive_forms вызывается изнутри drive_root с тем же объектом),
 * поэтому один патч накрывает все ответы обоих серверов.
 *
 * Как работает: перехватываем writeHead/write/end. Решение «сжимать или нет»
 * принимается по Content-Type (только текст/js/css/html/json/svg) и
 * Accept-Encoding клиента. Сжимаемый ответ буферизуется и сжимается на `end`;
 * мелочь (< MIN_SIZE) отдаётся как есть. Несжимаемое (картинки) и потоковые
 * ответы (SSE, text/event-stream — определяются по Content-Type ещё до первого
 * write) идут passthrough без буферизации.
 *
 * Инвариант (как у perfMetrics): обёртка НЕ должна ломать ответ ни при каких
 * условиях — критичные ветки в try/catch с fallback на оригинальный путь.
 *
 * Порядок патчей: perfMetrics патчит writeHead ПЕРВЫМ (внутри runWithRequest),
 * мы ставимся поверх и при реальном флаше зовём его writeHead → Server-Timing
 * по-прежнему проставляется (и даже точнее — на момент фактической отправки).
 *
 * Управление (env):
 *   COMPRESS_DISABLE=1 — полностью выключить сжатие
 *   COMPRESS_MIN_BYTES — порог сжатия, байт (default 1024)
 */

const zlib = require('zlib');

const DISABLED = process.env.COMPRESS_DISABLE === '1';
const MIN_SIZE = Number(process.env.COMPRESS_MIN_BYTES) || 1024;

// Сжимаем только текстовые типы. Картинки (кроме svg), шрифты, уже сжатое —
// мимо (gzip их не уменьшает, только жжёт CPU).
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|xml|manifest\+json|.*\+json|.*\+xml)|image\/svg\+xml)/i;

// На слабом CPU brotli quality 11 (default) — секунды на крупный файл, поэтому
// предпочитаем gzip (дешевле), brotli — только если клиент не принимает gzip,
// и то с умеренным quality.
const BROTLI_OPTS = {
    params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: 0
    }
};

/** Выбрать кодировку по Accept-Encoding (gzip приоритетнее — дешевле по CPU). */
function pickEncoding(req) {
    const ae = String((req.headers && req.headers['accept-encoding']) || '');
    if (/\bgzip\b/i.test(ae)) return 'gzip';
    if (/\bbr\b/i.test(ae)) return 'br';
    return null;
}

function toBuffer(chunk, enc) {
    if (chunk == null) return null;
    if (Buffer.isBuffer(chunk)) return chunk;
    return Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8');
}

/**
 * Поставить прозрачное сжатие на пару (req, res).
 * Вызывается один раз на входе каждого запроса.
 */
function install(req, res) {
    if (DISABLED) return;
    const encoding = pickEncoding(req);
    if (!encoding) return; // клиент не принимает сжатие — ничего не делаем

    // origWriteHead — это writeHead, уже пропатченный perfMetrics (Server-Timing).
    const origWriteHead = res.writeHead.bind(res);
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    let statusCode = 200;
    let decided = false;     // решение compress/passthrough принято
    let compress = false;
    let headFlushed = false; // реальный writeHead уже вызван (passthrough/compress)
    let chunks = [];

    // Применяем заголовки, переданные в writeHead, через setHeader — чтобы
    // getHeader работал, а фактический флаш отложить до решения.
    function applyHeaders(hdrs) {
        if (!hdrs) return;
        try {
            if (Array.isArray(hdrs)) {
                for (let i = 0; i < hdrs.length - 1; i += 2) res.setHeader(hdrs[i], hdrs[i + 1]);
            } else {
                for (const k of Object.keys(hdrs)) res.setHeader(k, hdrs[k]);
            }
        } catch (e) { /* заголовки уже отправлены — не наша забота */ }
    }

    function decide() {
        if (decided) return;
        decided = true;
        try {
            const ct = String(res.getHeader('Content-Type') || '');
            const ce = res.getHeader('Content-Encoding');
            // Не сжимаем: уже закодировано, потоковый SSE, несжимаемый тип.
            if (ce || /event-stream/i.test(ct) || !COMPRESSIBLE.test(ct)) {
                compress = false;
            } else {
                compress = true;
            }
        } catch (e) {
            compress = false;
        }
    }

    function ensureHeadFlushed() {
        if (headFlushed) return;
        headFlushed = true;
        try { origWriteHead(statusCode); } catch (e) { /* ignore */ }
    }

    res.writeHead = function (status, reasonOrHeaders, maybeHeaders) {
        statusCode = status;
        let hdrs;
        if (typeof reasonOrHeaders === 'string') {
            try { res.statusMessage = reasonOrHeaders; } catch (e) { }
            hdrs = maybeHeaders;
        } else {
            hdrs = reasonOrHeaders;
        }
        applyHeaders(hdrs);
        // Флаш откладываем — фактический writeHead вызовем в write/end после decide().
        return res;
    };

    res.write = function (chunk, enc, cb) {
        try {
            if (!decided) decide();
            if (compress) {
                const b = toBuffer(chunk, enc);
                if (b) chunks.push(b);
                if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb();
                return true; // буферизуем — backpressure имитируем как «ок»
            }
            ensureHeadFlushed();
            return origWrite(chunk, enc, cb);
        } catch (e) {
            // Любой сбой — деградируем в прямую запись, ответ важнее метрик/сжатия.
            try { ensureHeadFlushed(); return origWrite(chunk, enc, cb); } catch (e2) { return false; }
        }
    };

    res.end = function (chunk, enc, cb) {
        // Нормализуем перегрузки end(cb) / end(chunk, cb)
        if (typeof chunk === 'function') { cb = chunk; chunk = undefined; enc = undefined; }
        else if (typeof enc === 'function') { cb = enc; enc = undefined; }

        try {
            if (!decided) decide();

            if (!compress) {
                ensureHeadFlushed();
                return origEnd(chunk, enc, cb);
            }

            const last = toBuffer(chunk, enc);
            if (last) chunks.push(last);
            const body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
            chunks = [];

            // Мелочь не сжимаем — экономия CPU, выигрыш от gzip минимален.
            if (body.length < MIN_SIZE) {
                try { res.removeHeader('Content-Encoding'); } catch (e) { }
                try { res.setHeader('Content-Length', body.length); } catch (e) { }
                ensureHeadFlushed();
                return origEnd(body, cb);
            }

            let out;
            try {
                out = encoding === 'br' ? zlib.brotliCompressSync(body, BROTLI_OPTS) : zlib.gzipSync(body);
            } catch (e) {
                // Сжатие не удалось — отдаём оригинал.
                try { res.setHeader('Content-Length', body.length); } catch (e2) { }
                ensureHeadFlushed();
                return origEnd(body, cb);
            }

            try {
                res.setHeader('Content-Encoding', encoding);
                res.setHeader('Content-Length', out.length);
                // Кэши/прокси должны различать ответы по кодировке (важно для 0.5 ETag).
                const vary = res.getHeader('Vary');
                if (!vary) res.setHeader('Vary', 'Accept-Encoding');
                else if (!/accept-encoding/i.test(String(vary))) res.setHeader('Vary', vary + ', Accept-Encoding');
            } catch (e) { /* ignore */ }

            ensureHeadFlushed();
            return origEnd(out, cb);
        } catch (e) {
            // Полная деградация: отдать как есть, ничего не сломав.
            try { ensureHeadFlushed(); return origEnd(chunk, enc, cb); } catch (e2) { return res; }
        }
    };
}

module.exports = { install };
