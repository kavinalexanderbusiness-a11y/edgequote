// ── Verify: the crew's board tells the truth ─────────────────────────────────
//   npm run verify:crew-sync
//
// WHY THIS SCRIPT EXISTS
// EdgeQuote has no employee login (technicians is a RECORD, not an auth principal —
// see the single-crew-architecture note). So "the manager changed the work and the
// crew found out" happens in exactly one place: the dispatch board, open on a phone
// in the truck on the same account, kept current by useRealtimeRefresh. That makes
// the board the coordination contract, and it has three failure modes that neither
// tsc nor `next build` can see — all three shipped at once, and all three look
// IDENTICAL on screen to working software:
//
//   1. A read that failed answering as if it had succeeded. supabase-js RESOLVES on
//      failure ({ error }, no throw), so `const { data } = await …; return data ?? []`
//      turns dead signal into "you have no crews", "nobody works here", and — worst —
//      "there is no note for this crew today", silently erasing the gate code the
//      manager wrote. The board then partitions every visit into "Unassigned".
//   2. A crew-visible input with no realtime subscription. The board RENDERS
//      day_statuses (the "this day is rained out, capacity is zero" banner) and
//      COMPUTES from it, but nothing invalidated it — so a day marked blocked in the
//      office reached the calendar instantly and never reached the truck.
//   3. "Saved" claimed before the write landed. The note box called onSave without
//      awaiting it and flashed a green ✓ in the same tick.
//
// THE CONTRACTS BELOW ARE DELIBERATELY SHALLOW. They cannot judge whether an error
// message is well worded or a refetch is well timed — only that the outcome is
// LOOKED AT, that every crew-visible table is subscribed, and that success is
// claimed after the await rather than before. That is enough to stop the class from
// coming back, and each one costs a line to satisfy honestly.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }

const SRC = join(process.cwd(), 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

const CREWS = read('lib/crews.ts')
const DISPATCH = read('app/dashboard/dispatch/page.tsx')
const RT_HOOK = read('hooks/useRealtime.ts')

/** Body of a top-level `export async function <name>(` … up to the next top-level `}`. */
function fnBody(src: string, name: string): string | null {
  const at = src.indexOf(`export async function ${name}(`)
  if (at < 0) return null
  const open = src.indexOf('{', src.indexOf(')', at))
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1) }
  }
  return null
}

// ── 1. Reader contract: a failed query is not an empty result ────────────────
// Every reader on the crew path must destructure `error` from the query AND branch
// on it. Returning `[]` for a request that never reached Postgres is the single
// defect that made a whole crew's day read as unassigned, and made a pay run read
// as "nobody works here".
console.log('\nReaders surface failure (lib/crews.ts)')
for (const fn of ['loadCrews', 'loadTechnicians', 'loadDispatchNotes']) {
  const body = fnBody(CREWS, fn)
  if (!body) { fail(`${fn} exists`, 'function not found — was it renamed or moved?'); continue }
  const destructures = /\{\s*data\s*,\s*error\s*\}/.test(body)
  const branches = /if\s*\(\s*error\s*\)/.test(body)
  if (destructures && branches) ok(`${fn} checks its query error`)
  else {
    fail(
      `${fn} checks its query error`,
      !destructures
        ? 'destructures only `{ data }` — a failed request returns [] and reads as real emptiness.'
        : 'destructures `error` but never branches on it. Naming it is not checking it.',
    )
  }
  if (/return\s*\(data[^)]*\)\s*\?\?\s*\[\]/.test(body) && !branches) {
    fail(`${fn} does not fabricate an empty answer`, 'falls back to [] with no error branch above it.')
  }
}

