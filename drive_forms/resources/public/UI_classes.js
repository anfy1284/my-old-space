
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

// DataForm relocated below (defined after Form)

// Base class for form input controls: provides common label/container helpers
class FormInput extends UIObject {
    constructor(parentElement = null, properties = {}) {
        super();
        this.parentElement = parentElement;
        this.containerElement = null; // optional wrapper when placed inside a parent
        this._labelInstance = null; // Label instance (if used)
        this.showLabel = false;
        // Whether to show a border around the input container. Default: true.
        // Some controls (those that use an input container) will respect this.
        this.showBorder = true;
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
            this.containerElement.style.margin = '0';
            // Prefer CSS classes over inline borders to avoid visual regressions.
            // Add standard input container class so styling comes from stylesheet.
            try { this.containerElement.classList.add('ui-input-container'); } catch (e) {}
            // If explicitly requested to hide border, mark container with helper class
            try { if (this.showBorder === false) this.containerElement.classList.add('ui-input-no-border'); } catch (e) {}
            this.containerElement.style.backgroundColor = 'transparent';
            this.containerElement.style.outline = 'none';
            this.containerElement.style.width = '100%';
        }
        // Inject global CSS to hide native input borders inside containers marked as no-border
        try {
            if (typeof document !== 'undefined' && !document._uiInputNoBorderStyleInjected) {
                const ss = document.createElement('style');
                ss.type = 'text/css';
                ss.appendChild(document.createTextNode('\n.ui-input-no-border { border: none !important; padding: 0 !important; }\n.ui-input-no-border input, .ui-input-no-border textarea, .ui-input-no-border select { border: none !important; background: transparent !important; box-shadow: none !important; outline: none !important; }\n/* Keep embedded control buttons visible and 3D inside no-border containers (e.g., table cells) */\n.ui-input-no-border .ui-input-container button, .ui-input-no-border button { background: #ffffff !important; box-shadow: none !important; }\n.ui-input-no-border .ui-input-container button, .ui-input-no-border .ui-input-container > button { border-top: 2px solid #ffffff !important; border-left: 2px solid #ffffff !important; border-right: 2px solid #808080 !important; border-bottom: 2px solid #808080 !important; padding: 0 !important; margin: 0 !important; min-width: 18px !important; height: 100% !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; cursor: default !important; }\n'));
                (document.head || document.getElementsByTagName('head')[0] || document.documentElement).appendChild(ss);
                document._uiInputNoBorderStyleInjected = true;
            }
        } catch (e) {}

        // If container created and showBorder is false, add helper class to hide inner input borders
        try {
            if (this.containerElement && this.showBorder === false) {
                this.containerElement.classList.add('ui-input-no-border');
            }
        } catch (e) {}

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

