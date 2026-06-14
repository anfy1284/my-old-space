// Приложение "Калькулятор".
//
// Паттерн MySpace: client.js регистрирует дескриптор, окно строится в
// createInstance() при MySpace.open() из меню. Singleton — одно окно.
(function () {
    const APP_NAME = 'calculator';

    const descriptor = {
        config: { allowMultipleInstances: false },

        createInstance: async function (params) {
            const appForm = new DataForm(APP_NAME);
            appForm.setTitle(__t('menu_calculator'));
            appForm.setWidth(260);
            appForm.setHeight(340);
            appForm.setAnchorToWindow('center');

            const ERROR_TEXT = __t('calc_error');

            // ── Состояние ─────────────────────────────────────────────────────
            let displayMemory = '0';
            let dotPressed = false;
            let operationGiven = false;
            let operation = null;
            let value1 = '';
            let value2 = '';
            let isError = false;
            let displayEl = null;

            function refreshDisplay() {
                if (!displayEl) return;
                displayEl.textContent = isError ? ERROR_TEXT : displayMemory;
            }

            function handleButton(digit, op) {
                if (digit) {
                    if (isError) { isError = false; displayMemory = '0'; }
                    if (operationGiven) { displayMemory = ''; operationGiven = false; }
                    if (displayMemory === '0') displayMemory = '';
                    displayMemory = displayMemory + digit;
                } else {
                    if (op === '.' && !dotPressed) {
                        if (operationGiven) { displayMemory = '0'; operationGiven = false; }
                        if (displayMemory === '') displayMemory = '0';
                        displayMemory = displayMemory + '.';
                        dotPressed = true;
                    } else if (op === 'C') {
                        isError = false; displayMemory = '0'; operation = null;
                        value1 = '0'; value2 = '0'; dotPressed = false; operationGiven = false;
                    } else if (op === 'CE') {
                        isError = false; displayMemory = '0'; dotPressed = false;
                    } else if (op === 'backspace') {
                        if (isError) { isError = false; displayMemory = '0'; }
                        else if (displayMemory.length > 1) {
                            if (displayMemory.slice(-1) === '.') dotPressed = false;
                            displayMemory = displayMemory.slice(0, -1);
                        } else {
                            displayMemory = '0';
                        }
                    } else if (['+', '-', '*', '/'].includes(op)) {
                        operation = op; operationGiven = true; dotPressed = false;
                        value1 = displayMemory; value2 = '';
                    } else if (op === '%') {
                        displayMemory = (parseFloat(displayMemory) / 100 * parseFloat(value1 || '0')).toString();
                    } else if (op === '=') {
                        if (operation && value1 !== '') {
                            if (value2 === '' || !operationGiven) value2 = displayMemory;
                            switch (operation) {
                                case '+': displayMemory = (parseFloat(value1) + parseFloat(value2)).toString(); break;
                                case '-': displayMemory = (parseFloat(value1) - parseFloat(value2)).toString(); break;
                                case '*': displayMemory = (parseFloat(value1) * parseFloat(value2)).toString(); break;
                                case '/':
                                    if (parseFloat(value2) !== 0) {
                                        displayMemory = (parseFloat(value1) / parseFloat(value2)).toString();
                                    } else {
                                        displayMemory = ''; isError = true;
                                    }
                                    break;
                            }
                            value1 = displayMemory;
                            operationGiven = true; // следующая цифра начнёт новое число
                            dotPressed = displayMemory.includes('.');
                        }
                    }
                }
                refreshDisplay();
            }

            const OPS = new Set(['/', '*', '-', '+', '%', '=']);

            function buildUI(content) {
                content.innerHTML = '';
                content.style.padding = '6px';
                content.style.boxSizing = 'border-box';
                content.style.overflow = 'hidden';
                content.style.display = 'flex';
                content.style.flexDirection = 'column';
                content.style.gap = '6px';

                // Дисплей (утопленная панель Win95)
                displayEl = document.createElement('div');
                content.appendChild(displayEl);
                displayEl.textContent = '0';
                displayEl.style.boxSizing = 'border-box';
                displayEl.style.height = '48px';
                displayEl.style.lineHeight = '40px';
                displayEl.style.padding = '0 8px';
                displayEl.style.textAlign = 'right';
                displayEl.style.fontSize = '26px';
                displayEl.style.fontFamily = 'Consolas, "Lucida Console", monospace';
                displayEl.style.backgroundColor = '#ffffff';
                displayEl.style.overflow = 'hidden';
                displayEl.style.whiteSpace = 'nowrap';
                displayEl.style.borderTop = '2px solid #808080';
                displayEl.style.borderLeft = '2px solid #808080';
                displayEl.style.borderRight = '2px solid #ffffff';
                displayEl.style.borderBottom = '2px solid #ffffff';

                // Сетка кнопок 4×5
                const grid = document.createElement('div');
                content.appendChild(grid);
                grid.style.display = 'grid';
                grid.style.gridTemplateColumns = 'repeat(4, 1fr)';
                grid.style.gridTemplateRows = 'repeat(5, 1fr)';
                grid.style.gap = '4px';
                grid.style.flex = '1';
                grid.style.minHeight = '0';

                const buttons = [
                    { caption: '%', op: '%' }, { caption: 'CE', op: 'CE' }, { caption: 'C', op: 'C' }, { caption: '⌫', op: 'backspace' },
                    { caption: '7', digit: '7' }, { caption: '8', digit: '8' }, { caption: '9', digit: '9' }, { caption: '/', op: '/' },
                    { caption: '4', digit: '4' }, { caption: '5', digit: '5' }, { caption: '6', digit: '6' }, { caption: '*', op: '*' },
                    { caption: '1', digit: '1' }, { caption: '2', digit: '2' }, { caption: '3', digit: '3' }, { caption: '-', op: '-' },
                    { caption: '0', digit: '0' }, { caption: '.', op: '.' }, { caption: '=', op: '=' }, { caption: '+', op: '+' }
                ];

                for (const def of buttons) {
                    const btn = new Button(grid, { caption: def.caption });
                    btn.Draw(grid);
                    btn.onClick = () => handleButton(def.digit || null, def.op || null);
                    const el = btn.getElement();
                    if (el) {
                        el.style.width = '100%';
                        el.style.height = '100%';
                        el.style.fontSize = '17px';
                        el.style.padding = '0';
                        if (def.op && OPS.has(def.op)) {
                            // Операторы выделяем цветом текста для читаемости.
                            el.style.color = (def.op === '=') ? '#0000aa' : '#aa3300';
                            el.style.fontWeight = 'bold';
                        }
                    }
                }
            }

            // Клавиатурный ввод (фреймворк зовёт onKeyPressed на верхней форме).
            appForm.onKeyPressed = function (e) {
                const k = e.key;
                if (k >= '0' && k <= '9') { handleButton(k, null); e.preventDefault(); return; }
                if (k === '.' || k === ',') { handleButton(null, '.'); e.preventDefault(); return; }
                if (['+', '-', '*', '/', '%'].includes(k)) { handleButton(null, k); e.preventDefault(); return; }
                if (k === 'Enter' || k === '=') { handleButton(null, '='); e.preventDefault(); return; }
                if (k === 'Backspace') { handleButton(null, 'backspace'); e.preventDefault(); return; }
                if (k === 'Escape') { handleButton(null, 'C'); e.preventDefault(); return; }
            };

            let built = false;
            const instance = {
                appName: APP_NAME,
                form: appForm,

                onOpen: async (openParams) => {
                    if (built) {
                        try {
                            if (typeof appForm.restore === 'function') appForm.restore();
                            else if (typeof appForm.activate === 'function') appForm.activate();
                        } catch (e) {}
                        return;
                    }
                    built = true;

                    appForm.getLayoutWithData = async () => ({ layout: [], data: [] });
                    await appForm.Draw();

                    const content = appForm.contentArea || (appForm.getContentArea && appForm.getContentArea());
                    if (!content) return;
                    buildUI(content);
                    refreshDisplay();
                },

                onAction: async () => false,

                destroy: () => {
                    try { appForm.close(); } catch (e) {}
                }
            };

            appForm.instance = instance;
            await instance.onOpen(params);
            return instance;
        }
    };

    if (window.MySpace) {
        window.MySpace.register(APP_NAME, descriptor);
    } else {
        console.error('[calculator] window.MySpace not found!');
    }
})();
