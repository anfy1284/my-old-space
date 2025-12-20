// Server methods for fileSystem
const global = require('../../drive_root/globalServerContext');
const agentManager = require('./agentManager');

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const { Op } = require('sequelize');
const config = require('./config.json');
let storagePath = config.storagePath || 'uploads';

const isProduction = process.env.NODE_ENV === 'production';
const configStorageType = config.storageType;
let storageType;

if (typeof configStorageType === 'string') {
    storageType = configStorageType;
} else if (typeof configStorageType === 'object') {
    storageType = isProduction ? configStorageType.production : configStorageType.development;
}
storageType = storageType || 'local';

if (storageType === 'local') {
    if (!path.isAbsolute(storagePath)) {
        storagePath = path.resolve(__dirname, storagePath);
    }
    // Ensure directory exists
    fs.mkdir(storagePath, { recursive: true }).catch(() => { });
}

async function getUserId(sessionID) {
    if (!sessionID) return null;
    const SessionModel = global.modelsDB.Sessions;
    if (!SessionModel) return null;
    const session = await SessionModel.findOne({ where: { sessionId: sessionID } });
    return session ? session.userId : null;
}

async function uploadFile(params, sessionID, req, res) {
    // Handle file upload
    // req.file - uploaded file (from multer memoryStorage)
    // params - additional data (parentId, etc.)
    const { parentId } = params;
    const file = req.file;

    if (!file) {
        return { error: 'No file uploaded' };
    }

    const userId = await getUserId(sessionID);
    if (!userId) return { error: 'Unauthorized' };

    // Check parent provider
    const FileModel = global.modelsDB.FileSystem_Files;
    let provider = 'local';
    let parentExternalId = null;

    if (parentId) {
        const parent = await FileModel.findByPk(parentId);
    }

    // Fix filename encoding
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    console.log('Original name after decode:', originalName);

    // Add record to DB first
    const ext = path.extname(originalName);
    const baseName = path.basename(originalName, ext);

    const newFile = await FileModel.create({
        name: originalName,
        parentId: parentId || null,
        isFolder: false,
        size: file.size,
        filePath: '', // update later
        ownerId: userId
    });

    // Save file with unique name: id + ext
    const uniqueName = `${newFile.id}${ext}`;

    if (storageType === 'remote_agent') {
        // Save to temp
        const tempDir = path.join(__dirname, 'temp');
        await fs.mkdir(tempDir, { recursive: true }).catch(() => {});
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const tempFilePath = path.join(tempDir, requestId);
        
        await fs.writeFile(tempFilePath, file.buffer);

        // Pick an agent (first online)
        const AgentModel = global.modelsDB.FileSystem_Agents;
        const agent = await AgentModel.findOne({ where: { status: true } });
        if (!agent) {
            await fs.unlink(tempFilePath).catch(() => {});
            await newFile.destroy();
            return { error: 'No online agents' };
        }

        // Send command
        const host = req.headers.host;
        // Check X-Forwarded-Proto for proxies (Koyeb, Heroku, etc.)
        const protocol = req.headers['x-forwarded-proto'] || (req.connection.encrypted ? 'https' : 'http');
        const downloadUrl = `${protocol}://${host}/api/apps/fileSystem/agent/download_temp/${requestId}`;

        try {
            await agentManager.sendCommand(agent.id, {
                action: 'upload',
                request_id: requestId,
                file_info: {
                    id: uniqueName, // Agent uses this ID
                    name: originalName,
                    size: file.size,
                    owner_id: newFile.ownerId
                },
                download_url: downloadUrl
            });
            
            // Success
            await newFile.update({ agentId: agent.id, filePath: uniqueName });
            await fs.unlink(tempFilePath).catch(() => {});
        } catch (e) {
            await fs.unlink(tempFilePath).catch(() => {});
            await newFile.destroy();
            return { error: 'Agent upload failed: ' + e.message };
        }
    } else {
        const filePath = path.join(storagePath, uniqueName);
        console.log('Saving file to:', filePath);
        await fs.writeFile(filePath, file.buffer);
        console.log('File saved successfully');

        // Update filePath in DB
        const relativePath = path.relative(storagePath, filePath).replace(/\\/g, '/');
        await newFile.update({ filePath: relativePath });
    }

    return { success: true, file: newFile };
}

async function getFiles(params, sessionID, req, res) {
    const { parentId } = params;
    const FileModel = global.modelsDB.FileSystem_Files;

    const userId = await getUserId(sessionID);
    if (!userId) return { error: 'Unauthorized' };

    const files = await FileModel.findAll({
        where: { 
            parentId: parentId || null,
            ownerId: userId
        },
        include: [{ model: global.modelsDB.Users, as: 'owner' }]
    });

    return files;
}

