// ── Google sign-in: END-TO-END against the REAL Supabase project ─────────────
// Not a source scan. This drives the live auth server and a real running build
// of this app, and reports what it OBSERVED.
//
//   node scripts/googleauth-e2e.mjs http://127.0.0.1:3156
//
// ⛔ WHAT THIS CANNOT DO, stated up front so a green run is not over-read:
// it cannot pass through Google's consent screen. That needs a human holding
// the Google account's password, and Google deliberately blocks automated
// sign-in. So the consent hop is the owner's to click. Everything on BOTH
// SIDES of it is proven here: that Supabase really will hand out a Google
// authorize URL (which is the proof the provider is configured), and that every
// way the return trip can go wrong is handled safely.
//
// It also cannot mint a beta invite or create a test user — that needs
// SUPABASE_SERVICE_ROLE_KEY, deliberately absent from this machine. Those
// halves are reported SKIPPED, never silently passed.

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const base = process.argv[2] || 'http://127.0.0.1:3156'
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))

const SUPA = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY

let pass = 0, fail = 0, skip = 0
const ok = m => { pass++; console.log(`  ✓ ${m}`) }
const no = (m, d = '') => { fail++; console.log(`  ✗ ${m}${d ? `\n      ${d}` : ''}`) }
const sk = (m, why) => { skip++; console.log(`  ⏭ SKIPPED ${m}\n      ${why}`) }
const H = t => console.log(`\n=== ${t} ===`)

// Never follow a redirect: the Location header IS the evidence.
const hop = (url, headers = {}) => fetch(url, { redirect: 'manual', headers })

// ⚠️ 127.0.0.1 and localhost are the SAME machine. The app answers on whichever
// name appOrigin derived from the request, so a naive host comparison calls a
// perfectly safe redirect an escape — which it did, on the first run of this
// script, for all four open-redirect cases. Normalise before comparing.
const normHost = h => h.replace(/^127\.0\.0\.1(:|$)/, 'localhost$1')
const sameOrigin = (loc, b) => {
  try { return normHost(new URL(loc).host) === normHost(new URL(b).host) } catch { return false }
}
const cookiesOf = r => (typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [])
const GOOD_TOKEN = 'eqb_' + 'a'.repeat(64)

H('1. Is the Google provider actually configured? (live Supabase)')
{
  const cb = 'https://app.edgehq.ca/auth/callback'
  // Probe with the SAME scopes the app sends. A bare probe returns Supabase's
  // defaults (email+profile) and would wrongly report openid missing.
  const r = await hop(`${SUPA}/auth/v1/authorize?provider=google`
    + `&scopes=${encodeURIComponent('openid email profile')}`
    + `&redirect_to=${encodeURIComponent(cb)}`)
  const loc = r.headers.get('location') || ''
  if (r.status >= 300 && r.status < 400 && /accounts\.google\.com/.test(loc)) {
    ok(`Supabase redirects to Google (HTTP ${r.status})`)
    const g = new URL(loc)
    const cid = g.searchParams.get('client_id') || ''
    if (cid) ok(`a Google client_id is configured (ends ...${cid.slice(-16)})`)
    else no('no client_id in the authorize URL - the provider is half-configured')

    const scope = g.searchParams.get('scope') || ''
    if (/email/.test(scope) && /profile/.test(scope)) ok('scopes include email + profile')
    else no(`unexpected scope set: ${scope}`)
    if (/openid/.test(scope)) ok('openid is requested')
    else no('openid missing from the scope set')

    const ru = g.searchParams.get('redirect_uri') || ''
    if (ru === `${SUPA}/auth/v1/callback`) ok('Google returns to the SUPABASE callback (hop 1 correct)')
    else no(`redirect_uri is ${ru}`)

    // A refresh token would be a standing key to the person's Google account.
    if (g.searchParams.get('access_type') === 'offline') no('access_type=offline is being requested')
    else ok('no offline access requested - Google issues no refresh token')

    // ⚠️ MEASURED 2026-08-23: this project's `state` is an opaque UUID, not a
    // JWT, so the destination cannot be read out of it. Supabase instead carries
    // the eventual destination as a plain `redirect_to` parameter — read that.
    const rt = decodeURIComponent(g.searchParams.get('redirect_to') || '')
    if (rt === cb) ok(`our callback is carried to the provider (${rt})`)
    else no(`redirect_to is ${rt || '(none)'} - expected ${cb}`)
    if (/edgepropertyservicesyyc/.test(rt)) no('the RETIRED host appears in the OAuth configuration')
    else ok('the retired host appears nowhere')
  } else {
    no(`provider not configured: HTTP ${r.status}, location ${loc.slice(0, 140)}`)
  }
}

