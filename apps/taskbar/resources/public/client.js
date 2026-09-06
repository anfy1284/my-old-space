(function() {
const Taskbar = {
    container: null,
    buttonsContainer: null,
    trayContainer: null,
    height: 28,

    init: function() {
        // Create container
        this.container = document.createElement('div');
        this.container.style.position = 'fixed';
        this.container.style.bottom = '0';
        this.container.style.left = '0';
        this.container.style.width = '100%';
        this.container.style.height = this.height + 'px';
        this.container.style.zIndex = '9999';
        this.container.style.backgroundColor = '#c0c0c0';
        this.container.style.borderTop = '2px solid #ffffff';
        this.container.style.display = 'flex';
        this.container.style.alignItems = 'center';
        this.container.style.padding = '2px';
        this.container.style.boxSizing = 'border-box';
        
        document.body.appendChild(this.container);
        
        // Set global offset
        if (typeof Form !== 'undefined') {
            Form.bottomOffset = this.height;
        }
        
        // Buttons container
        this.buttonsContainer = document.createElement('div');
        this.buttonsContainer.style.display = 'flex';
        this.buttonsContainer.style.flexGrow = '1';
        this.buttonsContainer.style.gap = '2px';
        this.buttonsContainer.style.height = '100%';
        this.container.appendChild(this.buttonsContainer);

        // Область трея — правый край панели задач. Саму панель рисует этот
        // модуль, значки в ней — приложение `tray`: панель задач ничего не знает
        // про то, у каких приложений есть значок, а трей ничего не знает про
        // геометрию панели. Контракт между ними — единственный метод
        // getTrayContainer().
        this.trayContainer = document.createElement('div');
        this.trayContainer.style.display = 'flex';
        this.trayContainer.style.alignItems = 'center';
        this.trayContainer.style.gap = '2px';
        this.trayContainer.style.height = '100%';
        this.trayContainer.style.flexShrink = '0';
        this.trayContainer.style.padding = '0 2px';
        // Утопленная рамка Win95 — как у области уведомлений в оригинале.
        this.trayContainer.style.borderTop = '1px solid #808080';
        this.trayContainer.style.borderLeft = '1px solid #808080';
        this.trayContainer.style.borderRight = '1px solid #ffffff';
        this.trayContainer.style.borderBottom = '1px solid #ffffff';
        this.trayContainer.style.boxSizing = 'border-box';
        this.container.appendChild(this.trayContainer);

        // Listeners
        window.addEventListener('form-created', (e) => this.addForm(e.detail.form));
        window.addEventListener('form-destroyed', (e) => this.removeForm(e.detail.form));
        window.addEventListener('form-activated', (e) => this.updateActive(e.detail.form));
        window.addEventListener('form-minimized', (e) => this.updateActive(null));
        window.addEventListener('form-restored', (e) => this.updateActive(e.detail.form));
        window.addEventListener('form-title-changed', (e) => this.updateTitle(e.detail.form));
        
        // Check existing forms
        if (typeof Form !== 'undefined' && Form._allForms) {
            Form._allForms.forEach(f => this.addForm(f));
        }
    },
    
    // Контейнер трея для приложения `tray`. Возвращает null, если панель ещё
    // не отрисована — вызывающий обязан это проверить.
    getTrayContainer: function() {
        return this.trayContainer;
    },

    addForm: function(form) {
        if (form._taskbarBtn) return;
        // Свойство приложения `hideFromTaskbar` (config.json): фоновому окну
        // кнопка в панели задач не нужна — его показывает и прячет значок в трее.
        if (form.hideFromTaskbar) return;

        const btn = document.createElement('div');
        btn.style.height = '100%';
        btn.style.minWidth = '120px';
        btn.style.maxWidth = '160px';
        btn.style.flex = '1';
        btn.style.backgroundColor = '#c0c0c0';
        btn.style.borderTop = '2px solid #ffffff';
        btn.style.borderLeft = '2px solid #ffffff';
        btn.style.borderRight = '2px solid #000000';
        btn.style.borderBottom = '2px solid #000000';
        btn.style.padding = '2px 4px';
        btn.style.boxSizing = 'border-box';
        btn.style.cursor = 'default';
        btn.style.display = 'flex';
        btn.style.alignItems = 'center';
        btn.style.fontSize = '12px';
        btn.style.fontFamily = 'MS Sans Serif, sans-serif';
        btn.style.userSelect = 'none';
        
        const text = document.createElement('span');
        text.textContent = form.getTitle();
        text.style.whiteSpace = 'nowrap';
        text.style.overflow = 'hidden';
        text.style.textOverflow = 'ellipsis';

        // Icon before text (always created, hidden until formIcon is set)
        const icon = document.createElement('img');
        icon.style.width = '16px';
        icon.style.height = '16px';
        icon.style.marginRight = '3px';
        icon.style.flexShrink = '0';
        if (form.formIcon) {
            MySpace.icon.apply(icon, form.formIcon, 16);
            icon.style.display = 'inline';
        } else {
            icon.style.display = 'none';
        }
        form._taskbarIcon = icon;
        btn.appendChild(icon);
        btn.appendChild(text);
        
        btn.onclick = () => {
            if (form.element.style.display === 'none') {
                form.restore();
            } else {
                // Check if active (blue title bar)
                // We can check z-index or titleBar background
                let isActive = false;
                if (form.titleBar && (form.titleBar.style.backgroundColor === 'rgb(0, 0, 128)' || form.titleBar.style.backgroundColor === '#000080')) {
                    isActive = true;
                }
                
                if (isActive) {
                     form.minimize();
                } else {
                    form.activate();
                }
            }
        };
        
        form._taskbarBtn = btn;
        this.buttonsContainer.appendChild(btn);
        this.updateActive(form);
    },
    
    removeForm: function(form) {
        if (form._taskbarBtn) {
            form._taskbarBtn.remove();
            form._taskbarBtn = null;
        }
    },

    updateTitle: function(form) {
        if (!form || !form._taskbarBtn) return;
        // Find the span text node inside the button
        const spans = form._taskbarBtn.querySelectorAll('span');
        if (spans.length > 0) {
            spans[spans.length - 1].textContent = form.getTitle();
        }
    },
    
    updateActive: function(activeForm) {
        if (typeof Form === 'undefined') return;
        
        Form._allForms.forEach(f => {
            if (f._taskbarBtn) {
                const btn = f._taskbarBtn;
                // Check if form is visible and active
                // We can rely on the passed activeForm, but also check display property
                const isVisible = f.element.style.display !== 'none';
                const isActive = (f === activeForm) && isVisible;
                
                if (isActive) {
                    // Pressed style
                    btn.style.backgroundColor = '#eeeeee'; 
                    btn.style.borderTop = '2px solid #000000';
                    btn.style.borderLeft = '2px solid #000000';
                    btn.style.borderRight = '2px solid #ffffff';
                    btn.style.borderBottom = '2px solid #ffffff';
                    btn.style.fontWeight = 'bold';
                } else {
                    // Normal style
                    btn.style.backgroundColor = '#c0c0c0';
                    btn.style.borderTop = '2px solid #ffffff';
                    btn.style.borderLeft = '2px solid #ffffff';
                    btn.style.borderRight = '2px solid #000000';
                    btn.style.borderBottom = '2px solid #000000';
                    btn.style.fontWeight = 'normal';
                }
            }
        });
    }
};

// Панель задач публикуется, чтобы приложение `tray` могло получить свой
// контейнер. Единственная точка связи между ними.
window.MySpaceTaskbar = Taskbar;

window.addEventListener('load', () => {
    Taskbar.init();
    // Трей мог загрузиться раньше панели: сообщаем, что контейнер готов.
    window.dispatchEvent(new CustomEvent('taskbar-ready', { detail: { taskbar: Taskbar } }));
});
})();
