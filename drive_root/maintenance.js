'use strict';

/**
 * maintenance — режим обслуживания: файловый флаг и состояние операции (ТЗ §6.2).
 *
 * ФЛАГ ЛЕЖИТ В ФАЙЛЕ И НЕ СНИМАЕТСЯ САМ ПРИ ПЕРЕЗАПУСКЕ. Это не перестраховка, а
 * главное свойство механизма. Сценарий, который получается при автоснятии:
 * восстановление умерло после начала записи, процесс мёртв, утром кто-то запускает
 * сервер, флаг снят — и сервер начинает обслуживать наполовину заполненную базу.
 * Пользователи создают в ней брони и счета поверх обломков. Через час это уже не
 * «неудачное восстановление, повторим», а испорченная боевая система со свежими
 * данными на битой основе — заметно хуже, чем сервер, который отказывается работать.
 *
 * Флаг снимается только: (1) успешным завершением восстановления, (2) явным решением
 * администратора — с записью в журнал.
 *
 * В файле состояния лежат фаза и прогресс, но НИКОГДА приватный ключ: он живёт только
 * в памяти на время операции (ТЗ §6, приёмка п. 23). Поэтому восстановление и не
 * «продолжается само» после аварии — администратор вводит ключ заново, и это правильно.
 */

const fs = require('fs');
const path = require('path');
const log = require('./log');

const FILE_NAME = 'maintenance.flag.json';
const MAX_LOG_LINES = 500;

// Кэш существования флага. Гейт 503 спрашивает его на КАЖДЫЙ HTTP-запрос, а флаг
// могут снять и снаружи (консольно, руками) — поэтому не «прочитали при старте и
// забыли», но и не `existsSync` на каждый запрос.
const EXISTS_TTL_MS = 1000;
let _existsCache = { value: null, at: 0 };

// Состояние держится В ПАМЯТИ и сбрасывается на диск не чаще, чем раз в FLUSH_MS.
// Причина: во время загрузки данных строки прогресса идут десятками в секунду, а файл
// переписывается ЦЕЛИКОМ — это лишние сотни операций записи и лишние сотни шансов
// поймать `EPERM` на переименовании (Windows отказывает, если файл кем-то открыт).
// Значимые переходы (смена фазы, поднятие и снятие флага) сбрасываются немедленно:
// именно по ним разбирают аварию.
const FLUSH_MS = 500;
let _state = null;
let _lastFlush = 0;

// Флаг и журнал обслуживания лежат в каталоге состояния (`stateDir`), а не в корне
// проекта. По умолчанию это одно и то же место; расходятся они там, где каталог
// проекта пересоздаётся при развёртывании. Прерванное восстановление обязано
// пережить деплой: снимать режим обслуживания должен администратор, разобравшись,
// а не сборка образа — молча и мимо него.
const stateDir = require('./stateDir');

function filePath() {
    return path.join(stateDir.dir(), FILE_NAME);
}

function auditPath() {
    return path.join(stateDir.dir(), 'maintenance.log');
}

/** Активен ли режим обслуживания. Синхронно и дёшево — зовётся на каждый запрос. */
function isActive() {
    const now = Date.now();
    if (_existsCache.value !== null && now - _existsCache.at < EXISTS_TTL_MS) return _existsCache.value;
    let v = false;
    try { v = fs.existsSync(filePath()); } catch (e) { v = false; }
    _existsCache = { value: v, at: now };
    return v;
}

/**
 * Прочитать состояние. `null`, если режим не активен или файл нечитаем.
 *
 * Свежая копия в памяти важнее диска: страницу обслуживания отдаёт ТОТ ЖЕ процесс,
 * который ведёт операцию, а на диск состояние сбрасывается с задержкой (см. `_flush`).
 * Читать с диска значило бы показывать администратору отставшую картину.
 */
