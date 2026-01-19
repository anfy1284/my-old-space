
class UIObject {
    constructor() {
        this.element = null;
        this.parent = null;
        this.children = [];
        this.caption = '';
        this.x = 0;
        this.y = 0;
        this.width = 0;
        this.height = 0;
        this.z = 0;
        this.hidden = false;
    }
    // Setters / Getters for geometry & depth
    setHidden(hidden) {
        this.hidden = hidden;
        if (this.element) {
            this.element.style.display = hidden ? 'none' : '';
        }
    }
    getHidden() { return this.hidden; }

    setVisible(visible) {
        this.setHidden(!visible);
    }
    getVisible() { return !this.hidden; }

    setX(x) {
        this.x = x;
        if (this.element) this.element.style.left = x + 'px';
    }
    getX() { return this.x; }
    setY(y) {
        this.y = y;
        if (this.element) this.element.style.top = y + 'px';
    }
    getY() { return this.y; }
    setWidth(width) {
        this.width = width;
        if (this.element) this.element.style.width = width + 'px';
    }
    getWidth() { return this.width; }
    setHeight(height) {
        this.height = height;
        if (this.element) this.element.style.height = height + 'px';
    }
    getHeight() { return this.height; }
    setZ(z) { this.z = z; }
    getZ() { return this.z; }
    // Caption accessor for generic UI objects
    setCaption(caption) {
        this.caption = caption;
        // Do not assume how derived classes render caption; they may override
        try {
            if (this.element && typeof this.element.textContent === 'string') {
                // Only set if element appears to be a simple text container
                // Avoid clobbering complex contents by checking if element has no children
                if (!this.element.children || this.element.children.length === 0) {
                    this.element.textContent = caption;
                }
            }
        } catch (e) {
            // silent
        }
    }
    getCaption() { return this.caption; }
    // Optional element accessor
    getElement() { return this.element; }
    setElement(el) { this.element = el; }

    // Load client_config.json (lazy, cached)
    static loadClientConfig() {
        if (UIObject._clientConfig) return Promise.resolve(UIObject._clientConfig);
        if (UIObject._clientConfigPromise) return UIObject._clientConfigPromise;
        if (typeof fetch !== 'function') {
            UIObject._clientConfig = {};
            return Promise.resolve(UIObject._clientConfig);
        }
        UIObject._clientConfigPromise = fetch('/app/res/public/client_config.json')
            .then(r => r.ok ? r.json() : {})
            .then(json => {
                UIObject._clientConfig = json || {};
                return UIObject._clientConfig;
            })
            .catch(() => {
                UIObject._clientConfig = {};
                return UIObject._clientConfig;
            });
        return UIObject._clientConfigPromise;
    }

    static getClientConfigValue(key, def) {
        const cfg = UIObject._clientConfig;
        return (cfg && Object.prototype.hasOwnProperty.call(cfg, key)) ? cfg[key] : def;
    }

    // Utility: brighten a CSS color by amount (0-255). Supports #RGB, #RRGGBB and rgb()/rgba().
    static brightenColor(color, amount = 20) {
        try {
            if (!color || typeof color !== 'string') return color;
            const clamp = (v) => Math.max(0, Math.min(255, v | 0));

            const trim = color.trim();
            // Hex formats
            if (trim[0] === '#') {
                let hex = trim.slice(1);
                if (hex.length === 3) {
                    // Expand #RGB to #RRGGBB
                    hex = hex.split('').map(ch => ch + ch).join('');
                }
                if (hex.length === 6) {
                    const r = parseInt(hex.slice(0, 2), 16);
                    const g = parseInt(hex.slice(2, 4), 16);
                    const b = parseInt(hex.slice(4, 6), 16);
                    const rr = clamp(r + amount).toString(16).padStart(2, '0');
                    const gg = clamp(g + amount).toString(16).padStart(2, '0');
                    const bb = clamp(b + amount).toString(16).padStart(2, '0');
                    return `#${rr}${gg}${bb}`;
                }
                return trim; // Unknown hex length, return as-is
            }

            // rgb() / rgba()
            const rgbMatch = trim.match(/^rgba?\(([^)]+)\)$/i);
            if (rgbMatch) {
                const parts = rgbMatch[1].split(',').map(p => p.trim());
                // Expect at least r,g,b
                const r = clamp(parseFloat(parts[0]));
                const g = clamp(parseFloat(parts[1]));
                const b = clamp(parseFloat(parts[2]));
                const a = parts[3] !== undefined ? parseFloat(parts[3]) : null;
                const rr = clamp(r + amount);
                const gg = clamp(g + amount);
                const bb = clamp(b + amount);
                return a === null ? `rgb(${rr}, ${gg}, ${bb})` : `rgba(${rr}, ${gg}, ${bb}, ${a})`;
            }

            // Fallback: return original if format unsupported
            return color;
        } catch (_) {
            return color;
        }
    }

    // Helper to style elements
    static styleElement(element, x, y, w, h, fSize) {
        if (element && typeof element.getElement === 'function') {
            const el = element.getElement();
            if (el) {
                el.style.position = 'absolute';
                el.style.left = x + 'px';
                el.style.top = y + 'px';
                el.style.width = w + 'px';
                el.style.height = h + 'px';
                el.style.fontSize = fSize + 'px';
            }
        }
    }

    setParent(parent) {
        this.parent = parent;
    }

    getParent() {
        return this.parent || null;
    }

    addChild(child) {
        this.children.push(child);
        child.setParent(this);
    }

    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index > -1) {
            this.children.splice(index, 1);
            child.setParent(null);
        }
    }

    getChildren() {
        return this.children || [];
    }

    Draw(container) {
        // Method to draw the element
    }

    onClick(event) {
        // Метод обработки клика
    }

    onDoubleClick(event) {
        // Метод обработки двойного клика
    }

    onLeftClick(event) {
        // Метод обработки левого клика
    }

    onHover(event) {
        // Метод обработки наведения
    }

    onMouseDown(event) {
        // Метод обработки нажатия кнопки мыши
    }

    onMouseUp(event) {
        // Метод обработки отпускания кнопки мыши
    }

    onKeyPressed(event) {
        // Метод обработки нажатия клавиши
    }
}

// Base class for form input controls: provides common label/container helpers
class FormInput extends UIObject {
    constructor(parentElement = null, properties = {}) {
        super();
        this.parentElement = parentElement;
        this.containerElement = null; // optional wrapper when placed inside a parent
        this._labelInstance = null; // Label instance (if used)
        this.showLabel = false;
        // If true, place caption to the right of the control and do not append ':'
        this.captionOnRight = false;
        // Apply initial properties passed at construction time
        this.setProperties(properties);
    }

    setProperties(properties = {}) {
        if (properties) {
            for (const key in properties) {
                if (Object.prototype.hasOwnProperty.call(properties, key)) {
                    try { this[key] = properties[key]; } catch (e) {}
                }
            }
        }
    }

    // Create a simple container similar to TextBox's container when needed
    ensureContainer() {
        if (this.containerElement) return this.containerElement;
        if (this.parentElement && typeof this.parentElement.appendChild === 'function') {
            this.containerElement = document.createElement('div');
            this.containerElement.style.display = 'flex';
            this.containerElement.style.alignItems = 'center';
            this.containerElement.style.gap = '8px';
            this.containerElement.style.padding = '0';
            this.containerElement.style.margin = '0';
            this.containerElement.style.border = 'none';
            this.containerElement.style.boxShadow = 'none';
            this.containerElement.style.backgroundColor = 'transparent';
            this.containerElement.style.outline = 'none';
            this.containerElement.style.width = '100%';
        }
        return this.containerElement;
    }

    // Draw label into provided container (do not assume container is this.containerElement)
    drawLabel(container) {
        try {
            if (!this.caption) return;
            if (!this._labelInstance) {
                this._labelInstance = new Label(container || this.parentElement);
            }
            // Use caption; append ':' only when caption is on the left (default)
            const labelText = this.caption ? (this.caption + (this.captionOnRight ? '' : ':')) : this.caption;
            this._labelInstance.setText(labelText);
            this._labelInstance.Draw(container || this.parentElement);
            if (this._labelInstance.element) {
                this._labelInstance.element.style.whiteSpace = 'nowrap';
                this._labelInstance.element.style.flex = '0 0 auto';
                this._labelInstance.element.style.boxSizing = 'border-box';
                // If caption should be on the right, ensure it appears after the control
                if (this.captionOnRight) {
                    try { this._labelInstance.element.style.order = '2'; } catch (e) {}
                } else {
                    try { this._labelInstance.element.style.order = '0'; } catch (e) {}
                }
            }
        } catch (e) {
            // silent
        }
    }

    // Override to keep label text in sync
    setCaption(caption) {
        super.setCaption(caption);
        if (this._labelInstance) {
            try {
                const labelText = caption ? (caption + (this.captionOnRight ? '' : ':')) : caption;
                this._labelInstance.setText(labelText);
            } catch (e) {}
        }
    }

    // Base draw flow for form inputs: ensure container and label are prepared.
    Draw(container) {
        // If a parentElement-aware container is needed, ensure it's created
        const host = this.ensureContainer();
        if (host) {
            this.containerElement = host;
            // draw label into container if caption present
            if (this.caption) this.drawLabel(this.containerElement);
            // Append container to provided container if available and not already attached
            if (container && this.containerElement && !this.containerElement.parentElement) {
                try { container.appendChild(this.containerElement); } catch (e) {}
            }
        } else {
            // No host container (control will manage its own element). If caption provided, draw into container
            if (this.caption && container) {
                this.drawLabel(container);
            }
        }

        return this.containerElement || this._labelInstance || null;
    }
}

// Minimal MySpace registrar exposed at framework (drive_forms) client level.
// Provides `register(name, descriptor)` and `open(name, params)` for app scripts.
if (typeof window !== 'undefined') {
    window.MySpace = window.MySpace || (function() {
        const apps = {};
        const instances = {};
        let _idCounter = 0;

        function genId(name) { return name + '-' + Date.now() + '-' + (++_idCounter); }

        return {
            register(name, descriptor) {
                apps[name] = descriptor;
                try { if (descriptor && typeof descriptor.init === 'function') descriptor.init(); } catch (e) { console.error('MySpace.register.init error', e); }
            },

            async open(name, params) {
                const desc = apps[name];
                if (!desc) throw new Error('MySpace: app not registered: ' + name);

                const allowMulti = !!(desc.config && desc.config.allowMultipleInstances);
                if (!allowMulti) {
                    // reuse existing instance for single-instance apps
                    for (const k in instances) {
                        if (instances[k] && instances[k].appName === name) {
                            try { instances[k].onOpen && instances[k].onOpen(params); } catch (e) { console.error(e); }
                            return instances[k].id;
                        }
                    }
                }

                if (!desc.createInstance) throw new Error('MySpace: descriptor.createInstance missing for ' + name);
                const inst = await desc.createInstance(params || {});
                const id = genId(name);
                inst.id = id;
                inst.appName = name;
                instances[id] = inst;
                return id;
            },

            getInstance(id) { return instances[id] || null; },

            close(id) { const inst = instances[id]; if (inst) { try { inst.destroy && inst.destroy(); } catch (e) {} delete instances[id]; } }
        };
    })();
}

class Form extends UIObject {

    constructor() {
        super();
        this.title = '';
        this.titleBar = null;
        this.titleTextElement = null;
        this.contentArea = null;
        this.movable = true;
        this.resizable = true;
        this.isDragging = false;
        this.isResizing = false;
        this.resizeDirection = null;
        this.dragOffsetX = 0;
        this.dragOffsetY = 0;
        this.anchorToWindow = null; // 'center', 'bottom-right', or null
        this.windowResizeHandler = null;
        this.lockAspectRatio = false; // Lock aspect ratio
        this.initialAspectRatio = 0; // Initial aspect ratio
        this.btnMaximize = null; // Reference to maximize button
        this.btnMaximizeCanvas = null; // Canvas with maximize button icon
        this.isMaximized = false;
        this.restoreX = 0;
        this.restoreY = 0;
        this.restoreWidth = 0;
        this.restoreWidth = 0;
        this.restoreHeight = 0;
        this.proportionalLayout = false;
        this.layoutTarget = null;
    }

