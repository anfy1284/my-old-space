'use strict';

// Серверные функции приложения "login".
//
// Экспортирует фабрику: module.exports = function(modelsDB, Utilities) { return { ... }; }
// Регистрируется в init.js через loadServerScript('login.actions', ...).
// Каждая функция получает (params, ctx), где ctx = { sessionID, user, role }.
//
// Аутентификация выполняется штатными API фреймворка:
//   - globalServerContext.createNewUser / createGuestUser — создание пользователя и привязка сессии
//   - Utilities.hashPassword / validatePassword            — работа с паролем
//   - modelsDB.Users / modelsDB.Sessions                   — поиск и обновление сессии

const { tForSession } = require('../../../drive_forms/globalServerContext');
const globalCtx = require('../../../drive_root/globalServerContext');

module.exports = function (modelsDB, Utilities) {

    // Вход по имени и паролю. Привязывает текущую сессию к найденному пользователю.
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

        return { success: true };
    }

    // Регистрация нового пользователя. createNewUser сам привязывает сессию.
    async function createUser(params, ctx) {
        const sessionID = ctx && ctx.sessionID;
        const { username, password } = params || {};
        if (!username || !password) {
            return { success: false, error: await tForSession('Username and password required', sessionID) };
        }

        const existing = await modelsDB.Users.findOne({ where: { name: username } });
        if (existing) {
            return { success: false, error: await tForSession('User already exists', sessionID) };
        }

        const user = await globalCtx.createNewUser(sessionID, username, ['mySpace'], ['user']);
        const hashedPassword = await Utilities.hashPassword(password);
        await user.update({ password_hash: hashedPassword });

        return { success: true };
    }

    // Гостевой вход: создаёт гостевого пользователя и привязывает сессию.
    async function loginAsGuest(params, ctx) {
        const sessionID = ctx && ctx.sessionID;
        await globalCtx.createGuestUser(sessionID, ['mySpace'], ['public']);
        return { success: true };
    }

    return { login, createUser, loginAsGuest };
};
