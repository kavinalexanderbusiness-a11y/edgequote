/* eslint-disable no-console */
// Verification of the business-shape derivation — what a business DOES, inferred
// from rows it already has. Imports the real production functions; nothing is
// reimplemented here.
//
// WHY THIS IS A SIBLING OF verify-automations.ts RATHER THAN A SECTION IN IT
// Three reasons, in order of weight:
//  1. That harness's headline is "PASS 244 / FAIL 0", and that number is the
//     acceptance signal for the automation engine's promotion story. Folding
//     unrelated checks into it moves the number for reasons that have nothing to
//     do with automations, and the next person to read "PASS 251" can't tell
//     whether the engine's coverage changed.
//  2. It opens "End-to-end verification of the two automatic chasers' DECISION
//     logic." Business shape is a UI gate. A red `verify:automations` caused by a
//     lawn field would send the reader to the wrong engine.
//  3. Its section 26 walks the cron engine's import closure and pins it EXACTLY.
//     That check is rooted at the engine's route, not at the harness file, so
//     adding imports here would not actually break it today — but keeping this
//     file's imports out of that file keeps it that way by construction.
//
// It is wired into package.json AND .github/workflows/ci.yml in the same commit.
// This repo has already shipped a harness with 234 checks wired to nothing; a
// guard rail nobody runs is not a guard rail, and a sibling script is only the
// right call if it actually runs.
import { deriveBusinessShape, showLawnFieldFor, SHAPE_LOADING, type ShapeEvidence } from '@/lib/businessShape'

let pass = 0, fail = 0
const fails: string[] = []
function check(group: string, name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(`${group} › ${name}`); console.log(`  ❌ ${name}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`) }
}
const H = (s: string) => console.log(`\n═══ ${s} ═══`)

// Evidence builders — named for the BUSINESS, so a failure reads as a sentence.
const ev = (e: Partial<ShapeEvidence>): ShapeEvidence =>
  ({ serviceTemplates: [], jobServiceTypes: [], ...e })

const tpl = (...names: string[]) => names.map(name => ({ name, category: null }))

