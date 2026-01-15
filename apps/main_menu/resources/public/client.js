(function () {
    const MenuRenderer = {
        openMenus: [],

        show: function (x, y, items, level = 0) {
            this.close(level);

            const menu = document.createElement('div');
            Object.assign(menu.style, {
                position: 'absolute',
                left: `${x}px`,
                top: `${y}px`,
                backgroundColor: '#c0c0c0',
                borderTop: '2px solid #ffffff',
                borderLeft: '2px solid #ffffff',
                borderRight: '2px solid #000000',
                borderBottom: '2px solid #000000',
                padding: '2px',
                zIndex: 10000 + level,
                display: 'flex',
                flexDirection: 'column',
                minWidth: '120px',
                boxShadow: '2px 2px 4px rgba(0,0,0,0.2)'
            });

            items.forEach(item => {
                const itemDiv = document.createElement('div');
                Object.assign(itemDiv.style, {
                    padding: '3px 20px 3px 5px',
                    cursor: 'default',
                    fontSize: '12px',
                    fontFamily: 'MS Sans Serif, sans-serif',
                    position: 'relative',
                    whiteSpace: 'nowrap',
                    userSelect: 'none'
                });

                const text = document.createElement('span');
                text.textContent = item.caption;
                itemDiv.appendChild(text);

                if (item.items) {
                    const arrow = document.createElement('span');
                    arrow.innerHTML = '&#9658;';
                    Object.assign(arrow.style, {
                        position: 'absolute',
                        right: '4px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        fontSize: '8px'
                    });
                    itemDiv.appendChild(arrow);
                }

                itemDiv.onmouseenter = () => {
                    // Reset neighbors style
                    Array.from(menu.children).forEach(child => {
                        child.style.backgroundColor = '';
                        child.style.color = 'black';
                    });

                    // Highlight
                    itemDiv.style.backgroundColor = '#000080';
                    itemDiv.style.color = 'white';

                    if (item.items) {
                        const rect = itemDiv.getBoundingClientRect();
                        this.show(rect.right - 2, rect.top - 2, item.items, level + 1);
                    } else {
                        this.close(level + 1);
                    }
                };

                itemDiv.onclick = (e) => {
                    e.stopPropagation();
                    if (!item.items) {
                        if (item.onClick) item.onClick();
                        this.close(0);
                    }
                };

                menu.appendChild(itemDiv);
            });

            document.body.appendChild(menu);
            this.openMenus.push({ element: menu, level });
        },

        close: function (fromLevel) {
            for (let i = this.openMenus.length - 1; i >= 0; i--) {
                if (this.openMenus[i].level >= fromLevel) {
                    this.openMenus[i].element.remove();
                    this.openMenus.splice(i, 1);
                }
            }
        }
    };

    document.addEventListener('mousedown', (e) => {
        let target = e.target;
        let inside = false;
        while (target) {
            if (MenuRenderer.openMenus.some(m => m.element === target)) {
                inside = true;
                break;
            }
            target = target.parentElement;
        }
        if (!inside) MenuRenderer.close(0);
    });

    function mergeItems(existingItems, newItems) {
        if (!newItems) return existingItems;

        const mergedMap = {};
        // Index existing items by caption
        for (const item of existingItems) {
            mergedMap[item.caption] = item;
        }

        for (const item of newItems) {
            if (mergedMap[item.caption]) {
                // If both have items, merge them
                if (item.items && mergedMap[item.caption].items) {
                    mergedMap[item.caption].items = mergeItems(mergedMap[item.caption].items, item.items);
                }
            } else {
                mergedMap[item.caption] = item;
                existingItems.push(item);
            }
        }
        return existingItems;
    }

    function transformItems(items) {
        return items.map(item => {
            const newItem = { caption: item.caption };
            if (item.items) {
                newItem.items = transformItems(item.items);
            }
            if (item.action === 'open' && item.appName) {
                newItem.onClick = () => {
                    // Pass params if available
                    const scriptUrl = `/apps/${item.appName}/resources/public/client.js`;
                    // Always reload script to create a new app instance
                    const script = document.createElement('script');
                    script.src = scriptUrl + '?t=' + new Date().getTime(); // Cache busting

                    const params = item.params;

                    const tryOpen = () => {
                        try {
                            if (window.MySpace && typeof window.MySpace.open === 'function') {
                                window.MySpace.open(item.appName, params).catch(e => console.error(e));
                                return true;
                            }
                        } catch (e) { /* ignore */ }
                        return false;
                    };

                    script.onload = () => {
                        if (tryOpen()) return;
                        let attempts = 0;
                        const iv = setInterval(() => {
                            attempts++;
                            if (tryOpen() || attempts >= 10) clearInterval(iv);
                        }, 100);
                    };

                    document.body.appendChild(script);
                    
                };
            }
            return newItem;
        });
    }

    function getMainMenuCommands() {
        callServerMethod('main_menu', 'getMainMenuCommands', {})
            .then(result => {
                // Merge commands
                const mergedCommands = {};
                for (const cmd of result) {
                    if (!mergedCommands[cmd.id]) {
                        mergedCommands[cmd.id] = { ...cmd, items: [...(cmd.items || [])] };
                    } else {
                        mergedCommands[cmd.id].items = mergeItems(mergedCommands[cmd.id].items, cmd.items);
                    }
                }

                // Transform to MainMenu buttons
                const buttons = Object.values(mergedCommands).map(cmd => {
                    const btn = {
                        id: cmd.id,
                        caption: cmd.caption || '', // id used as caption if missing, but for 'main' it's empty
                        items: transformItems(cmd.items || [])
                    };
                    // Special case for 'main' button caption
                    if (cmd.id === 'main') {
                        btn.caption = '';
                    }
                    return btn;
                });

                MainMenu.setButtons(buttons);
                MainMenu.Draw();
                // Trigger resize event so other components can recalculate their dimensions
                window.dispatchEvent(new Event('resize'));
            })
            .catch(err => {
                console.error('Menu loading error: ' + err.message);
            });
    }

    const MainMenu = {
        container: null,
        buttons: [], // Will be populated via getMainMenuCommands

        buttonObjects: [],
        Draw: function () {
            // Use sizes compatible with form title from UI_classes
            // In UI_classes title buttons have height '18px' and padding '2px 4px'
            const titleBtnHeight = 20;
            const titlePaddingV = 2; // padding top/bottom on titleBar
            const menuHeight = titleBtnHeight + titlePaddingV * 2; // 22 + 4 = 26
            const borderBottomWidth = 2;

            // Set global form offset if Form class is available
            if (typeof Form !== 'undefined') {
                Form.topOffset = menuHeight + borderBottomWidth;
            }

            // Buttons full menu height
            const btnHeight = menuHeight;
            const btnWidth = 120; // width kept flexible for text

            this.container = document.createElement('div');
            this.container.style.position = 'fixed';
            this.container.style.top = '0';
            this.container.style.left = '0';
            this.container.style.zIndex = '9999';
            this.container.style.width = '100%';
            // Menu thickness = button height
            this.container.style.height = menuHeight + 'px';

            // Menu color same as button (if UIObject available)
            const baseColor = (typeof UIObject !== 'undefined')
                ? UIObject.getClientConfigValue('defaultColor', '#c0c0c0')
                : '#222d3d';
            this.container.style.background = baseColor;

            // "3D" style only at bottom (like in Button class)
            const darkColor = (typeof UIObject !== 'undefined')
                ? UIObject.brightenColor(baseColor, -60)
                : '#000000';

            this.container.style.borderBottom = `2px solid ${darkColor}`;
            // this.container.style.boxShadow = '0 4px 10px rgba(0,0,0,0.2)';
            this.container.style.display = 'flex';
            this.container.style.alignItems = 'center';
            // Buttons are placed close to each other and to the left edge
            this.container.style.gap = '0';
            this.container.style.paddingLeft = '0';
            document.body.prepend(this.container);

            this.buttonObjects = [];
            for (const btnData of this.buttons) {
                const btn = new Button(this.container);
                btn.setCaption(btnData.caption);

                if (btnData.items) {
                    btn.onClick = (e) => {
                        e.stopPropagation();
                        const rect = btn.getElement().getBoundingClientRect();
                        MenuRenderer.show(rect.left, rect.bottom, btnData.items);
                    };
                } else {
                    btn.onClick = btnData.onClick;
                }

                const isMain = (btnData.id === 'main');
                const currentWidth = isMain ? btnHeight : btnWidth;

                btn.setWidth(currentWidth);
                btn.setHeight(btnHeight);
                btn.Draw(this.container);
                const btnElement = btn.getElement();
                if (btnElement) {
                    if (isMain) {
                        // 9 squares icon
                        const iconSvg = `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style="display:block;">
<rect x="0" y="0" width="4" height="4"/>
<rect x="5" y="0" width="4" height="4"/>
<rect x="10" y="0" width="4" height="4"/>
<rect x="0" y="5" width="4" height="4"/>
<rect x="5" y="5" width="4" height="4"/>
<rect x="10" y="5" width="4" height="4"/>
<rect x="0" y="10" width="4" height="4"/>
<rect x="5" y="10" width="4" height="4"/>
<rect x="10" y="10" width="4" height="4"/>
</svg>`;
                        btnElement.innerHTML = iconSvg;
                        btnElement.style.width = btnHeight + 'px';
                        btnElement.style.padding = '0';
                    }

                    // Place button close to previous one and to left edge
                    btnElement.style.margin = '0';
                    btnElement.style.fontSize = '12px';
                    // Adjust size to title height
                    btnElement.style.height = btnHeight + 'px';
                    // btnElement.style.lineHeight = btnHeight + 'px'; // Remove line-height

                    // Use Flexbox for precise text centering
                    btnElement.style.display = 'inline-flex';
                    btnElement.style.alignItems = 'center';
                    btnElement.style.justifyContent = 'center';

                    btnElement.style.boxSizing = 'border-box';
                    btnElement.style.padding = isMain ? '0' : '0 6px';
                    btnElement.style.verticalAlign = 'middle';

                    // "Flat" style for menu (if not main)
                    if (!isMain) {
                        const setFlat = () => {
                            btnElement.style.border = '1px solid transparent';
                        };

                        setFlat();
                        // Repeat after config load, as Button might redraw borders
                        if (typeof UIObject !== 'undefined') {
                            UIObject.loadClientConfig().then(setFlat);
                        }

                        btnElement.onmouseenter = () => {
                            btnElement.style.borderTop = '1px solid #ffffff';
                            btnElement.style.borderLeft = '1px solid #ffffff';
                            btnElement.style.borderRight = '1px solid #808080';
                            btnElement.style.borderBottom = '1px solid #808080';
                        };
                        btnElement.onmouseleave = () => {
                            // If menu is open, can keep pressed, but for now just reset
                            setFlat();
                        };
                    }
                }
                this.buttonObjects.push(btn);
            }
        },
        setButtons: function (buttonsArr) {

            this.buttons = buttonsArr;
        },
        clear: function () {
            if (this.container) {
                this.container.remove();
                this.container = null;
            }
            this.buttonObjects = [];
        }
    };

    async function collectMainMenuCommands() {
        // Get list of apps from apps.json
        let appsList = [];
        try {
            const resp = await fetch('/drive_forms/apps.json');
            if (resp.ok) {
                const json = await resp.json();
                appsList = json.apps || [];
            }
        } catch (e) { }

        const commandsById = {};
        for (const app of appsList) {
            const configUrl = `/apps/${app.name}/config.json`;
            try {
                const resp = await fetch(configUrl);
                if (!resp.ok) continue;
                const cfg = await resp.json();
                if (cfg.mainMenuCommands) {
                    for (const cmd of cfg.mainMenuCommands) {
                        if (!commandsById[cmd.id]) {
                            commandsById[cmd.id] = cmd;
                        }
                    }
                }
            } catch (e) { }
        }
        // Convert to array for menu
        const menuButtons = Object.values(commandsById).map(cmd => ({
            id: cmd.id,
            caption: cmd.id,
            items: cmd.items
        }));
        // Insert into MainMenu
        MainMenu.setButtons(menuButtons);
        MainMenu.Draw();
    }

    window.addEventListener('load', function () {
        getMainMenuCommands();
    });
})();

