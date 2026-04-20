(function () {
    const APP_NAME = 'calculator';

    const descriptor = {
        config: { allowMultipleInstances: true },

        createInstance: async function (params) {
            const appForm = new DataForm(APP_NAME);
            appForm.setTitle('Calculator');
            appForm.setWidth(300);
            appForm.setHeight(350);
            appForm.setAnchorToWindow('center');

            // Calculator state
            let displayMemory = '0';
            let dotPressed = false;
            let operationGiven = false;
            let operation = null;
            let value1 = '';
            let value2 = '';
            let isError = false;
            let displayTextBox = null;

            function refreshDisplay() {
                if (!displayTextBox) return;
                displayTextBox.setText(isError ? 'Error' : displayMemory);
            }

            function handleButton(digit, op) {
                if (digit) {
                    if (isError) isError = false;
                    if (operationGiven) { displayMemory = ''; operationGiven = false; }
                    if (displayMemory === '0') displayMemory = '';
                    displayMemory = displayMemory + digit;
                } else {
                    if (op === '.' && !dotPressed) {
                        displayMemory = displayMemory + '.';
                        dotPressed = true;
                    } else if (op === 'C') {
                        isError = false; displayMemory = '0'; operation = null;
                        value1 = '0'; value2 = '0'; dotPressed = false; operationGiven = false;
                    } else if (op === 'CE') {
                        isError = false; value1 = '0'; displayMemory = '0'; dotPressed = false;
                    } else if (op === 'backspace') {
                        if (displayMemory.length > 1) {
                            if (displayMemory.slice(-1) === '.') dotPressed = false;
                            displayMemory = displayMemory.slice(0, -1);
                        } else {
                            displayMemory = '0';
                        }
                    } else if (['+', '-', '*', '/'].includes(op)) {
                        operation = op; operationGiven = true;
                        value1 = displayMemory; value2 = '';
                    } else if (op === '%') {
                        displayMemory = (parseFloat(displayMemory) / 100 * parseFloat(value1)).toString();
                    } else if (op === '=') {
                        if (operation && value1 !== '') {
                            if (value2 === '') value2 = displayMemory;
                            switch (operation) {
                                case '+': displayMemory = (parseFloat(value1) + parseFloat(value2)).toString(); break;
                                case '-': displayMemory = (parseFloat(value1) - parseFloat(value2)).toString(); break;
                                case '*': displayMemory = (parseFloat(value1) * parseFloat(value2)).toString(); break;
                                case '/':
                                    if (parseFloat(value2) !== 0) {
                                        displayMemory = (parseFloat(value1) / parseFloat(value2)).toString();
                                    } else {
                                        displayMemory = ''; isError = true; operationGiven = true;
                                    }
                                    break;
                                case '%': displayMemory = (parseFloat(value1) % parseFloat(value2)).toString(); break;
                            }
                            value1 = displayMemory;
                        }
                    }
                }
                refreshDisplay();
            }

            const instance = {
                appName: APP_NAME,
                form: appForm,

                onOpen: async (openParams) => {
                    appForm.getLayoutWithData = async () => ({ layout: [], data: [] });
                    await appForm.Draw();

                    const content = appForm.contentArea || (appForm.getContentArea && appForm.getContentArea());
                    if (!content) return;
                    content.innerHTML = '';
                    content.style.padding = '0';

                    // Build calculator UI via table for grid layout
                    const table = document.createElement('table');
                    table.style.width = '100%';
                    table.style.height = '100%';
                    table.style.borderCollapse = 'collapse';
                    table.style.tableLayout = 'fixed';
                    content.appendChild(table);

                    // Display row
                    const displayRow = document.createElement('tr');
                    const displayCell = document.createElement('td');
                    displayCell.colSpan = 4;
                    displayCell.style.padding = '4px';
                    displayRow.appendChild(displayCell);
                    table.appendChild(displayRow);

                    displayTextBox = new TextBox(displayCell);
                    displayTextBox.setReadOnly(true);
                    displayTextBox.setText('0');
                    displayTextBox.Draw(displayCell);
                    const tbEl = displayTextBox.getElement();
                    if (tbEl) {
                        tbEl.style.width = '100%';
                        tbEl.style.height = '40px';
                        tbEl.style.fontSize = '24px';
                        tbEl.style.textAlign = 'right';
                    }

                    // Button rows
                    const buttons = [
                        [{ caption: '%', op: '%' }, { caption: 'CE', op: 'CE' }, { caption: 'C', op: 'C' }, { caption: '\u232B', op: 'backspace' }],
                        [{ caption: '7', digit: '7' }, { caption: '8', digit: '8' }, { caption: '9', digit: '9' }, { caption: '/', op: '/' }],
                        [{ caption: '4', digit: '4' }, { caption: '5', digit: '5' }, { caption: '6', digit: '6' }, { caption: '*', op: '*' }],
                        [{ caption: '1', digit: '1' }, { caption: '2', digit: '2' }, { caption: '3', digit: '3' }, { caption: '-', op: '-' }],
                        [{ caption: '0', digit: '0' }, { caption: '.', op: '.' }, { caption: '=', op: '=' }, { caption: '+', op: '+' }]
                    ];

                    for (const rowDef of buttons) {
                        const row = document.createElement('tr');
                        for (const btnDef of rowDef) {
                            const cell = document.createElement('td');
                            cell.style.padding = '0';
                            row.appendChild(cell);

                            const btn = new Button(cell);
                            btn.setCaption(btnDef.caption);
                            btn.Draw(cell);
                            btn.onClick = () => handleButton(btnDef.digit || null, btnDef.op || null);

                            const btnEl = btn.getElement();
                            if (btnEl) {
                                btnEl.style.width = '100%';
                                btnEl.style.height = '100%';
                                btnEl.style.fontSize = '18px';
                            }
                        }
                        table.appendChild(row);
                    }
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