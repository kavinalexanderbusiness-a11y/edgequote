// ── Does verify:measure-price actually catch anything? ───────────────────────
//   node scripts/mutate-measure-price.mjs
//
// A guard that passes is worthless until you have watched it fail. Each mutation
// below is a real bug someone could plausibly introduce — several are bugs this
// session actually shipped and had to fix. The guard must go RED for every one,
// and the file must be byte-identical afterwards.
//
// ⚠️ COMMIT BEFORE RUNNING. This rewrites source files in place and restores them
// from the copy it took; a crash between the two leaves the tree mutated, and an
// uncommitted change would be unrecoverable.
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const MUTATIONS = [
  {
    file: 'src/lib/measurePricing.ts',
    name: 'unknown price becomes zero (the $0 quote)',
    from: "return { ...base, price: null, basisText: 'No rate configured for this plan' }",
    to: "return { ...base, price: 0, basisText: 'No rate configured for this plan' }",
  },
  {
    file: 'src/lib/measurePricing.ts',
    name: 'an unmeasured per-unit plan prices at zero',
    from: "return { ...base, price: null, basisText: `${unitRateText(rate)}/${unitLabel(type) || 'unit'} — measure to price` }",
    to: "return { ...base, price: 0, basisText: `${unitRateText(rate)}/${unitLabel(type) || 'unit'} — measure to price` }",
  },
  {
    file: 'src/lib/measurePricing.ts',
    name: 'the measurement→money multiplication is wrong',
    from: 'return Math.round(rate * quantity)',
    to: 'return Math.round(rate * quantity * 1.1)',
  },
  {
    file: 'src/lib/measurePricing.ts',
    name: 'the snapshot references the live plan instead of copying the rate',
    from: 'rate: input.plan?.rate ?? null,',
    to: 'rate: null,',
  },
  {
    file: 'src/lib/measurePricing.ts',
    name: 'a service name decides the measurement type',
    from: "export function measurementTypeFor(s: MeasurableService | null | undefined): MeasurementType {",
    to: "export function measurementTypeFor(s: MeasurableService | null | undefined): MeasurementType {\n  const snow = /snow/i",
  },
  {
    file: 'src/lib/measurePricing.ts',
    name: 'an unknown commercial term silently defaults to One-time',
    from: '  if (!d) throw new Error(`Unknown pricing term: ${term}`)',
    to: '  if (!d) return PRICING_TERMS[0]',
  },
  {
    file: 'src/lib/googleMaps.ts',
    name: 'the Maps auth refusal is no longer heard',
    from: '  window.gm_authFailure = () => {',
    to: '  const _unused = () => {',
  },
  {
    file: 'src/lib/googleMaps.ts',
    name: 'places creeps back into the browser key',
    from: 'libraries=geometry&loading=async',
    to: 'libraries=places,geometry&loading=async',
  },
  {
    file: 'src/components/maps/MapUnavailable.tsx',
    name: 'the customer is shown the diagnostic',
    from: '        <p className="mt-1 text-xs text-ink-muted">\n          You can still continue — just type your address below.\n        </p>',
    to: '        <p className="mt-1 text-xs text-ink-muted">{unavailable.detail}</p>',
  },
  {
    file: 'supabase/migrations/20260826120000_measure_price_rate_precision.sql',
    name: 'the rate column is narrowed back to cents',
    from: 'alter column "rate" type numeric(12,4);',
    to: 'alter column "rate" type numeric(10,2);',
  },
  {
    file: 'supabase/migrations/20260823120000_measure_price_v2.sql',
    name: 'the composite tenant FK is weakened to a single column',
    from: '    foreign key ("service_template_id", "user_id")',
    to: '    foreign key ("service_template_id")',
  },
]

let caught = 0
let missed = 0
const skipped = []

// ⚠️⚠️ CRLF DISARMS A MULTI-LINE ANCHOR. These files are checked out with CRLF on
// Windows (git says so on every write: "LF will be replaced by CRLF"), while the
// anchors below are written with \n. An exact `includes()` therefore misses any
// anchor spanning more than one line, and the mutation reports SKIP — which reads
// like a stale anchor and is really a mutation that silently stopped running. A
// guard nobody is mutating is a guard nobody is checking.
// Match on a line-ending-agnostic regex instead, so the same anchor works on both.
const rx = s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\r?\n/g, '\\r?\\n'))

for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8')
  const anchor = rx(m.from)
  if (!anchor.test(original)) {
    skipped.push(m.name)
    console.log(`⚠️  SKIP  ${m.name}\n         anchor not found in ${m.file} — the mutation is stale, not the guard`)
    continue
  }
  writeFileSync(m.file, original.replace(anchor, m.to.replace(/\$/g, '$$$$')))
  let red = false
  try {
    execSync('npm run verify:measure-price', { stdio: 'pipe' })
  } catch {
    red = true
  } finally {
    writeFileSync(m.file, original)
  }
  if (red) { caught++; console.log(`✓ CAUGHT  ${m.name}`) }
  else { missed++; console.log(`✗ MISSED  ${m.name}\n         the guard passed with this bug in place`) }
}

// The tree must be exactly as we found it.
const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim()
console.log(`\n${caught} caught · ${missed} missed · ${skipped.length} skipped`)
console.log(dirty ? `\n⚠️  TREE NOT RESTORED:\n${dirty}` : '\n✓ tree restored byte-for-byte')
process.exit(missed === 0 && !dirty ? 0 : 1)
