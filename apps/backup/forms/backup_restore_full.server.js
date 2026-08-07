'use strict';

/**
 * Серверные функции формы «Полное восстановление базы» (ТЗ §6.1–§6.5, экран §6.2б).
 *
 * Форма виртуальная: таблицы `backup_restore_full` в базе нет, данные отдаёт
 * `onLoadData`. Запись делает не «сохранение формы», а явная кнопка — и только после
 * того, как выполнены ВСЕ условия точки невозврата.
 *
 * ЭКРАН ПЕРЕД ЗАПУСКОМ (§6.2б) — не формальность. Дальше начинается процедура, после
 * которой обычный вход невозможен: вместе со старой схемой уходит таблица `sessions`,
 * в том числе сессия самого администратора. Поэтому он обязан выйти из этого экрана
 * С ПАРОЛЕМ НА РУКАХ. Показать сохранённый пароль нельзя — он хэширован; вместо показа
 * два действия: проверить тот, который помнит, либо сгенерировать новый и увидеть его
 * ровно один раз. Кнопка запуска заблокирована, пока не выполнено одно из двух.
 *
 * Приватный ключ вводит администратор, и он НИГДЕ не сохраняется: на сервере его нет
 * по построению, и появиться он не должен даже временно.
 *
 * Проверок роли в функциях нет намеренно: модуль зарегистрирован
 * `loadServerScript(..., 'admin')`, а лейаут — `saveLayout({ roles: 'admin' })`.
 */

const fs = require('fs');
const path = require('path');

const log = require('../../../drive_root/log');
const dbGateway = require('../../../drive_root/dbGateway');
const backup = require('../../../drive_root/backup');
const maintenance = require('../../../drive_root/maintenance');
const recovery = require('../../../drive_root/recoveryPassword');
const formsCtx = require('../../../drive_forms/globalServerContext');
const { tForSession, tfForSession } = formsCtx;

