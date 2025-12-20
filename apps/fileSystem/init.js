const global = require('../../drive_root/globalServerContext');

// Автоматическое создание агента при старте, если заданы переменные окружения
(async () => {
    const agentId = process.env.AGENT_ID;
    const token = process.env.AGENT_TOKEN;

    if (agentId && token) {
        console.log(`[FileSystem] Found AGENT_ID and AGENT_TOKEN in env. Verifying agent...`);
        try {
            // Ждем немного, чтобы убедиться, что подключение к БД установлено (на всякий случай)
            // Хотя globalServerContext уже инициализирован
            const AgentModel = global.modelsDB.FileSystem_Agents;
            if (AgentModel) {
                const [agent, created] = await AgentModel.findOrCreate({
                    where: { id: agentId },
                    defaults: {
                        token: token,
                        status: false,
                        hostInfo: {},
                        lastSeen: new Date()
                    }
                });
                
                if (!created && agent.token !== token) {
                    await agent.update({ token: token });
                    console.log(`[FileSystem] Updated token for agent ${agentId}`);
                } else {
                    console.log(`[FileSystem] Agent ${agentId} is ready.`);
                }
            } else {
                console.error('[FileSystem] Error: FileSystem_Agents model not found in global.modelsDB');
            }
        } catch (e) {
            console.error('[FileSystem] Error ensuring agent from env:', e);
        }
    }
})();
