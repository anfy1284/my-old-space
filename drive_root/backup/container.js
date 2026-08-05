'use strict';

/**
 * container — формат файла резервной копии «MOSBAK01».
 *
 * Формат зафиксирован в брифе внешнего приложения (`tmp/backup_external_app/README.md`,
 * раздел «Формат файла») и является КОНТРАКТОМ с ним: менять раскладку байт нельзя,
 * не обновив бриф и не подняв `formatVersion`.
 *
 *   0    8   magic "MOSBAK01"
 *   8    1   formatVersion = 1
 *   9    1   algId = 1  (RSA-4096-OAEP-SHA256 обёртка DEK + AES-256-GCM по чанкам)
 *   10   2   wrappedKeyLen (uint16, BE)
 *   12   K   wrappedKey — DEK, завёрнутый публичным ключом
 *   12+K 4   headerJsonLen (uint32, BE)
 *   …    M   headerJson (UTF-8, ОТКРЫТЫМ ТЕКСТОМ)
 *   …    …   чанки: [uint32 cipherLen][16 байт GCM-тег][cipherLen байт шифротекста]
 *   конец 49 трейлер: "MOSBAKEND" + SHA-256 открытого текста + uint64 его размера
 *
 * Заголовок открыт намеренно: версию структуры БД, дату и область выгрузки нужно
 * уметь прочитать без приватного ключа. Данных в нём нет, а подмена исключена тем,
 * что его хэш входит в AAD каждого чанка.
 *
 * nonce чанка не хранится, а вычисляется: noncePrefix(4) || chunkIndex(uint64).
 * `isFinal` в AAD последнего чанка даёт обнаружение ОБРЕЗАННОГО файла: без него
 * расшифровка не сойдётся, а не «прочитается наполовину».
 */

const crypto = require('crypto');
const { Transform } = require('stream');

const keys = require('./keys');

const MAGIC = Buffer.from('MOSBAK01', 'ascii');
const TRAILER_MAGIC = Buffer.from('MOSBAKEND', 'ascii');
const FORMAT_VERSION = 1;
const ALG_ID = 1;
const TAG_LEN = 16;
const NONCE_LEN = 12;
const NONCE_PREFIX_LEN = 4;
const TRAILER_LEN = TRAILER_MAGIC.length + 32 + 8;   // 9 + 32 + 8 = 49
const DEFAULT_CHUNK_SIZE = 1024 * 1024;

/** uint64 BE — размеры дампа выходят за 32 бита, а Buffer#writeUInt64BE нет. */
function uint64BE(value) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(value));
    return b;
}

/** AAD чанка: хэш заголовка || индекс чанка || признак последнего. */
function chunkAAD(headerHash, index, isFinal) {
    return Buffer.concat([headerHash, uint64BE(index), Buffer.from([isFinal ? 1 : 0])]);
}

function chunkNonce(noncePrefix, index) {
    return Buffer.concat([noncePrefix, uint64BE(index)]);
}

/**
 * Собрать байты заголовка (всё до первого чанка).
 * @returns {{bytes: Buffer, hash: Buffer, headerJson: Object}}
 */
function buildHeaderBytes(wrappedKey, headerObj) {
    const headerJson = Buffer.from(JSON.stringify(headerObj), 'utf8');

    const prefix = Buffer.alloc(12);
    MAGIC.copy(prefix, 0);
    prefix.writeUInt8(FORMAT_VERSION, 8);
    prefix.writeUInt8(ALG_ID, 9);
    prefix.writeUInt16BE(wrappedKey.length, 10);

    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(headerJson.length, 0);

    const bytes = Buffer.concat([prefix, wrappedKey, lenBuf, headerJson]);
    return { bytes, hash: crypto.createHash('sha256').update(bytes).digest() };
}

