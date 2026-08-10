'use strict';

/**
 * restoreFullRunner — процедура полного восстановления со стороны ГЛАВНОГО процесса
 * (ТЗ §6.2, пункты 1–6).
 *
 * Порядок и его смысл:
 *
 *   1. проверки и safety-выгрузка   — пока пользователи ещё работают: выгрузка их не
 *                                     блокирует (снимок MVCC), а копия нужна ДО записи;
 *   2. остановка планировщика       — его тик каждые 30 с держал бы соединения и
 *                                     транзакции ровно в момент подмены схем;
 *   3. файловый флаг обслуживания   — 503 всем, кроме страницы состояния;
 *   4. дочерний процесс             — фазы восстановления, ключ через IPC;
 *   5. штатная миграция + кэши      — ТА ЖЕ функция, что при старте сервера;
 *   6. снятие флага                 — только при успехе (см. ниже про отказы).
 *
 * ПЕРЕЗАПУСК СЕРВЕРА НЕ НУЖЕН. Миграция — обычная функция (`createDB.initDatabase`), а
 * не свойство запуска процесса; кэши сбрасываются событием `onDatabaseReset`. Значит
 * не нужен и супервизор, то есть процедура одинакова на Windows, Linux и в контейнере.
 *
 * КОГДА ФЛАГ СНИМАЕТСЯ САМ, А КОГДА НЕТ. Он снимается автоматически ТОЛЬКО если
 * переключение не состоялось и мы живы: тогда живая база не тронута ПО ПОСТРОЕНИЮ —
 * писали мы исключительно в теневую схему, которую тут же и удалили. Во всех остальных
 * случаях флаг остаётся: после переключения состояние базы уже иное, а смерть процесса
 * не снимает флаг вообще никогда — в этом весь его смысл.
 */

const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const log = require('../log');
const maintenance = require('../maintenance');
const dialect = require('./dialect');
const restore = require('./restore');
const restoreFull = require('./restoreFull');
const settingsStore = require('./settings');

const SAFETY_TIMEOUT_MS = 60 * 60 * 1000;
const WORKER_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Переоткрыть пул соединений после `close()`.
 *
 * Sequelize 6 после `close()` помечает менеджер соединений закрытым, и любой
 * следующий запрос падает с «getConnection was called after the connection manager was
 * closed». Штатного «открыть обратно» в публичном API нет, поэтому — `initPools()` и
 * снятие собственного свойства-заглушки `getConnection`, которое `close()` вешает на
 * экземпляр. Приём собран В ОДНОМ месте с этим комментарием: он зависит от внутренностей
 * версии, и когда он сломается, чинить надо будет здесь, а не искать по коду.
 */
function reopenPool(sequelize) {
    const cm = sequelize.connectionManager;
    if (!cm) return false;
    try {
        cm.initPools();
        if (Object.prototype.hasOwnProperty.call(cm, 'getConnection')) delete cm.getConnection;
        return true;
    } catch (e) {
        log.error(`[restoreFull] Пул соединений не переоткрыт: ${e.message}`);
        return false;
    }
}

/** Планировщик: остановить на время операции и поднять обратно. */
function schedulerStop() {
    try { require('../scheduler').stop(); return true; }
    catch (e) { log.warn(`[restoreFull] Планировщик не остановлен: ${e.message}`); return false; }
}
async function schedulerStart() {
    try { await require('../scheduler').start(); return true; }
    catch (e) { log.warn(`[restoreFull] Планировщик не запущен обратно: ${e.message}`); return false; }
}

/**
 * Обязательная safety-выгрузка ТЕКУЩЕЙ базы (§6.1 шаг 1).
 *
 * Идёт тем же путём, что любая другая выгрузка — заданием `backup.create`. Отдельной
 * ветки выгрузки в системе быть не должно. Её результата дожидаемся: копия — это
 * ПРЕДУСЛОВИЕ операции, а не фон, и восстанавливать, не убедившись, что путь назад
 * существует, нельзя.
 */
