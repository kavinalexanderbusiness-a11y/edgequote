// ── verify-all — the one command that runs every verify, and proves the set is whole
//
//   npm run verify          parity guard, then run every verify:<domain>
//   npm run verify -- --check   parity guard only (instant; no scripts run)
//
// WHY THIS EXISTS
// There are ~two dozen scripts/verify-<domain>.ts guards, each wired to a
// verify:<domain> npm script. Two failure modes were latent:
//
//   1. NO ONE COMMAND RAN THEM ALL. A deploy check meant remembering two dozen
//      names, or a doc listing them that rots the moment a script is added. In
//      practice most never ran together, so "the suite passes" was never actually
//      asserted anywhere.
//
//   2. NOTHING ENFORCED THE SET. The files and the npm scripts stayed in sync by
//      discipline alone. Add scripts/verify-foo.ts and forget the npm entry and you
//      ship a guard that never runs — dead safety, silent. Rename a file and leave
//      the script pointing at the old path and it fails only when someone happens to
//      invoke that one name. This whole codebase keeps getting bitten by exactly
//      this shape (a canonical thing introduced, an old/again path left un-enforced),
//      so the fix is to make the invariant executable.
//
// This runner is dev/CI tooling ONLY. It ships nothing: `next build` never invokes
// it, and it imports no application code. It cannot change production behaviour.
//
// THE PARITY CONTRACT it enforces (all three drift modes):
//   • every scripts/verify-<name>.ts  has a  "verify:<name>" npm script   (no dead safety)
//   • every "verify:<name>" npm script has a scripts/verify-<name>.ts file (no dangling entry)
//   • every "verify:<name>" command is exactly `tsx scripts/verify-<name>.ts` (no mis-wire)
// Any breach fails the run BEFORE any guard executes — a hole in the net is fixed
// first, not reported after 25 seconds of green.

import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const ROOT = join(__dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts')
const SELF = 'verify-all'

// tsx's own CLI entry, resolved from its package manifest so no dist path is
// hard-coded (it moves between tsx versions). `node <cli> <file>` runs a TS file
// identically on Windows and POSIX — spawning the .bin shim would not.
const tsxPkg = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'tsx', 'package.json'), 'utf8'))
const TSX_CLI = resolve(ROOT, 'node_modules', 'tsx', typeof tsxPkg.bin === 'string' ? tsxPkg.bin : tsxPkg.bin.tsx)

interface Pkg { scripts: Record<string, string> }
const pkg: Pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// Domains from the files on disk (verify-all itself is the runner, not a domain).
const fileDomains = readdirSync(SCRIPTS_DIR)
  .filter(f => f.startsWith('verify-') && f.endsWith('.ts'))
  .map(f => f.slice('verify-'.length, -'.ts'.length))
  .filter(d => d !== SELF.slice('verify-'.length))
  .sort()

// Domains from the "verify:<name>" npm scripts.
const scriptDomains = Object.keys(pkg.scripts)
  .filter(k => k.startsWith('verify:'))
  .map(k => k.slice('verify:'.length))
  .sort()

// ── Parity guard ─────────────────────────────────────────────────────────────
const drift: string[] = []

for (const d of fileDomains) {
  if (!scriptDomains.includes(d)) {
    drift.push(`  • scripts/verify-${d}.ts exists but no "verify:${d}" npm script — this guard never runs`)
  }
}
for (const d of scriptDomains) {
  if (!fileDomains.includes(d)) {
    drift.push(`  • "verify:${d}" npm script points at scripts/verify-${d}.ts, which does not exist`)
  }
}
// Command form: the canonical wiring is exactly `tsx scripts/verify-<name>.ts`.
// A drifted path (typo, wrong file) passes the two existence checks above but runs
// the wrong guard — or none.
for (const d of scriptDomains) {
  const expected = `tsx scripts/verify-${d}.ts`
  const actual = pkg.scripts[`verify:${d}`]
  if (fileDomains.includes(d) && actual.trim() !== expected) {
    drift.push(`  • "verify:${d}" is \`${actual}\` — expected \`${expected}\``)
  }
}

if (drift.length) {
  console.error(`\n✗ verify registry is out of sync (${drift.length} issue${drift.length === 1 ? '' : 's'}):\n`)
  console.error(drift.join('\n'))
  console.error('\nFix the wiring before the suite can be trusted — a missing entry is a guard that silently never runs.\n')
  process.exit(1)
}

console.log(`✓ registry parity: ${fileDomains.length} guards, each file ↔ npm script ↔ canonical command`)

if (process.argv.includes('--check')) {
  console.log('  (--check: parity only, no guards run)\n')
  process.exit(0)
}

// ── Run every guard ──────────────────────────────────────────────────────────
// Each in its own process (the guards call process.exit; the exit CODE is the
// truth — a guard that dies mid-way still exits non-zero even if its own printed
// tally would have lied). Output is captured and shown ONLY on failure, so a green
// run stays quiet and a red one shows exactly the guard that broke.
const started = Date.now()
const failures: { domain: string; code: number | null; output: string }[] = []
// Guards that could not run at all. Tracked separately from failures so a suite
// can be green and still say plainly what it did not prove.
const unrunnable: { domain: string; why: string }[] = []

// ⭐ The end-of-run report lives in ./lib/verify-summary so it can be driven by a
// test directly: importing THIS file to test its reporting would run every guard.
import { summarize, skipReason, partialSkipNotice, type Notice } from './lib/verify-summary'

// A guard that PASSED but said it skipped part of its work. Never a count - the
// pass is real, and what it skipped is not proof of the half it skipped.
const notices: Notice[] = []

for (const d of fileDomains) {
  const file = join(SCRIPTS_DIR, `verify-${d}.ts`)
  const t0 = Date.now()
  process.stdout.write(`  ▶ verify:${d} … `)
  const r = spawnSync(process.execPath, [TSX_CLI, file], { cwd: ROOT, encoding: 'utf8' })
  const ms = Date.now() - t0
  // Exit 2 is reserved for "this guard could not run" — a live check with no
  // credentials, an optional engine absent. It is NOT a pass: reporting it as one
  // is how a suite goes green while proving nothing, which is exactly what
  // verify:schema and verify:rebuild did through the 2026-08 releases. It is not a
  // failure either, because a developer without production credentials must still
  // be able to run the suite. So it gets its own word, and its own line in the
  // summary, and the release checklist is what insists it be resolved.
  const skipped = r.status === 2
  // status null = killed by signal or spawn error; treat anything not 0 as failure.
  const ok = r.status === 0
  if (skipped) {
    console.log(`SKIPPED — could not run (${ms}ms)`)
    unrunnable.push({ domain: d, why: skipReason(r.stdout ?? '') })
  } else if (ok) {
    console.log(`ok (${ms}ms)`)
    const note = partialSkipNotice(r.stdout ?? '')
    if (note) notices.push({ domain: d, note })
  } else {
    console.log(`FAIL (exit ${r.status ?? 'signal'}, ${ms}ms)`)
    failures.push({ domain: d, code: r.status, output: [r.stdout, r.stderr, r.error?.message].filter(Boolean).join('\n') })
  }
}

const totalS = ((Date.now() - started) / 1000).toFixed(1)

// ⛔ ONE report, printed BEFORE either exit. The old tail exited inside the
// failure branch, so any failure erased the pass count AND the could-not-run
// list - a run that hid verify:schema's skip behind one failing guard is what
// prompted this. Exit semantics are unchanged: non-zero iff something FAILED.
process.exit(summarize({
  total: fileDomains.length,
  failures,
  unrunnable,
  notices,
  seconds: totalS,
}))
