// ── preflight-quote-number — READ ONLY, run immediately before applying ──────
//
//   npx tsx scripts/preflight-quote-number.ts
//
// ⛔⛔ THIS SCRIPT WRITES NOTHING. Every statement is a SELECT or an RPC that
// only reads. It applies no migration, renumbers nothing, and touches no row.
//
// ⭐⭐ THE QUESTION IT ANSWERS, WHICH NO OTHER GUARD CAN.
// §8 of supabase/proposals/quote_number_integrity_v1.sql re-routes book_service()
// and submit_booking() by MATCHING A MULTI-LINE ANCHOR against the body those
// functions have IN PRODUCTION, and refusing if the text is not found. Every
// other guard in this session builds the schema FROM ZERO out of this repository
// — so it proves the anchor matches the body the repo would create, which is not
// the same claim. If production has drifted, or a body comes back with different
// line endings, the from-zero guards stay green and the apply refuses.
//
// ⚠️⚠️ THAT IS NOT HYPOTHETICAL. S113 lost a production apply to exactly this:
// multi-line anchors read from a CRLF source matched ZERO times against LF
// bodies, and its from-zero guard was green and structurally could not see it.
// S122 hit the same shape. This script is the missing measurement, taken against
// the real bodies, before anything is applied.
//
// HOW IT KNOWS THE BODIES ARE CURRENT. supabase/contract/functions.json holds the
// definitions captured FROM PRODUCTION. That capture is only trustworthy if
// production still matches it, so this script calls schema_fingerprint() and
// compares the `functions` section itself. If they disagree it says so and makes
// no claim about the anchors — a stale capture must never read as a green light.
//
// ⭐ Exit codes: 0 = safe to apply · 1 = do NOT apply · 2 = could not measure.

import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const PROPOSAL = 'supabase/proposals/quote_number_integrity_v1.sql'
const FUNCTIONS = 'supabase/contract/functions.json'
const FINGERPRINT = 'supabase/contract/fingerprint.json'
const DOORS = ['book_service', 'submit_booking'] as const

function loadEnv() {
  if (!existsSync('.env.local')) return
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadEnv()

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}

// ── Rebuild the anchor exactly as the migration builds it ────────────────────
// §8 writes each anchor as  E'…\n' || E'…'  on single physical lines, so its
// newlines are ESCAPES and are LF regardless of this file's own line endings.
// Reconstructing it here rather than re-typing it is the point: a re-typed copy
// could drift from the one that will actually run.
const unescapeE = (s: string) => s
  .replace(/''/g, "'")
  .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
  .replace(/\\'/g, "'").replace(/\\\\/g, '\\')

function anchorFor(proposal: string, fn: string): string | null {
  const idx = proposal.indexOf(`p.proname = '${fn}'`)
  if (idx < 0) return null
  const m = proposal.slice(idx).match(/v_new := replace\(v_fn,\n([\s\S]*?),\n\s*E'[^\n]*'\);/)
  if (!m) return null
  const parts = [...m[1].matchAll(/E'((?:[^'\\]|\\.|'')*)'/g)].map(p => unescapeE(p[1]))
  return parts.length ? parts.join('') : null
}

