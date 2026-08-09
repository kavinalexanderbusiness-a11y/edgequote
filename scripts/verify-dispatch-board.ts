// ── Verify: the dispatch board stays legible, notes stay visible, writes stay honest ─
//   npm run verify:dispatch-board
//
// WHY THIS SCRIPT EXISTS
// The 2026-08-09 dispatch UX pass fixed three classes of operational friction,
// all of them the kind tsc and next build cannot see because every wrong answer
// is valid JSX:
//
//  1. LEGIBILITY AT REAL WIDTHS. Three lane columns at xl (1280px — the modal
//     laptop) left ~30px for the customer NAME on an in-progress row: every
//     fixed control kept its width and the one flexible element absorbed the
//     squeeze. Three-across now waits for 2xl. The duplicate per-lane stats line
//     (its facts were already in the capacity meter above it and the timeline
//     below it) is gone, and an EMPTY day-note box no longer costs ~70px of
//     first-paint chrome.
//
//  2. NOTES WHERE EYES ARE. job.notes was loaded (select *) and rendered
//     NOWHERE on the board — gate codes lived a modal away from the dispatcher
//     radioing them out. The crew note rendered only BELOW every stop row. Both
//     now surface at the top of their card/row, read-only, from SAVED bodies.
//
//  3. HONEST WRITES. Every `undo:` option callback (a shape verify:undo-contract's
//     `.undo(` scan cannot see) must branch on its write's outcome; the Best-order
//     apply re-checks lane membership AFTER its awaits so a job moved mid-optimize
//     can't be stamped with a foreign lane's route_order; the Escape put-back is
//     silent (a cancellation must not toast "→ crew · Undo" — an undo offering to
//     undo itself).
//
// Structural over source, in the style of verify-crew-sync — these are single-file
// invariants of page.tsx, checked as text because no runtime sees them.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))

const PAGE = readFileSync(join(process.cwd(), 'src/app/dashboard/dispatch/page.tsx'), 'utf8')

