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
// Пункт меню открывает СПИСОК (mode:'list'), поэтому для иконки берём список:
// документ → журнал, справочник → справочник.
const ICON_JOURNAL  = '/apps/general_icons/resources/public/16x16/journal.png';
const ICON_CATALOG  = '/apps/general_icons/resources/public/16x16/catalog.png';

/**
 * Пробегает по дереву пунктов меню и для пунктов appName==='uniForm' + params.dbTable
 * подставляет иконку из layoutMemory (или по типу сущности), если иконка ещё не задана.
 * Вызывается в getMainMenuCommands() — после того как все init.js уже выполнились.
 */
function resolveMenuIcons(items) {
    if (!Array.isArray(items)) return;
    let layoutMemory = null;
    let modelDefs = null;
    try { layoutMemory = require('../../drive_root/layoutMemory'); } catch (e) {}

    const getEntityIcon = (tableName) => {
        try {
            if (!modelDefs) {
                const gCtx = require('../../drive_root/globalServerContext');
                modelDefs = (gCtx.collectAllModelDefs().models || []);
            }
            const def = modelDefs.find(m => m.tableName === tableName);
            const et = (def && def.entityConfig && def.entityConfig.entityType) || null;
            return et === 'document' ? ICON_JOURNAL : ICON_CATALOG;
        } catch (e) { return ICON_CATALOG; }
    };

    const recurse = (arr) => {
        for (const item of arr) {
            if (!item.icon && item.appName === 'uniForm' && item.params && item.params.dbTable) {
                const tableName = item.params.dbTable;
                // Иконка списка (listIcon) приоритетнее иконки записи (formIcon).
                let icon = layoutMemory
                    ? (layoutMemory.getTableListIcon(tableName) || layoutMemory.getTableIcon(tableName))
                    : null;
                if (!icon) icon = getEntityIcon(tableName);
                item.icon = icon;
            }
            if (Array.isArray(item.items)) recurse(item.items);
        }
    };
    recurse(items);
}

/**
 * Рекурсивно переводит caption: { i18n: 'key' } → строку для текущей сессии пользователя.
 * Мутирует items in-place. Вызывается после filterItemsByRole, до resolveMenuIcons.
 */
async function translateCaptions(items, sessionID) {
    if (!Array.isArray(items)) return;
    let tFn = null;
    try {
        const formsCtx = require('../../drive_forms/globalServerContext');
        tFn = formsCtx.tForSession;
    } catch (e) { return; }
    const recurse = async (arr) => {
        for (const item of arr) {
            if (item.caption && typeof item.caption === 'object' && item.caption.i18n) {
                try {
                    item.caption = await tFn(item.caption.i18n, sessionID);
                } catch (e) {
                    item.caption = item.caption.i18n;
                }
            }
            if (Array.isArray(item.items)) await recurse(item.items);
        }
    };
    await recurse(items);
}

/**
 * Рекурсивно фильтрует пункты меню по роли пользователя.
 * Пункты с полем `roles` показываются только если userRole входит в список.
 * Пункты без `roles` — всегда видны.
 */
function filterItemsByRole(items, userRole) {
    if (!Array.isArray(items)) return items;
    const result = [];
    for (const item of items) {
        if (item.roles) {
            const allowed = Array.isArray(item.roles) ? item.roles : [item.roles];
            if (!allowed.includes(userRole)) continue;
        }
        if (Array.isArray(item.items)) {
            result.push(Object.assign({}, item, { items: filterItemsByRole(item.items, userRole) }));
        } else {
            result.push(item);
        }
    }
    return result;
}

async function getMainMenuCommands(params = {}, sessionID = null) {
    const fs = require('fs').promises;
    const path = require('path');
    const result = [];
    if (Array.isArray(dynamicMenuItems) && dynamicMenuItems.length) {
        result.push(...cloneMenuItems(dynamicMenuItems));
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
    // Определяем роль пользователя для фильтрации пунктов меню
    let userRole = null;
    if (sessionID) {
        try {
            const formsCtx = require('../../drive_forms/globalServerContext');
            const ctx = await formsCtx.getSessionContext(sessionID);
            userRole = ctx && ctx.role;
        } catch (e) {
            console.error('[main_menu] Failed to resolve user role:', e.message);
        }
    }

    const filtered = filterItemsByRole(result, userRole);
    await translateCaptions(filtered, sessionID);
    resolveMenuIcons(filtered);
    return filtered;
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
