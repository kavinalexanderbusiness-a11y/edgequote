// ── Verify: Undo tells the truth ─────────────────────────────────────────────
//   npm run verify:undo-contract
//
// WHY THIS SCRIPT EXISTS
// `toast.undo(msg, revert)` is the app's one destructive-action pattern: act now,
// offer a few seconds to put it back. That is a PROMISE, and the promise is kept
// by the revert callback — which is usually a single database write.
//
// A Supabase write RESOLVES on failure (it returns `{ error }`, it does not throw),
// so an unchecked revert fails in total silence. The owner clicks Undo, the toast
// disappears, and nothing happened. Worse, several sites repainted their local
// state unconditionally afterwards, so the screen showed the row restored while the
// database still held it deleted — the UI actively lying about the outcome.
//
// Thirteen sites shipped that way at once (archived customers, deleted shifts that
// feed payroll, removed expenses that are costs missing from the books, revoked API
// keys, dead webhook URLs, travel-fee tiers that change what quotes charge). tsc and
// `next build` are perfectly happy with every one of them, which is exactly why this
// has to be asserted over the real source instead of trusted to review.
//
// THE CONTRACT: if an undo callback persists anything, its body must reference the
// write's error. That is deliberately shallow — it cannot judge the wording of the
// message, only that the outcome is looked at. It is enough to stop the whole class
// from reappearing, and it costs one line to satisfy honestly.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }

const SRC = join(process.cwd(), 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

const rel = (p: string) => p.slice(SRC.length + 1).replace(/\\/g, '/')

// ── Known exceptions: FROZEN surfaces ────────────────────────────────────────
// These four are the same defect, on surfaces under an explicit freeze (quotes /
// invoices / payments, messaging, scheduling, the quote builder). A freeze means
// flag, don't fix — so they are recorded here rather than patched, and the debt is
// visible in the guard instead of invisible in the code. Keyed on the undo's own
// label text, not a line number, so the entry cannot silently start covering a
// DIFFERENT undo in the same file as it moves.
//
// ⚠️ Do not add to this list to make a new failure go away. Check the error.
const FROZEN_EXCEPTIONS: { file: string; label: string; why: string }[] = [
  { file: 'app/dashboard/invoices/page.tsx', label: 'cancelled.', why: 'invoices/payments frozen' },
  { file: 'app/dashboard/messages/page.tsx', label: 'Snoozed until', why: 'messaging frozen' },
  { file: 'app/dashboard/quotes/new/page.tsx', label: 'Saved lawn size updated', why: 'quote builder + pricing frozen' },
  { file: 'app/dashboard/schedule/page.tsx', label: 'Removed “', why: 'scheduling frozen' },
]

interface Site { file: string; line: number; body: string }

/**
 * Every `.undo(` call site, with its full argument list.
 *
 * The paren walk MUST skip strings, template literals and comments. A naive counter
 * over-runs the moment a message contains an unbalanced bracket — and an over-run
 * body swallows the next function, whose own error check then satisfies this guard
 * on behalf of an undo that has none. (Caught by negative-testing this script: a
 * deliberately broken site passed.) Returns end = -1 for an unterminated call.
 */
function callArgs(s: string, open: number): number {
  let depth = 0
  for (let j = open; j < s.length; j++) {
    const c = s[j]
    if (c === '/' && s[j + 1] === '/') { j = s.indexOf('\n', j); if (j === -1) return -1; continue }
    if (c === '/' && s[j + 1] === '*') { j = s.indexOf('*/', j); if (j === -1) return -1; j++; continue }
    if (c === '\'' || c === '"' || c === '`') {
      const quote = c
      for (j++; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue }
        if (s[j] === quote) break
        // `${…}` can hold arbitrary code, including parens — walk it as code.
        if (quote === '`' && s[j] === '$' && s[j + 1] === '{') {
          const close = callArgs(s, j + 1)
          if (close === -1) return -1
          j = close
        }
      }
      if (j >= s.length) return -1
      continue
    }
    if (c === '(' || c === '{') depth++
    else if (c === ')' || c === '}') { depth--; if (depth === 0) return j }
  }
  return -1
}

