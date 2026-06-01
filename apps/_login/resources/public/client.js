//Use classes from UI_classes.js file
//TextBox is used for text input
const loginForm = new Form()
loginForm.setTitle('Login');
loginForm.setWidth(300);
loginForm.setHeight(350);
loginForm.setX(100);
loginForm.setY(100);
loginForm.setAnchorToWindow('center');
//loginForm.setModal(true);

loginForm.lblUsername = null;
loginForm.txtUsername = null;
loginForm.lblPassword = null;
loginForm.txtPassword = null;
loginForm.lblConfirmPassword = null;
loginForm.txtConfirmPassword = null;
loginForm.btnLogin = null;
loginForm.btnCreate = null;
loginForm.btnGuest = null;
loginForm.btnCancel = null;
loginForm.contentArea = null;

loginForm.Draw = function (parent) {
    Form.prototype.Draw.call(this, parent);

    this.contentArea = this.getContentArea();
    if (!this.contentArea) return;

    // Username
    this.lblUsername = new Label(this.contentArea);
    this.lblUsername.setText('Username:');
    this.lblUsername.Draw(this.contentArea);

    this.txtUsername = new TextBox(this.contentArea);
    this.txtUsername.Draw(this.contentArea);

    // Password
    this.lblPassword = new Label(this.contentArea);
    this.lblPassword.setText('Password:');
    this.lblPassword.Draw(this.contentArea);

    this.txtPassword = new TextBox(this.contentArea);
    this.txtPassword.Draw(this.contentArea);
    this.txtPassword.element.type = 'password';

    // Confirm Password
    this.lblConfirmPassword = new Label(this.contentArea);
    this.lblConfirmPassword.setText('Confirm Password:');
    this.lblConfirmPassword.Draw(this.contentArea);
    this.lblConfirmPassword.setHidden(true);

    this.txtConfirmPassword = new TextBox(this.contentArea);
    this.txtConfirmPassword.Draw(this.contentArea);
    this.txtConfirmPassword.element.type = 'password';
    this.txtConfirmPassword.setHidden(true);

    // Buttons
    this.btnLogin = new Button(this.contentArea);
    this.btnLogin.setCaption('Login');
    this.btnLogin.Draw(this.contentArea);
    this.btnLogin.onClick = function () {
        const username = loginForm.txtUsername.getText();
        const password = loginForm.txtPassword.getText();
        
        callServerMethod('login', 'login', { username, password })
            .then(result => {
                if (result.success) {
                    location.reload();
                } else {
                    showAlert('Login failed: ' + result.error);
                }
            })
            .catch(err => {
                console.error('Error:', err);
                showAlert('Login error: ' + err.message);
            });
    };

    this.btnCreate = new Button(this.contentArea);
    this.btnCreate.setCaption('Create Login');
    this.btnCreate.Draw(this.contentArea);
    this.btnCreate.onClick = function () {
        if (loginForm.txtConfirmPassword.getHidden()) {
            // Show confirmation field
            loginForm.lblConfirmPassword.setHidden(false);
            loginForm.txtConfirmPassword.setHidden(false);
            
            // Hide login/guest, show cancel
            loginForm.btnLogin.setHidden(true);
            loginForm.btnGuest.setHidden(true);
            loginForm.btnCancel.setHidden(false);

            loginForm.btnCreate.setCaption('Confirm Create');
            loginForm.reDraw();
        } else {
            // Perform creation
            const username = loginForm.txtUsername.getText();
            const password = loginForm.txtPassword.getText();
            const confirm = loginForm.txtConfirmPassword.getText();

            if (password !== confirm) {
                showAlert('Passwords do not match!');
                return;
            }
            if (!username || !password) {
                showAlert('Username and password are required!');
                return;
            }

            callServerMethod('login', 'createUser', { username, password })
                .then(result => {
                    if (result.success) {
                        showAlert('User created! Logging in...', () => {
                            location.reload();
                        });
                    } else {
                        showAlert('Creation failed: ' + result.error);
                    }
                })
                .catch(err => {
                    console.error('Error:', err);
                    showAlert('Creation error: ' + err.message);
                });
        }
    };

    this.btnGuest = new Button(this.contentArea);
    this.btnGuest.setCaption('Login as Guest');
    this.btnGuest.Draw(this.contentArea);
    this.btnGuest.onClick = function () {
        callServerMethod('login', 'loginAsGuest', {})
            .then(result => {
                location.reload();
            })
            .catch(err => {
                console.error('Error: ' + err.message);
            });
    };

    this.btnCancel = new Button(this.contentArea);
    this.btnCancel.setCaption('Cancel');
    this.btnCancel.Draw(this.contentArea);
    this.btnCancel.setHidden(true);
    this.btnCancel.onClick = function () {
        loginForm.lblConfirmPassword.setHidden(true);
        loginForm.txtConfirmPassword.setHidden(true);
        loginForm.txtConfirmPassword.setText('');

        loginForm.btnLogin.setHidden(false);
        loginForm.btnGuest.setHidden(false);
        loginForm.btnCancel.setHidden(true);

        loginForm.btnCreate.setCaption('Create Login');
        loginForm.reDraw();
    };

    setTimeout(() => {
        this.reDraw();
    }, 50);
}

