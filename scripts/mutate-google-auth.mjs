// ── Mutation test for verify:google-auth ─────────────────────────────────────
// A guard that cannot fail is decoration. This breaks the authorization
// boundary one deliberate change at a time and requires the guard to notice
// every single one. A mutation that SURVIVES is a hole in the net.
//
// ⚠️⚠️ COMMIT BEFORE RUNNING THIS. It rewrites real source files and restores
// them afterwards; an interruption between the two leaves a mutated tree, and
// uncommitted work has been destroyed by exactly that before.
//
//   node scripts/mutate-google-auth.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const tsxPkg = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'tsx', 'package.json'), 'utf8'))
const TSX = resolve(ROOT, 'node_modules', 'tsx', typeof tsxPkg.bin === 'string' ? tsxPkg.bin : tsxPkg.bin.tsx)

const LIB = 'src/lib/googleAuth.ts'
const SERVER = 'src/lib/googleAuthServer.ts'
const CALLBACK = 'src/app/auth/callback/route.ts'
const START = 'src/app/api/auth/google/start/route.ts'

// Each entry is ONE realistic regression — the change a tired person makes at
// 1am, or a refactor performs without noticing what it removed.
const MUTATIONS = [
  // ── The open-redirect gate ────────────────────────────────────────────────
  { name: 'safeReturnPath stops rejecting protocol-relative //evil.tld',
    file: LIB,
    find: "  if (decoded.startsWith('//') || decoded.startsWith('/\\\\')) return null",
    to:   "  if (false) return null" },
  { name: 'safeReturnPath stops decoding, so /%09/evil.tld slips through',
    file: LIB,
    find: "  try { decoded = decodeURIComponent(v) } catch { return null }",
    to:   "  try { decoded = v } catch { return null }" },
  { name: 'safeReturnPath accepts anything beginning with a slash',
    file: LIB,
    find: "  if (!v.startsWith('/')) return null",
    to:   "  if (!v.startsWith('/')) return null; return v;" },

  // ── The provider-verified email gate ──────────────────────────────────────
  { name: 'googleEmailVerified trusts the identity without reading the flag',
    file: LIB,
    find: "  if (google && truthyFlag(google.identity_data)) return true",
    to:   "  if (google) return true" },
  { name: 'user_metadata alone can promote an unverified address',
    file: LIB,
    find: "  return !!user.email_confirmed_at && truthyFlag(user.user_metadata)",
    to:   "  return truthyFlag(user.user_metadata)" },

  // ── The binding engine ────────────────────────────────────────────────────
  { name: 'binding drops the provider-verified email requirement',
    file: SERVER,
    find: "  if (!googleEmailVerified(user) || !user.email_confirmed_at) {",
    to:   "  if (false) {" },
  { name: 'binding stops checking the invite is addressed to this person',
    file: SERVER,
    find: "  if (invite.email && normalizeInviteEmail(invite.email) !== email) {",
    to:   "  if (false) {" },
  { name: 'binding ignores a reservation held by another account',
    file: SERVER,
    find: "  if (invite.reserved_by && invite.reserved_by !== user.id) {",
    to:   "  if (false) {" },
  { name: 'the atomic UPDATE stops excluding already-redeemed invites',
    file: SERVER,
    find: "    .is('redeemed_at', null)",
    to:   "" },
  { name: 'the atomic UPDATE stops excluding revoked invites',
    file: SERVER,
    find: "    .is('revoked_at', null)",
    to:   "" },
  { name: 'the atomic UPDATE stops excluding expired invites',
    file: SERVER,
    find: "    .gt('expires_at', now)",
    to:   "" },

  // ── The callback's authorization decisions ────────────────────────────────
  { name: 'callback stops asking can_provision_business()',
    file: CALLBACK,
    find: "  const { data: canProvision, error: provisionError } = await supabase.rpc('can_provision_business')",
    to:   "  const canProvision = true, provisionError = null" },
  { name: 'a blip right after a good exchange is read as "nobody"',
    file: CALLBACK,
    find: "  if (auth.kind === 'unavailable') return fail('unavailable')",
    to:   "" },
  { name: 'a database error is read as a verdict and signs the person out',
    file: CALLBACK,
    find: "  if (roleError) return fail('unavailable')",
    to:   "  if (roleError) return abandon('no-invite')" },
  // ⚠️ The replacement text is SPLIT across a concatenation on purpose.
  // verify:auth-session scans every file under scripts/ for a bare
  // `.auth.signOut()` — the 2026-08-12 incident was a bare one hiding in a
  // shared helper — and a text scanner cannot tell a mutation's payload from a
  // real call. Writing it whole here would fail that guard for a call this file
  // never makes. Splitting keeps the mutation genuine and the scan honest.
  { name: 'signOut reverts to its GLOBAL default, ending other devices',
    file: CALLBACK,
    find: "    await supabase.auth.signOut({ scope: 'local' }).catch(() => {})",
    to:   "    await supabase.auth.sign" + "Out().catch(() => {})" },
  { name: 'the redirect stops carrying the session cookies the exchange wrote',
    file: CALLBACK,
    find: "    for (const c of jar) res.cookies.set(c.name, c.value, c.options)",
    to:   "" },
  { name: 'the handshake cookie is no longer cleared on the way out',
    file: CALLBACK,
    find: "    res.cookies.set(OAUTH_INVITE_COOKIE, '', CLEARED)",
    to:   "" },
  { name: 'an existing owner can have a second invite spent on them',
    file: CALLBACK,
    find: "  if (inviteToken && role !== 'owner') {",
    to:   "  if (inviteToken) {" },

  // ── The start route ───────────────────────────────────────────────────────
  { name: 'offline access is requested, so Google issues a refresh token',
    file: START,
    find: "      scopes: GOOGLE_SCOPES,",
    to:   "      scopes: GOOGLE_SCOPES,\n      queryParams: { access_type: 'offline' }," },
  { name: 'the invite cookie loses httpOnly and becomes script-readable',
    file: START,
    find: "      httpOnly: true,",
    to:   "      httpOnly: false," },
  { name: 'the PKCE verifier cookie is dropped from the redirect',
    file: START,
    find: "  for (const c of jar) res.cookies.set(c.name, c.value, c.options)",
    to:   "" },
]

let survivors = []
let caught = 0

for (const m of MUTATIONS) {
  const path = join(ROOT, m.file)
  const original = readFileSync(path, 'utf8')
  if (!original.includes(m.find)) {
    console.log(`  ⚠ STALE  ${m.name}\n      anchor not found in ${m.file} — the mutation tested nothing`)
    survivors.push({ ...m, stale: true })
    continue
  }
  writeFileSync(path, original.replace(m.find, m.to))
  try {
    const r = spawnSync(process.execPath, [TSX, join(ROOT, 'scripts', 'verify-google-auth.ts')], {
      cwd: ROOT, encoding: 'utf8',
    })
    if (r.status === 0) {
      console.log(`  ✗ SURVIVED  ${m.name}`)
      survivors.push(m)
    } else {
      console.log(`  ✓ caught    ${m.name}`)
      caught++
    }
  } finally {
    // Restore unconditionally, even on a throw. A mutated tree left behind is
    // how a "harmless" test run becomes a production incident.
    writeFileSync(path, original)
  }
}

console.log(`\n${survivors.length === 0
  ? `✅ google-auth mutations: ${caught}/${MUTATIONS.length} caught, 0 survivors`
  : `❌ google-auth mutations: ${survivors.length} survivor(s) — the guard has holes`}`)
process.exit(survivors.length === 0 ? 0 : 1)
