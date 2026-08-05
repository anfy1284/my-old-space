'use strict';

/**
 * serviceSession — служебные сессии для фоновой работы «от имени пользователя».
 *
 * Задача планировщика (рассылка, бэкап, перерасчёт) должна видеть ровно те данные,
 * что и её владелец. Соблазн — обойти RLS через `__SYS_INTERNAL__` и «доограничить»
 * вручную в прикладном коде; это новая точка обхода, которую потом никто не проверит.
 *
 * Правильный путь: создать НАСТОЯЩУЮ сессию (строка в `sessions`, `kind='service'`)
 * от имени владельца. Тогда RLS применяется тем же кодом, что и к живому пользователю:
 *   • владелец — `admin` → фильтры минуются штатно (это и есть «системная задача»);
 *   • владелец — `user`  → накладываются его обычные фильтры.
 *
 * Два обязательных условия механизма:
 *   1) служебная сессия НЕ работает как логин — гейт на HTTP-уровне
 *      (`globalServerContext.getSessionIdFromRequest`), но НЕ внутри
 *      `getUserBySessionID` (её зовёт dbGateway, там резолв обязан работать);
 *   2) сужение по организации — `scopeOrganizationId`, AND-условие поверх обычных
 *      фильтров, применяется и к `admin` (проектный `dbGateway.js`).
 *
 * Жизненный цикл ведёт ГЛАВНЫЙ процесс: создал → отдал воркеру только строку
 * sessionID → удалил при любом исходе. Висяки после падения процесса подметает
 * `sweepExpired()` при старте.
 */

const crypto = require('crypto');
const dbGateway = require('./dbGateway');
const globalCtx = require('./globalServerContext');
const log = require('./log');

const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';
const SESSIONS_TABLE = 'sessions';

/**
 * Криптослучайный идентификатор служебной сессии. Префикс `svc_` — только для
 * читаемости логов: гейт проверяет поле `kind` в БД, а не префикс.
 */
function generateServiceSessionId() {
    return 'svc_' + crypto.randomBytes(32).toString('hex');
}

/**
 * Создать служебную сессию.
 *
 * @param {Object} opts
 * @param {string} opts.userId — владелец (от его имени исполняется работа)
 * @param {string} [opts.scopeOrganizationId] — сузить видимость до этой организации
 * @param {string} [opts.taskRunId] — запуск, породивший сессию (для аудита)
 * @param {number} [opts.ttlSec=3900] — через сколько сессия считается протухшей
 * @returns {Promise<string>} sessionID
 */
async function create({ userId, scopeOrganizationId = null, taskRunId = null, ttlSec = 3900 } = {}) {
    if (!userId) throw new Error('[serviceSession] userId is required');
    const sessionId = generateServiceSessionId();
    await dbGateway.execute({
        operation: 'create',
        table: SESSIONS_TABLE,
        data: {
            sessionId,
            userId,
            isGuest: false,
            kind: 'service',
            expiresAt: new Date(Date.now() + ttlSec * 1000),
            scopeOrganizationId: scopeOrganizationId || null,
            taskRunId: taskRunId || null
        },
        context: { sessionID: SYSTEM_SESSION_ID }
    });
    await globalCtx.invalidateSessionKind(sessionId);
    return sessionId;
}

/**
 * Удалить служебную сессию и сбросить её кэши. Звать в `finally` — при ошибке,
 * таймауте и убийстве воркера тоже.
 */
async function destroy(sessionId) {
    if (!sessionId) return;
    try {
        await dbGateway.execute({
            operation: 'delete',
            table: SESSIONS_TABLE,
            where: { sessionId },
            context: { sessionID: SYSTEM_SESSION_ID }
        });
    } catch (e) {
        log.error('[serviceSession] Не удалось удалить служебную сессию:', e && e.message || e);
    }
    // Кэши пользователя и метаданных сессии переживают удаление строки — сбрасываем оба.
    try { await globalCtx.invalidateSessionUser(sessionId); } catch (e) {}
    try { await globalCtx.invalidateSessionKind(sessionId); } catch (e) {}
}

/**
 * Подмести протухшие служебные сессии (остаются после падения процесса).
 * Звать при старте сервера — до запуска планировщика.
 * @returns {Promise<number>} сколько удалено
 */
async function sweepExpired() {
    const { Op } = require('sequelize');
    try {
        const stale = await dbGateway.execute({
            operation: 'read',
            table: SESSIONS_TABLE,
            where: { kind: 'service', expiresAt: { [Op.lt]: new Date() } },
            context: { sessionID: SYSTEM_SESSION_ID }
        });
        for (const row of stale || []) {
            await destroy(row.sessionId);
        }
        if (stale && stale.length) {
            log.info(`[serviceSession] Подметено протухших служебных сессий: ${stale.length}`);
        }
        return (stale || []).length;
    } catch (e) {
        log.error('[serviceSession] sweepExpired:', e && e.message || e);
        return 0;
    }
}

module.exports = { create, destroy, sweepExpired, generateServiceSessionId };
