/**
 * Web Push notification service.
 *
 * This is what makes alerts show up as real OS-level notifications on
 * Android (and desktop Chrome/Edge/Firefox) once HillGuard is installed as
 * a PWA - no Firebase project or native app store needed. It uses the
 * standard Push API + VAPID, the same mechanism every browser supports
 * natively.
 *
 * VAPID keys identify this server to the push service (Google's FCM proxy
 * for Chrome, Mozilla's autopush for Firefox, etc.) - they are NOT secret
 * per-user credentials, just this deployment's signing keypair. Safe
 * defaults are generated below if none are supplied via .env, purely so
 * the project runs out of the box; for a real deployment, generate your
 * own with `npx web-push generate-vapid-keys` and put them in .env so they
 * stay stable across restarts (subscriptions are tied to the public key
 * that was active when the browser subscribed).
 */
const webpush = require('web-push');
const db = require('../config/db');


let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  // No keys configured: generate an ephemeral pair. Browser push subscriptions
  // will stop working after a restart - set VAPID_* in .env for stable keys.
  const generated = webpush.generateVAPIDKeys();
  VAPID_PUBLIC_KEY = generated.publicKey;
  VAPID_PRIVATE_KEY = generated.privateKey;
  console.warn('[push] VAPID keys not set - generated temporary keys. Run `npx web-push generate-vapid-keys` and set them in .env.');
}

webpush.setVapidDetails(
  'mailto:ops@hillguard.local',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

function getPublicKey() {
  return VAPID_PUBLIC_KEY;
}

async function notifyAll(payload) {
  const subs = db.getPushSubscriptions();
  if (!subs.length) return { sent: 0, removed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;

  await Promise.all(
    subs.map(async (entry) => {
      try {
        await webpush.sendNotification(entry.subscription, body);
        sent += 1;
      } catch (err) {
        // 404/410 = the browser unsubscribed or the install was removed;
        // clean up so we stop wasting sends on a dead endpoint.
        if (err.statusCode === 400 || err.statusCode === 403 || err.statusCode === 404 || err.statusCode === 410) {
          db.removePushSubscriptionByEndpoint(entry.subscription.endpoint);
          removed += 1;
        } else {
          console.warn('[push] notification delivery skipped:', err.statusCode || err.message);
        }
      }
    })
  );

  return { sent, removed };
}

// Builds the notification payload from a HillGuard alert object.
function alertToPushPayload(alert, zoneName) {
  const severityEmoji = { WARNING: '⚠️', CRITICAL: '🚨' };
  return {
    title: `${severityEmoji[alert.level] || '🔔'} ${zoneName || alert.zoneId} — ${alert.level}`,
    body: alert.message,
    tag: `hillguard-${alert.zoneId}`, // replaces older notifications for the same zone instead of stacking
    url: '/',
    level: alert.level,
    zoneId: alert.zoneId,
    alertId: alert.id
  };
}

module.exports = { getPublicKey, notifyAll, alertToPushPayload };
