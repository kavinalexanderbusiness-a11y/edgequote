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
import { nudgeAcrossVisible } from '../src/lib/dispatchOps'

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
  // The put-back target became an Assignee when a visit gained the option of
  // belonging to one person (Session 65). The rule it protects is unchanged:
  // cancelling a keyboard grab restores where the visit WAS, without a toast.
  check('the Escape put-back is silent',
    /moveJob\(job\.id, g\.homeAssignee, null, \{ silent: true \}\)/.test(PAGE),
    'a cancellation must not toast "→ crew · Undo" — that is an undo offering to undo itself')
  const silentUses = (PAGE.match(/\{ silent: true \}/g) || []).length
  check('…and silent is used ONLY there',
    silentUses === 1,
    `found ${silentUses} silent moves — every real move (drag, arrows, menu) must stay loud with its undo`)
}

// ── 4. A nudge moves against what the owner can SEE ──────────────────────────
// The chevrons used to swap full-sequence neighbours; with a status filter on,
// that could exchange a stop with a HIDDEN row — a persisted route_order change
// the board rendered as nothing happening. nudgeAcrossVisible hops the adjacent
// VISIBLE neighbour instead, and returns null exactly when the chevron disables.
console.log('\nNudges hop the visible neighbour, never a hidden one:')
{
  const eq = (name: string, actual: unknown, expected: unknown) =>
    check(name, JSON.stringify(actual) === JSON.stringify(expected),
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

  // No filter: visible == full → identical to the old adjacent swap.
  eq('with no filter, a nudge is the old adjacent swap',
    nudgeAcrossVisible(['a', 'b', 'c'], ['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c'])
  eq('…in both directions',
    nudgeAcrossVisible(['a', 'b', 'c'], ['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b'])

  // THE bug: b(hidden completed) sits between a and c. Nudging c earlier must
  // hop the visible 'a' — not swap with the invisible 'b' and look like a no-op.
  eq('a nudge hops the visible neighbour past hidden rows',
    nudgeAcrossVisible(['a', 'b', 'c'], ['a', 'c'], 'c', -1), ['c', 'a', 'b'])
  eq('…and later works symmetrically',
    nudgeAcrossVisible(['a', 'b', 'c'], ['a', 'c'], 'a', 1), ['b', 'c', 'a'])

  // Null exactly at the visible edges — the chevrons' disabled state, so button
  // and write can never disagree.
  eq('no visible neighbour earlier → null (chevron disabled)',
    nudgeAcrossVisible(['a', 'b', 'c'], ['a', 'c'], 'a', -1), null)
  eq('no visible neighbour later → null',
    nudgeAcrossVisible(['a', 'b', 'c'], ['a', 'c'], 'c', 1), null)
  eq('a hidden job itself can never be nudged',
    nudgeAcrossVisible(['a', 'b', 'c'], ['a', 'c'], 'b', 1), null)
  eq('an unchanged order returns null, not a redundant write',
    nudgeAcrossVisible(['a'], ['a'], 'a', 1), null)

  check('the page nudges through the helper',
    /nudgeAcrossVisible\(/.test(PAGE) && !/\[next\[i\], next\[target\]\] = \[next\[target\], next\[i\]\]/.test(PAGE),
    'nudgeJob must call lib/dispatchOps.nudgeAcrossVisible — the inline full-seq swap is the bug this section exists to keep out')
  check('the chevrons disable on the VISIBLE index',
    /disabled=\{vi === 0\}/.test(PAGE) && /disabled=\{vi === visibleSeq\.length - 1\}/.test(PAGE),
    'disabled must key on visibleSeq, matching what a nudge now does')
}

// ── 5. Running behind is an intervention row, never a plan repair ────────────
console.log('\nRunning behind reaches the intervention list, with no false remedy:')
{
  const OPS = readFileSync(join(process.cwd(), 'src/lib/dispatchOps.ts'), 'utf8')
  check('the running_behind conflict kind exists',
    /\| 'running_behind'/.test(OPS),
    'behind-ness needs its own kind — reusing overrun inherits "Optimize route"')
  check('the fix switch explicitly offers NOTHING for it',
    /case 'running_behind':\s*\n\s*return null/.test(PAGE),
    '"Optimize route" re-sequences the day a crew is already driving and makes nobody less late; the row\'s Jump is the whole offer')
  check('the panel rows reuse the lane chip\'s engine and thresholds',
    /behindMin >= 10/.test(PAGE) && /behindMin >= 30 \? 'error' : 'warn'/.test(PAGE),
    'panel and chip must derive from the same laneProgress output or they will disagree about who is behind')
  check('…and are gated to today',
    /if \(nowMin == null\) return \[\]/.test(PAGE),
    'behind-ness is a live-clock fact; a past day has no "now" to be behind')
}

// ── 6. Move-to carries the room; cancelled visits carry their names ──────────
console.log('\nReassignment is informed and cancellations are named:')
{
  check('the Move-to menu reads the shared spare-minutes map',
    /const spare = crewSpare\[c\.id\]/.test(PAGE),
    'the menu must read laneLoad-derived spare minutes — a bare name list is a blind pick')
  check('…derived from laneLoad, the meters\' own engine',
    /laneLoad\(r\.workMin, r\.capacityMin\)\.spareMin/.test(PAGE),
    'room must come from the same laneLoad the capacity meters draw, never a second computation')
  check('overloaded destinations say so instead of hiding',
    /over by \$\{Math\.abs\(spare\)\}m/.test(PAGE),
    'an over-capacity crew is still a legal destination — the label warns, it does not filter')
  check('cancelled visits are named, not just counted',
    /Cancelled today: \{lane\.jobs\.filter\(j => j\.status === 'cancelled'\)/.test(PAGE),
    'a bare count made "did that cancellation land?" require leaving the board')
}

if (failures) {
  console.log(`\n❌ verify:dispatch-board — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:dispatch-board — legible lanes, visible notes, honest writes\n')
