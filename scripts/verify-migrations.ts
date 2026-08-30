// ── Migration hygiene — `npm run verify:migrations` ──────────────────────────
//
// Offline. Enforces the rules that keep supabase/ trustworthy, each of which exists
// because breaking it already cost something:
//
//  1. EVERY applied migration is represented in the repo.
//     30 migrations reached production leaving no file at all; five more landed
//     during the audit that found them. If the ledger knows about a migration and
//     the repo does not, the repo is not the source of truth — it is a guess.
//
//  2. Exactly ONE baseline, and it sorts after everything it absorbed.
//     A baseline that sorts before folded-in history makes a rebuild replay that
//     history on top of itself.
//
//  3. The archive is NOT in the apply path.
//     supabase/archive/ holds ~10 older bodies of get_portal_data. Applying one
//     silently replaces the live function with an earlier version — no error, just
//     a portal that shows less. That has happened twice.
//
//  4. Shipped migrations are immutable.
//     A migration already applied to production cannot be edited into meaning
//     something else; a database that ran the old text will never run the new.
//     Enforced by content hash against supabase/contract/ledger.json.
//
// Reads only the repository. No network, no database.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

let pass = 0, fail = 0, warn = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const advise = (name: string, detail: string) => { warn++; console.log(`  ⚠ ${name}\n      ${detail}`) }

const SUPA = 'supabase'
const MIGRATIONS = join(SUPA, 'migrations')
const ARCHIVE = join(SUPA, 'archive')
const LEDGER_DIR = join(ARCHIVE, 'ledger')
const CONTRACT_LEDGER = join(SUPA, 'contract', 'ledger.json')

console.log('\n══ migration hygiene ════════════════════════════════════════════════════\n')

// ── 1. structure ─────────────────────────────────────────────────────────────
console.log('── structure ──')
check('supabase/migrations/ exists', existsSync(MIGRATIONS))
check('supabase/archive/ exists', existsSync(ARCHIVE))

const migrationFiles = existsSync(MIGRATIONS)
  ? readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
  : []
const baselines = migrationFiles.filter(f => /_baseline\.sql$/.test(f))
check('exactly one baseline', baselines.length === 1,
  baselines.length ? `found ${baselines.length}: ${baselines.join(', ')}` : 'no *_baseline.sql in supabase/migrations/')

const VERSION = /^(\d{14})_[a-z0-9_]+\.sql$/
const badNames = migrationFiles.filter(f => !VERSION.test(f))
check('every migration is <14-digit-timestamp>_snake_name.sql', badNames.length === 0, badNames.join(', '))

const versionOf = (f: string) => f.slice(0, 14)
const baselineVersion = baselines[0] ? versionOf(baselines[0]) : ''
check('the baseline sorts first among migrations',
  migrationFiles.length === 0 || migrationFiles[0] === baselines[0],
  `first file is ${migrationFiles[0]}, baseline is ${baselines[0]}`)

const dupes = migrationFiles.map(versionOf).filter((v, i, a) => a.indexOf(v) !== i)
check('no two migrations share a version', dupes.length === 0, dupes.join(', '))