async function createFolder(params, sessionID, req, res) {
    const { name, parentId } = params;
    const FileModel = global.modelsDB.FileSystem_Files;

    const userId = await getUserId(sessionID);
    if (!userId) return { error: 'Unauthorized' };

    // Check parent provider
    let provider = 'local';
    let parentExternalId = null;

    if (parentId) {
        const parent = await FileModel.findByPk(parentId);
    }

    const newFolder = await FileModel.create({
        name,
        parentId: parentId || null,
        isFolder: true,
        size: 0,
        ownerId: userId
    });

    return { success: true, folder: newFolder };
}

async function downloadFile(params, sessionID, req, res) {
    const { fileId } = params;
    const FileModel = global.modelsDB.FileSystem_Files;
    const fileRecord = await FileModel.findByPk(fileId);

    if (!fileRecord) return { error: 'File not found' };
    
    const userId = await getUserId(sessionID);
    if (!userId || fileRecord.ownerId !== userId) return { error: 'Access denied' };

    if (fileRecord.isFolder) return { error: 'Cannot download directory' };

    if (storageType === 'remote_agent') {
        if (!fileRecord.agentId) return { error: 'File has no agent assigned' };
        
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const tempDir = path.join(__dirname, 'temp');
        await fs.mkdir(tempDir, { recursive: true }).catch(() => {});
        const tempFilePath = path.join(tempDir, requestId);

        const host = req.headers.host;
        // Check X-Forwarded-Proto for proxies (Koyeb, Heroku, etc.)
        const protocol = req.headers['x-forwarded-proto'] || (req.connection.encrypted ? 'https' : 'http');
        const uploadUrl = `${protocol}://${host}/api/apps/fileSystem/agent/upload_temp/${requestId}`;

        try {
            await agentManager.sendCommand(fileRecord.agentId, {
                action: 'download',
                request_id: requestId,
                file_id: fileRecord.filePath || fileRecord.name, // Agent needs the ID it saved it with
                upload_url: uploadUrl
            });

            // File should be at tempFilePath
            if (await fs.stat(tempFilePath).catch(() => false)) {
                const buffer = await fs.readFile(tempFilePath);
                await fs.unlink(tempFilePath).catch(() => {});
                return {
                    file: {
                        name: fileRecord.name,
                        data: buffer.toString('base64')
                    }
                };
            } else {
                throw new Error('Temp file not found after agent upload');
            }
        } catch (e) {
            return { error: 'Agent download failed: ' + e.message };
        }
    }

    const fullPath = await resolveStoredFilePath(fileRecord);
    if (!fullPath) return { error: 'File not found on disk: ' + (fileRecord.filePath || '') };
    try {
        const buffer = await fs.readFile(fullPath);
        return {
            file: {
                name: fileRecord.name,
                data: buffer.toString('base64')
            }
        };
    } catch (e) {
        return { error: 'Read error: ' + e.message };
    }
}

async function deleteFile(params, sessionID) {
    const { fileId } = params;
    if (!fileId) return { error: 'fileId required' };
    
    const userId = await getUserId(sessionID);
    if (!userId) return { error: 'Unauthorized' };

    const FileModel = global.modelsDB.FileSystem_Files;
    // Use a transaction so DB changes rollback if any disk operation fails
    const sequelizeInstance = FileModel.sequelize;
    try {
        return await sequelizeInstance.transaction(async (t) => {
            // Reload record inside transaction
            const fileRecord = await FileModel.findByPk(fileId, { transaction: t });
            if (!fileRecord) throw new Error('File not found');
            
            if (fileRecord.ownerId !== userId) throw new Error('Access denied');

            // Recursive delete function
            async function deleteNode(rec) {

                if (rec.isFolder) {
                    const children = await FileModel.findAll({ where: { parentId: rec.id }, transaction: t });
                    for (const child of children) {
                        await deleteNode(child);
                    }
                    await rec.destroy({ transaction: t });
                } else {
                    if (storageType === 'remote_agent') {
                        if (rec.agentId) {
                            const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                            try {
                                await agentManager.sendCommand(rec.agentId, {
                                    action: 'delete',
                                    request_id: requestId,
                                    file_id: rec.filePath || rec.name
                                });
                            } catch (e) {
                                console.error('Agent delete failed:', e);
                                // We might still want to delete from DB even if agent fails?
                                // For now, we assume strict consistency and fail.
                                throw e;
                            }
                        }
                    } else {
                        // Delete file from disk; if fails, throw to rollback
                        if (rec.filePath) {
                            const fullPath = await resolveStoredFilePath(rec);
                            if (fullPath) {
                                try {
                                    await fs.unlink(fullPath);
                                } catch (e) {
                                    throw new Error('File unlink error: ' + e.message);
                                }
                            } else {
                                // file not found on disk - consider it OK or throw depending on policy
                                // Here we throw to notify caller
                                throw new Error('File not found on disk: ' + rec.filePath);
                            }
                        }
                    }
                    await rec.destroy({ transaction: t });
                }
            }

            await deleteNode(fileRecord);
            return { success: true };
        });
    } catch (e) {
        // Return error so client can call showAlert
        return { error: e.message || 'Delete failed' };
    }
}

