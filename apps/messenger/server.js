const eventBus = require('../../drive_root/eventBus');
const global = require('../../drive_root/globalServerContext');
const { modelsDB } = global;

// SSE clients storage: Map<chatId, Set<{res, userId, clientId}>>
// Store in global to prevent loss during module hot-reload
if (!global.messengerSseClients) {
    global.messengerSseClients = new Map();
    console.log('[messenger] Initialized global SSE clients Map');
}
const sseClients = global.messengerSseClients;

eventBus.on('userCreated', async (user, { systems, roles, sessionID } = {}) => {
    // Event input data validation
    if (!user || typeof user !== 'object' || !user.id) {
        console.error('[messenger] userCreated: invalid user object', user);
        return;
    }
    if (!modelsDB || !modelsDB.Users || !modelsDB.Messenger_Chats || !modelsDB.Messenger_ChatMembers) {
        console.warn('[messenger] Models unavailable during user creation');
        return;
    }

    try {
        const sequelize = modelsDB.Users.sequelize;
        // SEPARATE transaction for chat creation (independent of user creation)
        await sequelize.transaction(async (t) => {
            // 1. Create private chats with each existing user
            const existingUsers = await modelsDB.Users.findAll({
                where: { id: { [require('sequelize').Op.ne]: user.id } },
                transaction: t
            });

            for (const existingUser of existingUsers) {
                // Check if chat already exists between these users
                const memberships = await modelsDB.Messenger_ChatMembers.findAll({
                    where: { userId: [user.id, existingUser.id] },
                    transaction: t
                });

                const chatMap = new Map();
                for (const m of memberships) {
                    const arr = chatMap.get(m.chatId) || [];
                    arr.push(m.userId);
                    chatMap.set(m.chatId, arr);
                }

                let hasPrivate = false;
                for (const members of chatMap.values()) {
                    const set = new Set(members);
                    if (set.has(user.id) && set.has(existingUser.id) && set.size === 2) {
                        hasPrivate = true;
                        break;
                    }
                }

                if (!hasPrivate) {
                    try {
                        await createTwoUserChat({ user1: user, user2: existingUser }, null, t);
                        console.log(`[messenger] Private chat created: ${user.name} ↔ ${existingUser.name}`);
                    } catch (chatError) {
                        console.error(`[messenger] Error creating chat between ${user.name} and ${existingUser.name}:`, chatError.message);
                    }
                }
            }

            // 2. Add new user to "Local chat" from defaultValuesCache
            const localChat = global.getDefaultValue('messenger', 'Messenger_Chats', 1);
            if (localChat) {
                // Check if already in chat
                const existing = await modelsDB.Messenger_ChatMembers.findOne({
                    where: { chatId: localChat.id, userId: user.id },
                    transaction: t
                });

                if (!existing) {
                    try {
                        await modelsDB.Messenger_ChatMembers.create({
                            chatId: localChat.id,
                            userId: user.id,
                            role: 'member',
                            customName: 'Local chat',
                            joinedAt: new Date(),
                            isActive: true,
                        }, { transaction: t });
                        console.log(`[messenger] User ${user.name} added to Local chat`);
                    } catch (chatError) {
                        console.error(`[messenger] Error adding user ${user.name} to Local chat:`, chatError.message);
                    }
                }
            }
        });
    } catch (e) {
        console.error('[messenger] userCreated handling error:', e.message);
    }
});

function onLoad(params, sessionID) {
    // Empty for now, can be used for initialization
    return { success: true };
}

async function loadChats(params, sessionID) {
    if (!modelsDB || !modelsDB.Messenger_Chats || !modelsDB.Messenger_ChatMembers) {
        return { error: 'Messenger models unavailable' };
    }

    // Get user from session (await!)
    const user = await global.getUserBySessionID(sessionID);
    if (!user) {
        return { error: 'User not authorized' };
    }

    try {
        // Find all chats where user is a member
        const memberships = await modelsDB.Messenger_ChatMembers.findAll({
            where: { userId: user.id, isActive: true },
            include: [{
                model: modelsDB.Messenger_Chats,
                as: 'chat',
                where: { isActive: true },
                required: true
            }]
        });

        const chats = memberships.map(m => ({
            chatId: m.chatId,
            name: m.customName || m.chat.name,
            role: m.role,
            joinedAt: m.joinedAt
        }));

        return { chats };
    } catch (e) {
        console.error('[messenger] loadChats error:', e.message);
        return { error: 'Chats loading error: ' + e.message };
    }
}

