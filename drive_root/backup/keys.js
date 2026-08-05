'use strict';

/**
 * keys — публичный ключ шифрования бэкапов и его отпечаток.
 *
 * Гибридная схема (ТЗ §4): на сервере лежит ТОЛЬКО публичный ключ. Приватный не
 * хранится нигде — ни в БД, ни в файле, ни в журнале. Основной путь получения пары —
 * внешнее приложение-хранилище; пока его нет, пару порождает форма (§2), отдавая
 * приватный ключ скачиванием ровно один раз.
 *
 * Отпечаток публичного ключа секретом не является и нужен для того, чтобы через год
 * было понятно, каким из нескольких приватных ключей расшифровывать файл: он едет в
 * открытом заголовке дампа и дублируется в `backup_files`.
 */

const crypto = require('crypto');

const MODULUS_BITS = 4096;

/**
 * Отпечаток публичного ключа: SHA-256 его DER-представления.
 *
 * Считается именно по DER, а не по тексту PEM: один и тот же ключ, пересохранённый
 * с другими переводами строк или заголовком, дал бы другой отпечаток — и файлы,
 * зашифрованные им же, выглядели бы «чужими».
 * @param {string|crypto.KeyObject} publicKey
 * @returns {string} `sha256:<hex>`
 */
function fingerprint(publicKey) {
    const key = typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey;
    const der = key.export({ type: 'spki', format: 'der' });
    return 'sha256:' + crypto.createHash('sha256').update(der).digest('hex');
}

/**
 * Проверить PEM публичного ключа, пригодного для RSA-OAEP.
 * @param {string} pem
 * @returns {{ok: boolean, errorKey?: string, vars?: Object, fingerprint?: string, bits?: number}}
 */
function validatePublicKey(pem) {
    if (!pem || !String(pem).trim()) return { ok: false, errorKey: 'backup_err_key_empty' };
    let key;
    try {
        key = crypto.createPublicKey(String(pem));
    } catch (e) {
        return { ok: false, errorKey: 'backup_err_key_unparsable', vars: { message: e.message } };
    }
    if (key.asymmetricKeyType !== 'rsa') {
        return { ok: false, errorKey: 'backup_err_key_not_rsa', vars: { type: String(key.asymmetricKeyType) } };
    }
    // Длина модуля определяет и стойкость, и размер обёрнутого DEK в заголовке файла
    // (`wrappedKeyLen`), поэтому короткий ключ — не «слабее», а несовместим с форматом.
    const bits = (key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength) || 0;
    if (bits < MODULUS_BITS) {
        return { ok: false, errorKey: 'backup_err_key_too_short', vars: { bits: String(bits), need: String(MODULUS_BITS) } };
    }
    return { ok: true, fingerprint: fingerprint(key), bits };
}

/**
 * Породить пару ключей.
 *
 * Приватный ключ возвращается ВЫЗЫВАЮЩЕМУ и здесь никуда не сохраняется — решение,
 * куда его деть, принимает вызывающий код (форма отдаёт его на скачивание один раз).
 * @param {string} [passphrase] — если задана, приватный ключ шифруется ею
 * @returns {{publicKeyPem: string, privateKeyPem: string, fingerprint: string}}
 */
function generatePair(passphrase) {
    const privateKeyEncoding = { type: 'pkcs8', format: 'pem' };
    if (passphrase) {
        privateKeyEncoding.cipher = 'aes-256-cbc';
        privateKeyEncoding.passphrase = String(passphrase);
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: MODULUS_BITS,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding
    });
    return { publicKeyPem: publicKey, privateKeyPem: privateKey, fingerprint: fingerprint(publicKey) };
}

/**
 * Завернуть DEK публичным ключом (RSA-OAEP-SHA256).
 * @param {string|crypto.KeyObject} publicKey
 * @param {Buffer} dek
 * @returns {Buffer}
 */
function wrapKey(publicKey, dek) {
    const key = typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey;
    return crypto.publicEncrypt(
        { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        dek
    );
}

/**
 * Развернуть DEK приватным ключом. Нужен восстановлению (этап 2.2+); на сервере
 * ключ живёт только в памяти на время операции.
 * @param {string|crypto.KeyObject} privateKey
 * @param {Buffer} wrapped
 * @param {string} [passphrase]
 * @returns {Buffer}
 */
function unwrapKey(privateKey, wrapped, passphrase) {
    const keySpec = typeof privateKey === 'string'
        ? (passphrase ? { key: privateKey, passphrase: String(passphrase) } : privateKey)
        : privateKey;
    const key = crypto.createPrivateKey(keySpec);
    return crypto.privateDecrypt(
        { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        wrapped
    );
}

module.exports = { fingerprint, validatePublicKey, generatePair, wrapKey, unwrapKey, MODULUS_BITS };