    activate() {
        if (this.element) {
            // If there is any other modal form open, don't allow activation of this form
            const modalOpen = Form._allForms.some(f => f !== this && f.isModal && f.element && f.element.parentElement);
            if (modalOpen) return; // keep modality: ignore activation requests
            // Deactivate all other forms
            Form._allForms.forEach(form => {
                if (form !== this) {
                    form.deactivate();
                }
            });

            this.z = ++Form._globalZIndex;
            this.element.style.zIndex = this.z;
            this.element.focus();

            // Make title bar blue
            if (this.titleBar) {
                this.titleBar.style.backgroundColor = '#000080';
            }

            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('form-activated', { detail: { form: this } }));
            }
        }
    }

    deactivate() {
        // Make title bar dark gray
        if (this.titleBar) {
            this.titleBar.style.backgroundColor = '#808080';
        }
    }

    setTitle(title) {
        this.title = title;
        if (this.titleTextElement) {
            this.titleTextElement.textContent = title;
        } else if (this.titleBar) {
            this.titleBar.textContent = title;
        }
    }

    getTitle() {
        return this.title;
    }

    setMovable(value) {
        this.movable = value;
    }

    getMovable() {
        return this.movable;
    }

    setResizable(value) {
        this.resizable = value;
    }

    getResizable() {
        return this.resizable;
    }

    setLockAspectRatio(value) {
        this.lockAspectRatio = value;
        // Update maximize button state
        if (this.btnMaximize && this.btnMaximizeCanvas) {
            this.btnMaximize.disabled = value;
            this.btnMaximize.style.cursor = value ? 'not-allowed' : 'pointer';

            // Redraw icon with correct color
            const ctx = this.btnMaximizeCanvas.getContext('2d');
            ctx.clearRect(0, 0, 12, 12);

            if (value) {
                // Inactive - dark border color (bottom and right edge)
                const baseColor = UIObject.getClientConfigValue('defaultColor', '#c0c0c0');
                ctx.fillStyle = UIObject.brightenColor(baseColor, -60);
            } else {
                // Active - black
                ctx.fillStyle = '#000000';
            }

            ctx.fillRect(2, 2, 8, 1); // Top line
            ctx.fillRect(2, 2, 1, 8); // Left line
            ctx.fillRect(9, 2, 1, 8); // Right line
            ctx.fillRect(2, 9, 8, 1); // Bottom line
        }
    }

    getLockAspectRatio() {
        return this.lockAspectRatio;
    }

    setAnchorToWindow(anchor) {
        this.anchorToWindow = anchor;
        if (anchor && !this.windowResizeHandler) {
            this.windowResizeHandler = () => this.updatePositionOnResize();
            window.addEventListener('resize', this.windowResizeHandler);
        } else if (!anchor && this.windowResizeHandler) {
            window.removeEventListener('resize', this.windowResizeHandler);
            this.windowResizeHandler = null;
        }
    }

    getAnchorToWindow() {
        return this.anchorToWindow;
    }

    getContentArea() {
        return this.contentArea;
    }

    setModal(modal) {
        this.isModal = modal;
        if (this.element) {
            this.updateModalState();
        }
    }

    updateModalState() {
        if (this.isModal) {
            if (!this.modalOverlay) {
                this.modalOverlay = document.createElement('div');
                this.modalOverlay.style.position = 'fixed';
                this.modalOverlay.style.top = '0';
                this.modalOverlay.style.left = '0';
                this.modalOverlay.style.width = '100%';
                this.modalOverlay.style.height = '100%';
                // Transparent but blocking
                this.modalOverlay.style.backgroundColor = 'transparent';
                this.modalOverlay.style.zIndex = this.z - 1; // Behind the form
                document.body.appendChild(this.modalOverlay);

                // Prevent clicks on overlay
                this.modalOverlay.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    this.activate();
                    // Visual feedback?
                });
            }
            this.modalOverlay.style.display = 'block';
            this.modalOverlay.style.zIndex = this.z - 1;
        } else {
            if (this.modalOverlay) {
                this.modalOverlay.style.display = 'none';
            }
        }

        // If this form has a minimize button, disable it while modal
        if (this.btnMinimize) {
            try {
                this.btnMinimize.disabled = !!this.isModal;
                this.btnMinimize.style.cursor = this.isModal ? 'not-allowed' : 'pointer';
            } catch (e) {
                // ignore styling errors
            }
        }
    }

    updatePositionOnResize() {
        if (this.anchorToWindow === 'center') {
            this.setX((window.innerWidth - this.width) / 2);

            const availableHeight = window.innerHeight - Form.topOffset - Form.bottomOffset;
            let newY = Form.topOffset + (availableHeight - this.height) / 2;

            if (newY < Form.topOffset) newY = Form.topOffset;
            this.setY(newY);
        } else if (this.anchorToWindow === 'bottom-right') {
            this.setX(window.innerWidth - this.width - 40);
            this.setY(window.innerHeight - this.height - 60);
        }

        if (this.element) {
            this.element.style.left = this.x + 'px';
            this.element.style.top = this.y + 'px';
        }
        if (this.proportionalLayout) {
            this.updateProportionalLayout();
        }
    }

    Draw(container) {
        if (!this.element) {
            // Save initial aspect ratio for lockAspectRatio
            if (this.width > 0 && this.height > 0) {
                this.initialAspectRatio = this.width / this.height;
            }

            // Auto-center if x and y are 0 (default)
            if (this.x === 0 && this.y === 0 && this.width > 0 && this.height > 0) {
                this.x = (window.innerWidth - this.width) / 2;
                this.y = (window.innerHeight - this.height) / 2;
            }

            this.element = document.createElement('div');
            this.element.classList.add('ui-form');
            this.element.style.position = 'absolute';
            this.element.style.left = this.x + 'px';
            this.element.style.top = this.y + 'px';
            this.element.style.width = this.width + 'px';
            this.element.style.height = this.height + 'px';
            this.element.style.zIndex = this.z;
            this.element.tabIndex = 0;
            this.element.style.outline = 'none';

            // Focus on creation
            setTimeout(() => {
                if (this.element) this.activate();
            }, 0);

            // Add form to global array
            Form._allForms.push(this);

            // Retro style: 3D border
            // Use client_config.json (if loaded) or default value
            const initialBg = UIObject.getClientConfigValue('defaultColor', '#c0c0c0');
            const bgColor = initialBg;
            this.element.style.backgroundColor = bgColor;

            this.element.style.borderTop = `2px solid ${UIObject.brightenColor(bgColor, 60)}`;
            this.element.style.borderLeft = `2px solid ${UIObject.brightenColor(bgColor, 60)}`;
            this.element.style.borderRight = `2px solid ${UIObject.brightenColor(bgColor, -60)}`;
            this.element.style.borderBottom = `2px solid ${UIObject.brightenColor(bgColor, -60)}`;
            this.element.style.boxSizing = 'border-box';

            // Asynchronously load config and update colors if not already loaded
            UIObject.loadClientConfig().then(cfg => {
                const finalColor = UIObject.getClientConfigValue('defaultColor', bgColor);
                if (finalColor !== bgColor) {
                    this.element.style.backgroundColor = finalColor;
                    this.element.style.borderTop = `2px solid ${UIObject.brightenColor(finalColor, 60)}`;
                    this.element.style.borderLeft = `2px solid ${UIObject.brightenColor(finalColor, 60)}`;
                    this.element.style.borderRight = `2px solid ${UIObject.brightenColor(finalColor, -60)}`;
                    this.element.style.borderBottom = `2px solid ${UIObject.brightenColor(finalColor, -60)}`;
                }
            });

            // Create title bar (initially inactive - dark gray)
            this.titleBar = document.createElement('div');
            this.titleBar.classList.add('ui-titlebar');
            this.titleBar.style.backgroundColor = '#808080';
            this.titleBar.style.color = '#ffffff';
            this.titleBar.style.fontWeight = 'bold';
            this.titleBar.style.fontSize = '14px';
            this.titleBar.style.padding = '2px 2px';
            this.titleBar.style.cursor = 'default';
            this.titleBar.style.userSelect = 'none';
            this.titleBar.style.display = 'flex';
            this.titleBar.style.justifyContent = 'space-between';
            this.titleBar.style.alignItems = 'center';

            // Title text
            this.titleTextElement = document.createElement('span');
            this.titleTextElement.classList.add('ui-title');
            this.titleTextElement.textContent = this.title;
            this.titleBar.appendChild(this.titleTextElement);

            // Buttons container
            const buttonsContainer = document.createElement('div');
            buttonsContainer.classList.add('ui-titlebar-buttons');
            buttonsContainer.style.display = 'flex';
            buttonsContainer.style.gap = '2px';
            buttonsContainer.style.flexShrink = '0'; // Prevent button shrinking
            buttonsContainer.style.marginLeft = 'auto'; // Align to right (just in case)

            // Base style for title buttons (size/alignment etc.)
            const buttonStyle = {
                width: '18px',
                height: '18px',
                padding: '0',
                margin: '0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                lineHeight: '18px',
                boxSizing: 'border-box',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                cursor: 'default'
            };

            // Function to apply colors for title buttons
            const applyTitleButtonColors = (el, base) => {
                const light = UIObject.brightenColor(base, 60);
                const dark = UIObject.brightenColor(base, -60);
                el.style.backgroundColor = base;
                el.style.borderTop = `1px solid ${light}`;
                el.style.borderLeft = `1px solid ${light}`;
                el.style.borderRight = `1px solid ${dark}`;
                el.style.borderBottom = `1px solid ${dark}`;
                el.style.boxSizing = 'border-box';
                el.style.cursor = 'default';
            };

            // Minimize button
            const btnMinimize = document.createElement('button');
            btnMinimize.classList.add('ui-title-button');
            Object.assign(btnMinimize.style, buttonStyle);
            const canvasMin = document.createElement('canvas');
            canvasMin.width = 12;
            canvasMin.height = 12;
            const ctxMin = canvasMin.getContext('2d');
            ctxMin.fillStyle = '#000000';
            ctxMin.fillRect(2, 9, 8, 1); // Horizontal line at bottom
            btnMinimize.appendChild(canvasMin);
            // Apply themed 3D style
            applyTitleButtonColors(btnMinimize, UIObject.getClientConfigValue('defaultColor', initialBg));
            buttonsContainer.appendChild(btnMinimize);

            // Keep reference to minimize button so we can disable it for modal forms
            this.btnMinimize = btnMinimize;

            // Maximize button
            const btnMaximize = document.createElement('button');
            btnMaximize.classList.add('ui-title-button');
            Object.assign(btnMaximize.style, buttonStyle);
            const canvasMax = document.createElement('canvas');
            canvasMax.width = 12;
            canvasMax.height = 12;
            const ctxMax = canvasMax.getContext('2d');
            ctxMax.fillStyle = '#000000';
            ctxMax.fillRect(2, 2, 8, 1); // Top line
            ctxMax.fillRect(2, 2, 1, 8); // Left line
            ctxMax.fillRect(9, 2, 1, 8); // Right line
            ctxMax.fillRect(2, 9, 8, 1); // Bottom line
            btnMaximize.appendChild(canvasMax);
            // Apply themed 3D style
            applyTitleButtonColors(btnMaximize, UIObject.getClientConfigValue('defaultColor', initialBg));
            buttonsContainer.appendChild(btnMaximize);

            // Save reference to maximize button and its canvas
            this.btnMaximize = btnMaximize;
            this.btnMaximizeCanvas = canvasMax;

            // Apply lock if set
            if (this.lockAspectRatio) {
                this.setLockAspectRatio(true);
            }

            // Close button
            const btnClose = document.createElement('button');
            btnClose.classList.add('ui-title-button');
            Object.assign(btnClose.style, buttonStyle);
            const canvasClose = document.createElement('canvas');
            canvasClose.width = 12;
            canvasClose.height = 12;
            const ctxClose = canvasClose.getContext('2d');
            ctxClose.strokeStyle = '#000000';
            ctxClose.lineWidth = 1.5;
            ctxClose.beginPath();
            ctxClose.moveTo(3, 3);
            ctxClose.lineTo(9, 9);
            ctxClose.moveTo(9, 3);
            ctxClose.lineTo(3, 9);
            ctxClose.stroke();
            btnClose.appendChild(canvasClose);
            // Apply themed 3D style
            applyTitleButtonColors(btnClose, UIObject.getClientConfigValue('defaultColor', initialBg));
            buttonsContainer.appendChild(btnClose);

            this.titleBar.appendChild(buttonsContainer);
            this.element.appendChild(this.titleBar);

            // Update button colors after loading client_config (if not already loaded)
            UIObject.loadClientConfig().then(() => {
                const base = UIObject.getClientConfigValue('defaultColor', initialBg);
                applyTitleButtonColors(btnMinimize, base);
                applyTitleButtonColors(btnMaximize, base);
                applyTitleButtonColors(btnClose, base);
            });

            // Handlers
            btnMinimize.onclick = (e) => {
                e.stopPropagation();
                this.minimize();
            };
            btnMaximize.onclick = (e) => {
                e.stopPropagation();
                this.maximize();
            };
            btnClose.onclick = (e) => {
                e.stopPropagation();
                this.close();
            };

            // Create content area
            this.contentArea = document.createElement('div');
            this.contentArea.style.position = 'relative';
            this.contentArea.style.width = '100%';
            this.contentArea.style.overflow = 'auto';
            this.contentArea.style.boxSizing = 'border-box';
            this.element.appendChild(this.contentArea);

            // Set contentArea height after adding to DOM
            // (when titleBar.offsetHeight is available)
            setTimeout(() => {
                if (this.contentArea && this.titleBar) {
                    this.contentArea.style.height = 'calc(100% - ' + (this.titleBar.offsetHeight + 0) + 'px)';
                }
            }, 0);

            // Add form dragging via title bar
            if (this.movable) {
                this.titleBar.style.cursor = 'move';

                this.titleBar.addEventListener('mousedown', (e) => {
                    if (e.target === this.titleBar || e.target.tagName === 'SPAN') {
                        this.isDragging = true;
                        this.dragOffsetX = e.clientX - this.x;
                        this.dragOffsetY = e.clientY - this.y;
                        e.preventDefault();
                    }
                });

                document.addEventListener('mousemove', (e) => {
                    if (this.isDragging) {
                        this.setX(e.clientX - this.dragOffsetX);
                        let newY = e.clientY - this.dragOffsetY;

                        // Ограничение сверху
                        if (newY < Form.topOffset) newY = Form.topOffset;

                        // Ограничение снизу (чтобы окно не уходило под панель задач)
                        // Разрешаем уходить вниз, но не глубже чем bottomOffset
                        // Или лучше жестко ограничить? "не должны подлезать под меню"
                        // Сделаем жесткое ограничение нижней границы окна
                        const maxBottom = window.innerHeight - Form.bottomOffset;
                        if (newY + this.height > maxBottom) {
                            newY = maxBottom - this.height;
                            // Если окно выше рабочей области, прижимаем к верху
                            if (newY < Form.topOffset) newY = Form.topOffset;
                        }

                        this.setY(newY);
                        this.element.style.left = this.x + 'px';
                        this.element.style.top = this.y + 'px';
                    }
                });

                document.addEventListener('mouseup', () => {
                    this.isDragging = false;
                });
            }

            // Add form resizing
            if (this.resizable) {
                const resizeBorderSize = 4;

                this.element.addEventListener('mousemove', (e) => {
                    if (this.isResizing) return;

                    const rect = this.element.getBoundingClientRect();
                    const mouseX = e.clientX;
                    const mouseY = e.clientY;

                    const nearLeft = mouseX >= rect.left && mouseX <= rect.left + resizeBorderSize;
                    const nearRight = mouseX >= rect.right - resizeBorderSize && mouseX <= rect.right;
                    const nearTop = mouseY >= rect.top && mouseY <= rect.top + resizeBorderSize;
                    const nearBottom = mouseY >= rect.bottom - resizeBorderSize && mouseY <= rect.bottom;

                    if ((nearLeft && nearTop) || (nearRight && nearBottom)) {
                        this.element.style.cursor = 'nwse-resize';
                    } else if ((nearRight && nearTop) || (nearLeft && nearBottom)) {
                        this.element.style.cursor = 'nesw-resize';
                    } else if (nearRight || nearLeft) {
                        this.element.style.cursor = 'ew-resize';
                    } else if (nearBottom || nearTop) {
                        this.element.style.cursor = 'ns-resize';
                    } else {
                        this.element.style.cursor = 'default';
                    }
                });

                this.element.addEventListener('mousedown', (e) => {
                    const rect = this.element.getBoundingClientRect();
                    const mouseX = e.clientX;
                    const mouseY = e.clientY;

                    const nearLeft = mouseX >= rect.left && mouseX <= rect.left + resizeBorderSize;
                    const nearRight = mouseX >= rect.right - resizeBorderSize && mouseX <= rect.right;
                    const nearTop = mouseY >= rect.top && mouseY <= rect.top + resizeBorderSize;
                    const nearBottom = mouseY >= rect.bottom - resizeBorderSize && mouseY <= rect.bottom;

                    if (nearLeft || nearRight || nearTop || nearBottom) {
                        this.isResizing = true;
                        this.resizeDirection = {
                            left: nearLeft,
                            right: nearRight,
                            top: nearTop,
                            bottom: nearBottom
                        };
                        e.preventDefault();
                    }
                });

                document.addEventListener('mousemove', (e) => {
                    if (this.isResizing) {
                        if (this.lockAspectRatio) {
                            // When aspect ratio locked, resize both dimensions proportionally
                            // Simplified implementation for bottom-right corner (as was)
                            // TODO: Add support for other corners for lockAspectRatio
                            if (this.resizeDirection.right || this.resizeDirection.bottom) {
                                const newWidth = e.clientX - this.x;
                                const newHeight = e.clientY - this.y;

                                let targetWidth = newWidth;
                                let targetHeight = newHeight;

                                // Determine what changes and calculate other dimension
                                if (this.resizeDirection.right && this.resizeDirection.bottom) {
                                    // Resize by corner - take average or largest change
                                    const widthRatio = newWidth / this.width;
                                    const heightRatio = newHeight / this.height;

                                    if (Math.abs(widthRatio - 1) > Math.abs(heightRatio - 1)) {
                                        targetHeight = newWidth / this.initialAspectRatio;
                                    } else {
                                        targetWidth = newHeight * this.initialAspectRatio;
                                    }
                                } else if (this.resizeDirection.right) {
                                    targetHeight = newWidth / this.initialAspectRatio;
                                } else if (this.resizeDirection.bottom) {
                                    targetWidth = newHeight * this.initialAspectRatio;
                                }

                                if (targetWidth > 100 && targetHeight > 50) {
                                    this.setWidth(targetWidth);
                                    this.setHeight(targetHeight);
                                    this.element.style.width = this.width + 'px';
                                    this.element.style.height = this.height + 'px';
                                }
                            }
                        } else {
                            // Обычное изменение размера без блокировки пропорций

                            // Right
                            if (this.resizeDirection.right) {
                                const newWidth = e.clientX - this.x;
                                // Проверяем минимальную ширину с учетом заголовка
                                if (this.titleBar) {
                                    const titleBarHeight = this.titleBar.offsetHeight;
                                    const tempWidth = this.element.style.width;
                                    this.element.style.width = newWidth + 'px';
                                    const newTitleBarHeight = this.titleBar.offsetHeight;
                                    // Если заголовок начал переноситься на новую строку, откатываем
                                    if (newTitleBarHeight > titleBarHeight || newWidth < 120) {
                                        this.element.style.width = tempWidth;
                                    } else if (newWidth > 100) {
                                        this.setWidth(newWidth);
                                        this.element.style.width = this.width + 'px';
                                    }
                                } else if (newWidth > 100) {
                                    this.setWidth(newWidth);
                                    this.element.style.width = this.width + 'px';
                                }
                            }

                            // Left
                            if (this.resizeDirection.left) {
                                const newWidth = (this.x + this.width) - e.clientX;
                                if (newWidth > 100) {
                                    // Проверка заголовка
                                    if (this.titleBar) {
                                        const titleBarHeight = this.titleBar.offsetHeight;
                                        const tempWidth = this.element.style.width;
                                        this.element.style.width = newWidth + 'px';
                                        const newTitleBarHeight = this.titleBar.offsetHeight;
                                        if (newTitleBarHeight > titleBarHeight || newWidth < 120) {
                                            this.element.style.width = tempWidth;
                                        } else {
                                            this.setX(e.clientX);
                                            this.setWidth(newWidth);
                                            this.element.style.left = this.x + 'px';
                                            this.element.style.width = this.width + 'px';
                                        }
                                    } else {
                                        this.setX(e.clientX);
                                        this.setWidth(newWidth);
                                        this.element.style.left = this.x + 'px';
                                        this.element.style.width = this.width + 'px';
                                    }
                                }
                            }

                            // Bottom
                            if (this.resizeDirection.bottom) {
                                const newHeight = e.clientY - this.y;
                                if (newHeight > 50) {
                                    this.setHeight(newHeight);
                                    this.element.style.height = this.height + 'px';
                                }
                            }

                            // Top
                            if (this.resizeDirection.top) {
                                let newY = e.clientY;
                                // Top constraint
                                if (newY < Form.topOffset) newY = Form.topOffset;

                                const newHeight = (this.y + this.height) - newY;
                                if (newHeight > 50) {
                                    this.setY(newY);
                                    this.setHeight(newHeight);
                                    this.element.style.top = this.y + 'px';
                                    this.element.style.height = this.height + 'px';
                                }
                            }
                        }
                        // Call onResizing during resize
                        this.onResizing();
                        if (this.proportionalLayout) {
                            this.updateProportionalLayout();
                        }
                    }
                });

                document.addEventListener('mouseup', () => {
                    if (this.isResizing) {
                        this.isResizing = false;
                        this.resizeDirection = null;
                        // Call onResize after resize completes
                        this.onResize();
                    }
                });
            }
        }

        if (container) {
            container.appendChild(this.element);
        }

        // Update modal state if needed
        this.updateModalState();

        // Add event handlers for form
        this.element.addEventListener('mousedown', (e) => {
            this.activate();
        });

        this.element.addEventListener('click', (e) => {
            this.onClick(e);
        });

        this.element.addEventListener('dblclick', (e) => {
            this.onDoubleClick(e);
        });

        this.element.addEventListener('mouseover', (e) => {
            this.onHover(e);
        });

        // Global key handler - triggers only for top form
        if (!Form._globalKeyHandler) {
            Form._globalKeyHandler = (e) => {
                // Find form with max z
                let topForm = null;
                let maxZ = -1;
                Form._allForms.forEach(form => {
                    if (form.z > maxZ) {
                        maxZ = form.z;
                        topForm = form;
                    }
                });

                // Call onKeyPressed only on top form
                if (topForm) {
                    topForm.onKeyPressed(e);
                }
            };

            Form._globalKeyUpHandler = (e) => {
                // Find form with max z
                let topForm = null;
                let maxZ = -1;
                Form._allForms.forEach(form => {
                    if (form.z > maxZ) {
                        maxZ = form.z;
                        topForm = form;
                    }
                });

                // Call onKeyReleased only on top form
                if (topForm) {
                    topForm.onKeyReleased(e);
                }
            };

            document.addEventListener('keydown', Form._globalKeyHandler);
            document.addEventListener('keyup', Form._globalKeyUpHandler);
        }

        // Save reference to form instance in element
        this.element._formInstance = this;
        this.element.setAttribute('data-is-form', 'true');

        // Set z-index for new form
        this.z = ++Form._globalZIndex;
        this.element.style.zIndex = this.z;

        // Dispatch creation event
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('form-created', { detail: { form: this } }));
        }

        return this.element;
    }

    close() {
        if (this.modalOverlay) {
            this.modalOverlay.remove();
            this.modalOverlay = null;
        }
        if (this.element) {
            this.element.remove();
        }
        const index = Form._allForms.indexOf(this);
        if (index > -1) {
            Form._allForms.splice(index, 1);
        }
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('form-destroyed', { detail: { form: this } }));
        }

        // Activate next top form
        let topForm = null;
        let maxZ = -1;
        Form._allForms.forEach(form => {
            // Only consider visible forms
            if (form.element && form.element.style.display !== 'none' && form.z > maxZ) {
                maxZ = form.z;
                topForm = form;
            }
        });

        if (topForm) {
            topForm.activate();
        }
    }

    minimize() {
        // Do not allow minimizing of modal forms
        if (this.isModal) {
            // Small visual feedback on attempted minimize
            if (this.modalOverlay) {
                const prev = this.modalOverlay.style.backgroundColor;
                this.modalOverlay.style.backgroundColor = 'rgba(0,0,0,0.02)';
                setTimeout(() => {
                    if (this.modalOverlay) this.modalOverlay.style.backgroundColor = prev;
                }, 120);
            }
            return;
        }

        if (this.element) {
            this.element.style.display = 'none';
        }
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('form-minimized', { detail: { form: this } }));
        }
    }

    restore() {
        if (this.element) {
            this.element.style.display = '';
            this.activate();
        }
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('form-restored', { detail: { form: this } }));
        }
    }

    maximize() {
        if (this.isMaximized) {
            // Restore
            this.setX(this.restoreX);
            this.setY(this.restoreY);
            this.setWidth(this.restoreWidth);
            this.setHeight(this.restoreHeight);
            this.isMaximized = false;
        } else {
            // Maximize
            this.restoreX = this.x;
            this.restoreY = this.y;
            this.restoreWidth = this.width;
            this.restoreHeight = this.height;

            this.setX(0);
            this.setY(Form.topOffset);
            this.setWidth(window.innerWidth);
            this.setHeight(window.innerHeight - Form.topOffset - Form.bottomOffset);
            this.isMaximized = true;
        }
    }

    onClick(event) {
        // Handle click event
    }

    onDoubleClick(event) {
        // Handle double click event
    }

    onLeftClick(event) {
        // Handle left click event
    }

    onHover(event) {
        // Handle hover event
    }

    onMouseDown(event) {
        // Handle mouse down event
    }

    onMouseUp(event) {
        // Handle mouse up event
    }

    onKeyPressed(event) {
        // Handle key pressed event
    }

    onKeyReleased(event) {
        // Handle key released event
    }

    onResizing() {
        // Handle resizing event (called during resize)
    }

    onResize() {
        // Handle resize event (called after resize completes)
        if (this.proportionalLayout) {
            this.updateProportionalLayout();
        }
    }

    setProportionalLayout(value) {
        this.proportionalLayout = value;
        if (value) {
            this.updateProportionalLayout();
        }
    }

    getProportionalLayout() {
        return this.proportionalLayout;
    }

    setLayoutTarget(target) {
        this.layoutTarget = target;
        if (this.proportionalLayout) {
            this.updateProportionalLayout();
        }
    }

    getLayoutTarget() {
        return this.layoutTarget;
    }

    updateProportionalLayout() {
        const container = this.layoutTarget || this.contentArea;
        if (!container) return;

        // Get container dimensions
        let containerWidth = 0;
        if (container === this.contentArea) {
            containerWidth = this.width;
            // If borders are present, subtract them?
            // Form border is usually handled by box-sizing, but contentArea is inside.
        } else {
            containerWidth = container.clientWidth || parseInt(container.style.width) || 0;
            if (containerWidth === 0 && container.parentElement) {
                // Fallback if clientWidth is 0 (detached) involves guessing or waiting?
                // Try to estimate from parent if standard
            }
        }

        // If container is not attached or has no width yet, we might need to rely on the form width
        if (containerWidth <= 0 && this.layoutTarget && this.layoutTarget.parentElement === this.contentArea) {
            containerWidth = this.width - 20; // approximate padding
        }
        if (containerWidth <= 0) containerWidth = this.width;

        // 1. Collect relevant children (those that are direct children of the target)
        // Since UIObject children are logical, we need to filter those that are conceptually "in" this target.
        // If layoutTarget is set, we can match children's parentElement? 
        // Or simply iterate all logical children and check if their element is in container.

        // However, UIObject.children array is what we have.
        // Let's assume we are arranging the logical children of the Form (or the specialized container if we had a Container class).
        // But here 'this' is the Form. The children might be added to the Form object or just placed in the DOM.
        // The user's code in client.js does: new Label(null) -> draw(scrollContainer).
        // These are NOT logical children of the Form (form.children is empty).
        // So we must look at the DOM elements inside the container.

        const children = Array.from(container.children).filter(el => {
            // Filter out internal helpers like specific spacers if needed, or hidden elements
            if (el.style.display === 'none') return false;
            if (el.tagName === 'CANVAS') return false; // ignore helper canvases if any (e.g. funny decorations)
            // We only want "UI elements"
            // Let's rely on checking if they have absolute position or looking for our class marks?
            // The user wants "elements on the form".
            return true;
        });

        if (children.length === 0) return;

        // 2. Group by Y coordinate (Row detection)
        const tolerance = 10; // pixels
        const rows = [];

        children.forEach(el => {
            if (el.style.position === 'absolute') {
                const y = parseInt(el.style.top) || 0;

                // Find existing row
                let row = rows.find(r => Math.abs(r.y - y) < tolerance);
                if (!row) {
                    row = { y: y, elements: [] };
                    rows.push(row);
                }
                row.elements.push(el);
            }
        });

        // 3. Sort rows by Y
        rows.sort((a, b) => a.y - b.y);

        // 4. Process each row
        const paddingLeft = 10;
        const paddingRight = 10;
        const spacing = 10;
        const availableWidth = containerWidth - paddingLeft - paddingRight;

        rows.forEach(row => {
            // Sort elements by X
            row.elements.sort((a, b) => {
                const ax = parseInt(a.style.left) || 0;
                const bx = parseInt(b.style.left) || 0;
                return ax - bx;
            });

            const count = row.elements.length;
            if (count === 0) return;

            // Calculate width for each element
            // (Available - (count - 1) * spacing) / count
            const itemWidth = Math.floor((availableWidth - (count - 1) * spacing) / count);

            row.elements.forEach((el, index) => {
                const newX = paddingLeft + index * (itemWidth + spacing);
                el.style.left = newX + 'px';
                el.style.width = itemWidth + 'px';

                // Update logical X/Width if the element has a JS wrapper attached
                // We stored 'this' in '_formInstance' for Form, but for generic UIObjects?
                // We didn't store the instance on the element for normal controls in previous code (except Form).
                // Let's check existing code...
                // UI_classes.js: Button class -> no reference on element.
                // But we can try to update styles directly which we did.
            });
        });
    }

    // Resize the form to fit its content. Options: { padW, padH, minWidth, minHeight }
    setSizeToContent(options) {
        options = options || {};
        const padW = (typeof options.padW === 'number') ? options.padW : 20;
        const padH = (typeof options.padH === 'number') ? options.padH : 20;
        const minWidth = (typeof options.minWidth === 'number') ? options.minWidth : 120;
        const minHeight = (typeof options.minHeight === 'number') ? options.minHeight : 80;

        if (!this.element || !this.contentArea) return;

        // Temporarily unset width on contentArea to measure intrinsic width if possible
        const prevWidth = this.contentArea.style.width || '';
        try {
            this.contentArea.style.width = 'auto';
        } catch (e) {
            // ignore
        }

        // Measure content size
        const contentWidth = Math.max(this.contentArea.scrollWidth || 0, this.contentArea.clientWidth || 0);
        const contentHeight = this.contentArea.scrollHeight || 0;

        // Restore previous width style
        try {
            this.contentArea.style.width = prevWidth;
        } catch (e) {
            // ignore
        }

        const titleH = this.titleBar ? this.titleBar.offsetHeight || 0 : 0;

        const targetWidth = Math.max(minWidth, Math.ceil(contentWidth + padW));
        const targetHeight = Math.max(minHeight, Math.ceil(titleH + contentHeight + padH));

        this.setWidth(targetWidth);
        this.setHeight(targetHeight);

        if (this.element) {
            this.element.style.width = this.width + 'px';
            this.element.style.height = this.height + 'px';
        }

        // Update contentArea height to fill remaining space
        if (this.contentArea && this.titleBar) {
            try {
                this.contentArea.style.height = 'calc(100% - ' + (this.titleBar.offsetHeight) + 'px)';
            } catch (e) {
                this.contentArea.style.height = (this.height - titleH) + 'px';
            }
        }

        // Reposition if anchored
        if (this.anchorToWindow) this.updatePositionOnResize();
        if (this.proportionalLayout) this.updateProportionalLayout();
    }
}

// Static properties for form management
Form._globalZIndex = 0;
Form._allForms = []; // Array of all created forms
Form.topOffset = 0; // Top offset (e.g. for menu)
Form.bottomOffset = 0; // Bottom offset (e.g. for taskbar)

// Activate top form after page load
if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => {
        // Give time for all forms creation
        setTimeout(() => {
            if (Form._allForms.length > 0) {
                // Find form with max z
                let topForm = null;
                let maxZ = -1;
                Form._allForms.forEach(form => {
                    if (form.z > maxZ) {
                        maxZ = form.z;
                        topForm = form;
                    }
                });

                // Activate top form
                if (topForm) {
                    topForm.activate();
                }
            }
        }, 100);
    });
}

class Button extends UIObject {

