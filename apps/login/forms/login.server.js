'use strict';

// Серверные функции приложения "login".
//
// Экспортирует фабрику: module.exports = function(modelsDB, Utilities) { return { ... }; }
// Регистрируется в init.js через loadServerScript('login.actions', ...).
// Каждая функция получает (params, ctx), где ctx = { sessionID, user, role }.
//
// ВНИМАНИЕ: саморегистрация удалена, гостевой вход отключён — у нас ERP, пользователи
// заводятся только администратором.

const { tForSession } = require('../../../drive_forms/globalServerContext');
const globalCtx = require('../../../drive_root/globalServerContext');

module.exports = function (modelsDB, Utilities) {

    // Вход по имени и паролю. Привязывает текущую сессию к найденному пользователю.
    // Возвращает mustChangePassword — клиент по нему решает, показать ли форму смены пароля.
    async function login(params, ctx) {
        const sessionID = ctx && ctx.sessionID;
        const { username, password } = params || {};
        if (!username || !password) {
            return { success: false, error: await tForSession('Username and password required', sessionID) };
        }

        const user = await modelsDB.Users.scope('withPassword').findOne({ where: { name: username } });
        if (!user) {
            return { success: false, error: await tForSession('User not found', sessionID) };
        }

        const isValid = await Utilities.validatePassword(password, user.password_hash);
        if (!isValid) {
            return { success: false, error: await tForSession('Invalid password', sessionID) };
        }

        const session = await modelsDB.Sessions.findOne({ where: { sessionId: sessionID } });
        if (session) {
            await session.update({ userId: user.UID });
        } else {
            await modelsDB.Sessions.create({ sessionId: sessionID, userId: user.UID });
        }

        return { success: true, mustChangePassword: !!user.mustChangePassword };
    }

    // Смена пароля текущего (по сессии) пользователя.
    //   - Принудительная смена (флаг mustChangePassword) — старый пароль НЕ требуется.
    //   - Добровольная смена (флаг не стоит) — требуется верный старый пароль.
    // После успешной смены флаг mustChangePassword сбрасывается.
    async function changePassword(params, ctx) {
        const sessionID = ctx && ctx.sessionID;
        const { oldPassword, newPassword } = params || {};

        const sessionUser = await globalCtx.getUserBySessionID(sessionID);
        if (!sessionUser) {
            return { success: false, error: await tForSession('User not authorized', sessionID) };
        }
        if (!newPassword) {
            return { success: false, error: await tForSession('New password is required', sessionID) };
        }

        // Полная запись (с password_hash и флагом) для проверки и обновления.
        const user = await modelsDB.Users.scope('withPassword').findOne({ where: { UID: sessionUser.UID } });
        if (!user) {
            return { success: false, error: await tForSession('User not found', sessionID) };
        }

        // Добровольная смена — подтверждаем личность старым паролем.
        if (!user.mustChangePassword) {
            const ok = await Utilities.validatePassword(oldPassword || '', user.password_hash || '');
            if (!ok) {
                return { success: false, error: await tForSession('Invalid password', sessionID) };
            }
        }

        const hashedPassword = await Utilities.hashPassword(newPassword);
        await user.update({ password_hash: hashedPassword, mustChangePassword: false });

        // Сбрасываем кэш пользователя сессии — иначе серверный гейт mustChangePassword
        // (в /server-call и /app/call) продолжит блокировать доступ по устаревшей копии.
        try { await globalCtx.invalidateSessionUser(sessionID); } catch (e) {}

        return { success: true };
    }

    // Сброс пароля ЧУЖОЙ учётной записи администратором (форма записи справочника
    // «Пользователи»). В отличие от changePassword старый пароль не спрашивается —
    // администратор его не знает; вместо этого действие доступно только роли admin.
    //
    // mustChangePassword по умолчанию взводится: назначенный администратором пароль —
    // временный, пользователь обязан сменить его при первом входе (админ не должен
    // знать постоянный пароль сотрудника).
    async function resetUserPassword(params, ctx) {
        const sessionID = ctx && ctx.sessionID;
        const { userId, newPassword } = params || {};
        // Явное сравнение с false: параметр не передан → поведение по умолчанию (взвести флаг).
        const mustChange = (params && params.mustChangePassword === false) ? false : true;

        // Роль резолвится сервером в /server-call из сессии — клиент её подделать не может.
        // Гейт mustChangePassword пропускает всё приложение login (иначе смена своего
        // пароля была бы невозможна), поэтому здесь проверяем флаг вызывающего отдельно:
        // пока свой пароль не сменён, администрировать чужие нельзя.
        if (!ctx || ctx.role !== 'admin' || (ctx.user && ctx.user.mustChangePassword)) {
            return { success: false, error: await tForSession('Not enough rights', sessionID) };
        }
        if (!userId) {
            return { success: false, error: await tForSession('User not found', sessionID) };
        }
        if (!newPassword) {
            return { success: false, error: await tForSession('New password is required', sessionID) };
        }

        const user = await modelsDB.Users.scope('withPassword').findOne({ where: { UID: userId } });
        if (!user) {
            return { success: false, error: await tForSession('User not found', sessionID) };
        }

        const hashedPassword = await Utilities.hashPassword(newPassword);
        await user.update({ password_hash: hashedPassword, mustChangePassword: mustChange });

        // Сбрасываем кэш пользователя во ВСЕХ его сессиях (не в сессии администратора):
        // гейт mustChangePassword и RLS читают закэшированную копию пользователя, иначе
        // сотрудник продолжит работать по устаревшему флагу.
        try {
            const sessions = await modelsDB.Sessions.findAll({ where: { userId: user.UID }, raw: true });
            for (const s of (sessions || [])) {
                await globalCtx.invalidateSessionUser(s.sessionId);
            }
        } catch (e) {
            console.error('[login/resetUserPassword] session cache invalidation failed:', e && e.message || e);
        }

        return { success: true };
    }

    // Информация для точки входа: авторизован ли пользователь и его роль.
    // По ней autoStart-точка решает, показывать ли форму входа (только для неавторизованных).
    async function getBootInfo(params, ctx) {
        const authenticated = !!(ctx && ctx.user);
        // mustChangePassword читаем из БД по UID сессии — ctx.user может не содержать
        // всех полей. По нему boot решает, показать ли принудительную смену пароля
        // после перезагрузки страницы (иначе вход в обход смены).
        let mustChangePassword = false;
        if (authenticated) {
            try {
                const u = await modelsDB.Users.findByPk(ctx.user.UID, { raw: true });
                mustChangePassword = !!(u && u.mustChangePassword);
            } catch (e) { /* недоступно — считаем, что смена не требуется */ }
        }
        return {
            authenticated,
            role: (ctx && ctx.role) || null,
            mustChangePassword
        };
    }

    // ── Гостевой вход временно отключён (гостей пока нет; всё через админа) ──────
    // Чтобы вернуть: убери ранний return и верни кнопку/обработчик на клиенте.
    async function loginAsGuest(params, ctx) {
        return { success: false, error: await tForSession('Guest login is disabled', ctx && ctx.sessionID) };
        /*
        const sessionID = ctx && ctx.sessionID;
        await globalCtx.createGuestUser(sessionID, ['mySpace'], ['public']);
        return { success: true };
        */
    }

    return { login, changePassword, resetUserPassword, getBootInfo, loginAsGuest };
};
