// ── Targeted, dependency-free check: every icon in the warning card is either
//    aria-hidden or carries an accessible name ──────────────────────────────
//   node scripts/verify-workforce-identity-a11y.mjs
//
// ⭐ Deliberately dependency-free (plain node, no tsx/ts-node, no node_modules
// required) — this follow-up was built in a worktree with no `npm ci` run,
// during a resource-constrained parallel wave. It reads the source as text and
// asserts a structural property, the same idiom this repo's own verify-*.ts
// guards use, just without the TypeScript import machinery.
//
// WHAT IT PINS: found during an audit of the approved tip (ce594984) —
// lucide-react icons render as bare <svg> with no accessible name by default.
// Every icon in this file except the disclosure chevrons carried aria-hidden;
// the chevrons did not, which is an inconsistency against the file's own
// established pattern (not a functional defect — aria-expanded on the button
// already conveys open/closed state — but a real gap worth closing).

import { readFileSync } from 'node:fs'

let failures = 0
const ok = n => console.log(`  ✓ ${n}`)
const fail = (n, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, cond, d = '') => cond ? ok(n) : fail(n, d)

const FILE = 'src/components/workforce/WorkerIdentityWarnings.tsx'
const src = readFileSync(FILE, 'utf8')

console.log(`\n═══ ${FILE} — icon accessibility ═══`)

// Every lucide-react icon element (self-closing JSX, e.g. <Users .../>) used as
// pure decoration in this file must carry aria-hidden. We check by NAME against
// the exact set imported from lucide-react, so a future icon addition either
// gets aria-hidden or fails this check loudly rather than silently.
const importLine = src.match(/import \{([^}]+)\} from 'lucide-react'/)
check('the lucide-react import line is found', !!importLine, 'cannot verify icons without it')
const iconNames = importLine ? importLine[1].split(',').map(s => s.trim()).filter(Boolean) : []
check('icon names were extracted', iconNames.length >= 4, `found: ${iconNames.join(', ')}`)

for (const name of iconNames) {
  // Every self-closing tag for this icon, e.g. `<ChevronUp className="..." aria-hidden />`
  // or across two lines as in the fix. Match up to the closing `/>`.
  const tagPattern = new RegExp(`<${name}\\b[^>]*?/>`, 'g')
  const tags = src.match(tagPattern) || []
  check(`every <${name} .../> usage carries aria-hidden`,
    tags.length > 0 && tags.every(t => /aria-hidden/.test(t)),
    tags.filter(t => !/aria-hidden/.test(t)).join(' | ') || 'no usages found — icon imported but unused?')
}

// ⭐⭐ THE specific regression this follow-up exists to prevent: the disclosure
// chevrons, by name, in both branches of the ternary.
check('⭐⭐ ChevronUp (expanded state) is aria-hidden',
  /<ChevronUp className="[^"]*" aria-hidden \/>/.test(src))
check('⭐⭐ ChevronDown (collapsed state) is aria-hidden',
  /<ChevronDown className="[^"]*" aria-hidden \/>/.test(src))

// ── Regression guard: the approved behavioural contract must be untouched ────
// This follow-up is icon-attribute-only. Assert the load-bearing rules from the
// approved tip are still textually present, so a future edit to this file
// cannot silently drop them while this narrow test stays green.
check('⛔ name-only matches still never produce a finding (design contract intact)',
  /if \(!findings\.length && !uncheckable\.length\) return null/.test(src))
// ⚠️ Asserted over HANDLERS, not words in the file. A word search for
// "merge"/"archive" matches this very file's OWN COMMENTS explaining why there
// is no merge button, its `t.archived_at` READ, and "archived included" in a
// doc comment — the identical trap the approved tip's own guard
// (scripts/verify-workforce-identity.ts) hit and fixed for the same reason.
const onClicks = [...src.matchAll(/onClick=\{([\s\S]*?)\}(?=[\s>])/g)].map(m => m[1].trim())
check('the handler extractor found real onClick handlers',
  onClicks.length >= 4, `found ${onClicks.length}`)
check('⛔ every onClick either opens the existing editor (onOpen) or toggles local UI state',
  onClicks.every(h => /^\(\)\s*=>\s*(onOpen\(|expand\(|setShowUncheckable\()/.test(h)),
  `offending: ${onClicks.filter(h => !/^\(\)\s*=>\s*(onOpen\(|expand\(|setShowUncheckable\()/.test(h)).join(' | ')}`)
check('⛔ onOpen(a) and onOpen(b) are both present — Review is offered on both records',
  /onClick=\{\(\) => onOpen\(a\)\}/.test(src) && /onClick=\{\(\) => onOpen\(b\)\}/.test(src))
check('⛔ aria-expanded is still present on both disclosure buttons',
  (src.match(/aria-expanded=/g) || []).length === 2)

console.log('\n── Summary ────────────────────────────────────────────────────')
console.log(failures === 0
  ? '\n✅ every icon is aria-hidden or has a name; the approved behavioural contract is untouched\n'
  : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