// ── 1. Legibility ────────────────────────────────────────────────────────────
console.log('\nThe board stays legible at the widths owners actually use:')
{
  check('three lane columns wait for 2xl (~400px lanes)',
    /lg:grid-cols-2 2xl:grid-cols-3/.test(PAGE),
    'the lanes grid must be lg:grid-cols-2 2xl:grid-cols-3')
  check('…and xl:grid-cols-3 does not come back',
    !/xl:grid-cols-3/.test(PAGE.replace(/2xl:grid-cols-3/g, '')),
    'xl three-across leaves ~30px for the customer name on an in-progress row at 1280px')
  check('the lane jumper serves every stacked width, not just phones',
    /aria-label="Jump to crew" className="lg:hidden/.test(PAGE),
    'lanes stack single-column below lg; the jumper must be lg:hidden, not sm:hidden')
  check('the duplicate route-stats line stays deleted',
    !/On-site \{Math\.round\(stats\.workMin/.test(PAGE),
    'work/drive/day-used are already in the capacity meter and the RouteTimeline — a third statement costs ~44px per lane')
  check('done-count lives in the lane header instead',
    /`\$\{doneCount\}\/\$\{seq\.length\} done`/.test(PAGE),
    'the stats line\'s one non-duplicate fact (N/M done) must survive in the header')
  check('an empty day note collapses to one line',
    /dayNoteOpen \|\| dayNote\?\.body \?/.test(PAGE) && /Add a day note/.test(PAGE),
    'an empty NoteBox is ~70px of chrome on every day with nothing to say')
  check('…and the opened state is session-sticky',
    /const \[dayNoteOpen, setDayNoteOpen\] = useState\(false\)/.test(PAGE),
    'keying visibility purely on dayNote?.body would collapse the box the moment the owner clears the text mid-edit')
  check('the wraps chip yields to the crew name on phones',
    /hidden sm:inline">wraps ~/.test(PAGE),
    'the shrink-0 wraps chip was what squeezed the crew NAME to a few characters at 375px; the finish time survives in the RouteTimeline')
}

// ── 2. Notes where eyes are ──────────────────────────────────────────────────
console.log('\nAccess notes surface where the dispatcher is looking:')
{
  check('job.notes renders on the stop row',
    /\{job\.notes\?\.trim\(\) && \(/.test(PAGE),
    'job.notes is loaded by select * and previously rendered NOWHERE on the board — the gate code lived one modal away')
  check('…with the full text one hover away',
    /title=\{job\.notes\.trim\(\)\}/.test(PAGE),
    'line-clamp needs the title fallback or a long access note is unreadable')
  check('the crew note surfaces under the lane header',
    /note\?\.body\?\.trim\(\) && \(/.test(PAGE),
    'the editable NoteBox sits below every stop; on a long lane the note the dispatcher most needs was reliably below the fold')
  check('…reading the SAVED body, never the NoteBox draft',
    !/draft/.test(PAGE.split('note?.body?.trim()')[1]?.split('Capacity meter')[0] ?? ''),
    'the strip must read the persisted note only — reaching into NoteBox state would tangle with the awaited-save contract')
  check('NoteBox grows with the note instead of clipping at two rows',
    /rows=\{Math\.min\(4,/.test(PAGE),
    'gate codes run several lines; a resize-none 2-row textarea silently hides line three of the only reading surface these notes have')
  check('a blocked day offers the reschedule door on the banner',
    /Reschedule the day/.test(PAGE),
    'the banner said "needs a new day" and offered no way to do it — the only path was three undiscoverable steps deep in the bulk bar')
  check('in-progress rows show time on site, not a stale planned ETA',
    /on site \{Math\.max\(1, Math\.round\(\(Date\.now\(\) - new Date\(job\.started_at/.test(PAGE),
    'a checked-in crew has no future arrival; the planned ETA is moot the moment they are on site')
  check('…gated to today\'s board',
    /job\.status === 'in_progress' && job\.started_at && nowMin != null/.test(PAGE),
    'on a past day a leftover in_progress row would render a huge stale figure that never ticks')
}

// ── 3. Honest writes ─────────────────────────────────────────────────────────
console.log('\nEvery write the board makes reports its outcome:')
{
  // Every `undo:` option callback must branch on its write — the option shape
  // is invisible to verify:undo-contract's `.undo(` scan, which is exactly how
  // six of them shipped unchecked.
  const undoBodies: string[] = []
  const re = /undo:\s*async\s*\(\)\s*=>\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(PAGE))) {
    let depth = 0, i = m.index + m[0].length - 1
    for (; i < PAGE.length; i++) {
      if (PAGE[i] === '{') depth++
      else if (PAGE[i] === '}') { depth--; if (depth === 0) break }
    }
    undoBodies.push(PAGE.slice(m.index, i + 1))
  }
  check(`the scan finds the undo callbacks (${undoBodies.length} ≥ 6)`,
    undoBodies.length >= 6,
    'fewer than six undo: callbacks found — the pattern or the page moved; fix the scan, not the count')
  undoBodies.forEach((body, i) => {
    check(`undo callback #${i + 1} branches on its write`,
      /\berror\b/.test(body) || /\bcatch\b/.test(body),
      'a persisting undo must read the write\'s error (or catch) and tell the owner when the put-back did not happen')
  })

  check('Best order re-checks lane membership after its awaits',
    /nowInLane/.test(PAGE) && /\.filter\(id => nowInLane\.has\(id\)\)/.test(PAGE),
    'the pre-await snapshot can contain a job moved to another crew mid-optimize; applyLaneOrder\'s per-id writes carry no lane guard, so the stale write would stamp a foreign lane\'s route_order')
  check('the Escape put-back is silent',
    /moveJob\(job\.id, g\.homeCrewId, null, \{ silent: true \}\)/.test(PAGE),
    'a cancellation must not toast "→ crew · Undo" — that is an undo offering to undo itself')
  const silentUses = (PAGE.match(/\{ silent: true \}/g) || []).length
  check('…and silent is used ONLY there',
    silentUses === 1,
    `found ${silentUses} silent moves — every real move (drag, arrows, menu) must stay loud with its undo`)
}

if (failures) {
  console.log(`\n❌ verify:dispatch-board — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:dispatch-board — legible lanes, visible notes, honest writes\n')
