// ── Verify: public self-service sign-up — provider-native, closed by default, consented, honest ──
//   npm run verify:self-service-signup
//
// WHY THIS SCRIPT EXISTS
// The app half of self-service registration (the schema half is
// verify:self-service-registration). What the platform owner and the S110
// review asked for, and this guard refuses to take on faith:
//   1. no server route of ours creates or deletes accounts for the public —
//      sign-up is GoTrue's own auth.signUp on the anon key, so its limits and
//      its enumeration protection apply, and nothing here can delete anything;
//   2. the public learns exactly one fact about the switch — open or closed —
//      from a server route that fails CLOSED; the switch table is never named
//      on a client page;
//   3. a LICENCE is not CONSENT (S110 §4.1–4.3): a verified stranger who signs
//      in — with Google or a password — is never walked into tenant creation.
//      The public path carries an explicit intent (a cookie for the Google
//      round trip, ?intent=register on /setup), and /setup shows a row-less
//      account a clean "no business yet" screen until it says otherwise;
//   4. a refused write is re-asked, never echoed (S110 §4.4): the page renders
//      the database's current word, not the driver's message;
//   5. resend cannot be used to learn whether an address is confirmed (§4.7);
//   6. every closed-state screen says the owner's words and never accuses a
//      member of the public of lacking an invite;
//   7. the invite door is byte-for-byte the old one, and /setup still self-heals
//      an invite BEFORE asking anything and before writing anything.
//
// The pure mapping is EXECUTED; the wiring is source-level, \r-stripped,
// comment-stripped.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  signUpOutcome, resendOutcome, registrationNextStep, parseProvisioningStatus, hasRegisterIntent,
  REGISTRATION_CLOSED, REGISTER_STATUS_PATH, RESEND_COOLDOWN_SECONDS, RESENT_NOTE, SETUP_REGISTER_PATH, REGISTER_INTENT,
} from '../src/lib/registration'
import { readGoogleAuthError, GOOGLE_AUTH_ERROR_TEXT, OAUTH_REGISTER_COOKIE, OAUTH_INVITE_COOKIE } from '../src/lib/googleAuth'

let pass = 0, fail = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const H = (t: string) => console.log(`\n═══ ${t} ═══`)
const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const SIGNUP = strip(src('src/app/signup/page.tsx'))
const CONFIRM = strip(src('src/app/signup/confirm/[[...link]]/page.tsx'))
const SETUP = strip(src('src/app/setup/page.tsx'))
const STATUS_ROUTE = strip(src('src/app/api/register/status/route.ts'))
const CALLBACK = strip(src('src/app/auth/callback/route.ts'))
const START = strip(src('src/app/api/auth/google/start/route.ts'))
const BUTTON = strip(src('src/components/auth/GoogleButton.tsx'))
const LOGIN = strip(src('src/app/login/page.tsx'))
const REG = strip(src('src/lib/registration.ts'))
const MIDDLEWARE = strip(src('src/lib/supabase/middleware.ts'))
const PKG = src('package.json')

// ═══════════════════════════════════════════════════════════════════════════
H('1. the mapping, executed — an existing address is indistinguishable from a new one')
check('no error → sent', signUpOutcome({ data: { user: { identities: [{}] } }, error: null }).kind === 'sent')
check('GoTrue\'s obfuscated existing user (no identities, no error) → sent', signUpOutcome({ data: { user: { identities: [] } }, error: null }).kind === 'sent')
check('user_already_exists → sent (never revealed)', signUpOutcome({ error: { code: 'user_already_exists', message: 'User already registered', status: 422 } }).kind === 'sent')
check('email_exists → sent (never revealed)', signUpOutcome({ error: { code: 'email_exists', message: 'x', status: 422 } }).kind === 'sent')
check('signup_disabled → closed', signUpOutcome({ error: { code: 'signup_disabled', message: 'x' } }).kind === 'closed')
const weak = signUpOutcome({ error: { code: 'weak_password', message: 'Password should be at least 6 characters' } })
check('weak_password → a reason and OUR sentence, not the provider\'s', weak.kind === 'error' && weak.reason === 'weak-password' && /at least 10/.test(weak.message) && !/6 characters/.test(weak.message))
const bad = signUpOutcome({ error: { code: 'email_address_invalid', message: 'x' } })
check('email_address_invalid → bad-email', bad.kind === 'error' && bad.reason === 'bad-email')
const rl = signUpOutcome({ error: { code: 'over_email_send_rate_limit', message: 'x', status: 429 } })
const rl2 = signUpOutcome({ error: { message: 'x', status: 429 } })
check('rate limits (by code or by 429) → rate-limited', rl.kind === 'error' && rl.reason === 'rate-limited' && rl2.kind === 'error' && rl2.reason === 'rate-limited')
const unk = signUpOutcome({ error: { code: 'something_new', message: 'internal detail: db host 10.0.0.1' } })
check('an unknown failure → generic sentence; the provider message is never echoed', unk.kind === 'error' && unk.reason === 'error' && !/10\.0\.0\.1/.test(unk.message))

