// Global server context
const global = require('../../drive_root/globalServerContext');
const formsGlobal = require('../../drive_forms/globalServerContext');
const rootGlobal = require('../../drive_root/globalServerContext');
const { hashPassword, validatePassword } = require('../../drive_root/db/utilites');

// Server function for connection test
async function testConnection(params, sessionID) {
	if (!sessionID) {
		return { error: 'sessionID required' };
	}
	// Here we can add sessionID validity check
	let user = await global.getUserBySessionID(sessionID);
	let role = await formsGlobal.getUserAccessRole(user);
	return role;
}

// login as guest
async function loginAsGuest(params, sessionID) {
	const guestUser = await rootGlobal.createGuestUser(sessionID, ['mySpace'], ['public']);
}

async function createUser(params, sessionID) {
    const { username, password } = params;
    if (!username || !password) {
        return { success: false, error: 'Username and password required' };
    }

    try {
        // Check if user exists
        const existingUser = await global.modelsDB.Users.findOne({ where: { name: username } });
        if (existingUser) {
            return { success: false, error: 'User already exists' };
        }

        // Create user
        // We use createNewUser to set up roles and systems, then update password
        const user = await rootGlobal.createNewUser(sessionID, username, ['mySpace'], ['user']);
        
        // Update password
        const hashedPassword = await hashPassword(password);
        await user.update({ password_hash: hashedPassword });

        return { success: true };
    } catch (e) {
        console.error('Create user error:', e);
        return { success: false, error: e.message };
    }
}

async function login(params, sessionID) {
    const { username, password } = params;
    if (!username || !password) {
        return { success: false, error: 'Username and password required' };
    }

    try {
        // Find user with password hash
        const user = await global.modelsDB.Users.scope('withPassword').findOne({ where: { name: username } });
        if (!user) {
            return { success: false, error: 'User not found' };
        }

        if (user.isGuest) {
             return { success: false, error: 'Cannot login as guest with password' };
        }

        // Validate password
        const isValid = await validatePassword(password, user.password_hash);
        if (!isValid) {
            return { success: false, error: 'Invalid password' };
        }

        // Update session
        const session = await global.modelsDB.Sessions.findOne({ where: { sessionId: sessionID } });
        if (session) {
            await session.update({ userId: user.id });
        } else {
            await global.modelsDB.Sessions.create({ sessionId: sessionID, userId: user.id });
        }

        return { success: true };
    } catch (e) {
        console.error('Login error:', e);
        return { success: false, error: e.message };
    }
}

module.exports = { testConnection, loginAsGuest, createUser, login };
