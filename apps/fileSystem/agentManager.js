const WebSocket = require('ws');
const EventEmitter = require('events');
const global = require('../../drive_root/globalServerContext');

class ConnectionManager {
    constructor() {
        this.activeConnections = new Map(); // agent_id -> ws
    }

    async connect(agentId, ws) {
        this.activeConnections.set(agentId, ws);
        // Update status in DB
        try {
            const AgentModel = global.modelsDB.FileSystem_Agents;
            if (AgentModel) {
                await AgentModel.update({ status: true, lastSeen: new Date() }, { where: { id: agentId } });
            }
        } catch (e) {
            console.error('Error updating agent status:', e);
        }
    }

    async disconnect(agentId) {
        this.activeConnections.delete(agentId);
        // Update status in DB
        try {
            const AgentModel = global.modelsDB.FileSystem_Agents;
            if (AgentModel) {
                await AgentModel.update({ status: false, lastSeen: new Date() }, { where: { id: agentId } });
            }
        } catch (e) {
            console.error('Error updating agent status:', e);
        }
    }

    get(agentId) {
        return this.activeConnections.get(agentId);
    }
}

class AgentManager extends EventEmitter {
    constructor() {
        super();
        this.connectionManager = new ConnectionManager();
        this.pendingRequests = new Map(); // request_id -> { resolve, reject, timeout }
    }

    setupWebSocket(server) {
        this.wss = new WebSocket.Server({ noServer: true });

        server.on('upgrade', (request, socket, head) => {
            // Handle relative URLs or full URLs
            let pathname;
            try {
                pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
            } catch (e) {
                pathname = request.url;
            }

            if (pathname === '/ws') {
                console.log('[AgentManager] Upgrading connection for /ws');
                this.wss.handleUpgrade(request, socket, head, (ws) => {
                    this.wss.emit('connection', ws, request);
                });
            } else {
                // console.log('[AgentManager] Ignoring upgrade for path:', pathname);
            }
        });

        this.wss.on('connection', (ws, req) => {
            const ip = req.socket.remoteAddress;
            console.log(`[AgentManager] New WebSocket connection from ${ip}`);
            let authenticated = false;
            let agentId = null;

            ws.on('message', async (message) => {
                console.log(`[AgentManager] Received message from ${ip}:`, message.toString().slice(0, 200)); // Log first 200 chars
                try {
                    const data = JSON.parse(message);

                    if (!authenticated) {
                        if (data.action === 'auth') {
                            const { token, agent_id } = data;
                            console.log(`[AgentManager] Auth attempt for agent_id: ${agent_id}`);
                            
                            // Verify token
                            const AgentModel = global.modelsDB.FileSystem_Agents;
                            if (!AgentModel) {
                                console.error('[AgentManager] Critical Error: FileSystem_Agents model not found!');
                                ws.send(JSON.stringify({ status: 'error', message: 'Server internal error' }));
                                ws.close();
                                return;
                            }

                            const agent = await AgentModel.findOne({ where: { id: agent_id } });

                            if (!agent) {
                                console.warn(`[AgentManager] Auth failed: Agent ${agent_id} not found in DB`);
                                ws.send(JSON.stringify({ status: 'error', message: 'Invalid agent_id' }));
                                ws.close();
                            } else if (agent.token !== token) {
                                console.warn(`[AgentManager] Auth failed: Invalid token for agent ${agent_id}`);
                                ws.send(JSON.stringify({ status: 'error', message: 'Invalid token' }));
                                ws.close();
                            } else {
                                authenticated = true;
                                agentId = agent_id;
                                await this.connectionManager.connect(agentId, ws);
                                ws.send(JSON.stringify({ status: 'ok' }));
                                console.log(`[AgentManager] Agent ${agentId} successfully authenticated`);
                            }
                        } else {
                            console.warn(`[AgentManager] Unauthenticated message received (not auth):`, data.action);
                            ws.close();
                        }
                        return;
                    }

                    // Handle responses
                    if (data.action === 'response') {
                        const { request_id, status, data: responseData, message: errorMsg } = data;
                        if (this.pendingRequests.has(request_id)) {
                            const { resolve, reject, timeout } = this.pendingRequests.get(request_id);
                            clearTimeout(timeout);
                            this.pendingRequests.delete(request_id);

                            if (status === 'success') {
                                resolve(responseData);
                            } else {
                                reject(new Error(errorMsg || 'Agent returned error'));
                            }
                        }
                    }

                } catch (e) {
                    console.error('Error handling message:', e);
                }
            });

            ws.on('close', async () => {
                if (agentId) {
                    console.log(`Agent ${agentId} disconnected`);
                    await this.connectionManager.disconnect(agentId);
                }
            });
        });
    }

    async sendCommand(agentId, command, timeoutMs = 30000) {
        const ws = this.connectionManager.get(agentId);
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error('Agent offline');
        }

        return new Promise((resolve, reject) => {
            const requestId = command.request_id;
            
            const timeout = setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Timeout waiting for agent response'));
                }
            }, timeoutMs);

            this.pendingRequests.set(requestId, { resolve, reject, timeout });
            ws.send(JSON.stringify(command));
        });
    }
}

module.exports = new AgentManager();
