
class UIObject {
    constructor() {
        this.element = null;
        this.parent = null;
        this.children = [];
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
            this.titleTextElement.textContent = this.title;
            this.titleBar.appendChild(this.titleTextElement);

            // Buttons container
            const buttonsContainer = document.createElement('div');
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
        this.x = 0;
        this.y = 0;
        this.z = 0;
        if (parentElement) {
            this.parentElement = parentElement;
        } else {
            this.parentElement = null;
        }
    }

    setCaption(caption) {
        this.caption = caption;
        if (this.element) {
            this.element.textContent = caption;
        }
    }

    getCaption() {
        return this.caption;
    }

    Draw(container) {
        if (!this.element) {
            this.element = document.createElement('button');
            this.element.textContent = this.caption;

            // If parentElement is not set, use absolute positioning
            if (!this.parentElement) {
                this.element.style.position = 'absolute';
                this.element.style.left = this.x + 'px';
                this.element.style.top = this.y + 'px';
                this.element.style.width = this.width + 'px';
                this.element.style.height = this.height + 'px';
                this.element.style.zIndex = this.z;
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
        }

        if (container) {
            container.appendChild(this.element);
        }

        return this.element;
    }
}

class TextBox extends UIObject {

    constructor(parentElement = null) {
        super();
        this.text = '';
        this.placeholder = '';
        this.readOnly = false;
        this.maxLength = null;
        this.parentElement = parentElement;
    }

    setText(text) {
        this.text = text;
        if (this.element) {
            this.element.value = text;
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
        this.maxLength = maxLength;
        if (this.element && maxLength) {
            this.element.maxLength = maxLength;
        }
    }

    getMaxLength() {
        return this.maxLength;
    }

    Draw(container) {
        if (!this.element) {
            this.element = document.createElement('input');
            this.element.type = 'text';
            this.element.value = this.text;
            this.element.placeholder = this.placeholder;
            this.element.readOnly = this.readOnly;

            // Add unique id to eliminate browser warning
            this.element.id = 'textbox_' + Math.random().toString(36).substr(2, 9);
            this.element.name = this.element.id;

            if (this.maxLength) {
                this.element.maxLength = this.maxLength;
            }

            // Positioning
            if (!this.parentElement) {
                this.element.style.position = 'absolute';
                this.element.style.left = this.x + 'px';
                this.element.style.top = this.y + 'px';
                this.element.style.zIndex = this.z;
            }

            this.element.style.width = this.width + 'px';
            this.element.style.height = this.height + 'px';

            // Retro textbox style: white background, themed borders from client_config
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
            this.element.style.padding = '2px 4px';
            this.element.style.outline = 'none';
            this.element.style.boxSizing = 'border-box';

            // Load config and update if needed
            UIObject.loadClientConfig().then(() => {
                const base = UIObject.getClientConfigValue('defaultColor', tbBase);
                const light = UIObject.brightenColor(base, 60);
                const dark = UIObject.brightenColor(base, -60);
                this.element.style.backgroundColor = '#ffffff';
                this.element.style.borderTop = `2px solid ${dark}`;
                this.element.style.borderLeft = `2px solid ${dark}`;
                this.element.style.borderRight = `2px solid ${light}`;
                this.element.style.borderBottom = `2px solid ${light}`;
            });

            // Events
            this.element.addEventListener('input', (e) => {
                this.text = e.target.value;
            });

            this.element.addEventListener('click', (e) => {
                this.onClick(e);
            });

            this.element.addEventListener('dblclick', (e) => {
                this.onDoubleClick(e);
            });

            this.element.addEventListener('keydown', (e) => {
                this.onKeyPressed(e);
            });

            this.element.addEventListener('focus', (e) => {
                this.element.style.borderTop = '2px solid #000080';
                this.element.style.borderLeft = '2px solid #000080';
            });

            this.element.addEventListener('blur', (e) => {
                this.element.style.borderTop = '2px solid #808080';
                this.element.style.borderLeft = '2px solid #808080';
            });
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
            this.element.style.display = 'flex';
            this.element.style.alignItems = 'center';
            this.element.style.padding = '2px';
            this.element.style.gap = '2px';
            this.element.style.boxSizing = 'border-box';

            // Win98 toolbar style - FLATTENED as requested
            // Keeping it transparent or inheriting parent color? 
            // User requested "remove volume", so transparent is safest or same as window bg.
            // Usually rebar/coolbar is transparent.
            this.element.style.backgroundColor = 'transparent';
            this.element.style.border = 'none'; // Remove borders

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
            }

            // Draw items
            this.items.forEach(item => {
                item.Draw(this.element);
            });
            // Skip loading config color to keep it transparent/flat as requested
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

class Checkbox extends UIObject {
    constructor(parentElement = null) {
        super();
        this.parentElement = parentElement;
        this.checked = false;
        this.text = '';
        this.box = null;
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
    updateVisual() {
        if (this.box) {
            this.box.textContent = this.checked ? '✔' : '';
            // Using unicode checkmark, centered
        }
    }
    Draw(container) {
        if (!this.element) {
            this.element = document.createElement('div');
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
            this.element.appendChild(this.textSpan);

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
        if (container) container.appendChild(this.element);
        return this.element;
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

class ConfirmForm extends ModalForm {
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


class ComboBox extends UIObject {
    constructor(parentElement = null) {
        super();
        this.parentElement = parentElement;
        this.items = []; // Array of strings or objects {label, value}
        this.selectedIndex = -1;
        this.text = '';
        this.expanded = false;
        this.onChange = null;
        this.listElement = null; // The dropdown list container
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

        if (container) container.appendChild(this.element);
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
        el.onload = callback || function(){};
    } else if (type === 'style' || type === 'css') {
        el = document.createElement('link');
        el.rel = 'stylesheet';
        el.href = src;
        el.onload = callback || function(){};
    } else {
        throw new Error('Unsupported resource type: ' + type);
    }
    document.head.appendChild(el);
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