module.exports = function (modelsDB, Utilities) {

    const sequelize = () => require('../../../drive_root/db/sequelize_instance');
    const mergedModels = () => require('../../../drive_root/globalServerContext').collectMergedModelDefs().models;

    /**
     * Разрешить источник в путь к файлу.
     *
     * Путь с клиента не принимаем НИКОГДА: либо UID записи журнала копий, либо имя
     * файла, только что загруженного через наш же роут (оно порождено сервером и лежит
     * в известном каталоге). Иначе форма превращается в чтение произвольного файла с
     * диска сервера.
     */
    async function resolveSource(params, ctx) {
        const uploadName = String((params && params.uploadName) || '').trim();
        if (uploadName) {
            if (!/^upload-[0-9a-z\-]+\.mosbak$/i.test(uploadName)) return null;
            const appServer = require('../server.js');
            const p = path.join(appServer.uploadDir(), uploadName);
            return fs.existsSync(p) ? { filePath: p, fileName: uploadName, temporary: true } : null;
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
        const p = path.join(backup.settings.storagePath(), rec.fileName);
        return fs.existsSync(p) ? { filePath: p, fileName: rec.fileName, temporary: false, rec } : null;
    }


    /**
     * Человекочитаемый отчёт анализа для области «одна организация».
     * Язык — сессии: это операция администратора, а не документ организации.
     */
    async function formatOrgReport(report, sessionID) {
        const L = [];
        const t = (k, v) => v ? tfForSession(k, sessionID, v) : tForSession(k, sessionID);

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

        if (report.dangling.length) {
            L.push('');
            L.push(await t('restore_rep_dangling', { count: String(report.dangling.length) }));
            for (const d of report.dangling.slice(0, 20)) L.push(`  · ${d.table}.${d.column} → ${d.target} ${d.uid}`);
            if (report.dangling.length > 20) L.push('  · …');
        }
        if (report.cycle.length && !report.foreignKeysOff.ok) {
            L.push('');
            L.push(await t('restore_rep_cycle', { list: report.cycle.join(', ') }));
        }

        L.push('');
        L.push(await t('restore_rep_plan_head'));
        for (const row of report.tables) {
            L.push(`  ${row.table}: −${row.willDelete} / +${row.willInsert}${row.mode === 'upsert' ? ' (upsert)' : ''}`);
        }
        L.push('');
        L.push(await t('restore_rep_totals', { del: String(report.totalDelete), ins: String(report.totalInsert) }));
        if (report.users.total) {
            L.push(await t('restore_rep_users', { create: String(report.users.create), update: String(report.users.update) }));
        }
        if (!report.foreignKeysOff.ok) {
            L.push(await t('restore_rep_fk_by_order', { reason: String(report.foreignKeysOff.reason || '') }));
        }
        return L.join('\n');
    }


    /**
     * Восстановление ОДНОЙ организации (ТЗ §6.6).
     *
     * Порядок: анализ (он же повторяется внутри ядра и его вердикт обязателен) →
     * обязательная safety-выгрузка этой организации → одна транзакция замещения →
     * файловый аудит. Подтверждения вводом наименования здесь НЕТ: владелец снял этот
     * шаг вместе с подтверждением по имени базы.
     */
    async function runOrganization(params, ctx, src, encrypted, privateKeyPem) {
        const organizationId = String((params && params.organizationId) || '').trim();
        if (!organizationId) return { error: await tForSession('restore_err_org_required', ctx.sessionID) };

        const name = await orgName(organizationId, ctx);

        // Проверки ДО safety-выгрузки: они читающие и дешёвые, а восстановление,
        // которое всё равно запрещено, не должно тратить копию и время.
        const pre = await backup.restore.analyze({
            sequelize: sequelize(), models: mergedModels(),
            filePath: src.filePath, privateKeyPem, organizationId
        }).catch(e => ({ __error: e }));
        if (pre.__error) {
            const e = pre.__error;
            log.error(`[restore] Предпроверка ${src.fileName}: ${e.stack || e.message}`);
            return { error: await tfForSession(e.errorKey || 'restore_err_analyze', ctx.sessionID,
                Object.assign({ message: e.message }, e.vars || {})) };
        }
        if (!pre.ok) {
            return {
                error: await tForSession('restore_err_blocked', ctx.sessionID),
                reportText: await formatOrgReport(pre, ctx.sessionID)
            };
        }

        // Safety-выгрузка этой организации — обязательна, идёт тем же заданием, что и
        // любая другая выгрузка. Её результата дожидаемся: копия это предусловие
        // операции, а не фон.
        const settings = backup.settings.read();
        if (!settings.publicKeyPem) return { error: await tForSession('backup_err_key_empty', ctx.sessionID) };
        const tasks = await dbGateway.execute({
            operation: 'read', table: 'scheduler_tasks',
            where: { handler: 'backup.create' }, options: { raw: true },
            context: { sessionID: ctx.sessionID }
        });
        const task = tasks && tasks[0];
        if (!task) return { error: await tForSession('restore_err_no_backup_task', ctx.sessionID) };

        const scheduler = require('../../../drive_root/scheduler');
        const started = await scheduler.runNow(task.UID, { scope: 'organization', scopeOrganizationId: organizationId });
        if (!started.ok) return { error: await tForSession(started.errorKey || 'sched_err_dispatch_failed', ctx.sessionID) };
        const safety = await scheduler.waitForRun(started.runId, { timeoutMs: 30 * 60 * 1000 });
        if (!safety.ok) {
            return { error: await tfForSession('restore_err_safety_failed', ctx.sessionID, {
                status: String(safety.status || ''), message: String((safety.run && safety.run.errorText) || '')
            }) };
        }
        backup.restore.audit(`RESTORE_SAFETY org=${organizationId} run=${started.runId} user=${ctx.user && ctx.user.UID}`);

        // Файл-источник помечается занятым: safety-выгрузка запускает прореживание,
        // а оно способно удалить как раз его. Загруженный с диска ретеншну не подвержен.
        const release = src.temporary
            ? () => {}
            : backup.markInUse(backup.settings.storagePath(), src.fileName);

        let res;
        try {
            res = await backup.restore.restoreOrganization({
                sequelize: sequelize(), models: mergedModels(),
                filePath: src.filePath, privateKeyPem, organizationId,
                keepSessionId: ctx.sessionID
            });
        } catch (e) {
            log.error(`[restore] Организация ${organizationId}: ${e.stack || e.message}`);
            backup.restore.audit(`RESTORE_FAILED org=${organizationId} file=${src.fileName} error=${e.message}`);
            return {
                error: await tfForSession(e.errorKey === 'restore_err_blocked' ? 'restore_err_blocked' : 'restore_err_failed',
                    ctx.sessionID, { message: e.message }),
                reportText: e.report ? await formatOrgReport(e.report, ctx.sessionID) : undefined
            };
        } finally {
            release();
            if (src.temporary) { try { fs.unlinkSync(src.filePath); } catch (e) {} }
        }

        backup.restore.audit(
            `RESTORE_ORG org=${organizationId} name="${name}" file=${src.fileName} `
            + `user=${ctx.user && ctx.user.UID} deleted=${res.report.totalDelete} inserted=${res.report.totalInsert} `
            + `sessionsReset=${res.sessionsReset} ms=${res.durationMs}`
        );

        // Открытые списки других окон обязаны перечитаться: мы писали мимо applyChanges.
        try {
            const uniForm = require('../../uniForm/server.js');
            for (const table of Object.keys(res.stats.inserted)) uniForm.notifyTableChange(table, 'update', null);
        } catch (e) { /* оповещение не важнее результата */ }

        return {
            ok: true,
            scope: 'organization',
            message: await tfForSession('restore_done_msg', ctx.sessionID, {
                name, del: String(res.report.totalDelete), ins: String(res.report.totalInsert),
                sessions: String(res.sessionsReset)
            })
        };
    }

    /** Наименование организации — для сообщений. */
    async function orgName(organizationId, ctx) {
        if (!organizationId) return '';
        const rows = await dbGateway.execute({
            operation: 'read', table: 'organizations',
            where: { UID: organizationId }, options: { raw: true },
            context: { sessionID: ctx.sessionID }
        });
        return (rows && rows[0] && rows[0].name) || '';
    }

    /** Имя базы, КУДА развернётся копия — показывается в отчёте перед запуском. */
    function databaseName() {
        const s = sequelize();
        return (s.config && s.config.database) || '';
    }

    return {

        /** Открытие формы: состояние инсталляции до всякого выбора файла. */
        async onLoadData(params, ctx) {
            const p = (params && params.params) || {};
            let shadow = { ok: false, mode: 'unknown', reason: '' };
            try { shadow = await backup.dialect.canCreateShadowSpace(sequelize()); } catch (e) { shadow.reason = e.message; }

            return {
                data: {
                    fileUID: p.fileUID || '',
                    uploadName: '',
                    fileInfo: await tForSession('restore_full_hint_pick_file', ctx.sessionID),
                    modeInfo: shadow.ok
                        ? await tForSession('restore_full_mode_shadow', ctx.sessionID)
                        : await tfForSession('restore_full_mode_destructive', ctx.sessionID, { reason: shadow.reason || '' }),
                    passwordState: recovery.isSet()
                        ? await tForSession('restore_full_pwd_set', ctx.sessionID)
                        : await tForSession('restore_full_pwd_unset', ctx.sessionID),
                    recoveryPassword: '',
                    privateKeyPem: '',
                    restoreScope: 'full',
                    organizationId: '',
                    reportText: await tForSession('restore_full_hint_inspect_first', ctx.sessionID),
                    runState: await tForSession('restore_full_not_ready', ctx.sessionID)
                        + ' ' + await tForSession('restore_full_need_inspect', ctx.sessionID)
                        + '; ' + await tForSession('restore_full_need_key', ctx.sessionID)
                        + '; ' + await tForSession('restore_full_need_password', ctx.sessionID)
                },
                caption: await tForSession('restore_full_app_caption', ctx.sessionID)
            };
        },

        /**
         * Прочитать заголовок выбранной копии — БЕЗ приватного ключа.
         *
         * Всё, что нужно знать до точки невозврата: версия структуры, дата, область,
         * СУБД-источник и режим, в котором будет работать восстановление.
         */
        async inspectFile(params, ctx) {
            const src = await resolveSource(params, ctx);
            if (!src) return { error: await tForSession('restore_err_file_missing', ctx.sessionID) };

            let info;
            try {
                info = await backup.restoreFull.inspect(sequelize(), src.filePath);
            } catch (e) {
                return { error: await tfForSession('restore_err_header', ctx.sessionID, { message: e.message }) };
            }

            const L = [];
            const t = (k, v) => v ? tfForSession(k, ctx.sessionID, v) : tForSession(k, ctx.sessionID);
            L.push(await t('restore_full_rep_file', { name: src.fileName }));
            L.push(await t('restore_full_rep_created', { value: String(info.header.createdAt || '').replace('T', ' ').slice(0, 19) }));
            L.push(await t('restore_full_rep_db', { value: String(info.header.dbName || '') }));
            L.push(await t('restore_full_rep_scope', { value: info.scopeType }));
            L.push(await t('restore_full_rep_dialect', { from: info.sourceDialect || '?', to: info.targetDialect }));
            L.push(await t('restore_full_rep_version', { value: String(info.dbVersion || 0) }));
            L.push(await t('restore_full_rep_confighash', { value: String(info.configHash || '').slice(0, 26) }));
            L.push(info.actualHash
                ? await t('restore_full_rep_actualhash', { value: String(info.actualHash).slice(0, 26) })
                : await t('restore_full_rep_no_actualhash'));
            L.push('');
            L.push(info.encrypted
                ? await t('restore_full_rep_encrypted')
                : await t('restore_full_rep_plain'));
            L.push('');
            L.push(info.shadowAvailable
                ? await t('restore_full_mode_shadow')
                : await t('restore_full_mode_destructive', { reason: info.shadowReason || '' }));
            L.push('');
            L.push(await t('restore_full_rep_target_db', { name: databaseName() }));

            const wantScope = String((params && params.restoreScope) || 'full');
            const organizationId = String((params && params.organizationId) || '').trim();
            const blockers = [];

            // ── Область «вся база» ───────────────────────────────────────────────
            if (wantScope !== 'organization') {
                // Развернуть ВСЮ базу из копии ОДНОЙ организации нельзя: в ней нет ни
                // чужих организаций, ни личных и системных таблиц.
                if (info.scopeType !== 'full') blockers.push('scope');
                L.push('');
                L.push(await t('restore_full_rep_target_db', { name: databaseName() }));
                return {
                    ok: blockers.length === 0, blockers, mode: info.mode,
                    scopeType: info.scopeType, encrypted: info.encrypted, restoreScope: 'full',
                    reportText: L.join('\n')
                        + (blockers.includes('scope') ? '\n\n' + await t('restore_err_scope_not_full') : '')
                };
            }

            // ── Область «одна организация» ───────────────────────────────────────
            // Здесь анализ настоящий, а не чтение заголовка: сверка структуры, сверка
            // ссылок на глобальные справочники и dry-run по строкам. Он требует ключа,
            // если копия зашифрована, — поэтому раньше него дальше не идём.
            if (!organizationId) {
                return {
                    ok: false, blockers: ['organization'], mode: info.mode,
                    encrypted: info.encrypted, restoreScope: 'organization',
                    reportText: L.join('\n') + '\n\n' + await t('restore_err_org_required')
                };
            }
            const privateKeyPem = String((params && params.privateKeyPem) || '').trim();
            if (info.encrypted) {
                const kc = backup.keys.validatePrivateKey(privateKeyPem);
                if (!kc.ok) {
                    return {
                        ok: false, blockers: ['key'], mode: info.mode,
                        encrypted: true, restoreScope: 'organization',
                        reportText: L.join('\n'),
                        error: await tfForSession(kc.errorKey, ctx.sessionID, kc.vars || {})
                    };
                }
            }

            let report;
            try {
                report = await backup.restore.analyze({
                    sequelize: sequelize(), models: mergedModels(),
                    filePath: src.filePath, privateKeyPem, organizationId
                });
            } catch (e) {
                log.error(`[restore] Анализ ${src.fileName}: ${e.stack || e.message}`);
                return {
                    ok: false, restoreScope: 'organization', encrypted: info.encrypted,
                    error: await tfForSession(e.errorKey || 'restore_err_analyze', ctx.sessionID,
                        Object.assign({ message: e.message }, e.vars || {}))
                };
            }

            L.push('');
            L.push(await formatOrgReport(report, ctx.sessionID));
            return {
                ok: report.ok, blockers: report.blockers, mode: info.mode,
                scopeType: info.scopeType, encrypted: info.encrypted, restoreScope: 'organization',
                reportText: L.join('\n')
            };
        },

        /**
         * Проверить выбранный файл приватного ключа — сразу при выборе.
         *
         * Отвечает на два вопроса: это вообще приватный RSA-ключ (а не публичный,
         * который лежит на виду в форме настроек копирования) и от той ли он пары,
         * которой зашифрована выбранная копия. Оба ответа стоят миллисекунды, а без них
         * администратор узнавал бы правду только после запуска процедуры — заплатив
         * резервной копией и заходом в режим обслуживания.
         */
        async checkPrivateKey(params, ctx) {
            const check = backup.keys.validatePrivateKey(String((params && params.privateKeyPem) || ''));
            if (!check.ok) {
                return { error: await tfForSession(check.errorKey, ctx.sessionID, check.vars || {}) };
            }

            const src = await resolveSource(params, ctx);
            if (src) {
                try {
                    const header = backup.restore.readHeader(src.filePath);
                    if (header.keyFingerprint && header.keyFingerprint !== check.fingerprint) {
                        return {
                            error: await tfForSession('restore_err_key_other_pair', ctx.sessionID, {
                                expected: String(header.keyFingerprint).slice(0, 26),
                                actual: String(check.fingerprint).slice(0, 26)
                            })
                        };
                    }
                    return { ok: true, message: await tForSession('restore_key_matches_copy', ctx.sessionID) };
                } catch (e) { /* нечитаемый заголовок поймает сама процедура */ }
            }
            // Копия ещё не выбрана — сказать можно только то, что ключ читается.
            return { ok: true, message: await tForSession('restore_key_ok_no_copy', ctx.sessionID) };
        },

        /**
         * Проверить аварийный пароль (§6.2б, действие 1).
         *
         * Ничего не меняет — администратор просто убеждается, что не заблокирует себя.
         */
        async verifyRecoveryPassword(params, ctx) {
            if (!recovery.isSet()) {
                return { ok: false, error: await tForSession('restore_full_pwd_unset', ctx.sessionID) };
            }
            const ok = await recovery.verify((params && params.recoveryPassword) || '');
            maintenance.audit(`RECOVERY_PWD_VERIFY ${ok ? 'OK' : 'FAIL'} user=${ctx.user && ctx.user.UID}`);
            return ok
                ? { ok: true, message: await tForSession('restore_full_pwd_verified', ctx.sessionID) }
                : { ok: false, error: await tForSession('maint_err_bad_password', ctx.sessionID) };
        },

        /**
         * Сгенерировать новый аварийный пароль и показать его ОДИН РАЗ (§6.2б, действие 2).
         *
         * Хэш необратим: повторно узнать пароль невозможно, доступна только новая
         * генерация. Если запись `dbSettings.json` не удалась — восстановление не
         * начинается вовсе, поэтому отказ отдаётся честно, а не проглатывается.
         */
        async generateRecoveryPassword(params, ctx) {
            try {
                const plain = await recovery.generate();
                maintenance.audit(`RECOVERY_PWD_GENERATED user=${ctx.user && ctx.user.UID}`);
                log.info('[restoreFull] Сгенерирован новый аварийный пароль (значение не журналируется)');
                return { ok: true, password: plain, message: await tForSession('restore_full_pwd_generated', ctx.sessionID) };
            } catch (e) {
                log.error(`[restoreFull] Аварийный пароль не сохранён: ${e.message}`);
                return { ok: false, error: await tfForSession('restore_full_pwd_write_failed', ctx.sessionID, { message: e.message }) };
            }
        },

        /**
         * ЗАПУСК ПОЛНОГО ВОССТАНОВЛЕНИЯ.
         *
         * Все проверки повторяются здесь и обязательны: между показом экрана и нажатием
         * кнопки состояние могло измениться, а решение по устаревшему экрану было бы
         * решением вслепую.
         */
        async runFullRestore(params, ctx) {
            const privateKeyPem = String((params && params.privateKeyPem) || '').trim();
            const passwordReady = !!(params && params.passwordReady);

            const src0 = await resolveSource(params, ctx);
            if (!src0) return { error: await tForSession('restore_err_file_missing', ctx.sessionID) };

            // Незашифрованная копия (из домашнего архива) ключа не требует ВООБЩЕ.
            // Требовать его здесь значило бы сделать невозможным ровно тот сценарий,
            // ради которого режим и заведён.
            let encrypted = true;
            try { encrypted = backup.restore.readContainerInfo(src0.filePath).encrypted; } catch (e) { /* поймает процедура */ }

            let keyCheck = { ok: true, fingerprint: '' };
            if (encrypted) {
                // Ключ проверяется ПЕРВЫМ и до всего остального: опечатка не должна
                // стоить safety-выгрузки и простоя сервера. Самый частый случай — сюда
                // подсунули ПУБЛИЧНЫЙ ключ; об этом надо сказать прямо, а не «ключ от
                // другой пары».
                keyCheck = backup.keys.validatePrivateKey(privateKeyPem);
                if (!keyCheck.ok) {
                    return { error: await tfForSession(keyCheck.errorKey, ctx.sessionID, keyCheck.vars || {}) };
                }
            }

            // Подтверждения вводом имени базы здесь НЕТ: владелец снял этот шаг
            // осознанно (ТЗ §6.5 требовал двухшагового подтверждения). Последним
            // предупреждением остаётся диалог в форме, а невосполнимость операции
            // страхует safety-выгрузка и мгновенный откат переименованием схемы.

            // ── Область «одна организация»: другой механизм, другие гарантии ─────
            //
            // Пользователю это одна кнопка, но внутри процедуры разные: полное
            // восстановление уводит сервер в обслуживание и подменяет схему целиком,
            // а организация замещается ОДНОЙ транзакцией в живой базе — соседи
            // продолжают работать и ничего не замечают.
            if (String((params && params.restoreScope) || 'full') === 'organization') {
                return await runOrganization(params, ctx, src0, encrypted, privateKeyPem);
            }

            // Шаг с паролем нужен ТОЛЬКО полному восстановлению: после переключения
            // обычный вход невозможен, вместе со старой схемой уходит таблица сессий.
            // Организация этого шага не требует — сервер продолжает работать.
            if (!passwordReady || !recovery.isSet()) {
                return { error: await tForSession('restore_full_err_password_step', ctx.sessionID) };
            }

            const src = src0;

            // Отпечаток пары — в открытом заголовке копии. Сверяем его с отпечатком
            // ПУБЛИЧНОЙ части введённого приватного ключа: «ключ не от этой копии»
            // выясняется здесь, а не после расшифровки на середине операции. Ключей на
            // инсталляции со временем оказывается несколько — это штатная ситуация.
            try {
                const header = backup.restore.readHeader(src.filePath);
                if (header.keyFingerprint && keyCheck.fingerprint && header.keyFingerprint !== keyCheck.fingerprint) {
                    return {
                        error: await tfForSession('restore_err_key_other_pair', ctx.sessionID, {
                            expected: String(header.keyFingerprint).slice(0, 26),
                            actual: String(keyCheck.fingerprint).slice(0, 26)
                        })
                    };
                }
            } catch (e) { /* нечитаемый заголовок поймает сама процедура */ }

            if (maintenance.isActive()) {
                return { error: await tForSession('restore_full_err_already_maintenance', ctx.sessionID) };
            }

            // Файл-источник помечается занятым НА ВСЮ операцию: safety-выгрузка создаёт
            // новую копию и запускает прореживание, а оно способно удалить как раз этот
            // файл. Загруженный с диска лежит в отдельном каталоге и ретеншну не
            // подвержен — помечать нечего.
            const release = src.temporary
                ? () => {}
                : backup.markInUse(backup.settings.storagePath(), src.fileName);

            let res;
            try {
                res = await backup.restoreFullRunner.execute({
                    filePath: src.filePath,
                    privateKeyPem,
                    sessionID: ctx.sessionID,
                    userId: ctx.user && ctx.user.UID
                });
            } catch (e) {
                log.error(`[restoreFull] ${e.stack || e.message}`);
                return { error: await tfForSession('restore_full_err_failed', ctx.sessionID, { message: e.message }) };
            } finally {
                release();
                // Временный файл удаляется в любом исходе: он содержит персональные
                // данные всех клиентов и не должен оставаться в каталоге.
                if (src.temporary) { try { fs.unlinkSync(src.filePath); } catch (e) {} }
            }

            if (!res.ok) {
                // СВОЙ ключ отказа, а не общий с восстановлением организации: тот
                // обещает «данные организации не изменены», что для полного
                // восстановления бессмысленно и вводит в заблуждение.
                //
                // И он РАЗНЫЙ по обе стороны переключения. До переключения живая база
                // не тронута по построению, и сказать об этом — половина ответа на
                // вопрос «что теперь делать». После переключения состояние иное, и
                // отсылать туда же было бы враньём.
                const key = res.errorKey || (res.switched ? 'restore_full_err_failed_switched' : 'restore_full_err_failed');
                return {
                    error: await tfForSession(key, ctx.sessionID, Object.assign({ message: res.message || '' }, res.vars || {})),
                    maintenance: !!res.maintenance,
                    switched: !!res.switched
                };
            }

            return {
                ok: true,
                message: await tfForSession('restore_full_done_msg', ctx.sessionID, {
                    rows: String(res.totalRows || 0),
                    tables: String(res.tables || 0),
                    rollback: res.rollbackSchema || '—',
                    sec: String(Math.round((res.durationMs || 0) / 1000))
                })
            };
        }
    };
};
