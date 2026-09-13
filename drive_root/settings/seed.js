'use strict';

/**
 * seed — засев значений по умолчанию в строку дефолтов.
 *
 * Дефолт объявлен в файле приложения, но ХРАНИТСЯ строкой в базе: администратор его
 * правит («дефолт для новых записей»). Отсюда единственное правило засева:
 *
 *   ключа в строке нет  → записать значение из файла;
 *   ключ в строке есть  → НЕ ТРОГАТЬ НИКОГДА.
 *
 * Второе — не перестраховка. `defaultValues.json` пересевается при каждом старте, и
 * ровно поэтому значения настроек туда класть нельзя: перезапуск вернул бы заводское
 * значение поверх правки администратора (см. комментарий в `apps/systemSettings/lib`).
 * Здесь та же ловушка, поэтому засев только дополняет.
 *
 * Ключ, исчезнувший из объявлений, остаётся в строке сиротой: откат версии приложения
 * не должен терять значение. В лог идёт сводка.
 *
 * Вызывается из корневого `events_handler.onDatabasePostInit` — то есть в том процессе,
 * который выполняет миграцию, где моделей рантайма (`globalServerContext.modelsDB`)
 * может ещё не быть. Поэтому работает по переданному `sequelize`.
 *
 * @module drive_root/settings/seed
 */

const log = require('../log');
const registry = require('./registry');
const types = require('./types');

/**
 * @param {Object} sequelize — экземпляр с моделями (context.sequelize)
 * @param {string} [projectRoot]
 * @returns {Promise<{apps: number, added: number, orphans: number}>}
 */
async function seedDefaults(sequelize, projectRoot) {
    registry.ensureLoaded(projectRoot);

    const SettingsValues = sequelize && sequelize.models && sequelize.models.SettingsValues;
    if (!SettingsValues) {
        log.warn('[settings/seed] модель SettingsValues недоступна — засев пропущен');
        return { apps: 0, added: 0, orphans: 0 };
    }

    const table = registry.DEFAULT_SCOPE_TABLE;
    let apps = 0, added = 0, orphans = 0;

    for (const app of registry.getApps()) {
        const declared = registry.getSettings(app.name);
        if (!declared.length) continue;
        apps++;

        const row = await SettingsValues.findOne({
            where: { scopeTable: table, scopeId: table, appName: app.name, kind: registry.KIND_SETTING }
        });
        const current = types.parseData(row && row.data);
        const next = Object.assign({}, current);

        const newKeys = [];
        for (const decl of declared) {
            if (decl.key in next) continue;      // правку администратора не трогаем
            next[decl.key] = decl.default;
            newKeys.push(decl.key);
        }

        const declaredKeys = new Set(declared.map(d => d.key));
        const orphanKeys = Object.keys(next).filter(k => !declaredKeys.has(k));
        if (orphanKeys.length) {
            orphans += orphanKeys.length;
            log.warn(`[settings/seed] ${app.name}: значения без объявления (оставлены как есть): ${orphanKeys.join(', ')}`);
        }

        if (!newKeys.length) continue;
        added += newKeys.length;

        if (row) {
            await row.update({ data: next });
        } else {
            await SettingsValues.create({
                scopeTable: table, scopeId: table, appName: app.name,
                kind: registry.KIND_SETTING, data: next,
                userId: null, organizationId: null
            });
        }
        log.info(`[settings/seed] ${app.name}: добавлены значения по умолчанию — ${newKeys.join(', ')}`);
    }

    log.info(`[settings/seed] приложений: ${apps}, новых значений по умолчанию: ${added}, сирот: ${orphans}`);
    return { apps, added, orphans };
}

module.exports = { seedDefaults };
