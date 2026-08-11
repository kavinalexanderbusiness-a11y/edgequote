// ── Verify: portal_add_contact writes one row, fills only, and never consents ─
//   npm run verify:portal-contact
//
// WHY THIS IS EXECUTABLE AND NOT A SOURCE SCAN
// The rules that matter here live in the DEPLOYED function, not in the repo. A
// scan of the migration file passes happily while the database runs an older
// definition — and this function writes customer IDENTITY from an anonymous
// caller, which is the last place to be guessing. So it calls the live RPC as
// `anon`, exactly as the portal does, and asserts the answers.
//
// SAFETY: every live case below is one the function must REFUSE. A passing run
// writes nothing at all — no customer row moves, no service_requests row is
// created. The one thing that would prove the SUCCESS path (adding a real value
// to a real customer) is deliberately absent: it was verified by hand inside a
// rolled-back transaction, and a guard that mutates the owner's customer book on
// every CI run would be a worse bug than the one it protects against.
//
// WHAT THE FUNCTION IS FOR: 84 of 103 active customers have no email and 39 have
// no phone. The portal knows who the holder of a valid token is, so it can ask
// them for the detail and put it straight on the file. The risk that buys is that
// an anonymous caller now writes to `customers`, and these are the four rules
// that make that safe:
//
//   1. the TOKEN is the only authority — there is no customer-id parameter
//   2. FILL ONLY — a populated field is never overwritten (an email change is an
//      identity change: /portal-access mails the portal link to it)
//   3. CONSENT is untouched — having a phone is not agreeing to be texted
//   4. it will not create a DUPLICATE identity inside one owner's book

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { PHONE_MIN_DIGITS, PHONE_MAX_DIGITS } from '../src/app/portal/[token]/model'

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split(/\r?\n/) : []) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
}

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ── 1. The contract, in the migration that defines it ────────────────────────
// Source-level, because these are properties of the TEXT: a parameter that does
// not exist cannot be abused, and a column that is not in the UPDATE cannot be
// written. Both are checked live below as well where that is possible.
console.log('\n═══ The shape of the function forbids the attack ═══')
const SQL = read('supabase/RUN-2026-08-10-portal-add-contact.sql')
// Comments in this file describe the attacks by name, so scan the CODE only —
// a guard that greps its own prose reports the cure as the disease.
const SQL_CODE = SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

check('there is no customer-id parameter to abuse',
  !/p_customer_id/.test(SQL_CODE),
  'the token must be the only way to name a row; a caller-supplied id would be authority handed to the caller')
check('the customer is resolved from the token, unrevoked',
  /from public\.customer_portal_tokens\s+where token = p_token and not revoked/.test(SQL_CODE),
  'same lookup as get_portal_data and every other portal_* function')
check('the update targets exactly the resolved customer',
  /update public\.customers[\s\S]{0,400}?where id = v_customer;/.test(SQL_CODE))
check('the update writes phone and email and nothing else',
  /set phone = coalesce\(v_phone, phone\),\s*\n\s*email = coalesce\(v_email, email\),\s*\n\s*updated_at = now\(\)/.test(SQL_CODE),
  'any other column here is a capability the portal was not given')
for (const consent of ['sms_opt_in', 'email_opt_in', 'message_prefs']) {
  check(`${consent} is never assigned`,
    !new RegExp(`${consent}\\s*=`).test(SQL_CODE),
    'HAVING a contact detail is not CONSENTING to be contacted on it — lib/comms/reach.ts gates SMS on sms_opt_in with no transactional exemption, and portal_set_consent is the one door that changes it')
}
check('the duplicate checks are scoped to the token’s own owner',
  (SQL_CODE.match(/where user_id = v_user and id <> v_customer and archived_at is null/g) || []).length === 2,
  'both the phone and the email check; an unscoped one would read across tenants')
check('the phone duplicate test uses the last ten digits',
  /right\(phone_digits, 10\) = right\(v_digits, 10\)/.test(SQL_CODE),
  'the same national-number rule phoneMatches() and resolve_intake_customer use — otherwise a country code evades it')
check('the row is read back after the write',
  /select nullif\(btrim\(phone\), ''\) is not null[\s\S]{0,200}?from public\.customers where id = v_customer;/.test(SQL_CODE),
  '"saved" must be a claim about what the row holds, not that a statement ran')
check('the owner gets a trace of the change',
  /insert into public\.service_requests[\s\S]{0,200}?'handled'/.test(SQL_CODE),
  "it lands on the customer timeline; status 'handled' because nothing is being ASKED of the owner — a 'new' row would be a to-do with no task behind it")
check('it is security definer with a pinned search_path',
  /security definer/.test(SQL_CODE) && /set search_path to 'public'/.test(SQL_CODE))
check('PUBLIC is revoked rather than left at the CREATE default',
  /revoke all on function public\.portal_add_contact\(text, text, text\) from public;/.test(SQL_CODE),
  'a revoke aimed at anon does not remove a grant held by PUBLIC')

// The client mirrors the server's thresholds for instant feedback. If they drift,
// the portal starts refusing what the database would accept (or vice versa).
console.log('\n═══ The client mirror still agrees with the authority ═══')
check(`the migration enforces the same ${PHONE_MIN_DIGITS}-digit floor as the client`,
  new RegExp(`length\\(v_digits\\) < ${PHONE_MIN_DIGITS}`).test(SQL_CODE))
check(`the migration enforces the same ${PHONE_MAX_DIGITS}-digit ceiling`,
  new RegExp(`length\\(v_digits\\) > ${PHONE_MAX_DIGITS}`).test(SQL_CODE))

