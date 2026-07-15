// push.js — Web Push notifications (these work even when the browser/tab is fully closed,
// unlike the in-page Notification API the app already uses for "tab open in the background").
// Docs: https://github.com/web-push-libs/web-push
const webpush = require('web-push');
const db = require('./db');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

const enabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (enabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  // Not fatal — the app runs fine without this, staff just won't get notified while the
  // browser/tab is fully closed (the existing in-tab notification still works while it's open,
  // even in the background).
  console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY chưa được cấu hình — thông báo khi tắt màn hình sẽ không hoạt động.');
}

/**
 * Send a push notification to every device that has ever clicked "🔔 Bật thông báo".
 * Best-effort: a subscription the browser has revoked (Push service replies 404/410) is deleted
 * so we stop wasting calls on it; any other failure is just logged, never thrown back to the caller
 * (a failed push must never block saving the incoming message).
 */
async function sendPushToAll({ title, body }) {
  if (!enabled) return;
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  if (!subs.length) return;
  const payload = JSON.stringify({ title, body, icon: '/icon-192.png' });
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        } else {
          console.error('[push] gửi thất bại', e.statusCode, e.message);
        }
      }
    })
  );
}

module.exports = { sendPushToAll, publicKey: VAPID_PUBLIC_KEY, enabled };
