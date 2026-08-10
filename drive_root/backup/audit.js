'use strict';

/**
 * audit — журнал действий с резервными копиями.
 *
 * В ФАЙЛ, а не в базу (ТЗ §6.5). Довод простой: этот журнал нужен ровно тогда, когда с
 * базой что-то не так — её подменяют восстановлением, она не открывается, её украли.
 * Запись, живущая внутри предмета расследования, расследованию не помогает.
 *
 * Лежит рядом с копиями: у каталога хранения тот же срок жизни и тот же режим доступа,
 * что и у самих файлов, и переносят их вместе.
 *
 * Один модуль, а не по функции в каждом файле: реализаций было три (роуты приложения,
 * восстановление организации, полное восстановление), они разошлись бы при первой же
 * правке формата строки.
 */

const fs = require('fs');
const path = require('path');

const log = require('./../log');
const settingsStore = require('./settings');

const FILE_NAME = 'backup-audit.log';

/**
 * Дописать строку. Ошибка записи НЕ пробрасывается: аудит не должен ронять операцию,
 * которую он описывает, — иначе полный диск отменяет восстановление базы.
 * @param {string} line
 */
function audit(line) {
    try {
        const dir = settingsStore.storagePath();
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, FILE_NAME), `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch (e) {
        log.error(`[backup] Не удалось записать аудит: ${e.message}`);
    }
}

/** Путь к журналу — нужен формам и странице обслуживания, чтобы показать хвост. */
function filePath() {
    return path.join(settingsStore.storagePath(), FILE_NAME);
}

/** Последние N строк. Читается целиком: журнал коротких строк и живёт рядом с копиями. */
function tail(lines = 50) {
    try {
        const text = fs.readFileSync(filePath(), 'utf8');
        return text.split('\n').filter(Boolean).slice(-lines);
    } catch (e) {
        return [];
    }
}

module.exports = { audit, tail, filePath, FILE_NAME };
