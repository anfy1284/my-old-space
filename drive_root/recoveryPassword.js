'use strict';

/**
 * recoveryPassword — аварийный пароль администратора (ТЗ §6.2а).
 *
 * ЗАЧЕМ. Обычный вход зависит от базы: таблиц `users`/`sessions` может не быть вовсе
 * (разрушающий путь оборвался), либо сервер поднят в режиме обслуживания и рабочий стол
 * не развёрнут. Вход в сервисные действия обязан работать, когда БД недоступна, —
 * значит хранить пароль в БД нельзя по определению.
 *
 * ГДЕ. Хэшем в `dbSettings.json`: файл уже git-ignored и уже содержит реквизиты
 * подключения к базе — это его естественное место. В резервную копию он НЕ входит,
 * иначе аварийный пароль уехал бы во внешнее хранилище вместе с архивом.
 *
 * Это не ослабление защиты: у того, кто имеет доступ к файлам сервера, и так есть
 * реквизиты подключения к базе в этом же файле. Пароль защищает от того, кто дотянулся
 * до HTTP, но не до файловой системы, — а это ровно тот, от кого механизм и защищает.
 *
 * ЗАПИСЬ АТОМАРНА И СОХРАНЯЕТ ЧУЖИЕ КЛЮЧИ. Переписать `dbSettings.json` целиком и
 * умереть посреди записи — значит потерять реквизиты подключения, то есть сделать
 * механизм аварийного восстановления причиной аварии.
 *
 * ХЭШ ЧИТАЕТСЯ В МОМЕНТ ПРОВЕРКИ, а не кэшируется при старте: пароль могли задать
 * консольным скриптом уже после того, как сервер поднялся в режиме обслуживания
 * (приёмка §9 п. 25).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword, validatePassword } = require('./db/utilites');

const FILE_NAME = 'dbSettings.json';
const KEY = 'recoveryPasswordHash';

function projectRoot() {
    if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
    try {
        const r = require('./globalServerContext').getProjectRoot();
        if (r) return r;
    } catch (e) { /* контекст может быть ещё не поднят */ }
    return process.cwd();
}

function filePath() {
    return path.join(projectRoot(), FILE_NAME);
}

function readSettings() {
    const p = filePath();
    if (!fs.existsSync(p)) return {};
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    } catch (e) {
        throw new Error(`Файл ${FILE_NAME} повреждён: ${e.message}`);
    }
}

/** Задан ли аварийный пароль. Сам хэш наружу не отдаём никогда. */
function isSet() {
    try {
        const s = readSettings();
        return !!(s[KEY] && String(s[KEY]).length > 10);
    } catch (e) {
        return false;
    }
}

/**
 * Записать хэш, сохранив ВСЕ прочие ключи файла (в том числе реквизиты подключения).
 * Чтение-модификация-запись во временный файл + переименование: `rename` в пределах
 * одной ФС атомарен, поэтому прерывание не оставляет полуфайла.
 */
function _writeHash(hash) {
    const p = filePath();
    const current = readSettings();
    const next = Object.assign({}, current, { [KEY]: hash });

    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    try {
        fs.renameSync(tmp, p);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* уборка не важнее исходной ошибки */ }
        throw e;
    }
}

/**
 * Задать пароль (обычный путь: администратор ввёл его в форме или консольном скрипте).
 * @param {string} plain
 */
async function set(plain) {
    const pwd = String(plain || '');
    if (pwd.length < 8) {
        const e = new Error('Аварийный пароль короче 8 символов');
        e.errorKey = 'recovery_err_too_short';
        throw e;
    }
    _writeHash(await hashPassword(pwd));
    return true;
}

/**
 * Сгенерировать пароль, записать хэш и вернуть пароль ОДИН РАЗ.
 *
 * Пустое поле «до случая» означает, что в нужный момент пароля не окажется. Хэш
 * необратим, поэтому если механизм генерирует пароль сам, он ОБЯЗАН показать его один
 * раз — иначе получится хэш, к которому никто не знает пароля.
 *
 * @returns {Promise<string>} пароль открытым текстом; больше его не узнать
 */
async function generate() {
    // Алфавит без визуально неразличимых символов: пароль будут переписывать с экрана
    // на бумагу в неудачный день.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(24);
    let out = '';
    for (let i = 0; i < 20; i++) out += alphabet[bytes[i] % alphabet.length];
    const plain = `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15, 20)}`;
    _writeHash(await hashPassword(plain));
    return plain;
}

/**
 * Проверить введённый пароль.
 * Читаем хэш здесь и сейчас: его могли задать скриптом уже после старта сервера.
 */
async function verify(plain) {
    const pwd = String(plain || '');
    if (!pwd) return false;
    let hash = '';
    try { hash = readSettings()[KEY] || ''; } catch (e) { return false; }
    if (!hash) return false;
    try { return await validatePassword(pwd, hash); } catch (e) { return false; }
}

module.exports = { isSet, set, generate, verify, filePath, FILE_NAME, KEY };