async function main() {
  console.log('\n══ quote-number landing preflight — READ ONLY ══════════════════════════\n')

  if (!existsSync(PROPOSAL)) {
    console.error(`  ✗ ${PROPOSAL} is missing.`)
    console.error('    If it has already been stamped into supabase/migrations/, point this at it.')
    process.exit(2)
  }
  const proposal = readFileSync(PROPOSAL, 'utf8').replace(/\r\n/g, '\n')

  // ── 1 · is the captured contract still what production runs? ──────────────
  console.log('── 1 · is the captured body still what production runs? ──\n')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const email = process.env.PORTAL_RPC_OWNER_EMAIL
  const password = process.env.PORTAL_RPC_OWNER_PASSWORD
  if (!url || !anon || !email || !password) {
    console.log('  ⏭  COULD NOT MEASURE — no owner credentials in .env.local.')
    console.log('     The anchors below could only be compared against a capture this script')
    console.log('     cannot confirm is current, and a stale capture must not read as green.\n')
    process.exit(2)
  }
  const sb = createClient(url, anon, { auth: { persistSession: false } })
  const { error: signInErr } = await sb.auth.signInWithPassword({ email, password })
  if (signInErr) {
    console.log(`  ⏭  COULD NOT MEASURE — sign-in refused (${signInErr.message}).\n`)
    process.exit(2)
  }
  const { data: fpData, error: fpErr } = await sb.rpc('schema_fingerprint')
  await sb.auth.signOut({ scope: 'local' })   // local: never revoke the owner's phone
  if (fpErr) {
    console.log(`  ⏭  COULD NOT MEASURE — schema_fingerprint() failed (${fpErr.message}).\n`)
    process.exit(2)
  }
  const live = fpData as { sections?: Record<string, { n: number; md5: string }>; latest_migration?: string }
  const expected = JSON.parse(readFileSync(FINGERPRINT, 'utf8')) as
    { sections: Record<string, { n: number; md5: string }>; latest_migration?: string; captured_at?: string }

  const liveFns = live.sections?.functions
  const capturedFns = expected.sections.functions
  check('the captured function bodies still match production',
    !!liveFns && liveFns.md5 === capturedFns.md5,
    `contract functions md5 ${capturedFns.md5} (n=${capturedFns.n}) vs live ${liveFns?.md5} (n=${liveFns?.n}).\n`
    + '      Production has changed. Re-run `npm run schema:contract` before trusting anything below.')
  console.log(`     ledger — contract: ${expected.latest_migration ?? '?'} · live: ${live.latest_migration ?? '?'}`)
  if (fail) {
    console.error('\n  ⛔ STOPPING. The captured bodies are stale, so no claim about the anchors is honest.\n')
    process.exit(1)
  }

  // ── 2 · will the guarded in-place swap actually match? ────────────────────
  console.log('\n── 2 · will §8 match the body production actually has? ──\n')
  type FnDef = { proname: string; def: string }
  const contract: unknown = JSON.parse(readFileSync(FUNCTIONS, 'utf8'))
  const arr: FnDef[] = Array.isArray(contract)
    ? (contract as FnDef[])
    : (Object.values(contract as Record<string, FnDef>))

  for (const fn of DOORS) {
    const body = (arr.find(x => x.proname === fn) || {}).def ?? ''
    const anchor = anchorFor(proposal, fn)
    if (!anchor) { check(`${fn}: the anchor could be read out of the proposal`, false); continue }
    if (!body) { check(`${fn}: production has a captured body`, false, `no ${fn} in ${FUNCTIONS}`); continue }

    // The migration strips CR before matching; measure both so the report says
    // whether that normalisation is doing work or merely standing guard.
    const raw = body.split(anchor).length - 1
    const norm = body.replace(/\r\n/g, '\n').split(anchor).length - 1
    check(`${fn}: the guarded anchor matches the live body exactly once`,
      norm === 1,
      `matches=${norm} (raw ${raw}). The migration REFUSES on anything but 1 — re-measure the body before applying.`)
    console.log(`     ${fn}: body ${body.length} bytes, ${/\r/.test(body) ? 'CRLF' : 'LF'}; `
      + `anchor ${anchor.length} bytes over ${anchor.split('\n').length} lines`
      + `${raw !== norm ? '  ⭐ CR-stripping is load-bearing here' : ''}`)
  }

  // ── 3 · nothing may still allocate with MAX()+1 ───────────────────────────
  console.log('\n── 3 · no other live function still allocates with MAX()+1 ──\n')
  const offenders = arr.filter(f =>
    /max\(\(regexp_match\(quote_number/i.test(f.def ?? '') && !DOORS.includes(f.proname as typeof DOORS[number]))
  check('no function OTHER than the two known doors scans quotes for a maximum',
    offenders.length === 0,
    offenders.map(o => o.proname).join(', ')
    + ' — §8 refuses to finish if any survive, so this would fail the apply')
  const known = DOORS.filter(fn => /max\(\(regexp_match\(quote_number/i.test((arr.find(x => x.proname === fn) || {}).def ?? ''))
  check('both known doors still carry the defect this migration removes',
    known.length === 2,
    `found the MAX()+1 allocation in: ${known.join(', ') || 'neither'} — if one is already gone, re-measure §8`)

  console.log(`\n${fail ? '✗' : '✓'} preflight — ${pass} passed, ${fail} failed`)
  if (fail) {
    console.error('\n  ⛔ DO NOT APPLY until the failures above are understood.\n')
    process.exit(1)
  }
  console.log('\n  ⭐ The in-place swap will match. Nothing here has been changed.\n')
}

main().catch(e => { console.error(e); process.exit(1) })
