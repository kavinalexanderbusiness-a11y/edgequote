// ── Does verify:growth-quality actually catch anything? ──────────────────────
//   node scripts/mutate-growth-quality.mjs
//
// A guard that passes is worthless until you have watched it fail. Every
// mutation below re-introduces a defect the production audit actually found, or
// a defect the gate exists to prevent. The guard must go RED for each, and the
// tree must be byte-identical afterwards.
//
// ⚠️ COMMIT BEFORE RUNNING. This rewrites source files in place and restores them
// from the copy it took; a crash between the two leaves the tree mutated, and an
// uncommitted change would be unrecoverable.
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const MUTATIONS = [
  // ── 1. FIXTURE DATA INCLUDED ───────────────────────────────────────────────
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'fixture included (the fixture flag stops flagging)',
    from: '    if (FIXTURE_MARKERS.some(rx => rx.test(s))) return true',
    to: '    if (false && FIXTURE_MARKERS.some(rx => rx.test(s))) return true',
  },
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'fixture records counted even though flagged',
    from: "    if (looksLikeFixture(...(v.labels ?? []))) { drop('fixture'); continue }",
    to: "    if (false) { drop('fixture'); continue }",
  },
  // ⛔ The mirror-image failure: over-broad exclusion is as much a trust breach
  // as contamination. A real business called "Test Valley Landscaping" must keep
  // its revenue.
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'the fixture rule goes over-broad and eats a real customer',
    from: '  /\\b(test|demo|sample|dummy)\\s*(data|record|customer|account|job|service)\\b/i,',
    to: '  /(test|demo|sample|dummy)/i,',
  },

  // ── 2. UNKNOWN PRICE INCLUDED ──────────────────────────────────────────────
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'unknown price included (unpriced work counted as evidence)',
    from: "  if (!(Number(derivedValue) > 0)) return 'unpriced'",
    to: "  if (false) return 'unpriced'",
  },
  // ── 3. ZERO TREATED AS A REAL PRICE ────────────────────────────────────────
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'zero included as a real price',
    from: "  if (rawPrice != null && Number.isFinite(raw) && raw === 0) return 'zero_price'",
    to: "  if (false) return 'zero_price'",
  },
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'unpriced and $0 are collapsed into one indistinguishable reason',
    from: "    if (p !== 'ok') { drop(p); continue }",
    to: "    if (p !== 'ok') { drop('unpriced'); continue }",
  },

  // ── 4. ONE-OFF WORK ANNUALIZED ─────────────────────────────────────────────
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'one-off annualized (the minimum sample drops to one visit)',
    from: 'export const MIN_VISITS_FOR_VALUE = 2',
    to: 'export const MIN_VISITS_FOR_VALUE = 1',
  },
  {
    file: 'src/lib/revenueIntelligence.ts',
    name: 'a customer with no declared cadence is annualized anyway',
    from: '  const annualFor = (a: Agg): number | null => mayShowAnnual(a.evidence) ? a.evidence.annual : null',
    to: '  const annualFor = (a: Agg): number | null => a.evidence.perVisit != null ? a.evidence.perVisit * SEASON_VISITS.biweekly : null',
  },

  // ── 5. SERVICE-NAME CADENCE INFERENCE RETURNS ──────────────────────────────
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'service-name cadence inference (a name resolves a cadence)',
    from: "  return freq === 'weekly' || freq === 'biweekly' || freq === 'monthly' ? freq : null",
    to: "  if (freq === 'weekly' || freq === 'biweekly' || freq === 'monthly') return freq\n  return /mow|lawn care|fertiliz/i.test(String(freq ?? '')) ? 'biweekly' : null",
  },
  {
    file: 'src/lib/revenueIntelligence.ts',
    name: 'the undeclared-cadence fallback multiplier comes back',
    from: '  const c = declaredCadence(cadence)\n  return c ? SEASON_VISITS[c] : null',
    to: '  const c = declaredCadence(cadence)\n  return c ? SEASON_VISITS[c] : SEASON_VISITS.biweekly',
  },
  {
    file: 'src/lib/revenueIntelligence.ts',
    name: 'an add-on is annualized 4x by a regex on its name',
    from: '        const expected = best.typical',
    to: '        const appsPerYear = /mow|grass cut|lawn care|fertiliz/i.test(best.label) ? 4 : 1\n        const expected = best.typical * appsPerYear',
  },

  // ── 6. A SINGLE OUTLIER DOMINATES ──────────────────────────────────────────
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'a single outlier dominates (the median becomes a mean)',
    from: '  return Math.round(median(usable) as number)',
    to: '  return Math.round(usable.reduce((a, b) => a + b, 0) / usable.length)',
  },
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'the skew caveat is withheld from the owner',
    from: '  return `one visit is ${Math.round(max / m)}× the typical ${Math.round(m)}`',
    to: '  return null',
  },

  // ── 7. INSUFFICIENT EVIDENCE STILL SHOWS A DOLLAR VALUE ────────────────────
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'insufficient evidence still shows a dollar value',
    from: '  return e.strength !== \'insufficient\' && e.annual != null && e.annual > 0',
    to: '  return e.annual != null',
  },
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'an insufficient sample silently returns a figure anyway',
    from: '  if (sampleSize < MIN_VISITS_FOR_VALUE || perVisit == null) {',
    to: '  if (false) {',
  },
  {
    file: 'src/app/dashboard/revenue-intelligence/page.tsx',
    name: 'the UI prints a confident +$0/yr instead of the sentence',
    from: '        {o.expectedValue > 0 ? (',
    to: '        {true ? (',
  },

  // ── 8. THE FORMULA / EVIDENCE IS HIDDEN ────────────────────────────────────
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'the annualization formula is hidden',
    from: '      formula: `$${Math.round(perVisit)} × ${visitsPerSeason} ${label} visits`,',
    to: "      formula: '',",
  },
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'exclusions are no longer disclosed',
    from: "  if (dropped) parts.push(`${dropped} excluded (${e.excluded.map(x => `${x.count} ${EXCLUSION_COPY[x.reason]}`).join(', ')})`)",
    to: '  if (false) parts.push(String(dropped))',
  },
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'the sample size is no longer stated',
    from: "  const parts: string[] = [`${e.sampleSize} visit${e.sampleSize === 1 ? '' : 's'}`]",
    to: '  const parts: string[] = []',
  },
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'the statistic is left unnamed, so "average" is assumed',
    from: "    statistic: 'median visit value',",
    to: '    statistic: null,',
  },
  {
    file: 'src/app/dashboard/revenue-intelligence/page.tsx',
    name: 'the evidence block is removed from the Why? panel',
    from: '            <p className="text-[11px] text-ink-muted">{evidenceSummary(o.evidence)}</p>',
    to: '            <p className="text-[11px] text-ink-muted" />',
  },

  // ── Beyond the brief: the headline must stay honest ────────────────────────
  {
    file: 'src/lib/revenueIntelligence.ts',
    name: 'the headline stops saying how much of the book it speaks for',
    from: '    if (o.expectedValue > 0) quantified++; else unquantified++',
    to: '    quantified++',
  },
  {
    file: 'src/lib/revenueIntelligence.ts',
    name: 'an unquantified recommendation headlines a revenue screen',
    from: '      topAction: ranked.find(o => o.expectedValue > 0) || null,',
    to: '      topAction: ranked[0] || null,',
  },
]

let caught = 0
let missed = 0
const skipped = []

// ⚠️⚠️ CRLF DISARMS A MULTI-LINE ANCHOR. These files are checked out with CRLF on
// Windows while the anchors above are written with \n, so an exact includes()
// misses any anchor spanning more than one line and reports SKIP — which reads
// like a stale anchor and is really a mutation that silently stopped running.
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
    execSync('npm run verify:growth-quality', { stdio: 'pipe' })
  } catch {
    red = true
  } finally {
    writeFileSync(m.file, original)
  }
  if (red) { caught++; console.log(`✓ CAUGHT  ${m.name}`) }
  else { missed++; console.log(`✗ MISSED  ${m.name}\n         the guard passed with this bug in place`) }
}

const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim()
console.log(`\n${caught} caught · ${missed} missed · ${skipped.length} skipped`)
console.log(dirty ? `\n⚠️  TREE NOT RESTORED:\n${dirty}` : '\n✓ tree restored byte-for-byte')
process.exit(missed === 0 && skipped.length === 0 && !dirty ? 0 : 1)
