/**
 * httpCache — условное HTTP-кэширование статики (ТЗ «Оптимизация фреймворка»,
 * п. 0.5): ETag / Cache-Control / Last-Modified + ответы 304 Not Modified.
 *
 * Проблема: каждый F5 и каждое открытие окна заново качают все скрипты, CSS и
 * КАЖДУЮ иконку 16×16 отдельным запросом (их десятки на форму). Ни один ответ
 * не имеет Cache-Control/ETag, условные запросы (304) не поддерживаются.
 *
 * Две стратегии:
 *  - Файлы, не зависящие от языка (png/css/svg/шрифты): сильный ETag по
 *    mtime+size + `Cache-Control: public, max-age=86400` + Last-Modified.
 *    Браузер вообще перестаёт перезапрашивать в течение суток.
 *  - JS/бандлы, проходящие перевод __t() по языку сессии: ETag по ХЭШУ уже
 *    обработанного текста (различается между языками!) + `Cache-Control:
 *    no-cache` (всегда ревалидировать). При смене языка URL тот же, но контент
 *    другой → ETag не совпадёт → отдадим новый (не отдадим чужой язык из кэша).
 *    304 при этом всё равно экономит трафик, когда язык тот же.
 *
 * Взаимодействие с 0.4 (сжатие): ETag считается по несжатому телу; обёртка
 * сжатия прозрачна на том же URL и добавляет Vary: Accept-Encoding. 304-ответ
 * тела не несёт — обёртка сжатия его не трогает.
 */

const crypto = require('crypto');

/** Сильный ETag для файла на диске — дёшево, по размеру и времени правки. */
function fileETag(stat) {
    return '"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
}

/** ETag по содержимому (для обработанного JS/бандла, зависящего от языка/роли). */
function contentETag(textOrBuf) {
    const hash = crypto.createHash('sha1').update(textOrBuf).digest('base64');
    // base64 без '=' хвоста — достаточно для уникальности
    return 'W/"' + hash.replace(/=+$/, '') + '"';
}

/** Заголовки для статического файла (картинка/css/шрифт). */
function fileHeaders(stat, contentType, maxAge) {
    const age = maxAge == null ? 86400 : maxAge;
    return {
        'Content-Type': contentType,
        'Cache-Control': `public, max-age=${age}`,
        'ETag': fileETag(stat),
        'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
    };
}

/** Заголовки для обработанного JS/бандла (перевод по языку). */
function jsHeaders(text, contentType) {
    return {
        'Content-Type': contentType,
        // Всегда ревалидировать: контент зависит от языка сессии при том же URL.
        'Cache-Control': 'no-cache',
        'ETag': contentETag(text),
    };
}

/**
 * Совпадает ли клиентский кэш с текущей версией.
 * @param {object} req
 * @param {string} etag           - текущий ETag (может быть null)
 * @param {string} lastModifiedHdr- значение Last-Modified (строка) или null
 */
function isFresh(req, etag, lastModifiedHdr) {
    const h = req.headers || {};
    const inm = h['if-none-match'];
    if (inm && etag) {
        // If-None-Match может содержать список через запятую
        const tags = inm.split(',').map(s => s.trim());
        if (tags.includes(etag) || tags.includes('*')) return true;
        // Сравнение weak/strong без учёта префикса W/
        const bare = etag.replace(/^W\//, '');
        if (tags.some(t => t.replace(/^W\//, '') === bare)) return true;
    }
    const ims = h['if-modified-since'];
    if (ims && lastModifiedHdr && !inm) {
        const since = Date.parse(ims);
        const lm = Date.parse(lastModifiedHdr);
        if (!isNaN(since) && !isNaN(lm) && lm <= since) return true;
    }
    return false;
}

/**
 * Если кэш клиента свеж — отправить 304 и вернуть true (вызывающий делает return).
 * Иначе вернуть false (вызывающий шлёт 200 с теми же заголовками).
 */
function maybe304(req, res, headers) {
    if (isFresh(req, headers['ETag'], headers['Last-Modified'])) {
        // В 304 повторяем валидаторы/Cache-Control, тело пустое.
        const h304 = {};
        if (headers['ETag']) h304['ETag'] = headers['ETag'];
        if (headers['Cache-Control']) h304['Cache-Control'] = headers['Cache-Control'];
        if (headers['Last-Modified']) h304['Last-Modified'] = headers['Last-Modified'];
        res.writeHead(304, h304);
        res.end();
        return true;
    }
    return false;
}

module.exports = { fileETag, contentETag, fileHeaders, jsHeaders, isFresh, maybe304 };
