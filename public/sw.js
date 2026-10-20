// HillGuard service worker — caches the app shell so the icon opens instantly
// and the UI still loads if the network briefly drops. API/socket calls
// always go to the network (live data should never be served stale).
const CACHE = "hillguard-shell-v1";
const SHELL = [
  "/",
  "/css/style.css",
  "/js/app.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls or socket.io traffic — always live.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/")) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// ---------------------------------------------------------------------
// Push notifications — this is what makes HillGuard alerts show up as
// real Android/desktop OS notifications, even when the app isn't open.
// The payload is built server-side in server/services/push.js.
// ---------------------------------------------------------------------
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "HillGuard alert", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "HillGuard alert";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.tag || "hillguard-alert", // same tag replaces the previous notification for that zone instead of piling up
    renotify: true,
    vibrate: data.level === "CRITICAL" ? [200, 100, 200, 100, 200] : [120],
    data: { url: data.url || "/", alertId: data.alertId, zoneId: data.zoneId },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification focuses an already-open HillGuard tab/app if one
// exists, otherwise opens a new one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if ("focus" in client) {
          client.postMessage({ type: "HILLGUARD_NOTIFICATION_CLICK", zoneId: event.notification.data?.zoneId });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
