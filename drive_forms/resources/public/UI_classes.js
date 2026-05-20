
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
                // Apply some global CSS variables derived from client config so
                // individual elements don't need inline styles for theme colors.
                try {
                    if (typeof document !== 'undefined') {
                        const base = UIObject.getClientConfigValue('defaultColor', '#c0c0c0');
                        const light = UIObject.brightenColor(base, 60);
                        const dark = UIObject.brightenColor(base, -60);
                        try { document.documentElement.style.setProperty('--input-field-button-border-light', light); } catch (e) {}
                        try { document.documentElement.style.setProperty('--input-field-button-border-dark', dark); } catch (e) {}
                        try { document.documentElement.style.setProperty('--tb-border-light', light); } catch (e) {}
                        try { document.documentElement.style.setProperty('--tb-border-dark', dark); } catch (e) {}
                    }
                } catch (e) {}
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

        try {
            // cleanup observers/listeners attached to embedded buttons
            try {
                if (this._listBtn) {
                    try { if (this._listBtn._ro && typeof this._listBtn._ro.disconnect === 'function') this._listBtn._ro.disconnect(); } catch (e) {}
                    try { if (this._listBtn._win) window.removeEventListener('resize', this._listBtn._win); } catch (e) {}
                }
            } catch (e) {}
            try {
                if (this._selectBtn) {
                    try { if (this._selectBtn._ro && typeof this._selectBtn._ro.disconnect === 'function') this._selectBtn._ro.disconnect(); } catch (e) {}
                    try { if (this._selectBtn._win) window.removeEventListener('resize', this._selectBtn._win); } catch (e) {}
                }
            } catch (e) {}
            try {
                if (this._dateBtn) {
                    try { if (this._dateBtn._ro && typeof this._dateBtn._ro.disconnect === 'function') this._dateBtn._ro.disconnect(); } catch (e) {}
                    try { if (this._dateBtn._win) window.removeEventListener('resize', this._dateBtn._win); } catch (e) {}
                }
            } catch (e) {}
            try {
                if (this._calOpen && typeof this._closeCalendar === 'function') this._closeCalendar();
                else if (this._calPopup) { try { this._calPopup.remove(); } catch (_) {} this._calPopup = null; }
                if (this._calKeyCapture) { try { document.removeEventListener('keydown', this._calKeyCapture, true); } catch (_) {} this._calKeyCapture = null; }
            } catch (e) {}
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
        try { this._dateBtn = null; } catch (e) {}
        try { this._calPopup = null; } catch (e) {}
        try { if (this._qsDebounce) { clearTimeout(this._qsDebounce); this._qsDebounce = null; } } catch(e) {}
        try { if (this._qsKeyCapture) { document.removeEventListener('keydown', this._qsKeyCapture, true); this._qsKeyCapture = null; } } catch(e) {}
        try { if (typeof this._closeQsPopup === 'function') this._closeQsPopup(); } catch(e) {}
        try { this._qsPopup = null; this._qsOpen = false; this._quickSearchEnabled = false; } catch(e) {}
        try { if (this._addrDebounce) { clearTimeout(this._addrDebounce); this._addrDebounce = null; } } catch(e) {}
        try { if (this._addrKeyCapture) { document.removeEventListener('keydown', this._addrKeyCapture, true); this._addrKeyCapture = null; } } catch(e) {}
        try { if (typeof this._closeAddrPopup === 'function') this._closeAddrPopup(); } catch(e) {}
        try { this._addrPopup = null; this._addrOpen = false; this._addressEnabled = false; } catch(e) {}
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

    // Clean up form and child controls (invoke destroy on known children)
    destroy() {
        try {
            // If the form has a DynamicTable or other control assigned to common properties, destroy them
            try { if (this.table && typeof this.table.destroy === 'function') this.table.destroy(); } catch (e) {}
            try { if (this._child && typeof this._child.destroy === 'function') this._child.destroy(); } catch (e) {}
        } catch (e) {}

        try {
            if (UIObject && UIObject.prototype && typeof UIObject.prototype.destroy === 'function') {
                UIObject.prototype.destroy.call(this);
            }
        } catch (e) {}
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

            // NOTE: defer adding to global array until after we resolve overlaps
            // (we will push `this` into Form._allForms after inserting into DOM)

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
                try {
                    if (!this.element) return;
                    const finalColor = UIObject.getClientConfigValue('defaultColor', bgColor);
                    if (finalColor !== bgColor) {
                        this.element.style.backgroundColor = finalColor;
                        this.element.style.borderTop = `2px solid ${UIObject.brightenColor(finalColor, 60)}`;
                        this.element.style.borderLeft = `2px solid ${UIObject.brightenColor(finalColor, 60)}`;
                        this.element.style.borderRight = `2px solid ${UIObject.brightenColor(finalColor, -60)}`;
                        this.element.style.borderBottom = `2px solid ${UIObject.brightenColor(finalColor, -60)}`;
                    }
                } catch (e) {}
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
                try {
                    if (!this.element) return;
                    const base = UIObject.getClientConfigValue('defaultColor', initialBg);
                    applyTitleButtonColors(btnMinimize, base);
                    applyTitleButtonColors(btnMaximize, base);
                    applyTitleButtonColors(btnClose, base);
                } catch (e) {}
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

        // Resolve overlaps with existing forms so new windows cascade
        try {
            Form._resolveOverlap(this);
        } catch (e) {}

        // Now register this form in the global list
        Form._allForms.push(this);

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
        try { if (typeof this.destroy === 'function') this.destroy(); } catch (e) {}
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
        try {
            // Close form on ESC unless focus is inside an editable control
            if (!event) return;
            const key = event.key || event.keyCode || '';
            if (key === 'Escape' || key === 'Esc' || key === 27) {
                try {
                    const active = (typeof document !== 'undefined') ? document.activeElement : null;
                    let isEditable = false;
                    try {
                        if (active) {
                            const tag = active.tagName ? active.tagName.toLowerCase() : '';
                            if (tag === 'input' || tag === 'textarea' || tag === 'select' || active.isContentEditable) isEditable = true;
                        }
                    } catch (e) {}

                    if (!isEditable) {
                        try { this.close(); } catch (e) {}
                        try { event.preventDefault && event.preventDefault(); } catch (e) {}
                    }
                } catch (e) {}
            }
        } catch (e) {}
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

// Ensure a newly created form does not exactly overlap existing forms.
// If a conflict is detected (same x and y as any existing form), shift the
// new form right/down by the title bar height and re-check recursively.
Form._resolveOverlap = function(form) {
    if (!form) return;
    // Determine shift amount: prefer actual titleBar height when available
    let shift = 20;
    try {
        if (form.titleBar && typeof form.titleBar.offsetHeight === 'number' && form.titleBar.offsetHeight > 0) {
            shift = form.titleBar.offsetHeight;
        }
    } catch (e) {}

    // Safety limit to avoid infinite loops
    const maxIter = Math.max(200, Form._allForms.length + 20);
    let iter = 0;
    let moved = false;

    do {
        moved = false;
        for (let i = 0; i < Form._allForms.length; i++) {
            const f = Form._allForms[i];
            if (!f || f === form) continue;
            try {
                if (f.x === form.x && f.y === form.y) {
                    form.x += shift;
                    form.y += shift;
                    if (form.element) {
                        form.element.style.left = form.x + 'px';
                        form.element.style.top = form.y + 'px';
                    }
                    moved = true;
                    break; // restart checking from beginning
                }
            } catch (e) {
                // ignore and continue
            }
        }
        iter++;
    } while (moved && iter < maxIter);
};

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
// Default action forwarding: delegate form actions to attached instance, if present.
// Implemented as prototype assignment to avoid placing a bare method at top-level.
Form.prototype.doAction = function(action, params) {
    try {
        // --- СТАНДАРТНОЕ ПОВЕДЕНИЕ (если задан флаг isStandard) ---
        // Обработка стандартных действий непосредственно во фреймворке
        if (params && params.isStandard) {
            console.log('[Form] handle standard action:', action, params);
            
            if (action === 'cancel') {
                try { if (typeof this.close === 'function') return this.close(); } catch (e) {}
            }
            
            if (action === 'recordAdd') {
                try {
                    const tableName = this.dbTable || (params && params.tableName) || '';
                    if (!tableName) {
                        if (typeof showAlert === 'function') showAlert(__t('No table specified!'));
                        return;
                    }
                    if (window.MySpace && typeof window.MySpace.open === 'function') {
                        return window.MySpace.open('uniForm', { mode: 'record', tableName: tableName });
                    }
                } catch (e) { console.error('[Form] recordAdd error:', e); }
                return;
            }

            if (action === 'recordOpen') {
                try {
                    const row = (typeof this.getCurrentRow === 'function') ? this.getCurrentRow() : null;
                    if (!row || !row.UID) {
                        if (typeof showAlert === 'function') showAlert(__t('Please select a record'));
                        return;
                    }
                    const tableName = this.dbTable || (params && params.tableName) || '';
                    if (window.MySpace && typeof window.MySpace.open === 'function') {
                        return window.MySpace.open('uniForm', { mode: 'record', tableName, recordID: row.UID });
                    }
                } catch (e) { console.error('[Form] recordOpen error:', e); }
                return;
            }

            if (action === 'recordDelete') {
                try {
                    const row = (typeof this.getCurrentRow === 'function') ? this.getCurrentRow() : null;
                    if (!row || !row.UID) {
                        if (typeof showAlert === 'function') showAlert(__t('Please select a record to delete'));
                        return;
                    }
                    const tableName = this.dbTable || (params && params.tableName) || '';
                    const self = this;
                    if (typeof window.showConfirm === 'function') {
                        window.showConfirm(__t('Are you sure you want to delete this record?'), async (res) => {
                            if (res === 'yes') {
                                try {
                                    const result = await callServerMethod('uniForm', 'applyChanges', { 
                                        datasetId: { table: tableName, id: row.UID }, 
                                        changes: { _deleted: true } 
                                    });
                                    if (result && result.ok) {
                                        if (self.table && typeof self.table.refresh === 'function') self.table.refresh();
                                    } else {
                                        if (typeof showAlert === 'function') showAlert(__t('Delete error: ') + (result.error || __t('unknown error')));
                                    }
                                } catch(e) { console.error(e); }
                            }
                        });
                    }
                } catch (e) { console.error('[Form] recordDelete error:', e); }
                return;
            }

            if (action === 'listSettings') {
                try {
                    const appName = this.appName || (params && params.appName) || '';
                    const title = this.title || (params && params.title) || '';
                    console.log('[Form] Action listSettings triggered for:', appName);
                    if (window.MySpace && typeof window.MySpace.open === 'function') {
                        return window.MySpace.open('listSettings', { appName: appName, title: title });
                    } else {
                        console.error('[Form] window.MySpace.open is not available');
                    }
                } catch (e) { console.error('[Form] listSettings error:', e); }
                return true; // Возвращаем true, чтобы прервать дальнейшую обработку
            }
            
            // Если действие было помечено как стандартное, но не обработано выше, 
            // всё равно пробуем передать его в нативный onAction (как fallback)
        }

        if (this.instance && typeof this.instance.onAction === 'function') {
            const res = this.instance.onAction(action, params);
            if (res) return res;
        }
    } catch (e) {
        try { console.error('[Form] doAction forwarding error', e); } catch (_) {}
    }
    // no-op when no instance handler
};

/**
 * Вызов серверной функции из serverScriptStore.
 * Доступен глобально в клиентских скриптах (loadScript).
 *
 * @param {string} uid       - Имя серверного скрипта (loadServerScript name)
 * @param {string} fn        - Имя функции внутри скрипта
 * @param {*}      fnParams  - Параметры (любой JSON-сериализуемый тип)
 * @returns {Promise<*>}     - Результат серверной функции
 */
window.callServer = async function(uid, fn, fnParams) {
    const resp = await fetch('/server-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, fn, fnParams }),
    });
    if (!resp.ok) {
        let errMsg = resp.status;
        try { const e = await resp.json(); errMsg = e.error || errMsg; } catch (_) {}
        throw new Error(String(errMsg));
    }
    const data = await resp.json();
    return data.result;
};

class DataForm extends Form {
    constructor(appName) {
        super();
        this.appName = appName || null;
        this.controlsMap = {};
        this._dataMap = {};
        this._datasetId = null;
        this.showLoading = false;
        this.__currentRecord = null;
        this._modified = false;
        this._originalTitle = '';
        this._closing = false; // guard against recursive close
        this._clientScript = null; // UID клиентского скрипта (из saveLayout({ clientScript }))
    }

    // Override setTitle to keep track of the base (non-modified) title
    setTitle(title) {
        this._originalTitle = title || '';
        if (this._modified) {
            super.setTitle(title + ' *');
        } else {
            super.setTitle(title);
        }
    }

    // Mark form as modified/unmodified and update title with "*"
    setModified(val) {
        // Не выставляем modified=true пока идёт программное обновление полей (refresh после сохранения)
        if (val && this._suppressModified) return;
        const wasModified = this._modified;
        this._modified = !!val;
        if (this._modified && !wasModified) {
            if (!this._originalTitle) this._originalTitle = super.getTitle() || '';
            super.setTitle(this._originalTitle + ' *');
        } else if (!this._modified && wasModified) {
            if (this._originalTitle) super.setTitle(this._originalTitle);
        }
    }

    // Override close to prompt save if modified
    close() {
        if (this._closing) { super.close(); return; }
        if (!this._modified) { this._closing = true; super.close(); return; }
        // Show confirmation dialog
        const self = this;
        if (typeof showConfirm === 'function') {
            showConfirm(__t('Data has been modified. Save changes?'), async () => {
                // "Да" — save then close
                try { await self.doAction('save'); } catch(e) { console.error(e); }
                self._closing = true;
                self._modified = false;
                super.close.call(self);
            }, () => {
                // "Нет" — close without saving
                self._closing = true;
                self._modified = false;
                super.close.call(self);
            });
        } else {
            this._closing = true;
            super.close();
        }
    }

    set _currentRecord(val) {
        this.__currentRecord = val;
        // When current record changes, update all controls that are bound to data fields
        if (val && typeof val === 'object') {
            for (const key in this.controlsMap) {
                const ctrl = this.controlsMap[key];
                if (!ctrl) continue;
                
                // Find which field this control is bound to (if any)
                // We stored it in dataset.field in renderItem
                const fieldName = (ctrl.element && ctrl.element.dataset) ? ctrl.element.dataset.field : null;
                if (fieldName && Object.prototype.hasOwnProperty.call(val, fieldName)) {
                    let fieldVal = val[fieldName];
                    let displayVal = undefined;
                    
                    // Check for display value variants (like __fieldname_display)
                    const dispKey = '__' + fieldName + '_display';
                    if (Object.prototype.hasOwnProperty.call(val, dispKey)) {
                        displayVal = val[dispKey];
                    } else if (fieldVal && typeof fieldVal === 'object' && fieldVal !== null) {
                        displayVal = fieldVal.display || fieldVal.name || fieldVal.UID;
                        fieldVal = fieldVal.value !== undefined ? fieldVal.value : fieldVal.UID;
                    }
                    
                    if (typeof ctrl.setValue === 'function') {
                        ctrl.setValue(fieldVal, displayVal);
                    } else if (typeof ctrl.setText === 'function') {
                        ctrl.setText(displayVal !== undefined ? displayVal : fieldVal);
                    }
                }
            }
        }
    }

    get _currentRecord() {
        return this.__currentRecord;
    }

    async renderLayout(contentArea = null, layout = null) {
        if (!contentArea) contentArea = this.getContentArea();
        const items = layout || this.layout || [];
        const isRoot = layout == null;
        for (const item of items) {
            await this.renderItem(item, contentArea);
        }
        // После отрисовки корневого лейаута — активировать первую строку во всех таблицах.
        // Порядок: мастер-таблицы (с masterFor) первыми, чтобы их фильтры установились
        // до того как активируются деталь-таблицы.
        if (isRoot) {
            setTimeout(() => { try { this._activateFirstRows(); } catch(e) {} }, 0);
        }
    }

    async renderItem(item, contentArea = null) {
        contentArea = contentArea || this.getContentArea();
        let element = null;
        const properties = item.properties || {};
        // Резолвим caption: если пришёл объект { i18n: 'key' } — переводим через __t
        const rawCaption = (properties && properties.noCaption) ? '' : (item.caption || '');
        const caption = (rawCaption && typeof rawCaption === 'object' && rawCaption.i18n)
            ? (typeof __t === 'function' ? __t(rawCaption.i18n) : (rawCaption.i18n || ''))
            : rawCaption;

        // Helper to create textbox-like controls (single and multiline)
        const createTextControl = (ControlCtor) => {
            const ctrl = new ControlCtor(contentArea, properties);
            let val = '';
            let display = undefined;
            if (item.value !== null && item.value !== undefined) val = item.value;
            else if (item.data && this._dataMap && Object.prototype.hasOwnProperty.call(this._dataMap, item.data)) {
                const rec = this._dataMap[item.data];
                if (rec && rec.selection && rec.selection.display !== undefined) {
                    val = (rec.selection.UID !== undefined) ? rec.selection.UID : (rec.value !== undefined ? rec.value : rec);
                    display = rec.selection.display;
                } else if (rec && rec.__display !== undefined) {
                    val = (rec.value !== undefined ? rec.value : rec);
                    display = rec.__display;
                } else if (rec && typeof rec.value === 'object' && rec.value !== null) {
                    display = rec.value.display || rec.value.name || rec.value.UID || '';
                    val = (rec.value.value !== undefined) ? rec.value.value : (rec.value.UID !== undefined ? rec.value.UID : rec.value);
                } else {
                    val = (rec && (rec.value !== undefined)) ? rec.value : (rec && rec !== undefined ? rec : '');
                }
            }
            try { if (item.properties && item.properties.__display !== undefined) { display = item.properties.__display; } } catch (e) {}
            
            try { 
                if (typeof ctrl.setValue === 'function') ctrl.setValue(val, display);
                else if (typeof ctrl.setText === 'function') ctrl.setText(String(display || val)); 
            } catch (e) {}
            
            try { if (typeof item.rows === 'number' && typeof ctrl.setRows === 'function') ctrl.setRows(item.rows); else if (properties && properties.rows && typeof ctrl.setRows === 'function') ctrl.setRows(properties.rows); } catch (e) {}
            try { if (typeof ctrl.setCaption === 'function') ctrl.setCaption(caption); } catch (e) {}
            ctrl.Draw(contentArea);
            try { if (item.data && ctrl.element) { ctrl.element.dataset.field = item.data; } } catch (e) {}
            try { if (ctrl.element) ctrl.element.style.width = '100%'; } catch (e) {}
            // Keep _dataMap in sync when user types
            try {
                if (item.data && ctrl.element && ctrl.element.addEventListener) {
                    const fieldKey = item.data;
                    const self = this;
                    ctrl.element.addEventListener('input', () => {
                        try {
                            const newVal = (typeof ctrl.getValue === 'function') ? ctrl.getValue() : (ctrl.element ? ctrl.element.value : undefined);
                            if (!self._dataMap) self._dataMap = {};
                            if (!self._dataMap[fieldKey]) self._dataMap[fieldKey] = { name: fieldKey, value: newVal };
                            else self._dataMap[fieldKey].value = newVal;
                        } catch (_) {}
                        // Mark form as modified
                        try { if (typeof self.setModified === 'function') self.setModified(true); } catch (_) {}
                    });
                }
            } catch (_) {}
            const ctrlKey = item.name || item.data;
            if (ctrlKey) this.controlsMap[ctrlKey] = ctrl;
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
            case 'address': {
                properties.addressMode = true;
                createTextControl(TextBox);
                break;
            }
            case 'date': {
                // Date input: TextBox with isDate=true
                properties.isDate = true;
                createTextControl(TextBox);
                break;
            }
            case 'emunList': {
                const dataKey = item.data;
                let val = '';
                let display = undefined;
                if (item.value !== null && item.value !== undefined) val = item.value;
                else if (dataKey && this._dataMap && Object.prototype.hasOwnProperty.call(this._dataMap, dataKey)) {
                    const rec = this._dataMap[dataKey];
                    if (rec && rec.selection && rec.selection.display !== undefined) {
                        val = (rec.selection.UID !== undefined) ? rec.selection.UID : (rec.value !== undefined ? rec.value : rec);
                        display = rec.selection.display;
                    } else if (rec && rec.__display !== undefined) {
                        val = (rec.value !== undefined ? rec.value : rec);
                        display = rec.__display;
                    } else if (rec && typeof rec.value === 'object' && rec.value !== null) {
                        display = rec.value.display || rec.value.name || rec.value.UID || '';
                        val = (rec.value.value !== undefined) ? rec.value.value : (rec.value.UID !== undefined ? rec.value.UID : rec.value);
                    } else {
                        val = (rec && (rec.value !== undefined)) ? rec.value : (rec && rec !== undefined ? rec : '');
                    }
                }
                try { if (item.properties && item.properties.__display !== undefined) display = item.properties.__display; } catch (e) {}

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
                try { 
                    if (typeof ctrl.setValue === 'function') ctrl.setValue(val, display);
                    else if (typeof ctrl.setText === 'function') ctrl.setText(String(display || val)); 
                } catch (e) {}
                try { if (typeof ctrl.setCaption === 'function') ctrl.setCaption(caption); } catch (e) {}
                ctrl.Draw(contentArea);

                try {
                    if (item.data) {
                        const fieldKey = item.data;
                        const formSelf = this;
                        const handler = (ev) => {
                            try {
                                const newVal = (typeof ctrl.getText === 'function') ? ctrl.getText() : (ctrl.element ? ctrl.element.value : undefined);
                                if (!formSelf._dataMap) formSelf._dataMap = {};
                                if (!formSelf._dataMap[fieldKey]) formSelf._dataMap[fieldKey] = { name: fieldKey, value: newVal };
                                else formSelf._dataMap[fieldKey].value = newVal;
                            } catch (_) {}
                            try { if (typeof formSelf.setModified === 'function') formSelf.setModified(true); } catch (_) {}
                        };
                        try { if (ctrl.element && ctrl.element.addEventListener) ctrl.element.addEventListener('input', handler); } catch (_) {}
                    }
                } catch (_) {}
                try { if (item.data && ctrl.element) ctrl.element.dataset.field = item.data; } catch (e) {}
                { const ctrlKey = item.name || item.data; if (ctrlKey) this.controlsMap[ctrlKey] = ctrl; }
                break;
            }
            case 'textarea': {
                createTextControl(MultilineTextBox);
                break;
            }
            case 'recordSelector': {
                const dataKey = item.data;
                let val = '';
                let display = undefined;
                if (item.value !== null && item.value !== undefined) val = item.value;
                else if (dataKey && this._dataMap && Object.prototype.hasOwnProperty.call(this._dataMap, dataKey)) {
                    const rec = this._dataMap[dataKey];
                    if (rec && rec.selection && rec.selection.display !== undefined) {
                        val = (rec.selection.UID !== undefined) ? rec.selection.UID : (rec.value !== undefined ? rec.value : rec);
                        display = rec.selection.display;
                    } else if (rec && rec.__display !== undefined) {
                        val = (rec.value !== undefined ? rec.value : rec);
                        display = rec.__display;
                    } else if (rec && typeof rec.value === 'object' && rec.value !== null) {
                        display = (rec.value && rec.value.display) || (rec.value && rec.value.name) || (rec.value && rec.value.UID) || '';
                        val = (rec.value && rec.value.value !== undefined) ? rec.value.value : (rec.value && rec.value.UID !== undefined ? rec.value.UID : rec.value);
                    } else {
                        val = (rec && (rec.value !== undefined)) ? rec.value : (rec && rec !== undefined ? rec : '');
                    }
                }
                try { if (item.properties && item.properties.__display !== undefined) display = item.properties.__display; } catch (e) {}

                const propClone = Object.assign({}, properties || {});
                const propClone2 = Object.assign({}, propClone);
                if (properties && properties.selection) propClone2.selection = properties.selection;
                propClone2.showSelectionButton = !properties.readOnly;
                if (properties && properties.readOnly) propClone2.listMode = false;
                if (properties && properties.noQuickSearch) propClone2.quickSearch = false;
                
                const ctrlSel = new TextBox(contentArea, propClone2);
                try { 
                    if (typeof ctrlSel.setValue === 'function') ctrlSel.setValue(val, display);
                    else if (typeof ctrlSel.setText === 'function') ctrlSel.setText(String(display || val)); 
                } catch (e) {}
                try { if (typeof ctrlSel.setCaption === 'function') ctrlSel.setCaption(caption); } catch (e) {}
                try { ctrlSel.Draw(contentArea); } catch (e) {}
                const ctrl = ctrlSel;

                try {
                    if (item.data) {
                        const fieldKey = item.data;
                        const formSelf = this;
                        const handler = (ev) => {
                            try {
                                const newVal = (typeof ctrl.getValue === 'function') ? ctrl.getValue() : (typeof ctrl.getText === 'function' ? ctrl.getText() : (ctrl.element ? ctrl.element.value : undefined));
                                if (!formSelf._dataMap) formSelf._dataMap = {};
                                if (!formSelf._dataMap[fieldKey]) formSelf._dataMap[fieldKey] = { name: fieldKey, value: newVal };
                                else formSelf._dataMap[fieldKey].value = newVal;
                            } catch (_) {}
                            try { if (typeof formSelf.setModified === 'function') formSelf.setModified(true); } catch (_) {}
                        };
                        try { if (ctrl.element && ctrl.element.addEventListener) ctrl.element.addEventListener('input', handler); } catch (_) {}
                    }
                } catch (_) {}

                try { if (item.data && ctrl.element) ctrl.element.dataset.field = item.data; } catch (e) {}
                { const ctrlKey = item.name || item.data; if (ctrlKey) this.controlsMap[ctrlKey] = ctrl; }
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
                // Track checkbox changes for dirty flag
                try {
                    if (item.data && cb.element) {
                        const formSelf = this;
                        cb.element.addEventListener('change', () => {
                            try { if (typeof formSelf.setModified === 'function') formSelf.setModified(true); } catch (_) {}
                        });
                    }
                } catch (_) {}
                { const ctrlKey = item.name || item.data; if (ctrlKey) this.controlsMap[ctrlKey] = cb; }
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
                    const btnProps = Object.assign({}, properties || {}, { 
                        action: item.action, 
                        params: item.params || {},
                        isStandard: (item.isStandard !== undefined) ? item.isStandard : true, // По умолчанию считаем кнопки стандартными
                        icon: item.icon || properties.icon || null,
                        showIcon: !!(item.icon || properties.icon)
                    });
                    if (typeof Button === 'function') {
                        btn = new Button(contentArea, btnProps);
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
                    if (action) {
                        btn.onClick = (ev) => {
                            try { if (this && typeof this.doAction === 'function') this.doAction(action, params); } catch (e) {}
                        };
                    }
                    // Если action нет — onClick будет назначен через _wireItemEvents (events.onClick)
                } catch (e) {}

                try { if (item.name) this.controlsMap[item.name] = btn; } catch (e) {}
                break;
            }
            case 'commandBar': {
                // Стандартная панель команд формы: OK / Save / Cancel + custom extra buttons.
                // Конфигурация:
                //   hiddenButtons: ['ok', 'save', 'cancel']  — скрыть стандартные кнопки
                //   extraButtons: [{ name, caption, icon, events, ... }] — добавить свои
                const cmdBarEl = document.createElement('div');
                cmdBarEl.classList.add('ui-toolbar');
                // Компенсируем padding contentArea (10px): тянем фон к краям формы,
                // но внутренний отступ для кнопок = 10px, чтобы совпасть с контентом ниже
                cmdBarEl.style.marginTop    = '-10px';
                cmdBarEl.style.marginLeft   = '-10px';
                cmdBarEl.style.marginRight  = '-10px';
                cmdBarEl.style.marginBottom = '5px';
                cmdBarEl.style.paddingLeft  = '10px';
                cmdBarEl.style.paddingRight = '10px';
                contentArea.appendChild(cmdBarEl);

                const hiddenCmdBtns = Array.isArray(item.hiddenButtons) ? item.hiddenButtons : [];

                const stdCmdButtons = [
                    { id: 'ok',     caption: __t('OK'),     icon: '/apps/general_icons/resources/public/16x16/select.png',  action: 'ok' },
                    { id: 'save',   caption: __t('Save'),   icon: '/apps/general_icons/resources/public/16x16/save.png',    action: 'save' },
                    { id: 'cancel', caption: __t('Cancel'), icon: '/apps/general_icons/resources/public/16x16/cancel.png',  action: 'cancel' }
                ];

                const formSelfCmd = this;
                for (const btnDef of stdCmdButtons) {
                    if (hiddenCmdBtns.includes(btnDef.id)) continue;
                    const btn = new Button(cmdBarEl, { caption: btnDef.caption, tooltip: btnDef.caption, icon: btnDef.icon, showIcon: true, showText: true });
                    btn.Draw(cmdBarEl);
                    const action = btnDef.action;
                    btn.onClick = () => { try { formSelfCmd.doAction(action); } catch(e) {} };
                }

                // Дополнительные (приложение-специфичные) кнопки
                const extraButtons = Array.isArray(item.extraButtons) ? item.extraButtons : [];
                for (const exBtn of extraButtons) {
                    const exCaption = (typeof exBtn.caption === 'string') ? exBtn.caption : (exBtn.caption || '');
                    const btn = new Button(cmdBarEl, {
                        caption: exCaption,
                        tooltip: exBtn.tooltip || exCaption,
                        icon: exBtn.icon || null,
                        showIcon: !!(exBtn.icon),
                        showText: true
                    });
                    btn.Draw(cmdBarEl);
                    if (exBtn.name) this.controlsMap[exBtn.name] = btn;
                    // Подключаем события (events.onClick, top-level onXxx) через стандартный механизм
                    try {
                        if (exBtn.name && this.controlsMap[exBtn.name]) {
                            let mergedEvts = null;
                            if (exBtn.events) mergedEvts = Object.assign({}, exBtn.events);
                            for (const k of Object.keys(exBtn)) {
                                if (k.length > 2 && k[0] === 'o' && k[1] === 'n' && k[2] === k[2].toUpperCase() && k !== 'options') {
                                    if (!mergedEvts) mergedEvts = {};
                                    if (!mergedEvts[k]) mergedEvts[k] = exBtn[k];
                                }
                            }
                            if (mergedEvts) this._wireItemEvents(this.controlsMap[exBtn.name], mergedEvts);
                        }
                    } catch(e) {}
                }
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
                        
                        // СИСТЕМНАЯ ИНТЕГРАЦИЯ: Автоматически связываем таблицу с формой
                        // Таблица будет обновлять this._currentRecord при активации строки
                        try {
                            const form = this;
                            if (!this._tables) this._tables = [];
                            this._tables.push(tbl);
                            if (!this.table) this.table = tbl; // Первая таблица - главная
                            
                            // Устанавливаем callback для автоматического обновления _currentRecord
                            tbl.onRowActivate = function(rowIndex) {
                                try {
                                    const first = (typeof this.firstVisibleRow === 'number') ? (this.firstVisibleRow | 0) : 0;
                                    const global = first + rowIndex;
                                    if (this.dataCache && this.dataCache[global] && this.dataCache[global].loaded) {
                                        form._currentRecord = this.dataCache[global];
                                    }
                                } catch (e) {
                                    console.error('[DataForm] table onRowActivate error:', e);
                                }
                            };
                        } catch (e) {
                            console.error('[DataForm] failed to setup table integration:', e);
                        }
                    } else {
                        const tbl = new Table(contentArea, tblProps);
                        try { if (typeof tbl.setCaption === 'function') tbl.setCaption(caption); } catch (e) {}
                        try { if (typeof tbl.Draw === 'function') tbl.Draw(contentArea); } catch (e) {}
                        if (item.name) this.controlsMap[item.name] = tbl;

                        // masterFor: при активации строки автоматически фильтровать таблицу(ы)-деталь
                        // Поддерживается как строка, так и массив имён таблиц-деталей.
                        if (properties && properties.masterFor) {
                            const masterForTargets = Array.isArray(properties.masterFor)
                                ? properties.masterFor
                                : [properties.masterFor];
                            const masterField = properties.masterField || 'UID';
                            const detailField = properties.detailField;
                            const form = this;
                            tbl.onRowActivate = function(rowIndex) {
                                try {
                                    const rows = typeof this.data_getRows === 'function'
                                        ? this.data_getRows(this.dataKey)
                                        : [];
                                    const row = Array.isArray(rows) ? rows[rowIndex] : null;
                                    for (const key of masterForTargets) {
                                        const detailTbl = form.controlsMap && form.controlsMap[key];
                                        if (!detailTbl || typeof detailTbl.setFilter !== 'function') continue;
                                        if (row && detailField) {
                                            detailTbl.setFilter(detailField, row[masterField], {
                                                type: 'client', visibility: 'hidden', operator: '='
                                            });
                                        }
                                    }
                                } catch (e) {
                                    console.error('[Table] masterFor onRowActivate error:', e);
                                }
                            };
                            // Помечаем как мастер — _activateFirstRows() активирует их раньше деталей.
                            tbl._isMaster = true;
                        }
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
            case 'htmlViewer': {
                try {
                    const iframe = document.createElement('iframe');
                    iframe.style.width  = item.width  || '100%';
                    iframe.style.height = item.height || '400px';
                    iframe.style.border = item.border != null ? item.border : '1px solid #888';
                    iframe.style.backgroundColor = '#fff';
                    iframe.setAttribute('sandbox', 'allow-same-origin allow-popups allow-scripts allow-modals');
                    contentArea.appendChild(iframe);
                    const viewer = {
                        element: iframe,
                        setValue(html) {
                            const doc = iframe.contentDocument || iframe.contentWindow.document;
                            doc.open(); doc.write(html); doc.close();
                        },
                        setUrl(url) { iframe.src = url; },
                        print() {
                            try { iframe.contentWindow.print(); } catch(e) { window.print(); }
                        }
                    };
                    if (item.name) this.controlsMap[item.name] = viewer;
                } catch (e) {
                    console.error('Error creating htmlViewer control', e);
                }
                break;
            }
            default:
                console.warn('Unknown layout item type:', item.type);
        }

        // Сбор событий: явные events + top-level onXxx свойства элемента
        try {
            if (item.name && this.controlsMap[item.name]) {
                let mergedEvents = null;
                // 1. Явно описанные events: { onClick: ..., onRowActivate: ... }
                if (item.events) mergedEvents = Object.assign({}, item.events);
                // 2. Top-level onXxx свойства (onAction, onClick, onChange, ...)
                for (const k of Object.keys(item)) {
                    if (k.length > 2 && k[0] === 'o' && k[1] === 'n' && k[2] === k[2].toUpperCase() && k !== 'options') {
                        if (!mergedEvents) mergedEvents = {};
                        if (!mergedEvents[k]) mergedEvents[k] = item[k];
                    }
                }
                if (mergedEvents) this._wireItemEvents(this.controlsMap[item.name], mergedEvents);
            }
        } catch(e) {}
    }

    // Привязывает клиентские события на любой UI-объект.
    // Дом-события (onClick, onMouseOver ...) вешаются через addEventListener на ctrl.element.
    // Колбэки объекта (onRowActivate, onSelect ...) просто присваиваются ctrl[eventName].
    // Клиентский скрипт загружается один раз и кэшируется.
    _wireItemEvents(ctrl, events) {
        // Маппинг: имя события → DOM-событие. Всё что не здесь — объектный калбэк.
        const DOM_MAP = {
            onClick:       'click',
            onDoubleClick: 'dblclick',
            onMouseOver:   'mouseover',
            onMouseOut:    'mouseout',
            onMouseEnter:  'mouseenter',
            onMouseLeave:  'mouseleave',
            onKeyDown:     'keydown',
            onKeyUp:       'keyup',
            onKeyPress:    'keypress',
            onFocus:       'focus',
            onBlur:        'blur',
            onContextMenu: 'contextmenu',
        };
        const formSelf = this;
        // Нормализация binding: строка 'fnName' → { clientScript: form._clientScript, fn: 'fnName' }
        // Объект без clientScript → подставляем form._clientScript
        const normalizeBinding = (raw) => {
            if (typeof raw === 'string') {
                return { clientScript: formSelf._clientScript, fn: raw };
            }
            if (raw && typeof raw === 'object') {
                if (!raw.clientScript && formSelf._clientScript) {
                    raw = Object.assign({}, raw, { clientScript: formSelf._clientScript });
                }
                return raw;
            }
            return null;
        };
        // Резолв {data.field} плейсхолдеров из _dataMap формы
        const resolveParams = (val) => {
            if (typeof val === 'string') return val.replace(/\{data\.([^}]+)\}/g, (_, field) => {
                const entry = formSelf._dataMap && formSelf._dataMap[field];
                return (entry && entry.value !== undefined) ? entry.value : '';
            });
            if (Array.isArray(val)) return val.map(resolveParams);
            if (val && typeof val === 'object') { const out = {}; for (const k in val) out[k] = resolveParams(val[k]); return out; }
            return val;
        };
        const loadAndCallScript = async (binding, args) => {
            try {
                const uid = binding.clientScript;
                const fn  = binding.fn;
                if (!uid || !fn) return;
                if (!window._clientScriptCache) window._clientScriptCache = {};
                if (!window._clientScriptCache[uid]) {
                    const resp = await fetch(`/files/${uid}`);
                    if (!resp.ok) return;
                    window._clientScriptCache[uid] = (new Function(await resp.text()))();
                }
                const mod = window._clientScriptCache[uid];
                if (mod && typeof mod[fn] === 'function') {
                    // Контекст: форма + резолвленные fnParams
                    const ctx = { form: formSelf };
                    if (binding.fnParams) ctx.fnParams = resolveParams(binding.fnParams);
                    await mod[fn](...args, ctx);
                }
            } catch(e) { console.error('[_wireItemEvents] script error:', e); }
        };
        for (const [eventName, rawBinding] of Object.entries(events || {})) {
            if (!rawBinding) continue;
            const binding = normalizeBinding(rawBinding);
            if (!binding) continue;
            const domEvt = DOM_MAP[eventName];
            // Если у контрола уже есть свойство с именем события (напр. Button.onClick) —
            // обрабатываем как объектный колбэк, а не DOM, чтобы избежать двойного вызова.
            const hasOwnCallback = (eventName in ctrl) || (typeof ctrl[eventName] === 'function');
            if (domEvt && !hasOwnCallback) {
                // DOM-событие: вешаем на element
                const el = ctrl.element || (typeof ctrl.getElement === 'function' && ctrl.getElement());
                if (el) {
                    el.addEventListener(domEvt, (...args) => loadAndCallScript(binding, args));
                }
            } else if (eventName === 'onResize') {
                // ResizeObserver
                const el = ctrl.element || (typeof ctrl.getElement === 'function' && ctrl.getElement());
                if (el && typeof ResizeObserver !== 'undefined') {
                    new ResizeObserver(entries => loadAndCallScript(binding, [entries])).observe(el);
                }
            } else {
                // Объектный калбэк: onRowActivate, onSelect, onChange, onAction...
                // Цепляем поверх уже установленного обработчика (напр. masterFor), не перезаписываем.
                const existing = ctrl[eventName];
                ctrl[eventName] = typeof existing === 'function'
                    ? (...args) => { try { existing.apply(ctrl, args); } catch(e) {} loadAndCallScript(binding, args); }
                    : (...args) => loadAndCallScript(binding, args);
            }
        }
    }

    // Активировать первую строку во всех таблицах лейаута.
    // Мастер-таблицы (имеющие _isMaster) — первыми, чтобы их onRowActivate
    // успел установить фильтры до активации деталь-таблиц.
    // Деталь-таблицы активируются только если у них нет скрытых фильтров
    // (иначе _activeRowIndex = 0 не соответствует видимой строке при фильтрации).
    _activateFirstRows() {
        try {
            const tables = Object.values(this.controlsMap || {}).filter(
                c => c && typeof c.activateRow === 'function' && typeof c.data_getRows === 'function'
            );
            // Мастера первыми
            tables.sort((a, b) => (b._isMaster ? 1 : 0) - (a._isMaster ? 1 : 0));
            for (const tbl of tables) {
                try {
                    // Деталь-таблицы пропускаем: их фильтр ещё не выставлен,
                    // activateRow(0) дал бы реальный индекс, несовпадающий с видимым.
                    // Мастер сам активирует свою первую строку → её onRowActivate
                    // выставит фильтр на деталях.
                    if (!tbl._isMaster) continue;
                    const rows = tbl.data_getRows(tbl.dataKey);
                    if (Array.isArray(rows) && rows.length > 0) tbl.activateRow(0);
                } catch(e) {}
            }
        } catch(e) {}
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
                try { this._clientScript = both.clientScript || null; } catch (e) {}
                try { this._windowState = both.windowState || null; } catch (e) {}
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
            if (typeof showAlert === 'function') showAlert(__t('Layout load error: ') + (error && error.message ? error.message : String(error)));
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

    collectData() {
        const data = {};
        for (const key in this.controlsMap) {
            const ctrl = this.controlsMap[key];
            if (!ctrl) continue;
            
            const fieldName = (ctrl.element && ctrl.element.dataset) ? ctrl.element.dataset.field : null;
            if (fieldName) {
                let val = null;
                if (typeof ctrl.getValue === 'function') {
                    val = ctrl.getValue();
                } else if (typeof ctrl.getText === 'function') {
                    val = ctrl.getText();
                } else if (ctrl.element && ctrl.element.value !== undefined) {
                    val = ctrl.element.value;
                }
                data[fieldName] = val;
            }
        }
        return data;
    }

    async doAction(action, params) {
        if (action === 'runScript') {
            const uid      = params && params.uid;
            const fn       = params && params.fn;
            const fnParams = params && params.fnParams;
            if (!uid) { if (typeof showAlert === 'function') showAlert(__t('runScript: uid not specified')); return; }
            if (!fn)  { if (typeof showAlert === 'function') showAlert(__t('runScript: fn not specified')); return; }
            // Резолвинг {data.fieldName} — подставляет значения полей формы в fnParams
            const resolveParams = (val) => {
                if (!val) return val;
                if (typeof val === 'string') return val.replace(/\{data\.([^}]+)\}/g, (_, field) => {
                    const entry = this._dataMap && this._dataMap[field];
                    return (entry && entry.value !== undefined) ? entry.value : '';
                });
                if (Array.isArray(val)) return val.map(resolveParams);
                if (typeof val === 'object') { const out = {}; for (const k in val) out[k] = resolveParams(val[k]); return out; }
                return val;
            };
            try {
                const resp = await fetch(`/files/${uid}`);
                if (!resp.ok) { if (typeof showAlert === 'function') showAlert(__t('File not found or access denied')); return; }
                const code = await resp.text();
                // eslint-disable-next-line no-new-func
                const mod = (new Function(code))();
                if (mod && typeof mod[fn] === 'function') {
                    await mod[fn](resolveParams(fnParams));
                } else {
                    if (typeof showAlert === 'function') showAlert(__t('runScript: function "') + fn + __t('" not found in script'));
                }
            } catch (e) {
                if (typeof showAlert === 'function') showAlert(__t('Script execution error: ') + e.message);
            }
            return;
        }
        if (action === 'ok') {
            if (!this._modified) {
                // Изменений нет — просто закрываем
                this._closing = true;
                this.close();
            } else {
                // Есть изменения — спрашиваем "Сохранить?"
                const self = this;
                if (typeof showConfirm === 'function') {
                    showConfirm(__t('Data has been modified. Save changes?'), async () => {
                        // "Да" — сохранить, затем закрыть
                        await self.doAction('save');
                        if (!self._modified) {
                            self._closing = true;
                            self.close();
                        }
                    }, () => {
                        // "Нет" — закрыть без сохранения
                        self._closing = true;
                        self._modified = false;
                        if (self._originalTitle) super.setTitle(self._originalTitle);
                        self.close();
                    });
                } else {
                    await this.doAction('save');
                    if (!this._modified) {
                        this._closing = true;
                        this.close();
                    }
                }
            }
            return;
        }
        if (action === 'save') {
            const data = this.collectData();
            // Собираем данные табличных частей из _dataMap (записи с tabularSection: true)
            try {
                const tabularSections = {};
                if (this._dataMap) {
                    for (const key in this._dataMap) {
                        const entry = this._dataMap[key];
                        if (entry && entry.tabularSection === true) {
                            tabularSections[entry.tableName] = Array.isArray(entry.value) ? entry.value : [];
                        }
                    }
                }
                if (Object.keys(tabularSections).length > 0) data.__tabularSections = tabularSections;
            } catch (_) {}
            try {
                const res = await this.applyChanges(data);
                if (res && res.ok) {
                    if (res.warnings && res.warnings.length > 0) {
                        const msg = __t('Saved, but some rows were not written:\n') + res.warnings.join('\n');
                        if (typeof showAlert === 'function') showAlert(msg);
                        else alert(msg);
                    }
                    // Обновить скалярные данные формы с сервера без перерисовки DOM.
                    // Важно: controlsMap содержит не только поля формы, но и каждую ячейку
                    // таблицы (ключи вида ts_booking_rooms__r0__roomId). Если обновить их
                    // через setValue(UID, undefined), они потеряют отображаемые имена.
                    // Поэтому обновляем ТОЛЬКО контролы, чьё поле реально пришло от сервера.
                    try {
                        const freshBoth = await callServerMethod(this.appName, 'getLayoutWithData', { datasetId: this._datasetId });
                        if (freshBoth && Array.isArray(freshBoth.data)) {
                            if (freshBoth.datasetId) this._datasetId = freshBoth.datasetId;
                            // Собираем имена скалярных полей из свежего ответа
                            const freshScalarNames = new Set();
                            for (const rec of freshBoth.data) {
                                if (!rec || !rec.name) continue;
                                if (rec.tabularSection === true) continue;
                                this._dataMap[rec.name] = rec;
                                freshScalarNames.add(rec.name);
                            }
                            // Обновляем DOM только для тех контролов, которые есть в freshBoth.data
                            this._suppressModified = true;
                            for (const key in this.controlsMap) {
                                const ctrl = this.controlsMap[key];
                                if (!ctrl) continue;
                                const fieldName = (ctrl.element && ctrl.element.dataset) ? ctrl.element.dataset.field : null;
                                if (!fieldName || !freshScalarNames.has(fieldName)) continue;
                                const rec = this._dataMap[fieldName];
                                let val = '', display = undefined;
                                if (rec && rec.selection && rec.selection.display !== undefined) {
                                    val = (rec.selection.UID !== undefined) ? rec.selection.UID : (rec.value !== undefined ? rec.value : rec);
                                    display = rec.selection.display;
                                } else if (rec && rec.__display !== undefined) {
                                    val = (rec.value !== undefined ? rec.value : rec);
                                    display = rec.__display;
                                } else if (rec && typeof rec.value === 'object' && rec.value !== null) {
                                    display = rec.value.display || rec.value.name || rec.value.UID || '';
                                    val = (rec.value.value !== undefined) ? rec.value.value : (rec.value.UID !== undefined ? rec.value.UID : rec.value);
                                } else {
                                    val = (rec && rec.value !== undefined) ? rec.value : '';
                                }
                                try {
                                    if (typeof ctrl.setValue === 'function') ctrl.setValue(val, display);
                                    else if (typeof ctrl.setText === 'function') ctrl.setText(display !== undefined ? String(display) : String(val));
                                } catch(_) {}
                            }
                        }
                    } catch(reloadErr) { console.error('[DataForm] data refresh after save error', reloadErr); }
                    // Сбрасываем флаг изменённости и снимаем блокировку
                    this._modified = false;
                    this._suppressModified = false;
                    if (this._originalTitle) super.setTitle(this._originalTitle);
                } else {
                    const errMsg = (res && res.error ? res.error : __t('Unknown error'));
                    if (typeof showAlert === 'function') showAlert(__t('Save error: ') + errMsg);
                    else alert(__t('Save error: ') + errMsg);
                }
            } catch (e) {
                if (typeof showAlert === 'function') showAlert(__t('Save error: ') + e.message);
                else alert(__t('Save error: ') + e.message);
            }
            return;
        }
        if (action === 'cancel') {
            // Если данные не изменены — закрываем сразу.
            // Если изменены — спрашиваем "Отменить изменения?".
            if (!this._modified) {
                this._closing = true;
                this.close();
            } else {
                const self = this;
                if (typeof showConfirm === 'function') {
                    showConfirm(__t('Discard unsaved changes?'), () => {
                        self._closing = true;
                        self._modified = false;
                        if (self._originalTitle) super.setTitle(self._originalTitle);
                        self.close();
                    });
                } else {
                    this._closing = true;
                    this._modified = false;
                    this.close();
                }
            }
            return;
        }
        return super.doAction(action, params);
    }

    async Draw(parent) {
        super.Draw(parent);

        // Hide form until layout is fully loaded and windowState applied —
        // prevents flicker of an empty/small window before maximize.
        try { if (this.element) this.element.style.visibility = 'hidden'; } catch (e) {}

        const contentArea = this.getContentArea();
        try { if (contentArea) contentArea.style.display = 'flex'; } catch (e) {}
        try { if (contentArea) contentArea.style.flexDirection = 'column'; } catch (e) {}
        try { if (contentArea) contentArea.style.padding = '10px'; } catch (e) {}

        // Clear previous content and controls before re-rendering layout
        try { if (contentArea) contentArea.innerHTML = ''; } catch (e) {}
        try { for (const k in this.controlsMap) { if (Object.prototype.hasOwnProperty.call(this.controlsMap, k)) delete this.controlsMap[k]; } } catch (e) {}

        await this.loadLayout();
        await this.renderLayout();

        // Apply windowState specified in layout metadata
        try {
            if (this._windowState === 'maximized' && !this.isMaximized) {
                this.maximize();
            }
        } catch (e) {}

        // Show form now that layout is ready and window state applied
        try { if (this.element) this.element.style.visibility = 'visible'; } catch (e) {}

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

    constructor(parentElement = null, properties = {}) {
        super();
        this.caption = properties.caption || '';
        this.icon = properties.icon || null;
        this.showIcon = properties.showIcon || false;
        this.showText = (properties.showText !== undefined) ? properties.showText : true;
        this.tooltip = properties.tooltip || '';
        this.action = properties.action || null;
        this.params = properties.params || {};
        this.isStandard = (properties.isStandard !== undefined) ? properties.isStandard : false;

        this.x = (properties.x !== undefined) ? properties.x : 0;
        this.y = (properties.y !== undefined) ? properties.y : 0;
        this.z = (properties.z !== undefined) ? properties.z : 0;
        this.width = properties.width || 0;
        this.height = properties.height || 0;

        this.tooltipTimeout = null;
        this.tooltipElement = null;
        this.parentElement = parentElement || null;
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
                try {
                    if (!this.element) return;
                    const base = UIObject.getClientConfigValue('defaultColor', btnBase);
                    const light = UIObject.brightenColor(base, 60);
                    const dark = UIObject.brightenColor(base, -60);
                    this.element.style.backgroundColor = base;
                    this.element.style.borderTop = `2px solid ${light}`;
                    this.element.style.borderLeft = `2px solid ${light}`;
                    this.element.style.borderRight = `2px solid ${dark}`;
                    this.element.style.borderBottom = `2px solid ${dark}`;
                } catch (e) {}
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

// ── Google Places Autocomplete helpers ────────────────────────────────────────────────────────
// Module-level state for lazy one-time initialisation of Google Maps JS API
let _placesApiKey = null;
let _placesReady = false;
let _placesLoading = false;
let _placesCallbacks = [];
async function _ensureGooglePlaces() {
    if (_placesReady) return;
    if (!_placesApiKey) {
        try {
            const cfg = await callServerMethod('uniForm', 'getPlacesConfig', {});
            _placesApiKey = (cfg && cfg.apiKey) || null;
        } catch (e) { throw new Error('[AddressBox] Cannot fetch Places API key'); }
    }
    if (!_placesApiKey) throw new Error('[AddressBox] No Places API key configured');
    if (_placesReady) return;
    return new Promise((resolve, reject) => {
        if (_placesReady) { resolve(); return; }
        _placesCallbacks.push({ resolve, reject });
        if (!_placesLoading) {
            _placesLoading = true;
            window['_gmapsPlacesReady'] = () => {
                _placesReady = true;
                _placesLoading = false;
                const cbs = _placesCallbacks.splice(0);
                cbs.forEach(cb => { try { cb.resolve(); } catch (_) {} });
            };
            const s = document.createElement('script');
            s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(_placesApiKey) + '&libraries=places&callback=_gmapsPlacesReady';
            s.async = true;
            s.onerror = () => {
                _placesLoading = false;
                const cbs = _placesCallbacks.splice(0);
                cbs.forEach(cb => { try { cb.reject(new Error('[AddressBox] Failed to load Google Maps JS')); } catch (_) {} });
            };
            document.head.appendChild(s);
        }
    });
}
async function _getPlaceDetails(placeId) {
    await _ensureGooglePlaces();
    return new Promise((resolve) => {
        try {
            const div = document.createElement('div');
            const svc = new window.google.maps.places.PlacesService(div);
            svc.getDetails({ placeId, fields: ['formatted_address'] }, (place, status) => {
                if (status === 'OK' && place && place.formatted_address) resolve(place.formatted_address);
                else resolve(null);
            });
        } catch (e) { resolve(null); }
    });
}
async function _getAddressPredictions(text) {
    await _ensureGooglePlaces();
    return new Promise((resolve) => {
        try {
            const svc = new window.google.maps.places.AutocompleteService();
            svc.getPlacePredictions({ input: text }, (predictions, status) => {
                if (status === 'OK' && Array.isArray(predictions)) {
                    resolve(predictions.map(p => ({ description: p.description, placeId: p.place_id })));
                } else { resolve([]); }
            });
        } catch (e) { resolve([]); }
    });
}
// ─────────────────────────────────────────────────────────────────────────────────────────────

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
        // Date input mode: when true, input edits dates in dd.mm.yyyy format
        if (typeof this.isDate === 'undefined') this.isDate = false;
        this._dateBtn = null;
        this._calPopup = null;
        this._calOpen = false;
        this._dd = '';        // day part (0-2 digits as string)
        this._mm = '';        // month part (0-2 digits as string)
        this._yyyy = '';      // year part (0-4 digits as string)
        this._dateSection = 0; // 0=day, 1=month, 2=year
        this._calYear = null;
        this._calMonth = null;
        // Address autocomplete mode
        this.addressMode = !!this.addressMode;
    }

    setValue(val, display) {
        if (this.isDate) { this._setDateFromAny(val); return; }
        this.rawValue = val;
        // if val is an object with name/display, use it
        let displayVal = display;
        if (displayVal === undefined && val && typeof val === 'object') {
            displayVal = val.__display || val.name || val.UID || String(val);
        }
        if (displayVal === undefined) displayVal = val;
        
        this.setText(displayVal);
    }

    getValue() {
        if (this.isDate) { return this._getDateISO(); }
        // For selection controls, rawValue holds the FK ID which differs from displayed text
        if ((this.showSelectionButton || this.listMode) && this.rawValue !== undefined && this.rawValue !== null) {
            return this.rawValue;
        }
        // For numeric inputs, return a Number (not a string)
        if (this.digitsOnly) {
            const txt = this.getText();
            if (txt === '' || txt === null || txt === undefined) return null;
            const n = Number(txt);
            return isNaN(n) ? txt : n;
        }
        // For regular text/number inputs, return what the user actually typed
        return this.getText();
    }

    setText(text) {
        if (this.isDate) { this._setDateFromAny(text); return; }
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
        if (this.isDate) { return this._getDateDisplay(); }
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
            if (this.isDate) {
                // For date mode, render current date parts (may already be set via setValue before Draw)
                this.element.readOnly = false;
                const dd = (this._dd || '').padEnd(2, ' ');
                const mm = (this._mm || '').padEnd(2, ' ');
                const yyyy = (this._yyyy || '').padEnd(4, ' ');
                this.element.value = dd + '.' + mm + '.' + yyyy;
            } else {
                try { this.setText(this.text); } catch (_) { try { this.element.value = this.text; } catch (_) {} }
                this.element.placeholder = this.placeholder;
                this.element.readOnly = this.readOnly;
            }
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
            this.inputContainer.style.alignItems = 'stretch';
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
                        sbtn.dataset.role = 'selection';
                        // Apply CSS class for static styling; colors provided globally by client config
                        try { sbtn.classList.add('input-field-button'); } catch (e) {}
                        sbtn.addEventListener('click', (ev) => { try { ev.stopPropagation(); ev.preventDefault(); this.onSelectionStart(); } catch (_) {} });
                        this._selectBtn = sbtn;
                        this.inputContainer.appendChild(this._selectBtn);
                        // Ensure button width equals computed height (do not change height)
                        try {
                            const syncBtn = (b) => {
                                try {
                                    const update = () => {
                                        try {
                                            const h = Math.round((b.offsetHeight || (b.getBoundingClientRect && b.getBoundingClientRect().height) || 0));
                                            if (h > 0) b.style.width = h + 'px';
                                        } catch (_) {}
                                    };
                                    update();
                                    if (typeof ResizeObserver !== 'undefined') {
                                        try { const ro = new ResizeObserver(update); ro.observe(b.parentElement || b); b._ro = ro; } catch(_) {}
                                    }
                                    const winHandler = () => update();
                                    try { window.addEventListener('resize', winHandler); b._win = winHandler; } catch(_) {}
                                } catch (_) {}
                            };
                            try { syncBtn(this._selectBtn); } catch (_) {}
                        } catch (e) {}
                    }
                }
            } catch (e) {}

            // Calendar button: for date picker mode, a button identical in style to "..." and "▾"
            try {
                if (this.isDate && !this._dateBtn) {
                    const calBtn = document.createElement('button');
                    calBtn.type = 'button';
                    calBtn.tabIndex = -1;
                    calBtn.textContent = '▾';
                    calBtn.title = __t('Select date');
                    try { calBtn.classList.add('input-field-button'); } catch (e) {}
                    calBtn.addEventListener('click', (ev) => {
                        try { ev.stopPropagation(); ev.preventDefault(); this._toggleCalendar && this._toggleCalendar(); } catch (_) {}
                    });
                    this._dateBtn = calBtn;
                    this.inputContainer.appendChild(this._dateBtn);
                    try {
                        const syncCalBtn = (b) => {
                            try {
                                const update = () => {
                                    try {
                                        const h = Math.round((b.offsetHeight || (b.getBoundingClientRect && b.getBoundingClientRect().height) || 0));
                                        if (h > 0) b.style.width = h + 'px';
                                    } catch (_) {}
                                };
                                update();
                                if (typeof ResizeObserver !== 'undefined') {
                                    try { const ro = new ResizeObserver(update); ro.observe(b.parentElement || b); b._ro = ro; } catch(_) {}
                                }
                                const winHandler = () => update();
                                try { window.addEventListener('resize', winHandler); b._win = winHandler; } catch(_) {}
                            } catch (_) {}
                        };
                        syncCalBtn(this._dateBtn);
                    } catch (e) {}
                    // For date mode: set monospace-like letter-spacing so dd.mm.yyyy renders evenly
                    try { this.element.style.letterSpacing = '0.5px'; } catch (_) {}
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
                try {
                    if (!this.element) return;
                    const base = UIObject.getClientConfigValue('defaultColor', tbBase);
                    const light = UIObject.brightenColor(base, 60);
                    const dark = UIObject.brightenColor(base, -60);
                    this.element.style.backgroundColor = '#ffffff';
                } catch (e) {}
            });

            // If listMode is enabled, add a small Win95-style button at right to open prepared list
            try {
                // remove stale button/popup if present and mode disabled
                if (!this.listMode && this._listBtn) {
                    try { if (this._listBtn._ro && typeof this._listBtn._ro.disconnect === 'function') this._listBtn._ro.disconnect(); } catch (_) {}
                    try { if (this._listBtn._win) window.removeEventListener('resize', this._listBtn._win); } catch (_) {}
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
                        // Use simple text content for glyph to keep markup minimal
                        // and styling centralized in CSS (avoid extra span element).
                        // Use CSS class for static styling; unified size handled by CSS
                        try { btn.classList.add('input-field-button'); } catch (e) {}
                        btn.textContent = '▾';
                        // Win95-style raised button colors are provided globally by client config

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
                        // Ensure button width equals computed height (do not change height)
                        try {
                            const syncBtn = (b) => {
                                try {
                                    const update = () => {
                                        try {
                                            const h = Math.round((b.offsetHeight || (b.getBoundingClientRect && b.getBoundingClientRect().height) || 0));
                                            if (h > 0) b.style.width = h + 'px';
                                        } catch (_) {}
                                    };
                                    update();
                                    if (typeof ResizeObserver !== 'undefined') {
                                        try { const ro = new ResizeObserver(update); ro.observe(b.parentElement || b); b._ro = ro; } catch(_) {}
                                    }
                                    const winHandler = () => update();
                                    try { window.addEventListener('resize', winHandler); b._win = winHandler; } catch(_) {}
                                } catch (_) {}
                            };
                            try { syncBtn(this._listBtn); } catch (_) {}
                        } catch (e) {}

                        // Removed automatic preload — list must be provided from outside
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
                                            // store raw value so getValue() returns code, not caption
                                            this.rawValue = it.value;
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

            // ── Quick search for recordSelector fields ──────────────────────────────────────
            try {
                if (this.showSelectionButton && this.quickSearch !== false) {
                    const selMeta = this.selection || {};
                    const table = selMeta.table || selMeta.tableName || null;
                    if (table) {
                        this._quickSearchEnabled = true;

                        this._closeQsPopup = () => {
                            try {
                                if (this._qsKeyCapture) { try { document.removeEventListener('keydown', this._qsKeyCapture, true); } catch(_){} this._qsKeyCapture = null; }
                                if (this._qsPopup) { try { this._qsPopup.remove(); } catch(_){} this._qsPopup = null; }
                                this._qsOpen = false;
                                if (this._qsDocHandler) { try { document.removeEventListener('click', this._qsDocHandler); } catch(_){} this._qsDocHandler = null; }
                                if (this._qsScrollHandler) { try { window.removeEventListener('scroll', this._qsScrollHandler, true); } catch(_){} try { window.removeEventListener('resize', this._qsScrollHandler); } catch(_){} this._qsScrollHandler = null; }
                            } catch(_) {}
                        };

                        this._openQsPopup = (items, searchText) => {
                            try {
                                if (this._qsOpen) { try { this._closeQsPopup(); } catch(_){} }
                                const popup = document.createElement('div');
                                popup.className = 'textbox-list-popup';
                                popup.style.position = 'absolute';
                                popup.style.backgroundColor = '#ffffff';
                                popup.style.border = 'none';
                                popup.style.fontFamily = 'MS Sans Serif, sans-serif';
                                popup.style.fontSize = '11px';
                                popup.style.zIndex = '99999';
                                popup.style.boxSizing = 'border-box';
                                popup.style.padding = '2px';
                                popup.style.boxShadow = '0 4px 10px rgba(0,0,0,0.25)';
                                const containerRef = this.inputContainer;
                                popup.style.minWidth = (containerRef ? containerRef.clientWidth : 120) + 'px';

                                // Prevent blur on input when clicking popup
                                popup.addEventListener('mousedown', (e) => { e.preventDefault(); });

                                if (items.length === 0) {
                                    // "Create new" row
                                    const createRow = document.createElement('div');
                                    createRow.style.cssText = 'padding:3px 6px;cursor:pointer;user-select:none;color:#000080;display:flex;align-items:center;gap:4px;';
                                    createRow.setAttribute('data-qs-item', '1');
                                    const icon = document.createElement('img');
                                    icon.src = '/apps/general_icons/resources/public/16x16/add.png';
                                    icon.style.cssText = 'width:16px;height:16px;flex-shrink:0;';
                                    createRow.appendChild(icon);
                                    const createSpan = document.createElement('span');
                                    createSpan.textContent = __t('Create');
                                    createRow.appendChild(createSpan);
                                    createRow.addEventListener('mouseenter', () => { createRow.style.backgroundColor = '#0000aa'; createRow.style.color = '#ffffff'; createRow.setAttribute('data-selected','1'); });
                                    createRow.addEventListener('mouseleave', () => { if(createRow.getAttribute('data-selected')==='1'){ createRow.style.backgroundColor=''; createRow.style.color='#000080'; createRow.removeAttribute('data-selected'); } });
                                    createRow.addEventListener('click', () => {
                                        try {
                                            const capturedText = searchText;
                                            this._closeQsPopup();
                                            if (window.MySpace && typeof window.MySpace.open === 'function') {
                                                const onAfterSave = (savedData) => {
                                                    try {
                                                        if (savedData && savedData.UID) {
                                                            const display = savedData.name || String(capturedText || '');
                                                            this.setValue(savedData.UID, display);
                                                            this.text = String(display);
                                                            try { if (this.element) this.element.dispatchEvent(new Event('input', { bubbles: true })); } catch(_){}
                                                        }
                                                    } catch(_) {}
                                                };
                                                (async () => {
                                                    try {
                                                        const id = await window.MySpace.open('uniForm', { mode: 'record', tableName: table, onAfterSave });
                                                        const inst = window.MySpace.getInstance && window.MySpace.getInstance(id);
                                                        if (inst && inst.form) {
                                                            setTimeout(() => {
                                                                try {
                                                                    const nameCtrl = inst.form.controlsMap && inst.form.controlsMap['name'];
                                                                    if (nameCtrl && typeof nameCtrl.setValue === 'function') {
                                                                        nameCtrl.setValue(capturedText || '');
                                                                        inst.form.setModified(true);
                                                                    }
                                                                } catch(_){}
                                                            }, 300);
                                                        }
                                                    } catch(e) { try { console.error('[TextBox.quickSearch] create error', e); } catch(_){} }
                                                })();
                                            }
                                        } catch(_) {}
                                    });
                                    popup.appendChild(createRow);
                                    if (searchText) {
                                        const textRow = document.createElement('div');
                                        textRow.style.cssText = 'padding:2px 6px 2px 26px;font-size:11px;color:#808080;user-select:none;';
                                        textRow.textContent = String(searchText);
                                        popup.appendChild(textRow);
                                    }
                                } else {
                                    for (const it of items) {
                                        const row = document.createElement('div');
                                        row.style.cssText = 'padding:3px 6px;cursor:pointer;user-select:none;';
                                        row.textContent = String(it.name || '');
                                        row._qsRecord = it;
                                        row.setAttribute('data-qs-item', '1');
                                        row.addEventListener('mouseenter', () => { Array.from(popup.querySelectorAll('[data-qs-item]')).forEach(r => { r.style.backgroundColor=''; r.style.color=''; r.removeAttribute('data-selected'); }); row.style.backgroundColor='#0000aa'; row.style.color='#ffffff'; row.setAttribute('data-selected','1'); });
                                        row.addEventListener('mouseleave', () => { if(row.getAttribute('data-selected')==='1'){ row.style.backgroundColor=''; row.style.color=''; row.removeAttribute('data-selected'); } });
                                        row.addEventListener('click', () => {
                                            try {
                                                const rec = row._qsRecord;
                                                if (rec) {
                                                    const display = String(rec.name || '');
                                                    this.setValue(rec.UID, display);
                                                    this.text = display;
                                                    try { if (this.element) this.element.dispatchEvent(new Event('input', { bubbles: true })); } catch(_){}
                                                }
                                                this._closeQsPopup();
                                                try { if (this.element) this.element.focus(); } catch(_){}
                                            } catch(_){}
                                        });
                                        popup.appendChild(row);
                                    }
                                }

                                const rect = (containerRef || this.element || document.body).getBoundingClientRect();
                                popup.style.left = (rect.left + (window.pageXOffset || document.documentElement.scrollLeft)) + 'px';
                                popup.style.top = (rect.bottom + (window.pageYOffset || document.documentElement.scrollTop)) + 'px';
                                document.body.appendChild(popup);
                                this._qsPopup = popup;
                                this._qsOpen = true;

                                this._qsKeyCapture = (ev) => {
                                    try {
                                        if (!this._qsOpen) return;
                                        const k = ev.key;
                                        if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'Enter' && k !== 'Escape') return;
                                        ev.preventDefault(); ev.stopPropagation();
                                        const rows = Array.from(popup.querySelectorAll('[data-qs-item]'));
                                        if (!rows.length) return;
                                        let idx = rows.findIndex(r => r.getAttribute('data-selected') === '1');
                                        if (k === 'ArrowDown') {
                                            idx = (idx < rows.length - 1) ? idx + 1 : 0;
                                            rows.forEach(r => { r.style.backgroundColor=''; r.style.color=''; r.removeAttribute('data-selected'); });
                                            rows[idx].style.backgroundColor='#0000aa'; rows[idx].style.color='#ffffff'; rows[idx].setAttribute('data-selected','1');
                                        } else if (k === 'ArrowUp') {
                                            idx = (idx > 0) ? idx - 1 : rows.length - 1;
                                            rows.forEach(r => { r.style.backgroundColor=''; r.style.color=''; r.removeAttribute('data-selected'); });
                                            rows[idx].style.backgroundColor='#0000aa'; rows[idx].style.color='#ffffff'; rows[idx].setAttribute('data-selected','1');
                                        } else if (k === 'Enter') {
                                            const target = (idx >= 0 && rows[idx]) ? rows[idx] : (rows.length === 1 ? rows[0] : null);
                                            if (target) target.click();
                                        } else if (k === 'Escape') {
                                            try { if (this.element) this.element.value = this.text || ''; } catch(_){}
                                            this._closeQsPopup();
                                            try { if (this.element) this.element.focus(); } catch(_){}
                                        }
                                    } catch(_){}
                                };
                                document.addEventListener('keydown', this._qsKeyCapture, true);

                                this._qsDocHandler = (ev) => {
                                    try { if (!popup.contains(ev.target) && !(this.inputContainer && this.inputContainer.contains(ev.target))) { this._closeQsPopup(); } } catch(_){}
                                };
                                document.addEventListener('click', this._qsDocHandler);

                                this._qsScrollHandler = () => { try { this._closeQsPopup(); } catch(_){} };
                                try { window.addEventListener('scroll', this._qsScrollHandler, true); } catch(_){}
                                try { window.addEventListener('resize', this._qsScrollHandler); } catch(_){}
                            } catch(_) {}
                        };

                        // Input event: debounced quick search
                        this._qsInputHandler = (ev) => {
                            try {
                                if (!this._quickSearchEnabled) return;
                                const text = this.element ? this.element.value : '';
                                if (this._qsDebounce) { clearTimeout(this._qsDebounce); this._qsDebounce = null; }
                                if (!text) {
                                    this._closeQsPopup();
                                    return;
                                }
                                // Skip search if text matches the last confirmed selection (e.g. after programmatic setValue)
                                if (text === (this.text || '')) {
                                    this._closeQsPopup();
                                    return;
                                }
                                this._qsDebounce = setTimeout(async () => {
                                    try {
                                        const resp = await callServerMethod('uniForm', 'quickSearch', { tableName: table, searchText: text, limit: 10 });
                                        const foundItems = (resp && Array.isArray(resp.items)) ? resp.items : [];
                                        if (this.element && this.element.value === text) {
                                            this._openQsPopup(foundItems, text);
                                        }
                                    } catch(e) {
                                        try { this._closeQsPopup(); } catch(_){}
                                    }
                                }, 250);
                            } catch(_){}
                        };
                        this.element.addEventListener('input', this._qsInputHandler);

                        // Blur: revert text if user typed but didn't select
                        this.element.addEventListener('blur', () => {
                            try {
                                if (!this._quickSearchEnabled) return;
                                if (this._qsDebounce) { clearTimeout(this._qsDebounce); this._qsDebounce = null; }
                                setTimeout(() => {
                                    try {
                                        if (this._qsOpen) return; // popup is open (e.g. focus moved to popup item), don't revert yet
                                        const currentText = this.element ? this.element.value : '';
                                        if (!currentText) {
                                            this.rawValue = null; this.text = '';
                                            try { if (this.element) this.element.dispatchEvent(new Event('input', { bubbles: true })); } catch(_){}
                                        } else if (currentText !== (this.text || '')) {
                                            try { if (this.element) this.element.value = this.text || ''; } catch(_){}
                                        }
                                    } catch(_){}
                                }, 200);
                            } catch(_){}
                        });
                    }
                }
            } catch(e) {}

            // ── Address autocomplete ─────────────────────────────────────────────────────
            try {
                if (this.addressMode) {
                    this._addressEnabled = true;
                    this._addrNavActive = false;
                    this._addrTypedText = '';

                    this._closeAddrPopup = () => {
                        try {
                            if (this._addrKeyCapture) { try { document.removeEventListener('keydown', this._addrKeyCapture, true); } catch (_) {} this._addrKeyCapture = null; }
                            if (this._addrPopup) { try { this._addrPopup.remove(); } catch (_) {} this._addrPopup = null; }
                            this._addrOpen = false;
                            this._addrNavActive = false;
                            if (this._addrDocHandler) { try { document.removeEventListener('click', this._addrDocHandler); } catch (_) {} this._addrDocHandler = null; }
                            if (this._addrScrollHandler) { try { window.removeEventListener('scroll', this._addrScrollHandler, true); } catch (_) {} try { window.removeEventListener('resize', this._addrScrollHandler); } catch (_) {} this._addrScrollHandler = null; }
                        } catch (_) {}
                    };

                    this._openAddrPopup = (predictions) => {
                        try {
                            if (this._addrOpen) this._closeAddrPopup();
                            if (!predictions || !predictions.length) return;
                            const popup = document.createElement('div');
                            popup.className = 'textbox-list-popup';
                            popup.style.position = 'absolute';
                            popup.style.backgroundColor = '#ffffff';
                            popup.style.border = 'none';
                            popup.style.fontFamily = 'MS Sans Serif, sans-serif';
                            popup.style.fontSize = '11px';
                            popup.style.zIndex = '99999';
                            popup.style.boxSizing = 'border-box';
                            popup.style.padding = '2px';
                            popup.style.boxShadow = '0 4px 10px rgba(0,0,0,0.25)';
                            popup.addEventListener('mousedown', (e) => { e.preventDefault(); });
                            const containerRef = this.inputContainer;
                            popup.style.width = (containerRef ? containerRef.clientWidth : 200) + 'px';
                            for (const pred of predictions) {
                                const row = document.createElement('div');
                                row.style.cssText = 'padding:3px 6px;cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                                row.textContent = pred.description;
                                row._addrPred = pred;
                                row.setAttribute('data-addr-item', '1');
                                row.addEventListener('mouseenter', () => {
                                    Array.from(popup.querySelectorAll('[data-addr-item]')).forEach(r => { r.style.backgroundColor = ''; r.style.color = ''; r.removeAttribute('data-selected'); });
                                    row.style.backgroundColor = '#0000aa'; row.style.color = '#ffffff'; row.setAttribute('data-selected', '1');
                                });
                                row.addEventListener('mouseleave', () => {
                                    if (row.getAttribute('data-selected') === '1') { row.style.backgroundColor = ''; row.style.color = ''; row.removeAttribute('data-selected'); }
                                });
                                row.addEventListener('click', () => {
                                    try {
                                        const desc = pred.description;
                                        const placeId = pred.placeId;
                                        this.setText(desc); this.text = desc;
                                        this._closeAddrPopup();
                                        try { if (this.element) this.element.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
                                        if (this._addrDebounce) { clearTimeout(this._addrDebounce); this._addrDebounce = null; }
                                        try { if (this.element) this.element.focus(); } catch (_) {}
                                        if (placeId) {
                                            _getPlaceDetails(placeId).then(fullAddr => {
                                                try {
                                                    if (!fullAddr || !this.element) return;
                                                    this.setText(fullAddr); this.text = fullAddr;
                                                    try { if (this.element) this.element.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
                                                    if (this._addrDebounce) { clearTimeout(this._addrDebounce); this._addrDebounce = null; }
                                                } catch (_) {}
                                            }).catch(() => {});
                                        }
                                    } catch (_) {}
                                });
                                popup.appendChild(row);
                            }
                            const rect = (containerRef || this.element || document.body).getBoundingClientRect();
                            popup.style.left = (rect.left + (window.pageXOffset || document.documentElement.scrollLeft)) + 'px';
                            popup.style.top = (rect.bottom + (window.pageYOffset || document.documentElement.scrollTop)) + 'px';
                            document.body.appendChild(popup);
                            this._addrPopup = popup; this._addrOpen = true;

                            this._addrKeyCapture = (ev) => {
                                try {
                                    if (!this._addrOpen) return;
                                    const k = ev.key;
                                    if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'Enter' && k !== 'Escape') return;
                                    ev.preventDefault(); ev.stopPropagation();
                                    const rows = Array.from(popup.querySelectorAll('[data-addr-item]'));
                                    if (!rows.length) return;
                                    let idx = rows.findIndex(r => r.getAttribute('data-selected') === '1');
                                    if (k === 'ArrowDown') {
                                        if (!this._addrNavActive) { this._addrTypedText = this.element ? this.element.value : ''; this._addrNavActive = true; }
                                        idx = (idx < rows.length - 1) ? idx + 1 : 0;
                                        rows.forEach(r => { r.style.backgroundColor = ''; r.style.color = ''; r.removeAttribute('data-selected'); });
                                        rows[idx].style.backgroundColor = '#0000aa'; rows[idx].style.color = '#ffffff'; rows[idx].setAttribute('data-selected', '1');
                                        try { if (this.element) this.element.value = rows[idx]._addrPred.description; } catch (_) {}
                                    } else if (k === 'ArrowUp') {
                                        if (!this._addrNavActive) { this._addrTypedText = this.element ? this.element.value : ''; this._addrNavActive = true; }
                                        idx = (idx > 0) ? idx - 1 : rows.length - 1;
                                        rows.forEach(r => { r.style.backgroundColor = ''; r.style.color = ''; r.removeAttribute('data-selected'); });
                                        rows[idx].style.backgroundColor = '#0000aa'; rows[idx].style.color = '#ffffff'; rows[idx].setAttribute('data-selected', '1');
                                        try { if (this.element) this.element.value = rows[idx]._addrPred.description; } catch (_) {}
                                    } else if (k === 'Enter') {
                                        const target = (idx >= 0 && rows[idx]) ? rows[idx] : (rows.length === 1 ? rows[0] : null);
                                        if (target) { this._addrNavActive = false; target.click(); }
                                    } else if (k === 'Escape') {
                                        if (this._addrNavActive && this.element) { this.element.value = this._addrTypedText || ''; }
                                        this._closeAddrPopup();
                                        try { if (this.element) this.element.focus(); } catch (_) {}
                                    }
                                } catch (_) {}
                            };
                            document.addEventListener('keydown', this._addrKeyCapture, true);

                            this._addrDocHandler = (ev) => {
                                try { if (!popup.contains(ev.target) && !(this.inputContainer && this.inputContainer.contains(ev.target))) this._closeAddrPopup(); } catch (_) {}
                            };
                            document.addEventListener('click', this._addrDocHandler);

                            this._addrScrollHandler = () => { try { this._closeAddrPopup(); } catch (_) {} };
                            window.addEventListener('scroll', this._addrScrollHandler, true);
                            window.addEventListener('resize', this._addrScrollHandler);
                        } catch (_) {}
                    };

                    this._addrInputHandler = () => {
                        try {
                            if (!this._addressEnabled) return;
                            if (this._addrNavActive) {
                                this._addrNavActive = false;
                                try { if (this._addrPopup) Array.from(this._addrPopup.querySelectorAll('[data-addr-item]')).forEach(r => { r.style.backgroundColor = ''; r.style.color = ''; r.removeAttribute('data-selected'); }); } catch (_) {}
                            }
                            const text = this.element ? this.element.value : '';
                            if (this._addrDebounce) { clearTimeout(this._addrDebounce); this._addrDebounce = null; }
                            if (!text || text.length < 3) { this._closeAddrPopup(); return; }
                            this._addrDebounce = setTimeout(async () => {
                                try {
                                    const preds = await _getAddressPredictions(text);
                                    if (this.element && this.element.value === text) this._openAddrPopup(preds);
                                } catch (e) { try { this._closeAddrPopup(); } catch (_) {} }
                            }, 300);
                        } catch (_) {}
                    };
                    this.element.addEventListener('input', this._addrInputHandler);
                }
            } catch (e) {}

            // Events
            this.element.addEventListener('input', (e) => {
                try {
                    if (this.isDate) return; // date mode is driven entirely by keydown
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

                    if (this.isDate) {
                        // Determine which date section was clicked based on cursor position
                        try {
                            const pos = this.element.selectionStart || 0;
                            if (pos <= 2) { this._dateSection = 0; }
                            else if (pos <= 5) { this._dateSection = 1; }
                            else { this._dateSection = 2; }
                            this._setDateSection && this._setDateSection(this._dateSection);
                        } catch (_) {}
                        try { e.stopPropagation(); } catch (_) {}
                    }

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
                if (this.isDate) { try { this._handleDateKeydown && this._handleDateKeydown(e); } catch (_) {} return; }
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
                    if (this.isDate) {
                        // On focus, validate date and position cursor at current section
                        try { this._updateDateDisplay && this._updateDateDisplay(); } catch (_) {}
                        try { setTimeout(() => { try { this._setDateSection && this._setDateSection(this._dateSection || 0); } catch(_){} }, 0); } catch (_) {}
                    }
                    // Open list on focus when in listMode — only if triggered by user interaction (click/tab), not programmatic focus
                    if (this.listMode && this._userInteracted) {
                        try { this._openList && this._openList(); } catch (_) {}
                    }
                } catch (_) {}
                // this.element.style.borderTop = '2px solid #000080';
                // this.element.style.borderLeft = '2px solid #000080';
            });

            // Track user interaction to distinguish programmatic focus from real clicks/tabs
            this.element.addEventListener('mousedown', () => { this._userInteracted = true; });
            this.element.addEventListener('keydown', () => { this._userInteracted = true; });

            this.element.addEventListener('blur', (e) => {
                this._userInteracted = false;
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

    // ======================== DATE MODE METHODS ========================

    _getDateDisplay() {
        const dd = (this._dd || '').padEnd(2, ' ');
        const mm = (this._mm || '').padEnd(2, ' ');
        const yyyy = (this._yyyy || '').padEnd(4, ' ');
        return dd + '.' + mm + '.' + yyyy;
    }

    _getDateISO() {
        if ((this._dd || '').length === 2 && (this._mm || '').length === 2 && (this._yyyy || '').length === 4) {
            const d = parseInt(this._dd, 10);
            const m = parseInt(this._mm, 10);
            const y = parseInt(this._yyyy, 10);
            if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 1000) {
                return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
            }
        }
        return null;
    }

    _setDateFromAny(val) {
        this._dd = ''; this._mm = ''; this._yyyy = '';
        if (!val && val !== 0) { if (this.element) this._updateDateDisplay(); return; }
        try {
            let d, m, y;
            if (val instanceof Date) {
                if (!isNaN(val.getTime())) { d = val.getDate(); m = val.getMonth() + 1; y = val.getFullYear(); }
            } else {
                const s = String(val).trim();
                const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
                if (iso) { y = parseInt(iso[1], 10); m = parseInt(iso[2], 10); d = parseInt(iso[3], 10); }
                else {
                    const dmy = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
                    if (dmy) { d = parseInt(dmy[1], 10); m = parseInt(dmy[2], 10); y = parseInt(dmy[3], 10); }
                }
            }
            if (d && m && y && d >= 1 && d <= 31 && m >= 1 && m <= 12) {
                this._dd = String(d).padStart(2, '0');
                this._mm = String(m).padStart(2, '0');
                this._yyyy = String(y);
            }
        } catch (_) {}
        if (this.element) this._updateDateDisplay();
    }

    _updateDateDisplay() {
        if (!this.element) return;
        const sec = this._dateSection || 0;
        const dd = (this._dd || '').padEnd(2, ' ');
        const mm = (this._mm || '').padEnd(2, ' ');
        const yyyy = (this._yyyy || '').padEnd(4, ' ');
        this.element.value = dd + '.' + mm + '.' + yyyy;
        this._setDateSection(sec);
        // Notify listeners so dirty-tracking / dataMap updates fire on every keystroke
        try { this.element.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
    }

    _setDateSection(n) {
        this._dateSection = n;
        if (!this.element) return;
        // Only reposition cursor if element is focused
        if (document.activeElement !== this.element) return;
        const starts = [0, 3, 6];
        const parts = [this._dd, this._mm, this._yyyy];
        const s = starts[n];
        const partLen = (parts[n] || '').length;
        const pos = s + partLen;
        try { this.element.setSelectionRange(pos, pos); } catch (_) {}
    }

    _handleDateKeydown(e) {
        const k = e.key;
        // Allow standard shortcuts (copy/paste/select all)
        if (e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        const sectionMaxLen = [2, 2, 4];
        const getPart = (n) => (n === 0 ? this._dd : (n === 1 ? this._mm : this._yyyy));
        const setPart = (n, v) => { if (n === 0) this._dd = v; else if (n === 1) this._mm = v; else this._yyyy = v; };
        const sec = this._dateSection;

        if (/^\d$/.test(k)) {
            const cur = getPart(sec);
            if (cur.length < sectionMaxLen[sec]) {
                const next = cur + k;
                setPart(sec, next);
                // Auto-advance to next section once section is full
                if (next.length === sectionMaxLen[sec]) {
                    // Validate range before advancing
                    if (sec === 1) {
                        const mv = parseInt(next, 10);
                        if (mv < 1 || mv > 12) { setPart(1, ''); this._updateDateDisplay(); return; }
                    }
                    if (sec < 2) { this._dateSection = sec + 1; }
                }
            }
            this._updateDateDisplay();
        } else if (k === 'Backspace' || k === 'Delete') {
            const cur = getPart(sec);
            if (cur.length > 0) {
                setPart(sec, cur.slice(0, -1));
                this._updateDateDisplay();
            } else if (sec > 0) {
                this._dateSection = sec - 1;
                this._updateDateDisplay();
            }
        } else if (k === 'ArrowLeft') {
            if (sec > 0) { this._dateSection = sec - 1; this._updateDateDisplay(); }
        } else if (k === 'ArrowRight' || k === '.') {
            if (sec < 2) { this._dateSection = sec + 1; this._updateDateDisplay(); }
        } else if (k === 'Tab') {
            if (!e.shiftKey) {
                if (sec < 2) { this._dateSection = sec + 1; this._updateDateDisplay(); }
                else {
                    // Allow Tab to propagate to next field
                    e.preventDefault = () => {}; // already prevented above — need to re-allow
                    // Re-dispatch as a real tab press
                    try {
                        const next = this._findNextFocusable(true);
                        if (next) next.focus();
                    } catch (_) {}
                }
            } else {
                if (sec > 0) { this._dateSection = sec - 1; this._updateDateDisplay(); }
                else {
                    try {
                        const prev = this._findNextFocusable(false);
                        if (prev) prev.focus();
                    } catch (_) {}
                }
            }
        } else if (k === 'Escape') {
            if (this._calOpen) {
                this._closeCalendar();
            } else {
                this._dd = ''; this._mm = ''; this._yyyy = '';
                this._dateSection = 0;
                this._updateDateDisplay();
            }
        } else if (k === 'Enter') {
            if (this._calOpen) {
                this._closeCalendar();
            } else {
                // Fire input event so dirty-tracking picks up the value
                try { if (this.element) this.element.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
            }
        } else if (k === 'F4') {
            this._toggleCalendar && this._toggleCalendar();
        }
        // Ignore all other keys (letters, symbols etc.)
    }

    _findNextFocusable(forward) {
        try {
            const focusable = Array.from(document.querySelectorAll(
                'input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
            )).filter(el => !el.closest('[style*="display: none"]') && !el.closest('[hidden]'));
            const idx = focusable.indexOf(this.element);
            if (idx === -1) return null;
            return forward ? focusable[idx + 1] : focusable[idx - 1];
        } catch (_) { return null; }
    }

    _toggleCalendar() {
        if (this._calOpen) this._closeCalendar();
        else this._openCalendar();
    }

    _openCalendar() {
        if (this._calOpen) return;
        const today = new Date();
        let year = today.getFullYear(), month = today.getMonth() + 1;
        if (this._yyyy) { const y = parseInt(this._yyyy, 10); if (y >= 1000) year = y; }
        if (this._mm) { const m = parseInt(this._mm, 10); if (m >= 1 && m <= 12) month = m; }
        this._calYear = year;
        this._calMonth = month;
        const popup = this._buildCalendarPopup(year, month);
        const anchor = this.containerElement || (this.element && this.element.closest('.ui-input-container')) || this.inputContainer;
        const rect = anchor ? anchor.getBoundingClientRect() : { left: 0, bottom: 20 };
        popup.style.left = (rect.left + (window.pageXOffset || document.documentElement.scrollLeft || 0)) + 'px';
        popup.style.top = (rect.bottom + (window.pageYOffset || document.documentElement.scrollTop || 0)) + 'px';
        document.body.appendChild(popup);
        this._calPopup = popup;
        this._calOpen = true;
        this._calDocHandler = (ev) => {
            try {
                if (!popup.contains(ev.target) && this._dateBtn && !this._dateBtn.contains(ev.target)) {
                    this._closeCalendar();
                }
            } catch (_) {}
        };
        document.addEventListener('click', this._calDocHandler);
        // Global keyboard capture: while calendar is open, eat ALL keydown events
        // so the underlying form (and its Escape/Enter handlers) cannot react.
        this._calKeyCapture = (ev) => {
            try {
                ev.stopPropagation();
                ev.stopImmediatePropagation();
                // Route the key to our date handler so Enter/Escape still work
                try { this._handleDateKeydown && this._handleDateKeydown(ev); } catch (_) {}
            } catch (_) {}
        };
        document.addEventListener('keydown', this._calKeyCapture, true);
    }

    _closeCalendar() {
        if (this._calPopup) {
            try { this._calPopup.remove(); } catch (_) { try { document.body.removeChild(this._calPopup); } catch (_) {} }
            this._calPopup = null;
        }
        this._calOpen = false;
        if (this._calDocHandler) {
            try { document.removeEventListener('click', this._calDocHandler); } catch (_) {}
            this._calDocHandler = null;
        }
        if (this._calKeyCapture) {
            try { document.removeEventListener('keydown', this._calKeyCapture, true); } catch (_) {}
            this._calKeyCapture = null;
        }
    }

    _navigateCalendar(dy, dm) {
        this._calMonth = (this._calMonth || 1) + dm;
        this._calYear = (this._calYear || new Date().getFullYear()) + dy;
        if (this._calMonth > 12) { this._calMonth -= 12; this._calYear++; }
        if (this._calMonth < 1) { this._calMonth += 12; this._calYear--; }
        if (!this._calOpen) return;
        const anchor = this.containerElement || this.inputContainer;
        const rect = anchor ? anchor.getBoundingClientRect() : { left: 0, bottom: 20 };
        if (this._calPopup) { try { this._calPopup.remove(); } catch (_) {} }
        // remove old listeners before re-attaching
        if (this._calDocHandler) { try { document.removeEventListener('click', this._calDocHandler); } catch (_) {} this._calDocHandler = null; }
        if (this._calKeyCapture) { try { document.removeEventListener('keydown', this._calKeyCapture, true); } catch (_) {} this._calKeyCapture = null; }
        const newPopup = this._buildCalendarPopup(this._calYear, this._calMonth);
        newPopup.style.left = (rect.left + (window.pageXOffset || document.documentElement.scrollLeft || 0)) + 'px';
        newPopup.style.top = (rect.bottom + (window.pageYOffset || document.documentElement.scrollTop || 0)) + 'px';
        document.body.appendChild(newPopup);
        this._calPopup = newPopup;
        if (this._calDocHandler) document.removeEventListener('click', this._calDocHandler);
        this._calDocHandler = (ev) => {
            try {
                if (!newPopup.contains(ev.target) && this._dateBtn && !this._dateBtn.contains(ev.target)) {
                    this._closeCalendar();
                }
            } catch (_) {}
        };
        document.addEventListener('click', this._calDocHandler);
        // Re-attach keyboard capture for the new popup
        this._calKeyCapture = (ev) => {
            try {
                ev.stopPropagation();
                ev.stopImmediatePropagation();
                try { this._handleDateKeydown && this._handleDateKeydown(ev); } catch (_) {}
            } catch (_) {}
        };
        document.addEventListener('keydown', this._calKeyCapture, true);
    }

    _buildCalendarPopup(year, month) {
        const base = UIObject.getClientConfigValue('defaultColor', '#c0c0c0');
        const light = UIObject.brightenColor(base, 60);
        const dark = UIObject.brightenColor(base, -60);

        const popup = document.createElement('div');
        popup.style.cssText = 'position:absolute;z-index:99999;background:' + base + ';box-sizing:border-box;padding:2px;' +
            'font-family:MS Sans Serif,sans-serif;font-size:11px;' +
            'border-top:2px solid ' + light + ';border-left:2px solid ' + light + ';' +
            'border-right:2px solid ' + dark + ';border-bottom:2px solid ' + dark + ';' +
            'box-shadow:2px 2px 4px rgba(0,0,0,0.4);user-select:none;width:190px;';

        // Header: prev / month+year title / next
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;' +
            'background:#000080;color:#ffffff;padding:2px 4px;margin-bottom:2px;';

        const mkNavBtn = (label) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.style.cssText = 'background:' + base + ';color:#000;border-top:2px solid ' + light + ';border-left:2px solid ' + light + ';' +
                'border-right:2px solid ' + dark + ';border-bottom:2px solid ' + dark + ';' +
                'cursor:default;padding:0 5px;font-size:10px;font-family:MS Sans Serif,sans-serif;line-height:1.2;min-width:18px;';
            return b;
        };

        const btnPrev = mkNavBtn('◄');
        btnPrev.addEventListener('click', (e) => { e.stopPropagation(); this._navigateCalendar(0, -1); });

        const MONTHS_RU = [__t('January'),__t('February'),__t('March'),__t('April'),__t('May'),__t('June'),__t('July'),__t('August'),__t('September'),__t('October'),__t('November'),__t('December')];
        const titleEl = document.createElement('span');
        titleEl.style.cssText = 'font-weight:bold;cursor:default;font-family:MS Sans Serif,sans-serif;font-size:11px;user-select:none;';
        titleEl.textContent = MONTHS_RU[month - 1] + ' ' + year;
        // Click on month name — cycle through year by +/- 1 year with double click on arrows
        // (simple single-click navigation is enough for now)

        const btnNext = mkNavBtn('►');
        btnNext.addEventListener('click', (e) => { e.stopPropagation(); this._navigateCalendar(0, 1); });

        header.appendChild(btnPrev);
        header.appendChild(titleEl);
        header.appendChild(btnNext);
        popup.appendChild(header);

        // Calendar grid
        const table = document.createElement('table');
        table.style.cssText = 'border-collapse:collapse;width:100%;table-layout:fixed;';

        // Day-of-week headers (Mon…Sun)
        const DAYS_SHORT = [__t('Mo'),__t('Tu'),__t('We'),__t('Th'),__t('Fr'),__t('Sa'),__t('Su')];
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (let i = 0; i < 7; i++) {
            const th = document.createElement('th');
            th.textContent = DAYS_SHORT[i];
            th.style.cssText = 'text-align:center;padding:1px 2px;font-weight:bold;font-size:10px;width:20px;' + (i >= 5 ? 'color:#800000;' : '');
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        // Compute first weekday of month (Mon-based: 0=Mon, 6=Sun)
        const firstDayJS = new Date(year, month - 1, 1).getDay(); // 0=Sun
        const startOffset = (firstDayJS + 6) % 7; // convert to Mon-start
        const daysInMonth = new Date(year, month, 0).getDate();
        const daysInPrev = new Date(year, month - 1, 0).getDate();

        const today = new Date();
        const todayY = today.getFullYear(), todayM = today.getMonth() + 1, todayD = today.getDate();
        const selD = this._dd ? parseInt(this._dd, 10) : -1;
        const selM = this._mm ? parseInt(this._mm, 10) : -1;
        const selY = this._yyyy ? parseInt(this._yyyy, 10) : -1;

        const tbody = document.createElement('tbody');
        let dayNum = 1, nextDay = 1;

        for (let row = 0; row < 6; row++) {
            const tr = document.createElement('tr');
            let rowHasCurMonth = false;

            for (let col = 0; col < 7; col++) {
                const cellIdx = row * 7 + col;
                const td = document.createElement('td');
                td.style.cssText = 'text-align:center;padding:2px;cursor:default;width:20px;height:18px;box-sizing:border-box;';

                let dayVal, isOtherMonth = false;
                if (cellIdx < startOffset) {
                    dayVal = daysInPrev - startOffset + cellIdx + 1;
                    isOtherMonth = true;
                } else if (dayNum > daysInMonth) {
                    dayVal = nextDay++;
                    isOtherMonth = true;
                } else {
                    dayVal = dayNum++;
                    rowHasCurMonth = true;
                }

                const isWeekend = (col >= 5);
                if (isOtherMonth) {
                    td.style.color = '#a0a0a0';
                } else if (isWeekend) {
                    td.style.color = '#800000';
                }

                // Highlight today
                const isToday = (!isOtherMonth && dayVal === todayD && month === todayM && year === todayY);
                if (isToday) { td.style.border = '1px dotted #000080'; }

                // Highlight selected date
                const isSel = (!isOtherMonth && dayVal === selD && month === selM && year === selY);
                if (isSel) {
                    td.style.backgroundColor = '#000080';
                    td.style.color = '#ffffff';
                    td.style.border = '';
                }

                td.textContent = String(dayVal);

                if (!isOtherMonth) {
                    const _day = dayVal, _month = month, _year = year;
                    td.addEventListener('mouseenter', () => { if (!isSel) td.style.backgroundColor = base; });
                    td.addEventListener('mouseleave', () => { if (!isSel) td.style.backgroundColor = ''; });
                    td.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this._dd = String(_day).padStart(2, '0');
                        this._mm = String(_month).padStart(2, '0');
                        this._yyyy = String(_year);
                        this._updateDateDisplay();
                        try { if (this.element) this.element.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
                        this._closeCalendar();
                        try { if (this.element) this.element.focus(); } catch (_) {}
                    });
                } else {
                    // Click on prev/next month days — navigate and then select
                    const _day = dayVal;
                    const _offset = (cellIdx < startOffset) ? -1 : 1;
                    td.style.cursor = 'pointer';
                    td.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this._navigateCalendar(0, _offset);
                    });
                }

                tr.appendChild(td);
            }

            tbody.appendChild(tr);
            if (!rowHasCurMonth && row >= 4) break; // Stop rendering empty extra rows
        }

        table.appendChild(tbody);
        popup.appendChild(table);

        // Footer: "Сегодня" button
        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;justify-content:center;padding:2px 0 0;';
        const btnToday = document.createElement('button');
        btnToday.type = 'button';
        btnToday.textContent = __t('Today');
        btnToday.style.cssText = 'background:' + base + ';border-top:2px solid ' + light + ';border-left:2px solid ' + light + ';' +
            'border-right:2px solid ' + dark + ';border-bottom:2px solid ' + dark + ';' +
            'cursor:default;padding:1px 10px;font-size:11px;font-family:MS Sans Serif,sans-serif;';
        btnToday.addEventListener('click', (e) => {
            e.stopPropagation();
            this._dd = String(todayD).padStart(2, '0');
            this._mm = String(todayM).padStart(2, '0');
            this._yyyy = String(todayY);
            this._updateDateDisplay();
            try { if (this.element) this.element.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
            this._closeCalendar();
            try { if (this.element) this.element.focus(); } catch (_) {}
        });
        footer.appendChild(btnToday);
        popup.appendChild(footer);

        return popup;
    }

    // ======================== END DATE MODE METHODS ========================

    onSelectionStart() {
        // Open uniListForm chooser directly and forward selection to `handleSelection`.
        try {
            const selMeta = this.selection || {};
            const table = selMeta.table || null;

            const setSelected = (rec) => {
                try {
                    const displayField = selMeta.displayField || 'name';
                    const display = (rec && (rec[displayField] !== undefined)) ? rec[displayField] : (rec && rec.name) || (rec && rec.UID) || '';
                    try { if (typeof this.setText === 'function') this.setText(String(display)); } catch (_) { try { if (this.element) this.element.value = display; } catch(_){} }
                    try { if (this.element) this.element.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
                } catch (e) {}
            };

            if (typeof window !== 'undefined' && window.MySpace && typeof window.MySpace.open === 'function') {
                (async () => {
                    try {
                        // pass callback in params and wire instance to call it
                        const cb = this.handleSelection.bind(this);
                        const textBoxId = this.element ? this.element.id : 'unknown';
                        console.log('[TextBox.onSelectionStart] Creating callback for TextBox:', textBoxId);
                        const id = await window.MySpace.open('uniForm', { mode: 'list', dbTable: table, onSelectCallBack: cb, selectMode: true, readOnly: true });
                        console.log('[TextBox.onSelectionStart] Opened uniForm instance:', id, 'for TextBox:', textBoxId);
                        const inst = (window.MySpace && typeof window.MySpace.getInstance === 'function') ? window.MySpace.getInstance(id) : null;
                    } catch (e) { console.error('[TextBox.onSelectionStart] ERROR opening uniForm for table:', table, e); }
                })();
                return;
            }

            // Fallback to simple prompt when framework not available
            try {
                const input = prompt(__t('Enter search text') + ' (' + (table || __t('table')) + ')');
                if (input !== null) setSelected({ id: input, [selMeta.displayField || 'name']: input });
            } catch (e) {}
        } catch (e) {
            try {
                const input = prompt(__t('Enter search text'));
                if (input !== null) {
                    try { if (typeof this.setText === 'function') this.setText(String(input)); } catch (_) { try { if (this.element) this.element.value = input; } catch(_){} }
                    try { if (this.element) this.element.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
                }
            } catch (_) {}
        }
    }

    // Selection handler ("Обработка выбора") — default implementation: apply selection to the field
    handleSelection(selectedRecord, uniFormInstance) {
        try {
            const textBoxId = this.element ? this.element.id : 'unknown';
            console.log('[TextBox.handleSelection] Called for TextBox:', textBoxId, 'with record:', selectedRecord);
            const selMeta = this.selection || {};
            const displayField = selMeta.displayField || 'name';
            const display = (selectedRecord && (selectedRecord[displayField] !== undefined)) ? selectedRecord[displayField] : (selectedRecord && (selectedRecord.name || selectedRecord.UID)) || '';

            try {
                // If it's a selection, prioritize storing the UID
                const val = (selectedRecord && selectedRecord.UID !== undefined) ? selectedRecord.UID : selectedRecord;
                if (typeof this.setValue === 'function') this.setValue(val, display);
                else {
                    if (typeof this.setText === 'function') this.setText(String(display));
                    else if (this.element) this.element.value = String(display);
                }
                console.log('[TextBox.handleSelection] Updated TextBox:', textBoxId, 'with value:', display, 'UID:', val);
            } catch (_) {}

            try { if (this.element) this.element.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}

            // Close/destroy chooser instance if provided
            try {
                if (uniFormInstance && typeof uniFormInstance.destroy === 'function') uniFormInstance.destroy();
                else if (typeof window !== 'undefined' && window.MySpace && uniFormInstance && uniFormInstance.id && typeof window.MySpace.close === 'function') window.MySpace.close(uniFormInstance.id);
            } catch (_) {}
        } catch (e) {}
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

            // Render children if any
            if (this.children && this.children.length > 0) {
                this.children.forEach(child => {
                    if (child && typeof child.Draw === 'function') {
                        child.Draw(this.element);
                    }
                });
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
                if (this.readOnly) return;
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
        super(__t('Alert'), 300, 150);
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
        btnOk.setCaption(__t('OK'));
        btnOk.Draw(this.contentArea);
        btnOk.onClick = () => {
            this.close();
            try { if (typeof this.onOk === 'function') this.onOk(); } catch (e) { console.error('AlertForm onOk callback error', e); }
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

class ConfirmForm extends ModalForm {
    constructor(message, onOk, onCancel) {
        super(__t('Confirm'), 400, 180);
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
        btnOk.setCaption(__t('Yes'));
        btnOk.Draw(this.contentArea);
        btnOk.onClick = () => {
            this.close();
            if (this.onOk) this.onOk();
        };

        const btnCancel = new Button(this.contentArea);
        btnCancel.setCaption(__t('No'));
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
                        sbtn.dataset.role = 'selection';
                        // Apply CSS class for static styling; colors provided globally by client config
                        try { sbtn.classList.add('input-field-button'); } catch (e) {}
                        // Colors are provided globally by client config
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

    setValue(value) {
        this.setChecked(value);
    }

    getValue() {
        return this.getChecked();
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
            checkbox._uiObject = this;
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
            this.inputContainer.style.alignItems = 'stretch';
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
                        if (e.__checkboxHandled) return;
                        const native = this.element.querySelector('input[type="checkbox"]');
                        if (this.readOnly || (native && native.disabled)) return;
                        if (!native) return;
                        // If clicked directly on the native checkbox or its label area, let the native event handle it
                        if (e.target === native || (this.element && this.element.contains(e.target))) return;
                        // Toggle native checkbox and fire change event so listeners update state
                        native.checked = !native.checked;
                        const ev = new Event('change', { bubbles: true });
                        native.dispatchEvent(ev);
                        e.__checkboxHandled = true;
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
                            if (ev.__checkboxHandled) return;
                            if (ev.target === nativeCb || nativeCb.contains(ev.target) || (this.element && this.element.contains(ev.target))) return;
                            if (this.readOnly || nativeCb.disabled) return;
                            nativeCb.checked = !nativeCb.checked;
                            nativeCb.dispatchEvent(new Event('change', { bubbles: true }));
                            ev.__checkboxHandled = true;
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
        calendar.setTitle(__t('Date selection'));
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
            const monthNames = [__t('January'), __t('February'), __t('March'), __t('April'), __t('May'), __t('June'),
                __t('July'), __t('August'), __t('September'), __t('October'), __t('November'), __t('December')];
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
            todayBtn.setCaption(__t('Today'));
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
        // Index of currently active (selected) row for highlighting
        this._activeRowIndex = -1;
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
        // Editing mode: 'row-activate' (default) or 'cell-immediate'
        this.editMode = properties.editMode || 'row-activate';
        // Internal handlers and state for managing row/cell activation
        this._docClickHandler = null;
        this._docKeyHandler = null;

        this.showToolbar = (properties.showToolbar !== false);
        this.hiddenButtons = Array.isArray(properties.hiddenButtons) ? properties.hiddenButtons : [];
        this.tableName = properties.tableName || '';
        // Признак табличной части — выставляется автоматически в Draw() из _dataMap
        this.isTabularSection = false;
        this.currentFilters = [];
    }

    // Обрабатывает действие тулбара внутри таблицы.
    // Возвращает true если действие обработано (tabular section); false — передать в appForm.
    doToolbarAction(action) {
        if (action === 'recordAdd' && this.isTabularSection) {
            // Запрашиваем UID с сервера, затем добавляем строку
            const self = this;
            const doAdd = async () => {
                const rows = self.data_getRows(self.dataKey);
                const newRow = {};
                if (Array.isArray(self.columns)) {
                    for (const col of self.columns) { if (col.data) newRow[col.data] = ''; }
                }
                // Получаем UID с сервера — используем тот же алгоритм что и dbGateway
                try {
                    const tableName = self.tableName || self.dataKey || 'row';
                    if (typeof callServerMethod === 'function') {
                        const resp = await callServerMethod('drive_api', 'getNewUID', { tableName });
                        if (resp && resp.uid) newRow.UID = resp.uid;
                    }
                } catch (_) {}
                // Пред-заполняем скрытыми клиентскими фильтрами (напр. bookingRoomId при мастер-деталь)
                try {
                    if (Array.isArray(self.currentFilters)) {
                        for (const f of self.currentFilters) {
                            if (f.enabled !== false && f.type === 'client' && f.visibility === 'hidden' && f.field && f.value != null && f.value !== '') {
                                newRow[f.field] = f.value;
                            }
                        }
                    }
                } catch (_) {}
                rows.push(newRow);
                self.data_updateValue(self.dataKey, rows);
                try { if (typeof self._invokeRenderBodyRows === 'function') self._invokeRenderBodyRows(); } catch (_) {}
                try { if (typeof self.activateRow === 'function') self.activateRow(rows.length - 1); } catch (_) {}
                try { if (self.appForm && typeof self.appForm.setModified === 'function') self.appForm.setModified(true); } catch (_) {}
            };
            doAdd();
            return true;
        }
        if (action === 'recordDelete' && this.isTabularSection) {
            const activeIdx = this._activeRowIndex;
            if (activeIdx < 0) return true;
            const rows = this.data_getRows(this.dataKey);
            if (Array.isArray(rows) && activeIdx < rows.length) {
                rows.splice(activeIdx, 1);
                this._activeRowIndex = -1;
                this.data_updateValue(this.dataKey, rows);
                try { if (typeof this._invokeRenderBodyRows === 'function') this._invokeRenderBodyRows(); } catch (_) {}
                try { if (this.appForm && typeof this.appForm.setModified === 'function') this.appForm.setModified(true); } catch (_) {}
            }
            return true;
        }
        return false;
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

    data_updateParentArray(dataKey, rowIndex, colDef, newVal, displayVal) {
        try {
            if (dataKey && this.appForm && this.appForm._dataMap && this.appForm._dataMap[dataKey] && Array.isArray(this.appForm._dataMap[dataKey].value)) {
                const parentArr = this.appForm._dataMap[dataKey].value;
                if (!parentArr[rowIndex]) parentArr[rowIndex] = {};
                if (colDef && colDef.data) {
                    parentArr[rowIndex][colDef.data] = newVal;
                    // Persist FK display value so it survives re-renders (e.g. masterFor row switch)
                    const dispKey = '__' + colDef.data + '_display';
                    if (displayVal !== undefined && displayVal !== null) {
                        parentArr[rowIndex][dispKey] = displayVal;
                    }
                }
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
            
            const titleSpan = document.createElement('span');
            titleSpan.className = 'th-title';
            const fld = col.data || i;
            const curSort = (this.currentSort || []).find(s => s.field === fld);
            const _colCap0 = (col.caption && typeof col.caption === 'object' && col.caption.i18n)
                ? (typeof __t === 'function' ? __t(col.caption.i18n) : col.caption.i18n)
                : (col.caption || '');
            titleSpan.textContent = _colCap0 + (curSort ? (curSort.order === 'asc' ? ' ▲' : ' ▼') : '');
            th.appendChild(titleSpan);

            th.addEventListener('mousedown', () => {
                this._resizeOccurred = false;
            });

            th.addEventListener('click', (e) => {
                try { console.log('[DynamicTable] header click', col && col.data ? col.data : i, 'isResizing=', this.resizeState && this.resizeState.isResizing); } catch (e) {}
                if (this.resizeState.isResizing || this._resizeOccurred) {
                    this._resizeOccurred = false;
                    return;
                }
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
                    
                    const span = thk.querySelector('.th-title');
                    if (span) {
                        const _colCapK = (colk.caption && typeof colk.caption === 'object' && colk.caption.i18n)
                            ? (typeof __t === 'function' ? __t(colk.caption.i18n) : colk.caption.i18n)
                            : (colk.caption || '');
                        span.textContent = _colCapK;
                        if (si) span.textContent += si.order === 'asc' ? ' ▲' : ' ▼';
                    }
                }
                
                if (typeof this.refresh === 'function') {
                    this.refresh();
                } else {
                    try { if (typeof this._invokeRenderBodyRows === 'function') this._invokeRenderBodyRows(); } catch (e) {}
                }
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
                    
                    const bcolgroup = getBcolgroup();
                    const bodyTable = (bcolgroup && bcolgroup.parentElement && bcolgroup.parentElement.tagName.toLowerCase() === 'table') ? bcolgroup.parentElement : null;
                    
                    // Capture actual widths of ALL columns from the header cells (th)
                    // and freeze them in pixels to prevent the browser from redistributing space.
                    const headerThs = Array.from(htr.children);
                    const startWidths = headerThs.map(th => th.offsetWidth);
                    
                    for (let k = 0; k < hcolgroup.children.length; k++) {
                        const colW = startWidths[k] + 'px';
                        if (hcolgroup.children[k]) hcolgroup.children[k].style.width = colW;
                        if (bcolgroup && bcolgroup.children[k]) bcolgroup.children[k].style.width = colW;
                    }

                    // Set explicit pixel widths for both tables based on their current actual size
                    const startTableWidth = headerTable.offsetWidth;
                    headerTable.style.width = startTableWidth + 'px';
                    if (bodyTable) bodyTable.style.width = bodyTable.offsetWidth + 'px';

                    const startW = startWidths[index];
                    self.resizeState.startWidth = startW;

                    const onMove = (me) => {
                        const dx = me.clientX - self.resizeState.startX;
                        if (Math.abs(dx) > 2) self._resizeOccurred = true;
                        
                        const newW = Math.max(30, startW + dx);
                        const actualDelta = newW - startW;
                        
                        const newTableWidthPixels = (startTableWidth + actualDelta) + 'px';

                        try { 
                            if (hcolgroup.children[index]) hcolgroup.children[index].style.width = newW + 'px'; 
                            headerTable.style.width = newTableWidthPixels;
                            
                            if (bcolgroup && bcolgroup.children[index]) bcolgroup.children[index].style.width = newW + 'px';
                            if (bodyTable) bodyTable.style.width = newTableWidthPixels;
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

    // ===================== FILTER API =====================

    /**
     * Установить / обновить один фильтр.
     * @param {string} field      - Поле модели
     * @param {*}      value      - Значение
     * @param {Object} [options]
     * @param {string} [options.operator='=']         - '='|'!='|'>'|'>='|'<'|'<='|'contains'|'isNull'|'isNotNull'
     * @param {string} [options.type='server']        - 'server'|'client'
     * @param {string} [options.visibility='visible'] - 'visible'|'readonly'|'hidden'
     * @param {string} [options.caption]              - Заголовок для UI
     * @param {boolean} [options.enabled=true]        - Включён ли фильтр
     */
    setFilter(field, value, options = {}) {
        if (!Array.isArray(this.currentFilters)) this.currentFilters = [];
        const idx = this.currentFilters.findIndex(f => f.field === field);
        const entry = {
            field,
            caption:    options.caption    || field,
            operator:   options.operator   || '=',
            value,
            type:       options.type       || 'server',
            visibility: options.visibility || 'visible',
            enabled:    options.enabled !== false
        };
        if (idx >= 0) this.currentFilters[idx] = entry;
        else this.currentFilters.push(entry);
        this._updateFilterBar();
        this.applyFilters();
    }

    /** Убрать фильтр по полю. */
    removeFilter(field) {
        if (!Array.isArray(this.currentFilters)) return;
        this.currentFilters = this.currentFilters.filter(f => f.field !== field);
        this._updateFilterBar();
        this.applyFilters();
    }

    /** Получить объект фильтра по полю (или undefined). */
    getFilter(field) {
        if (!Array.isArray(this.currentFilters)) return undefined;
        return this.currentFilters.find(f => f.field === field);
    }

    /** Все фильтры (копия массива). */
    getFilters() {
        return Array.isArray(this.currentFilters) ? this.currentFilters.slice() : [];
    }

    /** Заменить весь набор фильтров. */
    setFilters(filters) {
        this.currentFilters = Array.isArray(filters) ? filters.slice() : [];
        this._updateFilterBar();
        this.applyFilters();
    }

    /** Очистить все фильтры. */
    clearFilters() {
        this.currentFilters = [];
        this._updateFilterBar();
        this.applyFilters();
    }

    /**
     * Применить текущие фильтры. Базовая реализация для Table: перерисовать строки.
     * DynamicTable переопределяет этот метод для серверной перезагрузки.
     */
    applyFilters() {
        try { if (typeof this._invokeRenderBodyRows === 'function') this._invokeRenderBodyRows(); } catch (e) {}
    }

    /**
     * Применить client-фильтры к строке.
     * Возвращает true если строку нужно показать.
     */
    _matchClientFilters(row) {
        if (!Array.isArray(this.currentFilters)) return true;
        const clientFilters = this.currentFilters.filter(f => f.enabled !== false && f.type === 'client');
        if (clientFilters.length === 0) return true;
        for (const f of clientFilters) {
            const raw = row[f.field];
            // Скрытые фильтры (masterFor) работают по сырому значению (FK-UID),
            // а не по display-значению — иначе UID сравнивался бы с именем записи.
            const dispKey = '__' + f.field + '_display';
            const dispVal = (f.visibility !== 'hidden') ? row[dispKey] : undefined;
            const val = (dispVal !== undefined) ? dispVal : raw;
            const strVal = (val === null || val === undefined) ? '' : String(val).toLowerCase();
            const fVal = (f.value === null || f.value === undefined) ? '' : String(f.value).toLowerCase();
            switch (f.operator) {
                case '=':         if (strVal !== fVal) return false; break;
                case '!=':        if (strVal === fVal) return false; break;
                case 'contains':  if (!strVal.includes(fVal)) return false; break;
                case 'startsWith':if (!strVal.startsWith(fVal)) return false; break;
                case 'endsWith':  if (!strVal.endsWith(fVal)) return false; break;
                case '>':         if (!(parseFloat(val) >  parseFloat(f.value))) return false; break;
                case '>=':        if (!(parseFloat(val) >= parseFloat(f.value))) return false; break;
                case '<':         if (!(parseFloat(val) <  parseFloat(f.value))) return false; break;
                case '<=':        if (!(parseFloat(val) <= parseFloat(f.value))) return false; break;
                case 'isNull':    if (raw !== null && raw !== undefined && raw !== '') return false; break;
                case 'isNotNull': if (raw === null || raw === undefined || raw === '') return false; break;
                default: break;
            }
        }
        return true;
    }

    // ===================== END FILTER API =====================

    // Inline-редактор значения фильтра в filter bar (маленький popup).
    _openFilterInlineEditor(filter, chipEl) {
        // Убираем старый popup если был
        try { const old = document.getElementById('__filter-inline-popup'); if (old) old.remove(); } catch (e) {}

        const popup = document.createElement('div');
        popup.id = '__filter-inline-popup';
        popup.style.position = 'absolute';
        popup.style.zIndex   = '99999';
        popup.style.background = '#c0c0c0';
        popup.style.border = '2px solid #000';
        popup.style.padding = '6px 8px';
        popup.style.display = 'flex';
        popup.style.gap = '4px';
        popup.style.alignItems = 'center';
        popup.style.boxShadow = '2px 2px 0 #000';

        const input = document.createElement('input');
        input.type = 'text';
        input.value = (filter.value !== null && filter.value !== undefined) ? String(filter.value) : '';
        input.style.width = '140px';
        input.style.fontFamily = 'inherit';
        input.style.fontSize = 'inherit';

        const ok = document.createElement('button');
        ok.textContent = __t('OK');
        ok.style.fontFamily = 'inherit';
        ok.style.fontSize = 'inherit';

        const cancel = document.createElement('button');
        cancel.textContent = '✕';
        cancel.style.fontFamily = 'inherit';
        cancel.style.fontSize = 'inherit';

        popup.appendChild(input);
        popup.appendChild(ok);
        popup.appendChild(cancel);
        document.body.appendChild(popup);

        // Позиционируем под чипом
        try {
            const rect = chipEl.getBoundingClientRect();
            popup.style.top  = (rect.bottom + window.scrollY + 2) + 'px';
            popup.style.left = (rect.left  + window.scrollX)      + 'px';
        } catch (e) {}

        const commit = () => {
            filter.value = input.value;
            filter.enabled = true;
            popup.remove();
            this._updateFilterBar();
            this.applyFilters();
        };
        ok.addEventListener('click', commit);
        cancel.addEventListener('click', () => popup.remove());
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter')  { ev.preventDefault(); commit(); }
            if (ev.key === 'Escape') { ev.preventDefault(); popup.remove(); }
        });

        // Закрыть при клике вне
        const away = (ev) => {
            if (!popup.contains(ev.target) && ev.target !== chipEl && !chipEl.contains(ev.target)) {
                popup.remove();
                document.removeEventListener('mousedown', away, true);
            }
        };
        // небольшая задержка чтобы текущий mousedown не закрыл немедленно
        setTimeout(() => document.addEventListener('mousedown', away, true), 0);

        input.focus();
        input.select();
    }

    // Заглушка-stub для _updateFilterBar: будет переопределена в Draw()
    // чтобы код вне Draw (API фильтров) не падал до первой отрисовки.
    _updateFilterBar() {}

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
        // Propagate column-level readOnly into cellItem.properties and mark container
        if (col.readOnly) { cellItem.properties.readOnly = true; cellContainer.dataset.colReadonly = '1'; }
        cellItem.value = this.data_getValue(cellKey, (row && row[col.data]));
        // Map inputType → type so renderItem picks up the right control
        if (!cellItem.type && cellItem.inputType) cellItem.type = cellItem.inputType;

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

        // Поддержка шаблона {field} в selection.table — позволяет указывать таблицу-источник
        // динамически по значению другого поля строки, например: selection: { table: '{tableName}' }
        // Геттер читает актуальное значение из объекта строки в момент нажатия кнопки "..."
        try {
            if (cellItem.properties && cellItem.properties.selection &&
                    typeof cellItem.properties.selection.table === 'string' &&
                    cellItem.properties.selection.table.includes('{')) {
                const tmpl = cellItem.properties.selection.table;
                const rowRef = row;
                const dynSel = Object.assign({}, cellItem.properties.selection);
                Object.defineProperty(dynSel, 'table', {
                    get() {
                        return tmpl.replace(/\{([^}]+)\}/g, (_, k) => (rowRef && rowRef[k] != null ? rowRef[k] : ''));
                    },
                    configurable: true,
                    enumerable:   true
                });
                cellItem.properties = Object.assign({}, cellItem.properties, { selection: dynSel });
            }
        } catch (_) {}

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
                else if (rawVal.UID !== undefined && (typeof rawVal.UID === 'string' || typeof rawVal.UID === 'number')) primitiveVal = rawVal.UID;

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

            /*
            // If server provided a DB-style type (INTEGER/STRING/BOOLEAN/etc), map it to client input types
            try {
                const t = (cellItem.type || '').toString().toUpperCase();
                if (t === 'INTEGER' || t === 'INT' || t === 'NUMBER' || t === 'BIGINT') cellItem.type = 'number';
                else if (t === 'BOOLEAN' || t === 'BOOL') cellItem.type = 'checkbox';
                else if (t === 'DATE' || t === 'DATEONLY' || t === 'DATETIME') cellItem.type = 'date';
                else if (t === 'STRING' || t === 'TEXT' || t === 'CHAR' || t === 'VARCHAR') cellItem.type = 'textbox';
                // leave enums and custom inputType values as-is
            } catch (e) {}

            // If server provided foreignKey metadata but did not set inputType,
            // prefer rendering a record selector (so DynamicTable cells get selection button)
            try {
                if ((!cellItem.type || cellItem.type === 'textbox') && col && col.foreignKey) {
                    cellItem.type = 'recordSelector';
                    const fk = col.foreignKey || {};
                    cellItem.properties = cellItem.properties || {};
                    cellItem.properties.selection = { table: fk.table, idField: fk.field || 'id', displayField: fk.displayField || 'name' };
                    cellItem.properties.showSelectionButton = true;
                    cellItem.properties.listMode = true;
                    // Try to prefer explicit app hint from column properties if present, otherwise fallback to table name
                    const rpcApp = (col.properties && (col.properties.app || col.properties.appName)) || col.app || fk.table;
                    cellItem.properties.listSource = { app: rpcApp, table: fk.table, idField: fk.field || 'id', displayField: fk.displayField || 'name', limit: 50 };
                }
            } catch (e) {}
            */

            // If server did not specify a type (after mapping), default to textbox (keep client simple)
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
                        const el = containerLocal.querySelector('[data-field="' + key + '"]') || containerLocal.querySelector('input,textarea,select,button');
                        if (el) {
                            const handler = (ev) => {
                                try {
                                    // For selection-type controls (recordSelector with rawValue),
                                    // use ctrl.getValue() to get the FK UID rather than el.value
                                    // which contains only the human-readable display text.
                                    const ctrl = this.appForm && this.appForm.controlsMap && this.appForm.controlsMap[key];
                                    let newVal;
                                    let displayVal;
                                    if (ctrl && typeof ctrl.getValue === 'function') {
                                        newVal = ctrl.getValue();
                                        // For FK/selection controls, preserve display text alongside raw UID
                                        if ((ctrl.showSelectionButton || ctrl.listMode) && typeof ctrl.getText === 'function') {
                                            displayVal = ctrl.getText();
                                        }
                                    } else {
                                        newVal = (el.type === 'checkbox') ? !!el.checked : el.value;
                                    }
                                    this.data_updateValue(key, newVal);
                                    this.data_updateParentArray(this.dataKey, rowIndexLocal, colDef, newVal, displayVal);
                                } catch (e) {}
                            };
                            el.addEventListener('input', handler);
                            el.addEventListener('change', handler);
                        }

                        // Set initial editable state based on active row, table-level readOnly and column-level readOnly
                        const isActive = (this._activeRowIndex === rowIndexLocal) && !this.readOnly && !colDef.readOnly;
                        // Helper to apply readonly/disabled to typical controls inside cell
                        const applyReadonlyToElement = (node, makeReadOnly) => {
                            try {
                                if (!node) return;
                                // If node has an associated UI object with setReadOnly, try to call it
                                if (node._uiObject && typeof node._uiObject.setReadOnly === 'function') {
                                    try { node._uiObject.setReadOnly(!isActive); } catch (e) {}
                                }
                                if (typeof node.setReadOnly === 'function') {
                                    try { node.setReadOnly(!isActive); } catch (e) {}
                                }
                                // Native inputs
                                if (node.tagName) {
                                    const tag = node.tagName.toLowerCase();
                                    if (tag === 'input' || tag === 'textarea') {
                                        try { node.readOnly = !isActive; } catch (e) {}
                                    }
                                    if (tag === 'select' || tag === 'button' || (node.type && (node.type === 'checkbox' || node.type === 'radio'))) {
                                        if (!(node.dataset && node.dataset.role === 'selection')) {
                                            try { node.disabled = !isActive; } catch (e) {}
                                        }
                                    }
                                    // add pointer-events none for non-active to prevent JS click handlers
                                    if (!(node.dataset && node.dataset.role === 'selection')) {
                                        try { node.style.pointerEvents = isActive ? '' : 'none'; } catch (e) {}
                                    }
                                }
                            } catch (e) {}
                        };

                        // Apply to primary element
                        if (el) applyReadonlyToElement(el, !isActive);
                        // Also apply to any interactive descendants
                        const interactive = containerLocal.querySelectorAll('input,textarea,select,button');
                        for (let ii = 0; ii < interactive.length; ii++) applyReadonlyToElement(interactive[ii], !isActive);
                    } catch (e) {}
                    try {
                        const nativeCb = containerLocal.querySelector('input[type="checkbox"]');
                        if (nativeCb) {
                            if (!containerLocal.dataset.checkboxListener) {
                                containerLocal.style.cursor = nativeCb.disabled ? 'default' : 'pointer';
                                containerLocal.addEventListener('click', (ev) => {
                                    try {
                                        if (ev.__checkboxHandled) return;
                                        const label = nativeCb.closest ? nativeCb.closest('label') : null;
                                        if (ev.target === nativeCb || nativeCb.contains(ev.target) || (label && label.contains(ev.target))) return;
                                        if (nativeCb.disabled) return;
                                        nativeCb.checked = !nativeCb.checked;
                                        nativeCb.dispatchEvent(new Event('change', { bubbles: true }));
                                        ev.__checkboxHandled = true;
                                    } catch (_) {}
                                });
                                containerLocal.dataset.checkboxListener = '1';
                            }
                            if (!containerLocal.dataset.checkboxCapture) {
                                containerLocal.addEventListener('click', (ev) => {
                                    try {
                                        if (ev.__checkboxHandled) return;
                                        const label = nativeCb.closest ? nativeCb.closest('label') : null;
                                        if (ev.target === nativeCb || nativeCb.contains(ev.target) || (label && label.contains(ev.target))) return;
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
        // Use CSS classes for zebra and active-row highlighting
        try { tr.classList.add('ui-table-row'); } catch (e) {}
        // Храним реальный индекс в массиве данных — используется в activateRow и updateAllRowsReadOnly
        // для правильной подсветки при активных клиентских фильтрах.
        tr._dataIndex = rowIndex;
        if (this._activeRowIndex === rowIndex) {
            try { tr.classList.add('active'); } catch (e) {}
        }
        // Make rows focusable so keyboard users can select them
        try { tr.tabIndex = 0; } catch (e) {}

        // Clicking a row / cell: handle activation and editing
        tr.addEventListener('click', (ev) => {
            try {
                const prevActive = this._activeRowIndex;
                const clickedRow = rowIndex;

                // If click target is inside a td, find nearest td
                const td = ev.target && ev.target.closest ? ev.target.closest('td') : null;

                if (this.editMode === 'row-activate') {
                    // First click: just activate the row
                    if (this._activeRowIndex !== clickedRow) {
                        this.activateRow(clickedRow);
                        return;
                    }
                    // If already active, second click should focus the cell's editor
                    // fall through to focusing logic below
                } else {
                    // cell-immediate: activate row (if needed) and then focus the cell
                    const wasInactive = (this._activeRowIndex !== clickedRow);
                    if (wasInactive) this.activateRow(clickedRow);
                    // If a checkbox cell was clicked while the row was inactive, the checkbox
                    // was disabled so the native click had no effect. Toggle it now that the
                    // row is active (activateRow just enabled it via updateAllRowsReadOnly).
                    if (wasInactive && td) {
                        try {
                            const nativeCb = td.querySelector('input[type="checkbox"]');
                            if (nativeCb && !nativeCb.disabled) {
                                nativeCb.checked = !nativeCb.checked;
                                nativeCb.dispatchEvent(new Event('change', { bubbles: true }));
                                ev.__checkboxHandled = true;
                            }
                        } catch (e) {}
                    }
                }

                // Focus appropriate editor/control inside clicked cell
                if (td) {
                    try {
                        // prefer element with data-field
                        const keyEl = td.querySelector('[data-field]') || td.querySelector('input,textarea,select,button');
                        if (keyEl) {
                            try { keyEl.focus && keyEl.focus(); } catch (e) {}
                            // If text input, select contents
                            try { if (keyEl.select && (keyEl.tagName.toLowerCase() === 'input' || keyEl.tagName.toLowerCase() === 'textarea')) keyEl.select(); } catch (e) {}
                        }
                    } catch (e) {}
                }
            } catch (e) {}
        });

        // Double-click on a row should trigger select/open
        tr.addEventListener('dblclick', (ev) => {
            try {
                if (this._activeRowIndex !== rowIndex) this.activateRow(rowIndex);
                if (typeof this.onSelectOrOpen === 'function') {
                    try { this.onSelectOrOpen(rowIndex); } catch (e) {}
                }
            } catch (e) {}
        });

        // Allow Enter key to activate the row (or trigger select/open for readOnly tables)
        tr.addEventListener('keydown', (ev) => {
            try {
                if (ev.key === 'Enter') {
                    if (this.readOnly) {
                        // Ensure row active
                        if (this._activeRowIndex !== rowIndex) this.activateRow(rowIndex);
                        if (typeof this.onSelectOrOpen === 'function') {
                            try { this.onSelectOrOpen(rowIndex); } catch (e) {}
                        }
                    } else {
                        tr.click();
                    }
                }
            } catch (e) {}
        });
        for (let c = 0; c < this.columns.length; c++) {
            const col = this.columns[c] || {};
            const td = this.renderCellElement(rowIndex, c, col, row);
            tr.appendChild(td);
        }
        return tr;
    }

    // Activate a row: set _activeRowIndex and update readonly/disabled state of controls
    activateRow(rowIndex) {
        try {
            this._activeRowIndex = rowIndex;
            // Update CSS classes
            if (this.element) {
                const tbody = this.element.querySelector('tbody');
                if (tbody) {
                    const children = Array.from(tbody.children || []);
                    for (let i = 0; i < children.length; i++) {
                        const child = children[i];
                        try {
                            // Сравниваем по _dataIndex, а не по визуальному номеру строки (при фильтрах виз. индекс ≠ реальному)
                            if (child._dataIndex === rowIndex) child.classList.add('active');
                            else child.classList.remove('active');
                        } catch (e) {}
                    }
                }
            }
            // Update controls
            this.updateAllRowsReadOnly();
            
            // Call onRowActivate callback if present
            try {
                if (typeof this.onRowActivate === 'function') {
                    this.onRowActivate(rowIndex);
                }
            } catch (e) {
                console.error('[DynamicTable] onRowActivate error:', e);
            }
            
            // attach global handlers to close editors on Escape
            // NOTE: Do NOT deactivate row on outside click - active row should remain active
            // even when focus moves to other UI elements (buttons, other forms, etc.)
            if (!this._docKeyHandler) {
                this._docKeyHandler = (ev) => {
                    try {
                        if (ev.key === 'Escape') {
                            try {
                                const tgt = ev.target;
                                // If focus is inside an editable control, blur it and keep row active
                                const isEditable = (node => {
                                    if (!node) return false;
                                    try {
                                        const tag = node.tagName ? node.tagName.toLowerCase() : '';
                                        if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return true;
                                        if (node.isContentEditable) return true;
                                        if (node.closest) {
                                            const p = node.closest('input,textarea,select,button,[contenteditable="true"]');
                                            if (p) return true;
                                        }
                                    } catch (e) {}
                                    return false;
                                })(tgt);
                                if (isEditable) {
                                    try { if (tgt && typeof tgt.blur === 'function') tgt.blur(); } catch (e) {}
                                    try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
                                    // After blurring editor, restore focus to table (or active row) so keyboard navigation resumes
                                    try {
                                        setTimeout(() => {
                                            try {
                                                if (this.element) {
                                                    const tbody = this.element.querySelector && this.element.querySelector('tbody');
                                                    if (tbody && typeof this._activeRowIndex === 'number' && this._activeRowIndex >= 0 && tbody.children && tbody.children[this._activeRowIndex]) {
                                                        try { tbody.children[this._activeRowIndex].focus(); return; } catch (e) {}
                                                    }
                                                    try { this.element.focus(); } catch (e) {}
                                                }
                                            } catch (e) {}
                                        }, 0);
                                    } catch (e) {}
                                    return;
                                }
                            } catch (e) {}
                            this.deactivateRow();
                        }
                    } catch (e) {}
                };
                document.addEventListener('keydown', this._docKeyHandler);
            }
        } catch (e) {}
    }

    // Deactivate active row
    deactivateRow() {
        try {
            this._activeRowIndex = -1;
            if (this.element) {
                const tbody = this.element.querySelector('tbody');
                if (tbody) {
                    const children = Array.from(tbody.children || []);
                    for (let i = 0; i < children.length; i++) {
                        const child = children[i];
                        try { child.classList.remove('active'); } catch (e) {}
                    }
                }
            }
            this.updateAllRowsReadOnly();
            if (this._docKeyHandler) {
                try { document.removeEventListener('keydown', this._docKeyHandler); } catch (e) {}
                this._docKeyHandler = null;
            }
            // blur any focused control inside the table
            try {
                const focused = document.activeElement;
                if (focused && this.element && this.element.contains(focused)) try { focused.blur(); } catch (e) {}
            } catch (e) {}
        } catch (e) {}
    }

    // Iterate rows and set readOnly/disabled state on controls depending on active row
    updateAllRowsReadOnly() {
        try {
            const tbody = this.element ? this.element.querySelector('tbody') : null;
            if (!tbody) return;
            const rows = Array.from(tbody.children || []);
            for (let r = 0; r < rows.length; r++) {
                const tr = rows[r];
                // Используем _dataIndex чтобы правильно определить активную строку при активных клиентских фильтрах.
                const isActive = (tr._dataIndex === this._activeRowIndex) && !this.readOnly;
                const interactives = tr.querySelectorAll('input,textarea,select,button');
                for (let i = 0; i < interactives.length; i++) {
                    const el = interactives[i];
                    // Skip elements inside column-readOnly cells — they must stay readonly regardless of row state
                    if (el.closest && el.closest('[data-col-readonly]')) continue;
                    try {
                        // Selection buttons ("...") stay always clickable — skip disabling them.
                        const isSelectionBtn = !!(el.dataset && el.dataset.role === 'selection');
                        if (el.tagName) {
                            const tag = el.tagName.toLowerCase();
                            if (tag === 'input' || tag === 'textarea') el.readOnly = !isActive;
                            if (!isSelectionBtn) {
                                if (tag === 'select' || tag === 'button' || (el.type && (el.type === 'checkbox' || el.type === 'radio'))) el.disabled = !isActive;
                                try { el.style.pointerEvents = isActive ? '' : 'none'; } catch (e) {}
                            }
                        }
                        if (el._uiObject && typeof el._uiObject.setReadOnly === 'function') {
                            try { el._uiObject.setReadOnly(!isActive); } catch (e) {}
                        }
                        if (typeof el.setReadOnly === 'function') {
                            try { el.setReadOnly(!isActive); } catch (e) {}
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {}
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
                        const getVal = (row) => {
                            if (!row) return '';
                            // Try display value first (for FKs)
                            const dispKey = '__' + colDef.data + '_display';
                            if (Object.prototype.hasOwnProperty.call(row, dispKey)) return row[dispKey];
                            
                            let v = row[colDef.data];
                            if (v === null || v === undefined) return '';
                            // If it's an object, try to find a displayable string
                            if (typeof v === 'object') {
                                return v.display || v.name || v.title || v.caption || v.label || v.text || JSON.stringify(v);
                            }
                            return v;
                        };
                        const va = getVal(a);
                        const vb = getVal(b);
                        
                        if (va == vb) return 0;
                        
                        // Numeric comparison if both are numbers
                        if (typeof va === 'number' && typeof vb === 'number') {
                            return s.order === 'asc' ? va - vb : vb - va;
                        }
                        
                        // Default string comparison
                        const sa = String(va).toLowerCase();
                        const sb = String(vb).toLowerCase();
                        if (sa == sb) return 0;
                        if (s.order === 'asc') return (sa > sb) ? 1 : -1;
                        return (sa < sb) ? 1 : -1;
                    });
                }
            }

            // Применяем клиентские фильтры
            if (Array.isArray(this.currentFilters) && this.currentFilters.some(f => f.enabled !== false && f.type === 'client')) {
                workingRows = workingRows.filter(row => this._matchClientFilters(row));
            }

            for (let r = 0; r < workingRows.length; r++) {
                const row = workingRows[r] || {};
                // При активных фильтрах workingRows — отфильтрованный срез исходного массива.
                // Передаём реальный индекс в rows, чтобы data_updateParentArray обновлял правильный элемент.
                const actualIndex = rows.indexOf(row);
                const effectiveIndex = actualIndex >= 0 ? actualIndex : r;
                const tr = this.renderRowElement(effectiveIndex, row);
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

    // Called when a readOnly table row is requested to be selected/opened
    // Invoked on double-click or Enter only when `this.readOnly === true`.
    // The implementation is intentionally empty; it includes a conditional
    // branch so callers can rely on `appForm.selectMode` being checked here.
    onSelectOrOpen(rowIndex) {
        try {
            const isSelect = !!(this.appForm && this.appForm.selectMode);
            if (!isSelect) {
                // If recordOpen is disabled for this table — do not open on double-click
                if (Array.isArray(this.hiddenButtons) && this.hiddenButtons.includes('recordOpen')) return;
                // open mode: resolve the row object and open uniForm record mode
                try {
                    const rows = this.data_getRows ? this.data_getRows(this.dataKey) : [];
                    const row = Array.isArray(rows) ? rows[rowIndex] : null;
                    if (row && (row.UID !== undefined && row.UID !== null)) {
                        // Не наследуем tableName родительской формы если эта таблица является
                        // табличной секцией (_dataMap[dataKey].tabularSection === true) —
                        // в этом случае у таблицы нет своего независимого типа записи.
                        let tableName = this.tableName || '';
                        if (!tableName) {
                            const isTabularSection = !!(
                                this.dataKey &&
                                this.appForm &&
                                this.appForm._dataMap &&
                                this.appForm._dataMap[this.dataKey] &&
                                this.appForm._dataMap[this.dataKey].tabularSection === true
                            );
                            if (!isTabularSection) {
                                tableName = (this.appForm && (this.appForm.dbTable || this.dataKey)) || '';
                            }
                        }
                        if (!tableName) return;
                        if (typeof window !== 'undefined' && window.MySpace && typeof window.MySpace.open === 'function') {
                            const self = this;
                            (async () => {
                                try {
                                    const instId = await window.MySpace.open('uniForm', { mode: 'record', tableName, recordID: row.UID });
                                    if (instId) {
                                        // Listen for the form being destroyed to refresh table data
                                        const onFormDestroyed = (ev) => {
                                            try {
                                                const inst = window.MySpace.getInstance(instId);
                                                const destroyedForm = ev && ev.detail && ev.detail.form;
                                                // Match: the destroyed form is the one belonging to our instance
                                                if (inst && inst.form && destroyedForm === inst.form) {
                                                    window.removeEventListener('form-destroyed', onFormDestroyed);
                                                    try { self.refresh(); } catch(e) {}
                                                }
                                            } catch(e) {}
                                        };
                                        window.addEventListener('form-destroyed', onFormDestroyed);
                                    }
                                } catch(e) {}
                            })();
                        }
                    }
                } catch (e) {}
            } else {
                // selectMode === true -> selection mode: set form current record and call onSelect if present
                try {
                    const rows = this.data_getRows ? this.data_getRows(this.dataKey) : [];
                    const row = Array.isArray(rows) ? rows[rowIndex] : null;
                    if (row) {
                        try {
                            if (this.appForm) this.appForm._currentRecord = row;
                        } catch (e) {}

                        // Prefer instance.onSelect if available, otherwise call appForm.onSelect
                        try {
                            const inst = this.appForm && this.appForm.instance ? this.appForm.instance : null;
                            if (inst && typeof inst.onSelect === 'function') {
                                try { inst.onSelect({}); } catch (e) {}
                            } else if (this.appForm && typeof this.appForm.onSelect === 'function') {
                                try { this.appForm.onSelect({}); } catch (e) {}
                            }
                        } catch (e) {}
                    }
                } catch (e) {}
            }
        } catch (e) {}
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

            // Определяем: является ли таблица табличной частью
            try {
                if (this.dataKey && this.appForm && this.appForm._dataMap) {
                    const entry = this.appForm._dataMap[this.dataKey];
                    this.isTabularSection = !!(entry && entry.tabularSection === true);
                }
            } catch (e) {}

            if (this.showToolbar) {
                const toolbarContainer = document.createElement('div');
                toolbarContainer.classList.add('ui-toolbar');
                toolbarContainer.classList.add('table-toolbar');
                wrapper.appendChild(toolbarContainer);

                const isSelectMode = !!(this.appForm && this.appForm.selectMode);
                const hiddenButtons = Array.isArray(this.hiddenButtons) ? this.hiddenButtons : [];

                const toolbarButtons = [
                    { action: 'select',       caption: __t('Select'),   icon: '/apps/general_icons/resources/public/16x16/select.png',   selectModeOnly: true },
                    { action: 'cancel',       caption: __t('Cancel'),   icon: '/apps/general_icons/resources/public/16x16/cancel.png',   selectModeOnly: true },
                    { action: 'recordAdd',    caption: __t('Add'),      icon: '/apps/general_icons/resources/public/16x16/add.png',      hideInSelectMode: true },
                    { action: 'recordDelete', caption: __t('Delete'),   icon: '/apps/general_icons/resources/public/16x16/delete.png',   hideInSelectMode: true },
                    { action: 'recordOpen',   caption: __t('Open'),     icon: '/apps/general_icons/resources/public/16x16/open.png' },
                    { action: 'listSettings', caption: __t('Settings'), icon: '/apps/general_icons/resources/public/16x16/settings.png' }
                ];

                for (const btnDef of toolbarButtons) {
                    if (btnDef.selectModeOnly && !isSelectMode) continue;
                    if (btnDef.hideInSelectMode && isSelectMode) continue;
                    if (hiddenButtons.includes(btnDef.action)) continue;
                    const btn = new Button(toolbarContainer, { caption: btnDef.caption, tooltip: btnDef.caption, icon: btnDef.icon, showIcon: !!btnDef.icon, showText: false });
                    btn.Draw(toolbarContainer);
                    const action = btnDef.action;
                    const self = this;
                    btn.onClick = () => {
                        // Кнопка "Настройки": передаём себя как tableInstance чтобы listSettings
                        // мог читать/писать фильтры напрямую на экземпляре таблицы
                        if (action === 'listSettings') {
                            try {
                                if (window.MySpace && typeof window.MySpace.open === 'function') {
                                    const appName  = (self.appForm && self.appForm.appName) || '';
                                    const title    = (self.appForm && self.appForm._originalTitle) || appName;
                                    window.MySpace.open('listSettings', {
                                        appName, title,
                                        tableInstance: self   // ключевой параметр
                                    });
                                }
                            } catch (e) { console.error('[Table] listSettings error', e); }
                            return;
                        }
                        if (!self.doToolbarAction(action)) {
                            self.appForm && typeof self.appForm.doAction === 'function' &&
                                self.appForm.doAction(action, { isStandard: true });
                        }
                    };
                }
            }

            // --- FILTER BAR (полоска активных видимых фильтров) ---
            const filterBarContainer = document.createElement('div');
            filterBarContainer.classList.add('ui-filter-bar');
            filterBarContainer.style.display = 'none'; // скрыт пока нет видимых фильтров
            wrapper.appendChild(filterBarContainer);
            this._filterBarContainer = filterBarContainer;

            // Метод обновления полоски фильтров — вызывается из API фильтров
            this._updateFilterBar = () => {
                try {
                    const filters = Array.isArray(this.currentFilters) ? this.currentFilters : [];
                    const uiFilters = filters.filter(f => f.visibility === 'visible' || f.visibility === 'readonly');
                    filterBarContainer.innerHTML = '';
                    if (uiFilters.length === 0) {
                        filterBarContainer.style.display = 'none';
                        return;
                    }
                    filterBarContainer.style.display = 'flex';

                    for (const f of uiFilters) {
                        const chip = document.createElement('span');
                        chip.className = 'ui-filter-chip' + (f.enabled === false ? ' ui-filter-chip--off' : '');
                        chip.title = f.caption + ' ' + f.operator + ' ' + (f.value !== null && f.value !== undefined ? f.value : '');

                        if (f.visibility === 'visible') {
                            // Чекбокс вкл/выкл
                            const cb = document.createElement('input');
                            cb.type = 'checkbox';
                            cb.checked = f.enabled !== false;
                            cb.title = __t('Enable / disable filter');
                            cb.addEventListener('change', () => {
                                f.enabled = cb.checked;
                                chip.classList.toggle('ui-filter-chip--off', !f.enabled);
                                this.applyFilters();
                            });
                            chip.appendChild(cb);
                        }

                        // Текст: "Статус = Активный"
                        const label = document.createElement('span');
                        label.className = 'ui-filter-chip-label';
                        const opLabel = { '=':'=', '!=':'≠', '>':'>', '>=':'≥', '<':'<', '<=':'≤',
                            'contains':'⊃', 'startsWith':'^', 'endsWith':'$',
                            'isNull':'∅', 'isNotNull':'∃' }[f.operator] || f.operator;
                        label.textContent = (f.caption || f.field) + ' ' + opLabel +
                            ((f.operator !== 'isNull' && f.operator !== 'isNotNull')
                                ? ' ' + (f.value !== null && f.value !== undefined ? f.value : '') : '');
                        chip.appendChild(label);

                        // Клик на текст фильтра — inline-редактирование значения
                        if (f.visibility === 'visible') {
                            label.style.cursor = 'pointer';
                            label.addEventListener('click', () => {
                                this._openFilterInlineEditor(f, chip);
                            });

                            // Кнопка удаления
                            const del = document.createElement('span');
                            del.className = 'ui-filter-chip-del';
                            del.textContent = '×';
                            del.title = __t('Remove filter');
                            del.addEventListener('click', () => { this.removeFilter(f.field); });
                            chip.appendChild(del);
                        }

                        filterBarContainer.appendChild(chip);
                    }
                } catch (e) { console.error('[Table._updateFilterBar]', e); }
            };

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
            bodyContainer.style.overflowY = 'scroll'; // Always show scrollbar to reserve space
            bodyContainer.style.overflowX = 'auto';
            bodyContainer.style.backgroundColor = '#ffffff';
            bodyContainer.style.boxSizing = 'border-box';
            // Borders for body only: left - dark, right - light, bottom - light, no top
            bodyContainer.style.borderLeft = '2px solid #808080';
            bodyContainer.style.borderRight = '2px solid #ffffff';
            bodyContainer.style.borderBottom = '2px solid #ffffff';
            // If visibleRows specified (>0) use it as minHeight so the table is always
            // visible even when empty, but can still grow when there are more rows.
            if (this.visibleRows && this.visibleRows > 0) {
                bodyContainer.style.minHeight = (this.visibleRows * this.rowHeight) + 'px';
            }
            bodyContainer.style.flex = '1 1 auto';
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
                        // Add padding-right to headerContainer equal to scrollbar width minus 1px
                        headerContainer.style.paddingRight = (scrollBarWidth - 1) + 'px';
                    } else {
                        headerContainer.style.paddingRight = '0';
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
            // Ensure initial readonly/disabled state for controls according to active row
            try { this.updateAllRowsReadOnly(); } catch (e) {}
            // Keyboard navigation: enable row navigation when in 'row-activate' mode
            try {
                // make wrapper focusable to receive key events
                try { this.element.tabIndex = 0; } catch (e) {}
                this._anchorRow = null; // for shift-selection
                this.element.addEventListener('keydown', (ev) => {
                    try {
                        if (this.editMode !== 'row-activate') return;
                        const key = ev.key;
                        const tgt = ev.target;
                        // If focus is inside an editable control (input/textarea/select/button/contenteditable),
                        // allow default behavior so cursor movement and native handling work.
                        try {
                            const isEditable = (node => {
                                if (!node) return false;
                                try {
                                    const tag = node.tagName ? node.tagName.toLowerCase() : '';
                                    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return true;
                                    if (node.isContentEditable) return true;
                                    if (node.closest) {
                                        const p = node.closest('input,textarea,select,button,[contenteditable="true"]');
                                        if (p) return true;
                                    }
                                } catch (e) {}
                                return false;
                            })(tgt);
                            if (isEditable) return;
                        } catch (e) {}
                        const ctrl = ev.ctrlKey || ev.metaKey;
                        const shift = ev.shiftKey;
                        const tbody = this.element.querySelector('tbody');
                        if (!tbody) return;
                        const rows = Array.from(tbody.children || []);
                        const count = rows.length;
                        if (count === 0) return;
                        let idx = this._activeRowIndex >= 0 ? this._activeRowIndex : 0;

                        const pageSize = Math.max(1, Math.floor((this.bodyContainer ? this.bodyContainer.clientHeight : (this.visibleRows || 10) * this.rowHeight) / this.rowHeight) || this.visibleRows || 10);

                        const clamp = (v) => Math.max(0, Math.min(count - 1, v));

                        let handled = false;
                        if (key === 'ArrowDown') {
                            if (ctrl) idx = count - 1; else idx = clamp(idx + 1);
                            handled = true;
                        } else if (key === 'ArrowUp') {
                            if (ctrl) idx = 0; else idx = clamp(idx - 1);
                            handled = true;
                        } else if (key === 'PageDown') {
                            if (ctrl) idx = count - 1; else idx = clamp(idx + pageSize);
                            handled = true;
                        } else if (key === 'PageUp') {
                            if (ctrl) idx = 0; else idx = clamp(idx - pageSize);
                            handled = true;
                        } else if (key === 'Home') {
                            idx = 0;
                            handled = true;
                        } else if (key === 'End') {
                            idx = count - 1;
                            handled = true;
                        } else if (key === 'Enter') {
                            // Enter should focus first interactive element in active row
                            const activeRow = (this._activeRowIndex >= 0 && this._activeRowIndex < rows.length) ? rows[this._activeRowIndex] : rows[0];
                            if (activeRow) {
                                const first = activeRow.querySelector('[data-field]') || activeRow.querySelector('input,textarea,select,button');
                                try { if (first) { first.focus(); if (first.select && (first.tagName.toLowerCase()==='input' || first.tagName.toLowerCase()==='textarea')) first.select(); } } catch (e) {}
                            }
                            handled = true;
                        }

                        if (handled) {
                            ev.preventDefault();
                            // set anchor for shift-selection
                            if (shift) {
                                if (this._anchorRow === null) this._anchorRow = this._activeRowIndex >= 0 ? this._activeRowIndex : 0;
                            } else {
                                this._anchorRow = null;
                            }
                            // Activate new row
                            this.activateRow(idx);
                            // focus row element so further keyboard events target table
                            try { const tr = rows[idx]; if (tr) tr.focus(); } catch (e) {}
                            // update selection range UI when shift is held
                            try {
                                if (this._anchorRow !== null && shift) {
                                    const a = this._anchorRow;
                                    const b = idx;
                                    const start = Math.min(a,b);
                                    const end = Math.max(a,b);
                                    for (let i = 0; i < rows.length; i++) {
                                        try { if (i >= start && i <= end) rows[i].classList.add('range-selected'); else rows[i].classList.remove('range-selected'); } catch (e) {}
                                    }
                                } else {
                                    // clear any previous range selections
                                    for (let i = 0; i < rows.length; i++) try { rows[i].classList.remove('range-selected'); } catch (e) {}
                                }
                            } catch (e) {}
                        }
                    } catch (e) {}
                });
            } catch (e) {}
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

    async _renderTab(tab, btn) {
        try {
            if (!this._content) return;
            // Highlight active tab button
            if (this._header) {
                this._header.querySelectorAll('button').forEach(b => b.classList.remove('active'));
            }
            if (btn) btn.classList.add('active');

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

            const header = document.createElement('div');
            header.classList.add('ui-tabs-header');

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
                    btn.addEventListener('click', async () => { try { await this._renderTab(t, btn); } catch (e) {} });
                    this._header.appendChild(btn);
                    if (idx === 0) {
                        this._activeTab = t;
                        this._activeBtn = btn;
                    }
                });
                if (this.tabs.length > 0) this._renderTab(this._activeTab, this._activeBtn);
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
        super(null, { columns: options.fields || options.columns || [], rowHeight: options.rowHeight, appForm: options.appForm, dataKey: options.dataKey || options.data || options.tableName, readOnly: options.readOnly !== false });

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
        this._sseReconnectTimer = null;
        this._sseDestroyed = false;
    }

    // Override Draw: base structure + attach virtual scroll listener
    Draw(container) {
        try {
            if (!this._dataSubscribed) {
                try { if (typeof this.connectSSE === 'function') this.connectSSE(); } catch (e) {}
                this._dataSubscribed = true;
            }
        } catch (e) {}

        // Table.prototype.Draw calls this.buildBody() — our override creates the runway
        const el = (function(self, cnt) {
            try { return Table.prototype.Draw.call(self, cnt); } catch (e) { return null; }
        })(this, container);

        // Attach virtual scroll listener once (bodyContainer created by Table.Draw)
        try {
            if (el && this.bodyContainer && !this._scrollHandlerAttached) {
                this._scrollHandlerAttached = true;
                const self = this;
                this._scrollHandler = () => { try { self._onScroll(); } catch (e) {} };
                this.bodyContainer.addEventListener('scroll', this._scrollHandler);
            }
        } catch (e) {}

        // ResizeObserver: recalculate visibleRows and trigger scroll-check when bodyContainer height changes
        try {
            if (el && this.bodyContainer && !this._resizeObserver && typeof ResizeObserver !== 'undefined') {
                const self = this;
                this._resizeObserver = new ResizeObserver(() => {
                    try {
                        self.calculateVisibleRows();
                        if (self.dataLoaded && !self.isLoading) {
                            // _onScroll reads current scrollTop — correct for any resize direction
                            self._onScroll();
                        }
                    } catch (e) {}
                });
                this._resizeObserver.observe(this.bodyContainer);
            }
        } catch (e) {}

        try {
            if (el && !this.dataLoaded && !this.isLoading) {
                try { this.refresh(); } catch (e) {}
            }
        } catch (e) {}

        return el;
    }

    // Override buildBody: creates a regular table with empty tbody.
    // All TR rows are allocated later (in _allocateRows) once totalRows is known.
    buildBody(bodyContainer, _rows) {
        const tableEl = document.createElement('table');
        tableEl.style.width = '100%';
        tableEl.style.borderCollapse = 'collapse';
        tableEl.style.tableLayout = 'fixed';

        const bcolgroup = document.createElement('colgroup');
        for (let i = 0; i < this.columns.length; i++) {
            const col = this.columns[i] || {};
            const c = document.createElement('col');
            c.style.width = (col.width ? col.width + 'px' : '100px');
            bcolgroup.appendChild(c);
        }
        tableEl.appendChild(bcolgroup);
        const tbody = document.createElement('tbody');
        tableEl.appendChild(tbody);
        bodyContainer.appendChild(tableEl);

        this._mainTable = tableEl;
        this._mainTbody = tbody;
        this._dtBcolgroup = bcolgroup;
        this._rowElements = [];

        return { bodyTable: tableEl, bcolgroup: bcolgroup, tbody: tbody, renderBodyRows: () => {} };
    }

    // Create (or recreate) all TR placeholder elements for the full dataset.
    // Each TR is a fixed-height empty row — the browser uses these for the scrollbar.
    _allocateRows() {
        const tbody = this._mainTbody;
        if (!tbody) return;
        const colSpan = Math.max(1, this.columns.length);

        const existing = this._rowElements ? this._rowElements.length : 0;

        if (existing === this.totalRows) return; // nothing changed, skip

        // Remove excess rows
        while (this._rowElements && this._rowElements.length > this.totalRows) {
            const tr = this._rowElements.pop();
            try { if (tr && tr.parentNode) tr.parentNode.removeChild(tr); } catch (e) {}
        }
        if (!this._rowElements) this._rowElements = [];

        // Append missing rows
        for (let i = existing; i < this.totalRows; i++) {
            const tr = document.createElement('tr');
            tr.classList.add('ui-table-row');
            tr.style.height = this.rowHeight + 'px';
            tr.style.boxSizing = 'border-box';
            tr.tabIndex = 0;
            tr._dtIndex = i;
            tr._dtFilled = false;

            // Placeholder: single wide cell occupying the row height
            const ph = document.createElement('td');
            ph.colSpan = colSpan;
            ph.style.padding = '0';
            ph.style.height = this.rowHeight + 'px';
            tr.appendChild(ph);

            // Events — pass global index directly (index === globalIndex in this approach)
            const self = this;
            const gi = i;
            tr.addEventListener('click', (ev) => {
                try {
                    if (self.editMode === 'row-activate') {
                        if (self._activeRowIndex !== gi) { self.activateRow(gi); return; }
                    } else {
                        if (self._activeRowIndex !== gi) self.activateRow(gi);
                    }
                    const td = ev.target && ev.target.closest ? ev.target.closest('td') : null;
                    if (td) {
                        const keyEl = td.querySelector('[data-field]') || td.querySelector('input,textarea,select,button');
                        if (keyEl) { try { keyEl.focus && keyEl.focus(); } catch (e) {} }
                    }
                } catch (e) {}
            });
            tr.addEventListener('dblclick', () => {
                try {
                    if (self._activeRowIndex !== gi) self.activateRow(gi);
                    try { self.onSelectOrOpen(gi); } catch (e) {}
                } catch (e) {}
            });
            tr.addEventListener('keydown', (ev) => {
                try {
                    if (ev.key === 'Enter') {
                        if (self.readOnly) {
                            if (self._activeRowIndex !== gi) self.activateRow(gi);
                            try { self.onSelectOrOpen(gi); } catch (e) {}
                        } else { tr.click(); }
                    }
                } catch (e) {}
            });

            tbody.appendChild(tr);
            this._rowElements.push(tr);
        }
    }

    // Fill a single row with real cell content from dataCache.
    _fillRow(globalIndex) {
        const tr = this._rowElements && this._rowElements[globalIndex];
        if (!tr) return;
        const row = this.dataCache[globalIndex];
        if (!row || !row.loaded) return;
        if (tr._dtFilled) return; // already rendered (flag cleared by _resetFilledRows on refresh)

        // Применяем client-фильтры: не прошедшие строки просто скрываем
        const visible = this._matchClientFilters(row);
        tr.style.visibility = visible ? '' : 'hidden';

        tr.innerHTML = '';
        for (let c = 0; c < this.columns.length; c++) {
            const col = this.columns[c] || {};
            const td = this.renderCellElement(globalIndex, c, col, row);
            tr.appendChild(td);
        }
        tr._dtFilled = true;

        // Restore active highlight if needed
        if (this._activeRowIndex === globalIndex) tr.classList.add('active');
    }

    // Reset a row back to empty placeholder (used on refresh/sort).
    _emptyRow(tr) {
        if (!tr) return;
        tr.innerHTML = '';
        const ph = document.createElement('td');
        ph.colSpan = Math.max(1, this.columns.length);
        ph.style.padding = '0';
        ph.style.height = this.rowHeight + 'px';
        tr.appendChild(ph);
        tr._dtFilled = false;
    }

    // Fill all cached rows in the currently visible range (+ buffer).
    _fillVisibleRows() {
        if (!this.bodyContainer || !this._rowElements || !this._rowElements.length) return;
        const scrollTop  = this.bodyContainer.scrollTop;
        const visibleH   = this.bodyContainer.clientHeight || 0;
        const from = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.bufferRows);
        const to   = Math.min(this.totalRows - 1, Math.ceil((scrollTop + visibleH) / this.rowHeight) + this.bufferRows);
        for (let i = from; i <= to; i++) {
            if (this.dataCache[i] && this.dataCache[i].loaded) {
                this._fillRow(i);
            }
        }
    }

    // Scroll handler: fill from cache then fetch any missing rows.
    _onScroll() {
        if (!this.bodyContainer || this.totalRows === 0) return;

        // Immediately fill visible rows from what is already cached
        this._fillVisibleRows();

        const scrollTop  = this.bodyContainer.scrollTop;
        const visibleH   = this.bodyContainer.clientHeight || 0;
        const from = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.bufferRows);
        const to   = Math.min(this.totalRows - 1, Math.ceil((scrollTop + visibleH) / this.rowHeight) + this.bufferRows);

        // Find first row in visible range that is not cached
        let firstMissing = -1;
        for (let i = from; i <= to; i++) {
            if (!this.dataCache[i] || !this.dataCache[i].loaded) { firstMissing = i; break; }
        }
        if (firstMissing === -1) return; // everything visible is cached

        if (this._scrollDebounce) { clearTimeout(this._scrollDebounce); this._scrollDebounce = null; }
        const self = this;
        this._scrollDebounce = setTimeout(async () => {
            if (self._sseDestroyed) return;
            if (self.isLoading) {
                // Wait for current load then re-check
                const retry = () => {
                    if (self._sseDestroyed) return;
                    if (!self.isLoading) { try { self._onScroll(); } catch (e) {} }
                    else setTimeout(retry, 50);
                };
                setTimeout(retry, 50);
                return;
            }
            self.firstVisibleRow = firstMissing;
            try {
                self.calculateVisibleRows();
                await self.loadData(firstMissing);
            } catch (e) {
                console.error('[DynamicTable] scroll load error', e);
            }
        }, 80);
    }

    // Override activateRow: O(1) — directly target row by global index.
    activateRow(globalIndex) {
        // Remove highlight from previously active row
        if (typeof this._activeRowIndex === 'number' && this._activeRowIndex >= 0) {
            const prev = this._rowElements && this._rowElements[this._activeRowIndex];
            if (prev) try { prev.classList.remove('active'); } catch (e) {}
        }
        this._activeRowIndex = globalIndex;
        const tr = this._rowElements && this._rowElements[globalIndex];
        if (tr) try { tr.classList.add('active'); } catch (e) {}
        try { this.updateAllRowsReadOnly(); } catch (e) {}
        try { if (typeof this.onRowActivate === 'function') this.onRowActivate(globalIndex); } catch (e) {}
        // Attach Escape handler to close editors
        if (!this._docKeyHandler) {
            this._docKeyHandler = (ev) => {
                try {
                    if (ev.key === 'Escape') {
                        const tgt = ev.target;
                        const isEditable = (node => {
                            if (!node) return false;
                            try {
                                const tag = node.tagName ? node.tagName.toLowerCase() : '';
                                if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return true;
                                if (node.isContentEditable) return true;
                                if (node.closest) { const p = node.closest('input,textarea,select,button,[contenteditable="true"]'); if (p) return true; }
                            } catch (e) {}
                            return false;
                        })(tgt);
                        if (isEditable) {
                            try { tgt.blur(); } catch (e) {}
                            try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
                            setTimeout(() => {
                                try {
                                    const activeEl = this._rowElements && this._rowElements[this._activeRowIndex];
                                    if (activeEl) activeEl.focus(); else if (this.element) this.element.focus();
                                } catch (e) {}
                            }, 0);
                            return;
                        }
                        this.deactivateRow();
                    }
                } catch (e) {}
            };
            document.addEventListener('keydown', this._docKeyHandler);
        }
    }

    // Override deactivateRow: O(1).
    deactivateRow() {
        if (typeof this._activeRowIndex === 'number' && this._activeRowIndex >= 0) {
            const tr = this._rowElements && this._rowElements[this._activeRowIndex];
            if (tr) try { tr.classList.remove('active'); } catch (e) {}
        }
        this._activeRowIndex = -1;
        try { this.updateAllRowsReadOnly(); } catch (e) {}
        if (this._docKeyHandler) {
            try { document.removeEventListener('keydown', this._docKeyHandler); } catch (e) {}
            this._docKeyHandler = null;
        }
        try {
            const focused = document.activeElement;
            if (focused && this.element && this.element.contains(focused)) try { focused.blur(); } catch (e) {}
        } catch (e) {}
    }

    // Override updateAllRowsReadOnly: only iterate filled rows in visible range.
    updateAllRowsReadOnly() {
        if (!this._rowElements || !this.bodyContainer) return;
        const scrollTop = this.bodyContainer.scrollTop;
        const visibleH  = this.bodyContainer.clientHeight || 0;
        const from = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.bufferRows);
        const to   = Math.min(this._rowElements.length - 1, Math.ceil((scrollTop + visibleH) / this.rowHeight) + this.bufferRows);
        for (let i = from; i <= to; i++) {
            const tr = this._rowElements[i];
            if (!tr || !tr._dtFilled) continue;
            const isActive = (this._activeRowIndex === i) && !this.readOnly;
            const interactives = tr.querySelectorAll('input,textarea,select,button');
            for (let j = 0; j < interactives.length; j++) {
                const el = interactives[j];
                // Skip elements inside column-readOnly cells
                if (el.closest && el.closest('[data-col-readonly]')) continue;
                try {
                    const tag = el.tagName ? el.tagName.toLowerCase() : '';
                    if (tag === 'input' || tag === 'textarea') el.readOnly = !isActive;
                    if (tag === 'select' || tag === 'button' || (el.type && (el.type === 'checkbox' || el.type === 'radio'))) el.disabled = !isActive;
                    el.style.pointerEvents = isActive ? '' : 'none';
                } catch (e) {}
            }
        }
    }

    // Override onSelectOrOpen: rowIndex IS the global index in this approach.
    onSelectOrOpen(globalIndex) {
        try {
            const row = this.dataCache[globalIndex];
            if (!row || !row.loaded) return;
            const isSelect = !!(this.appForm && this.appForm.selectMode);
            if (!isSelect) {
                // If recordOpen is disabled for this table — do not open on double-click
                if (Array.isArray(this.hiddenButtons) && this.hiddenButtons.includes('recordOpen')) return;
                const tableName = this.tableName || (this.appForm && (this.appForm.dbTable || this.dataKey)) || '';
                if (typeof window !== 'undefined' && window.MySpace && typeof window.MySpace.open === 'function') {
                    const self = this;
                    (async () => {
                        try {
                            const instId = await window.MySpace.open('uniForm', { mode: 'record', tableName, recordID: row.UID });
                            if (instId) {
                                const onFD = (ev) => {
                                    try {
                                        const inst = window.MySpace.getInstance(instId);
                                        const df = ev && ev.detail && ev.detail.form;
                                        if (inst && inst.form && df === inst.form) {
                                            window.removeEventListener('form-destroyed', onFD);
                                            try { self.refresh(); } catch (e) {}
                                        }
                                    } catch (e) {}
                                };
                                window.addEventListener('form-destroyed', onFD);
                            }
                        } catch (e) {}
                    })();
                }
            } else {
                if (this.appForm) this.appForm._currentRecord = row;
                const inst = this.appForm && this.appForm.instance;
                if (inst && typeof inst.onSelect === 'function') { try { inst.onSelect({}); } catch (e) {} }
                else if (this.appForm && typeof this.appForm.onSelect === 'function') { try { this.appForm.onSelect({}); } catch (e) {} }
            }
        } catch (e) {}
    }

    // Mark all allocated rows as unfilled (O(N) flag-only, no DOM writes).
    // Called before a full data refresh so stale cell content is replaced on next _fillVisibleRows.
    _resetFilledRows() {
        if (!this._rowElements) return;
        for (let i = 0; i < this._rowElements.length; i++) {
            const tr = this._rowElements[i];
            if (tr) tr._dtFilled = false;
        }
    }

    // Override applyFilters: server filters need a server round-trip; client-only filters just re-render.
    applyFilters() {
        const hasServer = Array.isArray(this.currentFilters) && this.currentFilters.some(
            f => f.enabled !== false && f.type === 'server'
        );
        if (hasServer || !this.dataLoaded) {
            try { this.refresh(); } catch (e) {}
        } else {
            this._resetFilledRows();
            try { this._fillVisibleRows(); } catch (e) {}
        }
    }

    async refresh() {
        this.showLoadingIndicator();
        // Reset all cached rows so stale cell content is replaced after reload
        this.dataCache = {};
        this._resetFilledRows();
        try {
            this.calculateVisibleRows();
            await this.loadData(this.firstVisibleRow);
        } catch (error) {
            console.error('[DynamicTable] Refresh error:', error);
            if (typeof showAlert === 'function') {
                showAlert(__t('Data refresh error: ') + error.message);
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
            label.textContent = __t('Loading...');
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
            // На сервер отправляем только включённые server-фильтры
            const serverFilters = Array.isArray(this.currentFilters)
                ? this.currentFilters.filter(f => f.enabled !== false && f.type === 'server')
                : [];
            const data = await callServerMethod(this.appName, 'getDynamicTableData', {
                tableName: this.tableName,
                firstRow: firstRow,
                visibleRows: this.visibleRows,
                sort: this.currentSort,
                filters: serverFilters
            });
            // Expect new format only: { columns, rows, totalRows }
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
                }
            }
            // Preload lookup lists once per column (avoid per-row lookups)
            try {
                if (typeof callServerMethod === 'function') {
                    const lookupKeyToPromise = new Map();
                    const pendingAssignments = [];

                    for (let i = 0; i < columns.length; i++) {
                        const col = columns[i] || {};
                        const ls = (col.properties && col.properties.listSource) ? col.properties.listSource : null;
                        if (ls) {
                            const rpcApp = ls.app || ls.appName || this.appName || null;
                            const table = ls.table || ls.tableName || null;
                            if (rpcApp && table) {
                                const idField = ls.idField || 'UID';
                                const displayField = ls.displayField || 'name';
                                const limit = (typeof ls.limit === 'number' && ls.limit > 0) ? ls.limit : (ls.limit ? (ls.limit|0) : 100);
                                const key = `${rpcApp}::${table}::${idField}::${displayField}::${limit}`;
                                if (!lookupKeyToPromise.has(key)) {
                                    const p = (async () => {
                                        try {
                                            const resp = await callServerMethod(rpcApp, 'getLookupList', { tableName: table, firstRow: 0, visibleRows: limit });
                                            const rawRows = resp && (resp.rows || resp.data || resp.items) ? (resp.rows || resp.data || resp.items) : [];
                                            return (rawRows || []).map(r => {
                                                const val = (r && (r[idField] !== undefined)) ? r[idField] : (r && r.UID);
                                                const cap = (r && (r.display !== undefined)) ? r.display : ((r && (r[displayField] !== undefined)) ? r[displayField] : ((r && r.name) || (val !== undefined ? String(val) : '')));
                                                return { value: val, caption: cap };
                                            });
                                        } catch (e) {
                                            try { console.error('[DynamicTable] preload getLookupList failed for', rpcApp, table, e); } catch(_){}
                                            return [];
                                        }
                                    })();
                                    lookupKeyToPromise.set(key, p);
                                }
                                pendingAssignments.push({ colIndex: i, key });
                            }
                        }
                    }

                    // Await all distinct lookups
                    await Promise.all(Array.from(lookupKeyToPromise.values()));

                    // Assign lists to corresponding columns
                    for (const pa of pendingAssignments) {
                        try {
                            const list = await lookupKeyToPromise.get(pa.key);
                            if (!columns[pa.colIndex].properties) columns[pa.colIndex].properties = {};
                            columns[pa.colIndex].listItems = list;
                            columns[pa.colIndex].properties.listItems = list;
                        } catch (e) {
                            try { console.error('[DynamicTable] assign preload list failed', e); } catch(_){}
                        }
                    }
                }
            } catch (e) {
                try { console.error('[DynamicTable.loadData] preload lookup lists error', e); } catch(_){}
            }
            
            // Preserve manual column widths between refreshes
            if (this.columns && this.columns.length > 0) {
                columns.forEach(nc => {
                    const oc = this.columns.find(ex => ex.data === nc.data);
                    if (oc && oc.width) nc.width = oc.width;
                });
            }

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

            // Render: allocate rows (if totalRows changed), update colgroup, fill visible rows
            try {
                if (this.element) {
                    // Rebuild header when columns first arrive from server
                    if (this.headerContainer) {
                        this.headerContainer.innerHTML = '';
                        const self = this;
                        this.buildHeader(this.headerContainer, () => self._dtBcolgroup);
                    }
                    // Sync colgroup widths
                    const bcg = this._dtBcolgroup;
                    if (bcg) {
                        while (bcg.children.length < this.columns.length) bcg.appendChild(document.createElement('col'));
                        while (bcg.children.length > this.columns.length) bcg.removeChild(bcg.lastChild);
                        for (let i = 0; i < this.columns.length; i++) {
                            const col = this.columns[i] || {};
                            bcg.children[i].style.width = (col.width ? col.width + 'px' : '100px');
                        }
                    }
                    // Allocate/resize the TR array to match totalRows
                    this._allocateRows();
                    // Fill visible rows from the freshly populated dataCache
                    this._fillVisibleRows();
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

        // If destroyed or scheduled to be destroyed, do not (re)connect
        if (this._sseDestroyed) return;

        // Ensure global registries
        try {
            if (typeof window !== 'undefined') {
                window._dynamicTableEventSources = window._dynamicTableEventSources || new Map();
                window._dynamicTableSubscribers = window._dynamicTableSubscribers || new Map();
            }
        } catch (e) {}

        // Try session-scoped global SSE first (one EventSource per session)
        const sessionSharedKey = `__session__events`;
        const perTableSharedKey = `${this.appName}::${this.tableName}`;
        this._sseSharedKey = perTableSharedKey;

        // First try session-level SSE
        try {
            const existingSession = (typeof window !== 'undefined' && window._dynamicTableEventSources) ? window._dynamicTableEventSources.get(sessionSharedKey) : null;
            if (existingSession && existingSession.es) {
                this.eventSource = existingSession.es;
                this._sseSharedKey = sessionSharedKey;
                const subs = (typeof window !== 'undefined' && window._dynamicTableSubscribers) ? (window._dynamicTableSubscribers.get(sessionSharedKey) || new Set()) : new Set();
                subs.add(this);
                if (typeof window !== 'undefined' && window._dynamicTableSubscribers) window._dynamicTableSubscribers.set(sessionSharedKey, subs);
                console.log('[DynamicTable] reused session SSE for', this.appName, this.tableName, 'subscribers=', subs.size);
                // fall through to attach no new handlers (shared ES already has onmessage attached)
            } else {
                // Try to open a new session-scoped EventSource
                const sessionUrl = `/app/events`;
                console.log('[DynamicTable] attempting session SSE to', sessionUrl);
                try {
                    const ses = new EventSource(sessionUrl);
                    // register
                    if (typeof window !== 'undefined') {
                        window._dynamicTableEventSources.set(sessionSharedKey, { es: ses });
                        const subs = window._dynamicTableSubscribers.get(sessionSharedKey) || new Set();
                        subs.add(this);
                        window._dynamicTableSubscribers.set(sessionSharedKey, subs);
                    }
                    this.eventSource = ses;
                    this._sseSharedKey = sessionSharedKey;

                    ses.onopen = () => {
                        console.log('[DynamicTable] session SSE connected for', this.appName, this.tableName);
                    };

                    ses.onmessage = (event) => {
                        try {
                            const d = JSON.parse(event.data);
                            if (d && d.type === 'dataChanged') {
                                // Only react if message matches this table
                                if (d.app === this.appName && d.tableName === this.tableName) {
                                    try {
                                        const subs = window._dynamicTableSubscribers.get(sessionSharedKey);
                                        if (subs) subs.forEach(sub => {
                                            try { sub.dataCache = {}; } catch(e){}
                                            // Debounce SSE refresh to avoid rapid cascading refreshes
                                            try {
                                                if (sub._sseRefreshTimer) clearTimeout(sub._sseRefreshTimer);
                                                sub._sseRefreshTimer = setTimeout(() => {
                                                    sub._sseRefreshTimer = null;
                                                    if (typeof sub.refresh === 'function' && !sub._sseDestroyed) sub.refresh();
                                                }, 300);
                                            } catch(e){}
                                        });
                                    } catch(e){}
                                }
                            }
                        } catch (e) { console.error('[DynamicTable] session SSE parse error', e); }
                    };

                    ses.onerror = () => {
                        console.warn('[DynamicTable] session SSE error/closed for', this.appName, this.tableName);
                        try { ses.close(); } catch (e) {}
                        // cleanup registry if needed
                        try {
                            const subs = window._dynamicTableSubscribers.get(sessionSharedKey);
                            if (subs && subs.delete) subs.delete(this);
                            const remaining = subs ? subs.size : 0;
                            if (remaining === 0) {
                                try { window._dynamicTableEventSources.delete(sessionSharedKey); } catch(e){}
                            }
                        } catch (e) {}
                        // fallback to per-table SSE
                        this._sseSharedKey = perTableSharedKey;
                        try { if (typeof this.connectSSE === 'function') { /* will not re-enter */ } } catch(e){}
                    };
                } catch (e) {
                    console.warn('[DynamicTable] session SSE failed, will fallback to per-table SSE', e);
                }
            }
        } catch (e) { console.warn('[DynamicTable] session SSE init error', e); }

        // If session SSE already attached and in registry, we don't need to create per-table ES
        const activeShared = (typeof window !== 'undefined' && window._dynamicTableEventSources) ? window._dynamicTableEventSources.get(this._sseSharedKey) : null;
        if (activeShared && activeShared.es && this._sseSharedKey === sessionSharedKey) {
            // already handled via session ES
            return;
        }

        // Fallback: per-table EventSource
        try {
            // Reuse existing shared EventSource if present
            const existing = (typeof window !== 'undefined' && window._dynamicTableEventSources) ? window._dynamicTableEventSources.get(perTableSharedKey) : null;
            if (existing && existing.es) {
                this.eventSource = existing.es;
                const subs = (typeof window !== 'undefined' && window._dynamicTableSubscribers) ? (window._dynamicTableSubscribers.get(perTableSharedKey) || new Set()) : new Set();
                subs.add(this);
                if (typeof window !== 'undefined' && window._dynamicTableSubscribers) window._dynamicTableSubscribers.set(perTableSharedKey, subs);
                console.log('[DynamicTable] reused shared SSE for', this.appName, this.tableName, 'subscribers=', subs.size);
                return;
            }
        } catch (e) {}

        const url = `/app/${this.appName}/subscribeToTable?tableName=${this.tableName}`;
        console.log('[DynamicTable] connecting SSE to', url);
        const es = new EventSource(url);

        // Register shared event source and subscriber set
        try {
            if (typeof window !== 'undefined') {
                window._dynamicTableEventSources.set(perTableSharedKey, { es: es });
                const subs = window._dynamicTableSubscribers.get(perTableSharedKey) || new Set();
                subs.add(this);
                window._dynamicTableSubscribers.set(perTableSharedKey, subs);
            }
        } catch (e) {}

        this.eventSource = es;

        es.onopen = () => {
            console.log('[DynamicTable] SSE connected for', this.appName, this.tableName);
        };

        es.onmessage = (event) => {
            try {
                const d = JSON.parse(event.data);
                if (d && d.type === 'dataChanged') {
                    // Notify all subscribers for this table
                    try {
                        const subs = (typeof window !== 'undefined' && window._dynamicTableSubscribers) ? window._dynamicTableSubscribers.get(sharedKey) : null;
                        if (subs && subs.size > 0) {
                            subs.forEach(sub => {
                                try { sub.dataCache = {}; } catch (e) {}
                                // Debounce SSE refresh
                                try {
                                    if (sub._sseRefreshTimer) clearTimeout(sub._sseRefreshTimer);
                                    sub._sseRefreshTimer = setTimeout(() => {
                                        sub._sseRefreshTimer = null;
                                        if (typeof sub.refresh === 'function' && !sub._sseDestroyed) sub.refresh();
                                    }, 300);
                                } catch (e) {}
                            });
                        }
                    } catch (e) {}
                }
            } catch (e) {
                console.error('[DynamicTable] SSE parse error', e);
            }
        };

        es.onerror = () => {
            console.warn('[DynamicTable] SSE error/closed for', this.appName, this.tableName);
            try {
                // Remove this instance from subscribers
                const subs = (typeof window !== 'undefined' && window._dynamicTableSubscribers) ? window._dynamicTableSubscribers.get(sharedKey) : null;
                if (subs && subs.delete) subs.delete(this);
                const remaining = subs ? subs.size : 0;
                if (typeof window !== 'undefined' && window._dynamicTableSubscribers) window._dynamicTableSubscribers.set(sharedKey, subs || new Set());
                try { es.close(); } catch (e) {}
                try { if (this._sseReconnectTimer) { clearTimeout(this._sseReconnectTimer); this._sseReconnectTimer = null; } } catch (e) {}
                // If no subscribers left, remove shared source entry
                if (remaining === 0) {
                    try { if (typeof window !== 'undefined' && window._dynamicTableEventSources) window._dynamicTableEventSources.delete(sharedKey); } catch (e) {}
                }
            } catch (e) {
                try { es.close(); } catch (e2) {}
            }
        };
    }

    // Ensure cleanup of long-lived resources (SSE, timers, listeners) when table is destroyed
    destroy() {
        try {
            this._sseDestroyed = true;
            console.log('[DynamicTable] destroy() called for', this.appName, this.tableName);
            try { if (this._scrollDebounce) { clearTimeout(this._scrollDebounce); this._scrollDebounce = null; } } catch (e) {}
            try { if (this._sseRefreshTimer) { clearTimeout(this._sseRefreshTimer); this._sseRefreshTimer = null; } } catch (e) {}
            try {
                if (this._scrollHandler && this.bodyContainer) {
                    this.bodyContainer.removeEventListener('scroll', this._scrollHandler);
                    this._scrollHandler = null;
                    this._scrollHandlerAttached = false;
                }
            } catch (e) {}
            try {
                if (this._resizeObserver) {
                    this._resizeObserver.disconnect();
                    this._resizeObserver = null;
                }
            } catch (e) {}
            try {
                if (this._docKeyHandler) {
                    document.removeEventListener('keydown', this._docKeyHandler);
                    this._docKeyHandler = null;
                }
            } catch (e) {}
            try { this._rowElements = null; } catch (e) {}
            try { if (this._sseReconnectTimer) { clearTimeout(this._sseReconnectTimer); this._sseReconnectTimer = null; } } catch (e) {}
            try {
                const sharedKey = this._sseSharedKey;
                if (typeof window !== 'undefined' && sharedKey && window._dynamicTableSubscribers) {
                    const subs = window._dynamicTableSubscribers.get(sharedKey);
                    if (subs && subs.delete) subs.delete(this);
                    const remaining = subs ? subs.size : 0;
                    if (typeof window !== 'undefined' && window._dynamicTableSubscribers) window._dynamicTableSubscribers.set(sharedKey, subs || new Set());
                    if (remaining === 0) {
                        // close shared event source
                        try {
                            const entry = window._dynamicTableEventSources && window._dynamicTableEventSources.get(sharedKey);
                            if (entry && entry.es) {
                                try { console.log('[DynamicTable] closing shared EventSource for', sharedKey); entry.es.close(); } catch (e) {}
                            }
                        } catch (e) {}
                        try { if (typeof window !== 'undefined' && window._dynamicTableEventSources) window._dynamicTableEventSources.delete(sharedKey); } catch (e) {}
                    }
                }
            } catch (e) {}
            if (this.eventSource) {
                try { console.log('[DynamicTable] closing eventSource for', this.appName, this.tableName); this.eventSource.close(); } catch (e) {}
                this.eventSource = null;
            }
        } catch (e) {}

        try {
            if (UIObject && UIObject.prototype && typeof UIObject.prototype.destroy === 'function') {
                UIObject.prototype.destroy.call(this);
            }
        } catch (e) {}
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

    data_updateParentArray(dataKey, rowIndex, colDef, newVal, displayVal) {
        try {
            if (dataKey && dataKey === this.dataKey) {
                if (!this.dataCache[rowIndex]) this.dataCache[rowIndex] = { loaded: false, __index: rowIndex };
                if (colDef && colDef.data) {
                    this.dataCache[rowIndex][colDef.data] = newVal;
                    // Persist FK display value so it survives re-renders
                    const dispKey = '__' + colDef.data + '_display';
                    if (displayVal !== undefined && displayVal !== null) {
                        this.dataCache[rowIndex][dispKey] = displayVal;
                    }
                }
                return;
            }
        } catch (e) {}
        try { if (super.data_updateParentArray) return super.data_updateParentArray(dataKey, rowIndex, colDef, newVal, displayVal); } catch (e) {}
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