// Resend — S110 §4.7: a confirmed address must read exactly like a pending one.
check('resend: no error → sent', resendOutcome(null).kind === 'sent')
check('resend: an already-confirmed address (whatever GoTrue says) → sent', resendOutcome({ message: 'Email address already confirmed', status: 422, code: 'email_exists' }).kind === 'sent')
check('resend: an unknown address / unknown error → sent (same sentence)', resendOutcome({ message: 'User not found', status: 400 }).kind === 'sent' && resendOutcome({ message: 'boom', status: 500 }).kind === 'sent')
const rrl = resendOutcome({ code: 'over_email_send_rate_limit', message: 'x', status: 429 })
check('resend: a rate limit is the ONE distinguishable answer, and it names no address state', rrl.kind === 'error' && rrl.reason === 'rate-limited' && !/confirm|exist|found/i.test(rrl.message))
check('resend: a closed provider → closed', resendOutcome({ code: 'signup_disabled', message: 'x' }).kind === 'closed')
check('the resent note promises nothing about the address', /if this address can receive/.test(RESENT_NOTE) && !/already|confirmed|exists/i.test(RESENT_NOTE))

const steps: Record<string, string> = {
  'already-owner': 'setup', invited: 'setup', 'self-service': 'setup',
  'crew-account': 'crew', 'email-unverified': 'unverified', 'not-signed-in': 'signed-out', closed: 'closed',
}
for (const [s, want] of Object.entries(steps)) check(`status ${s} → ${want}`, registrationNextStep(parseProvisioningStatus(s)) === want)
check('an unreadable status → closed (fail closed on the way in)', registrationNextStep(parseProvisioningStatus('nonsense')) === 'closed' && registrationNextStep(null) === 'closed')
check('parseProvisioningStatus rejects junk and non-strings', parseProvisioningStatus(42) === null && parseProvisioningStatus('') === null && parseProvisioningStatus('self-service') === 'self-service')
check('the closed copy is the owner\'s sentence, verbatim',
  REGISTRATION_CLOSED.body === 'Account creation is temporarily unavailable. Please try again later.' && /Sign in/.test(REGISTRATION_CLOSED.signIn))
check('the resend cooldown matches GoTrue\'s per-address window (60s)', RESEND_COOLDOWN_SECONDS === 60)
check('the status path is the route this repo ships', REGISTER_STATUS_PATH === '/api/register/status')
check('the intent marker is one word on one path',
  REGISTER_INTENT === 'register' && SETUP_REGISTER_PATH === '/setup?intent=register'
  && hasRegisterIntent('?intent=register') && !hasRegisterIntent('?intent=x') && !hasRegisterIntent('') && !hasRegisterIntent(null))
check('the Google callback\'s closed code round-trips and carries the owner\'s sentence',
  readGoogleAuthError('closed') === 'closed' && /Account creation is temporarily unavailable\. Please try again later\./.test(GOOGLE_AUTH_ERROR_TEXT.closed))
check('…and the sign-in-is-not-sign-up code round-trips and says so',
  readGoogleAuthError('not-registered') === 'not-registered' && /never creates a business/.test(GOOGLE_AUTH_ERROR_TEXT['not-registered']))
