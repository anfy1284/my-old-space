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
            let modelName = tables[tableName];
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
            const fieldConfig = tableFields[tableName] || null;

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

                    res.write(`data: ${JSON.stringify({ type: 'connected', tableName, clientId })}\n\n`);

                    req.on('close', () => {
                        tableClients.delete(clientInfo);
                        if (tableClients.size === 0) {
                            appSseClients.delete(tableName);
                        }
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
                return;
            }

            const tableClients = appSseClients.get(tableName);
            const message = JSON.stringify({
                type: 'dataChanged',
                tableName,
                action,
                rowId,
                rowData
            });

            const deadClients = [];
            tableClients.forEach(client => {
                try {
                    client.res.write(`data: ${message}\n\n`);
                } catch (error) {
                    console.error(`[${appName}/notifyTableChange] Error sending to client:`, error.message);
                    deadClients.push(client);
                }
            });

            deadClients.forEach(client => tableClients.delete(client));
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
