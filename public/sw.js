/* EdgeQuote service worker — offline shell + fast static assets + push.
   Never caches API / Supabase / RSC data, so it can't serve stale app state.

   THREE caches, versioned independently and on purpose:
     eq-core-*  versioned — offline.html, manifest, icons. Tiny; safe to purge.
     eq-shell   NOT versioned — the field routes' HTML.
     eq-static  NOT versioned — /_next/static, which is content-hashed + immutable.

   Why the last two survive a release: they used to sit in one versioned cache that
   `activate` purged, and the file's own instruction was "bump CACHE on a new
   release" — so the documented deploy procedure WAS the outage. Reconnect for 20s
   at a gas station, the new SW installs and wipes the shell and every chunk, drive
   to the next driveway with no signal, and the app will not open at all.
   Purging content-hashed assets is also just wrong: their names already encode
   their version, so old and new coexist happily. Keeping them is what lets a shell
   cached before a release still find the chunks it references, instead of a white
   screen. An old-but-working app beats no app; network-first means anyone with
   signal gets the new one anyway. (Cost: old chunks accumulate. They're small and
   bounded by how often we ship.) */
const VERSION = 'v3'
const CORE = `eq-core-${VERSION}`
const SHELL = 'eq-shell'
const STATIC = 'eq-static'
const KEEP = [CORE, SHELL, STATIC]
const PRECACHE = ['/offline.html', '/manifest.webmanifest', '/icon.svg', '/icon-maskable.svg']

// The FIELD routes, listed explicitly. This was `/dashboard` + everything under it,
// which was wrong and was my error: I justified it by claiming every page below the
// layout is 'use client' with no server data, having "verified" it with a grep for
// `createServerClient` — but this repo's server helper is `createClient` from
// @/lib/supabase/server, so the grep could not have found what it was looking for.
// /dashboard is an async server component that fetches invoices/jobs/quotes and
// bakes collected/outstanding into the HTML (and a greeting with today's date).
// Caching that replays a FINANCIAL REPORT offline with full authority — days-old
// receivables reading as live money. Six Grow routes are server components too.
//
// So: an allowlist, not a pattern. A denylist would silently start caching money
// the day someone converts one of these to a server component; an allowlist fails
// closed (worst case a route just isn't available offline). Both entries below are
// 'use client' — they hold no server-rendered data — and they are the field
// workflow: the day board, and the invoice a deep link opens.
const FIELD_SHELLS = ['/dashboard/schedule', '/dashboard/invoices']
function isFieldShell(url) {
  return FIELD_SHELLS.indexOf(url.pathname) !== -1
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
    caches.open(CORE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => KEEP.indexOf(k) === -1).map((k) => caches.delete(k)))
    // Warm the day board while we still have signal. `activate` only runs after this
    // SW was downloaded, so we are online RIGHT NOW — the one guaranteed moment to
    // get a shell on disk. Without this the shell only ever appeared as a side effect
    // of an online visit, so installing the PWA and first opening it in a driveway
    // went straight to offline.html: there was no guaranteed-openable state after
    // install. Best-effort: signed-out users get a redirect (skipped), and a failure
    // here must never block activation.
    try {
      const res = await fetch('/dashboard/schedule', { credentials: 'same-origin' })
      if (res && res.ok && !res.redirected) {
        const c = await caches.open(SHELL)
        await c.put(new Request(self.location.origin + '/dashboard/schedule'), res.clone())
      }
    } catch (e) { /* offline at activate — the next online visit caches it */ }
    await self.clients.claim()
  })())
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
          caches.open(SHELL).then((c) => c.put(shellKey(url), copy)).catch(() => {})
        }
        return res
      } catch (e) {
        // THIS path's shell only. It used to fall back to the schedule for any
        // /dashboard/* miss, which left the URL bar reading /dashboard/invoices while
        // the day board rendered — and Next then hydrated router state from the
        // schedule's flight data, so URL and app disagreed for the rest of the
        // session. A page we can't serve should say so, not quietly serve another one.
        if (isFieldShell(url)) {
          const hit = await caches.match(shellKey(url))
          if (hit) return hit
        }
        // /dashboard is the manifest's start_url and we must never cache it (it's a
        // server-rendered financial report). Offline, send the contractor to the day
        // board — a REAL redirect, so the URL matches what renders, rather than
        // serving the schedule under the /dashboard URL. It's also where a contractor
        // wants to be with no signal.
        if (url.pathname === '/dashboard') {
          const day = await caches.match(new Request(url.origin + '/dashboard/schedule'))
          if (day) return Response.redirect(url.origin + '/dashboard/schedule', 302)
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
        // `res.ok` is the difference between a blip and a brick. Without it a chunk
        // that resolved 404/500 once — a deploy rotation, an edge blip, a captive
        // portal answering with its own HTML — was cached PERMANENTLY under a
        // content-hashed URL that will never change. Cache-first then served that
        // failure forever, back online included: a white screen no reload could fix,
        // recoverable only by clearing site data. (The navigation path already
        // checked this; this one didn't.)
        if (res && res.ok) {
          const copy = res.clone()
          caches.open(STATIC).then((c) => c.put(req, copy)).catch(() => {})
        }
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
