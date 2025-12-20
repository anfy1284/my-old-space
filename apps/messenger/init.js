// Messenger app initialization: check and create private chats for all user pairs
const global = require('../../drive_root/globalServerContext');
const messenger = require('./server');

async function ensurePrivateChatsForAllPairs() {
	const { modelsDB } = global;
	if (!modelsDB || !modelsDB.Users || !modelsDB.Messenger_Chats || !modelsDB.Messenger_ChatMembers) {
		console.warn('[messenger:init] Required models unavailable');
		return;
	}

	const sequelize = modelsDB.Users.sequelize;
	await sequelize.transaction(async (t) => {
		const users = await modelsDB.Users.findAll({ attributes: ['id', 'name'], transaction: t });
		// Iterate unique pairs (i<j)
		for (let i = 0; i < users.length; i++) {
			for (let j = i + 1; j < users.length; j++) {
				const u1 = users[i];
				const u2 = users[j];

				// Check if private chat already exists between these users
				// Criteria: chat where both participate as members
				const existingMemberships = await modelsDB.Messenger_ChatMembers.findAll({
					where: { userId: [u1.id, u2.id] },
					transaction: t
				});

				// Group by chatId and check presence of both userIds
				const chatMap = new Map();
				for (const m of existingMemberships) {
					const arr = chatMap.get(m.chatId) || [];
					arr.push(m.userId);
					chatMap.set(m.chatId, arr);
				}
				let hasPrivate = false;
				for (const members of chatMap.values()) {
					const set = new Set(members);
					if (set.has(u1.id) && set.has(u2.id) && set.size === 2) {
						hasPrivate = true;
						break;
					}
				}

				if (!hasPrivate) {
					try {
						await messenger.createTwoUserChat({ user1: u1, user2: u2 });
						console.log(`[messenger:init] Private chat created: ${u1.name} ↔ ${u2.name}`);
					} catch (e) {
						console.error('[messenger:init] Error creating chat for pair', u1.id, u2.id, e.message);
					}
				}
			}
		}
	});
}

// Run on app initialization
ensurePrivateChatsForAllPairs().catch(e => {
	console.error('[messenger:init] Private chats initialization error:', e.message);
});

// Check that all users are in "Local chat"; add missing ones
async function ensureLocalChatIncludesAllUsers() {
	const { modelsDB } = global;
	if (!modelsDB || !modelsDB.Users || !modelsDB.Messenger_Chats || !modelsDB.Messenger_ChatMembers) {
		console.warn('[messenger:init] Required models unavailable for Local chat');
		return;
	}

	const sequelize = modelsDB.Users.sequelize;
	await sequelize.transaction(async (t) => {
		// Get predefined common chat via defaultValuesCache
		const localChatDefId = 1; // from apps/messenger/db/defaultValues.json
		const localChat = global.getDefaultValue('messenger', 'Messenger_Chats', localChatDefId);
		if (!localChat) {
			console.warn('[messenger:init] Predefined "Local chat" not found in defaultValuesCache');
			return;
		}

		// Get all users
		const users = await modelsDB.Users.findAll({ attributes: ['id', 'name'], transaction: t });
		// Current chat members
		const members = await modelsDB.Messenger_ChatMembers.findAll({ where: { chatId: localChat.id }, transaction: t });
		const existingIds = new Set(members.map(m => m.userId));

		// Add missing
		for (const u of users) {
			if (!existingIds.has(u.id)) {
				await modelsDB.Messenger_ChatMembers.create({
					chatId: localChat.id,
					userId: u.id,
					role: u.id === localChat.userId ? 'owner' : 'member',
					customName: 'Local chat',
					joinedAt: new Date(),
					isActive: true,
				}, { transaction: t });
				console.log(`[messenger:init] User added to Local chat: ${u.name}`);
			}
		}
	});
}

ensureLocalChatIncludesAllUsers().catch(e => {
	console.error('[messenger:init] Local chat actualization error:', e.message);
});