/**
 * Поток шифрования: на вход открытый текст (gzip-поток дампа), на выходе файл целиком.
 *
 * Чанк отдаётся только когда известно, последний он или нет (`isFinal` входит в AAD),
 * поэтому в буфере всегда придерживается хвост: выпускаем, пока данных СТРОГО больше
 * размера чанка.
 */
class EncryptStream extends Transform {
    /**
     * @param {Object} opts
     * @param {string} opts.publicKeyPem
     * @param {Object} opts.header — содержимое headerJson (без `noncePrefix`/`chunkSize`)
     * @param {number} [opts.chunkSize]
     */
    constructor(opts) {
        super();
        const chunkSize = Number(opts.chunkSize) || DEFAULT_CHUNK_SIZE;
        const dek = crypto.randomBytes(32);
        const noncePrefix = crypto.randomBytes(NONCE_PREFIX_LEN);

        const header = Object.assign({}, opts.header, {
            chunkSize,
            noncePrefix: noncePrefix.toString('hex')
        });

        const wrapped = keys.wrapKey(opts.publicKeyPem, dek);
        const built = buildHeaderBytes(wrapped, header);

        this._dek = dek;
        this._noncePrefix = noncePrefix;
        this._chunkSize = chunkSize;
        this._headerHash = built.hash;
        this._buffer = Buffer.alloc(0);
        this._index = 0;
        this._plainSize = 0;
        this._plainHash = crypto.createHash('sha256');
        this._headerBytes = built.bytes;
        this._headerWritten = false;
    }

    /** Размер заголовка — нужен, чтобы читатель мог оценить смещение первого чанка. */
    get headerLength() { return this._headerBytes.length; }

    _emitChunk(plain, isFinal) {
        const cipher = crypto.createCipheriv('aes-256-gcm', this._dek, chunkNonce(this._noncePrefix, this._index));
        cipher.setAAD(chunkAAD(this._headerHash, this._index, isFinal));
        const body = Buffer.concat([cipher.update(plain), cipher.final()]);
        const tag = cipher.getAuthTag();

        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(body.length, 0);
        this.push(Buffer.concat([lenBuf, tag, body]));
        this._index++;
    }

    _transform(piece, _enc, cb) {
        try {
            if (!this._headerWritten) { this.push(this._headerBytes); this._headerWritten = true; }
            this._plainSize += piece.length;
            this._plainHash.update(piece);
            this._buffer = this._buffer.length ? Buffer.concat([this._buffer, piece]) : piece;

            // Строго «больше»: ровно один чанк данных мог бы оказаться последним.
            while (this._buffer.length > this._chunkSize) {
                this._emitChunk(this._buffer.subarray(0, this._chunkSize), false);
                this._buffer = this._buffer.subarray(this._chunkSize);
            }
            cb();
        } catch (e) { cb(e); }
    }

    _flush(cb) {
        try {
            if (!this._headerWritten) { this.push(this._headerBytes); this._headerWritten = true; }
            // Последний чанк выпускается ВСЕГДА, даже пустой: именно он несёт isFinal,
            // без которого обрезанный файл не отличить от целого.
            this._emitChunk(this._buffer, true);
            this._buffer = Buffer.alloc(0);
            this.push(Buffer.concat([TRAILER_MAGIC, this._plainHash.digest(), uint64BE(this._plainSize)]));
            cb();
        } catch (e) { cb(e); }
    }
}

/**
 * Разобрать заголовок из начала файла — БЕЗ приватного ключа.
 *
 * Достаточно первых сотен байт: так внешнее хранилище каталогизирует архивы, а форма
 * показывает версию структуры и область выгрузки до всякой расшифровки.
 * @param {Buffer} head — начало файла (рекомендуется ≥ 64 КБ)
 * @returns {{formatVersion: number, algId: number, header: Object, wrappedKey: Buffer, headerBytes: Buffer, headerHash: Buffer}}
 */