    constructor(parentElement = null) {
        super();
        this.caption = '';
        this.icon = null; // Path to icon file
        this.showIcon = false;
        this.showText = true;
        this.tooltip = ''; // Custom tooltip text
        this.x = 0;
        this.y = 0;
        this.z = 0;
        this.tooltipTimeout = null;
        this.tooltipElement = null;
        if (parentElement) {
            this.parentElement = parentElement;
        } else {
            this.parentElement = null;
        }
    }

    setCaption(caption) {
        this.caption = caption;
        if (this.element) {
            this.updateButtonContent();
        }
    }

    getCaption() {
        return this.caption;
    }
    
    setIcon(iconPath) {
        this.icon = iconPath;
        this.showIcon = !!iconPath;
        if (this.element) {
            this.updateButtonContent();
        }
    }
    
    setTooltip(text) {
        this.tooltip = text;
    }
    
    updateButtonContent() {
        if (!this.element) return;
        
        this.element.innerHTML = '';
        
        if (this.showIcon && this.icon) {
            const iconImg = document.createElement('img');
            iconImg.src = this.icon;
            iconImg.style.width = '16px';
            iconImg.style.height = '16px';
            iconImg.style.verticalAlign = 'middle';
            if (this.showText && this.caption) {
                iconImg.style.marginRight = '4px';
            }
            this.element.appendChild(iconImg);
        }
        
        if (this.showText && this.caption) {
            const textSpan = document.createElement('span');
            textSpan.textContent = this.caption;
            textSpan.style.verticalAlign = 'middle';
            this.element.appendChild(textSpan);
        }
    }
    
    showTooltip(event) {
        const tooltipText = this.tooltip || this.caption;
        if (!tooltipText) return;
        
        if (this.tooltipElement) {
            this.hideTooltip();
        }
        
        this.tooltipElement = document.createElement('div');
        this.tooltipElement.textContent = tooltipText;
        this.tooltipElement.style.position = 'fixed';
        this.tooltipElement.style.backgroundColor = '#ffffcc';
        this.tooltipElement.style.border = '1px solid #000';
        this.tooltipElement.style.padding = '4px 8px';
        this.tooltipElement.style.fontSize = '11px';
        this.tooltipElement.style.fontFamily = 'MS Sans Serif, sans-serif';
        this.tooltipElement.style.zIndex = '10000';
        this.tooltipElement.style.pointerEvents = 'none';
        this.tooltipElement.style.whiteSpace = 'nowrap';
        
        document.body.appendChild(this.tooltipElement);
        
        // Position near cursor
        const x = event.clientX + 10;
        const y = event.clientY + 10;
        this.tooltipElement.style.left = x + 'px';
        this.tooltipElement.style.top = y + 'px';

        // Start a hover watcher to auto-hide tooltip if pointer leaves the button
        try {
            if (this._tooltipHoverWatcher) {
                clearInterval(this._tooltipHoverWatcher);
                this._tooltipHoverWatcher = null;
            }
            const self = this;
            this._tooltipHoverWatcher = setInterval(() => {
                try {
                    if (!self.element || (typeof self.element.matches === 'function' && !self.element.matches(':hover'))) {
                        self.hideTooltip();
                    }
                } catch (e) {
                    // ignore
                }
            }, 200);
        } catch (e) {}
    }
    
    hideTooltip() {
        if (this.tooltipElement) {
            this.tooltipElement.remove();
            this.tooltipElement = null;
        }
        if (this.tooltipTimeout) {
            clearTimeout(this.tooltipTimeout);
            this.tooltipTimeout = null;
        }
        if (this._tooltipHoverWatcher) {
            try { clearInterval(this._tooltipHoverWatcher); } catch (e) {}
            this._tooltipHoverWatcher = null;
        }
    }

    Draw(container) {
        if (!this.element) {
            this.element = document.createElement('button');
            this.element.classList.add('ui-button');
            
            // Update button content (icon and/or text)
            this.updateButtonContent();

            // Set size - if showText is false (icon only), make button square
            if (!this.showText && this.showIcon) {
                // Icon-only button should be square
                if (this.height) {
                    this.element.style.width = this.height + 'px';
                    this.element.style.height = this.height + 'px';
                } else if (this.width) {
                    this.element.style.width = this.width + 'px';
                    this.element.style.height = this.width + 'px';
                }
            } else {
                // Normal button with text
                if (this.width) this.element.style.width = this.width + 'px';
                if (this.height) this.element.style.height = this.height + 'px';
            }
            
            // If parentElement is not set, use absolute positioning
            if (!this.parentElement) {
                this.element.style.position = 'absolute';
                this.element.style.left = this.x + 'px';
                this.element.style.top = this.y + 'px';
                this.element.style.zIndex = this.z;
            } else {
                this.element.style.position = 'relative';
            }

            // Retro button style (colors from client_config)
            const btnBase = UIObject.getClientConfigValue('defaultColor', '#c0c0c0');
            const btnLight = UIObject.brightenColor(btnBase, 60);
            const btnDark = UIObject.brightenColor(btnBase, -60);
            this.element.style.backgroundColor = btnBase;
            this.element.style.borderTop = `2px solid ${btnLight}`;
            this.element.style.borderLeft = `2px solid ${btnLight}`;
            this.element.style.borderRight = `2px solid ${btnDark}`;
            this.element.style.borderBottom = `2px solid ${btnDark}`;
            this.element.style.fontFamily = 'MS Sans Serif, sans-serif';
            this.element.style.fontSize = '11px';
            this.element.style.cursor = 'default';
            this.element.style.outline = 'none';
            this.element.style.boxSizing = 'border-box';
            this.element.style.display = 'inline-flex';
            this.element.style.alignItems = 'center';
            this.element.style.justifyContent = 'center';

            // Load config and update colors if needed
            UIObject.loadClientConfig().then(() => {
                const base = UIObject.getClientConfigValue('defaultColor', btnBase);
                const light = UIObject.brightenColor(base, 60);
                const dark = UIObject.brightenColor(base, -60);
                this.element.style.backgroundColor = base;
                this.element.style.borderTop = `2px solid ${light}`;
                this.element.style.borderLeft = `2px solid ${light}`;
                this.element.style.borderRight = `2px solid ${dark}`;
                this.element.style.borderBottom = `2px solid ${dark}`;
            });

            // Press effect
            this.element.addEventListener('mousedown', (e) => {
                this.element.style.borderTop = '2px solid #808080';
                this.element.style.borderLeft = '2px solid #808080';
                this.element.style.borderRight = '2px solid #ffffff';
                this.element.style.borderBottom = '2px solid #ffffff';
                this.onMouseDown(e);

                // Handler for mouse up anywhere
                const mouseUpHandler = (e) => {
                    this.element.style.borderTop = '2px solid #ffffff';
                    this.element.style.borderLeft = '2px solid #ffffff';
                    this.element.style.borderRight = '2px solid #808080';
                    this.element.style.borderBottom = '2px solid #808080';
                    this.onMouseUp(e);
                    document.removeEventListener('mouseup', mouseUpHandler);
                };
                document.addEventListener('mouseup', mouseUpHandler);
            });

            this.element.addEventListener('click', (e) => {
                this.onClick(e);
            });

            this.element.addEventListener('dblclick', (e) => {
                this.onDoubleClick(e);
            });

            this.element.addEventListener('mouseover', (e) => {
                this.onHover(e);
            });
            
            // Tooltip handlers
            this.element.addEventListener('mouseenter', (e) => {
                this.tooltipTimeout = setTimeout(() => {
                    this.showTooltip(e);
                }, 500);
            });
            
            this.element.addEventListener('mouseleave', () => {
                this.hideTooltip();
            });
            
            this.element.addEventListener('mousemove', (e) => {
                if (this.tooltipElement) {
                    this.tooltipElement.style.left = (e.clientX + 10) + 'px';
                    this.tooltipElement.style.top = (e.clientY + 10) + 'px';
                }
            });
        }

        if (container) {
            container.appendChild(this.element);
        }

        return this.element;
    }
}

class TextBox extends FormInput {

    constructor(parentElement = null, properties = {}) {
        super(parentElement, properties);
        if (typeof this.text === 'undefined' || this.text === null) this.text = '';
        if (typeof this.placeholder === 'undefined' || this.placeholder === null) this.placeholder = '';
        if (typeof this.readOnly === 'undefined' || this.readOnly === null) this.readOnly = false;
        if (typeof this.maxLength === 'undefined' || this.maxLength === null) this.maxLength = null;
        this.showCaption = !!this.caption;
        // Optional behaviors
        this.digitsOnly = !!this.digitsOnly; // when true, allow only digits to be entered
        this.isPassword = !!this.isPassword; // when true, render as password (masked input)
        // Defaults for numeric behavior: when digitsOnly is true, enable floats and negatives by default
        if (this.digitsOnly) {
            if (typeof this.allowFloat === 'undefined') this.allowFloat = true;
            if (typeof this.allowNegative === 'undefined') this.allowNegative = true;
            else { this.allowFloat = !!this.allowFloat; this.allowNegative = !!this.allowNegative; }
            // by default allow any number of decimal places (0 means unlimited)
            if (typeof this.decimalPlaces === 'undefined') this.decimalPlaces = 0;
        } else {
            this.allowFloat = !!this.allowFloat; // when true, allow a single decimal separator
            this.allowNegative = !!this.allowNegative; // when true, allow a leading minus sign
            this.decimalPlaces = this.decimalPlaces ? (this.decimalPlaces | 0) : 0;
        }
        // containerElement and label are handled by FormInput helpers
        this.containerElement = null;
        this.label = null;
        // List mode: when enabled, a small button appears to open a prepared list
        if (typeof this.listMode === 'undefined' || this.listMode === null) this.listMode = false;
        // Optional: show a selection button ("...") to trigger a selection procedure
        if (typeof this.showSelectionButton === 'undefined' || this.showSelectionButton === null) this.showSelectionButton = false;
        // listItems: array of objects { value: any, caption: string }
        if (!Array.isArray(this.listItems)) this.listItems = (properties && properties.listItems) ? properties.listItems : [];
        this._listBtn = null;
        this._listPopup = null;
        this._listOpen = false;
        this._selectBtn = null;
    }

    setText(text) {
        this.text = (text === null || text === undefined) ? '' : String(text);
        if (this.element) {
            try {
                if (this.listMode && Array.isArray(this.listItems)) {
                    const found = this.listItems.find(it => { try { return String(it && it.value) === String(this.text); } catch (_) { return false; } });
                    const display = (found && (typeof found.caption !== 'undefined' && found.caption !== null)) ? String(found.caption) : this.text;
                    this.element.value = display;
                } else {
                    this.element.value = this.text;
                }
            } catch (e) {
                try { this.element.value = this.text; } catch (_) {}
            }
        }
    }

    getText() {
        return this.element ? this.element.value : this.text;
    }

    setPlaceholder(placeholder) {
        this.placeholder = placeholder;
        if (this.element) {
            this.element.placeholder = placeholder;
        }
    }

    getPlaceholder() {
        return this.placeholder;
    }

    setReadOnly(readOnly) {
        this.readOnly = readOnly;
        if (this.element) {
            this.element.readOnly = readOnly;
        }
    }

    getReadOnly() {
        return this.readOnly;
    }

    setMaxLength(maxLength) {
        // zero or falsy means unlimited
        this.maxLength = (typeof maxLength === 'number') ? (maxLength | 0) : (maxLength ? parseInt(maxLength, 10) : 0);
        if (this.element && this.maxLength > 0 && !this.digitsOnly) {
            this.element.maxLength = this.maxLength;
        } else if (this.element && this.maxLength === 0) {
            try { this.element.removeAttribute('maxLength'); } catch (_) {}
        }
    }

    getMaxLength() {
        return this.maxLength;
    }

    setCaption(caption) {
        // Update logical caption and visual label if present
        try { super.setCaption(caption); } catch (e) {}
        this.showCaption = !!caption;
        if (this.label) {
            this.label.setText(caption ? (caption + ':') : caption);
        }
    }