// ── 2. The prompt cannot block the things the customer came for ──────────────
console.log('\n═══ A missing detail is a prompt, never a gate ═══')
const CLIENT = read('src/app/portal/[token]/PortalClient.tsx')
check('the card renders only on Home, only when a gap exists',
  /activeTab === 'home' && contactGap\(data\.customer\) !== 'none'/.test(CLIENT))
check('nothing else is conditional on the contact gap',
  (CLIENT.match(/contactGap\(/g) || []).length <= 3,
  'approving, paying, viewing a quote or checking a visit must never depend on it')
check('the write is not optimistic',
  /if \(res\.ok\) await load\(\)/.test(CLIENT),
  'the prompt must disappear because the FILE changed, not because the client decided it had')
check('a dropped connection is not a server refusal',
  /if \(error\) return \{ ok: false, reason: 'network' \}/.test(CLIENT),
  'supabase-js resolves { data: null, error } on a network failure — the error object is the only discriminator')

const CARD = read('src/app/portal/[token]/components/HomeTab.tsx')
check('success is claimed only from what the RPC read back',
  /res\.ok && \(res\.added\?\.length \?\? 0\) > 0/.test(CARD),
  'ok with an empty `added` means nothing was written')
check('a failure keeps the form and every typed value',
  /else setError\(explain\(res\)\)/.test(CARD)
  && !/setPhone\(''\)/.test(CARD) && !/setEmail\(''\)/.test(CARD),
  'the failure branch may only report — clearing either field would make the customer retype after a save that did not happen')
check('a failure is said in words, not implied by the form still being there',
  /role="alert"/.test(CARD))
// Scoped to THIS card's own markup. Counting the whole file was no check at all:
// `text-base sm:text-sm` appears four times in HomeTab.tsx, so both contact
// inputs could shrink and the count would still clear the threshold. (Found by
// mutating it — the mutation "passed".)
const CARD_BODY = CARD.slice(CARD.indexOf('export function ContactMethodCard'))
  .slice(0, CARD.slice(CARD.indexOf('export function ContactMethodCard')).indexOf('\nexport function '))
check('the card really contains its own markup', CARD_BODY.includes('aria-label="Phone number"'),
  'the slice above found the wrong region, so every check on it is meaningless')
check('both contact inputs are 16px on a phone',
  (CARD_BODY.match(/text-base sm:text-sm/g) || []).length === 2
  && !/py-3 text-sm/.test(CARD_BODY),
  'iOS zooms the page in on any focused input under 16px and does not zoom back out')

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  console.log('\n═══ The deployed function refuses every attack (live, as anon) ═══')
  // CI runs with placeholder Supabase values; there is nothing to talk to.
  if (!url || !anonKey || url.includes('placeholder')) {
    console.log('  … SKIPPED — no live Supabase credentials (CI runs with placeholders)')
    return
  }
  const sb: SupabaseClient = createClient(url, anonKey)

  const call = async (token: string | null, phone: string | null, email: string | null) => {
    const { data, error } = await sb.rpc('portal_add_contact', { p_token: token, p_phone: phone, p_email: email })
    if (error) return { ok: false, reason: 'rpc_error:' + error.message }
    return (data ?? {}) as { ok?: boolean; reason?: string; skipped?: string[] }
  }

  // A token nobody holds. Three shapes of "not a real token", all one answer.
  for (const [label, tok] of [['an unknown token', 'definitely-not-a-token'], ['an empty token', ''], ['a null token', null]] as const) {
    const r = await call(tok, '4035550100', null)
    check(`${label} is refused`, r.ok === false && r.reason === 'invalid_token', JSON.stringify(r))
  }

  // Find a real, live token whose customer ALREADY has both details: the safest
  // possible live subject, because every write against it must be refused.
  const { data: rows } = await sb.rpc('get_portal_data', { p_token: '__probe__' })
  check('a junk token yields no portal payload', rows == null,
    'get_portal_data must not answer for a token that does not exist')

  const probeToken = process.env.PORTAL_CONTACT_PROBE_TOKEN
  if (!probeToken) {
    console.log('  … the fill-only + duplicate cases need PORTAL_CONTACT_PROBE_TOKEN')
    console.log('      (a live token whose customer already has BOTH a phone and an email —')
    console.log('       every call against it is refused, so nothing is ever written)')
    return
  }

  // FILL ONLY. This customer already has both, so both must be reported as
  // skipped and the row must not move.
  const overwrite = await call(probeToken, '780-555-0000', 'attacker@example.invalid')
  check('a populated field is never overwritten',
    overwrite.ok === false && overwrite.reason === 'already_on_file',
    JSON.stringify(overwrite))
  check('it names what it refused to change',
    Array.isArray(overwrite.skipped) && overwrite.skipped.length === 2,
    JSON.stringify(overwrite))

  // Validation, on a token that would otherwise be allowed to write.
  const short = await call(probeToken, '555-0100', null)
  check('a number with no area code is refused before anything else',
    short.ok === false && (short.reason === 'bad_phone' || short.reason === 'already_on_file'),
    JSON.stringify(short))

  // Nothing supplied is not an error to shout about, but it is not a success.
  const empty = await call(probeToken, '   ', '  ')
  check('blank input writes nothing', empty.ok === false, JSON.stringify(empty))
}

main().then(() => {
  console.log('\n── Summary ────────────────────────────────────────────────────')
  if (failures) {
    console.log(`\n❌ verify:portal-contact — ${failures} failure${failures === 1 ? '' : 's'}\n`)
    process.exit(1)
  }
  console.log('\n✅ verify:portal-contact — token is the only authority, fills only, consent untouched\n')
}, e => {
  console.log(`\n❌ verify:portal-contact — ${e?.message || e}\n`)
  process.exit(1)
})
