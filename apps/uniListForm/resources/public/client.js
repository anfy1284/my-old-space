/**
 * myNewApp Application - Client Side
 */

try {
    (async function() {
        let APP_NAME = 'uniListForm'
        const APP_CONFIG = {};

        // Use framework `App` helper to build descriptor; override instance creation
        const app = new App(APP_NAME, { config: { allowMultipleInstances: true } });

        // Provide app-specific createInstance that sets up the DataForm.
        app.createInstance = async function(params) {
            const instanceId = this.generateInstanceId();
            const container = null; // App decides not to create per-instance container

            const appForm = new DataForm(APP_NAME);
            appForm.setTitle(APP_NAME);
            appForm.setWidth(800);
            appForm.setHeight(600);
            appForm.setX(100);
            appForm.setY(100);

            function instanceOnOpen(dbTable) {
                appForm.dbTable = dbTable || null;
                if (!dbTable) {
                    if (typeof showAlert === 'function') showAlert('Не указана таблица базы данных!');
                    return false;
                }
                return true;
            }

            const instance = {
                id: instanceId,
                appName: APP_NAME,
                container,
                form: appForm,
                async onOpen(params) {
                    const tableName = params && (params.dbTable || params.table);
                    if (!instanceOnOpen(tableName)) return;
                    // Capture the open params so loader overrides can forward them to server
                    const openParams = Object.assign({}, params || {});
                    // Normalize dbTable/table -> tableName so server resolvers receive `params.tableName`
                    openParams.tableName = openParams.tableName || openParams.dbTable || openParams.table || '';

                    // Override DataForm methods so subsequent internal loads include openParams
                    try {
                        appForm.appName = APP_NAME;
                        appForm.getLayoutWithData = async function() {
                            try { return await callServerMethod(APP_NAME, 'getLayoutWithData', openParams); } catch (e) { throw e; }
                        };
                        appForm.loadData = async function() {
                            try {
                                const d = await callServerMethod(APP_NAME, 'getData', openParams);
                                this._dataMap = {};
                                if (d && Array.isArray(d)) {
                                    for (const rec of d) {
                                        if (rec && rec.name) this._dataMap[rec.name] = rec;
                                    }
                                }
                            } catch (e) {
                                this._dataMap = {};
                            }
                        };
                    } catch (e) {
                        console.error('[uniListForm] failed to override DataForm loaders', e);
                    }

                    try { appForm.Draw(); } catch (e) { console.error(e); }
                },
                onAction(action, params) {
                    // Support framework calling instance.onAction('open', params)
                    if (action === 'open') {
                        try { if (typeof this.onOpen === 'function') this.onOpen(params); } catch (e) { console.error(e); }
                        return;
                    }
                    if (typeof appForm.doAction === 'function') {
                        try { appForm.doAction(action, params); } catch (e) { console.error(e); }
                    }
                },
                destroy() {
                    try { if (typeof appForm.destroy === 'function') appForm.destroy(); } catch (e) {}
                }
            };

            if (params && (params.dbTable || params.table)) instance.onOpen(params);
            return instance;
        };

        try { app.register(); } catch (e) { console.error('Failed to register app descriptor', e); }

        // Background config fetch disabled: this app works with server-provided
        // settings and the project doesn't host /apps/recordEditor/config.json.
        // If you later want to enable external overrides, restore the fetch
        // from /apps/recordEditor/config.json and merge into `APP_CONFIG`.

        console.log('[' + APP_NAME + '] Client descriptor registered via App helper');

    })();
} catch (error) {
    console.error('[recordEditor] Error initializing client descriptor:', error);
}
