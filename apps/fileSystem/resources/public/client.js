{
    // Copy of callServerMethod for standalone loading
    function callServerMethod(app, method, params = {}) {
        return fetch('/app/call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app, method, params })
        })
            .then(r => r.json())
            .then(data => {
                if ('error' in data) throw new Error(data.error);
                return data.result;
            });
    }

    const form = new Form();
    form.setTitle('File System Explorer');
    form.setX(100);
    form.setY(100);
    form.setWidth(1000);
    form.setHeight(700);
    form.setAnchorToWindow('center');

    // Current directory
    let currentDirId = null;
    let selectedFileId = null;
    // Last loaded file list (used for keyboard open)
    let lastFiles = [];
    // When viewing an archive, this object holds { name, fileId, entries, currentPath }
    let viewingArchive = null;
    // Navigation history (for Back)
    const backStack = [];

    // Create main container
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.height = '100%';
    container.style.width = '100%';
    container.style.boxSizing = 'border-box';



    // Right panel - file list
    const filePanel = document.createElement('div');
    filePanel.style.flex = '1'; // Fill the container width
    filePanel.style.width = '100%'; // Ensure full width
    filePanel.style.height = '100%';

    filePanel.style.padding = '0'; // Remove general padding
    filePanel.style.paddingLeft = '5px'; // Add side/bottom padding for the list content area effectively
    filePanel.style.paddingRight = '5px';
    filePanel.style.paddingBottom = '5px';
    // Toolbar is at the top, we want 0 top padding for it.
    filePanel.style.boxSizing = 'border-box';
    filePanel.style.display = 'flex';
    filePanel.style.flexDirection = 'column';
    filePanel.style.overflow = 'hidden'; // Prevent outer scroll 
    filePanel.style.backgroundColor = '#d4d0c8'; // Win98 background gray

    // Address Bar Row
    const addressRow = document.createElement('div');
    addressRow.style.display = 'flex';
    addressRow.style.alignItems = 'center';
    addressRow.style.padding = '2px 5px';
    addressRow.style.marginBottom = '2px';



    // Navigation buttons container (home, back, up) rendered with ToolbarButton to match style
    const navContainer = document.createElement('div');
    navContainer.style.display = 'flex';
    navContainer.style.gap = '4px';
    navContainer.style.marginRight = '6px';

    // Create toolbar-style nav buttons and draw them into navContainer
    const btnHome = new ToolbarButton();
    btnHome.setText('');
    btnHome.setIcon('🏠');
    btnHome.setTooltip('Home');
    btnHome.Draw(navContainer);
    if (btnHome.element) btnHome.element.style.cursor = 'pointer';

    const btnBack = new ToolbarButton();
    btnBack.setText('');
    btnBack.setIcon('◀');
    btnBack.setTooltip('Back');
    btnBack.Draw(navContainer);
    if (btnBack.element) btnBack.element.style.cursor = 'pointer';

    const btnUp = new ToolbarButton();
    btnUp.setText('');
    btnUp.setIcon('🔼');
    btnUp.setTooltip('Up');
    btnUp.Draw(navContainer);
    if (btnUp.element) btnUp.element.style.cursor = 'pointer';

    addressRow.appendChild(navContainer);

    // Using UI_classes TextBox
    const addressInput = new TextBox();
    addressInput.setText('\\');
    // Manually adjust width to fill flexibility
    addressInput.Draw(addressRow);
    addressInput.element.style.position = 'relative';
    addressInput.element.style.flex = '1';
    // Make address input same height as toolbar buttons
    addressInput.element.style.height = '24px';
    addressInput.element.style.top = '0';
    addressInput.element.style.left = '0';
    // Slightly larger font for address bar
    addressInput.element.style.fontSize = '14px';

    // Flag to ignore programmatic updates
    let ignoreAddressChange = false;
    // Prevent duplicate navigation calls (Enter + blur)
    let addressNavLock = false;

    async function onAddressChangeEvent() {
        if (ignoreAddressChange) return;
        if (addressNavLock) return;
        addressNavLock = true;
        const raw = (addressInput.getText() || '').trim();
        try {
            await navigateToAddress(raw);
        } catch (e) {
            // showAlert may open modal; ensure lock released after
            showAlert('Address navigation error: ' + (e.message || e));
        } finally {
            // release lock slightly later to allow blur/enter sequence to finish
            setTimeout(() => { addressNavLock = false; }, 50);
        }
    }

    // Enter and blur should trigger navigation
    addressInput.element.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            onAddressChangeEvent();
        }
    });
    addressInput.element.addEventListener('blur', () => onAddressChangeEvent());

    addressRow.appendChild(addressInput.element);

    filePanel.appendChild(addressRow);

    // Toolbar
    const toolbar = new Toolbar(filePanel);

    // New Folder
    const btnNewFolder = new ToolbarButton();
    btnNewFolder.setText('New Folder');
    btnNewFolder.setIcon('📁');
    btnNewFolder.setTooltip('Create new folder');
    btnNewFolder.onClick = () => createFolder();
    toolbar.addItem(btnNewFolder);

    // Separator
    toolbar.addItem(new ToolbarSeparator());

    // Upload
    const btnUpload = new ToolbarButton();
    btnUpload.setText('Upload');
    btnUpload.setIcon('📤');
    btnUpload.setTooltip('Upload files');
    btnUpload.onClick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = (e) => uploadFiles(e.target.files);
        input.click();
    };
    toolbar.addItem(btnUpload);

    // Download
    const btnDownload = new ToolbarButton();
    btnDownload.setText('Download');
    btnDownload.setIcon('📥');
    btnDownload.setTooltip('Download selected file');
    btnDownload.onClick = () => downloadSelected();
    toolbar.addItem(btnDownload);

    // Delete
    const btnDelete = new ToolbarButton();
    btnDelete.setText('Delete');
    btnDelete.setIcon('🗑️');
    btnDelete.setTooltip('Delete selected file');
    btnDelete.onClick = () => deleteSelected();
    toolbar.addItem(btnDelete);

    // File list
    const fileList = document.createElement('div');
    fileList.style.flex = '1';
    fileList.style.border = '2px inset #ffffff'; // Win98 inset style often uses light/dark combination, standard inset is fine
    fileList.style.backgroundColor = '#ffffff'; // White background required
    fileList.style.padding = '5px';
    fileList.style.boxSizing = 'border-box';
    fileList.style.overflowY = 'auto';
    // Grid layout for multi-column files
    // Grid layout for multi-column files (Column-Major)
    fileList.style.display = 'grid';
    // Fill vertical space first 
    fileList.style.gridAutoFlow = 'column';
    // Rows fixed height, fill available height
    fileList.style.gridTemplateRows = 'repeat(auto-fill, 24px)';
    // Columns dynamic width
    fileList.style.gridAutoColumns = 'minmax(200px, 1fr)';
    fileList.style.gap = '0 5px'; // Gap between columns primarily

    // prevent default browser behavior for drag and drop globally
    window.addEventListener('dragover', function (e) {
        e.preventDefault();
    }, false);
    window.addEventListener('drop', function (e) {
        e.preventDefault();
    }, false);

    toolbar.Draw(filePanel); // Render toolbar

    filePanel.appendChild(fileList);


    container.appendChild(filePanel);

    form.Draw(document.body);
    const contentArea = form.getContentArea();
    contentArea.appendChild(container);



    // Load files
    loadFiles();

    // Event listeners


    // Drag and drop for file panel
    filePanel.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation(); // Stop bubbling so window listener doesn't interfere if needed, though preventDefault is key
        // Optional: Add visual feedback for drop zone if needed, but user requested "not visually distinct" usually means mostly invisible
        // or just subtle. The requirement was "not be allocated separately". 
    });

    filePanel.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            uploadFiles(e.dataTransfer.files);
        }
    });



    async function loadFiles() {
        try {
            if (viewingArchive) {
                // Render current archive folder contents (entries have parentPath)
                const curPath = viewingArchive.currentPath || '';
                const files = viewingArchive.entries.filter(x => (x.parentPath || '') === curPath);
                lastFiles = files;
                await updateAddress(currentDirId);
                renderFiles(files);
            } else {
                const files = await callServerMethod('fileSystem', 'getFiles', { parentId: currentDirId || null });
                lastFiles = files || [];
                await updateAddress(currentDirId);
                renderFiles(files);
            }
        } catch (err) {
            // Use showAlert instead of console.error for user-visible errors
            showAlert('Error loading files: ' + (err.message || err));
        }
    }

    // Update address input to show full path for current directory
    async function updateAddress(dirId) {
        // If viewing archive, build full address from parent directory + archive name + internal path
        if (viewingArchive) {
            try {
                const parts = [];
                // build parent path from parentDirId if available
                let curParent = viewingArchive.parentDirId;
                while (curParent) {
                    const folder = await callServerMethod('fileSystem', 'getFolder', { id: curParent });
                    if (!folder) break;
                    parts.unshift(folder.name || String(folder.id));
                    curParent = folder.parentId || null;
                }
                const cur = viewingArchive.currentPath || '';
                let addr = '\\' + (parts.length ? parts.join('\\') + '\\' : '') + viewingArchive.name;
                if (cur) addr += '\\' + cur.replace(/\//g, '\\');
                ignoreAddressChange = true;
                addressInput.setText(addr);
                setTimeout(() => { ignoreAddressChange = false; }, 0);
            } catch (e) {
                // Fallback to simple display if resolving parent fails
                const parts = ['\\' + viewingArchive.name];
                const cur = viewingArchive.currentPath || '';
                if (cur) parts.push(cur.replace(/\//g, '\\'));
                ignoreAddressChange = true;
                addressInput.setText(parts.join('\\'));
                setTimeout(() => { ignoreAddressChange = false; }, 0);
            }
            return;
        }

        if (!dirId) {
            addressInput.setText('\\');
            return;
        }

        try {
            const parts = [];
            let cur = dirId;
            // Walk up parents until root
            while (cur) {
                const folder = await callServerMethod('fileSystem', 'getFolder', { id: cur });
                if (!folder) break;
                parts.unshift(folder.name || String(folder.id));
                cur = folder.parentId || null;
            }
            addressInput.setText('\\' + parts.join('\\'));
        } catch (e) {
            showAlert('Error resolving path: ' + (e.message || e));
        }
    }

    function renderFiles(files) {
        fileList.innerHTML = '';
        files.forEach(file => {
            const item = document.createElement('div');
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.padding = '2px';
            item.style.cursor = 'default';
            item.style.userSelect = 'none';
            item.style.boxSizing = 'border-box'; // Ensure resizing works well
            item.style.height = '24px'; // Fixed height for list items in grid
            item.style.overflow = 'hidden'; // Prevent text spill

            // Selection style
            if (file.id === selectedFileId) {
                item.style.backgroundColor = '#000080';
                item.style.color = '#ffffff';
            } else {
                item.style.backgroundColor = 'transparent';
                item.style.color = '#000000';
            }

            const icon = document.createElement('span');
            // Use helper to pick icon by file type; folders keep folder icon
            if (file.isFolder) icon.textContent = '📁';
            else icon.textContent = getIconForFileType(file.name);
            icon.style.marginRight = '5px';
            icon.style.display = 'flex';
            icon.style.alignItems = 'center';
            icon.style.justifyContent = 'center';
            icon.style.lineHeight = '1';

            const name = document.createElement('span');
            name.textContent = file.name;
            name.style.lineHeight = '1'; // Ensure text doesn't push bounds
            name.style.whiteSpace = 'nowrap';
            name.style.overflow = 'hidden';
            name.style.textOverflow = 'ellipsis'; // Truncate long names

            item.appendChild(icon);
            item.appendChild(name);

            // Click -> Select
            item.onclick = (e) => {
                e.stopPropagation();
                selectedFileId = file.id;
                renderFiles(files); // Re-render to show selection
            };

            // DblClick -> Open (folder or file)
            item.ondblclick = (e) => {
                e.stopPropagation();
                openSelected(file.id);
            };

            fileList.appendChild(item);
        });
    }

    // Choose icon by filename/extension. Easy to extend via switch-case.
    function getIconForFileType(name) {
        const ext = (name || '').toLowerCase().split('.').slice(-1)[0] || '';
        switch (ext) {
            case 'zip':
            case 'jar':
            case 'apk':
                return '🗜️';
            case 'png':
            case 'jpg':
            case 'jpeg':
            case 'gif':
                return '🖼️';
            case 'txt':
            case 'md':
            case 'log':
                return '📄';
            case 'js':
            case 'ts':
            case 'json':
                return '📜';
            case 'pdf':
                return '📕';
            case 'mp3':
            case 'wav':
                return '🎵';
            case 'mp4':
            case 'mov':
                return '🎬';
            default:
                return '📄';
        }
    }

    // Open folder by id (used by dblclick and Enter key)
    // Open selected item by id. If it's a folder - navigate into it; otherwise download the file.
    async function openSelected(itemId, pushToBack = true) {
        try {
            // If we're currently viewing an archive and itemId is an archive-entry id (format: zip:<fileId>:<entryPath>)
            if (viewingArchive && String(itemId).startsWith('zip:')) {
                const payload = String(itemId).slice(4);
                const sep = payload.indexOf(':');
                const fileIdFromId = payload.slice(0, sep);
                const entryPath = payload.slice(sep + 1);
                const entry = viewingArchive.entries.find(x => x.path === entryPath);
                if (!entry) return;
                if (entry.isFolder) {
                    // navigate inside archive
                    if (pushToBack) backStack.push({ type: 'archive', snapshot: JSON.parse(JSON.stringify(viewingArchive)) });
                    viewingArchive.currentPath = entry.path;
                    selectedFileId = null;
                    await loadFiles();
                    return;
                }
                // file inside archive: request server to extract entry and download
                try {
                    const res = await callServerMethod('fileSystem', 'extractArchiveEntry', { fileId: fileIdFromId, entryPath: entry.path });
                    if (res && res.error) return showAlert(res.error);
                    const blob = base64ToBlob(res.file.data, 'application/octet-stream');
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = res.file.name;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                } catch (err) {
                    showAlert('Failed to extract archive entry: ' + (err.message || err));
                }
                return;
            }

            let f = lastFiles.find(x => x.id === itemId);

            // If not found or unclear, try to fetch folder metadata. If that throws, treat as file.
            if (!f) {
                try {
                    const meta = await callServerMethod('fileSystem', 'getFolder', { id: itemId });
                    if (meta && meta.isFolder) f = meta;
                } catch (err) {
                    // getFolder failed — assume it's a file (or not accessible as folder)
                }
            }

            // If we have metadata and it's a folder -> navigate
            if (f && f.isFolder) {
                if (pushToBack && currentDirId !== null) backStack.push({ type: 'dir', id: currentDirId });
                currentDirId = f.id;
                selectedFileId = null;
                await loadFiles();
                return;
            }

            // Otherwise treat as file: ask server to list archive; if server reports entries - open as archive; otherwise download
            try {
                const listRes = await callServerMethod('fileSystem', 'listArchive', { fileId: itemId });
                if (listRes && !listRes.error && Array.isArray(listRes.entries) && listRes.entries.length > 0) {
                    // prepare entries with parentPath and unique ids
                    const entries = listRes.entries.map(e => {
                        const parts = (e.path || '').split('/').filter(Boolean);
                        const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
                        return Object.assign({}, e, { parentPath });
                    });
                    // push current directory snapshot so Back can return here
                    backStack.push({ type: 'dir', id: currentDirId });
                    viewingArchive = {
                        name: listRes.name || ('archive_' + itemId),
                        fileId: String(itemId),
                        entries,
                        currentPath: '',
                        parentDirId: currentDirId
                    };
                    // assign ids for selection (format: zip:<fileId>:<path>)
                    viewingArchive.entries.forEach(en => en.id = 'zip:' + viewingArchive.fileId + ':' + en.path);
                    lastFiles = viewingArchive.entries.filter(x => (x.parentPath || '') === '');
                    currentDirId = null;
                    selectedFileId = null;
                    await loadFiles();
                    return;
                }

                // fallback to normal download
                const res = await callServerMethod('fileSystem', 'downloadFile', { fileId: itemId });
                if (res && res.error) { showAlert(res.error); return; }
                const blob = base64ToBlob(res.file.data, 'application/octet-stream');
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = res.file.name;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            } catch (e) {
                showAlert('Open failed: ' + (e.message || e));
            }
        } catch (e) {
            showAlert('Open failed: ' + (e.message || e));
        }
    }

    // Handle Enter key to open selected folder
    document.addEventListener('keydown', (e) => {
        // ignore typing in inputs/textareas
        const tgt = e.target;
        if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
        if (e.key === 'Enter') {
            if (!selectedFileId) return;
            openSelected(selectedFileId);
        }
    });

    // Helpers for archive handling
    function isArchiveExt(name) {
        const ext = (name || '').toLowerCase().split('.').slice(-1)[0] || '';
        return ext === 'zip' || ext === 'jar';
    }

    function base64ToArrayBuffer(base64) {
        const binary_string = atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
    }

    function ensureJSZip() {
        return new Promise((resolve, reject) => {
            if (window.JSZip) return resolve(window.JSZip);
            const s = document.createElement('script');
            // Load from same-origin vendor folder to satisfy Content Security Policy
            // Place jszip at: apps/fileSystem/resources/public/vendor/jszip.min.js
            s.src = 'vendor/jszip.min.js';
            s.onload = () => { if (window.JSZip) resolve(window.JSZip); else reject(new Error('JSZip not available after load')); };
            s.onerror = (e) => {
                console.error('Failed to load local JSZip (vendor/jszip.min.js)', e);
                reject(new Error('Failed to load JSZip. Please download jszip and place it at apps/fileSystem/resources/public/vendor/jszip.min.js')); 
            };
            document.head.appendChild(s);
        });
    }

    function buildArchiveEntries(zip) {
        const map = {};
        const entries = [];
        let idx = 0;
        Object.keys(zip.files).forEach(name => {
            const zf = zip.files[name];
            const isFolder = !!zf.dir;
            const fullPath = name.replace(/\\/g, '/');
            const parts = fullPath.split('/').filter(Boolean);
            const base = parts.length ? parts[parts.length - 1] : '';
            const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
            const node = {
                id: 'zip:' + fullPath,
                name: base || fullPath,
                isFolder: isFolder,
                fullPath: fullPath,
                parentPath: parentPath,
                size: isFolder ? 0 : (zf._data && zf._data.uncompressedSize) || 0
            };
            map[fullPath] = node;
            entries.push(node);
            idx++;
        });
        // Ensure directories that are not explicitly listed are present (JSZip usually lists dirs)
        return entries;
    }

    // Navigate to address typed by user. Path format: \a\b\c or relative. Archives are handled when encountered as files.
    async function navigateToAddress(rawPath) {
        // Normalize
        if (!rawPath) rawPath = '\\';
        // root
        if (rawPath === '\\' || rawPath === '/') {
            viewingArchive = null;
            currentDirId = null;
            selectedFileId = null;
            await loadFiles();
            return;
        }

        // split by slash/backslash, ignore empty
        const parts = rawPath.replace(/^\\+|\\+$/g, '').replace(/^\/+|\/+$/g, '').split(/[\\/]+/).filter(Boolean);

        // start from root
        let dirId = null;
        for (let i = 0; i < parts.length; i++) {
            const name = parts[i];
            // list children of dirId
            const children = await callServerMethod('fileSystem', 'getFiles', { parentId: dirId || null });
            const found = (children || []).find(c => c.name === name);
            if (!found) {
                throw new Error('Path segment not found: ' + name);
            }
            const isLast = (i === parts.length - 1);
            if (found.isFolder) {
                // navigate into folder and continue
                dirId = found.id;
                if (isLast) {
                    viewingArchive = null;
                    currentDirId = dirId;
                    selectedFileId = null;
                    await loadFiles();
                    return;
                }
                continue;
            }
            // found is a file
            // try to treat as archive
            const listRes = await callServerMethod('fileSystem', 'listArchive', { fileId: found.id });
            if (!(listRes && !listRes.error && Array.isArray(listRes.entries))) {
                // not an archive
                if (isLast) {
                    // download file
                    const res = await callServerMethod('fileSystem', 'downloadFile', { fileId: found.id });
                    if (res && res.error) throw new Error(res.error);
                    const blob = base64ToBlob(res.file.data, 'application/octet-stream');
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = res.file.name;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    return;
                }
                throw new Error('Path segment is a file and not an archive: ' + name);
            }

            // It's an archive: open it and set internal path to remaining parts
            const entries = listRes.entries.map(e => {
                const parts2 = (e.path || '').split('/').filter(Boolean);
                const parentPath = parts2.length > 1 ? parts2.slice(0, -1).join('/') : '';
                return Object.assign({}, e, { parentPath });
            });
            viewingArchive = {
                name: listRes.name || found.name,
                fileId: String(found.id),
                entries,
                currentPath: '' ,
                parentDirId: dirId
            };
            viewingArchive.entries.forEach(en => en.id = 'zip:' + viewingArchive.fileId + ':' + en.path);

            // remaining internal path
            const internal = parts.slice(i + 1);
            if (internal.length === 0) {
                lastFiles = viewingArchive.entries.filter(x => (x.parentPath || '') === '');
                currentDirId = null;
                selectedFileId = null;
                await loadFiles();
                return;
            }
            // set currentPath inside archive
            viewingArchive.currentPath = internal.join('/');
            lastFiles = viewingArchive.entries.filter(x => (x.parentPath || '') === viewingArchive.currentPath);
            currentDirId = null;
            selectedFileId = null;
            await loadFiles();
            return;
        }
    }

    async function createFolder() {
        const name = prompt('Enter folder name:');
        if (!name) return;

        try {
            await callServerMethod('fileSystem', 'createFolder', { name, parentId: currentDirId });
            loadFiles();
        } catch (err) {
            console.error('Error creating folder:', err);
        }
    }

    async function deleteSelected() {
        if (!selectedFileId) return showAlert('Select a file to delete');
        try {
            const ok = await showConfirm('Delete selected item?');
            if (!ok) return; // cancelled
            const res = await callServerMethod('fileSystem', 'deleteFile', { fileId: selectedFileId });
            if (res && res.error) return showAlert('Delete failed: ' + res.error);
            selectedFileId = null;
            loadFiles();
        } catch (e) {
            // Show user-visible error using modal
            showAlert('Delete failed: ' + (e.message || e));
        }
    }

    // Navigation handlers
    btnHome.onClick = () => {
        if (currentDirId !== null) backStack.push({ type: 'dir', id: currentDirId });
        // If we are viewing archive, exit archive mode
        viewingArchive = null;
        currentDirId = null;
        selectedFileId = null;
        loadFiles();
    };

    btnBack.onClick = () => {
        if (backStack.length === 0) return;
        const prev = backStack.pop();
        if (!prev) return;
        if (prev.type === 'dir') {
            viewingArchive = null;
            currentDirId = prev.id;
            selectedFileId = null;
            loadFiles();
            return;
        }
        if (prev.type === 'archive' && prev.snapshot) {
            viewingArchive = prev.snapshot;
            selectedFileId = null;
            loadFiles();
            return;
        }
    };

    btnUp.onClick = async () => {
        // If viewing archive: go up inside archive or exit archive to parent dir
        if (viewingArchive) {
            const cur = viewingArchive.currentPath || '';
            if (!cur) {
                // exit archive to parent directory
                const parent = viewingArchive.parentDirId !== undefined ? viewingArchive.parentDirId : null;
                viewingArchive = null;
                currentDirId = parent;
                selectedFileId = null;
                await loadFiles();
                return;
            }
            // go to parent path inside archive
            const parts = cur.split('/').filter(Boolean);
            const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
            viewingArchive.currentPath = parentPath;
            selectedFileId = null;
            await loadFiles();
            return;
        }
        // Normal directory up
        if (!currentDirId) return; // already root
        try {
            const folder = await callServerMethod('fileSystem', 'getFolder', { id: currentDirId });
            if (folder && folder.parentId !== undefined) {
                backStack.push({ type: 'dir', id: currentDirId });
                currentDirId = folder.parentId || null;
                selectedFileId = null;
                loadFiles();
            }
        } catch (e) {
            showAlert('Up error: ' + (e.message || e));
        }
    };

    async function uploadFiles(fileList) {
        for (const file of fileList) {
            const formData = new FormData();
            formData.append('app', 'fileSystem');
            formData.append('method', 'uploadFile');
            formData.append('file', file);
            formData.append('parentId', currentDirId || '');

            try {
                const response = await fetch('/app/upload', {
                    method: 'POST',
                    body: formData
                });
                const result = await response.json();
                console.log('Uploaded:', result);
            } catch (err) {
                console.error('Error uploading file:', err);
            }
        }
        loadFiles();
    }
    function base64ToBlob(base64, mime) {
        const byteCharacters = atob(base64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        return new Blob([byteArray], { type: mime });
    }

    async function downloadSelected() {
        if (!selectedFileId) return showAlert('Select a file to download');
        try {
            const res = await callServerMethod('fileSystem', 'downloadFile', { fileId: selectedFileId });
            if (res.error) return showAlert(res.error);

            const blob = base64ToBlob(res.file.data, 'application/octet-stream');
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = res.file.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error(e);
            showAlert('Download failed');
        }
    }
}