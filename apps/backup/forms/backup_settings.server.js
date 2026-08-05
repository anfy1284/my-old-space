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
const scheduler = require('../../../drive_root/scheduler');
const formsCtx = require('../../../drive_forms/globalServerContext');
const { tForSession, tfForSession } = formsCtx;

const TASK_TABLE = 'scheduler_tasks';
const HANDLER = 'backup.create';

module.exports = function (modelsDB, Utilities) {

    /**
     * Роль проверяется на сервере: скрытая кнопка — не защита.
     *
     * Роль РЕЗОЛВИТСЯ ПО СЕССИИ, а не берётся из `ctx.role`: при диспетче событий формы
     * (`onLoadData`, `onSave`) фреймворк передаёт только `sessionID`, и проверка по
     * `ctx.role` отвергала даже администратора — форма открывалась пустым окном.
     */
    async function requireAdmin(ctx) {
        const sessionID = ctx && ctx.sessionID;
        let role = ctx && ctx.role;
        if (!role && sessionID) {
            const globalCtx = require('../../../drive_root/globalServerContext');
            const user = await globalCtx.getUserBySessionID(sessionID);
            role = user ? await formsCtx.getUserAccessRole(user) : null;
            if (ctx && !ctx.user && user) ctx.user = user;
        }
        if (role !== 'admin') {
            const e = new Error(await tForSession('backup_err_admin_only', sessionID));
            e.userMessage = e.message;
            throw e;
        }
    }

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

        lines.push(s.publicKeyPem
            ? await tfForSession('backup_status_key_set', sessionID, { fingerprint: String(s.keyFingerprint || '').slice(0, 23) })
            : await tForSession('backup_status_key_missing', sessionID));

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

    return {

        /**
         * Загрузка формы: настройки из файла + состояние.
         *
         * `data` — МАССИВ элементов `{ name, value }`, а не объект-словарь: таков
         * контракт `onLoadData` у uniForm (эталон — `organization_settings.server.js`).
         * Объект проходит без ошибки, но форма молча остаётся пустой.
         */
        async onLoadData(params, ctx) {
            await requireAdmin(ctx);
            const s = backup.settings.read();
            const values = {
                storageDir: s.storageDir,
                keepScheduled: s.keepScheduled,
                keepManual: s.keepManual,
                publicKeyPem: s.publicKeyPem,
                keyFingerprint: s.keyFingerprint,
                statusText: await buildStatusText(ctx.sessionID)
            };
            return {
                data: Object.entries(values).map(([name, value]) => ({ name, value, tabularSection: false })),
                caption: await tForSession('backup_app_caption', ctx.sessionID)
            };
        },

        /** Сохранение: пишем в файл, а не в БД. Ключ проверяем ДО записи. */
        async onSave(params, ctx) {
            await requireAdmin(ctx);
            const d = Object.assign({}, (params && params.changes) || (params && params.data) || {});
            delete d.__tabularSections;
            const patch = {};

            if (d.storageDir !== undefined) patch.storageDir = String(d.storageDir || '').trim() || 'backups';
            if (d.keepScheduled !== undefined) patch.keepScheduled = Math.max(1, Number(d.keepScheduled) || 1);
            if (d.keepManual !== undefined) patch.keepManual = Math.max(1, Number(d.keepManual) || 1);

            if (d.publicKeyPem !== undefined) {
                const pem = String(d.publicKeyPem || '').trim();
                if (pem) {
                    const v = backup.keys.validatePublicKey(pem);
                    if (!v.ok) return { error: await tfForSession(v.errorKey, ctx.sessionID, v.vars || {}) };
                    patch.publicKeyPem = pem;
                    patch.keyFingerprint = v.fingerprint;
                } else {
                    patch.publicKeyPem = '';
                    patch.keyFingerprint = '';
                }
            }

            backup.settings.write(patch);
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
            await requireAdmin(ctx);
            const pair = backup.keys.generatePair();
            backup.settings.write({ publicKeyPem: pair.publicKeyPem, keyFingerprint: pair.fingerprint });

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
         * «Создать сейчас» — ставит запуск задания. Разовая область передаётся
         * параметрами запуска, а не скрытым каналом между формой и обработчиком.
         */
        async createNow(params, ctx) {
            await requireAdmin(ctx);
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

        /** Удалить копию: сначала файл, потом запись — осиротевшая запись честнее осиротевшего файла. */
        async deleteBackup(params, ctx) {
            await requireAdmin(ctx);
            const uid = params && params.uid;
            if (!uid) return { error: await tForSession('backup_err_no_selection', ctx.sessionID) };
            const context = { sessionID: ctx.sessionID };

            const rows = await dbGateway.execute({
                operation: 'read', table: 'backup_files', where: { UID: uid }, options: { raw: true }, context
            });
            const rec = rows && rows[0];
            if (!rec) return { error: await tForSession('backup_err_no_selection', ctx.sessionID) };

            try { backup.deleteFile(backup.settings.storagePath(), rec.fileName); }
            catch (e) { log.error(`[backup] Удаление файла ${rec.fileName}: ${e.message}`); }

            await dbGateway.execute({ operation: 'delete', table: 'backup_files', where: { UID: uid }, context });
            try { require('../../uniForm/server.js').notifyTableChange('backup_files', 'delete', uid); } catch (e) {}
            return { ok: true };
        },

        /** UID задания — чтобы открыть его форму и настроить расписание. */
        async getTaskUID(params, ctx) {
            await requireAdmin(ctx);
            const task = await ensureTask(ctx);
            return { taskUID: task.UID };
        },

        /** Обновить панель состояния без перезагрузки формы. */
        async getStatus(params, ctx) {
            await requireAdmin(ctx);
            return { statusText: await buildStatusText(ctx.sessionID) };
        }
    };
};
