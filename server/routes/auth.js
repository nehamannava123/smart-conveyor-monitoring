const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { verifyCredentials, issueToken, validatePasswordStrength } = require('../services/authService');
const { requireAuth, requireRole } = require('../middleware/auth');
const db = require('../config/db');

const router = express.Router();

// Throttle login attempts to protect against brute-force attacks
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes before retrying.' }
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Valid username and password are required' });
  }

  const cleanUsername = username.trim().toLowerCase();
  const user = verifyCredentials(cleanUsername, password);

  if (!user) {
    db.addAudit({
      id: uuid(),
      at: new Date().toISOString(),
      actor: cleanUsername.slice(0, 50),
      action: 'LOGIN_FAILED',
      zoneId: null,
      detail: 'Invalid credentials or user does not exist'
    });
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = issueToken(user);
  db.addAudit({
    id: uuid(),
    at: new Date().toISOString(),
    actor: user.username,
    action: 'LOGIN_SUCCESS',
    zoneId: null,
    detail: `Authenticated as ${user.role}`
  });

  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role, displayName: user.displayName }
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Admin-only user provisioning endpoint
router.post('/users', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { username, password, role, displayName } = req.body || {};
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'username, password, and role are required' });
  }
  const cleanUsername = String(username).trim().toLowerCase();
  const validRoles = ['ADMIN', 'OPERATOR', 'VIEWER'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
  }
  if (!validatePasswordStrength(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }
  if (db.findUserByUsername(cleanUsername)) {
    return res.status(409).json({ error: 'Username already in use' });
  }

  const newUser = {
    id: uuid(),
    username: cleanUsername,
    passwordHash: bcrypt.hashSync(password, 10),
    role,
    displayName: (displayName || cleanUsername).trim(),
    createdAt: new Date().toISOString(),
    createdBy: req.user.username
  };

  db.addUser(newUser);
  db.addAudit({
    id: uuid(),
    at: new Date().toISOString(),
    actor: req.user.username,
    action: 'USER_CREATED',
    zoneId: null,
    detail: `Created user ${cleanUsername} with role ${role}`
  });

  res.status(201).json({
    user: { id: newUser.id, username: newUser.username, role: newUser.role, displayName: newUser.displayName }
  });
});

module.exports = router;