async function getFolder(params, sessionID) {
    const { id } = params;
    if (!id) return { error: 'id required' };
    const FileModel = global.modelsDB.FileSystem_Files;
    const folder = await FileModel.findByPk(id);
    if (!folder) return { error: 'Folder not found' };
    
    const userId = await getUserId(sessionID);
    if (!userId || folder.ownerId !== userId) return { error: 'Access denied' };

    return folder.get({ plain: true });
}

// Helper: resolve stored file path with a few fallbacks (absolute, joined with storagePath, basename)
async function resolveStoredFilePath(fileRecord) {
    const p = fileRecord.filePath || '';
    const candidates = [];
    try {
        if (path.isAbsolute(p)) candidates.push(p);
    } catch (e) { }
    candidates.push(path.join(storagePath, p));
    candidates.push(path.join(storagePath, path.basename(p)));
    // Fallback: check local uploads folder (default location)
    candidates.push(path.join(__dirname, 'uploads', p));
    candidates.push(path.join(__dirname, 'uploads', path.basename(p)));
    candidates.push(p);

    for (const c of candidates) {
        try {
            // use fs.stat to check existence
            await fs.stat(c);
            return c;
        } catch (e) {
            // ignore
        }
    }
    return null;
}

// List entries inside zip archive (no temp files written)
async function listArchive(params, sessionID) {
    const { fileId } = params;
    if (!fileId) return { error: 'fileId required' };
    const FileModel = global.modelsDB.FileSystem_Files;
    const fileRecord = await FileModel.findByPk(fileId);
    if (!fileRecord) return { error: 'File not found' };
    
    const userId = await getUserId(sessionID);
    if (!userId || fileRecord.ownerId !== userId) return { error: 'Access denied' };

    if (fileRecord.isFolder) return { error: 'Not a file' };

    if (storageType === 'remote_agent') {
        // TODO: remote_agent
        return { error: 'Not implemented for remote_agent' };
    }

    // resolve the actual on-disk path
    const fullPath = await resolveStoredFilePath(fileRecord);
    if (!fullPath) return { error: 'File not found on disk: ' + (fileRecord.filePath || '') };
    try {
        const buffer = await fs.readFile(fullPath);
        return await new Promise((resolve) => {
            yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
                if (err) return resolve({ error: 'Zip open error: ' + err.message });
                const entries = [];
                zipfile.readEntry();
                zipfile.on('entry', (entry) => {
                    const isDir = /\/$/.test(entry.fileName);
                    const name = entry.fileName.replace(/\/$/, '').split('/').pop() || entry.fileName;
                    entries.push({ path: entry.fileName, name, isFolder: isDir, size: entry.uncompressedSize });
                    zipfile.readEntry();
                });
                zipfile.on('end', () => {
                    try { zipfile.close(); } catch (e) { }
                    resolve({ name: fileRecord.name, entries });
                });
            });
        });
    } catch (e) {
        return { error: 'Read error: ' + e.message };
    }
}

