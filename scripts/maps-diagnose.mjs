// ── Maps configuration diagnosis, from the outside ───────────────────────────
// Answers "why is there no map / why did geocoding fail" with Google's OWN words
// instead of a guess, by doing what the app does from a real browser at a real
// origin. Written because on 2026-08-23 production carried TWO unrelated Maps
// faults at once, on two different keys, and each one's symptom hid the other's.
//
//   node scripts/maps-diagnose.mjs <origin> [--key <browser key>] [--server]
//
//   <origin>    e.g. https://app.edgehq.ca — the ORIGIN MATTERS: an HTTP-referrer
//               restriction is per-origin, so app.edgehq.ca passing tells you
//               nothing about edgehq.ca.
//   --key       the browser key to test. Defaults to reading whatever the site
//               actually ships in its own JS bundle, which is the honest thing to
//               test — a key in a .env file it isn't deployed with proves nothing.
//   --server    also sign in as the owner and exercise the SERVER-key routes
//               (/api/geocode, /api/distance, /api/places/autocomplete). Needs
//               PORTAL_RPC_OWNER_EMAIL/PASSWORD in .env.local. Read-only.
//
// ⭐ WHY BOTH HALVES. The browser key and GOOGLE_MAPS_API_KEY are different
// credentials with different restrictions and different failure modes. The map
// can be broken while geocoding is fine, and vice versa, and the fix for one is
// never the fix for the other.
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const args = process.argv.slice(2)
const origin = (args[0] || '').replace(/\/+$/, '')
if (!origin || origin.startsWith('--')) {
  console.error('usage: node scripts/maps-diagnose.mjs <origin> [--key <k>] [--server]')
  process.exit(2)
}
const keyArg = args.indexOf('--key') >= 0 ? args[args.indexOf('--key') + 1] : null
const doServer = args.includes('--server')
const PORT = Number(process.env.CDP_PORT || 9411)
const profile = (process.env.TEMP || '.') + '/eq-maps-diag-' + PORT

function ownerCreds() {
  for (const p of ['.env.local', '../edgehq-main/.env.local']) {
    if (!existsSync(p)) continue
    const t = readFileSync(p, 'utf8')
    const g = k => (t.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim().replace(/^["']|["']$/g, '')
    const email = g('PORTAL_RPC_OWNER_EMAIL'), pass = g('PORTAL_RPC_OWNER_PASSWORD')
    if (email && pass) return { email, pass }
  }
  return null
}

// The key the site actually ships. NEXT_PUBLIC_* is inlined at BUILD time, so
// reading the bundle is the only honest way to know what production is using — a
// value sitting in a .env file it wasn't built with proves nothing.
//
// ⚠️ Scan a page that actually loads Maps. /login does not, and its chunks
// therefore contain no key — which reads identically to "the key is missing" and
// sent this very script down that false path once. /book/* is public and pulls
// the map code in, so it carries the key without needing a session.
async function shippedKey() {
  for (const path of ['/book/diagnose', '/login']) {
    const res = await fetch(origin + path)
    if (!res.ok) continue
    const html = await res.text()
    const chunks = [...html.matchAll(/src="(\/_next\/static\/chunks\/[^"]+)"/g)].map(m => m[1])
    for (const c of chunks) {
      const js = await (await fetch(origin + c)).text()
      const hit = js.match(/AIza[0-9A-Za-z_-]{35}/)
      if (hit) return hit[0]
    }
  }
  return null
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl }
    catch { await sleep(250) }
  }
  throw new Error('Chrome never opened its debugging port')
}
const ws = new WebSocket(await wsUrl())
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0; const pending = new Map()
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const n = ++id
  pending.set(n, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))
  ws.send(JSON.stringify({ id: n, method, params, sessionId }))
})
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (m, p) => send(m, p, sessionId)
await S('Page.enable'); await S('Runtime.enable')
const ev = expr => S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(r => r.result.value)

let failures = 0
const ok = s => console.log('  ✓ ' + s)
const bad = (s, d = '') => { failures++; console.log('  ✗ ' + s + (d ? '\n      ' + d : '')) }

console.log(`\nMaps diagnosis — ${origin}\n`)

