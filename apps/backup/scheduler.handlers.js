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

                // Настройки читаются из базы В КЭШ, и кэш этот — свой у каждого
                // процесса. Задача выполняется в ВОРКЕРЕ, куда правки, сделанные
                // администратором в главном процессе, не доезжают: у него свой кэш,
                // наполненный при старте. Поэтому каждый прогон начинается с
                // перечитывания — иначе выгрузка шла бы по ключу и лимитам, которые
                // могли смениться неделю назад.
                await backup.settings.load();

                const scopeType = String(ctx.params.scope || 'full');
                const scopeOrgId = String(ctx.params.scopeOrganizationId || '').trim();
                if (scopeType === 'organization' && !scopeOrgId) {
                    throw new Error('Для выгрузки по организации не указана организация');
                }

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

                // Оценка места опирается на размер предыдущей копии (§3.0) — из
                // каталога: файлов, которых нет, там не бывает по построению, поэтому
                // прежний отсев `missing` не нужен.
                const previousSize = backup.catalog.list()
                    .reduce((mx, f) => Math.max(mx, Number(f.size) || 0), 0);

                const { models } = globalCtx.collectMergedModelDefs();

                // Версия структуры БД в заголовок копии (ТЗ §3.1 п. 1). `actualHash`
                // здесь принципиален: именно с ним при полном восстановлении сверяется
                // структура, воссозданная по снимку моделей из дампа. Без него сверить
                // «фреймворк построил ТО ЖЕ САМОЕ» нечем — `configHash` совпадёт всегда,
                // потому что считается по тому же снимку.
                const dbVersions = require('../../drive_root/db/dbVersions');
                let version = null;
                try { version = await dbVersions.latest(sequelize); } catch (e) { version = null; }

                const triggeredBy = String(ctx.triggeredBy || 'schedule') === 'manual' ? 'manual' : 'schedule';

                const result = await backup.createBackup({
                    sequelize, models,
                    // Повод и наименование едут в ЗАГОЛОВОК копии: строки журнала, где
                    // они лежали раньше, больше нет, а заголовок читается без ключа.
                    triggeredBy,
                    title: String(ctx.params.title || ''),
                    scope: scopeType === 'organization'
                        ? { type: 'organization', organizationId: scopeOrgId, organizationName: scopeOrgName }
                        : { type: 'full' },
                    meta: {
                        appVersion: process.env.npm_package_version || '',
                        frameworkVersion: (function () { try { return require('../../package.json').version; } catch (e) { return ''; } })(),
                        dbVersion: version ? Number(version.number) || 0 : 0,
                        actualHash: (version && version.actualHash) || ''
                    },
                    previousSize,
                    // Доля выполненного считается по таблицам плана: полоса прогресса
                    // должна показывать долю, а не «что-то происходит».
                    onProgress: (text, progress) => { try { ctx.log(text, progress); } catch (e) {} }
                });
                ctx.heartbeat();

                // Записи в журнал больше НЕ делается: журнала нет, источник истины —
                // каталог, и копия попадает в списки самим фактом своего существования.
                // Историю запусков (в том числе неудачных, которых в журнале копий не
                // бывало вовсе) ведёт `scheduler_runs`.

                // Прореживание — ТОЛЬКО после того, как новая копия создана: удалить
                // старое раньше значит на время операции остаться без копий вовсе.
                const settings = backup.settings.read();
                const doomed = backup.selectForPruning(backup.catalog.list(), settings);
                let pruned = 0;
                for (const f of doomed) {
                    try {
                        // Файл, из которого прямо сейчас идёт восстановление, пропускаем:
                        // метка `.inuse` ставится другим процессом, поэтому проверять её
                        // надо через каталог, а не через переменную.
                        if (f.inUse) continue;
                        if (backup.catalog.remove(f.fileName)) pruned++;
                    } catch (e) {
                        log.error(`[backup] Не удалось удалить копию ${f.fileName}: ${e.message}`);
                    }
                }

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
