// NEXUS · ABION — Service Worker
// Ported from the MVP sw.js (PRD §15: stale-while-revalidate for core
// assets, offline read access). Only change from the MVP version: the
// hardcoded old Vercel URL is gone — self.location.origin is always
// correct regardless of where this gets deployed.
//
// v1 -> v2: bumped alongside the /api//auth/ fetch-handler exclusion
// below (NEXT_STEPS.md A0, logout investigation) purely so this file's
// bytes actually change. Browsers only re-run the SW update algorithm
// when the served script differs from the currently-registered one —
// an unchanged CACHE string next to changed fetch-handler logic risks a
// browser treating a byte-identical-looking deploy as "nothing to
// update" depending on how aggressively the host caches /sw.js itself.
// `skipWaiting()`/`clients.claim()` below already make a real update
// take over immediately once the browser does fetch it; this line is
// the other half — making sure it fetches it at all.
const CACHE = 'nexus-v2';
const ASSETS = ['/'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Only cache same-origin GET requests; pass everything else through.
  // The origin check below already excludes /api/v1/* calls in today's
  // deployment (API and web app are cross-origin — server.ts's CORS
  // setup exists for exactly that reason), but that's the API being on
  // a different *origin*, not this worker actually knowing what an auth
  // endpoint is. Made explicit here rather than left as an accident of
  // topology: if the API is ever proxied same-origin (a common pattern
  // specifically to simplify cookie handling), this still refuses to
  // cache anything under /api/ or /auth/ — auth.ts's own `Cache-Control:
  // no-store` on that router is the other half of this same guard.
  const url = new URL(e.request.url);
  const isApiPath = url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/');
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || isApiPath) return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresh = fetch(e.request)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});

// ── Web Push — team chat + task thread notifications (PRD §10.4) ──
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'NEXUS', body: event.data ? event.data.text() : 'New message' };
  }

  const title = data.title || 'NEXUS';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'nexus-chat',
    data: { url: data.url || self.location.origin + '/' },
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.location.origin + '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If NEXUS is already open, hand the target URL to the page itself
      // via postMessage rather than reloading to the homepage — the page
      // navigates in-place to the right task/thread.
      for (const client of clientList) {
        if (client.url.indexOf(new URL(url).origin) === 0) {
          client.postMessage({ type: 'nexus-navigate', url });
          if ('focus' in client) return client.focus();
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