loginForm.reDraw = function () {
    if (!this.contentArea) return;

    const width = this.contentArea.clientWidth;
    const height = this.contentArea.clientHeight;

    // Determine visible elements
    const isConfirmVisible = !this.txtConfirmPassword.getHidden();

    // Element count: 2 label + 2 textbox + 3 button + 6 gap + 2 padding
    let numLabels = 2;
    let numTextboxes = 2;
    let numButtons = 0;
    let numGaps = 0;
    const numPaddings = 2;

    if (isConfirmVisible) {
        numLabels++;
        numTextboxes++;
    }

    // Count visible buttons
    if (!this.btnLogin.getHidden()) numButtons++;
    if (!this.btnCreate.getHidden()) numButtons++;
    if (!this.btnGuest.getHidden()) numButtons++;
    if (!this.btnCancel.getHidden()) numButtons++;

    const totalItems = numLabels + numTextboxes + numButtons;
    numGaps = Math.max(0, totalItems - 1);

    // Proportional to container height
    const minPadding = 16;
    const minGap = 8;
    const minLabelHeight = 16;
    const minElementHeight = 26;
    const minFontSize = 13;

    // Sum of minimum heights
    const minTotal = minPadding * 2 + minGap * numGaps + minLabelHeight * numLabels + minElementHeight * (numTextboxes + numButtons);
    const scale = Math.max(height / minTotal, 1);

    const padding = Math.round(minPadding * scale);
    const gap = Math.round(minGap * scale);
    const labelHeight = Math.round(minLabelHeight * scale);
    const elementHeight = Math.round(minElementHeight * scale);
    const fontSize = Math.round(minFontSize * scale);

    let currentTop = padding;
    const inputWidth = width - (padding * 2);

    // Helper to layout visible element
    const layoutElement = (el, h) => {
        if (!el.getHidden()) {
            UIObject.styleElement(el, padding, currentTop, inputWidth, h, fontSize, 1, false);
            currentTop += h + gap;
        }
    };

    // Username
    layoutElement(this.lblUsername, labelHeight);
    layoutElement(this.txtUsername, elementHeight);

    // Password
    layoutElement(this.lblPassword, labelHeight);
    layoutElement(this.txtPassword, elementHeight);

    // Confirm Password
    layoutElement(this.lblConfirmPassword, labelHeight);
    layoutElement(this.txtConfirmPassword, elementHeight);

    // Buttons - Vertical Column, Equal Sizes
    layoutElement(this.btnLogin, elementHeight);
    this.btnLogin.element.style.fontWeight = 'bold';

    layoutElement(this.btnCreate, elementHeight);
    layoutElement(this.btnGuest, elementHeight);
    layoutElement(this.btnCancel, elementHeight);
}

loginForm.onResizing = function () {
    this.reDraw();
}

loginForm.Draw(document.body);
