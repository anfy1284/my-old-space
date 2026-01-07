// DynamicTable.js - Appending to UI_classes.js
// This content should be added to the end of UI_classes.js

// Dynamic Table Component with Virtual Scrolling
class DynamicTable extends UIObject {
    constructor(options) {
        super();

        // Configuration
        this.appName = options.appName || '';
        this.tableName = options.tableName || '';
        this.rowHeight = options.rowHeight || 25;
        this.multiSelect = options.multiSelect || false;
        this.currentSort = options.initialSort || [];
        this.currentFilters = options.initialFilter || [];

        // Callbacks
        this.onRowClick = options.onRowClick || null;
        this.onRowDoubleClick = options.onRowDoubleClick || null;
        this.onSelectionChanged = options.onSelectionChanged || null;

        // State
        this.totalRows = 0;
        this.fields = [];
        this.dataCache = new Map(); // rowIndex -> rowData
        this.selectedRows = new Set(); // Set of row indices
        this.lastSelectedIndex = null; // For shift-click range selection

        // DOM elements
        this.container = null;
        this.headerRow = null;
        this.scrollContainer = null;
        this.visibleRowsContainer = null;
        this.loadingOverlay = null;

        // SSE
        this.eventSource = null;

        // Virtual scrolling state
        this.firstVisibleRow = 0;
        this.visibleRowCount = 20;
        this.isLoading = false;
    }

    async Draw(container) {
        // Create main container
        this.container = document.createElement('div');
        this.container.className = 'dynamic-table-container';
        this.container.style.width = '100%';
        this.container.style.height = '100%';
        this.container.style.position = 'relative';
        this.container.style.backgroundColor = '#c0c0c0';
        this.container.style.border = '2px outset #dfdfdf';
        this.container.style.boxSizing = 'border-box';
        this.container.style.overflow = 'hidden';
        this.container.style.fontFamily = 'MS Sans Serif, sans-serif';
        this.container.style.fontSize = '11px';

        // Make focusable for keyboard navigation
        this.container.tabIndex = 0;
        this.container.style.outline = 'none';

        // Create header
        this.headerRow = document.createElement('div');
        this.headerRow.className = 'table-header';
        this.headerRow.style.display = 'flex';
        this.headerRow.style.backgroundColor = '#c0c0c0';
        this.headerRow.style.borderBottom = '2px solid #808080';
        this.headerRow.style.height = '26px';
        this.container.appendChild(this.headerRow);

        // Create scroll container for virtual scrolling
        this.scrollContainer = document.createElement('div');
        this.scrollContainer.className = 'table-scroll-container';
        this.scrollContainer.style.width = '100%';
        this.scrollContainer.style.height = 'calc(100% - 26px)';
        this.scrollContainer.style.position = 'relative';
        this.scrollContainer.style.overflowY = 'auto';
        this.scrollContainer.style.overflowX = 'hidden';
        this.scrollContainer.style.backgroundColor = '#ffffff';
        this.container.appendChild(this.scrollContainer);

        // Scroll content (tall div for virtual scrolling)
        const scrollContent = document.createElement('div');
        scrollContent.className = 'table-scroll-content';
        scrollContent.style.height = '0px'; // Will be set after data load
        scrollContent.style.position = 'relative';
        this.scrollContainer.appendChild(scrollContent);

        // Visible rows container (absolutely positioned)
        this.visibleRowsContainer = document.createElement('div');
        this.visibleRowsContainer.className = 'table-visible-rows';
        this.visibleRowsContainer.style.position = 'absolute';
        this.visibleRowsContainer.style.top = '0px';
        this.visibleRowsContainer.style.left = '0px';
        this.visibleRowsContainer.style.width = '100%';
        scrollContent.appendChild(this.visibleRowsContainer);

        // Append to parent container
        if (container) {
            container.appendChild(this.container);
        }

        // Setup event listeners
        this.setupEventListeners();

        // Load initial data
        await this.loadData(0);

        // Connect SSE
        this.connectSSE();

        this.element = this.container;
        return this.container;
    }

    setupEventListeners() {
        // Scroll event for virtual scrolling
        this.scrollContainer.addEventListener('scroll', () => {
            this.handleScroll();
        });

        // Keyboard navigation
        this.container.addEventListener('keydown', (e) => {
            this.handleKeyPress(e);
        });
    }