async function makeSafetyDump(sessionID) {
    const dbGateway = require('../dbGateway');
    const scheduler = require('../scheduler');

    const tasks = await dbGateway.execute({
        operation: 'read', table: 'scheduler_tasks',
        where: { handler: 'backup.create' }, options: { raw: true },
        context: { sessionID }
    });
    const task = tasks && tasks[0];
    if (!task) return { ok: false, errorKey: 'restore_err_no_backup_task' };

    const started = await scheduler.runNow(task.UID, { scope: 'full' });
    if (!started.ok) return { ok: false, errorKey: started.errorKey || 'sched_err_dispatch_failed' };

    const run = await scheduler.waitForRun(started.runId, { timeoutMs: SAFETY_TIMEOUT_MS });
    if (!run.ok) {
        return {
            ok: false, errorKey: 'restore_err_safety_failed',
            vars: { status: String(run.status || ''), message: String((run.run && run.run.errorText) || '') }
        };
    }
    return { ok: true, runId: started.runId };
}

/**
 * Запустить дочерний процесс и дождаться его.
 * @returns {Promise<{ok: boolean, result?: Object, error?: Object}>}
 */
function runWorker({ filePath, privateKeyPem, passphrase, onProgress }) {
    return new Promise((resolve) => {
        const workerPath = path.join(__dirname, 'restoreWorker.js');
        const child = fork(workerPath, [], {
            env: Object.assign({}, process.env, { PROJECT_ROOT: process.env.PROJECT_ROOT || process.cwd() }),
            stdio: ['ignore', 'inherit', 'inherit', 'ipc']
        });

        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };

        const timer = setTimeout(() => {
            log.error('[restoreFull] Таймаут восстановления — процесс-исполнитель снимается');
            try { child.kill('SIGKILL'); } catch (e) {}
            finish({ ok: false, error: { errorKey: 'restore_err_timeout', message: 'timeout' } });
        }, WORKER_TIMEOUT_MS);

        child.on('message', (m) => {
            if (!m) return;
            if (m.type === 'ready') {
                // Ключ уходит ТОЛЬКО по IPC и только после готовности процесса.
                child.send({ type: 'run', filePath, privateKeyPem, passphrase });
                return;
            }
            if (m.type === 'progress') { onProgress(m); return; }
            if (m.type === 'done') { finish({ ok: true, result: m.result }); return; }
            if (m.type === 'error') { finish({ ok: false, error: m }); return; }
        });

        child.on('error', (e) => finish({ ok: false, error: { message: e.message } }));
        child.on('exit', (code, signal) => {
            // Молчаливая смерть исполнителя — самый опасный исход: мы не знаем, успело
            // ли произойти переключение. Состояние выясняется по базе (см. probeState),
            // а флаг обслуживания в любом случае остаётся поднятым.
            finish({
                ok: false,
                error: { errorKey: 'restore_err_worker_died', message: `exit=${code} signal=${signal}`, unknownState: true }
            });
        });
    });
}

/**
 * Выяснить по базе, что успело произойти, когда исполнитель умер молча.
 *
 * Вопрос ровно один: состоялось ли переключение. От ответа зависит, можно ли снять флаг
 * обслуживания, — то есть допустить пользователей к базе. Гадать здесь нельзя.
 *
 * Первая версия сравнивала ВРЕМЯ схемы отката с началом операции («новее старта, значит
 * переключились») и ошиблась на живом прогоне: схема, оставшаяся от восстановления
 * минутой раньше, попала в допуск, и прерванная на создании структуры операция была
 * объявлена переключившейся. Поэтому теперь — не догадка, а два факта:
 *
 *   · теневая схема ВСЁ ЕЩЁ существует ⇒ переключения ТОЧНО не было (оно её переименовывает);
 *   · появилась схема отката, которой перед стартом НЕ БЫЛО ⇒ переключение ТОЧНО состоялось.
 *
 * @param {Set<string>|Array<string>} rollbacksBefore — снимок схем отката ДО запуска
 */
async function probeState(sequelize, rollbacksBefore) {
    const before = new Set(rollbacksBefore || []);
    try {
        const list = await dialect.listRollbackSchemas(sequelize);
        const appeared = list.filter(n => !before.has(n));
        if (appeared.length) return { switched: true, rollbackSchema: appeared[0] };

        // Новых схем отката нет. Если теневая на месте — переключения точно не было.
        // Если её тоже нет, это по-прежнему «не переключились»: переключение обязано
        // было оставить след в виде новой схемы отката, а его нет.
        return { switched: false, rollbackSchema: '' };
    } catch (e) {
        // База недоступна — утверждать «не переключились» нельзя, и флаг остаётся.
        return { switched: null, error: e.message };
    }
}