const key = keyArg || await shippedKey()
console.log('── Browser key (Maps JavaScript API) ───────────────────────────────')
if (!key) {
  bad('No AIza… key found in the shipped bundle',
      'NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY is missing from this deployment. It is inlined at BUILD time — set it in Vercel and REDEPLOY; a running deploy cannot pick it up.')
} else {
  console.log(`  key …${key.slice(-6)} (public by design — it ships in the bundle)`)
  await S('Page.navigate', { url: origin + '/login' })
  await sleep(2500)
  const r = await ev(`(async () => {
    const log = []
    window.gm_authFailure = () => log.push('gm_authFailure')
    const orig = console.error.bind(console)
    console.error = (...a) => { log.push(a.map(String).join(' ')); orig(...a) }
    const el = document.createElement('div')
    el.style.cssText = 'width:400px;height:300px;position:fixed;left:-9999px;top:0'
    document.body.appendChild(el)
    try {
      await new Promise((res, rej) => {
        const s = document.createElement('script')
        s.src = 'https://maps.googleapis.com/maps/api/js?key=${key}&v=weekly&libraries=geometry&loading=async'
        s.onload = res; s.onerror = () => rej(new Error('script blocked'))
        document.head.appendChild(s)
      })
    } catch (e) { return JSON.stringify({ fatal: String(e) }) }
    for (let i=0;i<60 && typeof window.google?.maps?.importLibrary !== 'function';i++) await new Promise(r=>setTimeout(r,100))
    let geometry = false, mapErr = null
    try {
      const { Map } = await window.google.maps.importLibrary('maps')
      new Map(el, { center:{lat:51.05,lng:-114.07}, zoom:18, mapTypeId:'satellite' })
      const g = await window.google.maps.importLibrary('geometry')
      geometry = typeof g.spherical?.computeArea === 'function'
    } catch (e) { mapErr = String(e) }
    await new Promise(r=>setTimeout(r,3500))
    return JSON.stringify({ geometry, mapErr, log })
  })()`)
  const out = JSON.parse(r || '{}')
  const refused = (out.log || []).find(l => /RefererNotAllowed/.test(l))
  const other = (out.log || []).find(l => /Google Maps JavaScript API error/.test(l))
  if (refused) {
    const url = refused.match(/Your site URL to be authorized:\s*(\S+)/)?.[1] || origin
    bad('RefererNotAllowedMapError — this origin is NOT in the key\'s allowlist',
        `Add BOTH of these to the key's HTTP referrer restrictions (Cloud Console → APIs & Services → Credentials):\n        https://edgehq.ca/*\n        https://app.edgehq.ca/*\n      Google reported: ${url}`)
  } else if (other) {
    bad('Google refused the key', other.split('\n')[0])
  } else if (out.fatal) {
    bad('Maps script never loaded', out.fatal)
  } else {
    ok('Map initialised — this origin is authorised')
  }
  if (out.geometry) ok('geometry library available (spherical.computeArea — the area engine)')
  else bad('geometry library missing', 'Polygon area measurement cannot work without it.')
}

if (doServer) {
  console.log('\n── Server key (GOOGLE_MAPS_API_KEY) ────────────────────────────────')
  const creds = ownerCreds()
  if (!creds) {
    console.log('  – skipped: PORTAL_RPC_OWNER_EMAIL/PASSWORD not in .env.local')
  } else {
    await S('Page.navigate', { url: origin + '/login' })
    await sleep(3000)
    await ev(`(async () => {
      const set = (el, v) => {
        const p = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        p.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const e = document.querySelector('input[type=email]'), p = document.querySelector('input[type=password]')
      if (!e || !p) return
      set(e, ${JSON.stringify(creds.email)}); set(p, ${JSON.stringify(creds.pass)})
      await new Promise(r => setTimeout(r, 200))
      ;[...document.querySelectorAll('button')].find(b => /sign in|log in/i.test(b.textContent||''))?.click()
    })()`)
    await sleep(7000)
    const path = await ev('location.pathname')
    if (!/dashboard/.test(String(path))) {
      console.log(`  – skipped: sign-in did not reach the dashboard (at ${path})`)
    } else {
      const res = JSON.parse(await ev(`(async () => {
        const out = []
        const call = async (label, url, body) => {
          const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
          out.push({ label, status: r.status, body: (await r.text()).slice(0,300) })
        }
        await call('geocode', '/api/geocode', { address: '215 Point Mckay Ter NW, Calgary, AB' })
        await call('distance', '/api/distance', { origin: 'Calgary, AB', destination: '215 Point Mckay Ter NW, Calgary, AB' })
        await call('places/autocomplete', '/api/places/autocomplete', { input: '215 Point Mckay' })
        return JSON.stringify(out)
      })()`) || '[]')
      for (const r of res) {
        if (r.status >= 200 && r.status < 300) ok(`${r.label} → ${r.status}`)
        else if (/expired/i.test(r.body)) {
          bad(`${r.label} → ${r.status}`, `Google says the SERVER key is EXPIRED. This is a DIFFERENT key from the browser one above and needs its own fix: issue a replacement, set GOOGLE_MAPS_API_KEY in Vercel, redeploy.\n      ${r.body}`)
        } else bad(`${r.label} → ${r.status}`, r.body)
      }
    }
  }
}

console.log(`\n${failures === 0 ? 'Maps configuration looks healthy.' : failures + ' problem(s) found.'}\n`)
chrome.kill()
process.exit(failures === 0 ? 0 : 1)
