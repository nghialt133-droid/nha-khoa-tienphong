// sw.js — minimal service worker: only listens for push events so a notification can pop up
// on the phone/computer lock screen even when this app's tab/browser is fully closed (a normal
// in-page Notification() call cannot do that — it needs the tab running).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'Hộp thư hợp nhất';
  const body = data.body || 'Bạn có tin nhắn mới.';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: data.icon || '/icon-192.png',
      badge: '/icon-192.png',
    })
  );
});

// Clicking the notification focuses an already-open tab of the app if there is one,
// otherwise opens a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
