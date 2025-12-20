// sessionManager.js
// Session management: cache + DB interaction via Sequelize

const path = require('path');
const Sequelize = require('sequelize');
const sequelize = require('./sequelize_instance');
const dbConfig = require('./db.json');
const modelsDef = dbConfig.models;

// Dynamically create Sessions model (and Users if needed)
const sessionDef = modelsDef.find(m => m.name === 'Sessions');
const userDef = modelsDef.find(m => m.name === 'Users');

const Session = sequelize.define(sessionDef.name, Object.fromEntries(
  Object.entries(sessionDef.fields).map(([k, v]) => [k, { ...v, type: Sequelize.DataTypes[v.type] }])
), { ...sessionDef.options, tableName: sessionDef.tableName });

const User = sequelize.define(userDef.name, Object.fromEntries(
  Object.entries(userDef.fields).map(([k, v]) => [k, { ...v, type: Sequelize.DataTypes[v.type] }])
), { ...userDef.options, tableName: userDef.tableName });

// Session cache: Map<sessionId, { userId, isGuest, sessionId }>
const sessionCache = new Map();

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    cookies[name] = decodeURIComponent(rest.join('='));
  });
  return cookies;
}

async function getOrCreateSession(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  let sessionId = cookies.sessionID;
  let session = null;

  // Check cache
  if (sessionId && sessionCache.has(sessionId)) {
    session = sessionCache.get(sessionId);
  } else if (sessionId) {
    // Check DB
    session = await Session.findOne({ where: { sessionId } });
    if (session) {
      sessionCache.set(sessionId, session);
    }
  }

  // If no session exists - create new one
  if (!session) {
    // Remove old session if it existed
    if (sessionId) {
      await Session.destroy({ where: { sessionId } });
      sessionCache.delete(sessionId);
    }
    // Generate new
    sessionId = generateSessionId();
    session = await Session.create({ sessionId, userId: null, isGuest: true });
    sessionCache.set(sessionId, session);
    // Set cookie
    res.setHeader('Set-Cookie', `sessionID=${sessionId}; Path=/; HttpOnly`);
  }

  return session;
}

function generateSessionId() {
  // UUID-like, could be replaced with uuid/v4
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  ).slice(0, 36);
}

module.exports = {
  getOrCreateSession,
  sessionCache,
};