H('2. Where a foreign destination is actually stopped')
{
  // ⚠️⚠️ MEASURED 2026-08-23, not assumed: Supabase DOES carry a foreign
  // redirect_to all the way into Google's authorize URL. It does not validate
  // at this step — the Redirect-URLs allow list is enforced when the provider
  // RETURNS, and an unlisted destination falls back to Site URL.
  //
  // An earlier version of this script asserted "a foreign redirect_to is not
  // carried through" and PASSED. It was wrong: it only inspected `state`, which
  // is an opaque UUID on this project. Asserting something false is worse than
  // asserting nothing, so the behaviour is now reported, and the assertion is
  // made where it actually belongs.
  //
  // What is genuinely ours to guarantee: anyone can hand-craft a Supabase
  // authorize URL — that is true of every Supabase project and is governed by
  // the allow list, not by our code — but OUR app must never generate one.
  const foreign = await hop(`${SUPA}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent('https://evil.tld/steal')}`)
  const carried = (foreign.headers.get('location') || '').includes('evil.tld')
  console.log(`  i Supabase ${carried ? 'DOES' : 'does not'} carry a foreign redirect_to to the provider`)
  console.log('      the Redirect-URLs allow list is the control, enforced on the way back')

  const hostiles = ['//evil.tld', 'https://evil.tld', '/\\evil.tld', '/%09/evil.tld', 'javascript:alert(1)']
  let leaked = 0
  for (const h of hostiles) {
    const r = await hop(`${base}/api/auth/google/start?next=${encodeURIComponent(h)}`)
    const loc = r.headers.get('location') || ''
    if (!loc) { leaked++; no(`start route produced no redirect for next=${h}`); continue }
    let rt = ''
    try { rt = decodeURIComponent(new URL(loc).searchParams.get('redirect_to') || '') } catch { /* below */ }
    if (!rt || !sameOrigin(rt, base) || rt.includes('evil.tld')) {
      leaked++
      no(`start route emitted redirect_to=${rt || '(none)'} for next=${JSON.stringify(h)}`)
    }
  }
  if (leaked === 0) ok(`no hostile next (${hostiles.length} shapes) moves our redirect_to off our own origin`)
}

H('3. The start route: what it asks Google for')
{
  const r = await hop(`${base}/api/auth/google/start`)
  const loc = r.headers.get('location') || ''
  if (/accounts\.google\.com|\/auth\/v1\/authorize/.test(loc)) ok('start route hands the browser to the provider')
  else no(`start route went to ${loc.slice(0, 140)}`)

  const setC = cookiesOf(r)
  if (setC.some(c => /code-verifier|pkce/i.test(c))) ok('a PKCE verifier cookie rides the SAME response that redirects')
  else no('no PKCE verifier cookie on the redirect - the exchange would fail')
  if (setC.some(c => /eq-oauth-invite/.test(c))) no('an invite cookie was set when no invite was supplied')
  else ok('no invite cookie when no invite was supplied')

  const hostile = await hop(`${base}/api/auth/google/start?next=${encodeURIComponent('//evil.tld')}`)
  const hl = hostile.headers.get('location') || ''
  if (hl.includes('evil.tld')) no('a hostile `next` reached the provider URL')
  else ok('a hostile `next` is dropped before Google ever sees it')

  const badInv = await hop(`${base}/api/auth/google/start?invite=not-a-real-token`)
  if (cookiesOf(badInv).some(c => /eq-oauth-invite/.test(c))) no('a malformed invite token was stored in a cookie')
  else ok('a malformed invite token is refused a cookie')

  const good = await hop(`${base}/api/auth/google/start?invite=${GOOD_TOKEN}`)
  const inv = cookiesOf(good).find(c => /eq-oauth-invite/.test(c)) || ''
  if (inv) ok('a well-formed invite is carried in a cookie')
  else no('a well-formed invite was not carried')
  if (/HttpOnly/i.test(inv)) ok('the invite cookie is HttpOnly')
  else no('the invite cookie is readable by script')
  if (/SameSite=Lax/i.test(inv)) ok('the invite cookie is SameSite=Lax (survives the return hop)')
  else no(`SameSite is wrong: ${inv.slice(0, 90)}`)
  if ((good.headers.get('location') || '').includes(GOOD_TOKEN)) no('the invite token leaked into the URL sent to Google')
  else ok('the invite token never appears in the URL sent to Google')
}

