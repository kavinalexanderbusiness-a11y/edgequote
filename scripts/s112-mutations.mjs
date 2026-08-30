// ── Session 112 mutation suite — proves verify:accepted-document-truth can fail ─
//   node scripts/s112-mutations.mjs
//
// Each mutation flips exactly one protection in the real source (or the real
// migration), runs the guard, and REQUIRES it to go red. Two self-checks make
// the suite honest about itself:
//   · a mutation that changes NO bytes fails the suite (a no-op "mutation"
//     proves nothing — the exact mistake an early portal-confusion run made);
//   · after every restore, the guard must be green again before the next
//     mutation runs, so failures can never bleed between cases.
//
// ⛔ Run only on a COMMITTED tree: restores use `git checkout --`, which on an
// uncommitted file silently reverts to the last commit (the S112 QuotePDF
// incident). The suite refuses a dirty target file up front.

import { execSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const MAPPER = 'src/lib/acceptedDocument.ts'
const ENGINE = 'src/lib/quoteAcceptance.ts'
const PDF = 'src/components/quotes/QuotePDF.tsx'
const MODEL = 'src/app/portal/[token]/model.ts'
const GUARD = 'scripts/verify-accepted-document-truth.ts'
const MIG = 'supabase/migrations/20260830150000_portal_accepted_version.sql'

/** [name, file, find, replace] — replace must CHANGE the file. */
const MUTATIONS = [
  ['live price replaces snapshot price', MAPPER,
    'initial_price: numOrNull(d.initial_price),', 'initial_price: 9999,'],
  ['live scope replaces snapshot scope', MAPPER,
    'const services: QuoteService[] | undefined = d.services?.length',
    'const services: QuoteService[] | undefined = undefined ?? false && d.services?.length'],
  ['live terms replace historical terms', PDF,
    'const termsText = accepted ? accepted.termsText : settings?.terms_text',
    'const termsText = (accepted && accepted.termsText) || settings?.terms_text'],
  ['accepted renderer ignores evidence kind', PDF,
    'acceptedDocumentLabel(accepted.kind, dateStr(accepted.at))',
    "acceptedDocumentLabel('customer', dateStr(accepted.at))"],
  ['legacy_unrecorded labelled "customer accepted"', ENGINE,
    "export function acceptedDocumentLabel(kind: AcceptanceKind, dateText: string): { title: string; body: string } {\n  if (kind === 'legacy_unrecorded') return {",
    "export function acceptedDocumentLabel(kind: AcceptanceKind, dateText: string): { title: string; body: string } {\n  if (false && kind === 'legacy_unrecorded') return {"],
  ['owner_on_behalf labelled as customer acceptance', ENGINE,
    "  if (kind === 'owner_on_behalf') return {\n    title: `ACCEPTED VERSION — RECORDED ${dateText}`,",
    "  if (false && kind === 'owner_on_behalf') return {\n    title: `ACCEPTED VERSION — RECORDED ${dateText}`,"],
  ['legacy weld dropped — terms claimed on a backfill', MAPPER,
    "const termsText = args.kind === 'legacy_unrecorded' ? null : args.termsText",
    'const termsText = args.termsText'],
  ['portal confuses current revision with accepted version', MODEL,
    'getBlob: acc && isAcceptedOrBeyond(qq.status)\n        ? () => renderers.acceptedQuote(qq, acc)\n        : () => renderers.quote(qq),',
    'getBlob: () => renderers.quote(qq),'],
  ['historical fingerprint ignored', MODEL,
    'const driftedSinceAccepted = acc\n      ? acc.needs_reapproval && isAcceptedOrBeyond(qq.status)\n      : priceMovedSinceAccepted',
    'const driftedSinceAccepted = priceMovedSinceAccepted'],
  ['revision overwrites historical document (protection dropped)', GUARD,
    '  const refused = async (sql: string, params: unknown[] = []): Promise<string | null> => {',
    "  await db.exec('drop trigger trg_quote_acceptances_append_only on public.quote_acceptances')\n  const refused = async (sql: string, params: unknown[] = []): Promise<string | null> => {"],
  ['stale body: draft-quote privacy removed from the migration', MIG,
    "and qt.status <> 'draft'", ''],
  ['internal job notes reappear in the portal projection', MIG,
    'qt.accepted_price, qt.deposit_type, qt.deposit_value,',
    'qt.accepted_price, qt.deposit_type, qt.deposit_value, qt.internal_notes,'],
  ['the migration replaces an unrelated function', MIG,
    'end; $function$;',
    "end; $function$;\n\nCREATE OR REPLACE FUNCTION public.handle_updated_at() RETURNS trigger LANGUAGE plpgsql AS $stale$ begin return new; end; $stale$;"],
]

let failures = 0
const ok = n => console.log(`  ✓ ${n}`)
const bad = (n, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }

// Refuse dirty targets — a checkout-restore would eat uncommitted work.
const dirty = execSync('git status --porcelain', { encoding: 'utf8' })
  .split('\n').filter(Boolean).map(l => l.slice(3).replace(/"/g, ''))
for (const [, file] of MUTATIONS) {
  if (dirty.some(d => d.replace(/\\/g, '/') === file)) {
    console.error(`REFUSED: ${file} has uncommitted changes — commit before mutating.`)
    process.exit(2)
  }
}

const runGuard = () => spawnSync('npm', ['run', 'verify:accepted-document-truth'], { shell: true, encoding: 'utf8' })

console.log('\n═══ baseline must be green before anything is mutated ═══')
if (runGuard().status !== 0) { console.error('REFUSED: guard is not green at baseline.'); process.exit(2) }
ok('baseline green')

for (const [name, file, find, replace] of MUTATIONS) {
  console.log(`\n■ ${name}`)
  const before = readFileSync(file, 'utf8')
  const norm = before.replace(/\r\n/g, '\n')
  if (!norm.includes(find)) { bad('mutation target found in the file', `${file} does not contain the needle`); continue }
  const after = norm.replace(find, replace)
  if (after === norm) { bad('the mutation changed bytes', 'replacement was a no-op — this proves nothing'); continue }
  // Preserve the file's own line endings on write.
  writeFileSync(file, before.includes('\r\n') ? after.replace(/\n/g, '\r\n') : after)
  const r = runGuard()
  if (r.status !== 0) ok('the guard went red')
  else bad('the guard went red', 'mutation survived — the protection is decorative')
  execSync(`git checkout -- "${file}"`)
  if (runGuard().status === 0) ok('restored to green')
  else { bad('restored to green', 'the restore left the guard red — aborting'); process.exit(2) }
}

console.log('\n── Summary ────────────────────────────────────────────────────')
console.log(failures === 0
  ? `\n✅ s112 mutations — all ${MUTATIONS.length} caught, no no-ops, restored green\n`
  : `\n❌ s112 mutations — ${failures} failure(s)\n`)
process.exit(failures === 0 ? 0 : 1)