check('registration.ts creates, deletes and emails nothing', !/createClient|admin|deleteUser|fetch\(|sendEmail/.test(REG))

// ═══════════════════════════════════════════════════════════════════════════
H('2. the one public fact — /api/register/status')
check('nodejs runtime, never cached', /runtime = 'nodejs'/.test(STATUS_ROUTE) && /dynamic = 'force-dynamic'/.test(STATUS_ROUTE) && /'Cache-Control': 'no-store'/.test(STATUS_ROUTE))
check('answers { open } and nothing else',
  /NextResponse\.json\(\{ open \}/.test(STATUS_ROUTE) && (STATUS_ROUTE.match(/NextResponse\.json\(/g) ?? []).length === 1
  && !/opened_at|updated_at|\bnote\b/.test(STATUS_ROUTE))
check('fails CLOSED: open starts false, and only a true read flips it', /let open = false/.test(STATUS_ROUTE) && /self_service_open === true/.test(STATUS_ROUTE) && /!error &&/.test(STATUS_ROUTE))
check('reads the switch through the service role on the server', /createAdminClient\(\)/.test(STATUS_ROUTE) && /from\('platform_registration'\)/.test(STATUS_ROUTE))
check('GET only — nothing writes the switch from the app', !/export async function (POST|PUT|PATCH|DELETE)/.test(STATUS_ROUTE) && !/\.update\(|\.insert\(|\.upsert\(/.test(STATUS_ROUTE))
check('no client page names the switch table', ![SIGNUP, CONFIRM, SETUP].some(s => /platform_registration/.test(s)))

// ═══════════════════════════════════════════════════════════════════════════
H('3. /signup — provider-native when open, the owner\'s words when closed, the invite door unchanged')
check('the public door is the absence of an invite, fixed for the page', /const selfService = token === null/.test(SIGNUP))
check('without an invite the page asks the status route, and unreachable means closed',
  /fetch\(REGISTER_STATUS_PATH, \{ cache: 'no-store' \}\)[\s\S]{0,200}?\.catch\(\(\) => \(\{ open: false \}\)\)[\s\S]{0,120}?status\.open === true \? 'form' : 'closed'/.test(SIGNUP))
check('self-service submits through GoTrue\'s auth.signUp on the browser client',
  /if \(selfService\) \{[\s\S]{0,400}?supabase\.auth\.signUp\(\{[\s\S]{0,200}?emailRedirectTo: `\$\{window\.location\.origin\}\$\{SIGNUP_CONFIRM_PATH\}`/.test(SIGNUP))
check('…and reads the result through signUpOutcome (enumeration-safe)', /signUpOutcome\(await supabase\.auth\.signUp\(/.test(SIGNUP))
check('the confirmation link lands on the existing confirm page', /SIGNUP_CONFIRM_PATH/.test(SIGNUP))
check('resend is GoTrue\'s own, type signup, read through resendOutcome, under the cooldown',
  /supabase\.auth\.resend\(\{\s*type: 'signup'/.test(SIGNUP) && /const out = resendOutcome\(resendErr\)/.test(SIGNUP)
  && /out\.kind === 'sent' \? RESENT_NOTE/.test(SIGNUP) && /startCooldown\(RESEND_COOLDOWN_SECONDS\)/.test(SIGNUP))
check('the Google button states intent from the public door only', /<GoogleButton label="Continue with Google" invite=\{token\} intent=\{selfService \? REGISTER_INTENT : null\} \/>/.test(SIGNUP))
check('…and /login\'s Google button carries no intent', /<GoogleButton\b(?![^>]*intent=)/.test(LOGIN) && !/intent=/.test(LOGIN))
check('the invite door still posts to the beta route', /fetch\('\/api\/beta\/signup'/.test(SIGNUP) && /fetch\('\/api\/beta\/resend'/.test(SIGNUP))
check('the closed card is the owner\'s copy with sign-in', /phase === 'closed'[\s\S]{0,300}?REGISTRATION_CLOSED\.title[\s\S]{0,300}?REGISTRATION_CLOSED\.body[\s\S]{0,300}?REGISTRATION_CLOSED\.signIn/.test(SIGNUP))
check('no client page touches the service role, an admin client, or account deletion',
  ![SIGNUP, CONFIRM, SETUP].some(s => /SUPABASE_SERVICE_ROLE_KEY|createAdminClient|betaInviteServer|deleteUser|auth\.admin/.test(s)))
check('the public path never deletes an account anywhere it touches', ![STATUS_ROUTE, REG, CALLBACK, START].some(s => /deleteUser/.test(s)))
check('no accusation on any public screen', ![SIGNUP, CONFIRM, SETUP].some(s => /No beta invite on this account|isn’t attached to a beta invite/.test(s)))

// ═══════════════════════════════════════════════════════════════════════════
H('4. /signup/confirm — the claim first, then the database\'s word, then intent travels')
check('still verifies via token_hash (the beta path is untouched)', /verifyOtp\(\{ token_hash: tokenHash, type \}\)/.test(CONFIRM) && !/action_link/.test(CONFIRM))
check('a default-template ?code= link is exchanged in place', /exchangeCodeForSession\(pkceCode\)/.test(CONFIRM))
check('claims first, then asks provisioning_status only on no-invite',
  CONFIRM.indexOf("rpc('claim_beta_invite')") > 0 && CONFIRM.indexOf("rpc('claim_beta_invite')") < CONFIRM.indexOf("rpc('provisioning_status')")
  && /s === 'no-invite'\) \{[\s\S]{0,400}?rpc\('provisioning_status'\)/.test(CONFIRM))
check('an invite still lands on plain /setup (the invite is the intent)', /router\.replace\('\/setup'\)/.test(CONFIRM))
check('a self-service confirmation carries its intent to /setup', /step === 'setup'\) \{ router\.replace\(SETUP_REGISTER_PATH\)/.test(CONFIRM))
check('crew / closed each have one door; anything else is a retry', /step === 'crew'\) \{ setPhase\('crew'\)/.test(CONFIRM) && /step === 'closed'\) \{ setPhase\('closed'\)/.test(CONFIRM) && /setPhase\('error'\)\s*return\s*\}/.test(CONFIRM))
check('a failed status read is a retry, never a verdict', /if \(stErr\) \{ setPhase\('error'\); return \}/.test(CONFIRM))
check('the closed card is the owner\'s copy', /phase === 'closed'[\s\S]{0,400}?REGISTRATION_CLOSED\.body/.test(CONFIRM))

// ═══════════════════════════════════════════════════════════════════════════
H('5. /setup — self-heal, then ask, then consent, then (only if licensed) write; refusals re-asked')
const iClaim = SETUP.indexOf("rpc('claim_beta_invite')")
const iAsk = SETUP.indexOf("rpc('provisioning_status')")
const iWrite = SETUP.indexOf("from('business_settings')")
check('order: claim_beta_invite → provisioning_status → business_settings', iClaim > 0 && iAsk > iClaim && iWrite > iAsk)
check('the gate is set only from an error-free answer (a failed question changes nothing)',
  /if \(!gateErr\) \{\s*const parsed = parseProvisioningStatus\(gateAnswer\)\s*setStatus\(parsed\)\s*const step = registrationNextStep\(parsed\)\s*if \(step !== 'setup'\) \{ setGate\(step\); return \}/.test(SETUP))
check('an unlicensed account sees one honest screen and never the picker', /if \(gate !== 'setup'\) \{/.test(SETUP) && SETUP.indexOf("if (gate !== 'setup') {") < SETUP.indexOf('if (!state) {'))
check('closed → the owner\'s words; crew → the join door; unverified → confirm first',
  /REGISTRATION_CLOSED\.title/.test(SETUP) && /REGISTRATION_CLOSED\.body/.test(SETUP) && /href="\/crew\/join"/.test(SETUP) && /Confirm your email first/.test(SETUP))
// Consent — S110 §4.1–4.3
check('a self-service licence without intent shows the clean "no business yet" screen BEFORE the picker',
  /if \(status === 'self-service' && !consented\) \{/.test(SETUP) && SETUP.indexOf("if (status === 'self-service' && !consented) {") < SETUP.indexOf('if (!state) {'))
check('…whose only creating control says so, and whose exit is a local sign-out',
  /onClick=\{\(\) => setConsented\(true\)\}>Create a business/.test(SETUP) && /signOut\(\{ scope: 'local' \}\)/.test(SETUP) && /nothing is created until you choose/.test(SETUP))
check('arriving from sign-up (?intent=register) is the consent, and only for the self-service licence',
  /if \(parsed === 'self-service' && hasRegisterIntent\(window\.location\.search\)\) setConsented\(true\)/.test(SETUP))
check('an invited or existing owner never meets the consent screen (status gate is self-service only)',
  (SETUP.match(/status === 'self-service'/g) ?? []).length >= 2 && !/status !== 'invited'/.test(SETUP))
check('under public registration the skip control names what it does; an invited owner keeps "Skip for now"',
  /status === 'self-service' \? 'Create my business without a starter catalogue' : 'Skip for now'/.test(SETUP))
// Refusals — S110 §4.4
check('every write site re-asks the database on refusal', (SETUP.match(/await explainRefusal\(/g) ?? []).length === 3)
check('explainRefusal renders the current word, and only a transient fault falls through to a sentence',
  /async function explainRefusal\(fallback: string\) \{\s*const \{ data, error: askErr \} = await supabase\.rpc\('provisioning_status'\)\s*if \(!askErr\) \{\s*const step = registrationNextStep\(parseProvisioningStatus\(data\)\)\s*if \(step !== 'setup'\) \{ setGate\(step\); return \}\s*\}\s*setError\(fallback\)/.test(SETUP))
check('no driver message is ever interpolated into the page', !/\$\{[A-Za-z]+\.message\}/.test(SETUP) && !/res\.error \|\|/.test(SETUP))

// ═══════════════════════════════════════════════════════════════════════════
H('6. the OAuth round trip — intent travels like an invite; a sign-in never creates a business')
check('the start route sets the intent cookie only for ?intent=register, httpOnly, bounded',
  /const registerIntent = req\.nextUrl\.searchParams\.get\(INTENT_PARAM\) === REGISTER_INTENT/.test(START)
  && /if \(registerIntent\) \{\s*res\.cookies\.set\(OAUTH_REGISTER_COOKIE, '1', \{\s*httpOnly: true,\s*sameSite: 'lax',[\s\S]{0,120}?maxAge: OAUTH_INVITE_TTL_SECONDS,/.test(START))
check('the start route still preserves the PKCE jar and never logs', /for \(const c of jar\) res\.cookies\.set/.test(START) && !/console\./.test(START))
check('the Google button forwards intent only when given one', /if \(intent\) q\.set\('intent', intent\)/.test(BUTTON) && /intent\?: 'register' \| null/.test(BUTTON))
check('the callback reads the cookie and clears it on every exit',
  /const registerIntent = req\.cookies\.get\(OAUTH_REGISTER_COOKIE\)\?\.value === '1'/.test(CALLBACK)
  && /res\.cookies\.set\(OAUTH_INVITE_COOKIE, '', CLEARED\)\s*res\.cookies\.set\(OAUTH_REGISTER_COOKIE, '', CLEARED\)/.test(CALLBACK))
check('still asks can_provision_business() first', /rpc\('can_provision_business'\)/.test(CALLBACK))
// The hole S110 §4.1 named was ONE line: `if (canProvision === true) return send(…)`.
// It must not come back in any spelling: nothing between the licence check and
// the status read may land a session, and every landing after it is inside a
// branch that names the licence.
const iCan = CALLBACK.indexOf("rpc('can_provision_business')")
const iStat = CALLBACK.indexOf("rpc('provisioning_status')")
check('no short-circuit: nothing between the licence check and the status read can land a session',
  iCan > 0 && iStat > iCan && !/send\(|OWNER_ROOT|SETUP_REGISTER_PATH/.test(CALLBACK.slice(iCan, iStat)))
check('…and after it, exactly two landings, both inside status-named branches',
  (CALLBACK.slice(iCan).match(/return send\(/g) ?? []).length === 2 && !/if \(canProvision === true\) return/.test(CALLBACK))
check('a licence is read by NAME, and a failed read keeps the session',
  /rpc\('provisioning_status'\)\s*if \(statusError\) return fail\('unavailable'\)\s*const status = parseProvisioningStatus\(statusData\)/.test(CALLBACK))
check('an invite (or an owner) lands as it always has', /if \(status === 'invited' \|\| status === 'already-owner'\) return send\(next \?\? OWNER_ROOT\)/.test(CALLBACK))
check('the self-service licence lands on /setup ONLY with the intent cookie, carrying the intent onward',
  /if \(status === 'self-service' && registerIntent\) return send\(SETUP_REGISTER_PATH\)/.test(CALLBACK))
check('a licensed sign-in without intent is signed out and told how to sign up', /return abandon\('not-registered'\)/.test(CALLBACK))
check('closed is named only for a registering arrival; everything else keeps the old word',
  /if \(registerIntent && status === 'closed'\) return abandon\('closed'\)\s*return abandon\('no-invite'\)/.test(CALLBACK))
check('nothing in the callback creates a business row', !/business_settings/.test(CALLBACK))
check('the cookie names differ (an invite cannot be mistaken for intent)', String(OAUTH_REGISTER_COOKIE) !== String(OAUTH_INVITE_COOKIE))

// ═══════════════════════════════════════════════════════════════════════════
H('7. boundaries that must not move')
check('middleware gate set unchanged — /signup and /api/register stay reachable signed-out',
  /const gated = isOwnerPath\(pathname\) \|\| isCrewPath\(pathname\) \|\| pathname === '\/login'/.test(MIDDLEWARE) && !/signup|register/.test(MIDDLEWARE))
check('no CAPTCHA or extra auth dependency was added', !/turnstile|hcaptcha|recaptcha/i.test(PKG))
check('registry line present', /"verify:self-service-signup": "tsx scripts\/verify-self-service-signup\.ts"/.test(PKG))

console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) { console.log('\n❌ verify:self-service-signup — the public door is not what was promised\n'); process.exit(1) }
console.log('\n✅ verify:self-service-signup — provider-native, closed by default, consented, the owner\'s words, the invite door unchanged\n')
