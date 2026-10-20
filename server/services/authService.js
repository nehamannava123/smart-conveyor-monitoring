const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const db = require('../config/db');

const IS_PROD = process.env.NODE_ENV === 'production';

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.startsWith('change-this') || JWT_SECRET.length < 32) {
  if (IS_PROD) {
    throw new Error(
      'FATAL CONFIGURATION ERROR: JWT_SECRET must be set to a cryptographically secure random string ' +
      'of at least 32 characters in production. Server startup aborted.'
    );
  }
  JWT_SECRET = require('crypto').randomBytes(48).toString('hex');
  console.warn('[auth] JWT_SECRET not set or weak - using a temporary random secret for development.');
}

const JWT_EXPIRY = process.env.JWT_EXPIRY || '8h';
const JWT_ALGORITHM = 'HS256';

function validatePasswordStrength(password) {
  if (!password || typeof password !== 'string') return false;
  return password.length >= 8;
}

function seedUsersIfEmpty() {
  if (db.getUsers().length > 0) return;

  if (IS_PROD) {
    // In production, require explicitly configured administrator credentials.
    const adminPassword = process.env.INITIAL_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
    if (!adminPassword || !validatePasswordStrength(adminPassword)) {
      throw new Error(
        'FATAL CONFIGURATION ERROR: In production, INITIAL_ADMIN_PASSWORD must be configured ' +
        'with at least 8 characters for initial provisioning. Default demo passwords are disabled in production.'
      );
    }
    const hash = bcrypt.hashSync(adminPassword, 12);
    db.addUser({
      id: uuid(),
      username: (process.env.INITIAL_ADMIN_USERNAME || 'admin').trim().toLowerCase(),
      passwordHash: hash,
      role: 'ADMIN',
      displayName: 'System Administrator',
      createdAt: new Date().toISOString()
    });
    console.log('[auth] Seeded production initial administrator account.');
    return;
  }

  // Development / Demo seeding
  const devUsers = [
    { username: 'admin', password: process.env.ADMIN_PASSWORD || 'admin123', role: 'ADMIN', displayName: 'Site Administrator' },
    { username: 'operator', password: process.env.OPERATOR_PASSWORD || 'operator123', role: 'OPERATOR', displayName: 'Control Room Operator' },
    { username: 'viewer', password: process.env.VIEWER_PASSWORD || 'viewer123', role: 'VIEWER', displayName: 'Read-only Viewer' }
  ];

  for (const u of devUsers) {
    const hash = bcrypt.hashSync(u.password, 10);
    db.addUser({
      id: uuid(),
      username: u.username.trim().toLowerCase(),
      passwordHash: hash,
      role: u.role,
      displayName: u.displayName,
      createdAt: new Date().toISOString()
    });
  }
  console.log('[auth] Development mode: Seeded demo users (admin, operator, viewer).');
}

function verifyCredentials(rawUsername, password) {
  if (!rawUsername || !password || typeof rawUsername !== 'string' || typeof password !== 'string') {
    return null;
  }
  const username = rawUsername.trim().toLowerCase();
  const user = db.findUserByUsername(username);
  if (!user || !user.passwordHash) return null;
  const ok = bcrypt.compareSync(password, user.passwordHash);
  if (!ok) return null;
  return user;
}

function issueToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, displayName: user.displayName },
    JWT_SECRET,
    { algorithm: JWT_ALGORITHM, expiresIn: JWT_EXPIRY }
  );
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') throw new Error('Token missing or invalid format');
  return jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
}

module.exports = {
  seedUsersIfEmpty,
  verifyCredentials,
  issueToken,
  verifyToken,
  JWT_SECRET,
  JWT_ALGORITHM,
  validatePasswordStrength
};