    // Clean up DOM and observers when control is no longer needed
    destroy() {
        try {
            if (this._ro && typeof this._ro.disconnect === 'function') {
                try { this._ro.disconnect(); } catch (e) {}
                this._ro = null;
            }
        } catch (e) {}

        try { if (this.inputContainer && typeof this.inputContainer.remove === 'function') this.inputContainer.remove(); } catch (e) {}
        try { if (this.element && typeof this.element.remove === 'function') this.element.remove(); } catch (e) {}
        try { if (this.containerElement && typeof this.containerElement.remove === 'function') this.containerElement.remove(); } catch (e) {}
        try { if (this._labelInstance && this._labelInstance.element && typeof this._labelInstance.element.remove === 'function') this._labelInstance.element.remove(); } catch (e) {}

        // Nullify references to assist GC
        try { this.element = null; } catch (e) {}
        try { this.inputContainer = null; } catch (e) {}
        try { this.containerElement = null; } catch (e) {}
        try { this._labelInstance = null; } catch (e) {}
        try { this._listBtn = null; } catch (e) {}
        try { this._selectBtn = null; } catch (e) {}
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

        // If no container explicitly provided, append form to document.body
        // so Form.Draw() will render the form visibly by default.
        if (typeof document !== 'undefined' && (container === undefined || container === null)) {
            container = document.body;
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

// DataForm: specialized Form that knows how to load/render layout/data for
// data-driven apps. This class mirrors the instance helper methods previously
// defined on individual app forms and centralizes them here for reuse.
class DataForm extends Form {
    constructor(appName) {
        super();
        this.appName = appName || null;
        this.controlsMap = {};
        this._dataMap = {};
        this._datasetId = null;
        this.showLoading = false;
    }

    async renderLayout(contentArea = null, layout = null) {
        if (!contentArea) contentArea = this.getContentArea();
        const items = layout || this.layout || [];
        for (const item of items) {
            await this.renderItem(item, contentArea);
        }
    }

    async renderItem(item, contentArea = null) {
        contentArea = contentArea || this.getContentArea();
        let element = null;
        const properties = item.properties || {};
        const caption = (properties && properties.noCaption) ? '' : (item.caption || '');

        // Helper to create textbox-like controls (single and multiline)
        const createTextControl = (ControlCtor) => {
            const ctrl = new ControlCtor(contentArea, properties);
            let val = '';
            if (item.value !== null && item.value !== undefined) val = item.value;
            else if (item.data && this._dataMap && Object.prototype.hasOwnProperty.call(this._dataMap, item.data)) {
                const rec = this._dataMap[item.data];
                val = (rec && (rec.value !== undefined)) ? rec.value : (rec && rec !== undefined ? rec : '');
            }
            try { if (item.properties && item.properties.__display !== undefined) { val = item.properties.__display; } } catch (e) {}
            try { if (typeof ctrl.setText === 'function') ctrl.setText(String(val)); } catch (e) {}
            try { if (typeof item.rows === 'number' && typeof ctrl.setRows === 'function') ctrl.setRows(item.rows); else if (properties && properties.rows && typeof ctrl.setRows === 'function') ctrl.setRows(properties.rows); } catch (e) {}
            try { if (typeof ctrl.setCaption === 'function') ctrl.setCaption(caption); } catch (e) {}
            ctrl.Draw(contentArea);
            try { if (item.data && ctrl.element) { ctrl.element.dataset.field = item.data; } } catch (e) {}
            try { if (ctrl.element) ctrl.element.style.width = '100%'; } catch (e) {}
            if (item.name) this.controlsMap[item.name] = ctrl;
            return ctrl;
        };

        switch (item.type) {
            case 'number': {
                properties.digitsOnly = true;
            }
            case 'textbox': {
                createTextControl(TextBox);
                break;
            }
            case 'emunList': {
                const dataKey = item.data;
                let val = '';
                if (item.value !== null && item.value !== undefined) val = item.value;
                else if (dataKey && this._dataMap && Object.prototype.hasOwnProperty.call(this._dataMap, dataKey)) {
                    const rec = this._dataMap[dataKey];
                    val = (rec && (rec.value !== undefined)) ? rec.value : (rec && rec !== undefined ? rec : '');
                }
                try { if (item.properties && item.properties.__display !== undefined) val = item.properties.__display; } catch (e) {}

                let listItems = [];
                try {
                    if (dataKey && this._dataMap && this._dataMap[dataKey] && Array.isArray(this._dataMap[dataKey].options)) {
                        listItems = this._dataMap[dataKey].options;
                    } else if (Array.isArray(item.options)) {
                        listItems = item.options;
                    } else if (properties.listItems && Array.isArray(properties.listItems)) {
                        listItems = properties.listItems;
                    }
                } catch (e) { listItems = []; }

                const propClone = Object.assign({}, properties, { listMode: true, listItems: listItems, readOnly: true });
                const ctrl = new TextBox(contentArea, propClone);
                try { if (typeof ctrl.setText === 'function') ctrl.setText(String(val)); } catch (e) {}
                try { if (typeof ctrl.setCaption === 'function') ctrl.setCaption(caption); } catch (e) {}
                ctrl.Draw(contentArea);

                try {
                    if (item.data) {
                        const fieldKey = item.data;
                        const handler = (ev) => {
                            try {
                                const newVal = (typeof ctrl.getText === 'function') ? ctrl.getText() : (ctrl.element ? ctrl.element.value : undefined);
                                if (!this._dataMap) this._dataMap = {};
                                if (!this._dataMap[fieldKey]) this._dataMap[fieldKey] = { name: fieldKey, value: newVal };
                                else this._dataMap[fieldKey].value = newVal;
                            } catch (_) {}
                        };
                        try { if (ctrl.element && ctrl.element.addEventListener) ctrl.element.addEventListener('input', handler); } catch (_) {}
                    }
                } catch (_) {}
                try { if (item.data && ctrl.element) ctrl.element.dataset.field = item.data; } catch (e) {}
                if (item.name) this.controlsMap[item.name] = ctrl;
                break;
            }
            case 'textarea': {
                createTextControl(MultilineTextBox);
                break;
            }
            case 'recordSelector': {
                const dataKey = item.data;
                let val = '';
                if (item.value !== null && item.value !== undefined) val = item.value;
                else if (dataKey && this._dataMap && Object.prototype.hasOwnProperty.call(this._dataMap, dataKey)) {
                    const rec = this._dataMap[dataKey];
                    if (rec && typeof rec.value === 'object' && rec.value !== null) {
                        const disp = (rec.value && rec.value.name) || (rec.value && rec.value.id) || '';
                        val = disp;
                    } else {
                        val = (rec && (rec.value !== undefined)) ? rec.value : (rec && rec !== undefined ? rec : '');
                    }
                }
                try { if (item.properties && item.properties.__display !== undefined) val = item.properties.__display; } catch (e) {}

                const propClone = Object.assign({}, properties || {}, { readOnly: false });
                let ctrl = new TextBox(contentArea, propClone);
                try { if (typeof ctrl.setText === 'function') ctrl.setText(String(val)); } catch (e) {}
                try { if (typeof ctrl.setCaption === 'function') ctrl.setCaption(caption); } catch (e) {}
                ctrl.Draw(contentArea);

                const propClone2 = Object.assign({}, propClone);
                if (properties && properties.selection) propClone2.selection = properties.selection;
                propClone2.showSelectionButton = true;
                try { if (typeof ctrl.destroy === 'function') ctrl.destroy(); } catch (_) {}
                const ctrlSel = new TextBox(contentArea, propClone2);
                try { if (typeof ctrlSel.setText === 'function') ctrlSel.setText(String(val)); } catch (e) {}
                try { if (typeof ctrlSel.setCaption === 'function') ctrlSel.setCaption(caption); } catch (e) {}
                try { ctrlSel.Draw(contentArea); } catch (e) { ctrl.Draw(contentArea); }
                ctrl = ctrlSel;

                try {
                    if (item.data) {
                        const fieldKey = item.data;
                        const handler = (ev) => {
                            try {
                                const newVal = (typeof ctrl.getText === 'function') ? ctrl.getText() : (ctrl.element ? ctrl.element.value : undefined);
                                if (!this._dataMap) this._dataMap = {};
                                if (!this._dataMap[fieldKey]) this._dataMap[fieldKey] = { name: fieldKey, value: newVal };
                                else this._dataMap[fieldKey].value = newVal;
                            } catch (_) {}
                        };
                        try { if (ctrl.element && ctrl.element.addEventListener) ctrl.element.addEventListener('input', handler); } catch (_) {}
                    }
                } catch (_) {}

                try { if (item.data && ctrl.element) ctrl.element.dataset.field = item.data; } catch (e) {}
                if (item.name) this.controlsMap[item.name] = ctrl;
                break;
            }
            case 'checkbox': {
                const cb = new CheckBox(contentArea, properties);
                let checked = !!item.value;
                if ((item.value === null || item.value === undefined) && item.data && this._dataMap && Object.prototype.hasOwnProperty.call(this._dataMap, item.data)) {
                    const rec = this._dataMap[item.data];
                    checked = !!(rec && (rec.value !== undefined) ? rec.value : rec);
                }
                cb.setChecked(checked);
                cb.setHeight(22);
                cb.setCaption(caption);
                cb.Draw(contentArea);
                try { if (item.data && cb.element) cb.element.dataset.field = item.data; } catch (e) {}
                if (item.name) this.controlsMap[item.name] = cb;
                break;
            }
            case 'group': {
                const grp = new Group(contentArea, properties);
                grp.setCaption(caption);
                if (item.orientation) grp.orientation = item.orientation;
                grp.Draw(contentArea);
                if (grp.element && item.layout && Array.isArray(item.layout)) {
                    await this.renderLayout(grp.element, item.layout);
                }
                break;
            }
            case 'button': {
                let btn = null;
                try {
                    if (typeof Button === 'function') {
                        try { btn = new Button(contentArea, properties); } catch (e) { btn = new Button(); }
                    }
                } catch (e) { btn = null; }

                if (!btn) {
                    console.warn('Button control is not available');
                    break;
                }

                try { if (typeof btn.setCaption === 'function') btn.setCaption(caption); } catch (e) {}
                try { if (properties && properties.width && typeof btn.setWidth === 'function') btn.setWidth(properties.width); } catch (e) {}
                try { if (properties && properties.height && typeof btn.setHeight === 'function') btn.setHeight(properties.height); } catch (e) {}

                try { if (typeof btn.Draw === 'function') btn.Draw(contentArea); else if (btn.element && contentArea.appendChild) contentArea.appendChild(btn.element); } catch (e) {}

                try {
                    const action = item.action;
                    const params = item.params || {};
                    btn.onClick = (ev) => {
                        try { if (action && this && typeof this.doAction === 'function') this.doAction(action, params); } catch (e) {}
                    };
                } catch (e) {}

                try { if (item.name) this.controlsMap[item.name] = btn; } catch (e) {}
                break;
            }
            case 'table': {
                try {
                    const tblProps = Object.assign({}, properties || {}, { columns: item.columns || [], dataKey: item.data, appForm: this });
                    const wantsDynamic = !!(properties && (properties.dynamicTable || properties.appName || properties.tableName));
                    if (wantsDynamic && typeof DynamicTable === 'function') {
                        const dtConf = Object.assign({}, tblProps);
                        if (properties && properties.appName) dtConf.appName = properties.appName;
                        if (properties && properties.tableName) dtConf.tableName = properties.tableName;
                        dtConf.rowHeight = dtConf.rowHeight || 25;
                        dtConf.multiSelect = dtConf.multiSelect || false;
                        dtConf.editable = (dtConf.editable === undefined) ? true : dtConf.editable;
                        dtConf.showToolbar = (dtConf.showToolbar === undefined) ? true : dtConf.showToolbar;
                        const tbl = new DynamicTable(dtConf);
                        try { if (typeof tbl.setCaption === 'function') tbl.setCaption(caption); } catch (e) {}
                        try { if (typeof tbl.Draw === 'function') tbl.Draw(contentArea); } catch (e) {}
                        if (item.name) this.controlsMap[item.name] = tbl;
                    } else {
                        const tbl = new Table(contentArea, tblProps);
                        try { if (typeof tbl.setCaption === 'function') tbl.setCaption(caption); } catch (e) {}
                        try { if (typeof tbl.Draw === 'function') tbl.Draw(contentArea); } catch (e) {}
                        if (item.name) this.controlsMap[item.name] = tbl;
                    }
                } catch (e) {
                    console.error('Error creating table control', e);
                }
                break;
            }
            case 'tabs': {
                try {
                    let tabsCtrl = null;
                    try { tabsCtrl = new Tabs(contentArea, { tabs: item.tabs || [], appForm: this }); } catch (e) {
                        const TabsClass = (window.UI_Classes && window.UI_Classes.Tabs) ? window.UI_Classes.Tabs : null;
                        if (!TabsClass) throw new Error('Tabs control is not available');
                        tabsCtrl = new TabsClass(contentArea, { tabs: item.tabs || [], appForm: this });
                    }
                    try { if (typeof tabsCtrl.setCaption === 'function') tabsCtrl.setCaption(caption); } catch (e) {}
                    try { if (typeof tabsCtrl.Draw === 'function') tabsCtrl.Draw(contentArea); } catch (e) {}
                    if (item.name) this.controlsMap[item.name] = tabsCtrl;
                } catch (e) {
                    console.error('Error creating tabs control', e);
                }
                break;
            }
            default:
                console.warn('Unknown layout item type:', item.type);
        }
    }

    async loadData() {
        try {
            const d = await callServerMethod(this.appName, 'getData', {});
            this._dataMap = {};
            if (d && Array.isArray(d)) {
                for (const rec of d) {
                    if (rec && rec.name) this._dataMap[rec.name] = rec;
                }
            }
        } catch (e) {
            this._dataMap = {};
        }
    }

    async getLayoutWithData() {
        try {
            const both = await callServerMethod(this.appName, 'getLayoutWithData', {});
            return both;
        } catch (err) {
            throw err;
        }
    }

    async loadLayout() {
        try {
            const both = await this.getLayoutWithData();
            if (both && (Array.isArray(both.layout) || Array.isArray(both.data))) {
                this.layout = Array.isArray(both.layout) ? both.layout : (both.layout && Array.isArray(both.layout.layout) ? both.layout.layout : []);
                try { this._datasetId = both.datasetId || null; } catch (e) { this._datasetId = null; }
                this._dataMap = {};
                if (both.data && Array.isArray(both.data)) {
                    for (const rec of both.data) {
                        if (rec && rec.name) this._dataMap[rec.name] = rec;
                    }
                }
                this.showLoading = false;
                return;
            }
        } catch (err) {
            // Combined RPC not available — fallback below
        }

        try {
            const data = await callServerMethod(this.appName, 'getLayout', {});
            if (data && Array.isArray(data)) {
                this.layout = data;
            } else if (data && Array.isArray(data.layout)) {
                this.layout = data.layout;
            } else {
                this.layout = [];
            }
        } catch (error) {
            console.error('Ошибка загрузки макета:', error);
            if (error && error.message && error.message.indexOf('Method not found') !== -1) {
                this.layout = [];
            }
            if (typeof showAlert === 'function') showAlert('Ошибка загрузки макета: ' + (error && error.message ? error.message : String(error)));
        } finally {
            this.showLoading = false;
        }
    }

    async applyChanges(changes) {
        const payload = { datasetId: this._datasetId || null, changes: changes };
        try {
            const res = await callServerMethod(this.appName, 'applyChanges', payload);
            return res;
        } catch (e) {
            console.error('[DataForm] applyChanges error', e);
            throw e;
        }
    }

    async Draw(parent) {
        super.Draw(parent);
        const contentArea = this.getContentArea();
        try { if (contentArea) contentArea.style.display = 'flex'; } catch (e) {}
        try { if (contentArea) contentArea.style.flexDirection = 'column'; } catch (e) {}
        try { if (contentArea) contentArea.style.padding = '10px'; } catch (e) {}

        // Clear previous content and controls before re-rendering layout
        try { if (contentArea) contentArea.innerHTML = ''; } catch (e) {}
        try { for (const k in this.controlsMap) { if (Object.prototype.hasOwnProperty.call(this.controlsMap, k)) delete this.controlsMap[k]; } } catch (e) {}

        await this.loadLayout();
        await this.renderLayout();

        try {
            setTimeout(() => {
                try {
                    const selector = 'input, textarea, select, button, [tabindex]';
                    const first = contentArea && contentArea.querySelector ? contentArea.querySelector(selector) : null;
                    if (first && typeof first.focus === 'function') {
                        first.focus();
                        try { if (first.select && first.tagName && first.tagName.toLowerCase() === 'input') first.select(); } catch (e) {}
                    }
                } catch (e) {}
            }, 0);
        } catch (e) {}
    }
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
        // Optional: selection metadata for selector button (e.g. { table, idField, displayField })
        this.selection = (properties && properties.selection) ? properties.selection : (this.selection || null);
        // Optional: listSource metadata for dropdown list (e.g. { table, idField, displayField, limit })
        this.listSource = (properties && properties.listSource) ? properties.listSource : (this.listSource || null);
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
            // Allow input container and inner input to shrink below content width
            // so embedded buttons don't push into adjacent table cells.
            this.inputContainer.style.minWidth = '0';
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
            // Ensure the raw input itself can shrink inside flex container
            try { this.element.style.minWidth = '0'; } catch (e) {}

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

                        // If listMode is enabled and a listSource is provided, attempt to preload first N rows
                        try {
                            (async () => {
                                try {
                                    if (this.listMode && this.listSource && typeof callServerMethod === 'function') {
                                        const src = this.listSource || {};
                                        // Support both legacy and explicit app/table specification.
                                        // Preferred: { app: 'organizations', table: 'accommodation_types', ... }
                                        // Legacy: { table: 'organizations', ... } where `table` was also the app name.
                                        const appName = src.app || src.appName || null;
                                        const tableName = src.tableName || src.table || null;
                                        const idField = src.idField || 'id';
                                        const displayField = src.displayField || 'name';
                                        const limit = (typeof src.limit === 'number' && src.limit > 0) ? src.limit : (src.limit ? (src.limit | 0) : 10);
                                        // Determine RPC target app. If `appName` provided, use it; otherwise
                                        // fall back to using `tableName` as app (legacy behavior).
                                        const rpcApp = appName || tableName;
                                        if (rpcApp && tableName) {
                                            try {
                                                const resp = await callServerMethod(rpcApp, 'getDynamicTableData', { tableName: tableName, firstRow: 0, visibleRows: limit });
                                                const rows = resp && (resp.rows || resp.data || resp.items) ? (resp.rows || resp.data || resp.items) : [];
                                                // Map rows to listItems: { value: id, caption: displayField }
                                                this.listItems = (rows || []).slice(0, limit).map(r => {
                                                    const value = (r && (r[idField] !== undefined)) ? r[idField] : (r && r.id);
                                                    const caption = (r && (r[displayField] !== undefined)) ? r[displayField] : (r && r.name) || (value !== undefined ? String(value) : '');
                                                    return { value: value, caption: caption };
                                                });
                                            } catch (e) {
                                                // ignore fetch errors
                                                try { console.error('TextBox: failed to preload listSource', e); } catch(_){ }
                                            }
                                        }
                                    }
                                } catch (_) {}
                            })();
                        } catch (e) {}
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
        // Default selection start handler: dispatch `open-record-selector` event
        try {
            const selMeta = this.selection || {};
            const table = selMeta.table || null;

            const setSelected = (rec) => {
                try {
                    const displayField = selMeta.displayField || 'name';
                    const display = (rec && (rec[displayField] !== undefined)) ? rec[displayField] : (rec && rec.name) || (rec && rec.id) || '';
                    try { if (typeof this.setText === 'function') this.setText(String(display)); } catch (_) { try { if (this.element) this.element.value = display; } catch(_){} }
                    // signal change to consumers
                    try { if (this.element) this.element.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
                } catch (e) { console.error('TextBox.onSelectionStart.setSelected error', e); }
            };

            const evDetail = { table, selection: selMeta, callback: setSelected, control: this };
            const custom = new CustomEvent('open-record-selector', { detail: evDetail, cancelable: true });
            window.dispatchEvent(custom);
            // If nobody handled the event, fallback to a simple prompt
            if (!custom.defaultPrevented) {
                try {
                    const input = prompt('Введите текст для поиска (' + (table || 'таблица') + ')');
                    if (input !== null) setSelected({ id: input, [selMeta.displayField || 'name']: input });
                } catch (e) {}
            }
        } catch (e) {
            try {
                const input = prompt('Введите текст для поиска');
                if (input !== null) {
                    try { if (typeof this.setText === 'function') this.setText(String(input)); } catch (_) { try { if (this.element) this.element.value = input; } catch(_){} }
                    try { if (this.element) this.element.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
                }
            } catch (_) {}
        }
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

            // Make the whole input container clickable to toggle the checkbox
            try {
                this.inputContainer.style.cursor = this.readOnly ? 'default' : 'pointer';
                this.inputContainer.addEventListener('click', (e) => {
                    try {
                        if (this.readOnly) return;
                        const native = this.element.querySelector('input[type="checkbox"]');
                        if (!native) return;
                        // If clicked directly on the native checkbox, let the native event handle it
                        if (e.target === native) return;
                        // Toggle native checkbox and fire change event so listeners update state
                        native.checked = !native.checked;
                        const ev = new Event('change', { bubbles: true });
                        native.dispatchEvent(ev);
                        // Also call onClick for legacy handlers
                        try { this.onClick(e); } catch (_) {}
                    } catch (_) {}
                });
            } catch (e) {}
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

        // Also make the outer container (form context) clickable to toggle the checkbox
        try {
            const nativeCb = this.element.querySelector('input[type="checkbox"]');
            const host = this.containerElement || container;
            if (nativeCb && host && host !== this.inputContainer) {
                if (!host.dataset.checkboxListener) {
                    try { host.style.cursor = nativeCb.disabled ? host.style.cursor : (this.readOnly ? 'default' : 'pointer'); } catch (_) {}
                    host.addEventListener('click', (ev) => {
                        try {
                            if (ev.target === nativeCb || nativeCb.contains(ev.target)) return;
                            if (this.readOnly || nativeCb.disabled) return;
                            nativeCb.checked = !nativeCb.checked;
                            nativeCb.dispatchEvent(new Event('change', { bubbles: true }));
                            try { this.onClick(ev); } catch (_) {}
                        } catch (_) {}
                    });
                    host.dataset.checkboxListener = '1';
                }
            }
        } catch (e) {}

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
// Lightweight Table class: simpler than DynamicTable. Renders all rows at once
// and uses `appForm.renderItem` to create cell editors/viewers (one control per cell).
class Table extends UIObject {
    constructor(parentElement = null, properties = {}) {
        super();
        this.parentElement = parentElement;
        this.columns = properties.columns || [];
        this.dataKey = properties.dataKey || properties.data || null;
        this.appForm = properties.appForm || null;
        this.caption = properties.caption || '';
        this.readOnly = properties.readOnly || false;
        this.element = null;
        // If visibleRows === 0 => show all rows (no fixed height). If >0 => body height = visibleRows * rowHeight
        this.visibleRows = (typeof properties.visibleRows === 'number') ? (properties.visibleRows | 0) : 0;
        this.rowHeight = (typeof properties.rowHeight === 'number') ? (properties.rowHeight | 0) : (properties.rowHeight ? parseInt(properties.rowHeight,10) || 25 : 25);
        // Resize state for column resizing
        this.resizeState = { isResizing: false, columnIndex: null, startX: 0, startWidth: 0 };
        this.currentSort = []; // { field, order }
    }

    // Data helpers: encapsulate all _dataMap access for Table
    data_getRows(dataKey) {
        try {
            if (this.appForm && dataKey && this.appForm._dataMap && this.appForm._dataMap[dataKey] && Array.isArray(this.appForm._dataMap[dataKey].value)) {
                return this.appForm._dataMap[dataKey].value;
            }
        } catch (e) {}
        return [];
    }

    data_ensureCellEntry(key, value) {
        try {
            if (!this.appForm) return;
            if (!this.appForm._dataMap) this.appForm._dataMap = {};
            this.appForm._dataMap[key] = { name: key, value: value };
        } catch (e) {}
    }

    data_getValue(key, fallback) {
        try {
            if (this.appForm && this.appForm._dataMap && this.appForm._dataMap[key]) return this.appForm._dataMap[key].value;
        } catch (e) {}
        return fallback;
    }

    data_updateValue(key, newVal) {
        try {
            if (!this.appForm) return;
            if (!this.appForm._dataMap) this.appForm._dataMap = {};
            if (!this.appForm._dataMap[key]) this.appForm._dataMap[key] = { name: key, value: newVal };
            else this.appForm._dataMap[key].value = newVal;
        } catch (e) {}
    }

    data_updateParentArray(dataKey, rowIndex, colDef, newVal) {
        try {
            if (dataKey && this.appForm && this.appForm._dataMap && this.appForm._dataMap[dataKey] && Array.isArray(this.appForm._dataMap[dataKey].value)) {
                const parentArr = this.appForm._dataMap[dataKey].value;
                if (!parentArr[rowIndex]) parentArr[rowIndex] = {};
                if (colDef && colDef.data) parentArr[rowIndex][colDef.data] = newVal;
            }
        } catch (e) {}
    }

    // --- Extractable rendering helpers ---
    // Create header table and return { headerTable, hcolgroup, renderHeaderAdjust }
    buildHeader(headerContainer, getBcolgroup) {
        const headerTable = document.createElement('table');
        try {
            console.log('[Table.buildHeader] columns.length=', (this.columns && this.columns.length) || 0, 'tableName=', this.tableName || '');
            try { console.log('[Table.buildHeader] captions=', (this.columns || []).map(c => (c && (c.caption || c.data)) || '').slice(0, 50)); } catch(e) {}
        } catch (e) {}
        headerTable.style.width = '100%';
        headerTable.style.borderCollapse = 'separate';
        headerTable.style.borderSpacing = '0';
        headerTable.style.tableLayout = 'fixed';
        const hcolgroup = document.createElement('colgroup');
        for (let i = 0; i < this.columns.length; i++) {
            const col = this.columns[i] || {};
            const c = document.createElement('col');
            c.style.width = (col.width ? (col.width + 'px') : (100 + 'px'));
            hcolgroup.appendChild(c);
        }
        headerTable.appendChild(hcolgroup);
        const thead = document.createElement('thead');
        const htr = document.createElement('tr');
        for (let i = 0; i < this.columns.length; i++) {
            const col = this.columns[i] || {};
            const th = document.createElement('th');
            th.style.boxSizing = 'border-box';
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
            th.textContent = col.caption || '';

            th.addEventListener('click', (e) => {
                try { console.log('[DynamicTable] header click', col && col.data ? col.data : i, 'isResizing=', this.resizeState && this.resizeState.isResizing); } catch (e) {}
                if (this.resizeState.isResizing) return;
                const field = col.data || i;
                let existing = this.currentSort.find(s => s.field === field);
                if (!existing) {
                    this.currentSort = [{ field: field, order: 'asc' }];
                } else if (existing.order === 'asc') {
                    existing.order = 'desc';
                } else {
                    this.currentSort = [];
                }
                for (let k = 0; k < htr.children.length; k++) {
                    const thk = htr.children[k];
                    const colk = this.columns[k] || {};
                    const f = colk.data || k;
                    const si = this.currentSort.find(s => s.field === f);
                    thk.textContent = colk.caption || '';
                    if (si) thk.textContent += si.order === 'asc' ? ' ▲' : ' ▼';
                }
                try { if (typeof this._invokeRenderBodyRows === 'function') this._invokeRenderBodyRows(); } catch (e) {}
            });

            const resizeHandle = document.createElement('div');
            resizeHandle.style.position = 'absolute';
            resizeHandle.style.top = '0';
            resizeHandle.style.right = '0';
            resizeHandle.style.width = '5px';
            resizeHandle.style.height = '100%';
            resizeHandle.style.cursor = 'col-resize';
            resizeHandle.style.zIndex = '10';
            (function(index, self) {
                resizeHandle.addEventListener('mousedown', (ev) => {
                    ev.stopPropagation();
                    self.resizeState.isResizing = true;
                    self.resizeState.columnIndex = index;
                    self.resizeState.startX = ev.clientX;
                    self.resizeState.startWidth = (self.columns[index] && self.columns[index].width) ? self.columns[index].width : (self.element ? (self.element.clientWidth / self.columns.length) : 100);

                    const onMove = (me) => {
                        const dx = me.clientX - self.resizeState.startX;
                        const newW = Math.max(30, self.resizeState.startWidth + dx);
                        try { hcolgroup.children[index].style.width = newW + 'px'; } catch (e) {}
                        try {
                            const bg = getBcolgroup();
                            if (bg && bg.children && bg.children[index]) bg.children[index].style.width = newW + 'px';
                        } catch (e) {}
                        try { self.columns[index].width = newW; } catch (e) {}
                    };

                    const onUp = () => {
                        self.resizeState.isResizing = false;
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                    };

                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                });
            })(i, this);

            th.appendChild(resizeHandle);
            htr.appendChild(th);
        }
        thead.appendChild(htr);
        headerTable.appendChild(thead);
        headerContainer.appendChild(headerTable);

        return { headerTable: headerTable, hcolgroup: hcolgroup };
    }

    renderCellElement(rowIndex, c, col, row) {
        const td = document.createElement('td');
        td.style.padding = '4px 6px';
        td.style.overflow = 'hidden';
        td.style.borderRight = (c < this.columns.length - 1) ? '1px solid #c0c0c0' : '0';
        td.style.verticalAlign = 'top';

        const cellContainer = document.createElement('div');
        cellContainer.style.width = '100%';
        cellContainer.style.boxSizing = 'border-box';
        cellContainer.style.overflow = 'hidden';
        cellContainer.style.display = 'flex';
        cellContainer.style.alignItems = 'center';
        td.appendChild(cellContainer);

        const cellKey = (this.dataKey ? (this.dataKey + '__r' + rowIndex + '__' + (col.data || c)) : ('table_' + Math.random().toString(36).slice(2)));

        try {
            this.data_ensureCellEntry(cellKey, (row && Object.prototype.hasOwnProperty.call(row, col.data)) ? row[col.data] : (col.value !== undefined ? col.value : ''));
        } catch (e) {}

        const cellItem = Object.assign({}, col);
        cellItem.data = cellKey;
        cellItem.caption = '';
        cellItem.properties = Object.assign({}, col.properties || {}, { noCaption: true, showBorder: false });
        cellItem.value = this.data_getValue(cellKey, (row && row[col.data]));

        // If server returned a separate display value for this FK (e.g. __accommodationTypeId_display),
        // prefer it for non-editor rendering so the cell shows human-friendly text.
        try {
            if (row && col && col.data) {
                const dispKey = '__' + col.data + '_display';
                if (Object.prototype.hasOwnProperty.call(row, dispKey)) {
                    cellItem.properties = cellItem.properties || {};
                    cellItem.properties.__display = row[dispKey];
                }
            }
        } catch (e) {}

        // Normalize object values: preserve primitive ID/value for editing, but keep display text
        try {
            const rawVal = cellItem.value;
            if (rawVal !== null && rawVal !== undefined && typeof rawVal === 'object') {
                let display = undefined;
                if (rawVal.display !== undefined) display = rawVal.display;
                else if (rawVal.name !== undefined) display = rawVal.name;
                else if (rawVal.title !== undefined) display = rawVal.title;
                else if (rawVal.caption !== undefined) display = rawVal.caption;
                else if (rawVal.label !== undefined) display = rawVal.label;
                else if (rawVal.text !== undefined) display = rawVal.text;
                else if (typeof rawVal.toString === 'function' && rawVal.toString !== Object.prototype.toString) {
                    try { display = rawVal.toString(); } catch (e) { display = undefined; }
                }
                if (display === undefined) {
                    try { display = JSON.stringify(rawVal); } catch (e) { display = String(rawVal); }
                }

                // Prefer primitive id/value for the actual cell value so editors store ID internally
                let primitiveVal = undefined;
                if (rawVal.value !== undefined && typeof rawVal.value !== 'object') primitiveVal = rawVal.value;
                else if (rawVal.id !== undefined && (typeof rawVal.id === 'string' || typeof rawVal.id === 'number')) primitiveVal = rawVal.id;

                if (primitiveVal !== undefined) {
                    cellItem.value = primitiveVal;
                } else {
                    // No primitive id found: fallback to display so user sees something meaningful
                    cellItem.value = display;
                }

                // Store display separately so non-editor rendering can prefer human-friendly name
                cellItem.properties = cellItem.properties || {};
                try { cellItem.properties.__display = display; } catch (e) {}
            }
        } catch (e) {}

        try {
            if (cellItem.properties && cellItem.properties.showBorder === false) {
                try { cellContainer.classList.add('ui-input-no-border'); } catch (e) {}
                try { cellContainer.style.padding = '0'; } catch (e) {}
            }
        } catch (e) {}

        // Map column/field metadata to renderItem types (ensure cellItem.type is set)
        try {
            // Prefer explicit inputType provided by server-side column definition
            try {
                if (col && col.inputType) {
                    cellItem.type = col.inputType;
                    try { console.log('[DynamicTable] used inputType from column ->', col.data, '->', cellItem.type); } catch (e) {}
                }
            } catch (e) {}

            // Propagate list items if provided by server and choose list editor when appropriate
            if ((col.options && Array.isArray(col.options)) || (col.listItems && Array.isArray(col.listItems))) {
                if (!cellItem.properties) cellItem.properties = {};
                cellItem.properties.listItems = col.options || col.listItems;
                if (!cellItem.type) cellItem.type = 'emunList';
            }

            // If server did not specify a type, default to textbox (keep client simple)
            if (!cellItem.type) {
                cellItem.type = 'textbox';
                try { console.log('[DynamicTable] defaulted field -> type', col && col.data, '->', cellItem.type); } catch (e) {}
            }
        } catch (e) { try { console.error('[DynamicTable] Error mapping column type', e); } catch (ee) {} }

        try {
            if (this.appForm && typeof this.appForm.renderItem === 'function') {
                (async (cellItemLocal, containerLocal, rowIndexLocal, colDef, key) => {
                    try {
                        try { console.log('[DynamicTable] about to call renderItem with', cellItemLocal, 'field:', colDef && colDef.data); } catch (e) {}
                        await this.appForm.renderItem(cellItemLocal, containerLocal);
                    } catch (e) {}
                    try {
                        const el = containerLocal.querySelector('[data-field="' + key + '"]') || containerLocal.querySelector('input,textarea,select');
                        if (el) {
                            const handler = (ev) => {
                                try {
                                    let newVal = (el.type === 'checkbox') ? !!el.checked : el.value;
                                    this.data_updateValue(key, newVal);
                                    this.data_updateParentArray(this.dataKey, rowIndexLocal, colDef, newVal);
                                } catch (e) {}
                            };
                            el.addEventListener('input', handler);
                            el.addEventListener('change', handler);
                        }
                        try {
                            const nativeCb = containerLocal.querySelector('input[type="checkbox"]');
                            if (nativeCb) {
                                if (!containerLocal.dataset.checkboxListener) {
                                    containerLocal.style.cursor = nativeCb.disabled ? 'default' : 'pointer';
                                    containerLocal.addEventListener('click', (ev) => {
                                        try {
                                            if (ev.target === nativeCb) return;
                                            if (nativeCb.disabled) return;
                                            nativeCb.checked = !nativeCb.checked;
                                            nativeCb.dispatchEvent(new Event('change', { bubbles: true }));
                                        } catch (_) {}
                                    });
                                    containerLocal.dataset.checkboxListener = '1';
                                }
                                if (!containerLocal.dataset.checkboxCapture) {
                                    containerLocal.addEventListener('click', (ev) => {
                                        try {
                                            if (ev.__checkboxHandled) return;
                                            if (ev.target === nativeCb || nativeCb.contains(ev.target)) return;
                                            if (nativeCb.disabled) return;
                                            nativeCb.checked = !nativeCb.checked;
                                            nativeCb.dispatchEvent(new Event('change', { bubbles: true }));
                                            ev.__checkboxHandled = true;
                                        } catch (_) {}
                                    }, true);
                                    containerLocal.dataset.checkboxCapture = '1';
                                }
                            }
                        } catch (e) {}
                    } catch (e) {}
                })(cellItem, cellContainer, rowIndex, col, cellKey);
            } else {
                const span = document.createElement('span');
                const displayText = (cellItem.properties && cellItem.properties.__display !== undefined) ? cellItem.properties.__display : (cellItem.value !== undefined && cellItem.value !== null ? String(cellItem.value) : '');
                span.textContent = displayText;
                cellContainer.appendChild(span);
            }
        } catch (e) {}

        return td;
    }

    renderRowElement(rowIndex, row) {
        const tr = document.createElement('tr');
        tr.style.backgroundColor = (rowIndex % 2 === 0) ? '#ffffff' : '#f0f0f0';
        for (let c = 0; c < this.columns.length; c++) {
            const col = this.columns[c] || {};
            const td = this.renderCellElement(rowIndex, c, col, row);
            tr.appendChild(td);
        }
        return tr;
    }

    buildBody(bodyContainer, rows) {
        const bodyTable = document.createElement('table');
        bodyTable.style.width = '100%';
        bodyTable.style.borderCollapse = 'collapse';
        bodyTable.style.tableLayout = 'fixed';
        const bcolgroup = document.createElement('colgroup');
        for (let i = 0; i < this.columns.length; i++) {
            const col = this.columns[i] || {};
            const c = document.createElement('col');
            c.style.width = (col.width ? (col.width + 'px') : (100 + 'px'));
            bcolgroup.appendChild(c);
        }
        bodyTable.appendChild(bcolgroup);
        const tbody = document.createElement('tbody');

        const renderBodyRows = () => {
            tbody.innerHTML = '';
            let workingRows = Array.isArray(rows) ? rows.slice(0) : [];
            if (this.currentSort && this.currentSort.length > 0) {
                const s = this.currentSort[0];
                const colIndex = this.columns.findIndex(cc => (cc.data || cc) == s.field);
                if (colIndex >= 0) {
                    const colDef = this.columns[colIndex];
                    workingRows.sort((a, b) => {
                        const va = a && Object.prototype.hasOwnProperty.call(a, colDef.data) ? a[colDef.data] : '';
                        const vb = b && Object.prototype.hasOwnProperty.call(b, colDef.data) ? b[colDef.data] : '';
                        if (va == vb) return 0;
                        if (s.order === 'asc') return (va > vb) ? 1 : -1;
                        return (va < vb) ? 1 : -1;
                    });
                }
            }

            for (let r = 0; r < workingRows.length; r++) {
                const row = workingRows[r] || {};
                const tr = this.renderRowElement(r, row);
                tbody.appendChild(tr);
            }
        };

        // Initial render
        renderBodyRows();
        // expose renderer so header/sort code can invoke it
        try { this._invokeRenderBodyRows = renderBodyRows; } catch (e) {}

        bodyTable.appendChild(tbody);
        bodyContainer.appendChild(bodyTable);

        return { bodyTable: bodyTable, bcolgroup: bcolgroup, tbody: tbody, renderBodyRows: renderBodyRows };
    }

    setCaption(c) {
        this.caption = c;
        try { if (this.element && this.element.querySelector) {
            const hdr = this.element.querySelector('.table-caption');
            if (hdr) hdr.textContent = c;
        } } catch (e) {}
    }

    Draw(container) {
        // If already built, just attach
        if (!this.element) {
            const wrapper = document.createElement('div');
            wrapper.classList.add('ui-dynamictable');
            wrapper.style.position = 'relative';
            wrapper.style.width = '100%';
            wrapper.style.height = '100%';
            wrapper.style.boxSizing = 'border-box';
            wrapper.style.display = 'flex';
            wrapper.style.flexDirection = 'column';

            // Header container (fixed) - styled like DynamicTable
            const headerContainer = document.createElement('div');
            headerContainer.style.position = 'relative';
            headerContainer.style.width = '100%';
            headerContainer.style.boxSizing = 'border-box';
            headerContainer.style.flex = '0 0 auto';
            headerContainer.style.backgroundColor = '#c0c0c0';
            // Keep 3D look using th borders, but avoid duplicating a bottom border
            // on the header container which would double the dark separator line.
            headerContainer.style.borderBottom = '0';
            headerContainer.style.userSelect = 'none';
            headerContainer.style.overflowX = 'hidden';
            wrapper.appendChild(headerContainer);

            // Body container (scrollable)
            const bodyContainer = document.createElement('div');
            bodyContainer.style.overflow = 'auto';
            bodyContainer.style.backgroundColor = '#ffffff';
            bodyContainer.style.boxSizing = 'border-box';
            // Borders for body only: left - dark, right - light, bottom - light, no top
            bodyContainer.style.borderLeft = '2px solid #808080';
            bodyContainer.style.borderRight = '2px solid #ffffff';
            bodyContainer.style.borderBottom = '2px solid #ffffff';
            // If visibleRows specified (>0) fix the height to visibleRows*rowHeight, otherwise allow flexible grow
            if (this.visibleRows && this.visibleRows > 0) {
                bodyContainer.style.flex = '0 0 auto';
                bodyContainer.style.height = (this.visibleRows * this.rowHeight) + 'px';
            } else {
                bodyContainer.style.flex = '1 1 auto';
            }
            wrapper.appendChild(bodyContainer);

            // Build header and body using extractable helpers so DynamicTable can override
            // We'll provide a getter to allow header resize handler to access the body colgroup
            let _bcolgroup_ref = null;
            const headerResult = this.buildHeader(headerContainer, () => _bcolgroup_ref);
            const headerTable = headerResult.headerTable;
            const hcolgroup = headerResult.hcolgroup;

            // Retrieve rows array via data helper
            let rows = [];
            // DATA-API CALL: getRows
            try { rows = this.data_getRows(this.dataKey); } catch (e) { rows = []; }

            const bodyResult = this.buildBody(bodyContainer, rows);
            const bodyTable = bodyResult.bodyTable;
            const bcolgroup = bodyResult.bcolgroup;
            const renderBodyRows = bodyResult.renderBodyRows;
            _bcolgroup_ref = bcolgroup;

            // Sync horizontal scroll and adjust header width for vertical scrollbar
            const adjustHeaderForScrollbar = () => {
                try {
                    const scrollBarWidth = bodyContainer.offsetWidth - bodyContainer.clientWidth;
                    if (scrollBarWidth > 0) {
                        // Reduce header by scrollbar width but add a small 4px compensation
                        headerTable.style.width = 'calc(100% - ' + scrollBarWidth + 'px + 4px)';
                    } else {
                        headerTable.style.width = '100%';
                    }
                } catch (e) {}
            };

            bodyContainer.addEventListener('scroll', () => {
                headerContainer.scrollLeft = bodyContainer.scrollLeft;
                adjustHeaderForScrollbar();
            });
            // Also adjust on window resize and once now
            try { window.addEventListener('resize', adjustHeaderForScrollbar); } catch (e) {}
            try { 
                // Call after layout to ensure scrollbar presence is measured correctly
                if (window.requestAnimationFrame) {
                    window.requestAnimationFrame(adjustHeaderForScrollbar);
                }
                setTimeout(adjustHeaderForScrollbar, 0);
            } catch (e) {}

            // Save references
            this.element = wrapper;
            this.headerContainer = headerContainer;
            this.bodyContainer = bodyContainer;
            this.tableElement = bodyTable;
        }

        if (container && this.element && !this.element.parentElement) {
            try { container.appendChild(this.element); } catch (e) {}
        }

        return this.element;
    }
}

// Tabs control: simple tabbed panels that render layouts via appForm.renderLayout
class Tabs extends UIObject {
    constructor(parentElement = null, properties = {}) {
        super();
        this.parentElement = parentElement;
        this.tabs = Array.isArray(properties.tabs) ? properties.tabs : (properties.tabItems || []);
        this.appForm = properties.appForm || properties.app || null;
        this.caption = properties.caption || '';
        this.element = null;
        this._header = null;
        this._content = null;
    }

    setCaption(c) {
        this.caption = c;
        try { if (this.element) {
            const cap = this.element.querySelector && this.element.querySelector('.tabs-caption');
            if (cap) cap.textContent = c;
        } } catch (e) {}
    }

    async _renderTab(tab) {
        try {
            if (!this._content) return;
            this._content.innerHTML = '';
            if (tab && Array.isArray(tab.layout) && this.appForm && typeof this.appForm.renderLayout === 'function') {
                await this.appForm.renderLayout(this._content, tab.layout);
            }
        } catch (e) {
            console.error('Tabs._renderTab error', e);
        }
    }

    Draw(container) {
        if (!this.element) {
            const wrapper = document.createElement('div');
            wrapper.classList.add('ui-tabs');
            wrapper.style.boxSizing = 'border-box';
            wrapper.style.width = '100%';

            const header = document.createElement('div');
            header.classList.add('ui-tabs-header');
            header.style.display = 'flex';
            header.style.gap = '6px';
            header.style.marginBottom = '8px';

            const content = document.createElement('div');
            content.classList.add('ui-tabs-content');

            wrapper.appendChild(header);
            wrapper.appendChild(content);

            this.element = wrapper;
            this._header = header;
            this._content = content;

            // create buttons
            try {
                this._header.innerHTML = '';
                this.tabs.forEach((t, idx) => {
                    const btn = document.createElement('button');
                    try { btn.type = 'button'; } catch (e) {}
                    btn.textContent = t.caption || ('Tab ' + (idx + 1));
                    btn.tabIndex = -1;
                    btn.addEventListener('click', async () => { try { await this._renderTab(t); } catch (e) {} });
                    this._header.appendChild(btn);
                });
                if (this.tabs.length > 0) this._renderTab(this.tabs[0]);
            } catch (e) {
                // ignore
            }
        }

        const target = container || this.parentElement || null;
        try { if (target && target.appendChild) target.appendChild(this.element); } catch (e) {}
    }
}

// DynamicTable class for displaying tabular data with virtual scrolling
class DynamicTable extends Table {
    constructor(options = {}) {
        super(null, { columns: options.fields || options.columns || [], rowHeight: options.rowHeight, appForm: options.appForm, dataKey: options.dataKey || options.data || options.tableName });

        this.appName = options.appName || '';
        this.tableName = options.tableName || '';
        this.bufferRows = 10;

        // Minimal state needed for server interactions
        this.totalRows = 0;
        this.fields = [];
        this.dataCache = {};
        this.currentSort = options.initialSort || [];
        this.currentFilters = options.initialFilter || [];
        this.isLoading = false;
        this.dataLoaded = false;
        this.visibleRows = 20;
        this.firstVisibleRow = 0;
        this.editSessionId = null;
        this.eventSource = null;
    }

    // Override Draw to ensure data subscription happens before base drawing
    Draw(container) {
        try {
            // Subscribe to server-side changes if not already subscribed
            if (!this._dataSubscribed) {
                try {
                    // Prefer existing connectSSE implementation
                    if (typeof this.connectSSE === 'function') this.connectSSE();
                } catch (e) {}
                this._dataSubscribed = true;
            }
        } catch (e) {}

        // Call base Draw to build UI and then trigger initial load if needed
        const el = (function(self, cnt) {
            try { return Table.prototype.Draw.call(self, cnt); } catch (e) { return null; }
        })(this, container);

        try {
            if (el && !this.dataLoaded && !this.isLoading) {
                try { this.refresh(); } catch (e) {}
            }
        } catch (e) {}

        return el;
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
            this.visibleRows = 30;
        }
    }

    showLoadingIndicator() {
        if (this.loadingOverlay) return;
        try {
            const overlay = document.createElement('div');
            overlay.style.position = 'absolute';
            overlay.style.top = '0';
            overlay.style.left = '0';
            overlay.style.right = '0';
            overlay.style.bottom = '0';
            overlay.style.background = 'rgba(192, 192, 192, 0.6)';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';
            overlay.style.zIndex = '1000';
            const label = document.createElement('div');
            label.textContent = 'Loading...';
            label.style.padding = '6px 12px';
            label.style.background = '#c0c0c0';
            overlay.appendChild(label);
            if (this.element) this.element.appendChild(overlay);
            this.loadingOverlay = overlay;
        } catch (e) {}
    }

    hideLoadingIndicator() {
        try {
            if (this.loadingOverlay) {
                this.loadingOverlay.remove();
                this.loadingOverlay = null;
            }
        } catch (e) {}
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
            // Expect new format only: { columns, rows, totalRows }
            try { console.log('[DynamicTable.loadData] server response for', this.tableName, { hasData: !!data, keys: data ? Object.keys(data) : null }); } catch(e) {}
            const columnsRaw = data && data.columns ? data.columns : [];
            const rows = data && data.rows ? data.rows : [];
            const total = data && data.totalRows ? data.totalRows : 0;

            // Normalize columns: ensure each column is {data, caption, width?}
            let columns = [];
            if (Array.isArray(columnsRaw) && columnsRaw.length > 0) {
                // Preserve full column object returned by server so client can use
                // additional metadata like `inputType`, `properties`, etc.
                columns = columnsRaw.map(col => {
                    if (typeof col === 'string') return { data: col, caption: col };
                    if (col && typeof col === 'object') {
                        const out = Object.assign({}, col);
                        out.data = out.data || out.name || '';
                        out.caption = out.caption || out.data || out.name || '';
                        return out;
                    }
                    return { data: '', caption: '' };
                });
            } else {
                // Try to infer columns from first row if server didn't provide them
                if (rows && rows.length > 0 && typeof rows[0] === 'object') {
                    columns = Object.keys(rows[0]).map(k => ({ data: k, caption: k }));
                    try { console.log('[DynamicTable.loadData] inferred columns from first row:', columns.map(c=>c.data)); } catch(e) {}
                }
            }
            try { console.log('[DynamicTable.loadData] normalized columns count=', columns.length, 'captions=', columns.map(c=>c.caption).slice(0,50)); } catch(e) {}
            const rangeFrom = (data.range && (typeof data.range.from === 'number')) ? data.range.from : (typeof firstRow === 'number' ? firstRow : 0);

            this.totalRows = total;
            this.columns = columns.slice();
            this.fields = columns.slice();
            this.editSessionId = data.editSessionId || this.editSessionId;

            // Populate dataCache using rangeFrom as base index
            rows.forEach((row, index) => {
                const globalIndex = rangeFrom + index;
                this.dataCache[globalIndex] = Object.assign({}, row, { loaded: true, __index: globalIndex });
            });

            // If table is already rendered, rebuild header and body to reflect new columns/rows
            try {
                if (this.element) {
                    const headerContainer = this.headerContainer;
                    const bodyContainer = this.bodyContainer;
                    if (headerContainer) {
                        headerContainer.innerHTML = '';
                        this.buildHeader(headerContainer, () => {
                            try { return bodyContainer.querySelector('colgroup'); } catch (e) { return null; }
                        });
                    }
                    if (bodyContainer) {
                        bodyContainer.innerHTML = '';
                        this.buildBody(bodyContainer, rows);
                    }
                }
            } catch (e) { console.error('[DynamicTable] rebuild after loadData failed', e); }

            // Mark data as loaded to avoid duplicate initial loads
            try { this.dataLoaded = true; } catch (e) {}

            return { columns: columns, rows: rows, totalRows: total };
        } finally {
            this.isLoading = false;
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
                const d = JSON.parse(event.data);
                if (d && d.type === 'dataChanged') {
                    // Consumer can call loadData or handle update when needed
                    this.dataCache = {};
                }
            } catch (e) {
                console.error('[DynamicTable] SSE parse error', e);
            }
        };

        this.eventSource.onerror = () => {
            if (this.eventSource) { this.eventSource.close(); this.eventSource = null; }
            setTimeout(() => this.connectSSE(), 3000);
        };
    }

    // ================= DATA BLOCK (extracted from old DynamicTable) =================
    // The methods below were copied from the previous DynamicTable implementation.
    // They perform server GET/POST operations. They are placed here for review
    // and will NOT be invoked automatically — wiring is left to follow-up work.

    async data_finishCellEdit_send(editSessionId, rowId, fieldName, newValue) {
        // Sends single cell edit to server (was inside finishCellEdit)
        try {
            return await callServerMethod(this.appName, 'recordTableEdit', {
                editSessionId: editSessionId,
                rowId: rowId,
                fieldName: fieldName,
                newValue: newValue
            });
        } catch (e) {
            throw e;
        }
    }

    async data_saveChanges_commit() {
        // Commits all pending edits (was saveChanges)
        if (!this.editSessionId) {
            throw new Error('No active edit session');
        }
        if (this.editedCells && this.editedCells.size === 0) {
            return { ok: false, message: 'No edits' };
        }

        try {
            const result = await callServerMethod(this.appName, 'commitTableEdits', {
                editSessionId: this.editSessionId
            });
            return result;
        } catch (e) {
            throw e;
        }
    }

    async data_saveColumnWidths_saveState() {
        // Persist client-side column widths (was saveColumnWidths)
        try {
            await callServerMethod(this.appName, 'saveClientState', {
                window: 'dynamicTable',
                component: this.tableName,
                data: {
                    columns: (this.fields || []).map(f => ({ name: f.name, width: f.width }))
                }
            });
        } catch (error) {
            console.error('[DynamicTable] Error saving column widths:', error);
            throw error;
        }
    }

    data_connectSSE_full() {
        // Full SSE handler (extracted). Does not replace existing connectSSE; kept for review.
        if (!this.appName || !this.tableName) return;

        const url = `/app/${this.appName}/subscribeToTable?tableName=${this.tableName}`;
        const es = new EventSource(url);
        es.onopen = () => {
            console.log('[DynamicTable] SSE connected (extracted)');
        };

        es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'connected') {
                    console.log('[DynamicTable] SSE: connection confirmed');
                } else if (data.type === 'dataChanged') {
                    console.log('[DynamicTable] Data changed (extracted):', data.action);
                    this.clearCache();
                    // NOTE: not calling refresh() here — wiring deferred
                }
            } catch (e) {
                console.error('[DynamicTable] SSE message parse error (extracted):', e);
            }
        };

        es.onerror = (error) => {
            console.error('[DynamicTable] SSE error (extracted), reconnecting in 3s...', error);
            try { es.close(); } catch (e) {}
            setTimeout(() => {
                // do not auto-reconnect here to avoid duplicate connections; caller may choose to reconnect
            }, 3000);
        };

        return es; // caller may store/close
    }