    async loadData(firstRow) {
        if (this.isLoading) return;
        this.isLoading = true;
        this.showLoading(true);

        try {
            const method = this.fields.length === 0 ? 'initDynamicTable' : 'getDynamicTableData';
            const result = await callServerMethod(this.appName, method, {
                tableName: this.tableName,
                firstRow: firstRow,
                visibleRows: this.visibleRowCount,
                sort: this.currentSort,
                filters: this.currentFilters
            });

            this.totalRows = result.totalRows;
            this.fields = result.fields;

            // Update data cache
            for (let i = 0; i < result.data.length; i++) {
                const rowIndex = result.range.from + i;
                this.dataCache.set(rowIndex, { ...result.data[i], __index: rowIndex, loaded: true });
            }

            // Render header if this is first load
            if (method === 'initDynamicTable') {
                this.renderHeader();
            }

            // Update scroll content height
            const scrollContent = this.scrollContainer.querySelector('.table-scroll-content');
            scrollContent.style.height = (this.totalRows * this.rowHeight) + 'px';

            // Render visible rows
            this.renderVisibleRows();

        } catch (error) {
            console.error('[DynamicTable] Load error:', error);
            if (typeof showAlert === 'function') {
                showAlert('Ошибка загрузки данных: ' + error.message);
            } else {
                alert('Ошибка загрузки данных: ' + error.message);
            }
        } finally {
            this.isLoading = false;
            this.showLoading(false);
        }
    }