// ── 2. Invalidation contract: every crew-visible table is subscribed ─────────
// The board reads these five tables and renders all five. Whichever one loses its
// subscription becomes the stale one, and the crew has no way to tell.
console.log('\nDispatch board subscribes to every table it renders')
const SUBSCRIBED = [...DISPATCH.matchAll(/useRealtimeRefresh\(\s*'([a-z_]+)'/g)].map(m => m[1])
const REQUIRED: Record<string, string> = {
  jobs: 'the work itself — assignment, date, time, status, notes',
  crews: 'lane identity; a deactivated crew must drop its lane live',
  technicians: 'the roster; an archived tech must leave the board live',
  dispatch_notes: "the manager's written instructions for that crew, that day",
  day_statuses: 'the blocked/rained-out banner AND per-crew capacity + start time',
}
for (const [table, why] of Object.entries(REQUIRED)) {
  if (SUBSCRIBED.includes(table)) ok(`subscribes to ${table}`)
  else fail(`subscribes to ${table}`, `${why} — changed by the manager, never seen by the crew.`)
}
// Duplicate subscriptions to one table on one page are pure cost: each opens its own
// channel and fires its own debounce. (They coalesce at execution, so this is a
// leak, not a storm — but it is still a channel per copy.)
const dupes = SUBSCRIBED.filter((t, i) => SUBSCRIBED.indexOf(t) !== i)
if (dupes.length === 0) ok('no duplicate subscriptions on the board')
else fail('no duplicate subscriptions on the board', `subscribed more than once: ${[...new Set(dupes)].join(', ')}`)

// ── 3. The board's own reads are checked too ─────────────────────────────────
// Fixing the shared readers is not enough while the page still ignores the errors
// on the queries it makes inline — day_statuses is the one that matters most,
// because an unchecked failure there silently CLEARS the blocked-day banner.
console.log('\nDispatch board checks the reads it makes itself')
if (/const\s+readErr\s*=[\s\S]{0,200}?dRes\.error/.test(DISPATCH) && /if\s*\(\s*readErr\s*\)/.test(DISPATCH)) {
  ok('day/equipment/settings read errors reach the load banner')
} else {
  fail(
    'day/equipment/settings read errors reach the load banner',
    'fetchAll checks only the jobs query. A failed day_statuses read clears the rained-out banner and the board shows a normal working day.',
  )
}

// ── 4. Honest save: "Saved" means the row was written ───────────────────────
console.log('\nThe crew note box only claims what it can prove')
const noteAt = DISPATCH.indexOf('function NoteBox(')
const note = noteAt >= 0 ? DISPATCH.slice(noteAt) : ''
if (!note) {
  fail('NoteBox exists', 'component not found — was it renamed or extracted?')
} else {
  const awaitAt = note.indexOf('await onSave(')
  const savedAt = note.indexOf("setPhase('saved')")
  if (/onSave:\s*\(body:\s*string\)\s*=>\s*Promise<string\s*\|\s*null>/.test(note)) {
    ok('onSave reports its outcome (Promise<string | null>)')
  } else {
    fail('onSave reports its outcome', 'onSave returns void, so the box cannot know whether the write landed.')
  }
  if (awaitAt >= 0) ok('commit awaits the write')
  else fail('commit awaits the write', 'onSave is fire-and-forget — the ✓ is painted before the row exists.')
  if (awaitAt >= 0 && savedAt > awaitAt) ok("the ✓ is set after the write resolves")
  else fail("the ✓ is set after the write resolves", "setPhase('saved') runs before/without awaiting onSave.")
  // Losing the baseline on failure is what makes the retry real: leave lastSaved
  // behind and the next blur re-sends; advance it and the text is orphaned in a
  // textarea that claims it is saved.
  if (/if\s*\(err\)\s*\{\s*setPhase\('error'\);\s*return\s*\}/.test(note)) {
    ok('a failed save does not advance the saved baseline')
  } else {
    fail('a failed save does not advance the saved baseline', 'no early return on error before `lastSaved.current = text`.')
  }
}

// ── 5. The shared hook still self-heals ─────────────────────────────────────
// postgres_changes are NOT replayed after a dropped socket or a backgrounded tab —
// precisely the two things a phone in a truck does all day. Without these listeners
// every fix above is still one tunnel away from silently stale.
console.log('\nRealtime self-heals after a gap')
for (const [evt, why] of [
  ["'online'", 'reconnect after dead signal'],
  ["'visibilitychange'", 'the tab coming back to the foreground'],
] as const) {
  if (RT_HOOK.includes(`addEventListener(${evt}`)) ok(`refetches on ${evt} (${why})`)
  else fail(`refetches on ${evt}`, `missed rows during ${why} are never recovered.`)
}

// ── 6. Lifecycle behaviour over the real engines ────────────────────────────
// The pure partition/sequence functions the board renders from, exercised with the
// actual manager actions this lane is about.
console.log('\nManager actions land in the right lane')
async function behaviour() {
  const { partitionByCrew, laneSequence, laneWorkMinutes, crewCapacityMinutes, UNASSIGNED_ID } =
    await import('../src/lib/crews')

  type AnyJob = Record<string, unknown>
  const job = (id: string, over: AnyJob = {}): AnyJob => ({
    id, title: id, status: 'scheduled', crew_id: null, route_order: null,
    duration_minutes: 60, created_at: '2026-08-07T00:00:00Z', ...over,
  })
  const crew = (id: string, over: AnyJob = {}): AnyJob => ({
    id, name: id, color: 'emerald', is_active: true, sort_order: 0,
    capacity_minutes: null, day_start: null, day_end: null, ...over,
  })
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const lanesOf = (jobs: AnyJob[], crews: AnyJob[]) => partitionByCrew(jobs as any, crews as any)
  const laneFor = (jobs: AnyJob[], crews: AnyJob[], laneId: string) =>
    lanesOf(jobs, crews).find(l => l.laneId === laneId)

  const A = crew('crew-a'), B = crew('crew-b')

  // Assignment — the visit appears in the assigned crew's lane and nowhere else.
  const assigned = [job('j1', { crew_id: 'crew-a' })]
  const t1 = laneFor(assigned, [A, B], 'crew-a')?.jobs.length === 1
    && laneFor(assigned, [A, B], 'crew-b')?.jobs.length === 0
    && laneFor(assigned, [A, B], UNASSIGNED_ID)?.jobs.length === 0
  t1 ? ok('assignment puts the visit in exactly one lane') : fail('assignment puts the visit in exactly one lane', 'partitionByCrew mis-routed an assigned job.')

  // Assignment removal — unassigning returns it to the visible Unassigned lane
  // rather than dropping it off the board entirely.
  const unassigned = [job('j1', { crew_id: null })]
  const t2 = laneFor(unassigned, [A, B], UNASSIGNED_ID)?.jobs.length === 1
  t2 ? ok('removing an assignment returns the visit to Unassigned') : fail('removing an assignment returns the visit to Unassigned', 'the visit vanished from the board instead.')

  // Access revocation, as far as this app models it: a crew switched off must stop
  // holding work. Its visits fall back to Unassigned instead of hiding in a lane
  // that is no longer rendered.
  const deactivated = [job('j1', { crew_id: 'crew-a' })]
  const lanesD = lanesOf(deactivated, [crew('crew-a', { is_active: false }), B])
  const t3 = !lanesD.some(l => l.laneId === 'crew-a')
    && lanesD.find(l => l.laneId === UNASSIGNED_ID)?.jobs.length === 1
  t3 ? ok('a deactivated crew drops its lane and orphans nothing') : fail('a deactivated crew drops its lane and orphans nothing', 'work stayed attached to a lane the board no longer draws.')

  // Cancellation — a cancelled visit must not read as active work, in the running
  // order OR in the workload that drives capacity.
  const withCancelled = [job('j1'), job('j2', { status: 'cancelled' })]
  const t4 = laneSequence(withCancelled as any).length === 1 && laneWorkMinutes(withCancelled as any) === 60
  t4 ? ok('a cancelled visit leaves the running order and the workload') : fail('a cancelled visit leaves the running order and the workload', 'cancelled work still counts as scheduled.')

  // A blocked day is zero capacity for every crew — the day-level authority wins
  // over a crew's own configured window.
  const t5 = crewCapacityMinutes(crew('crew-a', { capacity_minutes: 480 }) as any, { blocks: true } as any, 8) === 0
  t5 ? ok('a blocked day zeroes every crew’s capacity') : fail('a blocked day zeroes every crew’s capacity', 'a rained-out day still advertised room to work.')

  // Reschedule — the board queries one date, so a moved visit must not linger.
  // (The date filter lives in the query; this pins the ordering contract that a
  // re-fetched day rebuilds cleanly from route_order.)
  const reordered = [job('j2', { route_order: 2 }), job('j1', { route_order: 1 })]
  const t6 = laneSequence(reordered as any).map(j => j.id).join(',') === 'j1,j2'
  t6 ? ok('a refetched day rebuilds the running order from route_order') : fail('a refetched day rebuilds the running order from route_order', 'laneSequence ignored route_order.')
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

behaviour().then(() => {
  console.log(failures === 0
    ? '\n✅ crew-sync: the board reflects what the manager actually persisted.\n'
    : `\n❌ crew-sync: ${failures} contract${failures === 1 ? '' : 's'} broken.\n`)
  process.exit(failures === 0 ? 0 : 1)
}).catch(e => {
  console.error('\n❌ crew-sync: behaviour checks could not run —', e)
  process.exit(1)
})