    Draw(container) {
        // Call base to prepare container/label
        super.Draw(container);

        if (!this.element) {
            this.element = document.createElement('input');
            this.element.classList.add('ui-input');
            // Password support: if requested, use password type
            this.element.type = this.isPassword ? 'password' : 'text';
            // Initialize displayed text via setText so listMode can show caption
            try { this.setText(this.text); } catch (_) { try { this.element.value = this.text; } catch (_) {} }
            this.element.placeholder = this.placeholder;
            this.element.readOnly = this.readOnly;
            // If we have a host container, use it; otherwise element will be appended to container below
            if (this.containerElement) {
                // If absolute positioning is desired when no parentElement is set on the control,
                // keep behaviour of setting position on the containerElement only when control was created
                // via ensureContainer (which implies a parentElement exists). For consistency, don't
                // override positioning here.
            }

            this.inputContainer = document.createElement('div');
            this.inputContainer.classList.add('ui-input-container');
            this.inputContainer.style.display = 'flex';
            this.inputContainer.style.flexDirection = 'row';
            this.inputContainer.style.alignItems = 'center';
            this.inputContainer.style.width = '100%';
            this.inputContainer.style.boxSizing = 'border-box';
            // Retro border for the input container to match the input itself
            try {
                const tbBase = UIObject.getClientConfigValue('defaultColor', '#c0c0c0');
                const tbLight = UIObject.brightenColor(tbBase, 60);
                const tbDark = UIObject.brightenColor(tbBase, -60);
                this.inputContainer.style.backgroundColor = '#ffffff';
                this.inputContainer.style.borderTop = `2px solid ${tbDark}`;
                this.inputContainer.style.borderLeft = `2px solid ${tbDark}`;
                this.inputContainer.style.borderRight = `2px solid ${tbLight}`;
                this.inputContainer.style.borderBottom = `2px solid ${tbLight}`;
                this.inputContainer.style.boxSizing = 'border-box';

                UIObject.loadClientConfig().then(() => {
                    try {
                        const base = UIObject.getClientConfigValue('defaultColor', tbBase);
                        const light = UIObject.brightenColor(base, 60);
                        const dark = UIObject.brightenColor(base, -60);
                        this.inputContainer.style.borderTop = `2px solid ${dark}`;
                        this.inputContainer.style.borderLeft = `2px solid ${dark}`;
                        this.inputContainer.style.borderRight = `2px solid ${light}`;
                        this.inputContainer.style.borderBottom = `2px solid ${light}`;
                    } catch (e) {}
                }).catch(()=>{});
            } catch (e) {}

            // Configure input to participate in flex layout and fill remaining space
            this.element.style.position = this.element.style.position || 'relative';
            this.element.style.flex = '1 1 auto';
            this.element.style.width = 'auto';
            this.element.style.height = this.element.style.height || 'auto';

            /*
            // Append input into containerElement if present, otherwise into provided container
            try {
                if (this.containerElement) this.containerElement.appendChild(this.element);
                else if (container) container.appendChild(this.element);
            } catch (e) {}
            */
            try {
                if (this.containerElement) this.containerElement.appendChild(this.inputContainer);
                else if (container) container.appendChild(this.inputContainer);
            } catch (e) {}
            this.inputContainer.appendChild(this.element);

            // If requested, add selection button ("...") to the input container.
            // It should appear to the right of the input and (if present) to the left of the dropdown list button.
            try {
                if (this.showSelectionButton) {
                    if (!this._selectBtn) {
                        const sbtn = document.createElement('button');
                        sbtn.type = 'button';
                        sbtn.tabIndex = -1;
                        sbtn.textContent = '...';
                        sbtn.style.flex = '0 0 22px';
                        sbtn.style.height = '100%';
                        sbtn.style.minWidth = '22px';
                        sbtn.style.display = 'inline-flex';
                        sbtn.style.alignItems = 'center';
                        sbtn.style.justifyContent = 'center';
                        sbtn.style.margin = '0';
                        sbtn.style.padding = '0';
                        sbtn.style.fontFamily = 'MS Sans Serif, sans-serif';
                        sbtn.style.fontSize = '12px';
                        sbtn.style.boxSizing = 'border-box';
                        sbtn.style.cursor = 'default';
                        const base = UIObject.getClientConfigValue('defaultColor', '#c0c0c0');
                        const light = UIObject.brightenColor(base, 60);
                        const dark = UIObject.brightenColor(base, -60);
                        sbtn.style.borderTop = `2px solid ${light}`;
                        sbtn.style.borderLeft = `2px solid ${light}`;
                        sbtn.style.borderRight = `2px solid ${dark}`;
                        sbtn.style.borderBottom = `2px solid ${dark}`;
                        sbtn.addEventListener('click', (ev) => { try { ev.stopPropagation(); ev.preventDefault(); this.onSelectionStart(); } catch (_) {} });
                        this._selectBtn = sbtn;
                        this.inputContainer.appendChild(this._selectBtn);
                    }
                }
            } catch (e) {}


            // Adaptive layout: if container is wide enough, place label left and input right (row).
            // If narrow, stack label above input (column).
            const updateLayout = () => {
                try {
                    const cw = (this.containerElement && this.containerElement.clientWidth) || (container && container.clientWidth) || this.width || 0;
                    const lblW = (this.label && this.label.element) ? (this.label.element.scrollWidth || this.label.element.offsetWidth || 0) : 0;
                    const gap = parseInt(this.containerElement.style.gap) || 8;
                    const minInput = Math.min(120, Math.max(60, Math.floor(cw * 0.4)));

                    if (cw > 0 && (lblW + gap + minInput) <= cw) {
                        this.containerElement.style.flexDirection = 'row';
                        if (this.label && this.label.element) {
                            this.label.element.style.flex = '0 0 auto';
                            this.label.element.style.width = 'auto';
                        }
                        this.element.style.flex = '1 1 auto';
                        this.element.style.width = 'auto';
                    } else {
                        this.containerElement.style.flexDirection = 'column';
                        if (this.label && this.label.element) {
                            this.label.element.style.flex = '0 0 100%';
                            this.label.element.style.width = '100%';
                        }
                        this.element.style.flex = '0 0 100%';
                        this.element.style.width = '100%';
                    }
                } catch (e) {}
            };

            // Initial layout
            setTimeout(updateLayout, 0);

            // Observe size changes
            try {
                if (typeof ResizeObserver !== 'undefined') {
                    if (this._ro) try { this._ro.disconnect(); } catch (e) {}
                    this._ro = new ResizeObserver(updateLayout);
                    this._ro.observe(this.containerElement);
                } else {
                    // fallback
                    const winHandler = () => updateLayout();
                    if (this._winHandler) window.removeEventListener('resize', this._winHandler);
                    this._winHandler = winHandler;
                    window.addEventListener('resize', winHandler);
                }
            } catch (e) {}

            // Add unique id to eliminate browser warning
            this.element.id = 'textbox_' + Math.random().toString(36).substr(2, 9);
            this.element.name = this.element.id;

            if (this.maxLength && !this.digitsOnly) {
                try { this.element.maxLength = this.maxLength; } catch (_) {}
            } else if (this.digitsOnly) {
                try { this.element.removeAttribute && this.element.removeAttribute('maxLength'); } catch (_) {}
            }

            // label already drawn above when input was prepared

            // Retro textbox style: white background, themed borders from client_config
            const tbBase = UIObject.getClientConfigValue('defaultColor', '#c0c0c0');
            const tbLight = UIObject.brightenColor(tbBase, 60);
            const tbDark = UIObject.brightenColor(tbBase, -60);
            this.element.style.backgroundColor = '#ffffff';
            this.element.style.border = 'none';
            // Border for the raw input is intentionally commented out —
            // visual border is applied to the input container (`inputContainer`).
            // this.element.style.borderTop = `2px solid ${tbDark}`;
            // this.element.style.borderLeft = `2px solid ${tbDark}`;
            // this.element.style.borderRight = `2px solid ${tbLight}`;
            // this.element.style.borderBottom = `2px solid ${tbLight}`;
            this.element.style.fontFamily = 'MS Sans Serif, sans-serif';
            this.element.style.fontSize = '11px';
            this.element.style.padding = '2px 4px';
            this.element.style.outline = 'none';
            this.element.style.boxSizing = 'border-box';

            // Load config and update if needed
            UIObject.loadClientConfig().then(() => {
                const base = UIObject.getClientConfigValue('defaultColor', tbBase);
                const light = UIObject.brightenColor(base, 60);
                const dark = UIObject.brightenColor(base, -60);
                this.element.style.backgroundColor = '#ffffff';
                // Keep input borders controlled by the container; skip updating element borders
                // this.element.style.borderTop = `2px solid ${dark}`;
                // this.element.style.borderLeft = `2px solid ${dark}`;
                // this.element.style.borderRight = `2px solid ${light}`;
                // this.element.style.borderBottom = `2px solid ${light}`;
            });

            // If listMode is enabled, add a small Win95-style button at right to open prepared list
            try {
                // remove stale button/popup if present and mode disabled
                if (!this.listMode && this._listBtn) {
                    try { this._listBtn.remove(); } catch (_) {}
                    this._listBtn = null;
                    try { this._closeList && this._closeList(); } catch (_) {}
                }

                if (this.listMode) {
                    // create button if missing
                    if (!this._listBtn) {
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.tabIndex = -1;
                        // Create glyph in a child span and visually scale it so the
                        // symbol appears larger without affecting layout (transforms
                        // don't change document flow size).
                        const glyph = document.createElement('span');
                        glyph.textContent = '▾';
                        glyph.style.display = 'inline-block';
                        glyph.style.fontFamily = 'MS Sans Serif, sans-serif';
                        glyph.style.fontSize = '11px';
                        glyph.style.lineHeight = '1';
                        glyph.style.transform = 'scale(1.25)';
                        glyph.style.transformOrigin = 'center';
                        glyph.style.pointerEvents = 'none';
                        // Button sizing stays small so layout (height) doesn't change
                        // make button slightly narrower while preserving height
                        btn.style.flex = '0 0 18px';
                        btn.style.height = '100%';
                        btn.style.minWidth = '18px';
                        btn.style.display = 'inline-flex';
                        btn.style.alignItems = 'center';
                        btn.style.justifyContent = 'center';
                        btn.style.margin = '0';
                        btn.style.padding = '0';
                        btn.style.fontFamily = 'MS Sans Serif, sans-serif';
                        btn.style.fontSize = '11px';
                        // Use default cursor (avoid pointer/hand) to keep native text cursor on input
                        btn.style.cursor = 'default';
                        btn.style.boxSizing = 'border-box';
                        btn.style.overflow = 'visible';
                        btn.appendChild(glyph);
                        // Win95-style raised button (use tbDark/tbLight derived colors)
                        const base = UIObject.getClientConfigValue('defaultColor', '#c0c0c0');
                        const light = UIObject.brightenColor(base, 60);
                        const dark = UIObject.brightenColor(base, -60);
                        btn.style.borderTop = `2px solid ${light}`;
                        btn.style.borderLeft = `2px solid ${light}`;
                        btn.style.borderRight = `2px solid ${dark}`;
                        btn.style.borderBottom = `2px solid ${dark}`;

                        // handlers
                        btn.addEventListener('click', (ev) => {
                            try { ev.stopPropagation(); } catch (_) {}
                            try { this._toggleList && this._toggleList(); } catch (_) {}
                        });

                        this._listBtn = btn;
                        /*
                        try {
                            if (this.containerElement) this.containerElement.appendChild(this._listBtn);
                            else if (container) container.appendChild(this._listBtn);
                        } catch (_) {}
                         */
                        this.inputContainer.appendChild(this._listBtn);
                    }

                    // implement open/close/toggle helpers on the instance
                    if (!this._openList) {
                        this._openList = () => {
                            try {
                                if (this._listOpen) return;
                                // build popup
                                const popup = document.createElement('div');
                                popup.className = 'textbox-list-popup';
                                popup.style.position = 'absolute';
                                popup.style.backgroundColor = '#ffffff';
                                const base = UIObject.getClientConfigValue('defaultColor', '#c0c0c0');
                                const light = UIObject.brightenColor(base, 60);
                                const dark = UIObject.brightenColor(base, -60);
                                // No visible frame for dropdown popup
                                popup.style.border = 'none';
                                popup.style.fontFamily = 'MS Sans Serif, sans-serif';
                                popup.style.fontSize = '11px';
                                popup.style.zIndex = '99999';
                                popup.style.boxSizing = 'border-box';
                                // restore default inner padding
                                popup.style.padding = '2px';
                                // soft shadow instead of visible frame
                                popup.style.boxShadow = '0 4px 10px rgba(0,0,0,0.25)';
                                popup.style.minWidth = (this.containerElement ? this.containerElement.clientWidth : (container ? container.clientWidth : 120)) + 'px';

                                // populate items
                                const items = Array.isArray(this.listItems) ? this.listItems : [];
                                for (let i = 0; i < items.length; i++) {
                                    const it = items[i] || {};
                                    const row = document.createElement('div');
                                    row.style.padding = '3px 6px';
                                    row.style.cursor = 'pointer';
                                    row.style.userSelect = 'none';
                                    row.textContent = (typeof it.caption !== 'undefined' && it.caption !== null) ? String(it.caption) : String(it.value);
                                    row.addEventListener('mouseenter', () => { row.style.backgroundColor = '#b0b0b0'; });
                                    row.addEventListener('mouseleave', () => { row.style.backgroundColor = ''; });
                                    row.addEventListener('click', (e) => {
                                        try {
                                            // set underlying value; setText will display caption when available
                                            this.setText(it.value);
                                            // notify any listeners (so clients can pick up the new value)
                                            try { if (this.element) this.element.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
                                        } catch (_) {}
                                        try { this._closeList && this._closeList(); } catch (_) {}
                                    });
                                    popup.appendChild(row);
                                }

                                // Rows will be made focusable and the matching row will be focused
                                // after the popup is attached to the document to ensure focus() works.

                                // position popup under the container
                                const rect = (this.containerElement || container).getBoundingClientRect();
                                popup.style.left = (rect.left + (window.pageXOffset || document.documentElement.scrollLeft)) + 'px';
                                popup.style.top = (rect.bottom + (window.pageYOffset || document.documentElement.scrollTop)) + 'px';

                                document.body.appendChild(popup);
                                this._listPopup = popup;
                                this._listOpen = true;

                                // After popup is in DOM, make rows focusable and focus the
                                // one matching current value (or first). Doing this after
                                // append ensures document.activeElement will reflect the
                                // focused row so arrow-key navigation works correctly.
                                try {
                                    const rowsEls = Array.from(popup.children || []);
                                    // clear previous visuals/flags
                                    rowsEls.forEach(r => { try { r.tabIndex = -1; r.style.backgroundColor = ''; r.removeAttribute && r.removeAttribute('data-selected'); } catch (_) {} });
                                    let selIndex = -1;
                                    try {
                                        const curVal = (typeof this.text !== 'undefined' && this.text !== null) ? String(this.text) : String(this.element && this.element.value || '');
                                        for (let i = 0; i < items.length; i++) {
                                            const it = items[i] || {};
                                            if (String(it.value) === curVal || String(it.caption) === curVal) { selIndex = i; break; }
                                        }
                                    } catch (_) {}
                                    if (selIndex === -1 && rowsEls.length > 0) selIndex = 0;
                                    if (selIndex >= 0 && rowsEls[selIndex]) {
                                        try { rowsEls[selIndex].tabIndex = 0; rowsEls[selIndex].focus(); rowsEls[selIndex].style.backgroundColor = '#b0b0b0'; rowsEls[selIndex].setAttribute && rowsEls[selIndex].setAttribute('data-selected', '1'); } catch (_) {}
                                    }
                                } catch (_) {}

                                // keyboard navigation: arrows move, Enter/Space select, Esc close
                                try {
                                    this._listKeyHandler = (ev) => {
                                        try {
                                            const k = ev.key;
                                            const rows = Array.from(popup.children || []);
                                            if (!rows.length) return;
                                            const active = document.activeElement;
                                            let idx = rows.indexOf(active);
                                            // fallback: if activeElement isn't part of rows (idx == -1),
                                            // find the row that has the highlight/data-selected flag
                                            if (idx === -1) {
                                                idx = rows.findIndex(r => {
                                                    try { return (r.getAttribute && r.getAttribute('data-selected') === '1') || (r.style && r.style.backgroundColor === '#b0b0b0'); } catch(_) { return false; }
                                                });
                                            }

                                            if (k === 'ArrowDown') {
                                                ev.preventDefault();
                                                let next = (idx >= 0 && idx < rows.length - 1) ? rows[idx + 1] : rows[0];
                                                try {
                                                    rows.forEach(r => { try { r.style.backgroundColor = ''; r.removeAttribute && r.removeAttribute('data-selected'); r.tabIndex = -1; } catch(_){} });
                                                    next.tabIndex = 0; next.focus(); next.style.backgroundColor = '#b0b0b0'; next.setAttribute && next.setAttribute('data-selected', '1');
                                                } catch(_){ }
                                            } else if (k === 'ArrowUp') {
                                                ev.preventDefault();
                                                let prev = (idx > 0) ? rows[idx - 1] : rows[rows.length - 1];
                                                try {
                                                    rows.forEach(r => { try { r.style.backgroundColor = ''; r.removeAttribute && r.removeAttribute('data-selected'); r.tabIndex = -1; } catch(_){} });
                                                    prev.tabIndex = 0; prev.focus(); prev.style.backgroundColor = '#b0b0b0'; prev.setAttribute && prev.setAttribute('data-selected', '1');
                                                } catch(_){ }
                                            } else if (k === 'Enter' || k === ' ') {
                                                ev.preventDefault();
                                                try { if (active && popup.contains(active)) active.click(); } catch(_){}
                                            } else if (k === 'Escape') {
                                                ev.preventDefault();
                                                try { this._closeList && this._closeList(); } catch(_){}
                                            }
                                        } catch (_) {}
                                    };
                                    // Attach key handler on document (capture) so we reliably
                                    // intercept Arrow keys and prevent the underlying form
                                    // from scrolling when popup is open.
                                    document.addEventListener('keydown', this._listKeyHandler, true);
                                } catch (_) {}

                                // click outside closes
                                this._listDocHandler = (ev) => {
                                    try {
                                        if (!popup.contains(ev.target) && this._listBtn && !this._listBtn.contains(ev.target)) {
                                            this._closeList && this._closeList();
                                        }
                                    } catch (_) {}
                                };
                                document.addEventListener('click', this._listDocHandler);

                                // Close the popup when the page/layout changes in ways
                                // that can detach the popup from its input (scroll/resize/move)
                                this._listScrollHandler = (ev) => {
                                    try {
                                        // If the interaction started inside the popup, list button, or input, don't close.
                                        if (ev && ev.target) {
                                            try {
                                                const t = ev.target;
                                                if (this._listPopup && this._listPopup.contains(t)) return;
                                                if (this._listBtn && this._listBtn.contains(t)) return;
                                                if (this.element && (this.element === t || (this.inputContainer && this.inputContainer.contains(t)))) return;
                                            } catch(_) {}
                                        }
                                        this._closeList && this._closeList();
                                    } catch(_) {}
                                };
                                try {
                                    window.addEventListener('scroll', this._listScrollHandler, true);
                                } catch(_) {}
                                try {
                                    window.addEventListener('resize', this._listScrollHandler);
                                } catch(_) {}
                                try {
                                    window.addEventListener('orientationchange', this._listScrollHandler);
                                } catch(_) {}
                                try {
                                    // capture wheel events so scrolling via mouse wheel closes popup
                                    window.addEventListener('wheel', this._listScrollHandler, true);
                                } catch(_) {}
                                try {
                                    // detect start of pointer/drag interactions (scrollbar drag, touch, etc.)
                                    window.addEventListener('pointerdown', this._listScrollHandler, true);
                                } catch(_) {}
                                try {
                                    window.addEventListener('mousedown', this._listScrollHandler, true);
                                } catch(_) {}
                                try {
                                    window.addEventListener('touchstart', this._listScrollHandler, { capture: true, passive: true });
                                } catch(_) {}

                                // Observe DOM changes on the container (or body as fallback)
                                try {
                                    const observeTarget = (this.containerElement || container) || document.body;
                                    if (typeof MutationObserver !== 'undefined') {
                                        this._listMutationObserver = new MutationObserver((mutations) => {
                                            try { this._closeList && this._closeList(); } catch(_) {}
                                        });
                                        try {
                                            this._listMutationObserver.observe(observeTarget, { attributes: true, childList: true, subtree: true });
                                        } catch(_) {
                                            // if observing specific target fails, observe body
                                            try { this._listMutationObserver.observe(document.body, { attributes: true, childList: true, subtree: true }); } catch(_) {}
                                        }
                                    }
                                } catch(_) {}
                            } catch (e) { }
                        };

                        this._closeList = () => {
                            try {
                                if (this._listPopup) {
                                    try { 
                                        if (this._listKeyHandler) {
                                            try { document.removeEventListener('keydown', this._listKeyHandler, true); } catch(_){}
                                            this._listKeyHandler = null;
                                        }
                                        this._listPopup.remove(); 
                                    } catch (_) { document.body.removeChild(this._listPopup); }
                                }
                                this._listPopup = null;
                                this._listOpen = false;
                                if (this._listDocHandler) { try { document.removeEventListener('click', this._listDocHandler); } catch (_) {} }
                                this._listDocHandler = null;

                                // remove scroll/resize/wheel/orientation listeners added on open
                                try { if (this._listScrollHandler) { try { window.removeEventListener('scroll', this._listScrollHandler, true); } catch(_){} } } catch(_){ }
                                try { if (this._listScrollHandler) { try { window.removeEventListener('resize', this._listScrollHandler); } catch(_){} } } catch(_){ }
                                try { if (this._listScrollHandler) { try { window.removeEventListener('orientationchange', this._listScrollHandler); } catch(_){} } } catch(_){ }
                                try { if (this._listScrollHandler) { try { window.removeEventListener('wheel', this._listScrollHandler, true); } catch(_){} } } catch(_){ }
                                try { if (this._listScrollHandler) { try { window.removeEventListener('pointerdown', this._listScrollHandler, true); } catch(_){} } } catch(_){ }
                                try { if (this._listScrollHandler) { try { window.removeEventListener('mousedown', this._listScrollHandler, true); } catch(_){} } } catch(_){ }
                                try { if (this._listScrollHandler) { try { window.removeEventListener('touchstart', this._listScrollHandler, { capture: true, passive: true }); } catch(_){} } } catch(_){ }
                                this._listScrollHandler = null;

                                // disconnect mutation observer
                                try { if (this._listMutationObserver) { try { this._listMutationObserver.disconnect(); } catch(_){} } } catch(_){}
                                this._listMutationObserver = null;
                            } catch (_) {}
                        };

                        this._toggleList = () => {
                            try { if (this._listOpen) this._closeList(); else this._openList(); } catch (_) {}
                        };
                    }
                }
            } catch (e) {}

            // Events
            this.element.addEventListener('input', (e) => {
                try {
                    if (this.digitsOnly) {
                        let v = (e.target.value || '');
                        let sign = '';
                        if (this.allowNegative && v.startsWith('-')) {
                            sign = '-';
                            v = v.slice(1);
                        }
                        // normalize comma to dot
                        v = v.replace(/,/g, '.');
                        if (this.allowFloat) {
                            // remove anything except digits and dot
                            v = v.replace(/[^0-9.]/g, '');
                            // collapse multiple dots to a single dot (keep first)
                            const parts = v.split('.');
                            if (parts.length > 1) v = parts.shift() + '.' + parts.join('');
                            // enforce decimalPlaces if set (>0)
                            if (this.decimalPlaces && this.decimalPlaces > 0) {
                                const idx = v.indexOf('.');
                                if (idx !== -1) {
                                    const intPart = v.slice(0, idx);
                                    let frac = v.slice(idx + 1);
                                    if (frac.length > this.decimalPlaces) frac = frac.slice(0, this.decimalPlaces);
                                    v = intPart + '.' + frac;
                                }
                            }
                        } else {
                            v = v.replace(/\D+/g, '');
                        }
                        // enforce maxLength on digits (dot not counted)
                        const cleanedDigits = (sign + v).replace(/[^0-9]/g, '');
                        let cleaned = sign + v;
                        if (this.maxLength && this.maxLength > 0 && cleanedDigits.length > this.maxLength) {
                            // remove trailing digits until within limit
                            let needed = cleanedDigits.length - this.maxLength;
                            // iterate from end and remove digit characters
                            let arr = v.split('');
                            for (let i = arr.length - 1; i >= 0 && needed > 0; i--) {
                                if (/[0-9]/.test(arr[i])) { arr.splice(i, 1); needed--; }
                            }
                            v = arr.join('');
                            cleaned = sign + v;
                        }
                        if (cleaned !== e.target.value) {
                            const pos = e.target.selectionStart || 0;
                            e.target.value = cleaned;
                            try { e.target.setSelectionRange(Math.max(0, pos - 1), Math.max(0, pos - 1)); } catch (_) {}
                        }
                        this.text = cleaned;
                    } else {
                        this.text = e.target.value;
                    }
                } catch (ex) {
                    this.text = e.target.value;
                }
            });

            this.element.addEventListener('click', (e) => {
                this.onClick(e);
                try {
                    // Ensure the input receives focus even when readOnly so keyboard
                    // focus behavior remains consistent and focus handlers run.
                    try { if (this.element && typeof this.element.focus === 'function') this.element.focus(); } catch (_) {}

                    if (this.listMode) {
                        // Prevent the document-level click handler from seeing this
                        // click and immediately closing the newly opened popup.
                        try { e.stopPropagation(); } catch (_) {}
                        try { if (!this._listOpen) this._openList && this._openList(); } catch (_) {}
                    }
                } catch (_) {}
            });

            this.element.addEventListener('dblclick', (e) => {
                this.onDoubleClick(e);
            });

            this.element.addEventListener('keydown', (e) => {
                if (this.digitsOnly) {
                    // allow control combinations
                    if (e.ctrlKey || e.metaKey || e.altKey) return;
                    const k = e.key;
                    // allow digits (but may be blocked later if maxLength/decimalPlaces exceeded)
                    if (/^\d$/.test(k)) {
                        // enforce digit-count limit if configured
                        if (this.maxLength && this.maxLength > 0) {
                            try {
                                const el = e.target;
                                const selStart = typeof el.selectionStart === 'number' ? el.selectionStart : 0;
                                const selEnd = typeof el.selectionEnd === 'number' ? el.selectionEnd : selStart;
                                const cur = el.value || '';
                                const newVal = cur.slice(0, selStart) + k + cur.slice(selEnd);
                                const digits = newVal.replace(/[^0-9]/g, '');
                                if (digits.length > this.maxLength) { e.preventDefault(); return; }
                            } catch (_) {}
                        }
                        // enforce decimalPlaces if inserting into fractional part
                        if (this.allowFloat && this.decimalPlaces && this.decimalPlaces > 0) {
                            try {
                                const el = e.target;
                                const selStart = typeof el.selectionStart === 'number' ? el.selectionStart : 0;
                                const cur = el.value || '';
                                const dot = cur.indexOf('.');
                                if (dot !== -1 && selStart > dot) {
                                    const frac = cur.slice(dot + 1);
                                    const selEnd = typeof el.selectionEnd === 'number' ? el.selectionEnd : selStart;
                                    const replacedLen = Math.max(0, Math.min(selEnd, cur.length) - Math.min(selStart, cur.length));
                                    const fracLenAfter = frac.length - Math.max(0, Math.min(replacedLen, frac.length)) + 1; // +1 for new digit
                                    if (fracLenAfter > this.decimalPlaces) { e.preventDefault(); return; }
                                }
                            } catch (_) {}
                        }
                        return;
                    }
                    // allow navigation and editing keys
                    const allowed = ['Backspace','Tab','Enter','Escape','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'];
                    if (allowed.indexOf(k) !== -1) return;
                    // allow decimal separator if floats allowed
                    if ((k === '.' || k === ',') && this.allowFloat) return;
                    // toggle minus sign when pressed anywhere if negatives allowed
                    if ((k === '-' || k === '−') && this.allowNegative) {
                        try {
                            e.preventDefault();
                            const el = e.target;
                            const cur = el.value || '';
                            const selStart = typeof el.selectionStart === 'number' ? el.selectionStart : 0;
                            const selEnd = typeof el.selectionEnd === 'number' ? el.selectionEnd : selStart;
                            if (cur.startsWith('-')) {
                                // remove leading minus
                                const newVal = cur.slice(1);
                                el.value = newVal;
                                // adjust caret/selection
                                try {
                                    const ns = Math.max(0, selStart - 1);
                                    const ne = Math.max(0, selEnd - 1);
                                    el.setSelectionRange(ns, ne);
                                } catch (_) {}
                            } else {
                                // add leading minus
                                const newVal = '-' + cur;
                                el.value = newVal;
                                try {
                                    const ns = selStart + 1;
                                    const ne = selEnd + 1;
                                    el.setSelectionRange(ns, ne);
                                } catch (_) {}
                            }
                        } catch (_) {}
                        return;
                    }
                    // otherwise block
                    e.preventDefault();
                    return;
                }
                this.onKeyPressed(e);
            });

            // Sanitize pasted input when digitsOnly is enabled
            this.element.addEventListener('paste', (e) => {
                if (!this.digitsOnly) return;
                try {
                    e.preventDefault();
                    const data = (e.clipboardData || window.clipboardData).getData('text') || '';
                    let v = data || '';
                    let sign = '';
                    if (this.allowNegative && v.startsWith('-')) {
                        sign = '-';
                        v = v.slice(1);
                    }
                    v = v.replace(/,/g, '.');
                    if (this.allowFloat) {
                        v = v.replace(/[^0-9.]/g, '');
                        const parts = v.split('.');
                        if (parts.length > 1) v = parts.shift() + '.' + parts.join('');
                        // enforce decimalPlaces
                        if (this.decimalPlaces && this.decimalPlaces > 0) {
                            const idx = v.indexOf('.');
                            if (idx !== -1) {
                                const intPart = v.slice(0, idx);
                                let frac = v.slice(idx + 1);
                                if (frac.length > this.decimalPlaces) frac = frac.slice(0, this.decimalPlaces);
                                v = intPart + '.' + frac;
                            }
                        }
                    } else {
                        v = v.replace(/\D+/g, '');
                    }
                    // enforce maxLength on digits
                    if (this.maxLength && this.maxLength > 0) {
                        let digits = (sign + v).replace(/[^0-9]/g, '');
                        if (digits.length > this.maxLength) {
                            // trim trailing digits
                            let needed = digits.length - this.maxLength;
                            let arr = v.split('');
                            for (let i = arr.length - 1; i >= 0 && needed > 0; i--) {
                                if (/[0-9]/.test(arr[i])) { arr.splice(i, 1); needed--; }
                            }
                            v = arr.join('');
                        }
                    }
                    const cleaned = sign + v;
                    if (cleaned.length) document.execCommand('insertText', false, cleaned);
                } catch (_) {}
            });

            // Hint to mobile keyboards
            if (this.digitsOnly) {
                try { this.element.inputMode = this.allowFloat ? 'decimal' : 'numeric'; } catch (_) {}
                try {
                    if (this.allowFloat) {
                        this.element.pattern = this.allowNegative ? '-?[0-9]*\.?[0-9]*' : '[0-9]*\.?[0-9]*';
                    } else {
                        this.element.pattern = this.allowNegative ? '-?[0-9]*' : '[0-9]*';
                    }
                } catch (_) {}
            }

            // Ensure placeholder and readonly are applied after setup
            try { if (typeof this.placeholder !== 'undefined') this.element.placeholder = this.placeholder; } catch (_) {}
            try { if (typeof this.readOnly !== 'undefined') this.element.readOnly = !!this.readOnly; } catch (_) {}

            // focus/blur border changes moved to container; skip on-element border edits
            this.element.addEventListener('focus', (e) => {
                try {
                    // Open list on focus when in listMode
                    if (this.listMode) {
                        try { this._openList && this._openList(); } catch (_) {}
                    }
                } catch (_) {}
                // this.element.style.borderTop = '2px solid #000080';
                // this.element.style.borderLeft = '2px solid #000080';
            });

            this.element.addEventListener('blur', (e) => {
                // this.element.style.borderTop = '2px solid #808080';
                // this.element.style.borderLeft = '2px solid #808080';
            });

            // Finalize attribute application and log diagnostics to help debug property propagation
            try {
                // Ensure placeholder and readonly are applied
                if (typeof this.placeholder !== 'undefined') {
                    try { this.element.placeholder = this.placeholder; } catch (_) {}
                }
                try { this.element.readOnly = !!this.readOnly; } catch (_) {}

                // Apply maxLength only for non-numeric textboxes; for numeric we enforce digit-count separately
                try {
                    if (!this.digitsOnly) {
                        if (this.maxLength && this.maxLength > 0) this.element.maxLength = this.maxLength;
                        else this.element.removeAttribute && this.element.removeAttribute('maxLength');
                    } else {
                        // ensure no maxLength attribute remains on numeric inputs
                        try { this.element.removeAttribute && this.element.removeAttribute('maxLength'); } catch (_) {}
                    }
                } catch (_) {}

                // Diagnostic log
                try { console.debug && console.debug('TextBox init', { id: this.element.id, digitsOnly: this.digitsOnly, placeholder: this.placeholder, readOnly: this.readOnly, maxLength: this.maxLength, decimalPlaces: this.decimalPlaces, allowFloat: this.allowFloat, allowNegative: this.allowNegative }); } catch (_) {}
            } catch (_) {}
        }

        // Attach diagnostic dataset so DevTools shows passed properties on the element
        try {
            if (this.element) {
                const props = {
                    digitsOnly: !!this.digitsOnly,
                    isPassword: !!this.isPassword,
                    placeholder: this.placeholder || '',
                    readOnly: !!this.readOnly,
                    maxLength: this.maxLength || 0,
                    decimalPlaces: this.decimalPlaces || 0,
                    allowFloat: !!this.allowFloat,
                    allowNegative: !!this.allowNegative
                };
                try { this.element.dataset.props = JSON.stringify(props); } catch (_) {}
                try { if (this.placeholder !== undefined && this.placeholder !== null) this.element.setAttribute('placeholder', String(this.placeholder)); } catch (_) {}
                try { if (this.readOnly) this.element.setAttribute('readonly', 'readonly'); else this.element.removeAttribute && this.element.removeAttribute('readonly'); } catch (_) {}
            }
        } catch (_) {}

        if (container) {
            // Always append the containerElement (not the raw input) so label + input stay together
            container.appendChild(this.containerElement);
        }

        return this.element;
    }


    onSelectionStart() {
        // Empty handler - override in applications to start selection flow
    }

}
// Multiline text input: renders a <textarea> and implements the same basic
// API as TextBox (`setText`, `getText`, `setPlaceholder`, `setReadOnly`, `setMaxLength`).
class MultilineTextBox extends FormInput {
    constructor(parentElement = null, properties = {}) {
        super(parentElement, properties);
        if (typeof this.text === 'undefined' || this.text === null) this.text = '';
        if (typeof this.placeholder === 'undefined' || this.placeholder === null) this.placeholder = '';
        if (typeof this.readOnly === 'undefined' || this.readOnly === null) this.readOnly = false;
        this.rows = (typeof this.rows === 'number' && this.rows > 0) ? (this.rows | 0) : (properties.rows ? (properties.rows | 0) : 4);
        this.wrap = this.wrap || properties.wrap || 'soft'; // soft|hard|off
        this.maxLength = (typeof this.maxLength === 'number') ? (this.maxLength | 0) : (properties.maxLength ? (properties.maxLength | 0) : 0);
        this.containerElement = null;
    }