    // ================= END DATA BLOCK =================================================

    // DATA-API OVERRIDES: wrap Table's data helpers so DynamicTable can provide
    // its own data source (`dataCache`) while remaining compatible with Table.
    data_getRows(dataKey) {
        // If caller asks for DynamicTable's main dataKey, return array built from dataCache
        try {
            if (dataKey && dataKey === this.dataKey && this.dataCache && this.totalRows >= 0) {
                const arr = [];
                for (let i = 0; i < this.totalRows; i++) {
                    if (this.dataCache[i] && this.dataCache[i].loaded) arr.push(this.dataCache[i]);
                    else arr.push({});
                }
                return arr;
            }
        } catch (e) {}
        // Fallback to Table behaviour
        try { return super.data_getRows(dataKey); } catch (e) { return []; }
    }

    data_ensureCellEntry(key, value) {
        // For dynamic table, keep lightweight mapping in appForm._dataMap for compatibility
        try {
            if (!this.appForm) {
                // If no appForm, keep entry in local dataCache by key if possible
                return;
            }
            // Delegate to base implementation to preserve existing conventions
            return super.data_ensureCellEntry ? super.data_ensureCellEntry(key, value) : null;
        } catch (e) {}
    }

    data_getValue(key, fallback) {
        try {
            // If key corresponds to a dynamic row (format: dataKey__r{index}__), try to map to dataCache
            if (this.dataKey && typeof key === 'string' && key.indexOf(this.dataKey + '__r') === 0) {
                // attempt to extract row index and column name from key
                const m = key.match(/__r(\d+)__(.*)$/);
                if (m) {
                    const idx = parseInt(m[1], 10);
                    const colName = m[2];
                    if (!isNaN(idx) && this.dataCache && this.dataCache[idx] && this.dataCache[idx].loaded) {
                        // If column name present, return that field value when available
                        if (colName && Object.prototype.hasOwnProperty.call(this.dataCache[idx], colName)) {
                            return this.dataCache[idx][colName];
                        }
                        // Fallback to full row object
                        return this.dataCache[idx];
                    }
                }
            }
        } catch (e) {}
        try { return super.data_getValue ? super.data_getValue(key, fallback) : fallback; } catch (e) { return fallback; }
    }

