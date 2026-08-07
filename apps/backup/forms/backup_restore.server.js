'use strict';

/**
 * Серверные функции формы «Восстановление организации» (ТЗ §6.6).
 *
 * Форма виртуальная: таблицы `backup_restore` в базе нет, данные отдаёт `onLoadData`.
 * Запись в базу делает не «сохранение формы», а явная кнопка — и только после
 * анализа, подтверждения наименованием и обязательной safety-выгрузки.
 *
 * Приватный ключ вводит администратор и он НИГДЕ не сохраняется: на сервере его нет
 * по построению (§4), и появиться он не должен даже временно.
 *
 * Проверок роли в функциях нет намеренно: модуль зарегистрирован
 * `loadServerScript(..., 'admin')`, а лейаут — `saveLayout({ roles: 'admin' })`.
 */

const log = require('../../../drive_root/log');
const dbGateway = require('../../../drive_root/dbGateway');
const backup = require('../../../drive_root/backup');
const scheduler = require('../../../drive_root/scheduler');
const formsCtx = require('../../../drive_forms/globalServerContext');
const { tForSession, tfForSession } = formsCtx;

const path = require('path');
const fs = require('fs');

const SAFETY_TIMEOUT_MS = 30 * 60 * 1000;

module.exports = function (modelsDB, Utilities) {

    const sequelize = () => require('../../../drive_root/db/sequelize_instance');
    const mergedModels = () => require('../../../drive_root/globalServerContext').collectMergedModelDefs().models;

    /**
     * Источник: запись журнала копий ЛИБО файл, только что загруженный с диска.
     *
     * Загрузка нужна ровно для основного сценария: ежедневные копии уезжают в домашний
     * архив, там расшифровываются и хранятся открытыми, а когда одна организация
     * «накосячила позавчера», нужный файл лежит ДОМА, а не на сервере. Без загрузки
     * восстановить организацию из него нечем.
     *
     * Путь с клиента не принимается никогда: либо UID записи журнала, либо имя файла,
     * порождённое нашим же роутом загрузки и лежащее в известном каталоге.
     */
    async function resolveFile(params, ctx) {
        const uploadName = String((params && params.uploadName) || '').trim();
        if (uploadName) {
            if (!/^upload-[0-9a-z\-]+\.mosbak$/i.test(uploadName)) return null;
            const filePath = path.join(require('../server.js').uploadDir(), uploadName);
            return {
                rec: { fileName: uploadName },
                filePath,
                exists: fs.existsSync(filePath),
                temporary: true
            };
        }

        const fileUID = String((params && params.fileUID) || '').trim();
        if (!fileUID) return null;
        const rows = await dbGateway.execute({
            operation: 'read', table: 'backup_files',
            where: { UID: fileUID }, options: { raw: true },
            context: { sessionID: ctx.sessionID }
        });
        const rec = rows && rows[0];
        if (!rec) return null;
        const filePath = path.join(backup.settings.storagePath(), rec.fileName);
        return { rec, filePath, exists: fs.existsSync(filePath), temporary: false };
    }

    async function orgName(organizationId, ctx) {
        if (!organizationId) return '';
        const rows = await dbGateway.execute({
            operation: 'read', table: 'organizations',
            where: { UID: organizationId }, options: { raw: true },
            context: { sessionID: ctx.sessionID }
        });
        return (rows && rows[0] && rows[0].name) || '';
    }

    /** Человекочитаемый отчёт анализа. Язык — сессии: это операция админа, а не документ организации. */
    async function formatReport(report, sessionID) {
        const L = [];
        const t = (k, v) => v ? tfForSession(k, sessionID, v) : tForSession(k, sessionID);

        // Структура
        if (report.structure.fatal.length) {
            L.push(await t('restore_rep_structure_fatal'));
            for (const f of report.structure.fatal) {
                L.push('  · ' + await t('restore_rep_' + f.kind, {
                    table: f.table, column: f.column || '', from: f.from || '', to: f.to || ''
                }));
            }
        } else {
            L.push(await t('restore_rep_structure_ok'));
        }
        for (const s of report.structure.safe) {
            L.push('  · ' + await t('restore_rep_' + s.kind, { table: s.table, column: s.column || '' }));
        }

        // Ссылки на глобальные справочники
        if (report.dangling.length) {
            L.push('');
            L.push(await t('restore_rep_dangling', { count: String(report.dangling.length) }));
            for (const d of report.dangling.slice(0, 20)) {
                L.push(`  · ${d.table}.${d.column} → ${d.target} ${d.uid}`);
            }
            if (report.dangling.length > 20) L.push('  · …');
        }

        if (report.cycle.length && !report.foreignKeysOff.ok) {
            L.push('');
            L.push(await t('restore_rep_cycle', { list: report.cycle.join(', ') }));
        }

        // Что именно произойдёт
        L.push('');
        L.push(await t('restore_rep_plan_head'));
        for (const row of report.tables) {
            L.push(`  ${row.table}: −${row.willDelete} / +${row.willInsert}${row.mode === 'upsert' ? ' (upsert)' : ''}`);
        }
        L.push('');
        L.push(await t('restore_rep_totals', { del: String(report.totalDelete), ins: String(report.totalInsert) }));
        if (report.users.total) {
            L.push(await t('restore_rep_users', {
                create: String(report.users.create), update: String(report.users.update)
            }));
        }
        if (!report.foreignKeysOff.ok) {
            L.push(await t('restore_rep_fk_by_order', { reason: String(report.foreignKeysOff.reason || '') }));
        }
        return L.join('\n');
    }

    return {

        /** Открытие формы: что за файл и на какую организацию его накатывать. */
        async onLoadData(params, ctx) {
            const p = (params && params.params) || {};
            const fileUID = p.fileUID || '';
            const found = (fileUID || p.uploadName) ? await resolveFile(p, ctx) : null;

            let fileInfo = '';
            let organizationId = '';
            if (found && found.exists) {
                try {
                    const h = backup.restore.readHeader(found.filePath);
                    const sc = (h.scope && h.scope.type) || 'full';
                    if (sc === 'organization') organizationId = h.scope.organizationId || '';
                    fileInfo = await tfForSession('restore_file_info_value', ctx.sessionID, {
                        created: String(h.createdAt || '').replace('T', ' ').slice(0, 19),
                        scope: sc,
                        db: String(h.dbName || ''),
                        dialect: String(h.sourceDialect || '')
                    });
                } catch (e) {
                    fileInfo = await tfForSession('restore_err_header', ctx.sessionID, { message: e.message });
                }
            } else if (found) {
                fileInfo = await tForSession('restore_err_file_missing', ctx.sessionID);
            }

            return {
                data: {
                    fileUID,
                    fileName: (found && found.rec.fileName) || '',
                    fileInfo,
                    organizationId,
                    privateKeyPem: '',
                    reportText: await tForSession('restore_hint_analyze_first', ctx.sessionID),
                    confirmName: ''
                },
                caption: await tForSession('restore_app_caption', ctx.sessionID)
            };
        },

        /**
         * Шаги 2–4: сверка структуры, сверка ссылок, dry-run. Ничего не меняет.
         */
        async analyzeDump(params, ctx) {
            const fileUID = params && params.fileUID;
            const organizationId = params && params.organizationId;
            const privateKeyPem = String((params && params.privateKeyPem) || '').trim();

            if (!organizationId) return { error: await tForSession('restore_err_org_required', ctx.sessionID) };
            const found = await resolveFile(params, ctx);
            if (!found || !found.exists) return { error: await tForSession('restore_err_file_missing', ctx.sessionID) };

            // Ключ нужен ТОЛЬКО зашифрованной копии. Из домашнего архива приходит
            // расшифрованная — требовать у неё ключ значило бы закрыть основной сценарий.
            // Диагностика идёт до всякой работы: чаще всего сюда подсовывают ПУБЛИЧНЫЙ
            // ключ, и «ключ от другой пары» отправляет искать не то.
            let encrypted = true;
            try { encrypted = backup.restore.readContainerInfo(found.filePath).encrypted; } catch (e) {}
            if (encrypted) {
                const keyCheck = backup.keys.validatePrivateKey(privateKeyPem);
                if (!keyCheck.ok) {
                    return { error: await tfForSession(keyCheck.errorKey, ctx.sessionID, keyCheck.vars || {}) };
                }
            }

            let report;
            try {
                report = await backup.restore.analyze({
                    sequelize: sequelize(), models: mergedModels(),
                    filePath: found.filePath, privateKeyPem, organizationId
                });
            } catch (e) {
                log.error(`[restore] Анализ ${found.rec.fileName}: ${e.stack || e.message}`);
                const key = e.errorKey || 'restore_err_analyze';
                return { error: await tfForSession(key, ctx.sessionID, Object.assign({ message: e.message }, e.vars || {})) };
            }

            return {
                ok: report.ok,
                blockers: report.blockers,
                reportText: await formatReport(report, ctx.sessionID),
                confirmHint: report.ok
                    ? await tfForSession('restore_confirm_hint', ctx.sessionID, { name: await orgName(organizationId, ctx) })
                    : ''
            };
        },

        /**
         * Шаги 1, 5–8: safety-выгрузка → подтверждение → транзакционное замещение → аудит.
         *
         * Safety-выгрузка ОБЯЗАТЕЛЬНА и идёт тем же путём, что любая другая (задание
         * `backup.create`), — отдельной ветки выгрузки в системе быть не должно. Её
         * результата дожидаемся: восстанавливать, не убедившись, что копия снята,
         * означало бы остаться без пути назад.
         */
        async runRestore(params, ctx) {
            const fileUID = params && params.fileUID;
            const organizationId = params && params.organizationId;
            const privateKeyPem = String((params && params.privateKeyPem) || '').trim();
            const confirmName = String((params && params.confirmName) || '').trim();

            if (!organizationId) return { error: await tForSession('restore_err_org_required', ctx.sessionID) };
            const found = await resolveFile(params, ctx);
            if (!found || !found.exists) return { error: await tForSession('restore_err_file_missing', ctx.sessionID) };

            // Ключ нужен ТОЛЬКО зашифрованной копии. Из домашнего архива приходит
            // расшифрованная — требовать у неё ключ значило бы закрыть основной сценарий.
            // Диагностика идёт до всякой работы: чаще всего сюда подсовывают ПУБЛИЧНЫЙ
            // ключ, и «ключ от другой пары» отправляет искать не то.
            let encrypted = true;
            try { encrypted = backup.restore.readContainerInfo(found.filePath).encrypted; } catch (e) {}
            if (encrypted) {
                const keyCheck = backup.keys.validatePrivateKey(privateKeyPem);
                if (!keyCheck.ok) {
                    return { error: await tfForSession(keyCheck.errorKey, ctx.sessionID, keyCheck.vars || {}) };
                }
            }

            const name = await orgName(organizationId, ctx);
            if (!name || confirmName !== name) {
                return { error: await tfForSession('restore_err_confirm_mismatch', ctx.sessionID, { name }) };
            }

            // Файл-источник помечается используемым НА ВСЮ операцию: safety-выгрузка
            // создаёт новую копию и запускает прореживание, а оно способно удалить как
            // раз этот файл (ручных копий хранится три). Поймано прогоном — восстановление
            // падало с ENOENT на собственном источнике.
            // Загруженный с диска файл лежит в отдельном каталоге и ретеншну не
            // подвержен — помечать нечего.
            const releaseFile = found.temporary
                ? () => {}
                : backup.markInUse(backup.settings.storagePath(), found.rec.fileName);
            try {
                return await runRestoreGuarded({ ctx, found, organizationId, privateKeyPem, name });
            } finally {
                releaseFile();
                // Временный файл содержит персональные данные всех клиентов —
                // не остаётся в каталоге ни при каком исходе.
                if (found.temporary) { try { fs.unlinkSync(found.filePath); } catch (e) {} }
            }
        }
    };

    /** Тело восстановления. Вынесено, чтобы снятие отметки «файл занят» было гарантировано. */
    async function runRestoreGuarded({ ctx, found, organizationId, privateKeyPem, name }) {
            // ── Шаги 2–4 ДО safety-выгрузки ─────────────────────────────────────────
            // Проверки читающие и дешёвые. Прогонять их первыми — значит не тратить
            // выгрузку и время пользователя на восстановление, которое всё равно
            // запрещено (несовместимая структура, висячие ссылки). Гарантия ТЗ при этом
            // не нарушена: safety-копия по-прежнему снимается до любой ЗАПИСИ.
            const pre = await backup.restore.analyze({
                sequelize: sequelize(), models: mergedModels(),
                filePath: found.filePath, privateKeyPem, organizationId
            }).catch(e => ({ __error: e }));
            if (pre.__error) {
                const e = pre.__error;
                log.error(`[restore] Предпроверка ${found.rec.fileName}: ${e.stack || e.message}`);
                return { error: await tfForSession(e.errorKey || 'restore_err_analyze', ctx.sessionID, Object.assign({ message: e.message }, e.vars || {})) };
            }
            if (!pre.ok) {
                return {
                    error: await tForSession('restore_err_blocked', ctx.sessionID),
                    reportText: await formatReport(pre, ctx.sessionID)
                };
            }

            // ── Шаг 1: safety-выгрузка этой организации ──────────────────────────────
            const settings = backup.settings.read();
            if (!settings.publicKeyPem) return { error: await tForSession('backup_err_key_empty', ctx.sessionID) };

            const tasks = await dbGateway.execute({
                operation: 'read', table: 'scheduler_tasks',
                where: { handler: 'backup.create' }, options: { raw: true },
                context: { sessionID: ctx.sessionID }
            });
            const task = tasks && tasks[0];
            if (!task) return { error: await tForSession('restore_err_no_backup_task', ctx.sessionID) };

            const started = await scheduler.runNow(task.UID, {
                scope: 'organization', scopeOrganizationId: String(organizationId)
            });
            if (!started.ok) {
                return { error: await tForSession(started.errorKey || 'sched_err_dispatch_failed', ctx.sessionID) };
            }
            const safety = await scheduler.waitForRun(started.runId, { timeoutMs: SAFETY_TIMEOUT_MS });
            if (!safety.ok) {
                return {
                    error: await tfForSession('restore_err_safety_failed', ctx.sessionID, {
                        status: String(safety.status || ''),
                        message: String((safety.run && safety.run.errorText) || '')
                    })
                };
            }
            backup.restore.audit(`RESTORE_SAFETY org=${organizationId} run=${started.runId} user=${ctx.user && ctx.user.UID}`);

            // ── Шаги 2–7: анализ повторяется внутри и его вердикт обязателен ─────────
            let res;
            try {
                res = await backup.restore.restoreOrganization({
                    sequelize: sequelize(), models: mergedModels(),
                    filePath: found.filePath, privateKeyPem, organizationId,
                    keepSessionId: ctx.sessionID
                });
            } catch (e) {
                log.error(`[restore] Восстановление организации ${organizationId}: ${e.stack || e.message}`);
                backup.restore.audit(`RESTORE_FAILED org=${organizationId} file=${found.rec.fileName} user=${ctx.user && ctx.user.UID} error=${e.message}`);
                const key = e.errorKey === 'restore_err_blocked' ? 'restore_err_blocked' : 'restore_err_failed';
                return {
                    error: await tfForSession(key, ctx.sessionID, { message: e.message }),
                    reportText: e.report ? await formatReport(e.report, ctx.sessionID) : undefined
                };
            }

            // ── Шаг 8: аудит в файл ─────────────────────────────────────────────────
            backup.restore.audit(
                `RESTORE_ORG org=${organizationId} name="${name}" file=${found.rec.fileName} `
                + `user=${ctx.user && ctx.user.UID} deleted=${res.report.totalDelete} inserted=${res.report.totalInsert} `
                + `usersCreated=${res.stats.usersCreated} usersUpdated=${res.stats.usersUpdated} `
                + `sessionsReset=${res.sessionsReset} ms=${res.durationMs}`
            );
            log.info(`[restore] Организация ${name} восстановлена из ${found.rec.fileName} за ${res.durationMs} мс`);

            // Открытые списки других окон обязаны перечитаться: мы писали мимо applyChanges.
            try {
                const uniForm = require('../../uniForm/server.js');
                for (const table of Object.keys(res.stats.inserted)) uniForm.notifyTableChange(table, 'update', null);
            } catch (e) { /* SSE-оповещение не важнее результата */ }

            return {
                ok: true,
                message: await tfForSession('restore_done_msg', ctx.sessionID, {
                    name,
                    del: String(res.report.totalDelete),
                    ins: String(res.report.totalInsert),
                    sessions: String(res.sessionsReset)
                })
            };
    }
};