/**
 * ПОЛНАЯ процедура восстановления.
 *
 * @param {Object} opts
 * @param {string} opts.filePath        — файл копии (уже проверен и помечен занятым)
 * @param {string} opts.privateKeyPem   — только в памяти
 * @param {string} [opts.passphrase]
 * @param {string} opts.sessionID       — сессия администратора (для safety-выгрузки)
 * @param {string} [opts.userId]
 * @param {boolean} [opts.skipSafetyDump] — допустимо ТОЛЬКО в теневом режиме
 * @returns {Promise<Object>}
 */
async function execute(opts) {
    const sequelize = require('../db/sequelize_instance');
    const startedAt = Date.now();
    const fileName = path.basename(opts.filePath);

    // ── Предварительно: в каком режиме будем работать ───────────────────────────
    const info = await restoreFull.inspect(sequelize, opts.filePath);
    if (info.scopeType !== 'full') {
        return { ok: false, errorKey: 'restore_err_scope_not_full' };
    }

    // В разрушающем режиме safety-выгрузка ПРИНУДИТЕЛЬНА: отката переименованием там
    // нет, и копия остаётся единственным путём назад (§6.1а).
    const needSafety = info.mode !== 'shadow' ? true : !opts.skipSafetyDump;

    // ── 1. Safety-выгрузка — ДО любой записи и ДО режима обслуживания ───────────
    if (needSafety) {
        const safety = await makeSafetyDump(opts.sessionID);
        if (!safety.ok) return Object.assign({ ok: false }, safety);
        restore.audit(`RESTORE_FULL_SAFETY run=${safety.runId} user=${opts.userId || ''} file=${fileName}`);
    }

    // Снимок схем отката ДО операции. По нему потом отличают «переключение состоялось»
    // от «схема осталась от прошлого раза» — если исполнитель умрёт молча, это
    // единственный способ узнать правду, не гадая по времени (см. probeState).
    let rollbacksBefore = [];
    try { rollbacksBefore = await dialect.listRollbackSchemas(sequelize); } catch (e) { rollbacksBefore = []; }

    // ── 2–3. Планировщик стоп, флаг обслуживания вверх ──────────────────────────
    schedulerStop();
    maintenance.raise({
        reason: 'restore_full',
        phase: 'starting',
        byUser: String(opts.userId || ''),
        sourceFile: fileName,
        mode: info.mode
    });
    restore.audit(`RESTORE_FULL_START file=${fileName} user=${opts.userId || ''} mode=${info.mode}`);

    // Пул закрываем: соединения главного процесса не должны держать объекты живой
    // схемы в момент переименования. Гейт 503 уже не пускает новые запросы, но
    // открытый пул — это ещё и уже установленные сессии СУБД.
    try { await sequelize.close(); } catch (e) { log.warn(`[restoreFull] Пул не закрыт: ${e.message}`); }

    // ── 4. Дочерний процесс ─────────────────────────────────────────────────────
    const run = await runWorker({
        filePath: opts.filePath,
        privateKeyPem: opts.privateKeyPem,
        passphrase: opts.passphrase,
        // Обработчик прогресса ОБЯЗАН быть неломающимся. Он вызывается из обработчика
        // IPC-сообщения, где исключение становится необработанным и роняет СЕРВЕР
        // посреди восстановления. Поймано живым прогоном: отказ записи файла состояния
        // (`EPERM` на переименовании в Windows) убивал процесс.
        onProgress: (m) => {
            try {
                maintenance.update({ phase: m.phase });
                maintenance.appendLog(`${m.phase}: ${m.text}`, m.progress || null);
            } catch (e) {
                log.warn(`[restoreFull] Прогресс не записан: ${e.message}`);
            }
            try { emitProgress(m); } catch (e) { /* оповещение не важнее операции */ }
        }
    });

    // Пул нужен снова в любом исходе: даже разбор неудачи требует базы.
    reopenPool(sequelize);

    // ── Неудача ────────────────────────────────────────────────────────────────
    if (!run.ok) {
        const err = run.error || {};
        let switched = !!err.switched;
        let rollbackSchema = err.rollbackSchema || '';
        if (err.unknownState) {
            const probe = await probeState(sequelize, rollbacksBefore);
            switched = probe.switched === true;
            rollbackSchema = probe.rollbackSchema || '';
            // База недоступна — состояние неизвестно, и это НЕ повод считать, что всё
            // хорошо: флаг остаётся, разбираться человеку.
            if (probe.switched === null) switched = true;
        }

        maintenance.update({
            phase: switched ? 'failed_after_switch' : 'failed',
            switched, rollbackSchema,
            error: err.errorKey || err.message || 'unknown'
        });
        restore.audit(`RESTORE_FULL_FAILED file=${fileName} switched=${switched} error=${err.errorKey || err.message}`);
        log.error(`[restoreFull] Восстановление не выполнено: ${err.message || err.errorKey}`);

        if (!switched) {
            // Мусорную теневую схему убираем ЗДЕСЬ: при штатном отказе её удалил сам
            // исполнитель, но при его молчаливой смерти убирать некому, а она занимает
            // столько же места, сколько база. Оставленный мусор к тому же не виден:
            // флаг обслуживания мы сейчас снимем, и на страницу обслуживания, где есть
            // кнопка уборки, никто не зайдёт.
            try { await dialect.dropSchema(sequelize, dialect.SHADOW_SCHEMA); }
            catch (e) { log.warn(`[restoreFull] Теневая схема не убрана: ${e.message}`); }

            // Живая база НЕ ТРОНУТА по построению: мы писали только в теневую схему.
            // Держать сервер выключенным не за что — снимаем флаг и возвращаем работу.
            await afterDatabaseReady({ reason: 'restore-aborted' });
            maintenance.clear({ who: 'system', note: `aborted before switch: ${err.errorKey || err.message}` });
            await schedulerStart();
            return { ok: false, errorKey: err.errorKey || 'restore_full_err_failed', vars: err.vars, message: err.message, switched: false };
        }

        // Переключение состоялось, а дальше сломалось — сервер остаётся в обслуживании.
        // Откат доступен на странице обслуживания (обратное переименование, мгновенно).
        return {
            ok: false, errorKey: err.errorKey || 'restore_full_err_failed_switched', vars: err.vars, message: err.message,
            switched: true, rollbackSchema, maintenance: true
        };
    }

    // ── 5. Штатная миграция и сброс кэшей ──────────────────────────────────────
    const result = run.result || {};
    maintenance.update({ phase: 'migration', switched: true, rollbackSchema: result.rollbackSchema || '' });
    maintenance.appendLog('migration: приведение структуры к текущей версии приложения');

    try {
        await afterDatabaseReady({ reason: 'restore', migrate: true, origin: 'restore' });
    } catch (e) {
        // Данные восстановлены и переключение состоялось, но структура не приведена к
        // актуальной версии — работать в такой базе нельзя. Оставляем обслуживание:
        // на странице есть откат обратным переименованием.
        maintenance.update({ phase: 'migration_failed', error: e.message });
        restore.audit(`RESTORE_FULL_MIGRATION_FAILED file=${fileName} error=${e.message}`);
        log.error(`[restoreFull] Миграция после восстановления: ${e.stack || e.message}`);
        return {
            ok: false, errorKey: 'restore_err_migration', message: e.message,
            switched: true, rollbackSchema: result.rollbackSchema, maintenance: true
        };
    }

    // ── 6. Снятие флага ────────────────────────────────────────────────────────
    restore.audit(
        `RESTORE_FULL_OK file=${fileName} user=${opts.userId || ''} rows=${result.totalRows} `
        + `tables=${Object.keys(result.tables || {}).length} rollback=${result.rollbackSchema} ms=${Date.now() - startedAt}`
    );
    maintenance.clear({ who: String(opts.userId || 'admin'), note: 'restore completed' });
    await schedulerStart();

    // Схемы отката занимают столько же места, сколько база, — вечно копить их нельзя.
    // Последнюю оставляем всегда: она и есть путь назад.
    try { await dialect.dropStaleRollbacks(sequelize, { keep: 1, olderThanDays: 7 }); } catch (e) {}

    log.info(`[restoreFull] Восстановление завершено: ${result.totalRows} строк за ${Date.now() - startedAt} мс`);
    return {
        ok: true,
        totalRows: result.totalRows,
        tables: Object.keys(result.tables || {}).length,
        rollbackSchema: result.rollbackSchema,
        durationMs: Date.now() - startedAt
    };
}