function run() {
  console.log('\n  BUSINESS SHAPE — inferred, never asked\n' + '═'.repeat(60))

  // ═══════════════════════════════════════════════════════════════════════════
  H('1. BACKWARDS COMPATIBILITY — the four acceptance cases')
  // These four are the whole contract. Everything else in this file exists to
  // stop one of them regressing by accident.

  // CASE 1 — a lawn business. Templates, jobs and measured properties all say
  // lawn. Must be indistinguishable from the app before businessShape existed.
  {
    const lawnCo = ev({
      serviceTemplates: tpl('Weekly Mowing', 'Spring Aeration', 'Fertilization'),
      jobServiceTypes: ['Lawn Mowing', 'Lawn Mowing', 'Fertilizing'],
    })
    check('case-1', 'a lawn business shows lawn fields', deriveBusinessShape(lawnCo).showLawnFields, true)
    check('case-1', '➜ and it has evidence (not defaulting — actually detected)', deriveBusinessShape(lawnCo).hasEvidence, true)
  }

  // CASE 2 — a brand-new account. No templates, no jobs, nothing to infer from.
  // MUST show everything: this is the core market on day one, and hiding the
  // measure tool from a new lawn signup is the single worst outcome here.
  {
    const brandNew = ev({})
    check('case-2', 'a brand-new empty account shows lawn fields', deriveBusinessShape(brandNew).showLawnFields, true)
    check('case-2', '➜ …because there is NO evidence, not because it found lawn', deriveBusinessShape(brandNew).hasEvidence, false)
  }

  // CASE 3 — a plumber. A real catalogue, real jobs, no lawn anywhere.
  {
    const plumber = ev({
      serviceTemplates: tpl('Drain cleaning', 'Water heater install', 'Leak repair'),
      jobServiceTypes: ['Drain cleaning', 'Water heater install'],
    })
    check('case-3', 'a plumber does NOT show lawn fields', deriveBusinessShape(plumber).showLawnFields, false)
    check('case-3', '➜ and that is a finding, not a default (hasEvidence)', deriveBusinessShape(plumber).hasEvidence, true)

    // CASE 4 — the same plumber, who happens to have one property measured at
    // 5,000 ft². The ACCOUNT is still not a lawn business…
    check('case-4', 'one measured property does not re-shape the whole account',
      deriveBusinessShape(plumber).showLawnFields, false)
    // …but THAT property still renders its lawn size. Hiding a number someone can
    // remember entering reads as data loss.
    const shape = deriveBusinessShape(plumber)
    check('case-4', '➜ the measured property still renders its 5,000 ft²', showLawnFieldFor(shape, 5000), true)
    check('case-4', '➜ …while his unmeasured properties stay clean', showLawnFieldFor(shape, null), false)
    check('case-4', '➜ …and 0 is not data (an empty field is not a measurement)', showLawnFieldFor(shape, 0), false)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  H('2. THE OVERRIDE NEVER FIGHTS THE FLAG')
  {
    const lawnShape = deriveBusinessShape(ev({ jobServiceTypes: ['Lawn Mowing'] }))
    // A lawn business sees the field whether or not this property is measured —
    // this is what makes case 1 "identical to today": the gate is a no-op for them.
    check('override', 'a lawn business sees the field on an unmeasured property', showLawnFieldFor(lawnShape, null), true)
    check('override', '➜ and on a zero one (today\'s behaviour, preserved)', showLawnFieldFor(lawnShape, 0), true)
    check('override', '➜ and on a measured one', showLawnFieldFor(lawnShape, 5000), true)
    check('override', 'the loading placeholder shows everything (no field blinks out mid-load)',
      [SHAPE_LOADING.showLawnFields, showLawnFieldFor(SHAPE_LOADING, null)], [true, true])
  }

  // ═══════════════════════════════════════════════════════════════════════════
  H('3. EVIDENCE SOURCES — each one alone is enough')
  // Every source is an independent net. Any ONE of them firing keeps a lawn
  // business whole, which is why a miss in one place is not a regression.
  {
    check('sources', 'a lawn TEMPLATE name alone is enough',
      deriveBusinessShape(ev({ serviceTemplates: tpl('Weekly Mowing'), jobServiceTypes: ['Consultation'] })).showLawnFields, true)
    check('sources', 'a lawn template CATEGORY alone is enough (name says nothing)',
      deriveBusinessShape(ev({ serviceTemplates: [{ name: 'Weekly Visit', category: 'Lawn Care' }] })).showLawnFields, true)
    check('sources', 'a lawn JOB alone is enough (catalogue never set up)',
      deriveBusinessShape(ev({ jobServiceTypes: ['Lawn Mowing'] })).showLawnFields, true)
    // JobForm defaults service_type to 'Lawn Mowing', so in practice essentially
    // every lawn account in existence trips this net on its first job.
    check('sources', "➜ JobForm's 'Lawn Mowing' default trips the job net on job #1",
      deriveBusinessShape(ev({ jobServiceTypes: ['Lawn Mowing'] })).showLawnFields, true)
    check('sources', 'one lawn job among many non-lawn ones is still evidence',
      deriveBusinessShape(ev({ jobServiceTypes: ['Service Call', 'Repair', 'Lawn Mowing', 'Repair'] })).showLawnFields, true)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  H('4. THE MATCHER IS BORROWED, NOT REBUILT (lib/seasons serviceCategory)')
  // f760a3a fixed 'ice' matching inside serv·ice, which classified "Lawn Service"
  // as SNOW and sent those customers dormant all summer. This module classifies
  // nothing itself; these cases prove it inherited the fix rather than re-typing
  // the bug. If someone writes a second matcher here, these are what go red.
  {
    check('matcher', '"Lawn Service" is lawn, not snow (the f760a3a bug)',
      deriveBusinessShape(ev({ jobServiceTypes: ['Lawn Service'] })).showLawnFields, true)
    check('matcher', '"Full Service Mowing" is lawn',
      deriveBusinessShape(ev({ serviceTemplates: tpl('Full Service Mowing') })).showLawnFields, true)
    check('matcher', '"Weekly Service" alone is NOT lawn evidence (year_round)',
      deriveBusinessShape(ev({ jobServiceTypes: ['Weekly Service'] })).showLawnFields, false)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  H('5. THE OTHER TRADES')
  {
    const trades: [string, string[]][] = [
      ['HVAC', ['Furnace tune-up', 'AC install', 'Duct cleaning']],
      ['cleaning', ['Deep clean', 'Move-out clean', 'Office cleaning']],
      ['electrical', ['Panel upgrade', 'Outlet install', 'Lighting retrofit']],
      ['pest control', ['Wasp nest removal', 'Rodent exclusion', 'Quarterly spray']],
      ['roofing', ['Shingle replacement', 'Roof inspection', 'Flashing repair']],
      ['painting', ['Interior repaint', 'Exterior repaint', 'Cabinet refinish']],
      ['junk removal', ['Garage cleanout', 'Furniture haul', 'Estate cleanout']],
      ['pool service', ['Pool opening', 'Weekly chemical check', 'Filter clean']],
      ['handyman', ['Drywall patch', 'Door adjustment', 'Shelf install']],
    ]
    for (const [trade, services] of trades) {
      check('trades', `a ${trade} business does not show lawn fields`,
        deriveBusinessShape(ev({ serviceTemplates: tpl(...services), jobServiceTypes: services })).showLawnFields, false)
    }
    // A snow-only operator measures driveways, not lawns. serviceCategory tests
    // snow BEFORE lawn, so this also pins that ordering staying intact.
    check('trades', 'a snow-only operator does not show lawn fields',
      deriveBusinessShape(ev({ serviceTemplates: tpl('Snow Removal', 'Ice Melt', 'Plowing') })).showLawnFields, false)
    // …but the moment they add mowing for the summer, the shape follows. No
    // stored type to go stale, no setting for anyone to remember to change.
    check('trades', '➜ the day they add mowing, lawn fields come back on their own',
      deriveBusinessShape(ev({ serviceTemplates: tpl('Snow Removal', 'Weekly Mowing') })).showLawnFields, true)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  H('6. ABSENCE OF EVIDENCE IS NOT EVIDENCE OF ABSENCE')
  // The clause the whole design rests on. Each of these is an account with
  // nothing to infer from, and each must look exactly like the app does today.
  {
    check('absence', 'no templates + no jobs → show (not hide)',
      deriveBusinessShape(ev({})).showLawnFields, true)
    check('absence', 'a catalogue of empty names is not a plumber',
      deriveBusinessShape(ev({ serviceTemplates: [{ name: '', category: '' }] })).showLawnFields, true)
    check('absence', 'null service_types are not evidence of anything',
      deriveBusinessShape(ev({ jobServiceTypes: [null, null] })).showLawnFields, true)
    // The distinction the flag exists to carry: same answer, opposite reasons.
    check('absence', 'hasEvidence separates "found no lawn" from "found nothing"',
      [deriveBusinessShape(ev({})).hasEvidence,
       deriveBusinessShape(ev({ serviceTemplates: tpl('Drain cleaning') })).hasEvidence], [false, true])
  }

  // ═══════════════════════════════════════════════════════════════════════════
  H('7. NO business_type DEPENDENCY — the property, not the promise')
  // The owner's hard constraint: nothing stored, nothing asked, no industry type.
  // A comment saying so is worth nothing; assert it against the real source.
  {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { resolve } = require('node:path') as typeof import('node:path')
    const SRC = readFileSync(resolve(process.cwd(), 'src/lib/businessShape.ts'), 'utf8')
    // Strip comments first — this module's own prose says "business_type" while
    // explaining that there isn't one. A check that can't tell code from
    // commentary fails on the sentence documenting the property it's proving.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/gm, '$1')

    check('no-type', 'the engine never reads a business_type column', /business_type/.test(code), false)
    check('no-type', 'it declares no industry type or enum', /type\s+BusinessType|enum\s+BusinessType/.test(code), false)
    // The subtler version of the same mistake: a flag named for an industry is an
    // industry type with extra steps. Flags must be named for what they GATE.
    //
    // What this must NOT catch is `serviceCategory(s) === 'lawn'`, which is the
    // whole point of the module — that reads the BORROWED matcher's category of a
    // service NAME. Comparing a string to a season category is not the same act as
    // comparing a BUSINESS to an industry, and the first draft of this check
    // couldn't tell them apart. So look for the shape/type being compared, not for
    // the word 'lawn'.
    check('no-type', "no business is compared to a trade (shape === 'lawn', businessType…)",
      /\bshape\s*===|\bBusinessShape\s*===|businessType|isLawnBusiness|isPlumber/.test(code), false)
    // NOTHING is written. This feature needs no migration; the day it writes a row
    // it has become the stored type it was built to avoid.
    check('no-type', 'it writes nothing — no insert/update/upsert/delete',
      /\.(insert|update|upsert|delete)\s*\(/.test(code), false)
    check('no-type', '➜ and it reads only the two evidence tables it documents',
      [...code.matchAll(/\.from\(\s*'([^']+)'\s*\)/g)].map(m => m[1]).sort(), ['jobs', 'service_templates'])
    // The matcher lives in ONE place. A hint list appearing here is the second
    // matcher the brief forbids — and the exact shape of the 'ice'/serv·ice bug,
    // which took a whole mowing season to notice. Both halves are asserted: no
    // hints of its own, AND it actually imports the real one.
    check('no-type', 'it re-lists no service-name hints of its own',
      /'mow'|'fertiliz'|'aerat'|'grass'|LAWN_HINTS|SNOW_HINTS/.test(code), false)
    check('no-type', '➜ because it imports serviceCategory from lib/seasons',
      /import\s*\{[^}]*\bserviceCategory\b[^}]*\}\s*from\s*'@\/lib\/seasons'/.test(code), true)
  }

  console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
  if (fails.length) { console.log('\n  FAILURES:'); fails.forEach(f => console.log('   • ' + f)) }
  process.exit(fail ? 1 : 0)
}
run()
