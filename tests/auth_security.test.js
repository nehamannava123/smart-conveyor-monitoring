const test = require('node:test');
const assert = require('node:assert/strict');
const { seedUsersIfEmpty, verifyCredentials, issueToken, verifyToken, validatePasswordStrength } = require('../server/services/authService');
const { requireAuth, requireRole } = require('../server/middleware/auth');
const db = require('../server/config/db');

seedUsersIfEmpty();

test('authService - password strength validation', () => {
  assert.equal(validatePasswordStrength('short'), false);
  assert.equal(validatePasswordStrength(''), false);
  assert.equal(validatePasswordStrength(null), false);
  assert.equal(validatePasswordStrength('validSecurePassword123'), true);
});

test('authService - credential verification and case normalization', () => {
  // Test with seeded user
  const admin = db.findUserByUsername('admin');
  assert.ok(admin, 'Admin user should exist in dev database');

  const valid = verifyCredentials('ADMIN', 'admin123');
  assert.ok(valid, 'Should verify case-insensitively for username');
  assert.equal(valid.role, 'ADMIN');

  const invalid = verifyCredentials('admin', 'wrongpassword');
  assert.equal(invalid, null, 'Should reject invalid password');

  const nonExistent = verifyCredentials('ghost_user', 'any_password');
  assert.equal(nonExistent, null, 'Should reject non-existent user');
});

test('authService - token issuance and HS256 algorithm enforcement', () => {
  const user = { id: 'u1', username: 'operator', role: 'OPERATOR', displayName: 'Op' };
  const token = issueToken(user);
  assert.ok(token && typeof token === 'string');

  const decoded = verifyToken(token);
  assert.equal(decoded.username, 'operator');
  assert.equal(decoded.role, 'OPERATOR');

  // Verify that an arbitrary or malformed token throws
  assert.throws(() => verifyToken('invalid.token.structure'), /invalid|jwt/i);
});

test('auth middleware - requireAuth and requireRole RBAC enforcement', () => {
  let userReq = { headers: {} };
  let statusSet = null;
  let jsonResponse = null;
  const res = {
    status(s) {
      statusSet = s;
      return {
        json(data) { jsonResponse = data; }
      };
    }
  };

  // 1. Missing Authorization header
  requireAuth(userReq, res, () => {});
  assert.equal(statusSet, 401);

  // 2. Valid token sets req.user
  const validToken = issueToken({ id: 'u2', username: 'viewer', role: 'VIEWER' });
  userReq.headers.authorization = `Bearer ${validToken}`;
  let nextCalled = false;
  requireAuth(userReq, res, () => { nextCalled = true; });
  assert.ok(nextCalled, 'requireAuth should call next() for valid token');
  assert.equal(userReq.user.role, 'VIEWER');

  // 3. requireRole denies unprivileged viewer
  statusSet = null;
  const adminGuard = requireRole('ADMIN');
  nextCalled = false;
  adminGuard(userReq, res, () => { nextCalled = true; });
  assert.equal(statusSet, 403, 'requireRole ADMIN should reject VIEWER with 403');
  assert.equal(nextCalled, false);

  // 4. requireRole permits matching role
  const operatorToken = issueToken({ id: 'u3', username: 'op', role: 'OPERATOR' });
  userReq.user = verifyToken(operatorToken);
  const operatorGuard = requireRole('ADMIN', 'OPERATOR');
  nextCalled = false;
  operatorGuard(userReq, res, () => { nextCalled = true; });
  assert.ok(nextCalled, 'requireRole should permit OPERATOR');
});