function parseHeader(head) {
    if (!Buffer.isBuffer(head) || head.length < 12) throw new Error('Файл слишком мал для заголовка резервной копии');
    if (!head.subarray(0, 8).equals(MAGIC)) throw new Error('Это не файл резервной копии (magic не совпал)');

    const formatVersion = head.readUInt8(8);
    const algId = head.readUInt8(9);
    if (formatVersion !== FORMAT_VERSION) throw new Error(`Неподдерживаемая версия формата: ${formatVersion}`);
    if (algId !== ALG_ID) throw new Error(`Неподдерживаемый алгоритм: ${algId}`);

    const wrappedLen = head.readUInt16BE(10);
    const wrappedEnd = 12 + wrappedLen;
    if (head.length < wrappedEnd + 4) throw new Error('Заголовок обрезан');

    const wrappedKey = head.subarray(12, wrappedEnd);
    const jsonLen = head.readUInt32BE(wrappedEnd);
    const jsonEnd = wrappedEnd + 4 + jsonLen;
    if (head.length < jsonEnd) throw new Error('Заголовок обрезан: headerJson не помещается в прочитанный фрагмент');

    let header;
    try {
        header = JSON.parse(head.subarray(wrappedEnd + 4, jsonEnd).toString('utf8'));
    } catch (e) {
        throw new Error(`headerJson нечитаем: ${e.message}`);
    }

    const headerBytes = head.subarray(0, jsonEnd);
    return {
        formatVersion, algId, header, wrappedKey,
        headerBytes: Buffer.from(headerBytes),
        headerHash: crypto.createHash('sha256').update(headerBytes).digest()
    };
}

/**
 * Поток расшифровки: на вход файл целиком, на выходе открытый текст.
 *
 * Проверяется всё, что формат позволяет проверить: тег каждого чанка, порядок чанков,
 * наличие завершающего чанка, трейлер (SHA-256 и размер). Любое несовпадение —
 * немедленная ошибка, а не «прочитали сколько смогли».
 */
class DecryptStream extends Transform {
    /**
     * @param {Object} opts
     * @param {string} opts.privateKeyPem
     * @param {string} [opts.passphrase]
     */
    constructor(opts) {
        super();
        this._privateKeyPem = opts.privateKeyPem;
        this._passphrase = opts.passphrase;
        this._buffer = Buffer.alloc(0);
        this._state = 'header';
        this._index = 0;
        this._plainSize = 0;
        this._plainHash = crypto.createHash('sha256');
        this._sawFinal = false;
        this.header = null;
    }

    _tryHeader() {
        let parsed;
        try {
            parsed = parseHeader(this._buffer);
        } catch (e) {
            // Заголовок мог просто не дочитаться — ждём данных, но только если
            // magic уже совпал (иначе это заведомо чужой файл).
            if (this._buffer.length >= 8 && !this._buffer.subarray(0, 8).equals(MAGIC)) throw e;
            if (/обрезан|слишком мал/.test(e.message)) return false;
            throw e;
        }
        this._dek = keys.unwrapKey(this._privateKeyPem, parsed.wrappedKey, this._passphrase);
        this._headerHash = parsed.headerHash;
        this._noncePrefix = Buffer.from(String(parsed.header.noncePrefix || ''), 'hex');
        if (this._noncePrefix.length !== NONCE_PREFIX_LEN) throw new Error('В заголовке нет корректного noncePrefix');
        this.header = parsed.header;
        this._buffer = this._buffer.subarray(parsed.headerBytes.length);
        this._state = 'chunks';
        this.emit('header', parsed.header);
        return true;
    }

