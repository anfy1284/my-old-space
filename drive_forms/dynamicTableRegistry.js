/**
 * Dynamic Table Registry for drive_forms - returns data in a Table-friendly format
 * Формат вывода максимально приближен к тому, что ожидает Table в клиенте:
 * { columns: [{name,label,...}], rows: [{...}], totalRows: N }
 */

const globalServerContext = require('../drive_root/globalServerContext');

// Глобальное хранилище SSE подключений (shared across apps)
if (!global._dynamicTableSseClients) {
    global._dynamicTableSseClients = new Map(); // appName -> tableName -> Set of {res, userId, clientId}
}

function normalizeColumnsFromFields(fields, rows) {
    if (!fields) {
        // Infer fields from first row keys
        const first = (rows && rows[0]) || {};
        return Object.keys(first).map(k => ({ data: k, caption: k }));
    }

    // fields can be an array of strings or objects
    return fields.map(f => {
        if (typeof f === 'string') return { data: f, caption: f };
        const name = f.name || f.field || f.id || f.key;
        const caption = f.caption || f.label || f.title || name;
        // Preserve other metadata (width, properties, etc.) but ensure `data` and `caption` exist
        const col = Object.assign({}, f, { data: name, caption: caption });
        return col;
    });
}

function registerDynamicTableMethods(appName, config = {}) {
    const { tables = {}, tableFields = {}, accessCheck = null } = config;

    // Инициализация хранилища для приложения
    if (!global._dynamicTableSseClients.has(appName)) {
        global._dynamicTableSseClients.set(appName, new Map());
    }
    const appSseClients = global._dynamicTableSseClients.get(appName);

    return {
        /**
         * Получение данных таблицы в Table-совместимом формате
         */
        async getDynamicTableData(params, sessionID) {
            const { tableName, firstRow, visibleRows, sort, filters } = params;

            // Получение пользователя
            const user = await globalServerContext.getUserBySessionID(sessionID);
            if (!user) {
                throw new Error('User not authorized');
            }

            // Проверка доступа (если задана)
            if (accessCheck) {
                const hasAccess = await accessCheck(user, tableName, 'read');
                if (!hasAccess) {
                    throw new Error('Access denied to table: ' + tableName);
                }
            }

            // Маппинг таблицы на модель
            // `tables` may be:
            // - an object map { tableName: modelName }
            // - an object map where values may be functions returning modelName
            // - a function resolver which accepts either (params, sessionID, user)
            //   or the legacy signature (tableName, params, sessionID, user)
            let modelName = null;
            try {
                if (typeof tables === 'function') {
                    // Prefer calling resolver with params first (params should include tableName)
                    if (tables.length <= 1) {
                        modelName = await tables(params, sessionID, user);
                    } else {
                        modelName = await tables(tableName, params, sessionID, user);
                    }
                } else {
                    modelName = tables[tableName];
                    if (typeof modelName === 'function') {
                        if (modelName.length <= 1) {
                            modelName = await modelName(params, sessionID, user);
                        } else {
                            modelName = await modelName(tableName, params, sessionID, user);
                        }
                    }
                }
            } catch (e) {
                console.error(`[${appName}/getDynamicTableData] Error resolving modelName for table ${tableName}:`, e);
                modelName = null;
            }
            // Fallback: try to resolve model name by table name from global models (handles init-order issues)
            if (!modelName) {
                try {
                    const resolved = globalServerContext.getModelNameForTable(tableName);
                    if (resolved) {
                        modelName = resolved;
                        console.log(`[${appName}/getDynamicTableData] Resolved table '${tableName}' -> model '${modelName}' via global lookup`);
                    }
                } catch (e) {
                    // ignore and throw below
                }
            }

            if (!modelName) {
                throw new Error('Unknown table: ' + tableName);
            }

            // Получить конфигурацию полей для таблицы (если есть)
            // `tableFields` may be:
            // - an object map { tableName: fields }
            // - an object map where values may be functions returning fields
            // - a function resolver which accepts either (params, sessionID, user)
            //   or legacy signature (tableName, params, sessionID, user)
            let fieldConfig = null;
            try {
                if (typeof tableFields === 'function') {
                    if (tableFields.length <= 1) {
                        fieldConfig = await tableFields(params, sessionID, user);
                    } else {
                        fieldConfig = await tableFields(tableName, params, sessionID, user);
                    }
                } else {
                    fieldConfig = tableFields[tableName] || null;
                    if (typeof fieldConfig === 'function') {
                        if (fieldConfig.length <= 1) {
                            fieldConfig = await fieldConfig(params, sessionID, user);
                        } else {
                            fieldConfig = await fieldConfig(tableName, params, sessionID, user);
                        }
                    }
                }
            } catch (e) {
                console.error(`[${appName}/getDynamicTableData] Error resolving fieldConfig for table ${tableName}:`, e);
                fieldConfig = null;
            }

            // Вызов глобальной функции получения сырых данных
            const raw = await globalServerContext.getDynamicTableData({
                modelName,
                firstRow,
                visibleRows,
                sort: sort || [],
                filters: filters || [],
                fieldConfig: fieldConfig,
                userId: user.id
            });

            try {
                console.log(`[${appName}/getDynamicTableData] modelName=${modelName} tableName=${tableName} sessionUser=${user && user.id}`);
                try { console.log(`[${appName}/getDynamicTableData] raw keys=`, raw ? Object.keys(raw) : null); } catch(e) {}
                try { console.log(`[${appName}/getDynamicTableData] raw.fields=`, raw && raw.fields ? raw.fields : (fieldConfig || null)); } catch(e) {}
                try { console.log(`[${appName}/getDynamicTableData] rows.length=`, raw && raw.rows ? raw.rows.length : (raw && raw.data ? raw.data.length : 0)); } catch(e) {}
            } catch (e) {}

            // Ожидаемые варианты от глобальной функции: { rows, fields, totalRows } или { data, fields, total }
            const rows = raw && (raw.rows || raw.data || raw.items || raw.result) || [];
            const fields = raw && (raw.fields || fieldConfig) || fieldConfig;
            const totalRows = raw && (raw.totalRows || raw.total || rows.length) || rows.length;

            const columns = normalizeColumnsFromFields(fields, rows);
            try { console.log(`[${appName}/getDynamicTableData] normalized columns=`, columns.map(c => ({ data: c.data, caption: c.caption }))); } catch(e) {}

            return {
                columns,
                rows,
                totalRows
            };
        },

        /**
         * Lightweight lookup for dropdowns: returns id and display values
         */
        async getLookupList(params, sessionID) {
            const { tableName, firstRow, visibleRows } = params;

            // TEMP LOG: record incoming lookup requests to help debug empty dropdowns
            try { console.log(`[${appName}/getLookupList] called with params:`, JSON.stringify(params)); } catch (e) {}

            // Get user
            const user = await globalServerContext.getUserBySessionID(sessionID);
            if (!user) throw new Error('User not authorized');

            if (accessCheck) {
                const hasAccess = await accessCheck(user, tableName, 'read');
                if (!hasAccess) throw new Error('Access denied to table: ' + tableName);
            }

            // Resolve modelName using same logic as above
            let modelName = null;
            try {
                if (typeof tables === 'function') {
                    if (tables.length <= 1) modelName = await tables(params, sessionID, user);
                    else modelName = await tables(tableName, params, sessionID, user);
                } else {
                    modelName = tables[tableName];
                    if (typeof modelName === 'function') {
                        if (modelName.length <= 1) modelName = await modelName(params, sessionID, user);
                        else modelName = await modelName(tableName, params, sessionID, user);
                    }
                }
            } catch (e) {
                console.error(`[${appName}/getLookupList] Error resolving modelName for table ${tableName}:`, e);
                modelName = null;
            }

            if (!modelName) {
                const resolved = globalServerContext.getModelNameForTable(tableName);
                if (resolved) modelName = resolved;
            }

            if (!modelName) throw new Error('Unknown table: ' + tableName);

            const raw = await globalServerContext.getLookupList({ modelName, firstRow, visibleRows, userId: user.id });

            const rows = raw && (raw.rows || raw.data) || [];
            const fields = raw && raw.fields || [{ name: 'id' }, { name: 'display' }];
            const totalRows = raw && raw.totalRows || (rows.length ? rows.length : 0);

            const columns = normalizeColumnsFromFields(fields, rows);

            return { columns, rows, totalRows };
        },

        /**
         * Подписка на обновления таблицы через SSE
         */
        subscribeToTable(params, sessionID, req, res) {
            const { tableName } = params;

            (async () => {
                try {
                    const user = await globalServerContext.getUserBySessionID(sessionID);
                    if (!user) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'User not authorized' }));
                        return;
                    }

                    if (accessCheck) {
                        const hasAccess = await accessCheck(user, tableName, 'read');
                        if (!hasAccess) {
                            res.writeHead(403, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Access denied' }));
                            return;
                        }
                    }

                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                        'Access-Control-Allow-Origin': '*'
                    });

                    const clientId = Math.random().toString(36).substr(2, 9);

                    if (!appSseClients.has(tableName)) {
                        appSseClients.set(tableName, new Set());
                    }
                    const tableClients = appSseClients.get(tableName);
                    const clientInfo = { res, userId: user.id, clientId };
                    tableClients.add(clientInfo);

                    console.log(`[${appName}/subscribeToTable] client connected table=${tableName} clientId=${clientId} user=${user.id} totalClients=${tableClients.size}`);
                    res.write(`data: ${JSON.stringify({ type: 'connected', tableName, clientId })}\n\n`);

                    req.on('close', () => {
                        try {
                            tableClients.delete(clientInfo);
                            console.log(`[${appName}/subscribeToTable] client disconnected table=${tableName} clientId=${clientId} remaining=${tableClients.size}`);
                            if (tableClients.size === 0) {
                                appSseClients.delete(tableName);
                                console.log(`[${appName}/subscribeToTable] no more clients for table=${tableName}, cleaned up map`);
                            }
                        } catch (e) { console.error(`[${appName}/subscribeToTable] error on close handler:`, e); }
                    });

                } catch (error) {
                    console.error(`[${appName}/subscribeToTable] Error:`, error);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: error.message }));
                    }
                }
            })();

            return { _handled: true };
        },

        /**
         * Сохранение состояния клиента (ширины колонок и т.д.)
         */
        async saveClientState(params, sessionID) {
            return await globalServerContext.saveClientState(params, sessionID);
        },

        /**
         * Уведомление об изменении данных таблицы
         */
        notifyTableChange(tableName, action, rowId, rowData = null) {
            if (!appSseClients.has(tableName)) {
                // still notify session-scoped SSE clients if present
                // (fall through to session clients below)
            }

            const tableClients = appSseClients.get(tableName);
            const messageObj = {
                type: 'dataChanged',
                app: appName,
                tableName,
                action,
                rowId,
                rowData
            };
            const message = JSON.stringify(messageObj);

            const deadClients = [];
            if (tableClients) {
                tableClients.forEach(client => {
                    try {
                        client.res.write(`data: ${message}\n\n`);
                    } catch (error) {
                        console.error(`[${appName}/notifyTableChange] Error sending to client:`, error.message);
                        deadClients.push(client);
                    }
                });
                deadClients.forEach(client => tableClients.delete(client));
            }

            // Broadcast to session-scoped SSE clients (one EventSource per session)
            try {
                if (global._sessionSseClients) {
                    // Iterate over all sessions and send event to each connected session client
                    for (const [sessionID, set] of global._sessionSseClients.entries()) {
                        const sessionMsg = JSON.stringify(messageObj);
                        const dead = [];
                        set.forEach(client => {
                            try {
                                client.res.write(`data: ${sessionMsg}\n\n`);
                            } catch (e) {
                                console.error(`[${appName}/notifyTableChange] Error sending to session client:`, e.message);
                                dead.push(client);
                            }
                        });
                        dead.forEach(c => set.delete(c));
                        if (set.size === 0) global._sessionSseClients.delete(sessionID);
                    }
                }
            } catch (e) {
                console.error(`[${appName}/notifyTableChange] Error broadcasting to session SSE clients:`, e.message);
            }
        },

        /**
         * Запись одного изменения ячейки
         */
        async recordTableEdit(params, sessionID) {
            const { editSessionId, rowId, fieldName, newValue } = params;

            const user = await globalServerContext.getUserBySessionID(sessionID);
            if (!user) {
                throw new Error('User not authorized');
            }

            return await globalServerContext.recordTableEdit(editSessionId, rowId, fieldName, newValue);
        },

        /**
         * Применить все изменения из сессии в БД
         */
        async commitTableEdits(params, sessionID) {
            const { editSessionId } = params;

            const user = await globalServerContext.getUserBySessionID(sessionID);
            if (!user) {
                throw new Error('User not authorized');
            }

            return await globalServerContext.commitTableEdits(editSessionId);
        }
    };
}

module.exports = { registerDynamicTableMethods };
