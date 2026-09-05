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
  // ⚠️ RETARGETED (Session 114). Two mutations here used to break Growth's own
  // `FIXTURE_MARKERS` list. That list is gone — Growth delegates to
  // lib/fixtureData — so those patterns would now match nothing and report as
  // no-ops, which reads as "survived" and looks like a guard hole. They aim at
  // the canonical rule instead, testing the SAME two failure modes.
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'fixture included (Growth stops asking the canonical rule)',
    from: '  return isAnyFixtureName(...texts)',
    to: '  return false',
  },
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'fixture records counted even though flagged',
    from: "    if (looksLikeFixture(...(v.labels ?? []))) { drop('fixture'); continue }",
    to: "    if (false) { drop('fixture'); continue }",
  },
  // ⛔ The mirror-image failure: over-broad exclusion is as much a trust breach
  // as contamination. A real business called "Test Valley Landscaping" must keep
  // its revenue — and, since the convergence, so must "Light Fixture
  // Installation" and "S61 Roofing Ltd".
  {
    file: 'src/lib/fixtureData.ts',
    name: 'the conjunction collapses to a single keyword (eats a real electrician)',
    from: '  if (SELF_IDENTIFYING.some(r => n.includes(r.needs) && n.includes(r.and))) return true',
    to: '  if (SELF_IDENTIFYING.some(r => n.includes(r.needs) || n.includes(r.and))) return true',
  },
  // ⚠️ RE-TARGETED (Session 114 follow-up audit). The three mutations that used
  // to live here targeted the ORIGINAL `{ shape, alsoSays }` HARNESS_SHAPES
  // structure. The audit found that structure over-broad in exactly the way one
  // of these mutations warns about ("eats a real roofer") — the `alsoSays`
  // check used `n.includes('fixture')`, a WHOLE-STRING search, so a zz-prefixed
  // name that merely mentioned "fixture" LATER in the name (not beside the
  // zz-token) was already excluded even before any mutation ran. That is a
  // defect the guard's own MUST_SURVIVE list did not catch, because nothing in
  // it exercised "fixture" positioned away from the zz-token specifically.
  //
  // The fix bakes "fixture" into the regex at the position a machine actually
  // puts it and deletes the unfounded bare `s\d{1,3}[-_]fixture` shape entirely
  // (no harness anywhere emits that string — see lib/fixtureData's comment).
  // These two mutations now test the NEW rule's own two failure directions:
  // losing the anchor, and losing the fixture requirement.
  {
    file: 'src/lib/fixtureData.ts',
    name: 'the harness shape stops requiring "fixture" to sit beside the zz-token (the exact over-broad defect the audit found, reintroduced)',
    from: '  /^zz[\\s\\-_](?:s\\d{1,4}[\\s\\-_])?fixture\\b/i,',
    to: '  /^zz[\\s\\-_]/i,',
  },
  {
    file: 'src/lib/fixtureData.ts',
    name: 'the zz shape stops being anchored at the start (Deck ZZ Fixture Mural becomes a fixture)',
    from: '  /^zz[\\s\\-_](?:s\\d{1,4}[\\s\\-_])?fixture\\b/i,',
    to: '  /zz[\\s\\-_](?:s\\d{1,4}[\\s\\-_])?fixture\\b/i,',
  },
  {
    file: 'src/lib/fixtureData.ts',
    name: 'the whole HARNESS_SHAPES check evaporates (a real emitted quote fixture, "ZZ S111 Fixture A", escapes Tier 1)',
    from: '  if (HARNESS_SHAPES.some(r => r.test(n))) return true',
    to: '  if (false) return true',
  },
  {
    file: 'src/lib/fixtureData.ts',
    name: 'reserved-domain matching widens to any address containing "example"',
    from: "const RESERVED_EMAIL_DOMAINS = /@(example\\.(com|org|net)|.*\\.(invalid|test|localhost))$/i",
    to: "const RESERVED_EMAIL_DOMAINS = /example/i",
  },

  // ── 2. UNKNOWN PRICE INCLUDED ──────────────────────────────────────────────
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'unknown price included (unpriced work counted as evidence)',
    from: "  if (s === 'unpriced') return 'unpriced'",
    to: '  if (false) return null',
  },
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'a null amount is coerced into the sample as zero',
    from: "    if (v.amount == null || !(v.amount > 0)) { drop('unpriced'); continue }\n    values.push(v.amount)",
    to: '    values.push(Number(v.amount) || 0)',
  },
  // ── 3. A DECLARED NO-CHARGE TREATED AS A REAL PRICE ────────────────────────
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'no-charge counted as a real price (free work sets the statistic)',
    from: "  if (s === 'no_charge') return 'no_charge'",
    to: '  if (false) return null',
  },
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'unpriced and no-charge collapse into one indistinguishable reason',
    from: '    const excludeAs = exclusionForPriceState(v.priceState)\n    if (excludeAs) { drop(excludeAs); continue }',
    to: "    const excludeAs = exclusionForPriceState(v.priceState)\n    if (excludeAs) { drop('unpriced'); continue }",
  },
  // ⛔ THE SEAM ITSELF: growthEvidence must not start deciding price state again.
  {
    file: 'src/lib/revenueIntelligence.ts',
    name: 'the engine stops feeding the canonical verdict and infers one',
    from: '          priceState: jobPriceState(j, quote, freq),\n          amount: jobAmountOrNull(j, quote, freq),',
    to: "          priceState: (Number(j.price) > 0 ? 'priced' : 'unpriced'),\n          amount: Number(j.price) || null,",
  },
  {
    file: 'src/lib/revenueIntelligence.ts',
    name: 'the no_charge columns stop being selected, so a write-off reads as sloppy bookkeeping',
    from: 'no_charge_at, no_charge_reason, no_charge_by, ',
    to: '',
  },

  // ── 4. ONE-OFF WORK ANNUALIZED ─────────────────────────────────────────────
  {
    file: 'src/lib/growthEvidence.ts',
    name: 'one-off annualized (the minimum sample drops to two — where a median IS a mean)',
    from: 'export const MIN_VISITS_FOR_VALUE = 3',
    to: 'export const MIN_VISITS_FOR_VALUE = 2',
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
    // ⭐ BOTH guards, since Session 114 (the convergence). The fixture rule now
    // lives in lib/fixtureData and Growth delegates to it, so a break in that one
    // rule is a break in two features: Growth's exclusions AND the hygiene tiers.
    // Running only Growth's guard would let a mutation that hides a real
    // electrician's service pass, as long as Growth's own cases happened to miss
    // it. Either going red is a catch — that is what a shared engine means.
    execSync('npm run verify:growth-quality', { stdio: 'pipe' })
    execSync('npm run verify:production-hygiene', { stdio: 'pipe' })
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
