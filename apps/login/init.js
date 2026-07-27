'use strict';

// Точка регистрации приложения "login".
// Автоматически вызывается фреймворком при старте (drive_forms/init.js).
//
// login — standalone-приложение (uniForm недоступен до входа). Содержит две формы,
// выбираемые параметром запуска mode:
//   - 'login'          — форма входа (роль nologged);
//   - 'changePassword' — форма смены пароля (после входа / из параметров пользователя).
// Серверные лейауты отдаются клиенту через getFormSpec(mode), клиент рендерит их
// штатным DataForm.renderLayout.
//
// Роли: неавторизованная сессия видится сервером как 'public'; авторизованная — 'user'/'admin'.
// Клиентский скрипт (с обработчиками) должен быть доступен и тем, и другим, поэтому
// грузится дважды (для 'public' и для 'user'); getFormSpec отдаёт UID по роли вызывающего
// (admin имеет доступ к обоим — см. fileStore.hasRoleAccess).

const path = require('path');
const fs   = require('fs');

// Стабильное имя серверного скрипта — подставляется в client.js вместо __SERVER_SCRIPT__.
const SERVER_SCRIPT_NAME = 'login.actions';

// Рекурсивно переводит { i18n: 'key' } caption в лейауте (на копии дерева).
function translateCaptions(nodes, tFn) {
    if (!nodes) return;
    const arr = Array.isArray(nodes) ? nodes : [nodes];
    for (const node of arr) {
        if (!node || typeof node !== 'object') continue;
        if (node.caption && typeof node.caption === 'object' && node.caption.i18n) {
            node.caption = tFn(node.caption.i18n);
        }
        if (Array.isArray(node.layout)) translateCaptions(node.layout, tFn);
    }
}

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../');
        const i18n = require('../../drive_root/i18n');
        const { getSessionContext } = require('../../drive_forms/globalServerContext');

        // Серверные функции (фабрика): login, changePassword, getBootInfo, loginAsGuest.
        const authFns = require('./forms/login.server')(modelsDB, Utilities);

        // Лейауты по режимам.
        const layouts = {
            login:          require('./forms/login.layout.json'),
            changePassword: require('./forms/change_password.layout.json'),
            // Сброс пароля другому пользователю администратором. Право на действие
            // проверяет сервер (resetUserPassword: ctx.role === 'admin') — лейаут сам
            // по себе ничего не открывает.
            resetPassword:  require('./forms/reset_password.layout.json')
        };

        // Клиентские обработчики: __SERVER_SCRIPT__ → реальное имя серверного скрипта.
        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/login.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, SERVER_SCRIPT_NAME);
        // Один и тот же скрипт под двумя ролями — чтобы /files отдавал его и nologged (public),
        // и авторизованному пользователю (user); admin имеет доступ к обоим.
        const clientUID_public = await loadScript(clientSource, 'public');
        const clientUID_user   = await loadScript(clientSource, 'user');
        const pickClientUID = (role) =>
            (role && role !== 'public' && role !== 'nologged') ? clientUID_user : clientUID_public;

        // Отдаёт клиенту спецификацию формы для режима: переведённый лейаут + UID клиентского скрипта.
        async function getFormSpec(params, ctx) {
            const mode = (params && params.mode) || 'login';
            const layoutRaw = layouts[mode] || layouts.login;

            let language = 'en';
            try {
                const sctx = await getSessionContext(ctx && ctx.sessionID);
                language = (sctx && sctx.language) || 'en';
            } catch (e) { /* нет сессии — английский по умолчанию */ }

            const cloned = JSON.parse(JSON.stringify(layoutRaw));
            translateCaptions(cloned, (key) => i18n.t(key, language));
            return { layout: cloned, mode, clientScript: pickClientUID(ctx && ctx.role) };
        }

        loadServerScript(
            SERVER_SCRIPT_NAME,
            Object.assign({}, authFns, { getFormSpec }),
            ['public', 'nologged', 'user', 'admin']
        );

        // ── Кнопка «Сменить пароль» в форме записи справочника «Пользователи» ──────
        // Лейаут НЕ переопределяем: состав полей users собирают несколько слоёв
        // (фреймворк + прикладные db.json, напр. organizationId), ручной лейаут их
        // потерял бы. Регистрируем только кнопку — uniForm вклеит её в commandBar
        // автогенерируемой формы. Роль admin: сбрасывать чужой пароль может только он.
        const layoutMemory = require('../../drive_root/layoutMemory');
        const usersClientSource = fs.readFileSync(path.join(__dirname, 'forms/users.client.js'), 'utf8');
        const usersClientUID = await loadScript(usersClientSource, 'admin');

        await layoutMemory.saveLayout({
            appName:   'uniForm',
            mode:      'record',
            tableName: 'users',
            roles:     'admin',
            extraButtons: [{
                name:    'btnResetPassword',
                caption: { i18n: 'cp_btn_open' },
                icon:    '/apps/general_icons/resources/public/16x16/user.png',
                events:  { onClick: 'openResetPassword' }
            }],
            clientScript: usersClientUID,
            formIcon:     '/apps/general_icons/resources/public/16x16/user.png'
        });

        console.log('[login/init] Registered server script + login/changePassword/resetPassword layouts + users password button');
    } catch (e) {
        console.error('[login/init] Failed:', e && e.message || e);
    }
};