/**
 * Привести базу в рабочее состояние: штатная миграция + сброс кэшей.
 *
 * Это и есть та самая «стартовая фаза, оформленная функцией» (§6.2). Один и тот же
 * код зовётся при запуске сервера и здесь — второй реализации миграции в системе нет.
 */
async function afterDatabaseReady({ reason, migrate, origin } = {}) {
    if (migrate) {
        const sequelize = require('../db/sequelize_instance');
        const createDB = require('../db/createDB');
        // `origin` попадёт в журнал версий структуры: по нему видно, что версия
        // появилась не от правки моделей, а от восстановления копии.
        const prevOrigin = process.env.MOS_DB_INIT_ORIGIN;
        if (origin) process.env.MOS_DB_INIT_ORIGIN = origin;
        try {
            await createDB.initDatabase({ sequelize });
        } finally {
            if (origin) {
                if (prevOrigin === undefined) delete process.env.MOS_DB_INIT_ORIGIN;
                else process.env.MOS_DB_INIT_ORIGIN = prevOrigin;
            }
        }
        // Рантайм-модели пересобираем: состав таблиц мог измениться.
        try { require('../globalServerContext').initModelsDB(); } catch (e) {
            log.warn(`[restoreFull] Модели не пересобраны: ${e.message}`);
        }
    }
    await require('../dbLifecycle').notifyDatabaseReset({ reason: reason || 'restore' });

    if (migrate) {
        // Журнал копий приехал ВНУТРИ дампа и описывает каталог чужого момента: часть
        // перечисленных файлов уже удалена ретеншном, а реально лежащие — включая
        // safety-копию этой самой операции — в нём отсутствуют. Сверяем сразу:
        // показывать ссылки в никуда и терять из виду единственную свежую копию нельзя.
        try { await require('./index').reconcileJournal(); }
        catch (e) { log.warn(`[restoreFull] Журнал копий не сверен: ${e.message}`); }

        // Журнал ПЛАНИРОВЩИКА приезжает так же — и это хуже, чем кажется. В дампе
        // запечатлён момент, когда safety-выгрузка ещё выполнялась, поэтому после
        // восстановления задача «Резервное копирование» выглядит запущенной, а её
        // исполнителя не существует. Обычная защита планировщика (протухший heartbeat)
        // здесь не срабатывает: в дампе он свежий. Итог — задача заблокирована на
        // минуты, и первой ломается safety-выгрузка СЛЕДУЮЩЕГО восстановления, то есть
        // механизм отнимает у себя же путь назад. Поймано живым прогоном: второй
        // запуск отвечал «задача уже выполняется».
        //
        // В только что подменённой базе выполняющихся запусков не может быть по
        // построению — закрываем их принудительно, не дожидаясь таймаута.
        try {
            const closed = await require('../scheduler').sweepStuckRuns({ force: true });
            if (closed) log.info(`[restoreFull] Закрыто запусков, приехавших из копии: ${closed}`);
        } catch (e) {
            log.warn(`[restoreFull] Запуски планировщика не закрыты: ${e.message}`);
        }
    }
}