    setText(text) {
        this.text = (text === null || text === undefined) ? '' : String(text);
        if (this.element) this.element.value = this.text;
    }

    getText() {
        return this.element ? this.element.value : this.text;
    }

    setPlaceholder(placeholder) {
        this.placeholder = placeholder;
        if (this.element) this.element.placeholder = placeholder;
    }

    setReadOnly(readOnly) {
        this.readOnly = !!readOnly;
        if (this.element) this.element.readOnly = this.readOnly;
    }

    setRows(rows) {
        this.rows = (typeof rows === 'number' && rows > 0) ? (rows | 0) : this.rows;
        if (this.element) this.element.rows = this.rows;
    }

    setMaxLength(maxLength) {
        this.maxLength = (typeof maxLength === 'number') ? (maxLength | 0) : (maxLength ? parseInt(maxLength, 10) : 0);
        if (this.element) {
            if (this.maxLength && this.maxLength > 0) this.element.maxLength = this.maxLength;
            else if (this.maxLength === 0) try { this.element.removeAttribute('maxLength'); } catch (_) {}
        }
    }

    Draw(container) {
        // Prepare label/container
        super.Draw(container);

        if (!this.element) {
            this.element = document.createElement('textarea');
            this.element.value = this.text;
            this.element.placeholder = this.placeholder;
            this.element.readOnly = this.readOnly;
            this.element.rows = this.rows;
            try { this.element.wrap = this.wrap; } catch (_) {}

            // Flex layout participation
            this.element.style.position = this.element.style.position || 'relative';
            this.element.style.flex = '1 1 auto';
            this.element.style.width = '100%';
            this.element.style.boxSizing = 'border-box';

            // Append into container
            try {
                if (this.containerElement) this.containerElement.appendChild(this.element);
                else if (container) container.appendChild(this.element);
            } catch (e) {}

            // Basic visual style similar to TextBox
            const tbBase = UIObject.getClientConfigValue('defaultColor', '#c0c0c0');
            const tbLight = UIObject.brightenColor(tbBase, 60);
            const tbDark = UIObject.brightenColor(tbBase, -60);
            this.element.style.backgroundColor = '#ffffff';
            this.element.style.borderTop = `2px solid ${tbDark}`;
            this.element.style.borderLeft = `2px solid ${tbDark}`;
            this.element.style.borderRight = `2px solid ${tbLight}`;
            this.element.style.borderBottom = `2px solid ${tbLight}`;
            this.element.style.fontFamily = 'MS Sans Serif, sans-serif';
            this.element.style.fontSize = '11px';
            this.element.style.padding = '4px';
            this.element.style.outline = 'none';

            // Observe size if needed (keeps textarea full width)
            try {
                if (typeof ResizeObserver !== 'undefined' && this.containerElement) {
                    if (this._ro) try { this._ro.disconnect(); } catch (e) {}
                    this._ro = new ResizeObserver(() => {
                        try { this.element.style.width = '100%'; } catch (_) {}
                    });
                    this._ro.observe(this.containerElement);
                }
            } catch (e) {}

            // Events: input updates internal text, preserve API parity with TextBox
            this.element.addEventListener('input', (e) => {
                try { this.text = e.target.value; } catch (ex) { this.text = e.target.value; }
            });

            this.element.addEventListener('click', (e) => { this.onClick(e); });
            this.element.addEventListener('dblclick', (e) => { this.onDoubleClick(e); });
            this.element.addEventListener('keydown', (e) => { this.onKeyPressed(e); });

            this.element.id = 'textarea_' + Math.random().toString(36).substr(2, 9);
            this.element.name = this.element.id;

            // Dataset props for debugging
            try {
                const props = { rows: this.rows, wrap: this.wrap, placeholder: this.placeholder || '', readOnly: !!this.readOnly, maxLength: this.maxLength || 0 };
                try { this.element.dataset.props = JSON.stringify(props); } catch (_) {}
            } catch (_) {}
        }

        if (container) {
            // Always append the containerElement so label + control stay together
            try { container.appendChild(this.containerElement); } catch (e) {}
        }

        return this.element;
    }
}

class Group extends UIObject {
    constructor(parentElement = null) {
        super();
        this.title = '';
        this.caption = '';
        this.parentElement = parentElement;
    }

    setTitle(title) {
        this.title = title;
        if (this.element) {
            this.element.querySelector('legend').textContent = title;
        }
    }

    setCaption(caption) {
        this.caption = caption;
        if (this.element) {
            const lg = this.element.querySelector('legend');
            if (lg) {
                lg.textContent = caption;
            }
        }
    }

    getCaption() {
        return this.caption;
    }

    getTitle() {
        return this.title;
    }

    Draw(container) {
        if (!this.element) {
            this.element = document.createElement('fieldset');
            this.element.className = 'ui-group';
            try { this.element.classList.add('ui-fieldset'); } catch (e) {}
            const legend = document.createElement('legend');
            // Use caption (if provided) as legend text so it visually interrupts the border
            legend.textContent = this.caption || this.title;
            this.element.appendChild(legend);

            const orientation = this.orientation || 'horizontal';
            // Use CSS classes for layout; JS keeps positioning only
            if (orientation === 'vertical' || orientation === 'column') {
                this.element.classList.add('vertical');
            } else {
                this.element.classList.add('horizontal');
            }

            // Positioning
            if (!this.parentElement) {
                this.element.style.position = 'absolute';
                this.element.style.left = this.x + 'px';
                this.element.style.top = this.y + 'px';
                this.element.style.width = this.width + 'px';
                this.element.style.height = this.height + 'px';
                this.element.style.zIndex = this.z;
            } else {
                // When Group is placed inside a parent, make it stretch horizontally
                this.element.style.position = this.element.style.position || 'relative';
                this.element.style.width = '100%';
                // Keep provided height if explicitly set
                if (this.height) this.element.style.height = this.height + 'px';
                this.element.style.boxSizing = this.element.style.boxSizing || 'border-box';
            }

            // box-sizing/padding handled via CSS

        }

        if (container) {
            container.appendChild(this.element);
        }

        return this.element;
    }       

}

class Label extends UIObject {
    constructor(parentElement = null) {
        super();
        this.text = '';
        this.parentElement = parentElement;
        this.fontSize = '11px';
        this.fontFamily = 'MS Sans Serif, sans-serif';
        this.color = '#000000';
        this.align = 'left';
    }

    setText(text) {
        this.text = text;
        if (this.element) {
            this.element.textContent = text;
        }
    }

    getText() {
        return this.text;
    }

    setFontSize(size) {
        this.fontSize = size;
        if (this.element) {
            this.element.style.fontSize = size;
        }
    }

    setFontWeight(weight) {
        this.fontWeight = weight;
        if (this.element) {
            this.element.style.fontWeight = weight;
        }
    }

    setFontFamily(family) {
        this.fontFamily = family;
        if (this.element) {
            this.element.style.fontFamily = family;
        }
    }

    setColor(color) {
        this.color = color;
        if (this.element) {
            this.element.style.color = color;
        }
    }

    setAlign(align) {
        this.align = align;
        if (this.element) {
            this.element.style.textAlign = align;
        }
    }

    Draw(container) {
        if (!this.element) {
            this.element = document.createElement('span');
            this.element.classList.add('ui-label');
            this.element.textContent = this.text;
            this.element.style.fontSize = this.fontSize;
            this.element.style.fontFamily = this.fontFamily;
            this.element.style.color = this.color;
            this.element.style.textAlign = this.align;
            this.element.style.display = 'inline-block';
            this.element.style.boxSizing = 'border-box';

            if (!this.parentElement) {
                this.element.style.position = 'absolute';
                this.element.style.left = this.x + 'px';
                this.element.style.top = this.y + 'px';
                this.element.style.width = this.width ? this.width + 'px' : 'auto';
                this.element.style.height = this.height ? this.height + 'px' : 'auto';
                this.element.style.zIndex = this.z;
            }
        }

        if (container) {
            container.appendChild(this.element);
        }

        return this.element;
    }
}

class Toolbar extends UIObject {
    constructor(parentElement = null) {
        super();
        this.parentElement = parentElement;
        this.items = [];
        this.height = 28; // Default height for toolbar
        this.compact = false; // Default: with spacing (not compact)
    }

    addItem(item) {
        this.items.push(item);
        this.addChild(item);
        if (this.element && item.element) {
            this.element.appendChild(item.element);
        } else if (this.element && !item.element) {
            // Will be drawn when toolbar is drawn/refreshed
        }
    }

    Draw(container) {
        if (!this.element) {
            this.element = document.createElement('div');
            this.element.classList.add('ui-toolbar');
            this.element.style.display = 'flex';
            this.element.style.alignItems = 'center';
            this.element.style.boxSizing = 'border-box';

            // Apply compact or normal spacing
            if (this.compact) {
                // Compact mode: no spacing, buttons stick together
                this.element.style.padding = '0';
                this.element.style.gap = '0';
                this.element.style.backgroundColor = '#c0c0c0';
                this.element.style.borderBottom = '1px solid #808080';
            } else {
                // Normal mode: with spacing
                this.element.style.padding = '5px';
                this.element.style.gap = '5px';
                this.element.style.backgroundColor = '#c0c0c0';
                this.element.style.borderBottom = '1px solid #808080';
            }

            if (!this.parentElement) {
                this.element.style.position = 'absolute';
                this.element.style.left = this.x + 'px';
                this.element.style.top = this.y + 'px';
                this.element.style.width = this.width + 'px';
                this.element.style.height = this.height + 'px';
                this.element.style.zIndex = this.z;
            } else {
                this.element.style.width = '100%';
                this.element.style.height = this.height + 'px';
                this.element.style.position = 'relative';
                this.element.style.flex = '0 0 auto';
            }

            // Draw items
            this.items.forEach((item, index) => {
                // Set parentElement for items so they use relative positioning
                if (!item.parentElement) {
                    item.parentElement = this.element;
                }
                item.Draw(this.element);
                
                // In compact mode, adjust button borders to make them stick together
                if (this.compact && item instanceof Button && item.element) {
                    item.element.style.margin = '0';
                    item.element.style.borderRadius = '0';
                    
                    // First button: remove right border
                    if (index === 0) {
                        item.element.style.borderRight = 'none';
                    }
                    // Middle buttons: remove left and right borders
                    else if (index < this.items.length - 1) {
                        item.element.style.borderLeft = 'none';
                        item.element.style.borderRight = 'none';
                    }
                    // Last button: remove left border
                    else {
                        item.element.style.borderLeft = 'none';
                    }
                }
            });
        }
        if (container) container.appendChild(this.element);
        return this.element;
    }
}

class ToolbarButton extends UIObject {
    constructor() {
        super();
        this.text = '';
        this.icon = null;
        this.tooltip = '';
        this.toggle = false;
        this.pressed = false;
        this.group = null;
        this.width = 24; // Default icon button width
        this.height = 22; // Default height
        this.autoWidth = false; // if text is present
    }

    setText(text) {
        this.text = text;
        this.autoWidth = !!text;
    }
    setIcon(icon) { this.icon = icon; }
    setTooltip(tooltip) { this.tooltip = tooltip; }
    setToggle(toggle) { this.toggle = toggle; }
    setGroup(group) { this.group = group; }

    setPressed(pressed) {
        this.pressed = pressed;
        this.updateStyle();
    }

    updateStyle() {
        if (!this.element) return;
        if (this.pressed) {
            this.element.style.borderTop = '1px solid #808080';
            this.element.style.borderLeft = '1px solid #808080';
            this.element.style.borderRight = '1px solid #ffffff';
            this.element.style.borderBottom = '1px solid #ffffff';
            this.element.style.backgroundColor = '#d0d0d0';
        } else {
            this.element.style.border = '1px solid transparent';
            this.element.style.backgroundColor = 'transparent';
        }
    }

    Draw(container) {
        if (!this.element) {
            this.element = document.createElement('div');
            this.element.title = this.tooltip;
            this.element.style.display = 'flex';
            this.element.style.flexDirection = 'row';
            this.element.style.alignItems = 'center';
            this.element.style.justifyContent = 'center';
            this.element.style.boxSizing = 'border-box';
            this.element.style.cursor = 'default';
            this.element.style.border = '1px solid transparent';
            this.element.style.padding = '0 4px';
            this.element.style.userSelect = 'none';

            if (this.autoWidth) {
                this.element.style.width = 'auto'; // Auto width for text buttons
                this.element.style.minWidth = '24px';
            } else {
                this.element.style.width = this.width + 'px';
            }
            this.element.style.height = this.height + 'px';

            if (this.icon) {
                const iconSpan = document.createElement('span');
                iconSpan.textContent = this.icon;
                iconSpan.style.fontSize = '16px';
                iconSpan.style.display = 'flex';
                iconSpan.style.alignItems = 'center';
                iconSpan.style.justifyContent = 'center';
                iconSpan.style.lineHeight = '1'; // Fix emoji vertical offset
                this.element.appendChild(iconSpan);
                if (this.text) {
                    iconSpan.style.marginRight = '4px';
                }
            }

            if (this.text) {
                const textSpan = document.createElement('span');
                textSpan.textContent = this.text;
                textSpan.style.fontSize = '11px';
                textSpan.style.fontFamily = 'MS Sans Serif, sans-serif';
                textSpan.style.whiteSpace = 'nowrap';
                this.element.appendChild(textSpan);
            }

            this.element.addEventListener('mouseenter', () => {
                if (!this.pressed && !this.element.disabled) {
                    this.element.style.borderTop = '1px solid #ffffff';
                    this.element.style.borderLeft = '1px solid #ffffff';
                    this.element.style.borderRight = '1px solid #808080';
                    this.element.style.borderBottom = '1px solid #808080';
                }
            });

            this.element.addEventListener('mouseleave', () => {
                if (!this.pressed) {
                    this.element.style.border = '1px solid transparent';
                }
            });

            this.element.addEventListener('mousedown', (e) => {
                this.element.style.borderTop = '1px solid #808080';
                this.element.style.borderLeft = '1px solid #808080';
                this.element.style.borderRight = '1px solid #ffffff';
                this.element.style.borderBottom = '1px solid #ffffff';
                this.onMouseDown(e);
            });

            this.element.addEventListener('mouseup', (e) => {
                if (!this.toggle) {
                    this.element.style.borderTop = '1px solid #ffffff';
                    this.element.style.borderLeft = '1px solid #ffffff';
                    this.element.style.borderRight = '1px solid #808080';
                    this.element.style.borderBottom = '1px solid #808080';
                }
                this.onMouseUp(e);
            });

            this.element.addEventListener('click', (e) => {
                if (this.toggle) {
                    this.pressed = !this.pressed;
                    this.updateStyle();
                }
                this.onClick(e);
            });

            if (this.pressed) {
                this.updateStyle();
            }
        }
        if (container) container.appendChild(this.element);
        return this.element;
    }
}

class ToolbarSeparator extends UIObject {
    Draw(container) {
        if (!this.element) {
            this.element = document.createElement('div');
            this.element.style.width = '2px';
            this.element.style.height = '18px';
            this.element.style.marginLeft = '2px';
            this.element.style.marginRight = '2px';
            this.element.style.borderLeft = '1px solid #808080';
            this.element.style.borderRight = '1px solid #ffffff';
        }
        if (container) container.appendChild(this.element);
        return this.element;
    }
}

class LegacyCheckbox extends FormInput {
    constructor(parentElement = null, properties = {}) {
        super(parentElement);
        this.parentElement = parentElement;
        this.checked = false;
        this.text = '';
        this.box = null;
        this.textSpan = null;

        this.setProperties(properties);

    }
    setChecked(checked) {
        this.checked = checked;
        this.updateVisual();
    }
    setText(text) {
        this.text = text;
        if (this.textSpan) this.textSpan.textContent = text;
    }
    updateVisual() {
        if (this.box) {
            this.box.textContent = this.checked ? '✔' : '';
            // Using unicode checkmark, centered
        }
    }
    Draw(container) {
        // Prepare container/label
        super.Draw(container);

        if (!this.element) {
            this.element.style.display = 'flex';
            this.element.style.alignItems = 'center';
            this.element.style.cursor = 'default';
            this.element.style.userSelect = 'none';

            this.box = document.createElement('div');
            this.box.style.width = '13px';
            this.box.style.height = '13px';
            this.box.style.backgroundColor = '#ffffff';
            this.box.style.borderTop = '1px solid #808080';
            this.box.style.borderLeft = '1px solid #808080';
            this.box.style.borderRight = '1px solid #ffffff';
            this.box.style.borderBottom = '1px solid #ffffff';
            this.box.style.boxShadow = 'inset 1px 1px 0px #000000, 1px 1px 0px #ffffff'; // deeper sunken look
            this.box.style.display = 'flex';
            this.box.style.alignItems = 'center';
            this.box.style.justifyContent = 'center';
            this.box.style.fontSize = '10px';
            this.box.style.marginRight = '6px';
            this.box.style.color = '#000000';

            this.element.appendChild(this.box);

            this.textSpan = document.createElement('span');
            this.textSpan.textContent = this.text;
            this.textSpan.style.fontFamily = 'MS Sans Serif, sans-serif';
            this.textSpan.style.fontSize = '11px';
            // If caption is provided we've drawn a dedicated Label; skip internal label to avoid duplication
            if (!this.caption) {
                this.element.appendChild(this.textSpan);
            }

            this.element.onclick = () => {
                this.setChecked(!this.checked);
                this.onClick();
            };

            this.updateVisual();

            if (!this.parentElement) {
                this.element.style.position = 'absolute';
                this.element.style.left = this.x + 'px';
                this.element.style.top = this.y + 'px';
                this.element.style.zIndex = this.z;
            }
        }

        try {
            if (this.containerElement) this.containerElement.appendChild(this.element);
            else if (container) container.appendChild(this.element);
        } catch (e) {}
        return this.element;
    }

    onSelectionStart() {
        // Empty handler - override in applications to start selection/lookup
    }
}

class RadioButton extends UIObject {
    constructor(parentElement = null) {
        super();
        this.parentElement = parentElement;
        this.checked = false;
        this.text = '';
        this.group = null;
        this.circle = null;
        this.textSpan = null;
    }
    setChecked(checked) {
        this.checked = checked;
        this.updateVisual();
    }
    setText(text) {
        this.text = text;
        if (this.textSpan) this.textSpan.textContent = text;
    }
    setGroup(group) {
        this.group = group;
    }
    updateVisual() {
        if (this.circleIcon) {
            this.circleIcon.style.visibility = this.checked ? 'visible' : 'hidden';
        }
    }
    Draw(container) {
        if (!this.element) {
            this.element = document.createElement('div');
            this.element.style.display = 'flex';
            this.element.style.alignItems = 'center';
            this.element.style.cursor = 'default';
            this.element.style.userSelect = 'none';

            // Outer circle with sunken 3D effect
            this.circle = document.createElement('div');
            this.circle.style.width = '12px';
            this.circle.style.height = '12px';
            this.circle.style.borderRadius = '50%';
            this.circle.style.backgroundColor = '#ffffff';
            // Win98 radio border simulation with CSS borders (tricky for circle)
            // Simplified: solid border + box shadow
            this.circle.style.boxShadow = 'inset 1px 1px 2px rgba(0,0,0,0.5)';
            this.circle.style.border = '1px solid #808080';

            this.circle.style.display = 'flex';
            this.circle.style.alignItems = 'center';
            this.circle.style.justifyContent = 'center';
            this.circle.style.marginRight = '6px';

            // The dot
            this.circleIcon = document.createElement('div');
            this.circleIcon.style.width = '4px';
            this.circleIcon.style.height = '4px';
            this.circleIcon.style.backgroundColor = '#000000';
            this.circleIcon.style.borderRadius = '50%';
            this.circle.appendChild(this.circleIcon);

            this.element.appendChild(this.circle);

            this.textSpan = document.createElement('span');
            this.textSpan.textContent = this.text;
            this.textSpan.style.fontFamily = 'MS Sans Serif, sans-serif';
            this.textSpan.style.fontSize = '11px';
            this.element.appendChild(this.textSpan);

            this.element.onclick = () => {
                if (!this.checked) {
                    this.setChecked(true);
                    // Logic for unchecking others in group would ideally be here or global
                }
                this.onClick();
            };

            this.updateVisual();

            if (!this.parentElement) {
                this.element.style.position = 'absolute';
                this.element.style.left = this.x + 'px';
                this.element.style.top = this.y + 'px';
                this.element.style.zIndex = this.z;
            }
        }
        if (container) container.appendChild(this.element);
        return this.element;
    }
}

class RadioGroup extends UIObject {
    constructor(parentElement = null) {
        super();
        this.parentElement = parentElement;
        this.items = [];
        this.value = null;
        this.groupName = 'radiogroup_' + Math.random().toString(36).substr(2, 9);
        this.radios = [];
    }