function read() {
    if (_state) return _state;
    try {
        const p = filePath();
        if (!fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        // Битый файл — это ВСЁ РАВНО режим обслуживания: раз файл лежит, кто-то его
        // положил, и допускать пользователей в базу нельзя. Отдаём минимальное
        // состояние, чтобы страница обслуживания могла хоть что-то показать.
        return { active: true, reason: 'unknown', phase: 'unknown', broken: true, error: e.message };
    }
}

/**
 * Атомарная запись состояния: временный файл + переименование.
 * Прерывание посреди записи не должно оставить огрызок, по которому непонятно, в каком
 * состоянии система.
 *
 * С ПОВТОРАМИ, и это не перестраховка. В Windows `rename` поверх существующего файла
 * отказывает с `EPERM`, если файл В ЭТОТ МОМЕНТ кем-то открыт — а состояние читают все
 * подряд: страница обслуживания, антивирус, редактор администратора. Отказ здесь
 * недопустим вдвойне: файл состояния пишется во время восстановления, и необработанное
 * исключение из него роняло СЕРВЕР посреди операции. Поймано живым прогоном.
 */
function _write(state) {
    stateDir.ensure();
    const p = filePath();
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');

    let lastError = null;
    for (let attempt = 0; attempt < 8; attempt++) {
        try {
            fs.renameSync(tmp, p);
            _existsCache = { value: true, at: Date.now() };
            return;
        } catch (e) {
            lastError = e;
            if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') break;
            // Короткая синхронная пауза: конкурент держит файл десятки миллисекунд.
            // Ждать асинхронно нельзя — вызывающие рассчитывают на записанное состояние.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
    }
    try { fs.unlinkSync(tmp); } catch (e2) { /* мусор не важнее исходной ошибки */ }
    throw lastError;
}

/**
 * Запись, которая НЕ обязана удаться: прогресс и журнал операции.
 *
 * Потерянная строка журнала — мелкая неприятность, а исключение отсюда убивает
 * восстановление на середине. Значимые переходы (поднять флаг, снять флаг) пишутся
 * через `_write` напрямую и об отказе сообщают честно.
 */
function _writeAdvisory(state) {
    try { _write(state); return true; }
    catch (e) { log.warn(`[maintenance] Состояние не записано: ${e.message}`); return false; }
}

/**
 * Поднять флаг обслуживания.
 * @param {Object} info — `{ reason, phase, byUser, sourceFile, mode }`
 */
function raise(info = {}) {
    const now = new Date().toISOString();
    const state = Object.assign({
        active: true,
        reason: 'restore',
        phase: 'starting',
        startedAt: now,
        updatedAt: now,
        byUser: '',
        sourceFile: '',
        mode: '',
        shadowSchema: '',
        rollbackSchema: '',
        switched: false,
        progress: null,
        error: null,
        finishedAt: null,
        log: []
    }, info);
    // Поднятие флага обязано удаться: без него сервер продолжит обслуживать запросы
    // во время подмены базы. Отказ здесь — повод не начинать операцию вовсе.
    _write(state);
    _state = state;
    _lastFlush = Date.now();
    log.warn(`[maintenance] РЕЖИМ ОБСЛУЖИВАНИЯ включён (${state.reason}); сервер не обслуживает запросы`);
    audit(`MAINT_ON reason=${state.reason} user=${state.byUser} file=${state.sourceFile}`);
    return state;
}

function _flush(force) {
    if (!_state) return;
    const now = Date.now();
    if (!force && now - _lastFlush < FLUSH_MS) return;
    _lastFlush = now;
    _writeAdvisory(_state);
}

/**
 * Дописать поля состояния, сохранив остальные.
 * @param {Object} patch
 * @param {boolean} [immediate] — сбросить на диск немедленно (смена фазы, итог)
 */
function update(patch = {}, immediate) {
    const cur = _state || read() || { active: true, log: [] };
    _state = Object.assign({}, cur, patch, { updatedAt: new Date().toISOString() });
    if (!Array.isArray(_state.log)) _state.log = [];
    // Смена фазы — всегда на диск: если процесс умрёт, именно она скажет человеку,
    // на чём всё оборвалось.
    _flush(immediate || (patch.phase && patch.phase !== cur.phase) || patch.error !== undefined);
    return _state;
}

/** Строка в журнал операции (виден на странице обслуживания). */
function appendLog(line, progress) {
    const cur = _state || read();
    if (!cur) return null;
    const arr = Array.isArray(cur.log) ? cur.log : [];
    arr.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    // Журнал ограничен: длинная выгрузка иначе раздувает файл состояния.
    while (arr.length > MAX_LOG_LINES) arr.shift();
    _state = Object.assign({}, cur, { log: arr, updatedAt: new Date().toISOString() });
    if (progress) _state.progress = progress;
    _flush(false);
    return _state;
}

/**
 * Снять флаг.
 * @param {Object} opts — `{ who, note }`: кто снял и почему — уходит в аудит-лог,
 *   потому что ручное снятие это осознанное решение, а не техническая мелочь.
 */
function clear(opts = {}) {
    const state = _state || read();
    _state = null;
    try {
        const p = filePath();
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
        log.error(`[maintenance] Не удалось снять флаг: ${e.message}`);
        throw e;
    }
    _existsCache = { value: false, at: Date.now() };
    audit(`MAINT_OFF who=${opts.who || 'system'} note=${opts.note || ''} phase=${(state && state.phase) || ''}`);
    log.info(`[maintenance] Режим обслуживания снят (${opts.who || 'system'})`);
    return true;
}

/**
 * Аудит-лог — в ФАЙЛ рядом с флагом.
 *
 * Именно рядом с флагом, а не в каталоге резервных копий: журнал режима обслуживания
 * обязан работать, когда недоступно ВСЁ остальное — база подменяется, а файл настроек
 * бэкапа может быть не прочитан. Зависимость журнала аварии от исправности чего-либо
 * сводит его ценность к нулю ровно в тот момент, ради которого он заведён.
 */
function audit(line) {
    try {
        stateDir.ensure();
        fs.appendFileSync(auditPath(), `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch (e) {
        log.error(`[maintenance] Аудит не записан: ${e.message}`);
    }
}

/** Последние строки аудит-лога — для страницы обслуживания. */
function tailAudit(lines = 50) {
    try {
        const p = auditPath();
        if (!fs.existsSync(p)) return [];
        const all = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
        return all.slice(-lines);
    } catch (e) {
        return [];
    }
}

module.exports = {
    isActive, read, raise, update, appendLog, clear, audit, tailAudit, filePath, FILE_NAME
};