/**
 * Сообщить открытым окнам о ходе операции тем же каналом, что и заданиям.
 *
 * Работает только для потоков, ОТКРЫТЫХ до включения режима обслуживания: гейт 503
 * отвергает новые запросы, а уже установленный SSE-поток продолжает жить. Поэтому это
 * приятное дополнение, а не основной канал — основной канал хода операции — страница
 * обслуживания, куда клиента и уводит форма.
 */
function emitProgress(m) {
    const reg = require('../../drive_forms/dynamicTableRegistry');
    if (typeof reg.broadcastSessionEvent !== 'function') return;
    reg.broadcastSessionEvent({
        type: 'jobProgress',
        handler: 'restore.full',
        text: `${m.phase}: ${m.text}`,
        done: m.progress && m.progress.done,
        total: m.progress && m.progress.total
    });
}


/**
 * ПОВТОР восстановления со страницы обслуживания (ТЗ §6.2, «выход из тупика»).
 *
 * Зачем отдельная функция, а не `execute`. Мы уже в аварии: флаг обслуживания поднят,
 * приложения могут быть не загружены вовсе (сервер стартовал с флагом и не инициализировал
 * базу), планировщика нет. В таком состоянии `execute` неприменим — он начинает с
 * safety-выгрузки заданием планировщика, а её здесь некому исполнить.
 *
 * Почему safety-выгрузка НЕ снимается повторно:
 *   · копия текущего состояния уже снята первой попыткой — именно она и есть путь назад;
 *   · снимать копию с базы, про которую мы только что решили, что она непригодна, —
 *     значит тратить место и время на заведомый мусор;
 *   · если переключение состоялось, прежнее состояние цело в схеме `rollback_*`, и это
 *     защита надёжнее выгрузки: она мгновенна.
 *
 * Флаг обслуживания НЕ снимается до успеха. В этом весь смысл повтора: чтобы добраться
 * до этой операции, не надо открывать систему пользователям.
 *
 * @param {Object} opts — `{ filePath, privateKeyPem, passphrase, userId }`
 * @returns {Promise<Object>}
 */
