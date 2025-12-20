// Server methods main_menu

async function getMainMenuCommands(appsJsonUrl = '/drive_forms/apps.json') {
    const fs = require('fs').promises;
    const path = require('path');
    const result = [];
    try {
        // points to merged apps.json logic
        const localAppsJsonPath = path.resolve(__dirname, '../../drive_forms/apps.json');
        const rootAppsJsonPath = path.resolve(__dirname, '../../apps.json');

        let allApps = [];
        let appsBasePath = "apps"; // Default
        const loadAppsFromPath = async (p) => {
            if (require('fs').existsSync(p)) {
                try {
                    const cfg = JSON.parse(await fs.readFile(p, 'utf8'));
                    if (cfg.path) appsBasePath = cfg.path.replace(/^[/\\]+/, '');
                    if (Array.isArray(cfg.apps)) {
                        cfg.apps.forEach(app => {
                            if (app.name && !allApps.find(a => a.name === app.name)) {
                                allApps.push(app);
                            }
                        });
                    }
                } catch (e) {
                    console.error(`[main_menu] Error reading apps.json at ${p}:`, e.message);
                }
            }
        };

        await loadAppsFromPath(localAppsJsonPath);
        await loadAppsFromPath(rootAppsJsonPath);

        if (allApps.length === 0) return result;

        for (const app of allApps) {
            const configPath = path.resolve(__dirname, `../../${appsBasePath}/${app.name}/config.json`);
            try {
                const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
                if (cfg.mainMenuCommands) {
                    // Inject app name into commands
                    const injectAppName = (items) => {
                        if (!items) return;
                        for (const item of items) {
                            if (item.action) {
                                item.appName = app.name;
                            }
                            if (item.items) {
                                injectAppName(item.items);
                            }
                        }
                    };

                    cfg.mainMenuCommands.forEach(cmd => {
                        if (cmd.items) injectAppName(cmd.items);
                    });

                    result.push(...cfg.mainMenuCommands);
                }
            } catch (e) { }
        }
    } catch (e) { }
    return result;
}

module.exports = {
    getMainMenuCommands
};
