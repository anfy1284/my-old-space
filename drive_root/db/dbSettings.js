'use strict';

/**
 * dbSettings — ОДНО место, где решается, к какой базе подключаться.
 *
 * До этого модуля вопрос решался ДВАЖДЫ и по-разному:
 *   `drive_root/db/sequelize_instance.js` читал `dbSettings.json` из РАБОЧЕГО
 *   КАТАЛОГА процесса, а `drive_root/db/createDB.js` — из `PROJECT_ROOT`.
 * Пока то и другое совпадает, расхождения не видно. Стоит им разойтись — и
 * система делает ровно то, чего от неё никто не ждёт: МИГРАЦИЯ идёт в одну базу,
 * а СЕРВЕР работает с другой. Ни ошибки, ни предупреждения при этом нет: обе
 * операции успешны, просто над разными данными. Поймано на попытке прогнать
 * проверку на клоне базы: схема уехала в боевую, а приложение осталось без
 * созданных таблиц.
 *
 * Правило: путь к настройкам ОДИН и вычисляется здесь.
 *   1. `DB_SETTINGS_PATH` — каталог с `dbSettings.json` и `dbSettings.<dialect>.json`.
 *      Нужен, чтобы запустить ТУ ЖЕ сборку на ДРУГОЙ базе (клон для проверки,
 *      личная база разработчика), не подменяя файл настроек в проекте: подмена
 *      ради одного прогона неизбежно остаётся в нём навсегда.
 *   2. `PROJECT_ROOT` — обычный случай: настройки лежат в корне проекта.
 *   3. рабочий каталог процесса — запасной путь для запуска без `PROJECT_ROOT`.
 *
 * Модуль СИНХРОННЫЙ и без побочных эффектов: его зовут на самом раннем шаге,
 * когда ни базы, ни логгера ещё нет.
 */

const fs = require('fs');
const path = require('path');

/** Каталог, из которого берутся файлы настроек. */
function settingsDir() {
    if (process.env.DB_SETTINGS_PATH) return process.env.DB_SETTINGS_PATH;
    if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
    return process.cwd();
}

function readJson(file) {
    try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        console.error(`[dbSettings] Не удалось прочитать ${file}: ${e.message}`);
        return null;
    }
}

/**
 * Настройки подключения.
 * @returns {{dir: string, dialect: string, settings: object}}
 */
function resolve() {
    const dir = settingsDir();
    const base = readJson(path.join(dir, 'dbSettings.json')) || { dialect: 'sqlite' };
    const dialect = base.dialect || 'sqlite';

    let settings = readJson(path.join(dir, `dbSettings.${dialect}.json`));
    if (!settings) {
        if (dialect === 'sqlite') {
            settings = { dialect: 'sqlite', storage: path.join(dir, 'database.sqlite') };
        } else {
            // Для PostgreSQL молча продолжать нельзя: без адреса и пароля
            // подключение всё равно не состоится, но упадёт оно позже и не тем
            // сообщением, по которому видна настоящая причина.
            throw new Error(`[dbSettings] ${`dbSettings.${dialect}.json`} не найден в ${dir}`
                + ' — для PostgreSQL файл обязателен');
        }
    }
    if (!settings.dialect) settings.dialect = dialect;
    return { dir, dialect, settings };
}

/** Короткая строка для журнала запуска: видно, к какой базе идём и откуда узнали. */
function describe() {
    try {
        const r = resolve();
        const s = r.settings;
        const target = r.dialect === 'sqlite' ? (s.storage || '(sqlite)') : `${s.host}:${s.port}/${s.database}`;
        const via = process.env.DB_SETTINGS_PATH ? 'DB_SETTINGS_PATH'
            : (process.env.PROJECT_ROOT ? 'PROJECT_ROOT' : 'cwd');
        return `${r.dialect} ${target} (настройки из ${r.dir}, через ${via})`;
    } catch (e) {
        return `НЕ ОПРЕДЕЛЕНЫ: ${e.message}`;
    }
}

module.exports = { settingsDir, resolve, describe };
