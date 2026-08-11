'use strict';

/**
 * catalog — КАТАЛОГ КОПИЙ КАК ЕДИНСТВЕННЫЙ ИСТОЧНИК ИСТИНЫ.
 *
 * ЧТО ЗАМЕНИЛО. Прежде рядом с каталогом жила таблица `backup_files`, и они постоянно
 * расходились: файл удаляли мимо системы, копия приезжала из чужого дампа, журнал
 * описывал сервер, которого нет. Ради схождения существовала сверка (`reconcileJournal`)
 * с пометкой пропавших и усыновлением найденных — то есть целый механизм, чья
 * единственная задача была чинить последствия существования второго источника истины.
 *
 * Решение владельца 11.08.2026: таблицы больше нет. Сервер — перевалочный буфер, его
 * каталог уничтожается развёртыванием, и запись в базе, пережившая то, что она
 * описывает, вредна вдвойне. Список строится чтением каталога; вопрос «отработала ли
 * ночная выгрузка» отвечает `scheduler_runs`, который в базе и деплой переживает.
 *
 * ОТКУДА БЕРУТСЯ МЕТАДАННЫЕ. Из ЗАГОЛОВКА копии — он лежит открытым текстом и читается
 * без приватного ключа (`restore.readHeader`). Туда же перенесено всё, что прежде
 * хранила строка журнала: `triggeredBy`, `title`, `rowsTotal`.
 *
 * Единственное, чего в заголовке быть не может, — `sha256`: он считается по ГОТОВОМУ
 * файлу вместе с заголовком, то есть в момент записи заголовка ещё не существует. Ради
 * него и заведён файл-спутник `<имя>.meta.json`.
 *
 * СПУТНИК НЕОБЯЗАТЕЛЕН. Его потеря не должна делать исправную копию непригодной:
 * `sha256` нужен внешнему хранилищу для проверки скачанного, а восстановление обходится
 * без него. Поэтому отсутствующий спутник — это пустая сумма и строка в журнале, а не
 * исключение. Правило шире: заголовок — истина для всего, что известно при записи,
 * спутник — только для вычисляемого по готовому файлу.
 */

const fs = require('fs');
const path = require('path');

const log = require('../log');
const settingsStore = require('./settings');

const FILE_EXT = '.mosbak';
const SIDECAR_EXT = '.meta.json';

/** Метка «файл занят восстановлением» — кладётся рядом (см. markInUse в index.js). */
const IN_USE_SUFFIX = '.inuse';

// ── Имя файла как идентификатор ─────────────────────────────────────────────────

/**
 * Проверить имя файла, пришедшее СНАРУЖИ.
 *
 * Это главный новый риск всей затеи, и он не теоретический. Раньше копия адресовалась
 * UID записи журнала: неверное значение просто не находило строку. Теперь идентификатор
 * — имя файла, то есть оно превращается в ПУТЬ. Значение вида `../../.env` без проверки
 * означало бы чтение произвольного файла с диска сервера через подписанный запрос.
 *
 * Поэтому проверка белым списком, а не чёрным: разрешены только те символы, из которых
 * система сама строит имена (`buildFileName`), плюс обязательное расширение. Всё
 * остальное — отказ, включая любые разделители пути и `..` в любом виде.
 *
 * @param {string} name
 * @returns {string|null} безопасное имя либо null
 */
function safeName(name) {
    const s = String(name || '').trim();
    if (!s || s.length > 200) return null;
    // basename отсекает каталоги ДО проверки: так `a/../b.mosbak` не пройдёт даже
    // случайно совпав с шаблоном после нормализации.
    if (path.basename(s) !== s) return null;
    if (s.includes('..')) return null;
    if (!/^[A-Za-z0-9._-]+\.mosbak$/.test(s)) return null;
    return s;
}

/** Абсолютный путь копии по имени. `null`, если имя не прошло проверку. */
function resolvePath(name) {
    const safe = safeName(name);
    if (!safe) return null;
    return path.join(settingsStore.storagePath(), safe);
}

// ── Спутник ─────────────────────────────────────────────────────────────────────

function sidecarPath(filePath) {
    return filePath + SIDECAR_EXT;
}

/**
 * Записать спутник. Ошибку глотаем в журнал: копия уже создана и работоспособна, и
 * ронять успешную выгрузку из-за ненаписанного файла сумм нельзя.
 */
function writeSidecar(filePath, data) {
    try {
        fs.writeFileSync(sidecarPath(filePath), JSON.stringify(data || {}, null, 2), 'utf8');
    } catch (e) {
        log.warn(`[backup/catalog] Спутник для ${path.basename(filePath)} не записан: ${e.message}`);
    }
}

function readSidecar(filePath) {
    try {
        const p = sidecarPath(filePath);
        if (!fs.existsSync(p)) return {};
        return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    } catch (e) {
        log.warn(`[backup/catalog] Спутник для ${path.basename(filePath)} нечитаем: ${e.message}`);
        return {};
    }
}

// ── Чтение каталога ─────────────────────────────────────────────────────────────

/**
 * Описание одной копии: заголовок + спутник + факты файловой системы.
 * @returns {Object|null} null — файл не опознан как копия
 */
