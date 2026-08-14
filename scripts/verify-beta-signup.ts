// ── verify:beta-signup ────────────────────────────────────────────────────────
// The invite-only beta front door: /signup → verification email → /signup/confirm
// → claim_beta_invite() → /setup creates the tenant.
//
// The rules this guard pins are SECURITY rules, not UX preferences:
//   1. Tenant creation is licensed by a REDEEMED invite (or being an owner
//      already) — the business_settings INSERT policy carries
//      can_provision_business(), and redemption requires a VERIFIED email.
//   2. The database never holds a raw invite token: lookups are sha256-only and
//      the column CHECK makes a raw token unstorable.
//   3. The confirmation link travels ONLY inside the email. A route that echoed
//      it would hand email-ownership proof to whoever holds the invite URL.
//   4. The service role stays server-side; the signup pages are ordinary
//      anon-key clients.
//   5. Nothing here can mint platform privilege: operator functions gate on
//      platform_operators, which no signup path writes.
//
// Facts proven LIVE against prod Supabase on 2026-08-13 (session 40 E2E,
// 37/37): unconfirmed sign-in refused (email_not_confirmed) · generateLink
// regeneration invalidates the prior link · verifyOtp single-use, replay →
// otp_expired · owner upsert grandfathered by the new policy · bare stranger
// INSERT refused · claim idempotent ('claimed' → 'already-claimed') · revoked
// invite refuses claim AFTER verification · deleting a reserved account frees
// the invite · duplicate business row refused by business_settings_user_id_key.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BETA_TOKEN_RE, MIN_PASSWORD, SIGNUP_PATH, SIGNUP_CONFIRM_PATH,
  buildBetaSignupUrl, buildBetaConfirmUrl,
} from '../src/lib/betaInvite'
import { generateBetaToken, hashBetaToken, betaVerifyEmail } from '../src/lib/betaInviteServer'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail = '') => { failures++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
const check = (name: string, cond: boolean, detail = '') => { cond ? ok(name) : fail(name, detail) }
const H = (t: string) => console.log(`\n═══ ${t} ═══`)

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
// Strip comments before asserting on code order/content — a well-documented
// file must not fail on its own prose. [^\n] keeps this CRLF-safe.
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const SQL = read('supabase/RUN-2026-08-13-beta-invites.sql')
const SIGNUP_ROUTE = read('src/app/api/beta/signup/route.ts')
const RESEND_ROUTE = read('src/app/api/beta/resend/route.ts')
const SIGNUP_PAGE = read('src/app/signup/page.tsx')
const CONFIRM_PAGE = read('src/app/signup/confirm/page.tsx')
const SETUP_PAGE = read('src/app/setup/page.tsx')
const MIDDLEWARE = read('src/lib/supabase/middleware.ts')
const SCRIPT = read('scripts/beta-invite.ts')
const PKG = read('package.json')

H('1. token + hash + URLs (pure)')
{
  const t = generateBetaToken()
  check('token matches the contract shape', BETA_TOKEN_RE.test(t), t.slice(0, 12))
  check('two mints differ', generateBetaToken() !== t)
  const h = hashBetaToken(t)
  check('hash is 64 hex and deterministic', /^[0-9a-f]{64}$/.test(h) && h === hashBetaToken(t))
  check('hash is not the token', !t.includes(h) && !h.includes(t))
  const su = buildBetaSignupUrl('https://x.example/', t)
  check('signup URL: no double slash, token encoded, right path',
    su === `https://x.example${SIGNUP_PATH}?invite=${encodeURIComponent(t)}`)
  const cu = buildBetaConfirmUrl('https://x.example', 'pkce_ab/cd+ef=', 'signup')
  check('confirm URL encodes the hashed token', cu.includes('token_hash=pkce_ab%2Fcd%2Bef%3D') && cu.includes(`${SIGNUP_CONFIRM_PATH}?`))
  check(`MIN_PASSWORD stays ${8} (Supabase default; crew welcome states the same)`, MIN_PASSWORD === 8)
}

H('2. the verification email (pure)')
{
  const url = 'https://x.example/signup/confirm?token_hash=abc&type=signup'
  const m = betaVerifyEmail(url)
  check('html and text both carry the confirm URL', m.html.includes('token_hash=abc&amp;type=signup') && m.text.includes(url))
  check('the didn’t-sign-up line is present (anyone can type a stranger’s address)',
    /didn’t sign up/i.test(m.html) && /didn’t sign up/i.test(m.text))
  check('single-use is stated', /single-use/i.test(m.text))
  check('subject names EdgeQuote', /EdgeQuote/.test(m.subject))
  check('href is escaped', m.html.includes('href="https://x.example/signup/confirm?token_hash=abc&amp;type=signup"'))
}

H('3. migration: the invite ledger is server-authoritative')
{
  check('beta_invites: RLS on', /alter table public\.beta_invites enable row level security/.test(SQL))
  check('beta_invites: DML revoked by role name', /revoke all on table public\.beta_invites from anon, authenticated/.test(SQL))
  check('platform_operators: RLS on + revoked', /alter table public\.platform_operators enable row level security/.test(SQL)
    && /revoke all on table public\.platform_operators from anon, authenticated/.test(SQL))
  check('ZERO policies on either table (the deny is structural)',
    !/create policy[^\n]*beta_invites/.test(SQL) && !/create policy[^\n]*platform_operators/.test(SQL))
  check('token_hash CHECK makes a raw token unstorable', /token_hash ~ '\^\[0-9a-f\]\{64\}\$'/.test(SQL))
  check('one invite per account, both directions (partial uniques)',
    /beta_invites_reserved_by_key[\s\S]{0,120}where reserved_by is not null/.test(SQL)
    && /beta_invites_redeemed_by_key[\s\S]{0,120}where redeemed_by is not null/.test(SQL))
  check('reserved_by frees itself when the account is deleted', /reserved_by\s+uuid references auth\.users\(id\) on delete set null/.test(SQL))
}

H('4. migration: redemption and the provisioning licence')
{
  const sqlCode = stripComments(SQL)
  const claim = sqlCode.slice(sqlCode.indexOf('function public.claim_beta_invite'))
  check('claim: SECURITY DEFINER with pinned search_path (public, pg_temp)',
    /claim_beta_invite\(\)\s*returns text\s*language plpgsql security definer set search_path = public, pg_temp/.test(sqlCode))
  check('claim: email verification gates redemption (confirmed read BEFORE the redeem write)',
    claim.indexOf('email_confirmed_at') > 0 && claim.indexOf('email_confirmed_at') < claim.indexOf('set redeemed_by'))
  check('claim: revocation beats redemption', claim.indexOf('revoked_at is not null') < claim.indexOf('set redeemed_by'))
  check('claim: never inserts the tenant row itself (/setup stays the ONE door)',
    !/insert into public\.business_settings/.test(sqlCode))
  check('claim: row is locked while redeeming (for update)', /for update/.test(claim))
  check('can_provision_business: owner-grandfather OR redeemed invite, nothing else',
    /current_app_role\(\) = 'owner'\s*or exists \(select 1 from public\.beta_invites i where i\.redeemed_by = auth\.uid\(\)\)/.test(sqlCode))
  check('the INSERT policy carries the licence',
    /create policy "settings: insert own" on public\.business_settings\s*for insert with check \(auth\.uid\(\) = user_id and public\.can_provision_business\(\)\)/.test(SQL))
  check('every operator function gates on platform_operators',
    (sqlCode.match(/from public\.platform_operators o where o\.user_id = auth\.uid\(\)/g) || []).length >= 3)
  check('functions: EXECUTE revoked from public+anon and granted back to authenticated, all five',
    (SQL.match(/revoke execute on function public\./g) || []).length === 5
    && (SQL.match(/grant {2}execute on function public\./g) || []).length === 5)
}

H('5. the signup route: order, hashing, and what may never leave')
{
  const code = stripComments(SIGNUP_ROUTE)
  check('nodejs runtime pinned (service role never at the edge)', /export const runtime = 'nodejs'/.test(SIGNUP_ROUTE))
  check('force-dynamic pinned', /export const dynamic = 'force-dynamic'/.test(SIGNUP_ROUTE))
  check('lookup is by hash, only ever by hash',
    (code.match(/\.eq\('token_hash', hashBetaToken\(token\)\)/g) || []).length >= 2 && !/\.eq\('token',/.test(code))
  check('email provider checked BEFORE any account is created',
    code.indexOf('commsEnabled().email') > 0 && code.indexOf('commsEnabled().email') < code.indexOf('createUser'))
  check('accounts are born UNVERIFIED', /email_confirm: false/.test(code) && !/email_confirm: true/.test(code))
  check('reservation restates every eligibility condition atomically',
    /\.is\('reserved_by', null\)[\s\S]{0,120}\.is\('redeemed_at', null\)[\s\S]{0,120}\.is\('revoked_at', null\)[\s\S]{0,120}\.gt\('expires_at'/.test(code))
  check('losing the reservation race deletes the account it just made (no half-created signup)',
    /deleteUser\(userId\)/.test(code) && code.indexOf('.is(\'reserved_by\', null)') < code.indexOf('deleteUser(userId)'))
  check('the confirm link exists only on its way into the email',
    (code.match(/buildBetaConfirmUrl\(/g) || []).length === 1 && /betaVerifyEmail\(buildBetaConfirmUrl\(/.test(code))
  check('hashed_token used; action_link never touched', /hashed_token/.test(code) && !/action_link/.test(code))
  check('no console.* (a logged link is a session in a log aggregator)', !/console\.(log|info|warn|error)/.test(code))
  check('every refusal is a named reason', ['invalid', 'expired', 'revoked', 'used', 'in-progress', 'wrong-email',
    'email-exists', 'bad-email', 'weak-password', 'rate-limited', 'not-configured', 'email-failed']
    .every(r => SIGNUP_ROUTE.includes(`'${r}'`)))
}

H('6. the resend route: token-gated, throttled on the row')
{
  const code = stripComments(RESEND_ROUTE)
  check('nodejs runtime + force-dynamic pinned', /export const runtime = 'nodejs'/.test(RESEND_ROUTE) && /force-dynamic/.test(RESEND_ROUTE))
  check('resend can only mail the address already bound to the invite (holder.email, no email input)',
    /sendEmail\(holder\.email,/.test(code) && !/body\?\.email/.test(code))
  check('throttle reads the ROW (survives cold starts)', /last_sent_at/.test(code) && /send_count/.test(code))
  check('confirmed holders are turned away to sign-in', /'verified'/.test(RESEND_ROUTE))
  check('lookup by hash only', /\.eq\('token_hash', hashBetaToken\(token\)\)/.test(code))
  check('no console.*', !/console\.(log|info|warn|error)/.test(code))
}

H('7. the client boundary')
{
  check('both pages are client components on the anon key', /'use client'/.test(SIGNUP_PAGE) && /'use client'/.test(CONFIRM_PAGE))
  check('neither page imports the server-only lib or names the service key',
    ![SIGNUP_PAGE, CONFIRM_PAGE].some(s => s.includes('betaInviteServer') || s.includes('SUPABASE_SERVICE_ROLE_KEY')))
  check('confirm page verifies via token_hash (never parses an action_link)',
    /verifyOtp\(\{ token_hash/.test(CONFIRM_PAGE) && !/action_link/.test(CONFIRM_PAGE))
  check('confirm page claims after verifying', /claim_beta_invite/.test(CONFIRM_PAGE))
  check('/setup self-heals a pending redemption before any write',
    stripComments(SETUP_PAGE).indexOf("rpc('claim_beta_invite')") > 0
    && stripComments(SETUP_PAGE).indexOf("rpc('claim_beta_invite')") < stripComments(SETUP_PAGE).indexOf("from('business_settings')"))
  check('middleware gate set unchanged — /signup stays reachable signed-out',
    /const gated = isOwnerPath\(pathname\) \|\| isCrewPath\(pathname\) \|\| pathname === '\/login'/.test(MIDDLEWARE)
    && !/signup/.test(stripComments(MIDDLEWARE)))
}

H('8. the operator script')
{
  check('signs out LOCAL scope only (the 214-logouts lesson)', /signOut\(\{ scope: 'local' \}\)/.test(SCRIPT) && !/signOut\(\)/.test(SCRIPT))
  check('mints via the RPC with a hash — never writes beta_invites directly',
    /rpc\('create_beta_invite'/.test(SCRIPT) && /hashBetaToken\(token\)/.test(SCRIPT) && !/from\('beta_invites'\)/.test(SCRIPT))
  check('npm alias exists', /"beta:invite": "tsx scripts\/beta-invite\.ts"/.test(PKG))
}

H('9. a new tenant starts capability-restricted BY CONSTRUCTION')
{
  // Session 43's platform_capabilities model: a MISSING row is zero grants, the
  // app only reads it, and granting is operator SQL. The signup lane therefore
  // restricts every new tenant by doing NOTHING — and this section pins that
  // "nothing" so it stays deliberate: no file in the lane may so much as name
  // the grants table. A signup path that wrote a capability row would be a new
  // tenant born holding the shared Stripe account.
  const LANE: Array<[string, string]> = [
    ['migration', SQL], ['signup route', SIGNUP_ROUTE], ['resend route', RESEND_ROUTE],
    ['signup page', SIGNUP_PAGE], ['confirm page', CONFIRM_PAGE], ['setup page', SETUP_PAGE],
    ['operator script', SCRIPT],
    ['shared lib', read('src/lib/betaInvite.ts')], ['server lib', read('src/lib/betaInviteServer.ts')],
  ]
  for (const [name, text] of LANE) {
    check(`${name} never touches platform_capabilities`, !/platform_capabilities/.test(text))
  }
  // If the capability model itself moves, fail loudly so this section gets
  // re-derived instead of pinning against a table that no longer exists.
  const capLib = read('src/lib/capabilities.ts')
  check('the capability read model is where session 43 put it (fails closed on a missing row)',
    /platform_capabilities/.test(capLib) && /NO_CAPABILITIES/.test(capLib))
}

console.log('')
if (failures) {
  console.log(`✗ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✓ Tenant creation is invite-licensed: raw tokens are never stored, verification is a server-side gate, and the confirm link only ever travels inside the email.')
