

module.exports = async function(modelsDB) {
    console.log('[organizations/init] Initialization complete');

    try {
        const path = require('path');
        const mainMenu = require(path.resolve(__dirname, '../main_menu/server.js'));
        const globalCtx = require(path.resolve(__dirname, '../../drive_root/globalServerContext.js'));

        // Collect model definitions (from drive_root/globalServerContext)
        const defs = (globalCtx.collectAllModelDefs && typeof globalCtx.collectAllModelDefs === 'function')
            ? (globalCtx.collectAllModelDefs().models || [])
            : [];

        // Build submenu items for administration
        const adminItems = defs.map(d => {
            const tableName = d.tableName || d.name;
            return { caption: tableName, action: 'open', appName: 'uniListForm', params: { dbTable: tableName } };
        });

        // Add Administration submenu under 'main'
        if (adminItems.length) {
            mainMenu.addMenuItems([
                {
                    id: 'main',
                    items: [
                        { caption: 'Администрирование', items: adminItems }
                    ]
                }
            ], 'start');

            console.log('[uniListForm/init] Added Administration submenu with', adminItems.length, 'tables');
        } else {
            console.log('[uniListForm/init] No model definitions found to build Administration submenu');
        }

    } catch (e) {
        console.error('[uniListForm/init] Failed to add Administration menu items:', e && e.message || e);
    }
};