function describe(dir, fileName) {
    const filePath = path.join(dir, fileName);

    let header;
    try {
        header = require('./restore').readHeader(filePath);
    } catch (e) {
        // Не копия либо недописанный файл. Это не ошибка каталога: в нём могут лежать
        // чужие файлы, и падать из-за них весь список не должен.
        log.warn(`[backup/catalog] ${fileName} не опознан как копия: ${e.message}`);
        return null;
    }

    let st;
    try { st = fs.statSync(filePath); } catch (e) { return null; }

    const side = readSidecar(filePath);
    const scope = header.scope || { type: 'full' };

    return {
        fileName,
        filePath,
        createdAt: header.createdAt ? new Date(header.createdAt) : new Date(st.mtimeMs),
        size: st.size,
        // Сумма только из спутника: пересчитывать её при каждом показе списка нельзя —
        // файл может весить гигабайты, а список открывают часто.
        sha256: side.sha256 || '',
        dbName: header.dbName || '',
        dbVersion: Number(header.dbVersion) || 0,
        configHash: header.configHash || '',
        actualHash: header.actualHash || '',
        keyFingerprint: header.keyFingerprint || '',
        sourceDialect: header.sourceDialect || '',
        scopeType: scope.type || 'full',
        scopeOrganizationId: scope.organizationId || '',
        scopeOrganizationName: scope.organizationName || '',
        // Копии, снятые до переноса этих полей в заголовок, их не имеют. Умолчание
        // «ручная» безопасно: у ручных лимит меньше, поэтому ошибка в эту сторону
        // приводит к более раннему удалению лишнего, а не к вытеснению свежих плановых.
        triggeredBy: header.triggeredBy || 'manual',
        title: header.title || '',
        rowsTotal: Number(header.rowsTotal) || 0,
        inUse: fs.existsSync(filePath + IN_USE_SUFFIX)
    };
}

/**
 * Все копии в каталоге, новые сверху.
 *
 * Каталога нет — пустой список, а не исключение: свежая инсталляция без единой копии
 * это нормальное состояние.
 *
 * @returns {Array<Object>}
 */
function list() {
    const dir = settingsStore.storagePath();
    let names;
    try {
        names = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(FILE_EXT));
    } catch (e) {
        return [];
    }
    return names
        .map(n => describe(dir, n))
        .filter(Boolean)
        .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Одна копия по имени файла. Имя проверяется как внешнее (см. `safeName`).
 * @returns {Object|null}
 */
function find(fileName) {
    const safe = safeName(fileName);
    if (!safe) return null;
    const dir = settingsStore.storagePath();
    if (!fs.existsSync(path.join(dir, safe))) return null;
    return describe(dir, safe);
}

/**
 * Посчитать SHA-256 файла и записать спутник.
 *
 * Нужна для копий, снятых до появления спутников: у них суммы нет, а внешнему хранилищу
 * она нужна, чтобы проверить скачанное, не имея приватного ключа. Считать её при показе
 * списка нельзя — файл может весить гигабайты, а список открывают часто. Поэтому здесь:
 * по требованию, один раз, с записью результата рядом с копией.
 *
 * @returns {Promise<string>} sha256 либо '' при ошибке чтения
 */
async function computeSha256(fileName) {
    const filePath = resolvePath(fileName);
    if (!filePath || !fs.existsSync(filePath)) return '';

    const crypto = require('crypto');
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
        const s = fs.createReadStream(filePath);
        s.on('data', (c) => hash.update(c));
        s.on('error', reject);
        s.on('end', resolve);
    });
    const sum = hash.digest('hex');

    const side = readSidecar(filePath);
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch (e) { size = side.size || 0; }
    writeSidecar(filePath, Object.assign({}, side, { sha256: sum, size }));

    log.info(`[backup/catalog] Досчитана контрольная сумма ${fileName}`);
    return sum;
}

/**
 * Досчитать суммы у копий без спутника — фоном, по одной за раз.
 *
 * Возвращён намеренно: прежний `backfillChecksums()` я удалил вместе с журналом, но у
 * него было ДВЕ задачи, и обсолетной стала только одна. Заполнение строки журнала —
 * да, journal'а нет. А сумма нужна по-прежнему: без неё внешнее хранилище стоит перед
 * выбором «поверить молча» или «отказаться забирать», и оба плохи.
 *
 * Строго по одному файлу: это фоновая работа рядом с работающим сервером, и
 * параллельное хэширование нескольких гигабайтных файлов отняло бы диск у пользователей.
 */
async function backfillSidecars() {
    let done = 0;
    for (const f of list()) {
        if (f.sha256) continue;
        try { if (await computeSha256(f.fileName)) done++; }
        catch (e) { log.warn(`[backup/catalog] Сумма ${f.fileName} не досчитана: ${e.message}`); }
    }
    return { done };
}

/**
 * Удалить копию вместе со спутником.
 *
 * Спутник удаляется ПОСЛЕ основного файла: осиротевший спутник безвреден (список его не
 * покажет — он строится по `.mosbak`), а копия без спутника после сбоя удаления
 * выглядела бы целой, не будучи проверяемой.
 *
 * @returns {boolean} был ли удалён файл
 */
function remove(fileName) {
    const filePath = resolvePath(fileName);
    if (!filePath || !fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    try {
        const sp = sidecarPath(filePath);
        if (fs.existsSync(sp)) fs.unlinkSync(sp);
    } catch (e) {
        log.warn(`[backup/catalog] Спутник ${fileName} не удалён: ${e.message}`);
    }
    return true;
}

module.exports = {
    list, find, describe, remove, safeName, resolvePath,
    computeSha256, backfillSidecars,
    writeSidecar, readSidecar, sidecarPath,
    FILE_EXT, SIDECAR_EXT
};