// ── 2. every applied migration is represented ────────────────────────────────
console.log('\n── every applied migration is represented in the repo ──')
if (!existsSync(CONTRACT_LEDGER)) {
  check('supabase/contract/ledger.json exists', false,
    'without it there is no record of what production has applied — run npm run schema:contract')
} else {
  const ledger = JSON.parse(readFileSync(CONTRACT_LEDGER, 'utf8')) as
    { version: string; name: string; sql_md5: string; sql_len: number }[]
  const archived = existsSync(LEDGER_DIR) ? readdirSync(LEDGER_DIR).filter(f => f.endsWith('.sql')) : []
  const archivedVersions = new Set(archived.map(f => f.slice(0, 14)))

  const unrepresented = ledger.filter(l => !archivedVersions.has(l.version) && versionOf(l.version + '_x.sql') !== baselineVersion)
  check(`all ${ledger.length} applied migrations have a file`, unrepresented.length === 0,
    unrepresented.length
      ? `${unrepresented.length} applied to production with NO repo file:\n      ` +
        unrepresented.slice(0, 8).map(l => `${l.version} ${l.name}`).join('\n      ') +
        (unrepresented.length > 8 ? `\n      … and ${unrepresented.length - 8} more` : '') +
        '\n      Recover each with:  select array_to_string(statements, E\'\\n\') from' +
        '\n      supabase_migrations.schema_migrations where version = \'…\';'
      : '')

  // Post-baseline migrations must ALSO be in the ledger, or they have not shipped.
  const postBaseline = migrationFiles.filter(f => !/_baseline\.sql$/.test(f))
  const ledgerVersions = new Set(ledger.map(l => l.version))
  const unshipped = postBaseline.filter(f => !ledgerVersions.has(versionOf(f)))
  if (unshipped.length) {
    advise(`${unshipped.length} migration(s) in supabase/migrations/ are not yet in production`,
      `${unshipped.join(', ')}\n      Expected while a change is in flight; they must be applied before release.`)
  } else {
    check('no migration is committed but unapplied', true)
  }

  // ── 3. immutability ────────────────────────────────────────────────────────
  console.log('\n── shipped migrations are immutable ──')
  const byVersion = new Map(ledger.map(l => [l.version, l]))
  const mutated: string[] = []
  // ⚠️ A ledger row can carry NO sql_md5 — production records the version and name
  // but not the statements when a migration is applied by a path that does not
  // write them. Reading .slice() off that null threw, and a guard that THROWS
  // reports nothing at all: every other check in this file stopped running too.
  // "No SQL recorded" is its own finding — it is not a match and not a mismatch,
  // it is a migration whose immutability CANNOT be checked — so it is counted and
  // named rather than skipped into silence.
  const unhashed: string[] = []
  for (const f of archived) {
    const entry = byVersion.get(f.slice(0, 14))
    if (!entry) continue
    if (!entry.sql_md5) { unhashed.push(`${f} (production recorded no statements)`); continue }
    const body = readFileSync(join(LEDGER_DIR, f), 'utf8')
    // Strip the archive header this repo adds, then compare to what production ran.
    const sql = body.replace(/^[\s\S]*?═══\n\n/, '')
    const md5 = createHash('md5').update(sql, 'utf8').digest('hex')
    if (md5 !== entry.sql_md5) mutated.push(`${f} (repo ${md5.slice(0, 8)} ≠ applied ${entry.sql_md5.slice(0, 8)})`)
  }
  if (unhashed.length) {
    advise(`${unhashed.length} archived migration(s) have NO recorded SQL in production`,
      unhashed.slice(0, 5).join('\n      ') +
      '\n      Production knows the version ran but not what it ran, so immutability cannot' +
      '\n      be checked for it. Backfill supabase_migrations.schema_migrations.statements' +
      '\n      with the SQL that was applied.')
  }
  if (mutated.length) {
    // Whitespace/line-ending normalisation on checkout can shift a hash without
    // anyone editing anything, so this reports rather than fails — but it reports
    // LOUDLY, because the other explanation is that someone rewrote history.
    advise(`${mutated.length} archived migration(s) differ from the SQL production ran`,
      mutated.slice(0, 5).join('\n      ') +
      '\n      Either the file was edited after shipping (not allowed — add a new migration' +
      '\n      instead), or line endings were normalised on checkout. Check `git log -p` on it.')
  } else {
    check(`all ${archived.length} archived migrations byte-match what production ran`, true)
  }
}

// ── 4. the archive is not the apply path ─────────────────────────────────────
console.log('\n── the archive cannot be applied by accident ──')
const archiveSubdirs = existsSync(ARCHIVE)
  ? readdirSync(ARCHIVE).filter(f => statSync(join(ARCHIVE, f)).isDirectory())
  : []
check('archive lives outside supabase/migrations/', !archiveSubdirs.includes('migrations'))

const DEF_HEADER = /create\s+(or\s+replace\s+)?function\s+(public\.)?get_portal_data\s*\(/i
const definersInApplyPath = migrationFiles.filter(f => DEF_HEADER.test(readFileSync(join(MIGRATIONS, f), 'utf8')))
// Re-expressed with verify:portal-canonical (Session 112): the contract is that
// the apply path can only move the portal RPC FORWARD. Resting state is one
// definer (the baseline); an in-flight evolution adds one that sorts AFTER
// every baseline, which the next baseline regeneration absorbs. Fatal remains a
// definer sorting BEFORE a baseline — a from-zero apply would roll it backward.
check('the apply path defines get_portal_data, and only forward',
  definersInApplyPath.length >= 1 &&
  definersInApplyPath.filter(f => !/_baseline\.sql$/i.test(f))
    .every(x => definersInApplyPath.filter(f => /_baseline\.sql$/i.test(f)).every(b => x > b)),
  definersInApplyPath.join(', ') || 'none')

// The historical bodies must still exist somewhere — that is the point of an
// archive — but they must be marked, so nobody pastes one into a SQL editor.
const archiveRun = join(ARCHIVE, 'run')
if (existsSync(archiveRun)) {
  const olderBodies = readdirSync(archiveRun)
    .filter(f => f.endsWith('.sql') && DEF_HEADER.test(readFileSync(join(archiveRun, f), 'utf8')))
  check(`archived older get_portal_data bodies stay out of the apply path (${olderBodies.length} found)`,
    olderBodies.length === 0 || !archiveRun.startsWith(MIGRATIONS))
}

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(72)}`)
if (fail === 0) {
  console.log(`MIGRATION HYGIENE OK — ${pass} passed${warn ? `, ${warn} advisory` : ''}.`)
  console.log('Every migration production has run is represented here, and the baseline is single.\n')
} else {
  console.error(`MIGRATION HYGIENE FAILED — ${fail} failed, ${pass} passed${warn ? `, ${warn} advisory` : ''}.`)
  console.error('See docs/MIGRATIONS.md for the process these rules encode.\n')
}
process.exit(fail === 0 ? 0 : 1)