    data_updateValue(key, newVal) {
        try {
            // Attempt to update dynamic cache if key maps to row
            if (this.dataKey && typeof key === 'string' && key.indexOf(this.dataKey + '__r') === 0) {
                const m = key.match(/__r(\d+)__(.*)$/);
                if (m) {
                    const idx = parseInt(m[1], 10);
                    const colName = m[2];
                    if (!isNaN(idx)) {
                        if (!this.dataCache[idx]) this.dataCache[idx] = { loaded: false, __index: idx };
                        if (colName) {
                            this.dataCache[idx][colName] = newVal;
                        } else {
                            // preserve legacy placeholder if no column name parsed
                            this.dataCache[idx].__cell = newVal;
                        }
                        return;
                    }
                }
            }
        } catch (e) {}
        try { if (super.data_updateValue) return super.data_updateValue(key, newVal); } catch (e) {}
    }

    data_updateParentArray(dataKey, rowIndex, colDef, newVal) {
        try {
            if (dataKey && dataKey === this.dataKey) {
                if (!this.dataCache[rowIndex]) this.dataCache[rowIndex] = { loaded: false, __index: rowIndex };
                if (colDef && colDef.data) this.dataCache[rowIndex][colDef.data] = newVal;
                return;
            }
        } catch (e) {}
        try { if (super.data_updateParentArray) return super.data_updateParentArray(dataKey, rowIndex, colDef, newVal); } catch (e) {}
    }
}


