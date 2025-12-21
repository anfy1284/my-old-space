// Server methods main_menu

async function getMainMenuCommands(appsJsonUrl = '/drive_forms/apps.json') {
    const fs = require('fs').promises;
    const path = require('path');
    const result = [];
    try {
        // consider apps.json from drive_forms, package root and project root
        const localAppsJsonPath = path.resolve(__dirname, '../../drive_forms/apps.json');
        const packageAppsJsonPath = path.resolve(__dirname, '../../apps.json');
        const projectAppsJsonPath = path.resolve(process.cwd(), 'apps.json');

        const sources = [
            { p: localAppsJsonPath, baseDir: path.resolve(__dirname, '..', '..') },
            { p: packageAppsJsonPath, baseDir: path.resolve(__dirname, '..', '..') },
            { p: projectAppsJsonPath, baseDir: process.cwd() }
        ];

        const appsMap = new Map();
        for (const src of sources) {
            try {
                if (require('fs').existsSync(src.p)) {
                    const cfg = JSON.parse(await fs.readFile(src.p, 'utf8'));
                    const appsPath = (cfg.path || 'apps').replace(/^[/\\]+/, '');
                    if (Array.isArray(cfg.apps)) {
                        for (const app of cfg.apps) {
                            if (app.name) {
                                appsMap.set(app.name, Object.assign({}, app, { __appsBaseDir: src.baseDir, __appsPath: appsPath }));
                            }
                        }
                    }
                }
            } catch (e) {
                console.error(`[main_menu] Error reading apps.json at ${src.p}:`, e.message);
            }
        }

        const allApps = Array.from(appsMap.values());
        if (allApps.length === 0) return result;

        for (const app of allApps) {
            const baseDir = app.__appsBaseDir || path.resolve(__dirname, '..');
            const appsBasePath = app.__appsPath || 'apps';
            const cleanAppPath = (app.path || `/${app.name}`).replace(/^[/\\]+/, '');
            const configPath = path.resolve(baseDir, appsBasePath, cleanAppPath, 'config.json');
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
