'use strict';

// Точка регистрации приложения "login".
// Автоматически вызывается фреймворком при старте (drive_forms/init.js).
//
// login — standalone-приложение для роли nologged (uniForm недоступен до входа).
// Серверный лейаут (forms/login.layout.json) отдаётся клиенту через серверную
// функцию getFormSpec, клиент рендерит его штатным DataForm.renderLayout.
//
// Для неавторизованной сессии сервер видит роль 'public' (см. /server-call и /files),
// поэтому серверный и клиентский скрипты регистрируются для ['public', 'nologged'].

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

        // Серверные функции аутентификации (фабрика).
        const authFns   = require('./forms/login.server')(modelsDB, Utilities);
        const layoutRaw = require('./forms/login.layout.json');

        // Клиентские обработчики: __SERVER_SCRIPT__ → реальное имя серверного скрипта.
        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/login.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, SERVER_SCRIPT_NAME);
        // role 'public' — чтобы /files отдавал скрипт неавторизованной сессии.
        const clientUID = await loadScript(clientSource, 'public');

        // Отдаёт клиенту спецификацию формы: переведённый лейаут + UID клиентского скрипта.
        async function getFormSpec(params, ctx) {
            let language = 'en';
            try {
                const sctx = await getSessionContext(ctx && ctx.sessionID);
                language = (sctx && sctx.language) || 'en';
            } catch (e) { /* нет сессии — английский по умолчанию */ }

            const cloned = JSON.parse(JSON.stringify(layoutRaw));
            translateCaptions(cloned, (key) => i18n.t(key, language));
            return { layout: cloned, clientScript: clientUID };
        }

        loadServerScript(
            SERVER_SCRIPT_NAME,
            Object.assign({}, authFns, { getFormSpec }),
            ['public', 'nologged']
        );

        console.log('[login/init] Registered server script + client layout');
    } catch (e) {
        console.error('[login/init] Failed:', e && e.message || e);
    }
};
