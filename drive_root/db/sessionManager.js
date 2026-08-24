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

const { generateUID } = require('./utilites');

const Session = sequelize.define(sessionDef.name, Object.fromEntries(
  Object.entries(sessionDef.fields).map(([k, v]) => {
      const fieldDef = require('./fieldTypes').resolveFieldDef(v);
      if (fieldDef.defaultValue === 'GENERATE_UID') {
          fieldDef.defaultValue = () => generateUID('Session');
      }
      return [k, fieldDef];
  })
), { ...sessionDef.options, tableName: sessionDef.tableName });

const User = sequelize.define(userDef.name, Object.fromEntries(
  Object.entries(userDef.fields).map(([k, v]) => {
      const fieldDef = require('./fieldTypes').resolveFieldDef(v);
      if (fieldDef.defaultValue === 'GENERATE_UID') {
          fieldDef.defaultValue = () => generateUID('User');
      }
      return [k, fieldDef];
  })
), { ...userDef.options, tableName: userDef.tableName });

// Session cache: Map<sessionId, { userId, isGuest, sessionId }>
// 1.4: раньше new Map() рос бессрочно (запись на каждую виденную сессию, включая
// мусорные от прежней гонки 0.7). BoundedTTLMap (TTL 24ч, max 5000) ограничивает
// рост; протухшее подчищает общий sweeper memory_store. API set/get/has/delete
// совместим с Map.
const { BoundedTTLMap } = require('../memory_store');
const sessionCache = new BoundedTTLMap({ ttl: 24 * 60 * 60 * 1000, max: 5000 });

// Таблица `sessions` уходит вместе со старой схемой, а кэш продолжал бы считать
// пользователя вошедшим. Подписка — рядом с кэшем (см. dbLifecycle).
require('../dbLifecycle').onDatabaseReset('sessionManager', () => {
    if (typeof sessionCache.clear === 'function') sessionCache.clear();
});

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
    // Generate new session WITHOUT user - user will be created via login/guest button
    sessionId = generateSessionId();
    session = await Session.create({ sessionId, userId: null, isGuest: true });
    
    sessionCache.set(sessionId, session);
    // Set cookie
    res.setHeader('Set-Cookie', `sessionID=${sessionId}; Path=/; HttpOnly`);
    console.log(`[sessionManager] Created new session without user: ${sessionId}`);
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
