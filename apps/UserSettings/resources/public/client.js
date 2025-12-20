(function () {
    const form = new Form();
    form.setTitle('User Settings');
    form.setWidth(450);
    form.setHeight(400);

    // Center manually to ensure initial position is correct
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    form.setX((screenWidth - 450) / 2);
    form.setY((screenHeight - 400) / 2);

    form.setAnchorToWindow('center');

    // Draw immediately with loading state
    form.Draw(document.body);

    const content = form.getContentArea();
    // Fix: Disable scrolling on the main content area so buttons stay fixed
    content.style.overflow = 'hidden';

    const loadingLabel = new Label(content);
    loadingLabel.setText('Loading settings...');
    loadingLabel.setX(10);
    loadingLabel.setY(10);
    loadingLabel.Draw(content);

    // Fetch settings
    (async () => {
        try {
            const data = await callServerMethod('UserSettings', 'getSettings', {});
            if (data.error) throw new Error(data.error);

            // Clear loading message
            loadingLabel.setText('');
            if (loadingLabel.element) loadingLabel.element.style.display = 'none';

            // Update title
            if (data.userName) {
                form.setTitle('User Settings - ' + data.userName);
            }

            renderSettingsForm(form, data.fields);
        } catch (e) {
            console.error('Error loading settings:', e);
            if (typeof showAlert === 'function') {
                showAlert('Failed to load settings: ' + e.message);
            } else {
                alert('Failed to load settings: ' + e.message);
            }
        }
    })();

    function renderSettingsForm(form, fields) {
        if (!fields) return;

        const content = form.getContentArea();

        // Settings Container (Scrollable)
        const scrollContainer = document.createElement('div');
        scrollContainer.style.position = 'absolute';
        scrollContainer.style.top = '10px';
        scrollContainer.style.left = '10px';
        scrollContainer.style.right = '10px';
        // Height will be dynamic
        scrollContainer.style.overflowY = 'auto';
        scrollContainer.style.overflowX = 'hidden';
        // No explicit border as requested to look cleaner
        content.appendChild(scrollContainer);

        let currentY = 10;
        const labelWidth = 140;
        const gap = 10;
        const controlX = labelWidth + gap + 10;
        const controlWidth = 230;

        const controlsMap = {};

        fields.forEach(field => {
            // Label
            const label = new Label(null);
            label.setText((field.displayName || field.name) + ':');
            label.setAlign('right');
            label.setWidth(labelWidth);

            label.setX(5);
            label.setY(currentY + 4);
            label.Draw(scrollContainer);

            // Control based on type
            const typeId = field.typeId;
            const value = field.value;

            let controlHeight = 22;

            if (typeId === 1 || typeId === 2) {
                // String or Number
                const tb = new TextBox(null);
                tb.setText(value !== null && value !== undefined ? String(value) : '');
                tb.setX(controlX);
                tb.setY(currentY);
                tb.setWidth(controlWidth);
                tb.setHeight(22);
                tb.Draw(scrollContainer);
                controlsMap[field.name] = tb;
            }
            else if (typeId === 3) {
                // Boolean -> CheckBox
                const cb = new Checkbox(null);
                cb.setChecked(!!value);
                cb.setX(controlX);
                cb.setY(currentY);
                cb.Draw(scrollContainer);
                controlsMap[field.name] = cb;
            }
            else if (typeId === 4) {
                // Date
                const tb = new TextBox(null);
                tb.setText(value ? String(value) : '');
                tb.setPlaceholder('YYYY-MM-DD');
                tb.setX(controlX);
                tb.setY(currentY);
                tb.setWidth(controlWidth);
                tb.setHeight(22);
                tb.Draw(scrollContainer);
                controlsMap[field.name] = tb;
            }
            else if (typeId === 5) {
                // Enum
                const options = field.options || [];

                if (options.length <= 3) {
                    const rg = new RadioGroup(null);
                    rg.setItems(options); // Items are strings
                    rg.setX(controlX);
                    rg.setY(currentY);
                    rg.setWidth(controlWidth);
                    rg.Draw(scrollContainer);
                    rg.setValue(value);
                    controlsMap[field.name] = rg;

                    controlHeight = options.length * 20;
                } else {
                    // Fallback to ComboBox
                    const combo = new ComboBox(null);
                    combo.setWidth(controlWidth);
                    combo.setHeight(22);
                    combo.setX(controlX);
                    combo.setY(currentY);
                    combo.setItems(options);

                    const index = options.indexOf(value);
                    if (index !== -1) combo.setSelectedIndex(index);
                    else if (options.length > 0) combo.setSelectedIndex(0);

                    combo.Draw(scrollContainer);
                    controlsMap[field.name] = combo;
                }
            } else {
                // ComboBox
                const combo = new ComboBox(null);
                combo.setWidth(controlWidth);
                combo.setHeight(22);
                combo.setX(controlX);
                combo.setY(currentY);
                combo.setItems(options);

                const index = options.indexOf(value);
                if (index !== -1) combo.setSelectedIndex(index);
                else if (options.length > 0) combo.setSelectedIndex(0);

                combo.Draw(scrollContainer);
                controlsMap[field.name] = combo;
            }

            currentY += Math.max(30, controlHeight + 10);
        });

        // Add bottom padding
        const spacer = document.createElement('div');
        spacer.style.height = '20px';
        spacer.style.position = 'absolute';
        spacer.style.top = currentY + 'px';
        spacer.style.width = '1px';
        scrollContainer.appendChild(spacer);


        // Buttons Area (Fixed at bottom)
        const btnOk = new Button(null);
        btnOk.setCaption('OK');
        btnOk.setWidth(80);
        btnOk.setHeight(26);
        btnOk.Draw(content);

        const btnApply = new Button(null);
        btnApply.setCaption('Apply');
        btnApply.setWidth(80);
        btnApply.setHeight(26);
        btnApply.Draw(content);

        const btnCancel = new Button(null);
        btnCancel.setCaption('Cancel');
        btnCancel.setWidth(80);
        btnCancel.setHeight(26);
        btnCancel.Draw(content);

        // Layout update function
        const updateLayout = () => {
            // Use setTimeout to ensure we get updated clientWidth/Height after resize frame
            const w = form.getWidth(); // Use form width instead of content area clientWidth which might be unreliable
            const contentH = content.clientHeight;

            // Adjust Scroll Container
            scrollContainer.style.height = (contentH - 50) + 'px'; // 50px for buttons
            // Ensure container width is correct for calculation
            scrollContainer.style.width = (w - 20) + 'px';

            form.setLayoutTarget(scrollContainer);
            form.setProportionalLayout(true);

            // Adjust Buttons
            const btnY = contentH - 35; // 35px from bottom

            // [OK] [Cancel] [Apply] - Right aligned logic
            // Apply at right
            btnApply.setX(w - 100);
            btnApply.setY(btnY);

            // Cancel left of Apply
            btnCancel.setX(w - 190);
            btnCancel.setY(btnY);

            // OK left of Cancel
            btnOk.setX(w - 280);
            btnOk.setY(btnY);

            // Trigger proportional layout update
            if (form.updateProportionalLayout) {
                form.updateProportionalLayout();
            }
        };



        // Enable proportional layout
        if (typeof form.setProportionalLayout === 'function') {
            form.setLayoutTarget(scrollContainer);
            form.setProportionalLayout(true);
        }

        // Initial Layout
        updateLayout();

        // Hook into Resize
        const originalOnResize = form.onResize ? form.onResize.bind(form) : null;
        form.onResize = () => {
            if (originalOnResize) originalOnResize();
            updateLayout();
        };
        // Also hook onResizing if available for smooth update
        form.onResizing = () => {
            updateLayout();
        };

        const saveSettings = async () => {
            const dataToSave = {};
            // Extract values
            fields.forEach(f => {
                const ctrl = controlsMap[f.name];
                if (ctrl) {
                    let val = null;
                    if (ctrl instanceof Checkbox) {
                        val = ctrl.checked;
                    } else if (ctrl instanceof RadioGroup) {
                        val = ctrl.getValue();
                    } else if (ctrl instanceof ComboBox) {
                        val = ctrl.getText();
                    } else if (ctrl instanceof TextBox) {
                        val = ctrl.getText();
                    }

                    // Coerce based on field type to avoid sending invalid values (e.g. "NaN")
                    if (f.typeId === 2) {
                        const num = parseFloat(val);
                        dataToSave[f.name] = isNaN(num) ? null : num;
                    } else if (f.typeId === 3) {
                        dataToSave[f.name] = !!val;
                    } else {
                        dataToSave[f.name] = val;
                    }
                }
            });

            try {
                const result = await callServerMethod('UserSettings', 'saveSettings', dataToSave);
                if (result.error) throw new Error(result.error);

                return true;
            } catch (e) {
                console.error(e);
                if (typeof showAlert === 'function') showAlert('Error saving settings: ' + e.message);
                else alert('Error saving settings: ' + e.message);
                return false;
            }
        };

        btnCancel.onClick = () => {
            form.close();
        };

        btnApply.onClick = async () => {
            const success = await saveSettings();
            if (success) {
                if (typeof showAlert === 'function') showAlert('Settings applied successfully!');
                else alert('Settings applied successfully!');
            }
        };

        btnOk.onClick = async () => {
            const success = await saveSettings();
            if (success) {
                form.close();
            }
        };
    }
})();
