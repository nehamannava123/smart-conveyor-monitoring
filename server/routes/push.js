const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const push = require('../services/push');

module.exports = function pushRouter() {
  const router = express.Router();

  // Public: the client needs this key before it can subscribe. Not a secret.
  router.get('/vapid-public-key', (req, res) => {
    res.json({ publicKey: push.getPublicKey() });
  });

  router.post('/subscribe', requireAuth, (req, res) => {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Missing push subscription' });
    }
    db.addPushSubscription(req.user.username, subscription);
    res.json({ ok: true });
  });

  router.post('/unsubscribe', requireAuth, (req, res) => {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
    const removed = db.removePushSubscriptionByEndpoint(endpoint);
    res.json({ ok: true, removed });
  });

  // Lets you confirm the pipeline works end-to-end from a real phone
  // before waiting for a real fault to occur.
  router.post('/test', requireAuth, async (req, res) => {
    const result = await push.notifyAll({
      title: '🔔 HillGuard test notification',
      body: `Triggered by ${req.user.username} — if you see this, push is working.`,
      tag: 'hillguard-test',
      url: '/'
    });
    res.json({ ok: true, ...result });
  });

  return router;
};
