'use strict';

/**
 * dbVersions — журнал версий структуры базы (ТЗ §6.4).
 *
 * Зачем он вообще нужен, если есть миграция. Структуру миграция починит, а смену
 * СМЫСЛА поля — нет. Пример из истории этого проекта: `name` стал представлением, а
 * номер уехал в `number`. Дамп двухлетней давности после структурной миграции будет
 * валиден по форме и неверен по содержанию. Поэтому версия структуры — явная запись,
 * и вводить её надо было сразу: задним числом она не появляется.
 *
 * Три правила, без которых механизм врёт (все из ТЗ, все существенны):
 *
 *  1. Каноническая сериализация обязательна — иначе хэш пляшет от порядка обхода
 *     приложений и после каждого рестарта появляется «новая версия» на ровном месте
 *     (реализация — `db/modelsHash.js`, одна на всех потребителей).
 *  2. Хэша ДВА. `configHash` говорит, что фреймворк собирался построить, `actualHash` —
 *     что в базе есть. Их расхождение означает, что миграция упала посередине либо
 *     схему правили руками; одним хэшем это не обнаружить.
 *  3. Порядковый `number` ЛОКАЛЕН для инсталляции, и вешать на него сервисные скрипты
 *     нельзя: одна установка проходила версии подряд, другая развернулась из старого
 *     бэкапа и прыгнула через несколько — причём промежуточных версий в ней не
 *     существовало вовсе. Глобальная для продукта идентичность — `configHash`.
 *
 * Запись идёт СВОИМ экземпляром Sequelize вызывающего (миграция работает мимо
 * `dbGateway` и мимо рантайм-моделей), поэтому `number`, `date` и представление `name`
 * проставляются здесь ЯВНО: хуки автонумерации и представления живут в middleware
 * `dbGateway` и на прямой INSERT не срабатывают.
 */

const { QueryTypes } = require('sequelize');
const log = require('../log');
const { modelsSnapshot, actualSchemaHash } = require('./modelsHash');

const TABLE = 'db_versions';

function quoter(sequelize) {
    const qi = sequelize.getQueryInterface();
    return qi.quoteIdentifier
        ? (s) => qi.quoteIdentifier(s)
        : (s) => `"${String(s).replace(/"/g, '""')}"`;
}

/**
 * Последняя запись журнала. `null`, если таблицы нет или она пуста.
 *
 * Порядок — по дате создания, а не по `number`: реквизит номера строковый
 * (системная автонумерация даёт `00001`), и сортировка строк на несогласованной
 * ширине дала бы «10 < 2». Дата от такой ошибки свободна.
 */
async function latest(sequelize, opts = {}) {
    const q = quoter(sequelize);
    try {
        const rows = await sequelize.query(
            `SELECT * FROM ${q(TABLE)} ORDER BY ${q('createdAt')} DESC, ${q('number')} DESC LIMIT 1`,
            { type: QueryTypes.SELECT, transaction: opts.transaction }
        );
        return (rows && rows[0]) || null;
    } catch (e) {
        // Таблицы может не быть: первый старт, либо мы смотрим в теневую схему,
        // где `db_versions` появится только вместе с данными.
        return null;
    }
}

/**
 * Посчитать обе характеристики структуры, ничего не записывая.
 *
 * @param {Object} sequelize
 * @param {Array<Object>} models — СЛИТЫЕ определения
 * @param {Object} [opts] — `{ schema, transaction }`
 * @returns {Promise<{configHash, actualHash, dialect, snapshot, actualSnapshot, missing}>}
 */
async function describe(sequelize, models, opts = {}) {
    const { snapshot, configHash } = modelsSnapshot(models);
    const tables = (models || []).map(m => m.tableName).filter(Boolean);
    const actual = await actualSchemaHash(sequelize, tables, opts);
    return {
        configHash,
        actualHash: actual.actualHash,
        dialect: actual.dialect,
        snapshot,
        actualSnapshot: actual.snapshot,
        missing: actual.missing
    };
}

/**
 * Записать версию структуры, ЕСЛИ она изменилась.
 *
 * «Изменилась» — это расхождение ЛЮБОГО из двух хэшей с последней записью. Повторный
 * запуск сервера без правки моделей новой записи не создаёт (приёмка §9 п. 13) —
 * именно ради этого нужна каноническая сериализация.
 *
 * @param {Object} sequelize
 * @param {Array<Object>} models — СЛИТЫЕ определения
 * @param {Object} [opts] — `{ appVersion, frameworkVersion, origin, transaction }`
 * @returns {Promise<{created: boolean, version: Object|null, configHash, actualHash}>}
 */
async function record(sequelize, models, opts = {}) {
    const info = await describe(sequelize, models, { transaction: opts.transaction });
    const prev = await latest(sequelize, { transaction: opts.transaction });

    if (prev && prev.configHash === info.configHash && prev.actualHash === info.actualHash) {
        return { created: false, version: prev, configHash: info.configHash, actualHash: info.actualHash };
    }

    if (prev && prev.configHash === info.configHash && prev.actualHash !== info.actualHash) {
        // Тот же набор моделей, но база выглядит иначе. Это либо недоделанная
        // миграция, либо правка схемы руками — и то и другое должно быть заметно.
        log.warn(`[dbVersions] Фактическая структура разошлась с конфигурацией при том же configHash `
            + `(было ${String(prev.actualHash).slice(0, 22)}…, стало ${String(info.actualHash).slice(0, 22)}…)`);
    }

    const q = quoter(sequelize);
    // Ширина номера — та же, что у системной автонумерации (`default.autoNumber`,
    // length 5). Прямой INSERT идёт мимо неё, поэтому формат держим руками.
    const seq = (Number(prev && prev.number) || 0) + 1;
    const number = String(seq).padStart(5, '0');
    const now = new Date();
    const uid = require('./utilites').generateUID('DbVersions');

    const data = {
        UID: uid,
        number,
        date: now,
        // Представление: номер + короткий хэш. Билдер представления зарегистрировать
        // негде — миграция идёт мимо `dbGateway`, где он вызывается.
        name: `${number} · ${String(info.configHash).replace(/^sha256:/, '').slice(0, 12)}`,
        organizationId: '',                       // системная таблица: организации не принадлежит
        configHash: info.configHash,
        actualHash: info.actualHash,
        dialect: info.dialect,
        appVersion: String(opts.appVersion || ''),
        frameworkVersion: String(opts.frameworkVersion || ''),
        origin: String(opts.origin || 'migration'),
        modelsSnapshot: JSON.stringify(info.snapshot),
        createdAt: now,
        updatedAt: now
    };

    const cols = Object.keys(data);
    const bind = {};
    const holders = cols.map((c, i) => { bind[`v${i}`] = data[c]; return `:v${i}`; });
    await sequelize.query(
        `INSERT INTO ${q(TABLE)} (${cols.map(q).join(', ')}) VALUES (${holders.join(', ')})`,
        { replacements: bind, transaction: opts.transaction }
    );

    log.info(`[dbVersions] Версия структуры #${number}: config=${String(info.configHash).slice(7, 19)} actual=${String(info.actualHash).slice(7, 19)}`);
    return { created: true, version: data, configHash: info.configHash, actualHash: info.actualHash };
}

module.exports = { record, latest, describe, TABLE };
