/* EdgeQuote service worker — offline shell + fast static assets + push.
   Conservative by design: never caches API / Supabase / RSC data, so it can't
   serve stale app state. It DOES cache the dashboard's HTML shell (see
   isFieldShell) — that's chrome, not state: those pages render no server data, so
   there's nothing stale to serve, and without it a cold start with no signal can't
   open the app at all. Bump CACHE to invalidate on a new release. */
const CACHE = 'eq-v2'
const PRECACHE = ['/offline.html', '/manifest.webmanifest', '/icon.svg', '/icon-maskable.svg']

// The dashboard is the field app. Its pages are shells: /dashboard/layout is the
// only server component and it renders no business data — every page below it is
// 'use client' and pulls from Supabase in the BROWSER. So caching this HTML caches
// chrome, not app state, which is the thing the "no stale data" rule above exists
// to protect. Data offline is handled where it belongs (lib/clientCache).
function isFieldShell(url) {
  return url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')
}

// Key shells by PATHNAME only. A field deep link carries query (?job=…&pay=1 from
// "Get paid"), and the page reads the REAL url from window.location once it boots —
// so one cached shell serves every variant instead of the cache filling with a copy
// per link, and a deep link still opens with no signal.
function shellKey(url) {
  return new Request(url.origin + url.pathname)
}

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

  // Page navigations: network-first (fresh always wins), but remember the last good
  // dashboard shell. Without this the whole offline story was unreachable: a phone
  // kills the app between stops, so the next launch in a driveway is a COLD start —
  // it went straight to offline.html, and the cached day, the queued check-ins and
  // the pending photos sat there with no app to open them.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req)
        // `redirected` matters: the dashboard layout bounces to /login when the
        // session is gone. Caching THAT under /dashboard/schedule would pin a login
        // page as the field shell forever.
        if (res && res.ok && !res.redirected && isFieldShell(url)) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(shellKey(url), copy)).catch(() => {})
        }
        return res
      } catch (e) {
        if (isFieldShell(url)) {
          // This exact page, else the day board, else the dashboard home — a
          // contractor with no signal should land on work, not on an apology.
          const hit = (await caches.match(shellKey(url)))
            || (await caches.match(new Request(url.origin + '/dashboard/schedule')))
            || (await caches.match(new Request(url.origin + '/dashboard')))
          if (hit) return hit
        }
        return (await caches.match('/offline.html')) || Response.error()
      }
    })())
    return
  }

  // RSC payloads stay on the network, deliberately. They vary by the router-state
  // header, so any cache key we could invent here would sometimes hand the router a
  // payload for a different navigation — a subtly broken page is worse than a failed
  // one. Letting the fetch fail makes Next fall back to a full navigation, which the
  // handler above serves from the shell cache. Same destination, no guessing.

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