async function loadMessages(params, sessionID) {
    const { chatId } = params || {};

    if (!chatId) {
        return { error: 'chatId not specified' };
    }

    if (!modelsDB || !modelsDB.Messenger_Messages || !modelsDB.Messenger_ChatMembers) {
        return { error: 'Messenger models unavailable' };
    }

    // Get user from session
    const user = await global.getUserBySessionID(sessionID);
    if (!user) {
        return { error: 'User not authorized' };
    }

    try {
        // Check if user is in chat
        const membership = await modelsDB.Messenger_ChatMembers.findOne({
            where: { chatId, userId: user.id, isActive: true }
        });

        if (!membership) {
            return { error: 'Chat access denied' };
        }

        // Load chat messages with author info
        const messages = await modelsDB.Messenger_Messages.findAll({
            where: { chatId },
            include: [{
                model: modelsDB.Users,
                as: 'author',
                attributes: ['id', 'name']
            }],
            order: [['createdAt', 'ASC']],
            limit: 100 // Last 100 messages
        });

        const formattedMessages = messages.map(m => ({
            id: m.id,
            content: m.content,
            authorId: m.userId,
            authorName: m.author ? m.author.name : 'Unknown',
            createdAt: m.createdAt,
            isRead: m.isRead
        }));

        return { messages: formattedMessages, chatName: membership.customName };
    } catch (e) {
        console.error('[messenger] loadMessages error:', e.message);
        return { error: 'Messages loading error: ' + e.message };
    }
}

// SSE subscription to chat updates
function subscribeToChat(params, sessionID, req, res) {
    let { chatId } = params || {};
    chatId = parseInt(chatId); // Cast to number

    if (!chatId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'chatId not specified' }));
        return { _handled: true };
    }

    if (!modelsDB || !modelsDB.Messenger_ChatMembers) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Messenger models unavailable' }));
        return { _handled: true };
    }

    // Async access check and SSE setup
    (async () => {
        try {
            // Get user
            const user = await global.getUserBySessionID(sessionID);
            if (!user) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'User not authorized' }));
                return;
            }

            // Check access
            const membership = await modelsDB.Messenger_ChatMembers.findOne({
                where: { chatId, userId: user.id, isActive: true }
            });

            if (!membership) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Chat access denied' }));
                return;
            }

            // Setup SSE
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });

            // Add client
            const clientId = Math.random().toString(36).substr(2, 9);
            console.log('[messenger] subscribeToChat: chatId =', chatId, 'type:', typeof chatId, 'clientId:', clientId);
            if (!sseClients.has(chatId)) {
                sseClients.set(chatId, new Set());
            }
            const client = { res, userId: user.id, clientId };
            sseClients.get(chatId).add(client);

            console.log(`[messenger] [${new Date().toISOString()}] SSE: user ${user.name} subscribed to chat ${chatId} (client: ${clientId})`);
            console.log('[messenger] sseClients keys:', Array.from(sseClients.keys()), 'total clients:', sseClients.get(chatId).size);

            // Send connection confirmation
            res.write(`data: ${JSON.stringify({ type: 'connected', chatId })}\n\n`);

            // Disconnect handler
            req.on('close', () => {
                console.log(`[messenger] [${new Date().toISOString()}] req.on('close') triggered for user ${user.name} chat ${chatId} (client: ${clientId})`);
                const clients = sseClients.get(chatId);
                console.log('[messenger] Clients in map before delete:', clients?.size || 0);
                if (clients) {
                    clients.delete(client);
                    console.log('[messenger] Clients in map after delete:', clients.size);
                    if (clients.size === 0) {
                        sseClients.delete(chatId);
                        console.log('[messenger] Deleted chatId from Map:', chatId);
                    }
                }
                console.log(`[messenger] [${new Date().toISOString()}] SSE: user ${user.name} disconnected from chat ${chatId} (client: ${clientId})`);
            });

            console.log(`[messenger] [${new Date().toISOString()}] Close handler registered (client: ${clientId})`);
            console.log('[messenger] Map state after setup:', Array.from(sseClients.keys()), 'size:', sseClients.get(chatId)?.size);
        } catch (e) {
            console.error('[messenger] subscribeToChat error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Subscription error: ' + e.message }));
        }
    })();

    // Return immediately to avoid blocking
    return { _handled: true };
}