class App {
    constructor(name, params = {}) {
        this.name = name;
        this.params = params || {};
        this.caption = this.params.caption || name;
        this.config = this.params.config || { allowMultipleInstances: false };
    }

    // Return descriptor object suitable for MySpace.register
    getDescriptor() {
        const self = this;
        return {
            config: this.config,
            init() {
                try { console.log('[' + self.name + '] descriptor initialized'); } catch (e) {}
            },
            async createInstance(params) {
                return await self.createInstance(params || {});
            }
        };
    }

    // Helper to generate instance id
    generateInstanceId() {
        return this.name + '-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
    }

    // Create a new app instance. By default this returns a minimal instance
    // skeleton without creating any `Form`. Applications that need a form
    // should override `createInstance` or replace it on the App instance.
    async createInstance(params) {
        const instanceId = this.generateInstanceId();

        const instance = {
            id: instanceId,
            appName: this.name,
            form: null,
            // No-op onOpen by default — apps should provide behavior if needed
            onOpen: (openParams) => {
                // intentionally empty
            },
            onAction: (action, actionParams) => {
                // intentionally empty
            },
            destroy: () => {
                // intentionally empty
            }
        };

        // Auto-open hint for apps that want it
        try { if (params && (params.dbTable || params.table || params.open)) instance.onOpen(params); } catch (e) {}

        return instance;
    }

    // Convenience: register this app with MySpace
    register() {
        try {
            if (typeof window !== 'undefined' && window.MySpace && typeof window.MySpace.register === 'function') {
                window.MySpace.register(this.name, this.getDescriptor());
            }
        } catch (e) { console.error(e); }
    }
}