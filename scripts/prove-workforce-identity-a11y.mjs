// ── Manual proof: the warning card's decoration is invisible to assistive tech
//    (icons aria-hidden, decorative separators aria-hidden) ─────────────────
//   node scripts/prove-workforce-identity-a11y.mjs
//
// ⛔ DELIBERATELY NOT `verify-*` AND DELIBERATELY NOT IN `npm run verify`.
// An independent reviewer (S110, see outputs/s110-independent-ui-review.md)
// correctly flagged that the first version of this file was named
// `verify-workforce-identity-a11y.mjs` — a `.mjs`, invisible to
// `verify-all.ts`'s `f.endsWith('.ts')` glob, and never wired to a
// `verify:<name>` npm script — so it looked like a registered suite guard and
// was not one. `prove-*` is this repo's own existing convention for a script
// that is run BY HAND (see the many `prove-*`/`mutate-*`/`*-cdp.mjs` scripts
// already in this directory) — no naming claim of suite membership, no dead
// safety.
//
// ⭐ Deliberately dependency-free (plain node, no tsx/ts-node, no node_modules)
// — built and re-run in a worktree with no `npm ci` (junctioning an existing
// node_modules was attempted for this pass and declined by the environment's
// own safety controls; treated as a real boundary, not retried).
//
// ⭐ SCOPE, deliberately narrow: this proof covers exactly what changed across
// both a11y commits on this branch — icon `aria-hidden` coverage, and the three
// purely-decorative middle-dot separators. It does NOT re-assert the approved
// tip's own behavioural contract (name-only-never-a-finding, handler
// allowlist, etc.) — that would mirror `scripts/verify-workforce-identity.ts`
// on the frozen tip for a change that never touches that logic. One targeted
// proof per targeted change, not a parallel test suite for two JSX attributes.

import { readFileSync } from 'node:fs'

let failures = 0
const ok = n => console.log(`  ✓ ${n}`)
const fail = (n, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, cond, d = '') => cond ? ok(n) : fail(n, d)

const FILE = 'src/components/workforce/WorkerIdentityWarnings.tsx'
const src = readFileSync(FILE, 'utf8')

console.log(`\n═══ ${FILE} — decoration is invisible to assistive tech ═══`)

// ── Icons ─────────────────────────────────────────────────────────────────
// Every lucide-react icon used as pure decoration must carry aria-hidden.
// Checked BY NAME against the exact set imported, so a future icon addition
// either gets aria-hidden or fails this loudly rather than silently.
const importLine = src.match(/import \{([^}]+)\} from 'lucide-react'/)
check('the lucide-react import line is found', !!importLine, 'cannot verify icons without it')
const iconNames = importLine ? importLine[1].split(',').map(s => s.trim()).filter(Boolean) : []
check('icon names were extracted', iconNames.length >= 4, `found: ${iconNames.join(', ')}`)

for (const name of iconNames) {
  const tagPattern = new RegExp(`<${name}\\b[^>]*?/>`, 'g')
  const tags = src.match(tagPattern) || []
  check(`every <${name} .../> usage carries aria-hidden`,
    tags.length > 0 && tags.every(t => /aria-hidden/.test(t)),
    tags.filter(t => !/aria-hidden/.test(t)).join(' | ') || 'no usages found — icon imported but unused?')
}

// The specific gap the first a11y commit closed: the disclosure chevrons.
check('ChevronUp (expanded state) is aria-hidden',
  /<ChevronUp className="[^"]*" aria-hidden \/>/.test(src))
check('ChevronDown (collapsed state) is aria-hidden',
  /<ChevronDown className="[^"]*" aria-hidden \/>/.test(src))

// ── Decorative middle-dot separators ─────────────────────────────────────
// Flagged by the independent reviewer as pre-existing-but-closeable: three
// `<span>·</span>` separators between two already-meaningful text nodes
// (name/name, standing/standing ×2). aria-hidden here is precise — the
// separator carries no information a screen reader needs, and the text nodes
// either side of it remain in the accessible name/description unaffected.
const dotSeparators = [...src.matchAll(/<span className="text-ink-faint"[^>]*>·<\/span>/g)]
check('at least the 3 known middle-dot separators were found', dotSeparators.length === 3,
  `found ${dotSeparators.length}`)
check('every middle-dot separator is aria-hidden',
  dotSeparators.every(m => /aria-hidden/.test(m[0])),
  dotSeparators.filter(m => !/aria-hidden/.test(m[0])).map(m => m[0]).join(' | '))

// ⛔ Negative control: a span carrying REAL information ("×2", the count of
// records sharing a name) must be left alone — hiding it would remove
// information, not decoration. If this ever starts matching the dot pattern
// above, something has been merged/miscoded; assert it stays distinct.
check('⛔ the "×2" duplicate-count span is NOT swept up by the dot-separator fix',
  /<span className="text-ink-faint">×2<\/span>/.test(src),
  'a real information-bearing span must never be silently hidden by a decoration sweep')

console.log('\n── Summary ────────────────────────────────────────────────────')
console.log(failures === 0
  ? '\n✅ every icon and decorative separator is aria-hidden; the one information-bearing span is untouched\n'
  : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
