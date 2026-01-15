/**
 * Dynamic Table Registry - автоматическая регистрация типовых методов для работы с таблицами
 * Позволяет избежать boilerplate кода в server.js приложений
 */

const globalServerContext = require('./globalServerContext');

// Глобальное хранилище SSE подключений
if (!global._dynamicTableSseClients) {
    global._dynamicTableSseClients = new Map(); // appName -> tableName -> Set of {res, userId, clientId}
}

/**
 * Регистрация стандартных методов для работы с динамическими таблицами
 * @param {string} appName - Имя приложения
 * @param {Object} config - Конфигурация { tables: { tableName: 'ModelName' }, tableFields: {...}, accessCheck: fn }
 * @returns {Object} - Объект с методами для экспорта из server.js
 */
function registerDynamicTableMethods(appName, config = {}) {
    const { tables = {}, tableFields = {}, accessCheck = null } = config;
    
    // Инициализация хранилища для приложения
    if (!global._dynamicTableSseClients.has(appName)) {
        global._dynamicTableSseClients.set(appName, new Map());
    }
    const appSseClients = global._dynamicTableSseClients.get(appName);
    
    return {
        /**
         * Получение данных таблицы
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
            const modelName = tables[tableName];
            if (!modelName) {
                throw new Error('Unknown table: ' + tableName);
            }
            
            // Получить конфигурацию полей для таблицы (если есть)
            const fieldConfig = tableFields[tableName] || null;
            
            // Вызов глобальной функции
            return await globalServerContext.getDynamicTableData({
                modelName,
                firstRow,
                visibleRows,
                sort: sort || [],
                filters: filters || [],
                fieldConfig: fieldConfig,
                userId: user.id  // Pass userId for edit session
            });
        },
        
        /**
         * Подписка на обновления таблицы через SSE
         */
        subscribeToTable(params, sessionID, req, res) {
            const { tableName } = params;
            
            (async () => {
                try {
                    // Получение пользователя
                    const user = await globalServerContext.getUserBySessionID(sessionID);
                    if (!user) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'User not authorized' }));
                        return;
                    }
                    
                    // Проверка доступа
                    if (accessCheck) {
                        const hasAccess = await accessCheck(user, tableName, 'read');
                        if (!hasAccess) {
                            res.writeHead(403, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Access denied' }));
                            return;
                        }
                    }
                    
                    // Настройка SSE
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                        'Access-Control-Allow-Origin': '*'
                    });
                    
                    const clientId = Math.random().toString(36).substr(2, 9);
                    
                    // Регистрация клиента
                    if (!appSseClients.has(tableName)) {
                        appSseClients.set(tableName, new Set());
                    }
                    const tableClients = appSseClients.get(tableName);
                    const clientInfo = { res, userId: user.id, clientId };
                    tableClients.add(clientInfo);
                    
                    // Отправка подтверждения подключения
                    res.write(`data: ${JSON.stringify({ type: 'connected', tableName, clientId })}\n\n`);
                    
                    // Обработка отключения
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
         * @param {string} tableName - Имя таблицы
         * @param {string} action - Действие: 'insert', 'update', 'delete'
         * @param {number} rowId - ID изменённой строки
         * @param {Object} rowData - Данные строки (опционально)
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
            
            // Очистка мёртвых подключений
            deadClients.forEach(client => tableClients.delete(client));
        },
        
        /**
         * Запись одного изменения ячейки
         */
        async recordTableEdit(params, sessionID) {
            const { editSessionId, rowId, fieldName, newValue } = params;
            
            // Получение пользователя (для проверки прав)
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
            
            // Получение пользователя
            const user = await globalServerContext.getUserBySessionID(sessionID);
            if (!user) {
                throw new Error('User not authorized');
            }
            
            return await globalServerContext.commitTableEdits(editSessionId);
        }
    };
}

module.exports = {
    registerDynamicTableMethods
};
