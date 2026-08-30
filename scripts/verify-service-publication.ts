// ── Verify: ACTIVE is not PUBLISHED ──────────────────────────────────────────
//   npm run verify:service-publication
//
// ⭐⭐ THE DEFECT THIS GUARDS. There was ONE switch — `service_templates.
// is_active` — and both customer-facing projections gated on it and nothing
// else:
//
//   public_services(p_token)  → /api/public/services → the marketing website.
//                               ANONYMOUS. CORS *. Edge-cached for five minutes.
//   get_portal_data(p_token)  → the portal's "Request a service" tab.
//
// So "active" silently meant "published to the open internet". A placeholder
// switched on while pricing was being decided, a $1 row a test left behind, an
// internal-only call-out line — each was public the moment it existed, and the
// production audit found exactly that. No naming discipline fixes it: the system
// never asked whether a service was meant to be seen.
//
// ── THE MODEL: three states, two columns ────────────────────────────────────
//   INACTIVE   is_active = false                     not available at all
//   INTERNAL   is_active = true,  published_at NULL  owner-usable, not public
//   PUBLISHED  is_active = true,  published_at set   explicitly customer-visible
//
// ⛔⛔ THE DEFAULT IS CLOSED AND THE MIGRATION DOES NOT BACKFILL. §4 asserts
// that, because it is the single property that makes the rest safe: a service
// nobody has looked at cannot reach a customer, which is what lets the fixture
// rule stay conservative about "test"-sounding names elsewhere.
//
// This guard has an OFFLINE half (rules + the SQL on the apply path) and a LIVE
// half (an anonymous caller, attacking the real public door). The live half
// needs only the anon key, which CI does not have — so it skips there and runs
// locally, and §5 says which it did.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import {
  PUBLICATION_COLUMNS, PUBLICATION_LABEL, PUBLICATION_MEANING,
  isCustomerVisible, isOwnerUsable, publicationState, publishBlockedReason, publishPatch,
} from '../src/lib/servicePublication'
import { catalogueSuspicions } from '../src/lib/fixtureData'
import { loadEnvLocal } from './lib/verify-fixture'