// Extract a single archive entry and return base64 data (no temp files)
async function extractArchiveEntry(params, sessionID) {
    const { fileId, entryPath } = params;
    if (!fileId || !entryPath) return { error: 'fileId and entryPath required' };
    const FileModel = global.modelsDB.FileSystem_Files;
    const fileRecord = await FileModel.findByPk(fileId);
    if (!fileRecord) return { error: 'File not found' };

    const userId = await getUserId(sessionID);
    if (!userId || fileRecord.ownerId !== userId) return { error: 'Access denied' };

    if (storageType === 'remote_agent') {
        // TODO: remote_agent
        return { error: 'Not implemented for remote_agent' };
    }

    const fullPath = await resolveStoredFilePath(fileRecord);
    if (!fullPath) return { error: 'File not found on disk: ' + (fileRecord.filePath || '') };
    try {
        const buffer = await fs.readFile(fullPath);
        return await new Promise((resolve) => {
            yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
                if (err) return resolve({ error: 'Zip open error: ' + err.message });
                let found = false;
                zipfile.readEntry();
                zipfile.on('entry', (entry) => {
                    if (entry.fileName === entryPath) {
                        found = true;
                        zipfile.openReadStream(entry, (err, readStream) => {
                            if (err) {
                                try { zipfile.close(); } catch (e) { }
                                return resolve({ error: 'Read stream error: ' + err.message });
                            }
                            const chunks = [];
                            readStream.on('data', (c) => chunks.push(c));
                            readStream.on('end', () => {
                                try { zipfile.close(); } catch (e) { }
                                const buf = Buffer.concat(chunks);
                                return resolve({ file: { name: path.basename(entry.fileName), data: buf.toString('base64') } });
                            });
                            readStream.on('error', (e) => {
                                try { zipfile.close(); } catch (ee) { }
                                return resolve({ error: 'Stream error: ' + e.message });
                            });
                        });
                    } else {
                        zipfile.readEntry();
                    }
                });
                zipfile.on('end', () => {
                    if (!found) {
                        try { zipfile.close(); } catch (e) { }
                        resolve({ error: 'Entry not found' });
                    }
                });
            });
        });
    } catch (e) {
        return { error: 'Read error: ' + e.message };
    }
}

// Debug helper: return candidate paths and existence for a file record
async function debugFilePath(params, sessionID) {
    const { fileId } = params || {};
    if (!fileId) return { error: 'fileId required' };
    const FileModel = global.modelsDB.FileSystem_Files;
    const fileRecord = await FileModel.findByPk(fileId);
    if (!fileRecord) return { error: 'File not found' };

    if (storageType === 'remote_agent') {
        // TODO: remote_agent
        return { error: 'Not implemented for remote_agent' };
    }

    const p = fileRecord.filePath || '';
    const candidates = [];
    try {
        if (path.isAbsolute(p)) candidates.push(p);
    } catch (e) { }
    candidates.push(path.join(storagePath, p));
    candidates.push(path.join(storagePath, path.basename(p)));
    // Fallback: check local uploads folder (default location)
    candidates.push(path.join(__dirname, 'uploads', p));
    candidates.push(path.join(__dirname, 'uploads', path.basename(p)));
    candidates.push(p);

    const results = [];
    for (const c of candidates) {
        try {
            const st = await fs.stat(c);
            results.push({ path: c, exists: true, isFile: st.isFile(), isDirectory: st.isDirectory() });
        } catch (e) {
            results.push({ path: c, exists: false, error: e.message });
        }
    }

    return { fileId, filePath: p, storagePath: storagePath, storagePathResolved: path.resolve(storagePath), candidates: results };
}

async function handleDirectRequest(req, res, pathParts) {
    // pathParts comes from /api/apps/fileSystem/...
    // Expected: ['agent', 'download_temp', requestId] or ['agent', 'upload_temp', requestId]
    
    if (pathParts[0] !== 'agent') {
        res.writeHead(404);
        res.end('Unknown endpoint');
        return;
    }

    const action = pathParts[1]; 
    const requestId = pathParts[2];

    if (!requestId) {
        res.writeHead(400);
        res.end('Missing requestId');
        return;
    }

    const tempDir = path.join(__dirname, 'temp');
    await fs.mkdir(tempDir, { recursive: true }).catch(() => {});
    const tempFilePath = path.join(tempDir, requestId);

    if (action === 'download_temp') {
        // Agent wants to download file (User Upload flow)
        try {
            const stat = await fs.stat(tempFilePath);
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': stat.size
            });
            const stream = fsSync.createReadStream(tempFilePath);
            stream.pipe(res);
        } catch (e) {
            res.writeHead(404);
            res.end('File not found');
        }
    } else if (action === 'upload_temp') {
        // Agent wants to upload file (User Download flow)
        const stream = fsSync.createWriteStream(tempFilePath);
        req.pipe(stream);
        stream.on('finish', () => {
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'success' }));
        });
        stream.on('error', (e) => {
            res.writeHead(500);
            res.end(e.message);
        });
    } else {
        res.writeHead(404);
        res.end('Unknown action');
    }
}

function setupWebSocket(server) {
    agentManager.setupWebSocket(server);
}

module.exports = {
    uploadFile,
    getFiles,
    createFolder,
    downloadFile,
    deleteFile,
    getFolder,
    listArchive,
    extractArchiveEntry,
    debugFilePath,
    handleDirectRequest,
    setupWebSocket
};