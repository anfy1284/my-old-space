
module.exports = async function(modelsDB) {
    try {
        const path = require('path');
        const mainMenu = require(path.resolve(__dirname, '../main_menu/server.js'));
        const globalCtx = require(path.resolve(__dirname, '../../drive_root/globalServerContext.js'));

        const defs = (globalCtx.collectAllModelDefs && typeof globalCtx.collectAllModelDefs === 'function')
            ? (globalCtx.collectAllModelDefs().models || [])
            : [];

        const adminItems = defs.map(d => {
            const tableName = d.tableName || d.name;
            return { caption: tableName, action: 'open', appName: 'uniForm', params: { mode: 'list', dbTable: tableName }, icon: '/apps/general_icons/resources/public/16x16/catalog.png' };
        });

        if (adminItems.length) {
            mainMenu.addMenuItems([
                {
                    id: 'main',
                    items: [
                        { caption: 'Администрирование', items: adminItems }
                    ]
                }
            ], 'start');
            console.log('[uniForm/init] Added Administration submenu with', adminItems.length, 'tables');
        }
    } catch (e) {
        console.error('[uniForm/init] Failed to add Administration menu items:', e && e.message || e);
    }
};