    setItems(items) {
        this.items = items;
    }

    setGroupName(name) {
        this.groupName = name;
        this.radios.forEach(r => r.setGroup(name));
    }

    setValue(value) {
        this.value = value;
        this.radios.forEach(r => {
            if (r.text === value) {
                r.setChecked(true);
            } else {
                r.setChecked(false);
            }
        });
    }

    getValue() {
        const checked = this.radios.find(r => r.checked);
        return checked ? checked.text : null;
    }

    Draw(container) {
        if (!this.element) {
            this.element = document.createElement('div');
            this.element.style.position = 'absolute';

            const itemHeight = 20;
            const totalHeight = this.items.length * itemHeight;
            this.setHeight(totalHeight);

            if (!this.parentElement) {
                this.element.style.left = this.x + 'px';
                this.element.style.top = this.y + 'px';
                this.element.style.width = this.width + 'px';
                this.element.style.height = this.height + 'px';
            }

            this.items.forEach((item, idx) => {
                const rb = new RadioButton(null);
                rb.setText(item);
                rb.setGroup(this.groupName);
                rb.setX(0); // Relative to group container
                rb.setY(idx * itemHeight);

                if (this.value === item) {
                    rb.setChecked(true);
                }

                this.radios.push(rb);
                rb.Draw(this.element);

                const originalOnClick = rb.onClick;
                rb.onClick = (e) => {
                    this.value = item;
                    this.radios.forEach(other => {
                        if (other !== rb) other.setChecked(false);
                    });
                    if (originalOnClick) originalOnClick(e);
                };
            });
        }

        if (container) container.appendChild(this.element);

        if (this.width > 0 && this.element) this.element.style.width = this.width + 'px';

        return this.element;
    }
}

// Common base for modal dialogs (Alert, Confirm, etc.)
class ModalForm extends Form {
    constructor(title = '', width = 300, height = 150) {
        super();
        this.setTitle(title);
        this.setWidth(width);
        this.setHeight(height);
        this.setAnchorToWindow('center');
        this.resizable = false;
        this.movable = true;
    }

    Draw(container) {
        super.Draw(container);
        // Make modal and center
        this.setModal(true);
        this.updatePositionOnResize();

        // Hide title bar buttons block (if present)
        if (this.titleBar) {
            const children = this.titleBar.children;
            for (let i = 0; i < children.length; i++) {
                if (children[i].tagName === 'DIV' && children[i].children.length > 0 && children[i].children[0].tagName === 'BUTTON') {
                    children[i].style.display = 'none';
                    break;
                }
            }
        }

        // Provide content area reference for subclasses
        this.contentArea = this.getContentArea();
    }
}

class AlertForm extends ModalForm {
    constructor(message, onOk) {
        super('Alert', 300, 150);
        this.message = message;
        this.onOk = onOk;
    }

    Draw(container) {
        super.Draw(container);

        const lblMessage = new Label(this.contentArea);
        lblMessage.setText(this.message);
        lblMessage.Draw(this.contentArea);
        if (lblMessage.element) {
            lblMessage.element.style.textAlign = 'center';
            lblMessage.element.style.whiteSpace = 'pre-wrap';
            lblMessage.element.style.display = 'flex';
            lblMessage.element.style.alignItems = 'center';
            lblMessage.element.style.justifyContent = 'center';
        }
        UIObject.styleElement(lblMessage, 10, 10, this.width - 20, this.height - 80, 14);

        const btnOk = new Button(this.contentArea);
        btnOk.setCaption('OK');
        btnOk.Draw(this.contentArea);
        btnOk.onClick = () => {
            this.close();
            if (this.onOk) this.onOk();
        };

        const btnWidth = 80;
        const btnHeight = 26;
        const btnX = (this.width - btnWidth) / 2;
        const btnY = this.height - 40 - 20;
        UIObject.styleElement(btnOk, btnX, btnY, btnWidth, btnHeight, 12);

        // store reference so callers can access if needed
        this.okButton = btnOk;
        setTimeout(() => {
            try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) { }
            if (this.okButton && this.okButton.element) this.okButton.element.focus();
        }, 50);
    }
}

class ConfirmForm1 extends ModalForm {
    constructor(message, onOk, onCancel) {
        super('Confirm', 360, 170);
        this.message = message;
        this.onOk = onOk;
        this.onCancel = onCancel;
    }

    Draw(container) {
        super.Draw(container);

        const lblMessage = new Label(this.contentArea);
        lblMessage.setText(this.message);
        lblMessage.Draw(this.contentArea);
        if (lblMessage.element) {
            lblMessage.element.style.textAlign = 'center';
            lblMessage.element.style.whiteSpace = 'pre-wrap';
            lblMessage.element.style.display = 'flex';
            lblMessage.element.style.alignItems = 'center';
            lblMessage.element.style.justifyContent = 'center';
        }
        UIObject.styleElement(lblMessage, 10, 10, this.width - 20, this.height - 80, 13);

        const btnOk = new Button(this.contentArea);
        btnOk.setCaption('OK');
        btnOk.Draw(this.contentArea);
        btnOk.onClick = () => {
            this.close();
            if (this.onOk) this.onOk();
        };

        const btnCancel = new Button(this.contentArea);
        btnCancel.setCaption('Cancel');
        btnCancel.Draw(this.contentArea);
        btnCancel.onClick = () => {
            this.close();
            if (this.onCancel) this.onCancel();
        };

        const btnWidth = 90;
        const btnHeight = 28;
        const spacing = 12;
        const totalW = btnWidth * 2 + spacing;
        const startX = (this.width - totalW) / 2;
        const btnY = this.height - 48 - 10;

        UIObject.styleElement(btnOk, startX, btnY, btnWidth, btnHeight, 12);
        UIObject.styleElement(btnCancel, startX + btnWidth + spacing, btnY, btnWidth, btnHeight, 12);

        setTimeout(() => {
            if (btnCancel.element) btnCancel.element.focus();
        }, 10);
    }
}

function showConfirm(message, onOk, onCancel) {
    // Backwards-compatible signature: if callbacks provided, use them.
    if (typeof onOk === 'function' || typeof onCancel === 'function') {
        const f = new ConfirmForm(message, onOk || (() => { }), onCancel || (() => { }));
        f.Draw(document.body);
        return;
    }
    // Promise-based API: returns true for OK, false for Cancel
    return new Promise((resolve) => {
        const f = new ConfirmForm(message, () => { resolve(true); }, () => { resolve(false); });
        f.Draw(document.body);
    });
}

// Expose confirm helper
if (typeof window !== 'undefined') {
    window.showConfirm = showConfirm;
}


class ComboBox extends FormInput {
    constructor(parentElement = null, properties = {}) {
        super(parentElement, properties);
        this.items = []; // Array of strings or objects {label, value}
        this.selectedIndex = -1;
        this.text = '';
        this.expanded = false;
        this.onChange = null;
        this.listElement = null; // The dropdown list container
        // Optional selection button ("...") to trigger selection flow
        if (typeof this.showSelectionButton === 'undefined' || this.showSelectionButton === null) this.showSelectionButton = false;
        this._selectBtn = null;
    }

    setItems(items) {
        this.items = items;
        if (this.selectedIndex >= items.length) {
            this.selectedIndex = -1;
            this.setText('');
        }
    }

    setSelectedIndex(index) {
        if (index >= 0 && index < this.items.length) {
            this.selectedIndex = index;
            const item = this.items[index];
            this.setText(typeof item === 'object' ? item.label : item);
        } else {
            this.selectedIndex = -1;
            this.setText('');
        }
    }

    setText(text) {
        this.text = text;
        if (this.inputElement) {
            this.inputElement.value = text;
        }
    }

    getText() {
        return this.text;
    }

    toggle() {
        if (this.expanded) this.collapse();
        else this.expand();
    }

    expand() {
        if (this.expanded) return;
        this.expanded = true;
        this.drawList();
    }

    collapse() {
        if (!this.expanded) return;
        this.expanded = false;
        if (this.listElement) {
            this.listElement.remove();
            this.listElement = null;
        }
        // Remove global click listener
        if (this._clickOutsideHandler) {
            document.removeEventListener('mousedown', this._clickOutsideHandler);
            this._clickOutsideHandler = null;
        }
    }

    drawList() {
        if (this.listElement) this.listElement.remove();

        // Create dropdown list absolute positioned relative to body or nearest relative parent
        // For simplicity, attach to body and calculate absolute position
        this.listElement = document.createElement('div');
        this.listElement.style.position = 'absolute';
        this.listElement.style.backgroundColor = '#ffffff';
        this.listElement.style.border = '1px solid #000000';
        this.listElement.style.zIndex = 100000; // Very high z-index
        this.listElement.style.fontFamily = 'MS Sans Serif, sans-serif';
        this.listElement.style.fontSize = '11px';
        this.listElement.style.boxSizing = 'border-box';
        this.listElement.style.overflowY = 'auto';
        this.listElement.style.maxHeight = '150px';
        this.listElement.style.cursor = 'default';

        // Calculate position
        const rect = this.element.getBoundingClientRect();
        this.listElement.style.left = rect.left + 'px';
        this.listElement.style.top = (rect.bottom) + 'px';
        this.listElement.style.width = this.width + 'px'; // width matches combobox

        // Add items
        this.items.forEach((item, index) => {
            const div = document.createElement('div');
            const label = typeof item === 'object' ? item.label : item;
            div.textContent = label;
            div.style.padding = '2px 4px';
            div.style.whiteSpace = 'nowrap';

            if (index === this.selectedIndex) {
                div.style.backgroundColor = '#000080';
                div.style.color = '#ffffff';
            } else {
                div.style.backgroundColor = '#ffffff';
                div.style.color = '#000000';
            }

            div.onmouseover = () => {
                if (index !== this.selectedIndex) {
                    div.style.backgroundColor = '#000080';
                    div.style.color = '#ffffff';
                }
            };
            div.onmouseout = () => {
                if (index !== this.selectedIndex) {
                    div.style.backgroundColor = '#ffffff';
                    div.style.color = '#000000';
                }
            };

            div.onmousedown = (e) => {
                e.stopPropagation(); // Prevent closing immediately
                this.setSelectedIndex(index);
                this.collapse();
                if (this.onChange) this.onChange(index, item);
            }
            this.listElement.appendChild(div);
        });

        document.body.appendChild(this.listElement);

        // Add click outside listener
        this._clickOutsideHandler = (e) => {
            if (!this.element.contains(e.target) && !this.listElement.contains(e.target)) {
                this.collapse();
            }
        };
        document.addEventListener('mousedown', this._clickOutsideHandler);
    }

    Draw(container) {
        // Prepare container/label
        super.Draw(container);

        if (!this.element) {
            this.element = document.createElement('div');
            this.element.style.display = 'flex';
            this.element.style.alignItems = 'center';
            this.element.style.boxSizing = 'border-box';

            // Positioning
            if (!this.parentElement) {
                this.element.style.position = 'absolute';
                this.element.style.left = this.x + 'px';
                this.element.style.top = this.y + 'px';
            } else {
                this.element.style.position = 'relative';
            }
            this.element.style.width = this.width + 'px';
            this.element.style.height = this.height + 'px';
            this.element.style.zIndex = this.z;

            // Border style (Sunken)
            this.element.style.backgroundColor = '#ffffff';
            this.element.style.borderTop = '2px solid #808080';
            this.element.style.borderLeft = '2px solid #808080';
            this.element.style.borderRight = '2px solid #ffffff';
            this.element.style.borderBottom = '2px solid #ffffff';

            // Text input part
            this.inputElement = document.createElement('input');
            this.inputElement.type = 'text';
            // Ensure unique id/name for form autofill and diagnostics
            try { this.inputElement.id = this.inputElement.id || 'select_' + Math.random().toString(36).substr(2, 9); } catch (_) {}
            try { this.inputElement.name = this.inputElement.name || this.inputElement.id; } catch (_) {}
            this.inputElement.readOnly = true; // Typically read-only for simple dropdown
            this.inputElement.value = this.text;
            this.inputElement.style.flex = '1';
            this.inputElement.style.border = 'none';
            this.inputElement.style.outline = 'none';
            this.inputElement.style.fontFamily = 'MS Sans Serif, sans-serif';
            this.inputElement.style.fontSize = '11px';
            this.inputElement.style.padding = '1px 4px';
            this.inputElement.style.margin = '0';
            this.inputElement.style.backgroundColor = 'transparent';
            this.inputElement.style.cursor = 'default';

            this.element.appendChild(this.inputElement);

            // Optional selection button to the left of the dropdown arrow
            try {
                if (this.showSelectionButton) {
                    if (!this._selectBtn) {
                        const sbtn = document.createElement('button');
                        sbtn.type = 'button';
                        sbtn.tabIndex = -1;
                        sbtn.textContent = '...';
                        sbtn.style.width = '22px';
                        sbtn.style.minWidth = '22px';
                        sbtn.style.height = '100%';
                        sbtn.style.display = 'flex';
                        sbtn.style.alignItems = 'center';
                        sbtn.style.justifyContent = 'center';
                        sbtn.style.margin = '0';
                        sbtn.style.padding = '0';
                        sbtn.style.boxSizing = 'border-box';
                        sbtn.style.cursor = 'default';
                        sbtn.style.fontFamily = 'MS Sans Serif, sans-serif';
                        sbtn.style.fontSize = '12px';
                        sbtn.style.fontWeight = 'bold';
                        const base = UIObject.getClientConfigValue('defaultColor', '#c0c0c0');
                        const light = UIObject.brightenColor(base, 60);
                        const dark = UIObject.brightenColor(base, -60);
                        sbtn.style.borderTop = `2px solid ${light}`;
                        sbtn.style.borderLeft = `2px solid ${light}`;
                        sbtn.style.borderRight = `2px solid ${dark}`;
                        sbtn.style.borderBottom = `2px solid ${dark}`;
                        sbtn.addEventListener('click', (ev) => { try { ev.stopPropagation(); ev.preventDefault(); this.onSelectionStart(); } catch (_) {} });
                        // Insert now; arrow button will be appended after, so this will be to its left
                        this.element.appendChild(sbtn);
                        this._selectBtn = sbtn;
                    }
                }
            } catch (e) {}

            // Arrow button
            const btn = document.createElement('button');
            btn.style.width = '16px';
            btn.style.height = '100%';
            btn.style.borderTop = '2px solid #ffffff';
            btn.style.borderLeft = '2px solid #ffffff';
            btn.style.borderRight = '2px solid #808080';
            btn.style.borderBottom = '2px solid #808080';
            btn.style.backgroundColor = '#c0c0c0';
            btn.style.display = 'flex';
            btn.style.alignItems = 'center';
            btn.style.justifyContent = 'center';
            btn.style.cursor = 'default';
            btn.style.padding = '0';
            btn.style.margin = '0';
            btn.style.outline = 'none';
            btn.tabIndex = -1;

            // Arrow icon (canvas)
            const cvs = document.createElement('canvas');
            cvs.width = 8;
            cvs.height = 4;
            const ctx = cvs.getContext('2d');
            ctx.fillStyle = '#000000';
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(8, 0);
            ctx.lineTo(4, 4);
            ctx.fill();
            btn.appendChild(cvs);

            // Button press effect
            btn.onmousedown = (e) => {
                e.preventDefault(); // prevent focus transfer
                btn.style.borderTop = '2px solid #808080';
                btn.style.borderLeft = '2px solid #808080';
                btn.style.borderRight = '2px solid #ffffff';
                btn.style.borderBottom = '2px solid #ffffff';
                cvs.style.transform = 'translate(1px, 1px)';
                this.toggle();
            };
            btn.onmouseup = () => {
                btn.style.borderTop = '2px solid #ffffff';
                btn.style.borderLeft = '2px solid #ffffff';
                btn.style.borderRight = '2px solid #808080';
                btn.style.borderBottom = '2px solid #808080';
                cvs.style.transform = 'translate(0, 0)';
            };
            btn.onmouseout = () => {
                btn.style.borderTop = '2px solid #ffffff';
                btn.style.borderLeft = '2px solid #ffffff';
                btn.style.borderRight = '2px solid #808080';
                btn.style.borderBottom = '2px solid #808080';
                cvs.style.transform = 'translate(0, 0)';
            };

            this.element.appendChild(btn);

            // Handle clicking the text box to toggle also
            this.inputElement.onmousedown = (e) => {
                e.preventDefault();
                this.toggle();
            };
        }

        try {
            if (this.containerElement) this.containerElement.appendChild(this.element);
            else if (container) container.appendChild(this.element);
        } catch (e) {}
        return this.element;
    }
}

function showAlert(message, onOk) {
    const alertForm = new AlertForm(message, onOk);
    alertForm.Draw(document.body);
}

// Expose to global scope
if (typeof window !== 'undefined') {
    window.showAlert = showAlert;
}

function loadResource(src, type = 'script', callback) {
    let el;
    if (type === 'script') {
        el = document.createElement('script');
        el.src = src;
        el.onload = callback || function () { };
    } else if (type === 'style' || type === 'css') {
        el = document.createElement('link');
        el.rel = 'stylesheet';
        el.href = src;
        el.onload = callback || function () { };
    } else {
        throw new Error('Unsupported resource type: ' + type);
    }
    document.head.appendChild(el);
}

// Ensure bundled stylesheet is loaded for these UI components
if (typeof window !== 'undefined') {
    try {
        const href = '/app/res/public/style.css';
        if (!document.querySelector('link[href="' + href + '"]')) {
            loadResource(href, 'style');
        }
    } catch (e) {}
}

function loadHTMLContent(src, callback) {
    const fetchText = () => {
        if (window.fetch) {
            return fetch(src).then(res => {
                if (!res.ok) throw new Error('Failed to load ' + src + ' (' + res.status + ')');
                return res.text();
            });
        }
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', src, true);
            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4) {
                    if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
                    else reject(new Error('Failed to load ' + src + ' (' + xhr.status + ')'));
                }
            };
            xhr.onerror = function () {
                reject(new Error('Network error while loading ' + src));
            };
            xhr.send();
        });
    };

    if (typeof callback === 'function') {
        fetchText().then(text => callback(null, text)).catch(err => callback(err));
        return;
    }

    return fetchText();
}

// CheckBox class for boolean values
class CheckBox extends FormInput {
    constructor(parentElement = null, properties = {}) {
        super(parentElement, properties);
        this.checked = false;
        this.readOnly = false;
        this.label = '';
        this.parentElement = parentElement;
    }

    setChecked(value) {
        this.checked = !!value;
        if (this.element) {
            const checkbox = this.element.querySelector('input[type="checkbox"]');
            if (checkbox) checkbox.checked = this.checked;
        }
    }

    getChecked() {
        if (this.element) {
            const checkbox = this.element.querySelector('input[type="checkbox"]');
            if (checkbox) return checkbox.checked;
        }
        return this.checked;
    }

    setReadOnly(value) {
        this.readOnly = value;
        if (this.element) {
            const checkbox = this.element.querySelector('input[type="checkbox"]');
            if (checkbox) checkbox.disabled = value;
        }
    }

    setLabel(text) {
        this.label = text;
        if (this.element) {
            const labelSpan = this.element.querySelector('.checkbox-label-text');
            if (labelSpan) labelSpan.textContent = text;
        }
    }

