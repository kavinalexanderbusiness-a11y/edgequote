/* EdgeQuote service worker — offline shell + fast static assets + push.
   Conservative by design: never caches API / Supabase / RSC data, so it can't
   serve stale app state. Bump CACHE to invalidate on a new release. */
const CACHE = 'eq-v1'
const PRECACHE = ['/offline.html', '/manifest.webmanifest', '/icon.svg', '/icon-maskable.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // Only handle same-origin; never touch Supabase, Google Maps, Open-Meteo, etc.
  if (url.origin !== self.location.origin) return

  // Page navigations: network-first, fall back to the offline page when offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')))
    return
  }

  // Immutable hashed assets + our icons: cache-first (instant repeat launches).
  const cacheFirst = url.pathname.startsWith('/_next/static')
    || url.pathname.startsWith('/icon')
    || url.pathname.endsWith('.svg')
    || url.pathname === '/manifest.webmanifest'
  if (cacheFirst) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(req, copy))
        return res
      }))
    )
    return
  }
  // Everything else (API, RSC data, etc.) → straight to network.
})

// ── Push: show the notification + update the app-icon badge ──
// Payload is sent by /api/push/send: { title, body, url, tag, badge }.
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch (e) { data = {} }
  const title = data.title || 'EdgeQuote'
  // App-icon badge to the unread count the server computed (best-effort).
  if (typeof data.badge === 'number' && self.navigator && self.navigator.setAppBadge) {
    if (data.badge > 0) self.navigator.setAppBadge(data.badge).catch(() => {})
    else if (self.navigator.clearAppBadge) self.navigator.clearAppBadge().catch(() => {})
  }
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || '/dashboard' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/dashboard'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(target) && 'focus' in client) return client.focus()
      }
      if (self.clients.openWindow) return self.clients.openWindow(target)
    })
  )
})