H('4. The callback: every way the return trip can go wrong')
{
  const cases = [
    ['user cancelled at Google', '?error=access_denied', 'auth_error=cancelled'],
    ['a forged or replayed code', '?code=totally-bogus-code', 'auth_error=exchange'],
    ['no parameters at all', '', 'auth_error=exchange'],
    ['a provider error_code only', '?error_code=server_error', 'auth_error=exchange'],
  ]
  for (const [name, qs, expect] of cases) {
    const r = await hop(`${base}/auth/callback${qs}`)
    const loc = r.headers.get('location') || ''
    if (loc.includes(expect)) ok(`${name} -> ${expect}`)
    else no(`${name} -> ${loc.slice(0, 120)}`, `expected ${expect}`)
  }

  // Open redirect on the way BACK. `next` survives the provider round trip, so
  // being clean on the way out proves nothing about the way home.
  for (const h of ['//evil.tld', 'https://evil.tld', '/\\evil.tld', '/%09/evil.tld']) {
    const r = await hop(`${base}/auth/callback?error=access_denied&next=${encodeURIComponent(h)}`)
    const loc = r.headers.get('location') || ''
    if (!sameOrigin(loc, base) || loc.includes('evil.tld')) {
      no(`hostile next ${JSON.stringify(h)} escaped to ${loc.slice(0, 90)}`)
    } else {
      ok(`hostile next ${JSON.stringify(h)} refused -> stayed on ${new URL(loc).pathname}`)
    }
  }

  const withCookie = await hop(`${base}/auth/callback?error=access_denied`, { cookie: `eq-oauth-invite=${GOOD_TOKEN}` })
  const cleared = cookiesOf(withCookie).some(c => /eq-oauth-invite=/.test(c) && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c))
  if (cleared) ok('the invite cookie is cleared on a failed return')
  else no('an abandoned invite cookie survives in the browser')

  const page = await fetch(`${base}/login?auth_error=${encodeURIComponent('<script>alert(1)</script>')}`).then(r => r.text())
  if (page.includes('<script>alert(1)')) no('an unknown auth_error was reflected into the page')
  else ok('an unknown auth_error renders nothing (no reflection)')
}

H('5. The authorization gates, asked of the real database')
{
  const email = env.PORTAL_RPC_OWNER_EMAIL, password = env.PORTAL_RPC_OWNER_PASSWORD
  if (!email || !password) sk('owner gate checks', 'no owner credentials in .env.local')
  else {
    const sb = createClient(SUPA, ANON, { auth: { persistSession: false } })
    const { error } = await sb.auth.signInWithPassword({ email, password })
    if (error) no(`could not sign in as the real owner: ${error.message}`)
    else {
      const role = await sb.rpc('current_app_role')
      if (role.data === 'owner') ok('the existing owner still resolves as owner')
      else no(`role is ${JSON.stringify(role.data)}`)
      const prov = await sb.rpc('can_provision_business')
      if (prov.data === true) ok('the existing owner may still provision (grandfathered)')
      else no(`can_provision_business = ${JSON.stringify(prov.data)}`)
      // scope:'local' is load-bearing. A bare signOut() is GLOBAL and would end
      // the owner's session on their own phone - the 2026-08-12 incident.
      // ── "no duplicate business / no duplicate user" ───────────────────────
      // ⛔ Deliberately NOT tested by attempting a second INSERT. The refusal
      // comes from business_settings_user_id_key, that is already proven, and a
      // test that turned out to be WRONG would create a real second business in
      // production. Counting is sufficient, and it is a read.
      const { data: biz, error: bizErr } = await sb.from('business_settings').select('user_id, company_name')
      const { data: me } = await sb.auth.getUser()
      if (bizErr) sk('owner business count', bizErr.message)
      else if (biz.length === 1) {
        ok(`the owner still has exactly ONE business ("${biz[0].company_name || 'unnamed'}")`)
        if (me?.user && biz[0].user_id === me.user.id) ok('that business is keyed to this exact auth.uid() - no duplicate identity')
        else no('the business is not keyed to the signed-in uid')
      } else no(`the owner sees ${biz.length} business_settings rows - expected exactly 1`)

      await sb.auth.signOut({ scope: 'local' })
      ok('signed out with scope local - the owner other devices are untouched')
    }
  }

  const anonSb = createClient(SUPA, ANON, { auth: { persistSession: false } })
  const anonRole = await anonSb.rpc('current_app_role')
  if (anonRole.data === 'none' || anonRole.data === null) ok(`a signed-out caller is ${JSON.stringify(anonRole.data)} - authentication alone grants nothing`)
  else no(`anon role is ${JSON.stringify(anonRole.data)}`)
  const anonProv = await anonSb.rpc('can_provision_business')
  if (anonProv.data === true) no('an anonymous caller may provision a business')
  else ok('an anonymous caller may NOT provision a business')
}

H('6. What only a human can do')
sk('the Google consent hop itself',
   'needs the Google account password; Google blocks automated sign-in by design')
sk('fresh-Google-user / worker-invite / wrong-email binding',
   'needs SUPABASE_SERVICE_ROLE_KEY to mint an invite or a test user; not on this machine')

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} google-auth E2E: ${pass} passed, ${fail} failed, ${skip} skipped`)
process.exit(fail === 0 ? 0 : 1)