    Draw(container) {
        // Prepare container and label
        super.Draw(container);

        if (!this.element) {
            // Create label container
            this.element = document.createElement('label');
            // mark as ui-checkbox so stylesheet rules target it
            try { this.element.classList.add('ui-checkbox'); } catch (_) {}
            this.element.style.display = 'inline-flex';
            this.element.style.alignItems = 'center';
            this.element.style.cursor = this.readOnly ? 'default' : 'pointer';
            this.element.style.userSelect = 'none';
            this.element.style.fontFamily = 'MS Sans Serif, sans-serif';
            this.element.style.fontSize = '11px';

            // Normalize spacing to avoid unexpected gaps inside the label
            this.element.style.margin = '0';
            this.element.style.padding = '0';
            this.element.style.boxSizing = 'border-box';

            /*
            // If an explicit height is set on the label, keep width equal to that height
            // so the checkbox label area remains square. If no explicit height, leave width unset.
            if (this.element.style.height && this.element.style.height.trim() !== '') {
                this.element.style.width = this.element.style.height;
            }
            */

            // Positioning
            if (!this.parentElement) {
                this.element.style.position = 'absolute';
                this.element.style.left = this.x + 'px';
                this.element.style.top = this.y + 'px';
                this.element.style.zIndex = this.z;
            }

            // Create a wrapper that contains the native input (invisible) and a custom visual box
            const wrapper = document.createElement('span');
            wrapper.style.display = 'inline-block';
            wrapper.style.position = 'relative';
            wrapper.style.width = '13px';
            wrapper.style.height = '13px';
            wrapper.style.marginRight = '6px';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            try { checkbox.id = checkbox.id || 'checkbox_' + Math.random().toString(36).substr(2,9); } catch (_) {}
            try { checkbox.name = checkbox.name || checkbox.id; } catch (_) {}
            checkbox.checked = this.checked;
            checkbox.disabled = this.readOnly;
            // Position native input over custom box but keep it invisible so browser focus and keyboard work
            checkbox.style.position = 'absolute';
            checkbox.style.left = '0';
            checkbox.style.top = '0';
            checkbox.style.width = '13px';
            checkbox.style.height = '13px';
            checkbox.style.margin = '0';
            checkbox.style.padding = '0';
            checkbox.style.opacity = '0';
            checkbox.style.zIndex = '2';
            checkbox.style.cursor = this.readOnly ? 'default' : 'pointer';

            // Create visual box (we'll style via CSS class .custom-checkbox-box)
            const visualBox = document.createElement('div');
            visualBox.className = 'custom-checkbox-box';
            visualBox.style.position = 'absolute';
            visualBox.style.left = '0';
            visualBox.style.top = '0';
            visualBox.style.width = '13px';
            visualBox.style.height = '13px';
            visualBox.style.zIndex = '1';
            visualBox.setAttribute('aria-hidden', 'true');

            // Create label text span
            const labelSpan = document.createElement('span');
            labelSpan.className = 'checkbox-label-text';


            this.inputContainer = document.createElement('div');
            this.inputContainer.style.display = 'flex';
            this.inputContainer.style.flexDirection = 'row';
            this.inputContainer.style.alignItems = 'center';
            this.inputContainer.style.padding = '0';
            // If an explicit height was set on the input container (inline style),
            // keep width equal to that height so the control stays square.
            // If no explicit height is present, do not set width here (leave layout to CSS/flex).
            /*
            if (this.inputContainer.style.height && this.inputContainer.style.height.trim() !== '') {
                this.inputContainer.style.width = this.inputContainer.style.height;
            }
            */
            this.inputContainer.style.boxSizing = 'border-box';
            // Retro border for the input container to match the input itself
            try {
                const tbBase = UIObject.getClientConfigValue('defaultColor', '#c0c0c0');
                const tbLight = UIObject.brightenColor(tbBase, 60);
                const tbDark = UIObject.brightenColor(tbBase, -60);
                this.inputContainer.style.backgroundColor = '#ffffff';
                this.inputContainer.style.borderTop = `2px solid ${tbDark}`;
                this.inputContainer.style.borderLeft = `2px solid ${tbDark}`;
                this.inputContainer.style.borderRight = `2px solid ${tbLight}`;
                this.inputContainer.style.borderBottom = `2px solid ${tbLight}`;
                this.inputContainer.style.boxSizing = 'border-box';

                UIObject.loadClientConfig().then(() => {
                    try {
                        const base = UIObject.getClientConfigValue('defaultColor', tbBase);
                        const light = UIObject.brightenColor(base, 60);
                        const dark = UIObject.brightenColor(base, -60);
                        this.inputContainer.style.borderTop = `2px solid ${dark}`;
                        this.inputContainer.style.borderLeft = `2px solid ${dark}`;
                        this.inputContainer.style.borderRight = `2px solid ${light}`;
                        this.inputContainer.style.borderBottom = `2px solid ${light}`;
                    } catch (e) {}
                }).catch(()=>{});
            } catch (e) {}

            /*
            // Configure input to participate in flex layout and fill remaining space
            this.element.style.position = this.element.style.position || 'relative';
            this.element.style.flex = '1 1 auto';
            this.element.style.width = 'auto';
            this.element.style.height = this.element.style.height || 'auto';
            */

            // Add elements: wrapper contains native input + visual box
            wrapper.appendChild(checkbox);
            wrapper.appendChild(visualBox);
            this.element.appendChild(wrapper);
            if ((this.label && this.label.length) || (this.caption && this.caption.length)) {
                this.element.appendChild(labelSpan);
            }

            // Event listeners
            checkbox.addEventListener('change', (e) => {
                this.checked = e.target.checked;
            });

            this.element.addEventListener('click', (e) => {
                this.onClick(e);
            });
        }

        /*
        try {
            if (this.containerElement) this.containerElement.appendChild(this.element);
            else if (container) container.appendChild(this.element);
        } catch (e) {}
         */

        try {
            if (this.containerElement) this.containerElement.appendChild(this.inputContainer);
            else if (container) container.appendChild(this.inputContainer);
        } catch (e) {}
        this.inputContainer.appendChild(this.element);

        // Prevent label from flex-growing inside the container
        try {
            this.element.style.flex = this.element.style.flex || '0 0 auto';
            this.element.style.minWidth = this.element.style.minWidth || '0';

            // Compute rendered height and set width to match so label is square.
            // Only set if no explicit inline width already provided.
            if ((!this.element.style.width || this.element.style.width.trim() === '') && typeof window !== 'undefined' && window.getComputedStyle) {
                const cs = window.getComputedStyle(this.element);
                const h = cs && cs.height ? parseFloat(cs.height) : 0;
                if (h && !isNaN(h) && h > 0) {
                    this.element.style.width = Math.ceil(h) + 'px';
                }
            }
        } catch (e) {}

        return this.element;
    }
}

// DatePicker class for DATE and TIMESTAMP types
class DatePicker extends FormInput {
    constructor(parentElement = null, properties = {}) {
        super(parentElement, properties);
        this.value = null;  // Date object or null
        this.showTime = false;  // true for TIMESTAMP
        this.readOnly = false;
        this.parentElement = parentElement;
        this.format = 'DD.MM.YYYY';  // European format
        this.calendarPopup = null;
    }

    setValue(date) {
        this.value = date;
        if (this.element) {
            const input = this.element.querySelector('input[type="text"]');
            if (input) {
                input.value = this.formatDate(date);
            }
        }
    }

    getValue() {
        return this.value;
    }

    setShowTime(value) {
        this.showTime = value;
        this.format = value ? 'DD.MM.YYYY HH:mm' : 'DD.MM.YYYY';
        if (this.element && this.value) {
            const input = this.element.querySelector('input[type="text"]');
            if (input) {
                input.value = this.formatDate(this.value);
            }
        }
    }

    setReadOnly(value) {
        this.readOnly = value;
        if (this.element) {
            const input = this.element.querySelector('input[type="text"]');
            const button = this.element.querySelector('button');
            if (input) input.disabled = value;
            if (button) button.disabled = value;
        }
    }

    formatDate(date) {
        if (!date) return '';
        if (!(date instanceof Date)) {
            date = new Date(date);
        }
        if (isNaN(date.getTime())) return '';

        const dd = String(date.getDate()).padStart(2, '0');
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const yyyy = date.getFullYear();

        if (this.showTime) {
            const hh = String(date.getHours()).padStart(2, '0');
            const min = String(date.getMinutes()).padStart(2, '0');
            return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
        }

        return `${dd}.${mm}.${yyyy}`;
    }

    parseDate(text) {
        if (!text || text.trim() === '') return null;

        // Parse DD.MM.YYYY or DD.MM.YYYY HH:mm
        const parts = text.trim().split(' ');
        const datePart = parts[0];
        const timePart = parts[1];

        const dateMatch = datePart.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
        if (!dateMatch) return null;

        const day = parseInt(dateMatch[1], 10);
        const month = parseInt(dateMatch[2], 10) - 1; // 0-based
        const year = parseInt(dateMatch[3], 10);

        let hour = 0, minute = 0;
        if (timePart) {
            const timeMatch = timePart.match(/^(\d{1,2}):(\d{1,2})$/);
            if (timeMatch) {
                hour = parseInt(timeMatch[1], 10);
                minute = parseInt(timeMatch[2], 10);
            }
        }

        const date = new Date(year, month, day, hour, minute);
        return isNaN(date.getTime()) ? null : date;
    }

    openCalendar() {
        if (this.readOnly || this.calendarPopup) return;

        // Create calendar popup form
        const calendar = new Form();
        calendar.setTitle('Выбор даты');
        calendar.setWidth(280);
        calendar.setHeight(this.showTime ? 270 : 240);
        calendar.setResizable(false);

        // Position near the date picker
        const rect = this.element.getBoundingClientRect();
        calendar.setX(rect.left);
        calendar.setY(rect.bottom + 5);

        const contentArea = calendar.getContentArea();

        // Current month/year for display
        const now = this.value || new Date();
        let currentMonth = now.getMonth();
        let currentYear = now.getFullYear();

        // Header with navigation
        const renderCalendar = () => {
            // Clear content
            contentArea.innerHTML = '';

            // Month/Year navigation
            const header = document.createElement('div');
            header.style.display = 'flex';
            header.style.justifyContent = 'space-between';
            header.style.alignItems = 'center';
            header.style.marginBottom = '10px';
            header.style.padding = '5px';

            const prevBtn = new Button();
            prevBtn.setCaption('<<');
            prevBtn.setWidth(30);
            prevBtn.setHeight(20);
            prevBtn.onClick = () => {
                currentMonth--;
                if (currentMonth < 0) {
                    currentMonth = 11;
                    currentYear--;
                }
                renderCalendar();
            };

            const monthLabel = new Label();
            const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
                'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
            monthLabel.setText(`${monthNames[currentMonth]} ${currentYear}`);
            monthLabel.setFontWeight('bold');

            const nextBtn = new Button();
            nextBtn.setCaption('>>');
            nextBtn.setWidth(30);
            nextBtn.setHeight(20);
            nextBtn.onClick = () => {
                currentMonth++;
                if (currentMonth > 11) {
                    currentMonth = 0;
                    currentYear++;
                }
                renderCalendar();
            };

            const headerContainer = document.createElement('div');
            headerContainer.style.display = 'flex';
            headerContainer.style.justifyContent = 'space-between';
            headerContainer.style.marginBottom = '10px';

            prevBtn.Draw(headerContainer);
            monthLabel.Draw(headerContainer);
            nextBtn.Draw(headerContainer);
            contentArea.appendChild(headerContainer);

            // Days of week
            const daysRow = document.createElement('div');
            daysRow.style.display = 'grid';
            daysRow.style.gridTemplateColumns = 'repeat(7, 1fr)';
            daysRow.style.gap = '2px';
            daysRow.style.marginBottom = '5px';

            const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
            for (const dayName of dayNames) {
                const dayLabel = document.createElement('div');
                dayLabel.textContent = dayName;
                dayLabel.style.textAlign = 'center';
                dayLabel.style.fontWeight = 'bold';
                dayLabel.style.fontSize = '10px';
                dayLabel.style.padding = '2px';
                daysRow.appendChild(dayLabel);
            }
            contentArea.appendChild(daysRow);

            // Days grid
            const daysGrid = document.createElement('div');
            daysGrid.style.display = 'grid';
            daysGrid.style.gridTemplateColumns = 'repeat(7, 1fr)';
            daysGrid.style.gap = '2px';

            // Calculate first day of month (Monday = 0)
            const firstDay = new Date(currentYear, currentMonth, 1);
            let firstWeekday = firstDay.getDay() - 1; // Convert to Monday = 0
            if (firstWeekday < 0) firstWeekday = 6;

            // Days in month
            const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

            // Add empty cells for days before month start
            for (let i = 0; i < firstWeekday; i++) {
                const emptyCell = document.createElement('div');
                daysGrid.appendChild(emptyCell);
            }

            // Add day buttons
            for (let day = 1; day <= daysInMonth; day++) {
                const dayBtn = document.createElement('button');
                dayBtn.textContent = day;
                dayBtn.style.padding = '4px';
                dayBtn.style.cursor = 'pointer';
                dayBtn.style.fontSize = '10px';
                dayBtn.style.backgroundColor = '#c0c0c0';
                dayBtn.style.border = '1px outset #dfdfdf';

                const dayDate = new Date(currentYear, currentMonth, day);
                if (this.value && dayDate.toDateString() === this.value.toDateString()) {
                    dayBtn.style.backgroundColor = '#000080';
                    dayBtn.style.color = '#ffffff';
                }

                dayBtn.addEventListener('click', () => {
                    let selectedDate = new Date(currentYear, currentMonth, day);
                    if (this.showTime && this.value) {
                        selectedDate.setHours(this.value.getHours());
                        selectedDate.setMinutes(this.value.getMinutes());
                    }
                    this.setValue(selectedDate);
                    calendar.element.remove();
                    this.calendarPopup = null;
                });

                daysGrid.appendChild(dayBtn);
            }

            contentArea.appendChild(daysGrid);

            // Today button
            const todayBtn = new Button();
            todayBtn.setCaption('Сегодня');
            todayBtn.setWidth(80);
            todayBtn.setHeight(22);
            todayBtn.setX(100);
            todayBtn.setY(this.showTime ? 220 : 190);
            todayBtn.onClick = () => {
                this.setValue(new Date());
                calendar.element.remove();
                this.calendarPopup = null;
            };
            todayBtn.Draw(contentArea);
        };

        renderCalendar();

        calendar.Draw(document.body);
        calendar.activate();
        this.calendarPopup = calendar;
    }

    Draw(container) {
        // Prepare container/label
        super.Draw(container);

        if (!this.element) {
            this.element = document.createElement('div');
            this.element.style.display = 'inline-flex';
            this.element.style.alignItems = 'center';
            this.element.style.gap = '2px';

            // Positioning
            if (!this.parentElement) {
                this.element.style.position = 'absolute';
                this.element.style.left = this.x + 'px';
                this.element.style.top = this.y + 'px';
                this.element.style.zIndex = this.z;
            }

            // Text input
            const input = document.createElement('input');
            input.type = 'text';
            try { input.id = input.id || 'date_' + Math.random().toString(36).substr(2,9); } catch (_) {}
            try { input.name = input.name || input.id; } catch (_) {}
            input.value = this.formatDate(this.value);
            input.disabled = this.readOnly;
            input.style.width = this.showTime ? '120px' : '80px';
            input.style.height = '20px';
            input.style.padding = '2px 4px';
            input.style.fontFamily = 'MS Sans Serif, sans-serif';
            input.style.fontSize = '11px';
            input.style.backgroundColor = '#ffffff';
            input.style.borderTop = '2px solid #808080';
            input.style.borderLeft = '2px solid #808080';
            input.style.borderRight = '2px solid #ffffff';
            input.style.borderBottom = '2px solid #ffffff';
            input.style.outline = 'none';
            input.style.boxSizing = 'border-box';

            // Calendar button
            const button = document.createElement('button');
            button.textContent = '📅';
            button.disabled = this.readOnly;
            button.style.width = '24px';
            button.style.height = '20px';
            button.style.padding = '0';
            button.style.cursor = this.readOnly ? 'default' : 'pointer';
            button.style.backgroundColor = '#c0c0c0';
            button.style.borderTop = '2px solid #ffffff';
            button.style.borderLeft = '2px solid #ffffff';
            button.style.borderRight = '2px solid #808080';
            button.style.borderBottom = '2px solid #808080';
            button.style.fontSize = '12px';
            button.style.boxSizing = 'border-box';

            // Events
            input.addEventListener('blur', (e) => {
                const parsed = this.parseDate(e.target.value);
                if (parsed) {
                    this.setValue(parsed);
                } else if (e.target.value.trim() === '') {
                    this.setValue(null);
                } else {
                    // Invalid format, restore previous value
                    e.target.value = this.formatDate(this.value);
                }
            });

            button.addEventListener('click', () => {
                this.openCalendar();
            });

            this.element.appendChild(input);
            this.element.appendChild(button);
        }

        try {
            if (this.containerElement) this.containerElement.appendChild(this.element);
            else if (container) container.appendChild(this.element);
        } catch (e) {}

        return this.element;
    }
}

// DynamicTable class for displaying tabular data with virtual scrolling
class DynamicTable extends UIObject {
    constructor(options = {}) {
        super();
        
        // Options
        this.appName = options.appName || '';
        this.tableName = options.tableName || '';
        this.rowHeight = options.rowHeight || 25;
        this.bufferRows = 10; // Client-side rendering buffer (server limits actual data)
        this.multiSelect = options.multiSelect !== undefined ? options.multiSelect : false;
        this.editable = options.editable !== undefined ? options.editable : false;
        this.showToolbar = options.showToolbar !== undefined ? options.showToolbar : this.editable;
        this.initialSort = options.initialSort || [];
        this.initialFilter = options.initialFilter || [];
        this.onRowClick = options.onRowClick || null;
        this.onRowDoubleClick = options.onRowDoubleClick || null;
        this.onSelectionChanged = options.onSelectionChanged || null;
        
        // State
        this.totalRows = 0;
        this.fields = [];
        this.dataCache = {}; // globalIndex -> rowData
        this.currentSort = this.initialSort;
        this.currentFilters = this.initialFilter;
        this.visibleRows = 20;
        this.firstVisibleRow = 0;
        this.selectedRows = new Set();
        this.lastSelectedIndex = null;
        this.isLoading = false;
        this.dataLoaded = false;
        this.editSessionId = null; // Edit session ID from server
        this.editedCells = new Map(); // Track edited cells: key = 'rowId_fieldName', value = newValue
        
        // DOM elements
        this.toolbarContainer = null;
        this.tableContainer = null;
        this.headerContainer = null;
        this.bodyContainer = null;
        this.scrollContainer = null;
        this.tableElement = null;
        this.loadingOverlay = null;
        this.eventSource = null; // SSE connection
        this.currentEditCell = null; // Currently editing cell
        
        // Resize state
        this.resizeState = {
            isResizing: false,
            columnIndex: null,
            startX: 0,
            startWidth: 0
        };
        
        // Keyboard navigation
        this.currentRowIndex = null;
    }
    
    async Draw(container) {
        if (!this.element) {
            this.element = document.createElement('div');
            this.element.classList.add('ui-dynamictable');
            this.element.style.position = 'relative';
            this.element.style.width = '100%';
            this.element.style.height = '100%';
            this.element.style.boxSizing = 'border-box'; // Include border in size calculation
            this.element.style.overflow = 'hidden';
            this.element.style.display = 'flex';
            this.element.style.flexDirection = 'column';
            this.element.style.backgroundColor = '#c0c0c0';
            this.element.style.borderTop = '2px solid #808080';
            this.element.style.borderLeft = '2px solid #808080';
            this.element.style.borderRight = '2px solid #ffffff';
            this.element.style.borderBottom = '2px solid #ffffff';
            this.element.style.fontFamily = 'MS Sans Serif, sans-serif';
            this.element.style.fontSize = '11px';
            this.element.tabIndex = 0; // Make focusable
            this.element.style.outline = 'none';
            this.element.style.userSelect = 'none'; // Disable text selection
            
            // Toolbar (if enabled) - FIRST, before header
            if (this.showToolbar) {
                const toolbar = new Toolbar(this.element);
                toolbar.compact = true; // Compact mode: no spacing between buttons
                toolbar.height = 28;
                
                // Standard table buttons
                if (this.editable) {
                    const addBtn = new Button();
                    addBtn.setCaption('Добавить');
                    addBtn.setIcon('/app/res/public/fontawesome-free-7.1.0-web/svgs/solid/plus.svg');
                    addBtn.showIcon = true;
                    addBtn.showText = false;
                    addBtn.setTooltip('Добавить новую запись');
                    addBtn.setWidth(100);
                    addBtn.setHeight(28);
                    addBtn.onClick = () => {
                        console.log('[DynamicTable] Add button clicked');
                    };
                    toolbar.addItem(addBtn);
                    
                    const delBtn = new Button();
                    delBtn.setCaption('Удалить');
                    delBtn.setIcon('/app/res/public/fontawesome-free-7.1.0-web/svgs/solid/trash-can.svg');
                    delBtn.showIcon = true;
                    delBtn.showText = false;
                    delBtn.setTooltip('Удалить выбранные записи');
                    delBtn.setWidth(100);
                    delBtn.setHeight(28);
                    delBtn.onClick = () => {
                        const selected = this.getSelectedRows();
                        if (selected.length === 0) {
                            showAlert('Выберите строки для удаления');
                            return;
                        }
                    };
                    toolbar.addItem(delBtn);
                }
                
                toolbar.Draw(this.element);
            }
            
            // Header container
            this.headerContainer = document.createElement('div');
            this.headerContainer.style.position = 'relative';
            this.headerContainer.style.width = '100%';
            this.headerContainer.style.boxSizing = 'border-box'; // Include padding in width
            this.headerContainer.style.flex = '0 0 auto'; // Don't grow, don't shrink, auto height
            this.headerContainer.style.backgroundColor = '#c0c0c0';
            this.headerContainer.style.borderBottom = '2px solid #808080';
            this.headerContainer.style.userSelect = 'none'; // Disable text selection in headers
            this.headerContainer.style.overflowX = 'hidden'; // Hide horizontal overflow
            this.element.appendChild(this.headerContainer);
            
            // Body container with scrolling
            this.bodyContainer = document.createElement('div');
            this.bodyContainer.style.position = 'relative';
            this.bodyContainer.style.width = '100%';
            this.bodyContainer.style.flex = '1 1 auto'; // Grow to fill remaining space
            this.bodyContainer.style.overflow = 'auto';
            this.bodyContainer.style.backgroundColor = '#ffffff'; // White background
            this.bodyContainer.style.userSelect = 'none'; // Disable text selection in body
            this.element.appendChild(this.bodyContainer);
            
            // Sync horizontal scroll between header and body
            this.bodyContainer.addEventListener('scroll', () => {
                this.headerContainer.scrollLeft = this.bodyContainer.scrollLeft;
            });
            
            // Setup keyboard navigation
            this.setupKeyboardNavigation();
            
            // Setup SSE (optional, can be disabled for MVP)
            // this.connectSSE();
        }
        
        if (container) {
            container.appendChild(this.element);
            
            // Load initial data AFTER element is in DOM so clientHeight is available
            if (!this.dataLoaded) {
                this.dataLoaded = true;
                await this.refresh();
            }
        }
        
        return this.element;
    }
    
    async refresh() {
        this.showLoadingIndicator();
        try {
            this.calculateVisibleRows();
            await this.loadData(this.firstVisibleRow);
        } catch (error) {
            console.error('[DynamicTable] Refresh error:', error);
            if (typeof showAlert === 'function') {
                showAlert('Ошибка обновления данных: ' + error.message);
            }
        } finally {
            this.hideLoadingIndicator();
        }
    }
    
    calculateVisibleRows() {
        if (this.bodyContainer && this.bodyContainer.clientHeight > 0) {
            const containerHeight = this.bodyContainer.clientHeight;
            this.visibleRows = Math.ceil(containerHeight / this.rowHeight) + this.bufferRows;
        } else {
            // Fallback if container not yet rendered
            this.visibleRows = 30;
        }
    }
    
    async loadData(firstRow) {
        if (this.isLoading) return;
        this.isLoading = true;
        
        try {
            const data = await callServerMethod(this.appName, 'getDynamicTableData', {
                tableName: this.tableName,
                firstRow: firstRow,
                visibleRows: this.visibleRows,
                sort: this.currentSort,
                filters: this.currentFilters
            });
            
            this.totalRows = data.totalRows;
            this.fields = data.fields;
            this.editSessionId = data.editSessionId; // Save edit session ID
            
            // Update cache
            data.data.forEach((row, index) => {
                const globalIndex = data.range.from + index;
                this.dataCache[globalIndex] = { ...row, loaded: true, __index: globalIndex };
            });
            
            // Render table
            this.renderTable();
            
        } catch (error) {
            throw error;
        } finally {
            this.isLoading = false;
        }
    }
    
    renderTable() {
        // Render header
        this.renderHeader();
        
        // Render body
        this.renderBody();
        
        // Adjust header for scrollbar
        this.adjustHeaderForScrollbar();
    }
    
    adjustHeaderForScrollbar() {
        // Calculate scrollbar width
        const scrollbarWidth = this.bodyContainer.offsetWidth - this.bodyContainer.clientWidth;
        
        // Add padding to header to compensate for scrollbar
        if (scrollbarWidth > 0) {
            this.headerContainer.style.paddingRight = scrollbarWidth + 'px';
        } else {
            this.headerContainer.style.paddingRight = '0';
        }
    }
    