loadEnvLocal()

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const strip = (s: string) => s.split(/\r?\n/).map(l => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n')
const stripperAlive = (s: string) => { const t = strip(s); return t.length > s.length * 0.2 && t.length < s.length * 0.99 }

// ── 1. The three states ──────────────────────────────────────────────────────
console.log('\n═══ Three states, and a customer sees exactly one of them ═══')
const INACTIVE = { is_active: false, published_at: null }
const INTERNAL = { is_active: true, published_at: null }
const PUBLISHED = { is_active: true, published_at: '2026-08-29T00:00:00Z' }

check('an inactive service is INACTIVE', publicationState(INACTIVE) === 'inactive')
check('an active, never-published service is INTERNAL', publicationState(INTERNAL) === 'internal')
check('an active, published service is PUBLISHED', publicationState(PUBLISHED) === 'published')
// ⭐ THE ordering property. is_active is the master switch; reading them the
// other way round leaves a switched-off service live on the website.
check('⭐ a service that was PUBLISHED and then switched off is INACTIVE, not published',
  publicationState({ is_active: false, published_at: '2026-08-29T00:00:00Z' }) === 'inactive',
  'is_active must win, or unpublishing would require two taps and one of them would be forgotten')
check('⛔ ONLY the published state is customer-visible',
  isCustomerVisible(PUBLISHED) && !isCustomerVisible(INTERNAL) && !isCustomerVisible(INACTIVE))
check('an unknown/missing row is NOT customer-visible — fail closed',
  !isCustomerVisible(null) && !isCustomerVisible(undefined) && publicationState(null) === 'inactive')
check('a row that has never heard of publication reads as INTERNAL, not public',
  publicationState({ is_active: true }) === 'internal',
  'a reader that forgets to select published_at must go quiet, never wide open')
check('the OWNER may use both internal and published services',
  isOwnerUsable(INTERNAL) && isOwnerUsable(PUBLISHED) && !isOwnerUsable(INACTIVE),
  'internal is about the customer, never about the owner’s own tools')
check('every state has a label and a sentence saying what it MEANS',
  (['inactive', 'internal', 'published'] as const)
    .every(s => PUBLICATION_LABEL[s].length > 3 && PUBLICATION_MEANING[s].length > 25))
check('the meanings answer "can my customers see this?" in words',
  /Customers cannot see it/i.test(PUBLICATION_MEANING.internal)
  && /Live for customers/i.test(PUBLICATION_MEANING.published))

// ── 2. Publishing is a patch, not a side effect ──────────────────────────────
console.log('\n═══ Publishing changes publication, and nothing else ═══')
check('publishPatch sets a timestamp, and unpublish clears it',
  typeof publishPatch(true).published_at === 'string' && publishPatch(false).published_at === null)
check('⛔ publishing NEVER touches is_active',
  !('is_active' in publishPatch(true)) && !('is_active' in publishPatch(false)),
  'publishing an inactive service must not switch it on as a side effect nobody asked for')
check('publish is blocked by a $1 price, and the reason is a sentence',
  (publishBlockedReason(catalogueSuspicions({ name: 'Mowing', default_rate: 1, is_active: true })) ?? '').length > 20)
check('publish is NOT blocked by a name that merely reads oddly',
  publishBlockedReason(catalogueSuspicions({ name: 'Soil Testing', default_rate: 180, is_active: true })) === null,
  'the owner decides what their services are called')
check('publish is blocked on an inactive service',
  publishBlockedReason(catalogueSuspicions({ name: 'Mowing', default_rate: 65, is_active: false })) !== null)
check('the gate and the catalogue warnings are the SAME rules',
  /catalogueSuspicions/.test(read('src/lib/servicePublication.ts')) === false
  && /blocksPublication/.test(read('src/lib/servicePublication.ts')),
  'servicePublication composes the suspicions it is GIVEN rather than re-deriving them — one rule, two readers')

// ── 3. The owner surface ─────────────────────────────────────────────────────
console.log('\n═══ The owner can see and change it, in one place ═══')
const TPL_SRC = read('src/app/dashboard/settings/templates/page.tsx')
check('the stripper is alive on the catalogue screen', stripperAlive(TPL_SRC))
const TPL = strip(TPL_SRC)
check('every row states its publication state', /publicationState\(t\)/.test(TPL))
check('…as a badge a person can read, not just a colour',
  /Published/.test(TPL) && /Internal/.test(TPL) && /Inactive/.test(TPL))
check('the publish control has an accessible name and a pressed state',
  /aria-pressed=\{publicationState\(t\) === 'published'\}/.test(TPL)
  && /aria-label=\{publicationState\(t\) === 'published' \?/.test(TPL))
check('⭐ PUBLISHING is confirmed; unpublishing is not',
  /if \(next\) \{[\s\S]{0,700}?confirmDialog\(/.test(TPL),
  'making something public is the direction that cannot be quietly undone — the page is edge-cached for five minutes')
check('…and the confirmation says where it will appear and at what price',
  /booking site and in every customer's portal at \$\{formatServicePrice\(t\)\}/.test(TPL))
check('a blocked service cannot be published from the UI',
  /const blocked = publishBlockedReason\([\s\S]{0,200}?if \(blocked\) \{ toast\.error\(blocked\); return \}/.test(TPL))
check('an un-migrated database is reported as such, not as "could not update"',
  /column .\*published_at/.test(TPL) && /migration has not been applied/.test(TPL),
  '42703 sends the owner looking at the service instead of at the deploy')
check('fixture rows are labelled on the catalogue so the owner knows why counts moved',
  /isFixtureName\(t\.name\)/.test(TPL) && /Test data/.test(TPL))
// ⚠️ Asserted over the WRITE PATH, not over every occurrence of a price. An
// earlier version of this check matched the form's own `defaultValues` — "a new
// service starts at $65" — and called it an auto-correction. The rule is: the
// screen RENDERS the suspicion, and no update payload it sends contains a price
// the owner did not type.
const tplWrites = [...TPL.matchAll(/\.update\(\s*(\{[\s\S]*?\}|[A-Za-z]\w*\([^)]*\))/g)].map(m => m[1])
check('the write-payload extractor found the catalogue’s real writes',
  tplWrites.length >= 3, `found ${tplWrites.length}`)
check('⛔ quality problems are SHOWN, never auto-corrected',
  /catalogueSuspicions\(t/.test(TPL)
  && tplWrites.every(w => !/default_rate\s*:/.test(w) && !/\bname\s*:/.test(w)),
  'the screen states the problem and lets the owner answer it — it must never write a price or a name the owner did not type')

// ── 4. The SQL on the apply path ─────────────────────────────────────────────
console.log('\n═══ The database is the gate — the app only explains it ═══')
const MIGRATIONS = 'supabase/migrations'
const files = readdirSync(join(process.cwd(), MIGRATIONS))
const pubFile = files.find(f => f.includes('service_publication'))
const SQL = pubFile ? read(join(MIGRATIONS, pubFile)) : ''
const baselineFile = files.filter(f => f.endsWith('_baseline.sql')).sort().pop()
const BASELINE = baselineFile ? read(join(MIGRATIONS, baselineFile)) : ''

check('the migration is on the APPLY PATH, not in archive',
  !!pubFile && SQL.length > 1000,
  'supabase/archive/ is never applied — a migration there is a migration that does not exist')
check('it sorts after the live ledger floor',
  !!pubFile && pubFile.slice(0, 14) > '20260828120001',
  `${pubFile} must sort after the current baseline or a from-zero rebuild replays it in the wrong order`)
// ⚠️ Scoped to the ALTER STATEMENT, not to the whole file. `[^;]*` spans lines,
// and this migration is full of `published_at is not null` PREDICATES — the very
// clauses that make the feature work. A file-wide match would have failed on its
// own success, which is the same trap a `[^;]*` once hit spanning a CREATE TABLE.
const alterStmt = (SQL.match(/alter table public\.service_templates[\s\S]*?;/) ?? [''])[0]
check('the column is added by an ALTER that is nullable and has no default',
  /add column if not exists published_at timestamptz;/.test(alterStmt)
  && !/\bnot null\b/i.test(alterStmt) && !/\bdefault\b/i.test(alterStmt),
  'NULL IS the internal state — a default would make "never published" unrepresentable')
check('⭐⭐ THE DEFAULT IS CLOSED: there is no backfill in the migration body',
  !/^\s*update public\.service_templates set published_at/m.test(SQL.replace(/^--.*$/gm, '')),
  'backfilling every active service would re-publish the exact $1 rows this removes')
// The rule is that an operator is WARNED, in the file they are about to run —
// not that the warning uses one exact sentence. Asserted as: the header block
// carries a read-this-first marker, names the visible consequence, and says the
// catalogue empties.
const header = SQL.slice(0, 4000)
check('…and the consequence is stated where an operator will read it',
  /READ THIS BEFORE APPLYING/i.test(header)
  && /EMPTY/.test(header)
  && /until the owner publishes/i.test(header),
  'a migration that changes what customers see must say so in its own header')
check('an OPTIONAL, quality-filtered backfill is offered as a commented decision',
  /OPTIONAL — NOT PART OF THIS MIGRATION/.test(SQL) && /not like 'zz-%'/.test(SQL))

check('⭐ the PUBLIC website door filters on published_at',
  /public\.public_services[\s\S]{0,1400}?is_active = true and published_at is not null/.test(SQL))
check('⭐ the PORTAL door filters on published_at',
  /where user_id = v_user and is_active and published_at is not null/.test(SQL))
check('the portal function is TRANSFORMED in place at a guarded anchor, never retyped',
  /pg_get_functiondef[\s\S]{0,900}?expected exactly 1 services anchor/.test(SQL),
  'get_portal_data carries a dozen incident fixes; retyping it is how one gets lost')
check('⛔ and the transform PROVES the incident fixes survived',
  /LOST its draft-privacy predicate/.test(SQL)
  && /LOST its change_orders projection/.test(SQL)
  && /LOST its quote add-ons projection/.test(SQL),
  'a migration that claims a boundary should demonstrate it in the same transaction')
check('the migration verifies its own effect before committing',
  /did not take the publication predicate/.test(SQL))
check('⛔ NON-DESTRUCTIVE: no drop, no delete, no truncate anywhere in it',
  !/\b(drop\s+(table|column)|delete\s+from|truncate)\b/i.test(SQL.replace(/^--.*$/gm, '')),
  'drop trigger/policy would be replacement, but a dropped COLUMN or a deleted ROW is data loss')

// The defect must actually exist in what shipped, or this whole file guards air.
check('the shipped baseline really did gate the public door on is_active alone',
  /from public\.service_templates where user_id = v_user and is_active = true\)/.test(BASELINE),
  'if this stops matching, the baseline has converged and this assertion should be retired deliberately')

// ── 5. LIVE — the real public door, attacked anonymously ─────────────────────
async function main() {
  console.log('\n═══ The deployed public catalogue ═══')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey || url.includes('placeholder')) {
    console.log('  … SKIPPED — no live Supabase credentials (CI runs with placeholders)')
    return
  }
  const anon = createClient(url, anonKey)

  // A forged token must yield nothing at all. This needs no fixture and writes
  // nothing — it is the cheapest possible proof that the door is token-gated.
  const forged = await anon.rpc('public_services', { p_token: 'forged-token-not-a-real-business' })
  check('a forged booking token returns no catalogue',
    forged.error === null && forged.data === null,
    `returned ${JSON.stringify(forged.data)} — the token is the only thing standing in front of this`)

  // Whether the predicate is LIVE yet. ⚠️ This is a state report, not a pass/fail:
  // the migration is deliberately not applied by this session, so both answers
  // are legitimate — but which one is true must be stated, never assumed.
  const { data: probe, error: probeErr } = await anon
    .from('service_templates').select('published_at').limit(1)
  const columnLive = !(probeErr && /published_at/.test(probeErr.message))
  console.log(columnLive
    ? '  ℹ️  published_at EXISTS on the live database — the migration has been applied.'
    : '  ⚠️  published_at does NOT exist on the live database yet — migration 20260830130000 is UNAPPLIED, so the public catalogue is still gated on is_active alone.')
  check('the live database was actually reachable for that probe',
    probeErr === null || /published_at|permission|row-level/i.test(probeErr.message),
    `unexpected: ${probeErr?.message}`)
}

main()
  .catch(e => fail('the guard itself could not run', String(e?.message ?? e)))
  .finally(() => {
    console.log('\n── Summary ────────────────────────────────────────────────────')
    console.log(failures === 0
      ? '\n✅ verify:service-publication — nothing reaches a customer until a person publishes it\n'
      : `\n❌ verify:service-publication — ${failures} contract${failures === 1 ? '' : 's'} broken\n`)
    process.exit(failures === 0 ? 0 : 1)
  })

// Referenced so the constant cannot be deleted without this guard noticing: a
// customer-facing reader that omits published_at goes silently INTERNAL.
void PUBLICATION_COLUMNS
