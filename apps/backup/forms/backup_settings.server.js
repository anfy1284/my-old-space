'use strict';

/**
 * Серверные функции формы «Резервное копирование».
 *
 * Форма редактирует ИНСТАЛЛЯЦИОННЫЕ настройки, которые лежат в файле, а не в БД:
 * каталог, публичный ключ и лимиты относятся к этой машине. В базе они уехали бы в
 * бэкап, и восстановление старого дампа молча вернуло бы прежний путь и отозвало
 * действующий ключ (ТЗ §2.1).
 *
 * Выгрузку эти функции НЕ выполняют: они ставят запуск задачи `backup.create` через
 * планировщик — то же ядро, что и по расписанию.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const log = require('../../../drive_root/log');
const dbGateway = require('../../../drive_root/dbGateway');
const backup = require('../../../drive_root/backup');
const { audit } = require('../../../drive_root/backup/audit');
const scheduler = require('../../../drive_root/scheduler');
const formsCtx = require('../../../drive_forms/globalServerContext');
const { tForSession, tfForSession } = formsCtx;

const TASK_TABLE = 'scheduler_tasks';
const HANDLER = 'backup.create';

module.exports = function (modelsDB, Utilities) {

    /**
     * Проверки роли в каждом RPC здесь НЕТ — и не должно быть.
     *
     * Гейт следует из регистрации: `loadServerScript('backup.actions', …, 'admin')` в
     * `init.js` не отдаёт этот модуль никому, кроме администратора (проверяет
     * `serverScriptStore.getServerScript` — и в роуте `/server-call`, и при диспетче
     * событий формы), а `saveLayout({ roles: 'admin' })` не отдаёт ему лейаут. Ручная
     * проверка в каждой функции была бы копией того, что ядро уже делает, причём такой,
     * которую однажды забудут написать в новой функции.
     */

    /**
     * Задание `backup.create` этой инсталляции. Создаётся выключенным при первом
     * обращении: расписание админ включит сам, а кнопке «Создать сейчас» задание
     * нужно всегда — ручной запуск идёт тем же путём, что и плановый.
     */
    async function ensureTask(ctx) {
        const context = { sessionID: ctx.sessionID };
        const found = await dbGateway.execute({
            operation: 'read', table: TASK_TABLE,
            where: { handler: HANDLER }, options: { raw: true }, context
        });
        if (found && found.length) return found[0];

        const created = await dbGateway.execute({
            operation: 'create', table: TASK_TABLE, context,
            data: {
                caption: await tForSession('backup_task_caption', ctx.sessionID),
                handler: HANDLER,
                enabled: false,
                organizationId: null,
                hotelId: null,
                userId: ctx.user && ctx.user.UID,
                scheduleMode: 'daily',
                timeOfDay: '02:00',
                timezone: 'Europe/Berlin',
                misfirePolicy: 'runOnce',
                timeoutSec: 3600,
                maxRetries: 0,
                retryDelaySec: 300
            }
        });
        log.info('[backup] Создано регламентное задание резервного копирования (выключено)');
        return (created && created.get) ? created.get({ plain: true }) : created;
    }

    /** Текст панели состояния: режим инсталляции виден ДО аварии, а не в момент неё. */
    async function buildStatusText(sessionID) {
        const sequelize = require('../../../drive_root/db/sequelize_instance');
        const s = backup.settings.read();
        const lines = [];

        const dialectName = backup.dialect.nameOf(sequelize);
        const nb = await backup.dialect.checkNonBlocking(sequelize).catch(e => ({ ok: false, errorKey: e.message }));
        lines.push(await tfForSession('backup_status_dialect', sessionID, {
            dialect: dialectName,
            mode: nb.ok
                ? await tForSession('backup_status_nonblocking_ok', sessionID)
                : await tForSession('backup_status_nonblocking_bad', sessionID)
        }));

        const dir = backup.settings.storagePath(s);
        const free = backup.dialect.freeSpace(dir);
        const dbSize = await backup.dialect.databaseSize(sequelize).catch(() => 0);
        lines.push(await tfForSession('backup_status_space', sessionID, {
            dir,
            free: free ? String(Math.round(free / 1048576)) : '?',
            db: dbSize ? String(Math.round(dbSize / 1048576)) : '?'
        }));

        if (s.publicKeyPem) {
            lines.push(await tfForSession('backup_status_key_set', sessionID,
                { fingerprint: String(s.keyFingerprint || '').slice(0, 23) }));
        } else {
            // Ключа нет, а в каталоге лежат копии — это не «ещё не настроено», это
            // ПОТЕРЯ. Разница для администратора решающая: в первом случае надо
            // сгенерировать пару, во втором — сначала понять, куда делся ключ, иначе
            // новая пара исчезнет тем же путём, а лежащие копии останутся зашифрованными
            // ключом, о котором система уже не помнит.
            let known = 0;
            try { known = backup.catalog.list().length; } catch (e) { known = 0; }

            lines.push(known
                ? await tfForSession('backup_status_key_lost', sessionID, {
                    count: String(known),
                    file: backup.settings.storagePath()
                })
                : await tForSession('backup_status_key_missing', sessionID));
        }

        // Что умеет восстановление на сегодня — сказать ЗДЕСЬ, а не оставлять
        // пользователя гадать, почему в панели есть «восстановить организацию» и нет
        // «восстановить всю базу». Мёртвая выключенная кнопка была бы хуже строки текста.
        lines.push(await tForSession('backup_status_restore_scope', sessionID));

        // Неизвестные объекты: логическая выгрузка их не видит, и молчать об этом нельзя.
        try {
            const globalCtx = require('../../../drive_root/globalServerContext');
            const { models } = globalCtx.collectMergedModelDefs();
            const cmp = await backup.dump.compareWithDatabase(sequelize, models);
            if (cmp.unknownObjects.length) {
                lines.push(await tfForSession('backup_status_unknown_objects', sessionID, { list: cmp.unknownObjects.join(', ') }));
            }
        } catch (e) {
            log.warn(`[backup] Сверка объектов не выполнена: ${e.message}`);
        }

        return lines.join('\n');
    }

    /**
     * Строки таблицы внешних хранилищ.
     *
     * Отпечаток показывается ЦЕЛИКОМ: по нему администратор сверяет, тот ли ключ он
     * зарегистрировал, — и сверять придётся с тем, что показало у себя хранилище.
     * Обрезанный отпечаток для сверки не годится.
     */
    async function apiClientRows(sessionID) {
        const rows = [];
        for (const c of backup.apiAuth.listClients()) {
            rows.push({
                id: c.id,
                name: c.name || '',
                fingerprint: c.fingerprint || '',
                stateText: await tForSession(c.disabled ? 'backup_api_state_off' : 'backup_api_state_on', sessionID),
                lastSeenText: c.lastSeenAt
                    ? String(c.lastSeenAt).slice(0, 19).replace('T', ' ') + (c.lastSeenIp ? ` (${c.lastSeenIp})` : '')
                    : await tForSession('backup_api_never_seen', sessionID)
            });
        }
        return rows;
    }

    /**
     * Строки списка копий — из КАТАЛОГА.
     *
     * Синхронно и без базы: каталог и есть источник истины, а чтение заголовков — это
     * несколько небольших чтений с диска на файл. Пересчитывать sha256 здесь нельзя и
     * не нужно — он лежит в спутнике (см. catalog.js).
     */
    function backupFileRows() {
        return backup.catalog.list().map(f => ({
            fileName: f.fileName,
            date: f.createdAt,
            title: f.title,
            scopeType: f.scopeType,
            scopeOrganizationName: f.scopeOrganizationName,
            triggeredBy: f.triggeredBy,
            rowsTotal: f.rowsTotal,
            sizeBytes: f.size,
            sha256: f.sha256,
            inUse: f.inUse
        }));
    }

    return {

        /** Загрузка формы: настройки из базы + состояние этой машины. */
        async onLoadData(params, ctx) {
            // Не полагаемся на то, что прогрев при старте успел отработать: форму
            // открывают в том числе через секунду после перезапуска.
            const s = await backup.settings.ensureLoaded();
            return {
                data: {
                    // Каталог показывается, но не редактируется: он нужен, когда база
                    // недоступна, поэтому задаётся переменной окружения, а не здесь.
                    // Показывать его всё равно надо — иначе «куда легли копии» будет
                    // выясняться по файловой системе сервера.
                    storageDir: s.storageDir,
                    keepScheduled: s.keepScheduled,
                    keepManual: s.keepManual,
                    publicKeyPem: s.publicKeyPem,
                    keyFingerprint: s.keyFingerprint,
                    apiClients: await apiClientRows(ctx.sessionID),
                    apiClientName: '',
                    apiClientKeyPem: '',
                    // Организация для выгрузки по одной организации. Пустое значение
                    // задаётся ЯВНО: контрол, ни разу не проинициализированный, отдаёт
                    // undefined, и проверки «выбрана ли организация» начинают зависеть
                    // от того, трогал ли пользователь поле.
                    scopeOrganizationId: '',
                    backupFiles: backupFileRows(),
                    recoveryPassword: '',
                    recoveryState: await tForSession(
                        require('../../../drive_root/recoveryPassword').isSet()
                            ? 'backup_recovery_state_set' : 'backup_recovery_state_unset',
                        ctx.sessionID),
                    statusText: await buildStatusText(ctx.sessionID)
                },
                caption: await tForSession('backup_app_caption', ctx.sessionID)
            };
        },

        /**
         * Задать аварийный пароль восстановления вводом (ТЗ §6.2а, путь 1).
         *
         * Три пути к паролю не роскошь: форма годится, пока система жива; генерация с
         * однократным показом закрывает первичную настройку («пустое поле до случая»
         * означает, что в нужный момент пароля не окажется); консольный скрипт нужен
         * тогда, когда войти в систему уже нельзя, — то есть ровно тогда, когда пароль
         * и требуется. Здесь — первый путь.
         *
         * Пароль НЕ сохраняется в поле формы и не уходит в журнал: в файл пишется
         * только хэш, и запись атомарна с сохранением реквизитов подключения к базе.
         */
        async setRecoveryPassword(params, ctx) {
            const recovery = require('../../../drive_root/recoveryPassword');
            const pwd = String((params && params.recoveryPassword) || '');
            try {
                await recovery.set(pwd);
            } catch (e) {
                return { error: await tfForSession(e.errorKey || 'backup_recovery_write_failed', ctx.sessionID, { message: e.message }) };
            }
            require('../../../drive_root/maintenance').audit(`RECOVERY_PWD_SET user=${ctx.user && ctx.user.UID}`);
            return {
                ok: true,
                state: await tForSession('backup_recovery_state_set', ctx.sessionID),
                message: await tForSession('backup_recovery_saved', ctx.sessionID)
            };
        },

        /** Сохранение: пишем в БД. Ключ проверяем ДО записи. */
        async onSave(params, ctx) {
            const d = Object.assign({}, (params && params.changes) || (params && params.data) || {});
            delete d.__tabularSections;
            const patch = {};

            // storageDir здесь НЕ принимается: каталог задаётся переменной окружения,
            // потому что нужен, когда база недоступна. Поле формы доступно только для
            // чтения, и принимать его отсюда значило бы обещать правку, которой нет.
            if (d.keepScheduled !== undefined) patch.keepScheduled = Math.max(1, Number(d.keepScheduled) || 1);
            if (d.keepManual !== undefined) patch.keepManual = Math.max(1, Number(d.keepManual) || 1);

            if (d.publicKeyPem !== undefined) {
                const pem = String(d.publicKeyPem || '').trim();
                if (pem) {
                    const v = backup.keys.validatePublicKey(pem);
                    if (!v.ok) return { error: await tfForSession(v.errorKey, ctx.sessionID, v.vars || {}) };
                    patch.publicKeyPem = pem;
                    patch.keyFingerprint = v.fingerprint;
                } else if (backup.settings.read().publicKeyPem) {
                    // Пустое поле НЕ стирает установленный ключ.
                    //
                    // Стирание было бы самым дорогим действием формы: без публичного ключа
                    // копирование останавливается, а расшифровать уже сделанные копии
                    // становится нечем, если приватный ключ не сохранён отдельно. Такое
                    // действие не может происходить «заодно» с сохранением каталога или
                    // лимитов — а происходило оно именно так: достаточно, чтобы поле
                    // оказалось пустым (форма не догрузила данные, поле очистили по
                    // ошибке), и первое же «Сохранить» уносило ключ вместе с отпечатком.
                    //
                    // Ключ ЗАМЕНЯЕТСЯ вставкой другого PEM или кнопкой «Сгенерировать
                    // пару» — оба пути осознанные. Пути «очистить» нет намеренно:
                    // инсталляции без ключа не бывает, бывает инсталляция с другим ключом.
                    log.warn('[backup] Сохранение с пустым полем публичного ключа: установленный ключ сохранён без изменений');
                } else {
                    patch.publicKeyPem = '';
                    patch.keyFingerprint = '';
                }
            }

            await backup.settings.write(patch);
            try { backup.settings.ensureStorage(); } catch (e) { /* каталог создастся при запуске */ }
            return { ok: true };
        },

        /**
         * Сгенерировать пару ключей.
         *
         * Приватный ключ НЕ сохраняется нигде: он кладётся в память процесса под
         * одноразовый токен и отдаётся скачиванием ровно один раз. Механизм, который
         * генерирует ключ и не показывает его, бессмысленен — получится шифротекст,
         * к которому никто не знает ключа.
         */
        async generateKeys(params, ctx) {
            const pair = backup.keys.generatePair();
            await backup.settings.write({ publicKeyPem: pair.publicKeyPem, keyFingerprint: pair.fingerprint });

            const token = crypto.randomBytes(24).toString('hex');
            require('../server.js').stashPrivateKey(token, pair.privateKeyPem, ctx.user.UID);
            log.info(`[backup] Сгенерирована пара ключей, отпечаток ${pair.fingerprint}`);

            return {
                ok: true,
                publicKeyPem: pair.publicKeyPem,
                keyFingerprint: pair.fingerprint,
                downloadUrl: `/api/apps/backup/private-key/${token}`,
                statusText: await buildStatusText(ctx.sessionID)
            };
        },

        /**
         * Какая копия будет вытеснена ретеншном, если создать ещё одну.
         *
         * Спрашивается ДО запуска: «сколько копий хранить» это настройка, а «вот эта
         * копия сейчас исчезнет» — событие, и узнавать о нём постфактум по пропавшему
         * файлу недопустимо. Считается тем же `selectForPruning`, что и само
         * прореживание, — второго набора правил быть не должно.
         */
        async previewRetention(params, ctx) {
            const s = backup.settings.read();
            const triggeredBy = 'manual';                       // из формы запуск всегда ручной

            // Моделируем БУДУЩЕЕ состояние: каталог + ещё одна копия, которая вот-вот
            // появится. Отсева «пропавших» больше нет — в каталоге их не бывает.
            const future = backup.catalog.list().concat([{
                fileName: '__new__', triggeredBy, date: new Date()
            }]);
            const doomed = backup.selectForPruning(future, s).filter(f => f.fileName !== '__new__');

            return {
                willDelete: doomed.map(f => ({ fileName: f.fileName, triggeredBy: f.triggeredBy, date: f.createdAt })),
                keepManual: s.keepManual,
                keepScheduled: s.keepScheduled
            };
        },

        /**
         * «Создать сейчас» — ставит запуск задания. Разовая область передаётся
         * параметрами запуска, а не скрытым каналом между формой и обработчиком.
         */
        async createNow(params, ctx) {
            const s = backup.settings.read();
            if (!s.publicKeyPem) return { error: await tForSession('backup_err_key_empty', ctx.sessionID) };

            const scopeType = params && params.scope === 'organization' ? 'organization' : 'full';
            if (scopeType === 'organization' && !(params && params.organizationId)) {
                return { error: await tForSession('backup_err_scope_org_required', ctx.sessionID) };
            }

            const task = await ensureTask(ctx);
            const res = await scheduler.runNow(task.UID, {
                scope: scopeType,
                scopeOrganizationId: scopeType === 'organization' ? String(params.organizationId) : ''
            });
            if (!res.ok) return { error: await tForSession(res.errorKey || 'sched_err_dispatch_failed', ctx.sessionID) };
            return { ok: true, runId: res.runId, message: await tForSession('backup_run_started_msg', ctx.sessionID) };
        },

        /**
         * Удалить копию — файл и его спутник. Записи в базе больше нет, поэтому и
         * согласовывать нечего: удаление файла и есть удаление копии.
         */
        async deleteBackup(params, ctx) {
            const rec = backup.catalog.find(params && params.fileName);
            if (!rec) return { error: await tForSession('backup_err_no_selection', ctx.sessionID) };

            // Файл, из которого прямо сейчас идёт восстановление, не удаляем ни по чьей
            // команде: операция читает его в этот момент.
            if (rec.inUse) return { error: await tForSession('backup_err_file_in_use', ctx.sessionID) };

            try {
                backup.catalog.remove(rec.fileName);
            } catch (e) {
                log.error(`[backup] Удаление файла ${rec.fileName}: ${e.message}`);
                return { error: await tfForSession('backup_err_delete_failed', ctx.sessionID, { message: e.message }) };
            }
            return { ok: true, files: backupFileRows() };
        },

        /**
         * Зарегистрировать внешнее хранилище (ТЗ §5).
         *
         * Принимается ТОЛЬКО публичный ключ: приватного здесь быть не должно — в этом
         * весь смысл входа по подписи. Ключ проверяется до записи, и самая частая
         * ошибка настройки (вставили приватный) называется прямо.
         */
        async addApiClient(params, ctx) {
            const res = await backup.apiAuth.addClient(
                (params && params.name) || '',
                (params && params.publicKeyPem) || ''
            );
            if (!res.ok) return { error: await tfForSession(res.errorKey, ctx.sessionID, res.vars || {}) };

            audit(`API_CLIENT_ADD fp=${res.fingerprint} user=${ctx.user && ctx.user.UID}`);
            return {
                ok: true,
                clients: await apiClientRows(ctx.sessionID),
                message: await tfForSession(
                    res.added ? 'backup_api_added_msg' : 'backup_api_reenabled_msg',
                    ctx.sessionID, { fingerprint: res.fingerprint })
            };
        },

        /** Включить/отключить хранилище. Действует сразу: реестр читается на каждом запросе. */
        async toggleApiClient(params, ctx) {
            const id = String((params && params.id) || '');
            const client = backup.apiAuth.listClients().find(c => c.id === id);
            if (!client) return { error: await tForSession('backup_api_err_client_unknown', ctx.sessionID) };

            const res = await backup.apiAuth.setClientDisabled(id, !client.disabled);
            if (!res.ok) return { error: await tForSession(res.errorKey, ctx.sessionID) };

            audit(`API_CLIENT_${client.disabled ? 'ENABLE' : 'DISABLE'} fp=${client.fingerprint} user=${ctx.user && ctx.user.UID}`);
            return { ok: true, clients: await apiClientRows(ctx.sessionID) };
        },

        /** Удалить хранилище из реестра. */
        async removeApiClient(params, ctx) {
            const id = String((params && params.id) || '');
            const client = backup.apiAuth.listClients().find(c => c.id === id);
            const res = await backup.apiAuth.removeClient(id);
            if (!res.ok) return { error: await tForSession(res.errorKey, ctx.sessionID) };

            audit(`API_CLIENT_REMOVE fp=${client && client.fingerprint} user=${ctx.user && ctx.user.UID}`);
            return { ok: true, clients: await apiClientRows(ctx.sessionID) };
        },

        /** UID задания — чтобы открыть его форму и настроить расписание. */
        async getTaskUID(params, ctx) {
            const task = await ensureTask(ctx);
            return { taskUID: task.UID };
        },

        /** Обновить панель состояния и список копий без перезагрузки формы. */
        async getStatus(params, ctx) {
            return { statusText: await buildStatusText(ctx.sessionID), files: backupFileRows() };
        },

        /**
         * Перечитать каталог по требованию.
         *
         * Нужна потому, что каталог меняется мимо формы: копию удаляет внешнее
         * хранилище своей командой, прореживание идёт в воркере, а файлы исчезают при
         * развёртывании. Кнопка «Обновить» честнее, чем список, о котором неизвестно,
         * насколько он свеж.
         */
        async refreshFiles(params, ctx) {
            return { ok: true, files: backupFileRows() };
        }
    };
};
