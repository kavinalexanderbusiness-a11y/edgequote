// ── Verify: the tenant boundary holds ────────────────────────────────────────
//   npm run verify:tenant-boundary
//
// WHY THIS SCRIPT EXISTS
// EdgeQuote is one auth user == one business. That model is enforced by ~300
// RLS policies that all say `auth.uid() = user_id`, and it holds up well — a
// crew session provably reads 0 rows from jobs, customers, invoices, payments,
// roster and settings. What does NOT hold up is everything that runs with RLS
// switched OFF: SECURITY DEFINER functions and service-role routes. The
// 2026-08-10 tenant audit reproduced three real holes there, and every one of
// them was invisible to tsc, to lint, and to every other verify suite:
//
//   1. find_customer_by_phone — SECURITY DEFINER, owned by a role that bypasses
//      RLS, and EXECUTE-able by `anon`. A phone number returned the customer's
//      name, id, opt-in AND owning business to anyone holding the public anon
//      key (which ships in the browser bundle).
//   2. ensure_pricing_config_version(p_user) — took the TARGET USER as an
//      argument. The crew account (zero table access) drove the owner's version
//      count 3 -> 4.
//   3. A crew member could self-promote to 'owner' with one business_settings
//      INSERT, then use the owner-only /api/crew/invite to mint a password
//      RECOVERY token for any other user's email — full account takeover.
//
// The lesson each one teaches is the same: a GRANT is not a boundary, and
// "no caller in our app does that" is not a boundary either. These checks are
// structural (they read the real migration + route source) so the contracts
// survive the next refactor.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const MIG = 'supabase/RUN-2026-08-10-tenant-rpc-grants.sql'

// ── 1. The two public-reachable DEFINER functions stay revoked ───────────────
console.log('\n═══ A SECURITY DEFINER function is not public API ═══')
check('the tenant-grant migration is committed', existsSync(join(ROOT, MIG)),
  'the live database was changed; the repo must carry the migration that explains it')