/**
 * Проверки, которые обязаны отработать ДО ответа странице обслуживания.
 *
 * Вынесены отдельно не ради красоты. Повтор идёт минутами, поэтому страница получает
 * ответ сразу и дальше следит за фазой, — а при таком порядке ошибка ключа успевала
 * уехать в фазу `failed`, и администратор видел «запущено» вместо «ключ от другой пары».
 * Ровно та же беда, что уже ловилась на обычной форме восстановления: про ключ надо
 * говорить прямо и до начала работ, а не намёком в журнале.
 *
 * Дёшево: читается только заголовок копии, ничего не пишется. Поэтому `retry` зовёт
 * это же сам — двойная проверка здесь ничего не стоит, а запуск в обход страницы
 * (из сценария, из теста) остаётся защищённым.
 *
 * @returns {Promise<Object>} `{ ok: true, info }` либо `{ ok: false, errorKey, vars }`
 */
async function precheckRetry(opts) {
    const sequelize = require('../db/sequelize_instance');

    if (!maintenance.isActive()) {
        return { ok: false, errorKey: 'maint_err_not_in_maintenance' };
    }

    const info = await restoreFull.inspect(sequelize, opts.filePath);
    if (info.scopeType !== 'full') return { ok: false, errorKey: 'restore_err_scope_not_full' };

    // Ключ нужен только зашифрованной копии; для незашифрованной его не спрашиваем вовсе.
    if (info.encrypted) {
        const keys = require('./keys');
        const check = keys.validatePrivateKey(opts.privateKeyPem, opts.passphrase);
        if (!check.ok) return { ok: false, errorKey: check.errorKey, vars: check.vars };
        const header = info.header || {};
        if (header.keyFingerprint && header.keyFingerprint !== check.fingerprint) {
            return {
                ok: false, errorKey: 'restore_err_key_other_pair',
                vars: {
                    expected: String(header.keyFingerprint).slice(0, 26),
                    actual: String(check.fingerprint).slice(0, 26)
                }
            };
        }
    }
    return { ok: true, info };
}