    renderHeader() {
        this.headerRow.innerHTML = '';

        this.fields.forEach((field, index) => {
            const headerCell = document.createElement('div');
            headerCell.className = 'header-cell';
            headerCell.style.flex = `0 0 ${field.width}px`;
            headerCell.style.minWidth = `${field.width}px`;
            headerCell.style.height = '100%';
            headerCell.style.display = 'flex';
            headerCell.style.alignItems = 'center';
            headerCell.style.padding = '0 4px';
            headerCell.style.backgroundColor = '#c0c0c0';
            headerCell.style.border = '2px outset #dfdfdf';
            headerCell.style.boxSizing = 'border-box';
            headerCell.style.fontWeight = 'bold';
            headerCell.style.cursor = 'pointer';
            headerCell.style.userSelect = 'none';
            headerCell.style.position = 'relative';
            headerCell.textContent = field.caption;
            headerCell.dataset.fieldName = field.name;

            // Click to sort
            headerCell.addEventListener('click', () => {
                this.toggleSort(field.name);
            });

            // Resize handle
            const resizeHandle = document.createElement('div');
            resizeHandle.className = 'resize-handle';
            resizeHandle.style.position = 'absolute';
            resizeHandle.style.right = '0';
            resizeHandle.style.top = '0';
            resizeHandle.style.width = '4px';
            resizeHandle.style.height = '100%';
            resizeHandle.style.cursor = 'col-resize';
            resizeHandle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                this.startColumnResize(index, e);
            });
            headerCell.appendChild(resizeHandle);

            this.headerRow.appendChild(headerCell);
        });
    }

    renderVisibleRows() {
        const scrollTop = this.scrollContainer.scrollTop;
        const firstVisibleRow = Math.floor(scrollTop / this.rowHeight);
        this.firstVisibleRow = firstVisibleRow;

        // Calculate visible range
        const containerHeight = this.scrollContainer.clientHeight;
        const visibleRowCount = Math.ceil(containerHeight / this.rowHeight) + 2; // +2 for buffer
        this.visibleRowCount = visibleRowCount;

        // Clear existing rows
        this.visibleRowsContainer.innerHTML = '';

        // Position container
        this.visibleRowsContainer.style.top = (firstVisibleRow * this.rowHeight) + 'px';

        // Render visible rows
        for (let i = 0; i < visibleRowCount && (firstVisibleRow + i) < this.totalRows; i++) {
            const rowIndex = firstVisibleRow + i;
            const rowData = this.dataCache.get(rowIndex);
            const rowElement = this.renderRow(rowData, rowIndex);
            this.visibleRowsContainer.appendChild(rowElement);
        }
    }

    renderRow(rowData, rowIndex) {
        const row = document.createElement('div');
        row.className = 'table-row';
        row.style.display = 'flex';
        row.style.height = this.rowHeight + 'px';
        row.style.boxSizing = 'border-box';
        row.dataset.rowIndex = rowIndex;

        // Zebra striping
        if (rowIndex % 2 === 0) {
            row.style.backgroundColor = '#ffffff';
        } else {
            row.style.backgroundColor = '#f0f0f0';
        }

        // Selection highlighting
        if (this.selectedRows.has(rowIndex)) {
            row.style.backgroundColor = '#000080';
            row.style.color = '#ffffff';
        }

        // Unloaded row styling
        if (!rowData || !rowData.loaded) {
            row.style.opacity = '0.3';
        }

        // Add cells
        this.fields.forEach(field => {
            const cell = document.createElement('div');
            cell.className = 'table-cell';
            cell.style.flex = `0 0 ${field.width}px`;
            cell.style.minWidth = `${field.width}px`;
            cell.style.height = '100%';
            cell.style.padding = '4px 8px';
            cell.style.borderRight = '1px solid #c0c0c0';
            cell.style.boxSizing = 'border-box';
            cell.style.overflow = 'hidden';
            cell.style.textOverflow = 'ellipsis';
            cell.style.whiteSpace = 'nowrap';
            cell.style.display = 'flex';
            cell.style.alignItems = 'center';

            if (rowData && rowData.loaded) {
                const value = field.foreignKey ? rowData[`__${field.name}_display`] : rowData[field.name];
                const fieldElement = this.createFieldElement(field, value, true);
                if (fieldElement) {
                    cell.appendChild(fieldElement);
                }
            } else {
                // Unloaded: show empty element
                const fieldElement = this.createFieldElement(field, null, false);
                if (fieldElement) {
                    cell.appendChild(fieldElement);
                }
            }

            row.appendChild(cell);
        });

        // Click events
        row.addEventListener('click', (e) => {
            this.handleRowClick(rowIndex, e);
        });

        row.addEventListener('dblclick', (e) => {
            this.handleRowDoubleClick(rowIndex, e);
        });

        return row;
    }

    createFieldElement(field, value, loaded) {
        if (value === null || value === undefined) {
            value = '';
        }

        let element = null;

        switch (field.type) {
            case 'BOOLEAN':
                const checkbox = new CheckBox();
                checkbox.setChecked(!!value);
                checkbox.setReadOnly(true);
                const frag = document.createDocumentFragment();
                checkbox.Draw(frag);
                element = checkbox.element;
                break;

            case 'DATE':
            case 'DATEONLY':
                const datePicker = new DatePicker();
                if (value) {
                    datePicker.setValue(new Date(value));
                }
                datePicker.setShowTime(false);
                datePicker.setReadOnly(true);
                const fragDate = document.createDocumentFragment();
                datePicker.Draw(fragDate);
                element = datePicker.element;
                break;

            case 'TIMESTAMP':
                const timestampPicker = new DatePicker();
                if (value) {
                    timestampPicker.setValue(new Date(value));
                }
                timestampPicker.setShowTime(true);
                timestampPicker.setReadOnly(true);
                const fragTimestamp = document.createDocumentFragment();
                timestampPicker.Draw(fragTimestamp);
                element = timestampPicker.element;
                break;

            case 'DECIMAL':
            case 'FLOAT':
                const numBox = new TextBox();
                numBox.setText(value !== '' ? parseFloat(value).toFixed(2) : '');
                numBox.setReadOnly(true);
                const fragNum = document.createDocumentFragment();
                numBox.Draw(fragNum);
                element = numBox.element;
                element.style.width = '100%';
                element.style.border = 'none';
                element.style.backgroundColor = 'transparent';
                element.style.padding = '0';
                break;

            default: // STRING, INTEGER, etc.
                const textBox = new TextBox();
                textBox.setText(String(value));
                textBox.setReadOnly(true);
                const fragText = document.createDocumentFragment();
                textBox.Draw(fragText);
                element = textBox.element;
                element.style.width = '100%';
                element.style.border = 'none';
                element.style.backgroundColor = 'transparent';
                element.style.padding = '0';
        }

        return element;
    }

    handleScroll() {
        const scrollTop = this.scrollContainer.scrollTop;
        const firstVisibleRow = Math.floor(scrollTop / this.rowHeight);

        // Check if we need to load more data
        const bufferSize = 10;
        const cacheStart = Math.min(...Array.from(this.dataCache.keys()));
        const cacheEnd = Math.max(...Array.from(this.dataCache.keys()));

        if (this.dataCache.size === 0 ||
            firstVisibleRow < cacheStart + bufferSize ||
            firstVisibleRow + this.visibleRowCount > cacheEnd - bufferSize) {
            // Need to load more data
            this.loadData(firstVisibleRow);
        } else {
            // Just re-render with cached data
            this.renderVisibleRows();
        }
    }

    handleRowClick(rowIndex, event) {
        const rowData = this.dataCache.get(rowIndex);

        if (event.shiftKey && this.multiSelect && this.lastSelectedIndex !== null) {
            // Range selection
            const start = Math.min(this.lastSelectedIndex, rowIndex);
            const end = Math.max(this.lastSelectedIndex, rowIndex);
            for (let i = start; i <= end; i++) {
                this.selectedRows.add(i);
            }
        } else {
            // Single selection
            if (!this.multiSelect) {
                this.selectedRows.clear();
            }
            this.selectedRows.add(rowIndex);
            this.lastSelectedIndex = rowIndex;
        }

        this.renderVisibleRows();

        if (this.onRowClick && rowData) {
            this.onRowClick(rowData, rowIndex);
        }

        if (this.onSelectionChanged) {
            this.onSelectionChanged(this.getSelectedRows());
        }
    }

    handleRowDoubleClick(rowIndex, event) {
        const rowData = this.dataCache.get(rowIndex);

        if (!rowData || !rowData.loaded) {
            if (typeof showAlert === 'function') {
                showAlert('Данные ещё не загружены. Подождите.');
            } else {
                alert('Данные ещё не загружены. Подождите.');
            }
            return;
        }

        if (this.onRowDoubleClick) {
            this.onRowDoubleClick(rowData, rowIndex);
        }
    }

    handleKeyPress(event) {
        if (this.selectedRows.size === 0) {
            // No selection, select first row
            if (this.totalRows > 0) {
                this.selectedRows.add(0);
                this.lastSelectedIndex = 0;
                this.scrollToRow(0);
                this.renderVisibleRows();
                if (this.onSelectionChanged) {
                    this.onSelectionChanged(this.getSelectedRows());
                }
            }
            return;
        }

        const currentIndex = this.lastSelectedIndex || Array.from(this.selectedRows)[0];
        let newIndex = currentIndex;

        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                newIndex = Math.min(currentIndex + 1, this.totalRows - 1);
                break;

            case 'ArrowUp':
                event.preventDefault();
                newIndex = Math.max(currentIndex - 1, 0);
                break;

            case 'PageDown':
                event.preventDefault();
                newIndex = Math.min(currentIndex + this.visibleRowCount, this.totalRows - 1);
                break;

            case 'PageUp':
                event.preventDefault();
                newIndex = Math.max(currentIndex - this.visibleRowCount, 0);
                break;

            case 'Home':
                event.preventDefault();
                newIndex = 0;
                break;

            case 'End':
                event.preventDefault();
                newIndex = this.totalRows - 1;
                break;

            case 'Enter':
                event.preventDefault();
                this.handleRowDoubleClick(currentIndex, event);
                return;

            default:
                return;
        }

        if (newIndex !== currentIndex) {
            if (!event.shiftKey || !this.multiSelect) {
                this.selectedRows.clear();
            }
            this.selectedRows.add(newIndex);
            this.lastSelectedIndex = newIndex;
            this.scrollToRow(newIndex);
            this.renderVisibleRows();

            if (this.onSelectionChanged) {
                this.onSelectionChanged(this.getSelectedRows());
            }
        }
    }

    scrollToRow(rowIndex) {
        const scrollTop = this.scrollContainer.scrollTop;
        const containerHeight = this.scrollContainer.clientHeight;
        const rowTop = rowIndex * this.rowHeight;
        const rowBottom = rowTop + this.rowHeight;

        if (rowTop < scrollTop) {
            // Row is above viewport
            this.scrollContainer.scrollTop = rowTop;
        } else if (rowBottom > scrollTop + containerHeight) {
            // Row is below viewport
            this.scrollContainer.scrollTop = rowBottom - containerHeight;
        }
    }

    toggleSort(fieldName) {
        // Find existing sort on this field
        const existingIndex = this.currentSort.findIndex(s => s.field === fieldName);

        if (existingIndex >= 0) {
            // Toggle order
            const currentOrder = this.currentSort[existingIndex].order;
            this.currentSort[existingIndex].order = currentOrder === 'asc' ? 'desc' : 'asc';
        } else {
            // Add new sort
            this.currentSort = [{ field: fieldName, order: 'asc' }];
        }

        // Reload data
        this.dataCache.clear();
        this.loadData(this.firstVisibleRow);
    }

    startColumnResize(columnIndex, event) {
        const startX = event.clientX;
        const startWidth = this.fields[columnIndex].width;

        const onMouseMove = (e) => {
            const delta = e.clientX - startX;
            const newWidth = Math.max(50, startWidth + delta);
            this.fields[columnIndex].width = newWidth;

            // Update header cell width
            const headerCells = this.headerRow.querySelectorAll('.header-cell');
            if (headerCells[columnIndex]) {
                headerCells[columnIndex].style.flex = `0 0 ${newWidth}px`;
                headerCells[columnIndex].style.minWidth = `${newWidth}px`;
            }

            // Re-render rows to update cell widths
            this.renderVisibleRows();
        };

        const onMouseUp = (e) => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            // Save column state
            this.saveColumnWidths();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    async saveColumnWidths() {
        try {
            const columnData = this.fields.map(f => ({ name: f.name, width: f.width }));
            await callServerMethod(this.appName, 'saveClientState', {
                window: `${this.appName}Form`,
                component: `${this.tableName}Table`,
                data: { columns: columnData }
            });
        } catch (e) {
            console.error('[DynamicTable] Failed to save column widths:', e.message);
        }
    }

    connectSSE() {
        try {
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
                        this.refresh();
                    } else if (data.type === 'rowUpdate') {
                        console.log('[DynamicTable] Row update:', data.rowId);
                        // Could implement targeted row update here
                        this.refresh();
                    }
                } catch (e) {
                    console.error('[DynamicTable] SSE message parse error:', e.message);
                }
            };

            this.eventSource.onerror = (error) => {
                console.error('[DynamicTable] SSE error, reconnecting in 3s...');
                if (this.eventSource) {
                    this.eventSource.close();
                    this.eventSource = null;
                }

                setTimeout(() => {
                    if (!this.eventSource) {
                        this.connectSSE();
                    }
                }, 3000);
            };
        } catch (e) {
            console.error('[DynamicTable] Failed to setup SSE:', e.message);
        }
    }

    showLoading(show) {
        if (show) {
            if (!this.loadingOverlay) {
                this.loadingOverlay = document.createElement('div');
                this.loadingOverlay.className = 'table-loading-overlay';
                this.loadingOverlay.style.position = 'absolute';
                this.loadingOverlay.style.top = '0';
                this.loadingOverlay.style.left = '0';
                this.loadingOverlay.style.right = '0';
                this.loadingOverlay.style.bottom = '0';
                this.loadingOverlay.style.background = 'rgba(192, 192, 192, 0.7)';
                this.loadingOverlay.style.display = 'flex';
                this.loadingOverlay.style.alignItems = 'center';
                this.loadingOverlay.style.justifyContent = 'center';
                this.loadingOverlay.style.zIndex = '1000';

                const label = document.createElement('div');
                label.textContent = 'Loading...';
                label.style.padding = '10px 20px';
                label.style.backgroundColor = '#c0c0c0';
                label.style.border = '2px outset #dfdfdf';
                label.style.fontFamily = 'MS Sans Serif, sans-serif';
                label.style.fontSize = '11px';
                label.style.fontWeight = 'bold';
                this.loadingOverlay.appendChild(label);
            }
            this.container.appendChild(this.loadingOverlay);
        } else {
            if (this.loadingOverlay && this.loadingOverlay.parentElement) {
                this.loadingOverlay.parentElement.removeChild(this.loadingOverlay);
            }
        }
    }

    // Public API methods
    async refresh() {
        this.dataCache.clear();
        await this.loadData(this.firstVisibleRow);
    }

    setSort(sortArray) {
        this.currentSort = sortArray;
        this.dataCache.clear();
        this.loadData(this.firstVisibleRow);
    }

    setFilter(filterArray) {
        this.currentFilters = filterArray;
        this.dataCache.clear();
        this.loadData(0); // Reset to first row
        this.scrollContainer.scrollTop = 0;
    }

    getSelectedRows() {
        return Array.from(this.selectedRows)
            .map(index => this.dataCache.get(index))
            .filter(row => row && row.loaded);
    }

    clearSelection() {
        this.selectedRows.clear();
        this.lastSelectedIndex = null;
        this.renderVisibleRows();
        if (this.onSelectionChanged) {
            this.onSelectionChanged([]);
        }
    }

    destroy() {
        // Close SSE connection
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }

        // Remove event listeners
        // (automatically removed when element is removed from DOM)

        // Remove element
        if (this.element && this.element.parentElement) {
            this.element.parentElement.removeChild(this.element);
        }
    }
}