if (existsSync(join(ROOT, MIG))) {
  const m = read(MIG)
  // The PUBLIC grant is the one that bites: `revoke ... from anon` alone leaves
  // `=X/postgres` standing and has_function_privilege('anon', ...) stays TRUE.
  check('find_customer_by_phone is revoked from public AND the named roles',
    /revoke execute on function public\.find_customer_by_phone\(text\)\s+from public, anon, authenticated;/.test(m),
    'a per-role revoke does not remove a grant held by PUBLIC')
  check('ensure_pricing_config_version is revoked from public and anon',
    /revoke execute on function public\.ensure_pricing_config_version\(uuid\)\s+from public, anon;/.test(m))
  check('the pricing RPC re-revokes AFTER its create-or-replace',
    m.lastIndexOf('revoke execute on function public.ensure_pricing_config_version') >
    m.indexOf('create or replace function public.ensure_pricing_config_version'),
    'create-or-replace can restore default grants — revoking only before it is a no-op')
  check('the pricing RPC refuses to act for anyone but the caller',
    /if auth\.uid\(\) is not null and p_user is distinct from auth\.uid\(\) then\s*\n\s*return null;/.test(m),
    'taking the target user as a parameter is an RLS-bypass write primitive without this')
  check('the migration proves itself with has_function_privilege, not hope',
    /has_function_privilege\('anon'/.test(m) && /raise exception/.test(m))
  check('service_role keeps what the app actually needs',
    /has_function_privilege\('service_role', 'public\.find_customer_by_phone/.test(m),
    'the inbound-SMS webhook calls it with the service role — the revoke must not break it')

  // ── 2. The escalation chain stays closed ──────────────────────────────────
  console.log('\n═══ An employee account can never become an owner ═══')
  check('a trigger blocks business_settings INSERT for an employee-linked account',
    /create trigger business_settings_no_crew_owner\s+before insert on public\.business_settings/.test(m),
    'current_app_role() reads "has a business_settings row" as proof of ownership')
  check('…and it is SECURITY DEFINER (a policy subquery could not see the roster)',
    /function public\.guard_business_settings_owner\(\)[\s\S]{0,200}security definer/.test(m))
  check('auth_user_id is writable only by the invite/join flows',
    /create trigger technicians_auth_link_guard\s+before insert or update on public\.technicians/.test(m) &&
    /current_user in \('postgres', 'service_role', 'supabase_admin'\)/.test(m),
    'a client-forged link would let the invite route mint a recovery token for a stranger')
}

// ── 3. The invite route never hands out a token for a foreign account ────────
console.log('\n═══ The invite route mints tokens only for its own employee ═══')
const INV = 'src/app/api/crew/invite/route.ts'
check('the invite route exists', existsSync(join(ROOT, INV)))
if (existsSync(join(ROOT, INV))) {
  const r = read(INV)
  check('a pre-existing account is refused unless it is ALREADY this employee',
    /if \(existingId && existingId !== tech\.auth_user_id\) \{/.test(r),
    'the old check only refused addresses bound to another TECHNICIAN — an owner is not a technician, so a victim owner sailed through to generateLink')
  check('the refusal happens BEFORE the account is linked or a link is generated', (() => {
    const guard = r.indexOf('existingId !== tech.auth_user_id')
    const link = r.indexOf('generateLink')
    const update = r.indexOf(".update({ auth_user_id: authUserId")
    return guard > 0 && link > guard && update > guard
  })(), 'an authorization check after the privileged action is not a check')
  check('the route still proves ownership through the caller’s own RLS client',
    /await supabase\s*\n?\s*\.from\('technicians'\)/.test(r) && /role !== 'owner'/.test(r))
  check('the admin link-write stays scoped to the caller’s own user_id',
    /\.eq\('id', tech\.id\)\s*\n?\s*\.eq\('user_id', user\.id\)/.test(r))
}

// ── 3b. Storage: public URL reads are fine; anonymous LISTING is not ─────────
console.log('\n═══ Nobody can page through another tenant’s files ═══')
if (existsSync(join(ROOT, MIG))) {
  const m = read(MIG)
  check('job-photos SELECT is folder-scoped to the owner',
    /create policy "job-photos: read own"[\s\S]{0,220}\(storage\.foldername\(name\)\)\[1\] = \(auth\.uid\(\)\)::text/.test(m),
    'anon could otherwise enumerate every customer photo AND read the owner uid from the path')
  check('booking-uploads is no longer anon-readable',
    /drop policy if exists "booking_uploads_public_read"/.test(m),
    'its top-level folder name IS the raw booking_token — the public API’s tenant credential')
  check('branding write is folder-scoped (no cross-tenant logo overwrite)',
    /create policy "branding: insert own"[\s\S]{0,200}\(storage\.foldername\(name\)\)\[1\] = \(auth\.uid\(\)\)::text/.test(m) &&
    /create policy "branding: update own"/.test(m),
    'bucket_id-only policies let any authenticated account replace another business’s logo on every PDF and portal page')
  check('the booking form can still upload anonymously',
    !/drop policy if exists "booking_uploads_public_insert"/.test(m),
    'the public /book funnel depends on it')
  check('the storage change proves itself, and pins the ONE surviving anon policy',
    /roles::text like '%anon%'[\s\S]{0,200}booking_uploads_public_insert/.test(m))
}

// ── 4. No NEW anon-callable DEFINER function creeps in unreviewed ────────────
// Token-authenticated portal/booking RPCs are legitimately anon-callable; this
// only asks that any FUTURE migration granting anon EXECUTE says why.
console.log('\n═══ New public RPCs are a deliberate decision ═══')
const SUPA = join(ROOT, 'supabase')
const grants: string[] = []
if (existsSync(SUPA)) {
  for (const f of readdirSync(SUPA)) {
    const p = join(SUPA, f)
    if (!statSync(p).isFile() || !f.endsWith('.sql')) continue
    const src = readFileSync(p, 'utf8')
    for (const line of src.split('\n')) {
      if (/^\s*grant execute on function/i.test(line) && /\banon\b/.test(line)) grants.push(`${f}: ${line.trim()}`)
    }
  }
}
// Every legitimate one is a token-scoped portal/booking/public RPC.
const suspicious = grants.filter(g => !/portal_|book|public_|get_booking|submit_|record_booking|find_portal/i.test(g))
check('every anon EXECUTE grant is a token-scoped portal/booking/public RPC',
  suspicious.length === 0,
  suspicious.length ? `unexplained anon grants:\n      ${suspicious.join('\n      ')}` : '')

console.log(failures === 0
  ? '\n✅ tenant-boundary: RLS-off surfaces stay scoped to the tenant that owns the data.\n'
  : `\n❌ tenant-boundary: ${failures} contract${failures === 1 ? '' : 's'} broken.\n`)
process.exit(failures === 0 ? 0 : 1)