async function retry(opts) {
    const sequelize = require('../db/sequelize_instance');
    const startedAt = Date.now();
    const fileName = path.basename(opts.filePath);

    const pre = await precheckRetry(opts);
    if (!pre.ok) return pre;
    const info = pre.info;

    let rollbacksBefore = [];
    try { rollbacksBefore = await dialect.listRollbackSchemas(sequelize); } catch (e) { rollbacksBefore = []; }

    maintenance.update({
        phase: 'starting', reason: 'restore_retry', sourceFile: fileName,
        mode: info.mode, error: null, byUser: String(opts.userId || 'recovery-admin')
    }, true);
    restore.audit(`RESTORE_RETRY_START file=${fileName} mode=${info.mode} by=${opts.userId || 'recovery-admin'}`);

    // Пул закрываем: соединения не должны держать объекты живой схемы в момент
    // переименования. Запросов извне и так нет — сервер отдаёт 503.
    try { await sequelize.close(); } catch (e) { log.warn(`[restoreFull] Пул не закрыт: ${e.message}`); }

    const run = await runWorker({
        filePath: opts.filePath,
        privateKeyPem: opts.privateKeyPem,
        passphrase: opts.passphrase,
        onProgress: (m) => {
            try {
                maintenance.update({ phase: m.phase });
                maintenance.appendLog(`${m.phase}: ${m.text}`, m.progress || null);
            } catch (e) { log.warn(`[restoreFull] Прогресс не записан: ${e.message}`); }
        }
    });

    reopenPool(sequelize);

    if (!run.ok) {
        const err = run.error || {};
        let switched = !!err.switched;
        if (err.unknownState) {
            const probe = await probeState(sequelize, rollbacksBefore);
            switched = probe.switched !== false;      // неизвестность трактуем в худшую сторону
        }
        // Флаг остаётся в ЛЮБОМ случае: мы в аварии, и пускать пользователей не за чем.
        maintenance.update({
            phase: switched ? 'failed_after_switch' : 'failed',
            switched, error: err.errorKey || err.message || 'unknown'
        }, true);
        restore.audit(`RESTORE_RETRY_FAILED file=${fileName} switched=${switched} error=${err.errorKey || err.message}`);
        return { ok: false, errorKey: err.errorKey || 'restore_full_err_failed', vars: err.vars, message: err.message };
    }

    const result = run.result || {};
    maintenance.update({ phase: 'migration', switched: true, rollbackSchema: result.rollbackSchema || '' }, true);
    maintenance.appendLog('migration: приведение структуры к текущей версии приложения');

    try {
        await afterDatabaseReady({ reason: 'restore', migrate: true, origin: 'restore' });
    } catch (e) {
        maintenance.update({ phase: 'migration_failed', error: e.message }, true);
        restore.audit(`RESTORE_RETRY_MIGRATION_FAILED file=${fileName} error=${e.message}`);
        log.error(`[restoreFull] Миграция после повтора: ${e.stack || e.message}`);
        return { ok: false, errorKey: 'restore_err_migration', message: e.message, maintenance: true };
    }

    restore.audit(
        `RESTORE_RETRY_OK file=${fileName} rows=${result.totalRows} `
        + `rollback=${result.rollbackSchema} ms=${Date.now() - startedAt}`
    );
    maintenance.clear({ who: String(opts.userId || 'recovery-admin'), note: 'restore retry completed' });
    try { await dialect.dropStaleRollbacks(sequelize, { keep: 1, maxKeep: 3, olderThanDays: 7 }); } catch (e) {}

    log.info(`[restoreFull] Повтор восстановления завершён: ${result.totalRows} строк`);
    return {
        ok: true, totalRows: result.totalRows,
        tables: Object.keys(result.tables || {}).length,
        rollbackSchema: result.rollbackSchema,
        durationMs: Date.now() - startedAt
    };
}

/**
 * Копии, ПРИГОДНЫЕ для повтора, — читаются С ДИСКА, а не из журнала `backup_files`.
 *
 * Журнал живёт в базе, а база в этот момент как раз и есть предмет аварии: она может
 * быть подменена наполовину, содержать список файлов чужого момента или не открываться
 * вовсе. Каталог хранения — единственный источник, которому здесь можно верить.
 * Заголовок копии читается без приватного ключа.
 */
function listRestorableFiles() {
    const settingsStore2 = require('./settings');
    const out = [];
    let dir;
    try { dir = settingsStore2.storagePath(); } catch (e) { return out; }
    let names = [];
    try { names = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.mosbak')); } catch (e) { return out; }

    for (const fileName of names) {
        const full = path.join(dir, fileName);
        let info = null;
        try { info = restore.readContainerInfo(full); } catch (e) { continue; }   // не наш файл
        const h = info.header || {};
        const scope = h.scope || {};
        let size = 0;
        try { size = fs.statSync(full).size; } catch (e) {}
        out.push({
            fileName,
            createdAt: h.createdAt || '',
            scopeType: scope.type || 'full',
            encrypted: info.encrypted,
            keyFingerprint: h.keyFingerprint || '',
            dbVersion: h.dbVersion || 0,
            size
        });
    }
    // Сортируем по МОМЕНТУ СНЯТИЯ из заголовка, а не по имени файла: имя начинается с
    // области копии, и по алфавиту копии организаций уезжают выше более свежих полных.
    out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
        || b.fileName.localeCompare(a.fileName));
    return out;
}

module.exports = {
    execute, retry, precheckRetry, listRestorableFiles,
    afterDatabaseReady, reopenPool, probeState, makeSafetyDump
};
