'use strict';

/**
 * Тип регламентной задачи «Резервная копия базы».
 *
 * ЕДИНСТВЕННАЯ точка запуска выгрузки в системе: и расписание, и кнопка «Создать
 * сейчас» приходят сюда через `engine.dispatch`. Отдельной ветки для ручного бэкапа
 * не существует — иначе у механизма появилось бы два исполнения, которые однажды
 * разойдутся (ТЗ, решение 0.0.1).
 *
 * Файл грузят ДВА процесса — главный (форма показывает тип задачи и схему параметров)
 * и воркер (исполняет), — поэтому он обязан быть чистым модулем-фабрикой без побочных
 * эффектов. См. drive_root/scheduler/registry.js.
 */

const dbGateway = require('../../drive_root/dbGateway');
const log = require('../../drive_root/log');

const TABLE = 'backup_files';

module.exports = function (modelsDB, Utilities) {
    return {

        'backup.create': {
            caption: { i18n: 'backup_handler_create' },
            icon: '/apps/general_icons/resources/public/16x16/backup.png',
            // Только admin и без организации: копия снимается со всей инсталляции,
            // а не от имени одного арендатора.
            scope: 'system',
            paramsSchema: {
                // Осмысленны только при ручном запуске; расписание всегда делает
                // полную копию (ТЗ §3.7).
                scope: { type: 'string', required: false, default: 'full' },
                scopeOrganizationId: { type: 'string', required: false, default: '' }
            },
            run: async (ctx) => {
                const globalCtx = require('../../drive_root/globalServerContext');
                const sequelize = require('../../drive_root/db/sequelize_instance');
                const backup = require('../../drive_root/backup');

                // `scope: 'system'` в объявлении — это про то, кому позволено СОЗДАТЬ
                // задание, и проверяется формой. Здесь проверяем ещё раз, на исполнении:
                // задание с владельцем-не-админом создаёт копии, но не может ни увидеть,
                // ни прореживать их (системная таблица ему невидима по RLS), то есть
                // тихо копит файлы навсегда. Такое лучше остановить с внятным текстом.
                const formsCtx = require('../../drive_forms/globalServerContext');
                const ownerRole = ctx.userId ? await formsCtx.getUserAccessRole({ UID: ctx.userId }) : null;
                if (ownerRole !== 'admin') {
                    throw new Error(`Владелец задания резервного копирования должен иметь роль admin (сейчас: ${ownerRole || 'не определена'})`);
                }

                const scopeType = String(ctx.params.scope || 'full');
                const scopeOrgId = String(ctx.params.scopeOrganizationId || '').trim();
                if (scopeType === 'organization' && !scopeOrgId) {
                    throw new Error('Для выгрузки по организации не указана организация');
                }

                // Данные читаем через сессию задачи — RLS применяется тем же кодом,
                // что и к живому пользователю. Владелец задачи admin, поэтому
                // организация видна; подменять контекст не нужно.
                const call = (operation, params) => dbGateway.execute(
                    Object.assign({ operation, table: TABLE, context: { sessionID: ctx.sessionID } }, params));

                let scopeOrgName = '';
                if (scopeType === 'organization') {
                    const orgs = await dbGateway.execute({
                        operation: 'read', table: 'organizations',
                        where: { UID: scopeOrgId }, options: { raw: true },
                        context: { sessionID: ctx.sessionID }
                    });
                    if (!orgs || !orgs.length) throw new Error(`Организация ${scopeOrgId} не найдена или недоступна`);
                    scopeOrgName = orgs[0].name || '';
                }

                // Оценка места опирается на размер предыдущей копии (§3.0).
                const existing = (await call('read', { where: {}, options: { raw: true } })) || [];
                const alive = existing.filter(f => !f.missing);
                const previousSize = alive.reduce((mx, f) => Math.max(mx, Number(f.sizeBytes) || 0), 0);

                const { models } = globalCtx.collectMergedModelDefs();
                const result = await backup.createBackup({
                    sequelize, models,
                    scope: scopeType === 'organization'
                        ? { type: 'organization', organizationId: scopeOrgId, organizationName: scopeOrgName }
                        : { type: 'full' },
                    meta: {
                        appVersion: process.env.npm_package_version || '',
                        frameworkVersion: (function () { try { return require('../../package.json').version; } catch (e) { return ''; } })(),
                        dbVersion: null
                    },
                    previousSize,
                    onProgress: (text) => { try { ctx.log(text); } catch (e) {} }
                });
                ctx.heartbeat();

                const triggeredBy = String(ctx.triggeredBy || 'schedule') === 'manual' ? 'manual' : 'schedule';
                await call('create', {
                    data: {
                        organizationId: null,          // системная таблица: строка не принадлежит организации
                        fileName: result.fileName,
                        sizeBytes: result.size,
                        sha256: result.sha256,
                        keyFingerprint: result.keyFingerprint,
                        configHash: result.configHash,
                        dbVersion: 0,
                        triggeredBy,
                        scopeType,
                        scopeOrganizationId: scopeType === 'organization' ? scopeOrgId : null,
                        scopeOrganizationName: scopeType === 'organization' ? scopeOrgName : null,
                        rowsTotal: result.totalRows,
                        verifyStatus: 'none',
                        acked: false,
                        missing: false,
                        tablesText: JSON.stringify(result.tables)
                    }
                });

                // Прореживание — ТОЛЬКО после того, как новая копия создана: удалить
                // старое раньше значит на время операции остаться без копий вовсе.
                const settings = backup.settings.read();
                const storageDir = backup.settings.storagePath(settings);
                const fresh = (await call('read', { where: {}, options: { raw: true } })) || [];
                const doomed = backup.selectForPruning(fresh.filter(f => !f.missing), settings);
                let pruned = 0;
                for (const f of doomed) {
                    try {
                        backup.deleteFile(storageDir, f.fileName);
                        await call('delete', { where: { UID: f.UID } });
                        pruned++;
                    } catch (e) {
                        log.error(`[backup] Не удалось удалить копию ${f.fileName}: ${e.message}`);
                    }
                }

                try {
                    require('../uniForm/server.js').notifyTableChange(TABLE, 'create', null);
                } catch (e) { /* оповещение необязательно */ }

                const warn = [];
                if (result.unknownObjects.length) warn.push(`объекты вне моделей: ${result.unknownObjects.join(', ')}`);
                for (const w of result.warnings) warn.push(`${w.table} без реквизита доступа и вне excluded_tables`);

                const scopeText = scopeType === 'organization' ? `организация «${scopeOrgName}»` : 'вся база';
                return {
                    resultText: `${result.fileName}: ${result.totalRows} строк, ${Math.round(result.size / 1024)} КБ (${scopeText})`
                        + (pruned ? `; удалено устаревших копий: ${pruned}` : '')
                        + (warn.length ? `; ВНИМАНИЕ: ${warn.join('; ')}` : '')
                };
            }
        }
    };
};
