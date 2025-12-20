{
    const formCalc = new Form();
    formCalc.setTitle('Calculator');
    formCalc.setX(300);
    formCalc.setY(300);
    formCalc.setWidth(500);
    formCalc.setHeight(300);
    formCalc.setAnchorToWindow('center');
    formCalc.displayMemory = '0';
    formCalc.dotPressed = false;
    formCalc.operationGiven = false;
    formCalc.operation = null;
    formCalc.value1 = '';
    formCalc.value2 = '';
    formCalc.isError = false;

    formCalc.Draw = function (parent) {
        // Call base implementation
        Form.prototype.Draw.call(this, parent);

        // Create invisible 5x4 table (added row for TextBox)
        const table = document.createElement('table');
        this.getContentArea().appendChild(table);
        table.style.width = '100%';
        table.style.height = '100%';
        table.style.borderCollapse = 'collapse';
        table.style.tableLayout = 'fixed';

        // First row with TextBox (merged columns)
        const displayRow = document.createElement('tr');
        const displayCell = document.createElement('td');
        displayCell.colSpan = 4;
        displayCell.style.padding = '4px';
        displayCell.style.margin = '0';
        displayRow.appendChild(displayCell);
        table.appendChild(displayRow);

        // Create TextBox for result display
        const displayTextBox = new TextBox(displayCell);
        displayTextBox.setParent(formCalc)
        displayTextBox.setReadOnly(true);
        formCalc.refreshDisplay = function () {
            if (formCalc.isError) {
                displayTextBox.setText('Error');
                return;
            }
            displayTextBox.setText(formCalc.displayMemory);
        }
        displayTextBox.setText('0');
        displayTextBox.Draw(displayCell);

        const textBoxElement = displayTextBox.getElement();
        if (textBoxElement) {
            textBoxElement.style.width = '100%';
            textBoxElement.style.height = '40px';
            textBoxElement.style.fontSize = '24px';
            textBoxElement.style.textAlign = 'right';

            // Set row height based on TextBox height
            const textBoxHeight = textBoxElement.offsetHeight;
            const cellPadding = parseInt(displayCell.style.padding) * 2;
            const rowHeight = textBoxHeight + cellPadding;
            displayRow.style.height = rowHeight + 'px';
            displayCell.style.height = rowHeight + 'px';
        }

        // Create calculator buttons
        const buttons = [
            [{ caption: '%', digit: null, operation: '%' }, { caption: 'CE', digit: null, operation: 'CE' }, { caption: 'C', digit: null, operation: 'C' }, { caption: '⌫', digit: null, operation: 'backspace' }],
            [{ caption: '7', digit: '7', operation: null }, { caption: '8', digit: '8', operation: null }, { caption: '9', digit: '9', operation: null }, { caption: '/', digit: null, operation: '/' }],
            [{ caption: '4', digit: '4', operation: null }, { caption: '5', digit: '5', operation: null }, { caption: '6', digit: '6', operation: null }, { caption: '*', digit: null, operation: '*' }],
            [{ caption: '1', digit: '1', operation: null }, { caption: '2', digit: '2', operation: null }, { caption: '3', digit: '3', operation: null }, { caption: '-', digit: null, operation: '-' }],
            [{ caption: '0', digit: '0', operation: null }, { caption: '.', digit: null, operation: '.' }, { caption: '=', digit: null, operation: '=' }, { caption: '+', digit: null, operation: '+' }]
        ];

        let cellIndex = 0;

        for (let i = 0; i < buttons.length; i++) {
            const row = document.createElement('tr');
            for (let j = 0; j < buttons[i].length; j++) {

                const cell = document.createElement('td');
                cell.style.padding = '0';
                cell.style.margin = '0';
                row.appendChild(cell);

                const btn = new Button(cell);
                btn.setCaption(buttons[i][j].caption);
                btn.setParent(cell);
                btn.Draw(cell);
                btn.onClick = function () {
                    // Button click handling
                    if (buttons[i][j].digit) {
                        if (formCalc.isError) {
                            formCalc.isError = false;
                        }
                        if (formCalc.operationGiven) {
                            formCalc.displayMemory = '';
                            formCalc.operationGiven = false;
                        }
                        if (formCalc.displayMemory === '0') {
                            formCalc.displayMemory = '';
                        }
                        formCalc.displayMemory = formCalc.displayMemory + buttons[i][j].digit;
                    } else {
                        if (buttons[i][j].operation === '.' && !formCalc.dotPressed) {
                            formCalc.displayMemory = formCalc.displayMemory + '.';
                            formCalc.dotPressed = true;
                        } else if (buttons[i][j].operation === 'C') {
                            formCalc.isError = false;
                            formCalc.displayMemory = '0';
                            formCalc.operation = null;
                            formCalc.value1 = '0';
                            formCalc.value2 = '0';
                            formCalc.dotPressed = false;
                            formCalc.operationGiven = false;
                        } else if (buttons[i][j].operation === 'CE') {
                            formCalc.isError = false;
                            formCalc.value1 = '0';
                            formCalc.displayMemory = '0';
                            formCalc.dotPressed = false;
                        } else if (buttons[i][j].operation === 'backspace') {
                            if (formCalc.displayMemory.length > 1) {
                                if (formCalc.displayMemory.slice(-1) === '.') {
                                    formCalc.dotPressed = false;
                                }
                                formCalc.displayMemory = formCalc.displayMemory.slice(0, -1);
                            } else {
                                formCalc.displayMemory = '0';
                            }
                        } else if (['+', '-', '*', '/'].includes(buttons[i][j].operation)) {
                            formCalc.operation = buttons[i][j].operation;
                            formCalc.operationGiven = true;
                            formCalc.value1 = formCalc.displayMemory;
                            formCalc.value2 = '';
                        } else if (buttons[i][j].operation === '%') {
                            formCalc.displayMemory = (parseFloat(formCalc.displayMemory) / 100 * parseFloat(formCalc.value1)).toString();
                        } else if (buttons[i][j].operation === '=') {
                            if (formCalc.operation && formCalc.value1 !== '') {
                                if (formCalc.value2 === '') {
                                    formCalc.value2 = formCalc.displayMemory;
                                }
                                switch (formCalc.operation) {
                                    case '+':
                                        formCalc.displayMemory = (parseFloat(formCalc.value1) + parseFloat(formCalc.value2)).toString();
                                        break;
                                    case '-':
                                        formCalc.displayMemory = (parseFloat(formCalc.value1) - parseFloat(formCalc.value2)).toString();
                                        break;
                                    case '*':
                                        formCalc.displayMemory = (parseFloat(formCalc.value1) * parseFloat(formCalc.value2)).toString();
                                        break;
                                    case '/':
                                        if (parseFloat(formCalc.displayMemory) !== 0) {
                                            formCalc.displayMemory = (parseFloat(formCalc.value1) / parseFloat(formCalc.value2)).toString();
                                        } else {
                                            formCalc.displayMemory = '';
                                            formCalc.isError = true;
                                            formCalc.operationGiven = true;
                                        }
                                        break;
                                    case '%':
                                        formCalc.displayMemory = (parseFloat(formCalc.value1) % parseFloat(formCalc.value2)).toString();
                                        break;
                                }
                                formCalc.value1 = formCalc.displayMemory;
                            }
                        }
                    }
                    formCalc.refreshDisplay();
                }

                // Get button element and set its dimensions
                const btnElement = btn.getElement();
                if (btnElement) {
                    btnElement.style.width = '100%';
                    btnElement.style.height = '100%';
                    btnElement.style.fontSize = '18px';
                }
                cellIndex++;
            }
            table.appendChild(row);
        }

    };

    formCalc.doAction = function (action, params) {
        if (action === 'open') {
            // Show calculator form
            formCalc.Draw(document.body);
        }
    };
    formCalc.Draw(document.body);
}