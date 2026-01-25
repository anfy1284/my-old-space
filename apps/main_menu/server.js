// Server methods main_menu

// Runtime dynamic menu storage and API (shared via global to survive multiple requires)
const __MAIN_MENU_GLOBAL = global.__my_old_space_main_menu = global.__my_old_space_main_menu || {};
__MAIN_MENU_GLOBAL.dynamicMenuItems = __MAIN_MENU_GLOBAL.dynamicMenuItems || [];
__MAIN_MENU_GLOBAL.__dynamicIdCounter = __MAIN_MENU_GLOBAL.__dynamicIdCounter || Date.now();
const dynamicMenuItems = __MAIN_MENU_GLOBAL.dynamicMenuItems;
function genDynamicId() {
    __MAIN_MENU_GLOBAL.__dynamicIdCounter += 1;
    return `dyn-${__MAIN_MENU_GLOBAL.__dynamicIdCounter}`;
}
function cloneMenuItems(items) {
    try {
        return JSON.parse(JSON.stringify(items || []));
    } catch (e) {
        return (items || []).slice();
    }
}
function assignDynamicIds(items) {
    if (!Array.isArray(items)) return;
    for (const it of items) {
        if (!it._dynamicId) it._dynamicId = genDynamicId();
        if (it.items) assignDynamicIds(it.items);
    }
}
function addMenuItem(item, position = 'end') {
    if (!item) return null;
    const copy = cloneMenuItems([item])[0];
    assignDynamicIds([copy]);
    if (position === 'start') dynamicMenuItems.unshift(copy);
    else dynamicMenuItems.push(copy);
    try { console.log('[main_menu] addMenuItem ->', JSON.stringify(copy, null, 2)); } catch(e){}
    return copy._dynamicId;
}
function addMenuItems(items, position = 'end') {
    if (!Array.isArray(items)) return [];
    const copies = cloneMenuItems(items);
    assignDynamicIds(copies);
    if (position === 'start') dynamicMenuItems.unshift(...copies);
    else dynamicMenuItems.push(...copies);
    try { console.log('[main_menu] addMenuItems -> added items=' + JSON.stringify(copies, null, 2)); } catch(e){}
    return copies.map(i => i._dynamicId);
}
function removeMenuItemById(id) {
    if (!id) return false;
    let removed = false;
    const recur = (arr) => {
        for (let i = arr.length - 1; i >= 0; i--) {
            const it = arr[i];
            if (it._dynamicId === id) {
                arr.splice(i, 1);
                removed = true;
            } else if (Array.isArray(it.items) && it.items.length) {
                recur(it.items);
                // if child array became empty, keep parent as-is
            }
        }
    };
    recur(dynamicMenuItems);
    return removed;
}
function removeMenuItemsByMatch(matchObj) {
    if (!matchObj || typeof matchObj !== 'object') return 0;
    let removedCount = 0;
    const matches = (it) => {
        for (const k of Object.keys(matchObj)) {
            if (it[k] !== matchObj[k]) return false;
        }
        return true;
    };
    const recur = (arr) => {
        for (let i = arr.length - 1; i >= 0; i--) {
            const it = arr[i];
            if (matches(it)) {
                arr.splice(i, 1);
                removedCount++;
            } else if (Array.isArray(it.items) && it.items.length) {
                recur(it.items);
            }
        }
    };
    recur(dynamicMenuItems);
    return removedCount;
}
function setDynamicMenu(items) {
    dynamicMenuItems.length = 0;
    if (!Array.isArray(items)) return;
    const copies = cloneMenuItems(items);
    assignDynamicIds(copies);
    dynamicMenuItems.push(...copies);
}
function clearDynamicMenu() {
    dynamicMenuItems.length = 0;
}
function getDynamicMenu() {
    return cloneMenuItems(dynamicMenuItems);
}
async function getMainMenuCommands(appsJsonUrl = '/drive_forms/apps.json') {
    const fs = require('fs').promises;
    const path = require('path');
    const result = [];
    // include runtime dynamic items first
    if (Array.isArray(dynamicMenuItems) && dynamicMenuItems.length) {
        try { console.log('[main_menu] getMainMenuCommands -> dynamicMenuItems:', JSON.stringify(dynamicMenuItems, null, 2)); } catch(e){}
        result.push(...cloneMenuItems(dynamicMenuItems));
    } else {
        try { console.log('[main_menu] getMainMenuCommands -> no dynamicMenuItems'); } catch(e){}
    }
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
    getMainMenuCommands,
    // dynamic menu API
    addMenuItem,
    addMenuItems,
    removeMenuItemById,
    removeMenuItemsByMatch,
    setDynamicMenu,
    clearDynamicMenu,
    getDynamicMenu
};