    renderHeader() {
        this.headerContainer.innerHTML = '';
        
        const table = document.createElement('table');
        table.style.width = '100%';
        table.style.borderCollapse = 'separate';
        table.style.borderSpacing = '0';
        table.style.tableLayout = 'fixed';
        
        // Add colgroup to explicitly set column widths
        const colgroup = document.createElement('colgroup');
        this.fields.forEach((field, index) => {
            const col = document.createElement('col');
            // Last column gets remaining space, others are fixed
            if (index === this.fields.length - 1) {
                col.style.width = 'auto';
            } else {
                col.style.width = field.width + 'px';
            }
            colgroup.appendChild(col);
        });
        table.appendChild(colgroup);
        
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        
        this.fields.forEach((field, index) => {
            const th = document.createElement('th');
            th.style.width = field.width + 'px';
            th.style.boxSizing = 'border-box'; // Include padding and border in width
            th.style.padding = '4px 8px';
            th.style.backgroundColor = '#c0c0c0';
            th.style.borderTop = '2px solid #ffffff';
            th.style.borderLeft = '2px solid #ffffff';
            th.style.borderRight = '2px solid #808080';
            th.style.borderBottom = '2px solid #808080';
            th.style.fontWeight = 'bold';
            th.style.textAlign = 'left';
            th.style.cursor = 'pointer';
            th.style.userSelect = 'none';
            th.style.position = 'relative';
            th.style.whiteSpace = 'nowrap';
            th.style.overflow = 'hidden';
            th.style.textOverflow = 'ellipsis';
            th.textContent = field.caption;
            
            // Sort indicator
            const sortItem = this.currentSort.find(s => s.field === field.name);
            if (sortItem) {
                th.textContent += sortItem.order === 'asc' ? ' ▲' : ' ▼';
            }
            
            // Click to sort
            th.addEventListener('click', (e) => {
                if (!this.resizeState.isResizing) {
                    this.toggleSort(field.name);
                }
            });
            
            // Resize handle
            const resizeHandle = document.createElement('div');
            resizeHandle.style.position = 'absolute';
            resizeHandle.style.top = '0';
            resizeHandle.style.right = '0';
            resizeHandle.style.width = '5px';
            resizeHandle.style.height = '100%';
            resizeHandle.style.cursor = 'col-resize';
            resizeHandle.style.zIndex = '10';
            
            resizeHandle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                this.startResize(index, e.clientX, field.width);
            });
            
            th.appendChild(resizeHandle);
            headerRow.appendChild(th);
        });
        
        thead.appendChild(headerRow);
        table.appendChild(thead);
        this.headerContainer.appendChild(table);
    }
    
    renderBody() {
        // Save current scroll position
        const savedScrollTop = this.bodyContainer.scrollTop || 0;
        
        this.bodyContainer.innerHTML = '';
        
        // Create scroll container with full height
        const scrollContainer = document.createElement('div');
        scrollContainer.style.position = 'relative';
        scrollContainer.style.height = (this.totalRows * this.rowHeight) + 'px';
        scrollContainer.style.width = '100%';
        
        // Create visible table
        const table = document.createElement('table');
        table.style.width = '100%';
        table.style.borderCollapse = 'collapse';
        table.style.tableLayout = 'fixed';
        table.style.position = 'absolute';
        table.style.top = '0';
        
        // Add colgroup to explicitly set column widths
        const colgroup = document.createElement('colgroup');
        this.fields.forEach((field, index) => {
            const col = document.createElement('col');
            // Last column gets remaining space, others are fixed
            if (index === this.fields.length - 1) {
                col.style.width = 'auto';
            } else {
                col.style.width = field.width + 'px';
            }
            colgroup.appendChild(col);
        });
        table.appendChild(colgroup);
        
        const tbody = document.createElement('tbody');
        
        // Calculate visible range based on saved scroll position
        const scrollTop = savedScrollTop;
        const firstVisible = Math.floor(scrollTop / this.rowHeight);
        const visibleRowCount = Math.ceil(this.bodyContainer.clientHeight / this.rowHeight);
        const lastVisible = firstVisible + visibleRowCount;
        
        // Add buffer rows for smooth scrolling
        const renderFirst = Math.max(0, firstVisible - this.bufferRows);
        const renderLast = Math.min(this.totalRows, lastVisible + this.bufferRows);
        
        // Save for scroll optimization
        this.lastRenderedFirstRow = firstVisible;
        
        // Position table at first rendered row (including buffer)
        table.style.top = (renderFirst * this.rowHeight) + 'px';
        
        // Render visible rows + buffer
        for (let i = renderFirst; i < renderLast; i++) {
            const rowData = this.dataCache[i] || { loaded: false, __index: i };
            const tr = this.renderRow(rowData, i);
            tbody.appendChild(tr);
        }
        
        table.appendChild(tbody);
        scrollContainer.appendChild(table);
        this.bodyContainer.appendChild(scrollContainer);
        
        // Restore scroll position after DOM update
        this.bodyContainer.scrollTop = savedScrollTop;
        
        // Setup scroll handler
        this.bodyContainer.addEventListener('scroll', () => {
            this.onScroll();
        });
    }
    
    renderRow(rowData, rowIndex) {
        const tr = document.createElement('tr');
        tr.dataset.rowIndex = rowIndex;
        tr.style.height = this.rowHeight + 'px';
        
        // Zebra striping
        tr.style.backgroundColor = rowIndex % 2 === 0 ? '#ffffff' : '#f0f0f0';
        
        // Selection highlight
        if (this.selectedRows.has(rowIndex)) {
            tr.style.backgroundColor = '#000080';
            tr.style.color = '#ffffff';
        }
        
        // Render cells
        this.fields.forEach((field, fieldIndex) => {
            const td = document.createElement('td');
            td.style.width = field.width + 'px';
            td.style.boxSizing = 'border-box'; // Include padding and border in width
            td.style.padding = '4px 8px';
            td.style.borderRight = '1px solid #c0c0c0';
            td.style.whiteSpace = 'nowrap';
            td.style.overflow = 'hidden';
            td.style.textOverflow = 'ellipsis';
            
            if (!rowData.loaded) {
                td.style.opacity = '0.3';
                td.textContent = '...';
            } else {
                // Get value
                let value = rowData[field.name];
                
                // For foreign keys, use display value
                if (field.foreignKey && rowData[`__${field.name}_display`] !== undefined) {
                    value = rowData[`__${field.name}_display`];
                }
                
                // Format value by type
                td.textContent = this.formatValue(value, field.type);
                
                // Check if edited
                const cellKey = `${rowData.id}_${field.name}`;
                if (this.editedCells.has(cellKey)) {
                    td.style.backgroundColor = '#ffffcc'; // Mark edited cells
                }
                
                // Make cell editable if allowed
                if (this.editable && field.editable && !field.foreignKey) {
                    td.style.cursor = 'text';
                    td.addEventListener('click', (e) => {
                        e.stopPropagation();
                        // Select the row first
                        if (!this.selectedRows.has(rowIndex)) {
                            this.selectedRows.clear();
                            this.selectedRows.add(rowIndex);
                            this.lastSelectedIndex = rowIndex;
                            this.currentRowIndex = rowIndex;
                            this.renderBody();
                        }
                        this.startCellEdit(td, rowData, field, rowIndex);
                    });
                }
            }
            
            tr.appendChild(td);
        });
        
        // Click events
        tr.addEventListener('click', (e) => {
            this.onRowClickHandler(rowData, rowIndex, e);
        });
        
        tr.addEventListener('dblclick', (e) => {
            this.onRowDoubleClickHandler(rowData, rowIndex);
        });
        
        return tr;
    }
    
    formatValue(value, type) {
        if (value === null || value === undefined) return '';
        
        switch (type) {
            case 'BOOLEAN':
                return value ? '☑' : '☐';
            case 'DATE':
            case 'DATEONLY':
                if (value instanceof Date) {
                    const dd = String(value.getDate()).padStart(2, '0');
                    const mm = String(value.getMonth() + 1).padStart(2, '0');
                    const yyyy = value.getFullYear();
                    return `${dd}.${mm}.${yyyy}`;
                }
                // Parse from string
                const date = new Date(value);
                if (!isNaN(date.getTime())) {
                    const dd = String(date.getDate()).padStart(2, '0');
                    const mm = String(date.getMonth() + 1).padStart(2, '0');
                    const yyyy = date.getFullYear();
                    return `${dd}.${mm}.${yyyy}`;
                }
                return value.toString();
            case 'DECIMAL':
            case 'FLOAT':
                return parseFloat(value).toFixed(2);
            default:
                return value.toString();
        }
    }
    
    onScroll() {
        const scrollTop = this.bodyContainer.scrollTop;
        const newFirstVisible = Math.floor(scrollTop / this.rowHeight);
        
        // Check if visible range changed significantly
        const currentFirstVisible = this.lastRenderedFirstRow || 0;
        const rowDiff = Math.abs(newFirstVisible - currentFirstVisible);
        
        // Only re-render if we scrolled more than 5 rows
        if (rowDiff < 5) {
            return;
        }
        
        // Check if we need to load more data
        const needsReload = this.needsDataReload(newFirstVisible);
        
        if (needsReload) {
            this.loadData(newFirstVisible);
        } else {
            // Just re-render with cached data
            this.renderBody();
        }
    }
    
    needsDataReload(firstRow) {
        const visibleRange = Math.ceil(this.bodyContainer.clientHeight / this.rowHeight);
        
        // Check if data is in cache
        for (let i = firstRow; i < firstRow + visibleRange; i++) {
            if (i >= this.totalRows) break;
            if (!this.dataCache[i] || !this.dataCache[i].loaded) {
                return true;
            }
        }
        
        return false;
    }
    
    onRowClickHandler(rowData, rowIndex, event) {
        if (!rowData.loaded) {
            if (typeof showAlert === 'function') {
                showAlert('Данные ещё не загружены. Подождите.');
            }
            return;
        }
        
        if (this.multiSelect && event.shiftKey && this.lastSelectedIndex !== null) {
            // Range selection with Shift
            const start = Math.min(this.lastSelectedIndex, rowIndex);
            const end = Math.max(this.lastSelectedIndex, rowIndex);
            this.selectedRows.clear();
            for (let i = start; i <= end; i++) {
                this.selectedRows.add(i);
            }
        } else if (this.multiSelect && event.ctrlKey) {
            // Toggle single row selection with Ctrl
            if (this.selectedRows.has(rowIndex)) {
                this.selectedRows.delete(rowIndex);
            } else {
                this.selectedRows.add(rowIndex);
            }
            this.lastSelectedIndex = rowIndex;
        } else {
            // Single selection without modifiers
            this.selectedRows.clear();
            this.selectedRows.add(rowIndex);
            this.lastSelectedIndex = rowIndex;
        }
        
        this.currentRowIndex = rowIndex;
        this.renderBody(); // Re-render to show selection
        
        if (this.onRowClick) {
            this.onRowClick(rowData, rowIndex);
        }
        
        if (this.onSelectionChanged) {
            this.onSelectionChanged(this.getSelectedRows());
        }
    }
    
    onRowDoubleClickHandler(rowData, rowIndex) {
        if (!rowData.loaded) {
            if (typeof showAlert === 'function') {
                showAlert('Данные ещё не загружены. Подождите.');
            }
            return;
        }
        
        if (this.onRowDoubleClick) {
            this.onRowDoubleClick(rowData, rowIndex);
        }
    }
    
    toggleSort(fieldName) {
        const existing = this.currentSort.find(s => s.field === fieldName);
        
        if (existing) {
            // Toggle order
            existing.order = existing.order === 'asc' ? 'desc' : 'asc';
        } else {
            // Add new sort
            this.currentSort = [{ field: fieldName, order: 'asc' }];
        }
        
        // Reload data
        this.clearCache();
        this.refresh();
    }
    
    setSort(sortArray) {
        this.currentSort = sortArray;
        this.clearCache();
        this.refresh();
    }
    
    setFilter(filterArray) {
        this.currentFilters = filterArray;
        this.clearCache();
        this.refresh();
    }
    
    clearCache() {
        this.dataCache = {};
    }
    
    getSelectedRows() {
        const rows = [];
        this.selectedRows.forEach(index => {
            if (this.dataCache[index] && this.dataCache[index].loaded) {
                rows.push(this.dataCache[index]);
            }
        });
        return rows;
    }
    
    clearSelection() {
        this.selectedRows.clear();
        this.lastSelectedIndex = null;
        this.currentRowIndex = null;
        this.renderBody();
    }
    
    scrollToRow(rowIndex) {
        const scrollTop = rowIndex * this.rowHeight;
        this.bodyContainer.scrollTop = scrollTop;
    }
    
    startCellEdit(td, rowData, field, rowIndex) {
        if (!this.editable || !field.editable || field.foreignKey) {
            return;
        }
        
        // Close previous edit if exists
        if (this.currentEditCell) {
            this.finishCellEdit(false);
        }
        
        const currentValue = rowData[field.name];
        const input = document.createElement('input');
        input.type = 'text';
        try { input.id = input.id || 'celledit_' + Math.random().toString(36).substr(2,9); } catch (_) {}
        try { input.name = input.name || input.id; } catch (_) {}
        input.value = this.formatValue(currentValue, field.type);
        input.style.width = '100%';
        input.style.boxSizing = 'border-box';
        input.style.border = '1px solid #0000ff';
        input.style.padding = '2px';
        input.style.fontFamily = 'Tahoma, Arial, sans-serif';
        input.style.fontSize = '11px';
        // Preserve selection colors for input in selected row
        if (this.selectedRows.has(rowIndex)) {
            input.style.backgroundColor = '#000080';
            input.style.color = '#ffffff';
        }
        
        this.currentEditCell = {
            td: td,
            input: input,
            rowData: rowData,
            field: field,
            originalValue: currentValue,
            rowIndex: rowIndex
        };
        
        td.textContent = '';
        td.appendChild(input);
        input.focus();
        input.select();
        
        // Handle Enter - save
        input.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                await this.finishCellEdit(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.finishCellEdit(false);
            }
        });
        
        // Handle blur - save
        input.addEventListener('blur', async () => {
            await this.finishCellEdit(true);
        });
    }
    
    async finishCellEdit(save) {
        if (!this.currentEditCell) return;
        
        const { td, input, rowData, field, originalValue } = this.currentEditCell;
        const newValue = input.value;
        
        // Restore text content
        td.textContent = save ? newValue : this.formatValue(originalValue, field.type);
        
        if (save && newValue !== this.formatValue(originalValue, field.type)) {
            // Send to server
            try {
                await callServerMethod(this.appName, 'recordTableEdit', {
                    editSessionId: this.editSessionId,
                    rowId: rowData.id,
                    fieldName: field.name,
                    newValue: newValue
                });
                
                // Mark as edited
                const cellKey = `${rowData.id}_${field.name}`;
                this.editedCells.set(cellKey, newValue);
                td.style.backgroundColor = '#ffffcc';
                
                // Update cache
                rowData[field.name] = newValue;
                
            } catch (e) {
                showAlert('Ошибка сохранения: ' + e.message);
                td.textContent = this.formatValue(originalValue, field.type);
            }
        }
        
        this.currentEditCell = null;
    }
    
    async saveChanges() {
        if (!this.editSessionId) {
            showAlert('Нет активной сессии редактирования');
            return;
        }
        
        if (this.editedCells.size === 0) {
            showAlert('Нет изменений для сохранения');
            return;
        }
        
        try {
            const result = await callServerMethod(this.appName, 'commitTableEdits', {
                editSessionId: this.editSessionId
            });
            
            if (result.success) {
                // Clear edited marks
                this.editedCells.clear();
                
                // Reload table with new session ID
                this.editSessionId = result.newEditSessionId;
                await this.refresh();
                
                showAlert(`Изменения сохранены: ${result.updatedRows} строк`);
            }
        } catch (e) {
            showAlert('Ошибка применения изменений: ' + e.message);
        }
    }
    
    startResize(columnIndex, startX, startWidth) {
        this.resizeState.isResizing = true;
        this.resizeState.columnIndex = columnIndex;
        this.resizeState.startX = startX;

        this.resizeState.startWidth = startWidth;
        
        const mouseMoveHandler = (e) => {
            if (this.resizeState.isResizing) {
                const diff = e.clientX - this.resizeState.startX;
                const newWidth = Math.max(50, this.resizeState.startWidth + diff);
                this.fields[this.resizeState.columnIndex].width = newWidth;
                this.renderTable();
            }
        };
        
        const mouseUpHandler = () => {
            if (this.resizeState.isResizing) {
                this.resizeState.isResizing = false;
                document.removeEventListener('mousemove', mouseMoveHandler);
                document.removeEventListener('mouseup', mouseUpHandler);
                
                // Save column widths
                this.saveColumnWidths();
            }
        };
        
        document.addEventListener('mousemove', mouseMoveHandler);
        document.addEventListener('mouseup', mouseUpHandler);
    }
    
    async saveColumnWidths() {
        try {
            await callServerMethod(this.appName, 'saveClientState', {
                window: 'dynamicTable',
                component: this.tableName,
                data: {
                    columns: this.fields.map(f => ({ name: f.name, width: f.width }))
                }
            });
        } catch (error) {
            console.error('[DynamicTable] Error saving column widths:', error);
        }
    }
    
    setupKeyboardNavigation() {
        this.element.addEventListener('keydown', (e) => {
            if (this.currentRowIndex === null && this.totalRows > 0) {
                this.currentRowIndex = 0;
            }
            
            switch (e.key) {
                case 'ArrowUp':
                    e.preventDefault();
                    if (this.currentRowIndex > 0) {
                        this.navigateToRow(this.currentRowIndex - 1, e.shiftKey);
                    }
                    break;
                    
                case 'ArrowDown':
                    e.preventDefault();
                    if (this.currentRowIndex < this.totalRows - 1) {
                        this.navigateToRow(this.currentRowIndex + 1, e.shiftKey);
                    }
                    break;
                    
                case 'PageUp':
                    e.preventDefault();
                    const pageSize = Math.floor(this.bodyContainer.clientHeight / this.rowHeight);
                    this.navigateToRow(Math.max(0, this.currentRowIndex - pageSize), e.shiftKey);
                    break;
                    
                case 'PageDown':
                    e.preventDefault();
                    const pageSize2 = Math.floor(this.bodyContainer.clientHeight / this.rowHeight);
                    this.navigateToRow(Math.min(this.totalRows - 1, this.currentRowIndex + pageSize2), e.shiftKey);
                    break;
                    
                case 'Home':
                    e.preventDefault();
                    this.navigateToRow(0, e.shiftKey);
                    break;
                    
                case 'End':
                    e.preventDefault();
                    this.navigateToRow(this.totalRows - 1, e.shiftKey);
                    break;
                    
                case 'Enter':
                    e.preventDefault();
                    if (this.currentRowIndex !== null) {
                        const rowData = this.dataCache[this.currentRowIndex];
                        if (rowData) {
                            this.onRowDoubleClickHandler(rowData, this.currentRowIndex);
                        }
                    }
                    break;
            }
        });
    }
    
    navigateToRow(newIndex, extendSelection) {
        if (newIndex < 0 || newIndex >= this.totalRows) return;
        
        if (this.multiSelect && extendSelection) {
            // Extend selection
            if (this.lastSelectedIndex === null) {
                this.lastSelectedIndex = this.currentRowIndex;
            }
            const start = Math.min(this.lastSelectedIndex, newIndex);
            const end = Math.max(this.lastSelectedIndex, newIndex);
            this.selectedRows.clear();
            for (let i = start; i <= end; i++) {
                this.selectedRows.add(i);
            }
        } else {
            // Single selection
            this.selectedRows.clear();
            this.selectedRows.add(newIndex);
            this.lastSelectedIndex = newIndex;
        }
        
        this.currentRowIndex = newIndex;
        
        // Auto-scroll to keep visible
        const scrollTop = this.bodyContainer.scrollTop;
        const scrollHeight = this.bodyContainer.clientHeight;
        const rowTop = newIndex * this.rowHeight;
        const rowBottom = rowTop + this.rowHeight;
        
        if (rowTop < scrollTop) {
            this.bodyContainer.scrollTop = rowTop;
        } else if (rowBottom > scrollTop + scrollHeight) {
            this.bodyContainer.scrollTop = rowBottom - scrollHeight;
        }
        
        // Check if we need to load data
        if (!this.dataCache[newIndex] || !this.dataCache[newIndex].loaded) {
            this.loadData(newIndex);
        } else {
            this.renderBody();
        }
        
        if (this.onSelectionChanged) {
            this.onSelectionChanged(this.getSelectedRows());
        }
    }
    
    showLoadingIndicator() {
        if (this.loadingOverlay) return;
        
        const overlay = document.createElement('div');
        overlay.style.position = 'absolute';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.right = '0';
        overlay.style.bottom = '0';
        overlay.style.background = 'rgba(192, 192, 192, 0.7)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.zIndex = '1000';
        
        const label = document.createElement('div');
        label.textContent = 'Loading...';
        label.style.padding = '10px 20px';
        label.style.background = '#c0c0c0';
        label.style.borderTop = '2px solid #ffffff';
        label.style.borderLeft = '2px solid #ffffff';
        label.style.borderRight = '2px solid #808080';
        label.style.borderBottom = '2px solid #808080';
        label.style.fontFamily = 'MS Sans Serif, sans-serif';
        label.style.fontSize = '11px';
        overlay.appendChild(label);
        
        this.element.appendChild(overlay);
        this.loadingOverlay = overlay;
    }
    
    hideLoadingIndicator() {
        if (this.loadingOverlay) {
            this.loadingOverlay.remove();
            this.loadingOverlay = null;
        }
    }
    
    connectSSE() {
        if (!this.appName || !this.tableName) return;
        
        const url = `/app/${this.appName}/subscribeToTable?tableName=${this.tableName}`;
        this.eventSource = new EventSource(url);
        
        this.eventSource.onopen = () => {
            console.log('[DynamicTable] SSE connected');
        };
        
        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                if (data.type === 'connected') {
                    console.log('[DynamicTable] SSE: connection confirmed');
                } else if (data.type === 'dataChanged') {
                    console.log('[DynamicTable] Data changed:', data.action);
                    this.clearCache();
                    this.refresh();
                }
            } catch (e) {
                console.error('[DynamicTable] SSE message parse error:', e);
            }
        };
        
        this.eventSource.onerror = (error) => {
            console.error('[DynamicTable] SSE error, reconnecting in 3s...', error);
            if (this.eventSource) {
                this.eventSource.close();
                this.eventSource = null;
            }
            
            setTimeout(() => {
                this.connectSSE();
            }, 3000);
        };
    }
    
    destroy() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        
        if (this.element && this.element.parentElement) {
            this.element.parentElement.removeChild(this.element);
        }
        
        this.element = null;
        this.dataCache = {};
    }
}