function undoSites(): Site[] {
  const sites: Site[] = []
  for (const f of walk(SRC)) {
    const s = readFileSync(f, 'utf8')
    let i = 0
    while ((i = s.indexOf('.undo(', i)) !== -1) {
      const open = i + '.undo'.length
      const end = callArgs(s, open)
      if (end === -1) {
        // Unparseable is a failure, never a pass: a site this script cannot read is a
        // site it cannot police, and silently skipping it is the hole it exists to close.
        fail(`${rel(f)}:${s.slice(0, i).split('\n').length} — could not parse the undo call`, 'this guard cannot check it; simplify the call or fix the scanner')
        i = open
        continue
      }
      sites.push({ file: rel(f), line: s.slice(0, i).split('\n').length, body: s.slice(i, end + 1) })
      i = end
    }
  }
  return sites
}

// A revert that only restores LOCAL state (setState with a captured snapshot) has
// nothing to check — it cannot fail. Only persisting reverts are in scope.
const PERSISTS = /supabase\s*\.\s*from\(|\.rpc\(|await\s+(install|restore|reactivate)[A-Za-z]*\(/

/**
 * Naming the error is not checking it: `const { error } = await …` and then nothing
 * reads exactly like a guarded write and behaves exactly like an unguarded one. So
 * the contract is that some error binding is BRANCHED on — an `if`, a ternary, a
 * `&&`/`||`, or a `throw`. Bindings come in both shapes the app uses: destructured
 * (`{ error }`, `{ error: rErr }`) and assigned (`const rErr = await install(…)`).
 */
function checksItsWrite(body: string): boolean {
  // Result-object form: the engine helpers return `{ error }`, so the branch is on a
  // PROPERTY of a result whose own name carries no hint (`const r = await restorePayment(…)`
  // → `if (r.error)`). Checking that shape first keeps the binding scan below narrow.
  if (/if\s*\([^)]*\.error\b|\.error\s*(?:\?|&&|\|\|)|throw[^\n]*\.error\b/.test(body)) return true

  const ids = new Set<string>()
  for (const m of body.matchAll(/\{\s*error\s*(?::\s*(\w+))?[\s,}]/g)) ids.add(m[1] || 'error')
  for (const m of body.matchAll(/\b(?:const|let)\s+(\w*(?:err|Err)\w*)\s*=/g)) ids.add(m[1])
  for (const id of ids) {
    const branched = new RegExp(
      `if\\s*\\([^)]*\\b${id}\\b` +          // if (rErr) / if (rErr) {
      `|\\b${id}\\b\\s*(?:\\?|&&|\\|\\|)` +  // rErr ? … / rErr && …
      `|throw[^\\n]*\\b${id}\\b`,            // throw new Error(rErr…)
    )
    if (branched.test(body)) return true
  }
  return false
}
const CHECKS = { test: checksItsWrite }

const sites = undoSites()

console.log('\n── Every undo callback that persists must check its write ──────')

if (sites.length < 20) {
  fail('the scan found the undo sites', `only ${sites.length} \`.undo(\` call sites found — the walk or the pattern is broken, not the code`)
}

let persisting = 0
const unexpected: string[] = []
const staleExceptions = new Set(FROZEN_EXCEPTIONS.map(e => `${e.file}::${e.label}`))

for (const site of sites) {
  if (!PERSISTS.test(site.body)) continue
  persisting++
  const exception = FROZEN_EXCEPTIONS.find(e => e.file === site.file && site.body.includes(e.label))
  if (exception) {
    staleExceptions.delete(`${exception.file}::${exception.label}`)
    if (CHECKS.test(site.body)) {
      // Someone fixed it — good, but the exception must go, or it starts shielding
      // the next unchecked undo written in the same file.
      fail(`${site.file}:${site.line} now checks its write`, 'remove its entry from FROZEN_EXCEPTIONS — a spent exception is a hole in this guard')
    }
    continue
  }
  if (CHECKS.test(site.body)) ok(`${site.file}:${site.line}`)
  else unexpected.push(`${site.file}:${site.line}`)
}

for (const u of unexpected) {
  fail(`${u} — undo persists without checking the write`,
    'read the write\'s `error` and tell the owner when the restore did not happen; a silent failed undo is the UI lying about the outcome')
}

// An exception whose label no longer appears means the site moved, was reworded or
// was deleted. Either way this entry is now dead weight that could mask a real one.
for (const s of staleExceptions) {
  fail(`stale exception: ${s}`, 'that undo label no longer exists — delete the FROZEN_EXCEPTIONS entry')
}

console.log(`\n── Coverage ───────────────────────────────────────────────────`)
console.log(`  ${sites.length} undo sites · ${persisting} persist · ${FROZEN_EXCEPTIONS.length} frozen exceptions`)

if (failures) {
  console.log(`\n❌ verify:undo-contract — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:undo-contract — every persisting undo reports its outcome\n')