    /**
     * Разобрать один чанк.
     *
     * `isFinal` входит в AAD, поэтому решать его по текущему наполнению буфера НЕЛЬЗЯ:
     * в середине потока после очередного чанка может случайно остаться ровно длина
     * трейлера, и «финальный» чанк был бы аутентифицирован неверным AAD — целый файл
     * объявился бы повреждённым. Поэтому в потоке обрабатываем чанк, только когда
     * ЗАВЕДОМО есть данные после трейлера (значит, за ним идёт ещё один чанк), а
     * последний чанк разбирается в `_flush`, когда поток кончился.
     *
     * @param {boolean} atEnd — поток завершён, оставшийся чанк финальный
     * @returns {boolean} удалось ли продвинуться
     */
    _tryChunk(atEnd) {
        if (this._buffer.length < 4) return false;
        const cipherLen = this._buffer.readUInt32BE(0);
        const total = 4 + TAG_LEN + cipherLen;
        if (this._buffer.length < total + TRAILER_LEN) {
            if (!atEnd) return false;
            throw new Error('Файл резервной копии обрезан: чанк не помещается до конца файла');
        }

        const rest = this._buffer.length - total;
        const isFinal = rest === TRAILER_LEN;
        if (!isFinal && rest < TRAILER_LEN) throw new Error('Файл резервной копии повреждён: неверная длина чанка');
        if (isFinal && !atEnd) return false;      // ждём конца потока — вдруг данные ещё идут

        const tag = this._buffer.subarray(4, 4 + TAG_LEN);
        const body = this._buffer.subarray(4 + TAG_LEN, total);

        const decipher = crypto.createDecipheriv('aes-256-gcm', this._dek, chunkNonce(this._noncePrefix, this._index));
        decipher.setAAD(chunkAAD(this._headerHash, this._index, isFinal));
        decipher.setAuthTag(tag);
        let plain;
        try {
            plain = Buffer.concat([decipher.update(body), decipher.final()]);
        } catch (e) {
            throw new Error(`Чанк ${this._index} не проходит проверку подлинности — файл повреждён или подделан`);
        }

        this._plainSize += plain.length;
        this._plainHash.update(plain);
        if (plain.length) this.push(plain);

        this._buffer = this._buffer.subarray(total);
        this._index++;
        if (isFinal) { this._sawFinal = true; this._state = 'trailer'; }
        return true;
    }

    _pump(atEnd) {
        for (;;) {
            if (this._state === 'header') { if (!this._tryHeader()) return; continue; }
            if (this._state === 'chunks') { if (!this._tryChunk(atEnd)) return; continue; }
            return;
        }
    }

    _transform(piece, _enc, cb) {
        try {
            this._buffer = this._buffer.length ? Buffer.concat([this._buffer, piece]) : piece;
            this._pump(false);
            cb();
        } catch (e) { cb(e); }
    }

    _flush(cb) {
        try {
            this._pump(true);
            if (this._state === 'header') throw new Error('Файл резервной копии обрывается на заголовке');
            if (!this._sawFinal) throw new Error('Файл резервной копии обрезан: не найден завершающий чанк');
            if (this._buffer.length !== TRAILER_LEN) throw new Error('Трейлер отсутствует или повреждён');
            if (!this._buffer.subarray(0, TRAILER_MAGIC.length).equals(TRAILER_MAGIC)) throw new Error('Подпись трейлера не совпала');

            const expectHash = this._buffer.subarray(TRAILER_MAGIC.length, TRAILER_MAGIC.length + 32);
            const expectSize = this._buffer.readBigUInt64BE(TRAILER_MAGIC.length + 32);
            const actualHash = this._plainHash.digest();

            if (!actualHash.equals(expectHash)) throw new Error('SHA-256 открытого текста не совпал с трейлером');
            if (BigInt(this._plainSize) !== expectSize) {
                throw new Error(`Размер открытого текста не совпал с трейлером: ${this._plainSize} вместо ${expectSize}`);
            }
            cb();
        } catch (e) { cb(e); }
    }
}

module.exports = {
    EncryptStream, DecryptStream, parseHeader,
    MAGIC, TRAILER_MAGIC, FORMAT_VERSION, ALG_ID, TRAILER_LEN, DEFAULT_CHUNK_SIZE
};
