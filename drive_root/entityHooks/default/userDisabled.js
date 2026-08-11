/**
 * default.userDisabled — отключение учётной записи разрывает её открытые сессии.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ОБРАБОТЧИК. Признак `users.disabled` проверяется в двух местах: на
 * форме входа (новые входы) и в `getUserBySessionID` (каждая операция с БД). Второго,
 * казалось бы, достаточно — но между ними лежит кэш сессии: запись пользователя
 * положена в него, когда он ещё был включён, и до истечения TTL продолжает отдаваться
 * со старым значением. То есть отключение сработало бы с задержкой, размер которой
 * администратор не знает и проверить не может. Для действия, которым отзывают доступ
 * уволенному сотруднику, это негодное свойство: «через сколько-то» здесь означает
 * «неизвестно когда».
 *
 * Поэтому в момент отключения сессии пользователя УДАЛЯЮТСЯ, а их кэш сбрасывается.
 * Дальше работает обычный путь: сессии нет — пользователь не опознан.
 *
 * Симметрично: включение обратно сессий не восстанавливает. Их и не должно —
 * человек просто входит заново.
 *
 * Объявляется в `entityConfig.hooks.beforeUpdate` модели `users`.
 */

'use strict';

module.exports = async function userDisabled(request) {
    if (request.operation !== 'update') return;

    const becameDisabled = request.data && request.data.disabled === true;
    if (!becameDisabled) return;

    // UID берётся из условия операции: форма правит запись по первичному ключу.
    const uid = (request.where && (request.where.UID || request.where.uid))
        || (request.data && request.data.UID);
    if (!uid) return;

    const dbGateway = require('../../dbGateway');
    const globalCtx = require('../../globalServerContext');
    const log = require('../../log');
    const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';

    // Служебная сессия механизма: это его собственная уборка в системной таблице,
    // выполняемая от имени системы, а не от имени правящего пользователя.
    const context = { sessionID: SYSTEM_SESSION_ID };

    try {
        const sessions = await dbGateway.execute({
            operation: 'read', table: 'sessions',
            where: { userId: String(uid) }, options: { raw: true }, context
        }) || [];

        for (const s of sessions) {
            // Кэш сбрасывается ДО удаления строки: между удалением и сбросом
            // существует окно, в котором запрос ещё резолвится по кэшу.
            try { await globalCtx.invalidateSessionUser(s.sessionId); } catch (e) {}
            try { await globalCtx.invalidateSessionKind(s.sessionId); } catch (e) {}
        }

        if (sessions.length) {
            await dbGateway.execute({
                operation: 'delete', table: 'sessions',
                where: { userId: String(uid) }, context
            });
        }
        log.info(`[users] Учётная запись ${uid} отключена: разорвано сессий ${sessions.length}`);
    } catch (e) {
        // Отключение важнее уборки: если сессии удалить не удалось, признак всё равно
        // должен быть записан — доступ закроется на истечении кэша, а не никогда.
        log.error(`[users] Сессии отключённого пользователя ${uid} не разорваны: ${e.message}`);
    }
};
