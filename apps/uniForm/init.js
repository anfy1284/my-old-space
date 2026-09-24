
module.exports = async function(modelsDB) {
    // Команды документа «Сторнировать»/«Скорректировать» — механизм ядра, а не
    // приложения: они одинаковы для любого документа, объявившего встречный
    // документ. Кнопка формы зовёт их декларацией `command` в лейауте, без
    // клиентского кода (drive_root/db/documentCommands.js).
    try {
        const { loadServerScript } = require('../../');
        require('../../drive_root/db/documentCommands').register(loadServerScript);
        console.log('[uniForm/init] document commands registered (storno / correct)');
    } catch (e) {
        console.error('[uniForm/init] document commands registration failed:', e && e.message || e);
    }

    // Обработчик клика по уведомлению. Уведомление о неудачном проведении
    // приходит от имени `uniForm` — значит, и функция, открывающая документ,
    // живёт здесь. В базе лежит ИМЯ функции: UID скрипта меняется на каждом
    // старте процесса (drive_root/notificationHandlers.js).
    try {
        const fs = require('fs');
        const path = require('path');
        const { loadScript } = require('../../');
        const src = fs.readFileSync(path.join(__dirname, 'notifications.client.js'), 'utf8');
        const clientUID = await loadScript(src, 'user');
        require('../../drive_root/notificationHandlers').register('uniForm', clientUID);
        console.log('[uniForm/init] notification handlers registered (openDocument)');
    } catch (e) {
        console.error('[uniForm/init] notification handlers registration failed:', e && e.message || e);
    }

    try {
        const path = require('path');
        const mainMenu = require(path.resolve(__dirname, '../main_menu/server.js'));
        const globalCtx = require(path.resolve(__dirname, '../../drive_root/globalServerContext.js'));

        const defs = (globalCtx.collectAllModelDefs && typeof globalCtx.collectAllModelDefs === 'function')
            ? (globalCtx.collectAllModelDefs().models || [])
            : [];

        const adminItems = defs.map(d => {
            const tableName = d.tableName || d.name;
            return { caption: tableName, action: 'open', appName: 'uniForm', params: { mode: 'list', dbTable: tableName } };
        });

        if (adminItems.length) {
            mainMenu.addMenuItems([
                {
                    id: 'main',
                    items: [
                        { caption: 'Администрирование', roles: ['admin'], items: adminItems }
                    ]
                }
            ], 'start');
            console.log('[uniForm/init] Added Administration submenu with', adminItems.length, 'tables');
        }
    } catch (e) {
        console.error('[uniForm/init] Failed to add Administration menu items:', e && e.message || e);
    }
};