// Broadcast message to all chat subscribers
function broadcastMessage(chatId, message) {
    console.log('[messenger] broadcastMessage: chatId =', chatId, 'type:', typeof chatId);
    console.log('[messenger] sseClients keys:', Array.from(sseClients.keys()));
    console.log('[messenger] broadcastMessage called:', { chatId, clientsCount: sseClients.get(chatId)?.size || 0 });
    const clients = sseClients.get(chatId);
    if (!clients || clients.size === 0) {
        console.log('[messenger] No clients subscribed to chat', chatId);
        return;
    }

    const data = JSON.stringify({
        type: 'newMessage',
        message
    });
    console.log('[messenger] Broadcasting to', clients.size, 'clients:', data);

    clients.forEach(client => {
        try {
            client.res.write(`data: ${data}\n\n`);
            console.log('[messenger] Message sent to client userId:', client.userId);
        } catch (e) {
            console.error('[messenger] SSE send error:', e.message);
            clients.delete(client);
        }
    });
}

async function sendMessage(params, sessionID) {
    let { chatId, content } = params || {};
    chatId = parseInt(chatId); // Cast to number
    console.log('[messenger] sendMessage called:', { chatId, content, sessionID });
    console.log('[messenger] sendMessage: sseClients keys at start:', Array.from(sseClients.keys()), 'size for chatId:', sseClients.get(chatId)?.size);

    if (!chatId) {
        return { error: 'chatId not specified' };
    }

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return { error: 'Message cannot be empty' };
    }

    if (!modelsDB || !modelsDB.Messenger_Messages || !modelsDB.Messenger_ChatMembers) {
        return { error: 'Messenger models unavailable' };
    }

    // Get user from session
    const user = await global.getUserBySessionID(sessionID);
    if (!user) {
        return { error: 'User not authorized' };
    }

    const sequelize = modelsDB.Users.sequelize;

    try {
        const result = await sequelize.transaction(async (t) => {
            // Check if user is in chat
            const membership = await modelsDB.Messenger_ChatMembers.findOne({
                where: { chatId, userId: user.id, isActive: true },
                transaction: t
            });

            if (!membership) {
                throw new Error('Chat access denied');
            }

            // Create message
            const message = await modelsDB.Messenger_Messages.create({
                chatId,
                userId: user.id,
                content: content.trim(),
                isRead: false,
                isDelivered: true
            }, { transaction: t });

            return {
                id: message.id,
                content: message.content,
                authorId: user.id,
                authorName: user.name,
                createdAt: message.createdAt
            };
        });

        // Broadcast message to all subscribers AFTER successful transaction
        console.log('[messenger] Calling broadcastMessage:', { chatId, message: result });
        broadcastMessage(chatId, result);
        console.log('[messenger] broadcastMessage completed');

        return {
            success: true,
            message: result
        };
    } catch (e) {
        console.error('[messenger] sendMessage error:', e.message);
        return { error: 'Message sending error: ' + e.message };
    }
}


// Create private chat for two users
// params: { user1: userModel, user2: userModel } - accepts sequelize users models
// transaction: if passed, uses this transaction, otherwise creates new one
async function createTwoUserChat(params, sessionID, transaction) {
    const { user1, user2 } = params || {};
    if (!user1 || !user2 || user1.id === user2.id) {
        throw new Error('Two different users required: user1 and user2 (sequelize model objects)');
    }
    if (!modelsDB || !modelsDB.Messenger_Chats || !modelsDB.Messenger_ChatMembers) {
        throw new Error('Messenger models unavailable');
    }

    const sequelize = modelsDB.Users.sequelize;

    const createChat = async (t) => {
        // Create chat, owner is first user
        const chat = await modelsDB.Messenger_Chats.create({
            userId: user1.id,
            name: `Dialog: ${user1.name} ↔ ${user2.name}`,
            description: 'Private dialog of two users',
            isActive: true,
        }, { transaction: t });

        // Add both members with personal names (customName)
        await modelsDB.Messenger_ChatMembers.create({
            chatId: chat.id,
            userId: user1.id,
            role: 'owner',
            customName: user2.name,
            joinedAt: new Date(),
            isActive: true,
        }, { transaction: t });

        await modelsDB.Messenger_ChatMembers.create({
            chatId: chat.id,
            userId: user2.id,
            role: 'member',
            customName: user1.name,
            joinedAt: new Date(),
            isActive: true,
        }, { transaction: t });

        return { chatId: chat.id };
    };

    // If transaction passed, use it; otherwise create new
    if (transaction) {
        return await createChat(transaction);
    } else {
        return await sequelize.transaction(async (t) => {
            return await createChat(t);
        });
    }
}


module.exports = { onLoad, loadChats, loadMessages, sendMessage, subscribeToChat, createTwoUserChat };