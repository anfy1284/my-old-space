'use strict';

/**
 * appFactories — ОБЪЯВЛЕНИЕ ПО СОГЛАШЕНИЮ ОБ ИМЕНИ ФАЙЛА.
 *
 * ── Зачем это ядро ───────────────────────────────────────────────────────────
 * В фреймворке три механизма объявляются приложением не побочным эффектом
 * `init.js`, а ФАЙЛОМ-ФАБРИКОЙ в его каталоге:
 *
 *   apps/<app>/scheduler.handlers.js   типы регламентных задач
 *   apps/<app>/posting.handlers.js     обработчики проведения
 *   apps/<app>/alerts.rules.js         правила оповещений по документам
 *
 * Причина у всех трёх одна: реестр нужен ДВУМ процессам — главному и форкнутому
 * воркеру планировщика, — а `init.js` выполняет только главный. Императивная
 * регистрация в воркере не существует, и механизм падает с «обработчик не
 * зарегистрирован» (поймано живым прогоном на проведении).
 *
 * Поиск каталогов приложений при этом был СКОПИРОВАН дословно: `collectAppDirs`
 * жил и в `scheduler/registry.js`, и в `postingHandlers.js`. Третий потребитель —
 * повод не копировать в третий раз, а вынести общее ядро из работающего
 * механизма (правило проекта: «второй потребитель механизма — сначала выделить
 * ядро, потом навешивать»). Ядро здесь — ПОИСК И ЗАГРУЗКА фабрик; что считать
 * правильным объявлением, остаётся за потребителем (`accept`).
 *
 * ── Чего здесь нет ───────────────────────────────────────────────────────────
 * Ни одного обращения к базе и ни одного побочного действия: модуль грузят оба
 * процесса, и в воркере половины окружения главного попросту нет.
 */

const fs = require('fs');
const path = require('path');

/**
 * Каталоги приложений: сначала проект (перекрывает), затем фреймворк.
 *
 * Имена приложений берутся из реестров `apps.json` — фреймворкового,
 * пакетного и проектного, в этом порядке; `path` последнего прочитанного
 * задаёт базовый каталог.
 *
 * @returns {{appNames: string[], baseDirs: string[]}}
 */
function collectAppDirs() {
    const projectRoot = process.env.PROJECT_ROOT
        || (function () { try { return require('./globalServerContext').getProjectRoot(); } catch (e) { return null; } })();
    const frameworkRoot = path.join(__dirname, '..');

    let appsBasePath = 'apps';
    const appNames = [];
    const readAppsJson = (p) => {
        if (!fs.existsSync(p)) return;
        try {
            const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (typeof cfg.path === 'string' && cfg.path) appsBasePath = cfg.path.replace(/^[/\\]+/, '');
            for (const app of (cfg.apps || [])) {
                if (app && app.name && !appNames.includes(app.name)) appNames.push(app.name);
            }
        } catch (e) {
            console.error(`[appFactories] Битый apps.json: ${p}: ${e.message}`);
        }
    };
    readAppsJson(path.join(frameworkRoot, 'drive_forms', 'apps.json'));
    readAppsJson(path.join(frameworkRoot, 'apps.json'));
    if (projectRoot) readAppsJson(path.join(projectRoot, 'apps.json'));

    const baseDirs = [];
    if (projectRoot) baseDirs.push(path.join(projectRoot, appsBasePath));
    baseDirs.push(path.join(frameworkRoot, appsBasePath));
    return { appNames, baseDirs };
}

/**
 * Собрать объявления всех приложений из файла с заданным именем.
 *
 * Фабрика зовётся как `(modelsDB, Utilities)` — объявленная сигнатура есть
 * обещание, и держать его обязан ЗАГРУЗЧИК, а не доверие вызывающему: зовущий
 * однажды позвал `ensureLoaded()` без аргументов, и обработчик проведения
 * получил `Utilities = undefined` — не при загрузке, а в очереди, у 58
 * документов подряд.
 *
 * @param {object}   p
 * @param {string}   p.fileName   — имя файла в каталоге приложения
 * @param {string}   p.tag        — префикс сообщений в журнале
 * @param {object}   [p.modelsDB]
 * @param {object}   [p.Utilities]
 * @param {boolean}  [p.fresh]    — перечитать файл, минуя кэш `require`
 * @param {Function} [p.accept]   — `(code, decl, appName) => {value}|{error}`;
 *                                  не задан — берётся объявление как есть
 * @returns {Map<string, *>}
 */
function load(p) {
    const out = new Map();
    const tag = p.tag || '[appFactories]';
    const { appNames, baseDirs } = collectAppDirs();

    for (const appName of appNames) {
        for (const baseDir of baseDirs) {
            const file = path.join(baseDir, appName, p.fileName);
            if (!fs.existsSync(file)) continue;
            try {
                if (p.fresh) { try { delete require.cache[require.resolve(file)]; } catch (e) { /* не был загружен */ } }
                const factory = require(file);
                if (typeof factory !== 'function') {
                    console.error(`${tag} ${file}: модуль должен экспортировать функцию-фабрику`);
                    break;
                }
                const declared = factory(p.modelsDB, p.Utilities) || {};
                let taken = 0;
                for (const [code, decl] of Object.entries(declared)) {
                    const verdict = p.accept ? p.accept(code, decl, appName) : { value: decl };
                    if (!verdict || verdict.error) {
                        console.error(`${tag} ${file}: ${(verdict && verdict.error) || `объявление "${code}" отброшено`}`);
                        continue;
                    }
                    out.set(code, verdict.value);
                    taken++;
                }
                console.log(`${tag} ${appName}: объявлений ${taken}`);
            } catch (e) {
                console.error(`${tag} Ошибка загрузки ${file}: ${e && e.message || e}`);
            }
            break; // проектный файл перекрывает фреймворковый
        }
    }

    return out;
}

/**
 * Утилиты пакета — то, что фабрика вправе ожидать вторым аргументом, даже когда
 * вызывающий его не передал.
 */
function defaultUtilities() {
    try { return require('./db/utilites'); } catch (e) { return null; }
}

/** Модели текущего процесса — первый аргумент фабрики. */
function defaultModels() {
    try { return require('./globalServerContext').modelsDB || null; } catch (e) { return null; }
}

module.exports = { collectAppDirs, load, defaultUtilities, defaultModels };
