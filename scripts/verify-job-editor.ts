// ── Verify: the job editor + quick edit cannot destroy what they don't render ──
//   npm run verify:job-editor
//
// WHY THIS SCRIPT EXISTS
// Session 81 split job editing into a compact primary form (customer, location,
// service, date, time window, duration, assignee, status, note) with everything
// else behind "More options", plus a quick-edit sheet on the day board. Both
// redesigns sit on top of save engines with sharp edges:
//
//   • applyFieldEdits overwrites a FIXED field set from form values on every
//     save — safe only while every field in that set is seeded from the loaded
//     row. A field dropped from the seed (or added to the set without a seed)
//     becomes a data destroyer, and price=null is not benign: null means
//     "derive from the quote cadence", i.e. a silent re-price.
//   • The quick sheet renders a SUBSET of the row, so its save must apply only
//     the keys actually sent — a fixed list would null every hidden column.
//   • Completing/un-completing is a money event with exactly one definition
//     (completionPatch / uncompleteJob); a new editor must reuse it, not add a
//     fourth door.
//   • Crew assignment has ONE semantic (crew_id + route_order reset, from
//     lib/crews.assignJobCrew) and must only apply when the owner touched it —
//     a scope-wide save blasting the anchor's crew onto siblings would undo
//     the dispatch board's lane assignments in silence.
//
// Every check here is a source pin that a mutation can turn red. Regexes are
// \r?\n-safe (CRLF disarms naive strippers — see the guard-design memories).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
// Strip JSX + block + line comments. `.` never matches \r or \n in a class-free
// regex, so line comments use [^\n]* and CRLF survives harmlessly.
const stripComments = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '')

const PAGE = 'src/app/dashboard/schedule/page.tsx'
const FORM = 'src/components/schedule/JobForm.tsx'
const SHEET = 'src/components/schedule/VisitQuickEdit.tsx'
const BOARD = 'src/components/schedule/DayOpsPanel.tsx'

const pageRaw = read(PAGE)
const page = stripComments(pageRaw)
const form = stripComments(read(FORM))
const sheet = stripComments(read(SHEET))
const board = stripComments(read(BOARD))

// Slice a named function's body: from its declaration to the next top-level
// `async function` / `function` at the same two-space page indent. Coarse but
// mutation-honest — moving or renaming the function fails loudly here.
function slice(text: string, startMarker: string, name: string): string {
  const i = text.indexOf(startMarker)
  if (i === -1) { fail(`${name}: found in source`, `marker "${startMarker}" missing`); return '' }
  const rest = text.slice(i + startMarker.length)
  const m = rest.search(/\r?\n  (?:async )?function /)
  return startMarker + (m === -1 ? rest : rest.slice(0, m))
}

// ═══ 1. Full-form save: the fixed patch set is exactly the seeded set ═══
console.log('\n═══ applyFieldEdits: every patched field is seeded from the loaded row ═══')

const afe = slice(page, 'async function applyFieldEdits', 'applyFieldEdits')
const fieldsLit = (afe.match(/const fields = \{([\s\S]*?)\n    \}/) || [])[1] ?? ''
check('the fixed field set was found', fieldsLit.length > 0, 'const fields = { … } literal not matched')
const fieldKeys = [...fieldsLit.matchAll(/^\s*([a-z_]+):/gm)].map(m => m[1])
check('the fixed set is non-trivial', fieldKeys.length >= 8, `only ${fieldKeys.length} keys`)

// The editor's seed for those fields — the `editing ? { … }` defaultValues block.
const seedLit = (page.match(/defaultValues=\{editing \? \{([\s\S]*?)\} : /) || [])[1] ?? ''
check('the edit-mode seed block was found', seedLit.length > 0, 'defaultValues={editing ? { … } : …} not matched')
for (const k of fieldKeys) {
  check(`fixed-set field "${k}" is seeded from the loaded row`,
    new RegExp(`^\\s*${k}: editing`, 'm').test(seedLit),
    `applyFieldEdits overwrites ${k} on every save, but the form no longer seeds it — a save would blank it`)
}

// Fields that must NEVER ride the unconditional set: identity/money/derived.
for (const banned of ['crew_id', 'quote_id', 'recurrence_id', 'is_initial_visit', 'status', 'actual_minutes', 'scheduled_date']) {
  check(`fixed set does not carry "${banned}"`,
    !new RegExp(`^\\s*${banned}:`, 'm').test(fieldsLit),
    `${banned} has its own engine/gate and must not be a plain overwritten field`)
}

// ═══ 2. Crew assignment: gated on change, one reassignment semantic ═══
console.log('\n═══ Assignee: silence is not consent, and one route_order semantic ═══')

check('assignment change is detected through THE engine (sameAssignee/assigneeOf)',
  /const crewChanged = !sameAssignee\(\r?\n\s*assigneeOf\(\{ crew_id: values\.crew_id \?\? null, technician_id: values\.technician_id \?\? null \}\),\r?\n\s*assigneeOf\(job\),?\r?\n\s*\)/.test(afe),
  'the change test must compare Assignees via lib/crewAssignment, not raw columns')
check('the assignment patch carries BOTH columns + the route_order reset',
  /crewChanged\r?\n\s*\? \{ crew_id: values\.crew_id \?\? null, technician_id: values\.technician_id \?\? null, route_order: null \}/.test(afe),
  'half a write leaves a stale second answer; jobs_one_assignee would refuse it at save time')
check('the assignment patch is applied to the save',
  /\.\.\.crewPatch,/.test(afe), 'the update spread no longer includes crewPatch')
check('lib/crews.assignJob still IS that semantic',
  /update\(\{ \.\.\.assigneeColumns\(assignee\), route_order: null \}\)/.test(read('src/lib/crews.ts')),
  'assignJob changed shape — update the two mirrors (applyFieldEdits, quickSaveJob) together')
check('the form assigns through THE chooser (AssigneeSelect), both columns together',
  /<AssigneeSelect/.test(read(FORM)) && /const cols = assigneeColumns\(next\)/.test(form),
  'a second assignee control (bare crew list) is a second implementation of the one chooser')

// ═══ 3. Quick save: apply ONLY the keys sent ═══
console.log('\n═══ quickSaveJob: a partial editor can never null hidden columns ═══')

const qsj = slice(page, 'async function quickSaveJob', 'quickSaveJob')
for (const k of ['start_time', 'crew_size', 'duration_minutes', 'status', 'notes', 'service_type']) {
  check(`"${k}" applies only when present in the patch`,
    new RegExp(`if \\('${k}' in patch\\)`).test(qsj),
    `base.${k} must be guarded by ('${k}' in patch) — an unconditional copy nulls it for every caller that omits it`)
}
check('assignment applies only when the pair is present — both columns + route_order reset',
  /if \('crew_id' in patch \|\| 'technician_id' in patch\) \{\r?\n\s*base\.crew_id = patch\.crew_id \?\? null\r?\n\s*base\.technician_id = patch\.technician_id \?\? null\r?\n\s*base\.route_order = null\r?\n\s*\}/.test(qsj),
  'the quick door must mirror lib/crews.assignJob: both columns together, route_order cleared, only when sent')
check('a quick save never writes price',
  !/base\.price|patch\.price/.test(qsj) && /syncPrice: false/.test(qsj),
  'price belongs to setJobPrice (audit row + draft sync) — quickSaveJob must not carry it')
check('an empty patch writes nothing',
  /if \(Object\.keys\(base\)\.length === 0\) return/.test(qsj),
  'a no-op quick save must not issue an UPDATE (it would still bump updated_at and race the offline guard)')

// The sheet's QuickPatch type carries no money/identity keys at all.
const patchLit = (sheet.match(/export interface QuickPatch \{([\s\S]*?)\}/) || [])[1] ?? ''
check('QuickPatch interface was found in VisitQuickEdit', patchLit.length > 0)
for (const banned of ['price', 'quote_id', 'recurrence_id', 'is_initial_visit', 'actual_minutes', 'scheduled_date']) {
  check(`QuickPatch cannot name "${banned}"`, !new RegExp(`\\b${banned}\\b`).test(patchLit),
    `${banned} in the quick patch is a bypass of its engine`)
}

// ═══ 4. Completion stays ONE engine, however many doors ═══
console.log('\n═══ Completing/un-completing routes through the one definition ═══')

check('form save: completing uses completionPatch', /completionPatch\(job/.test(afe))
check('form save: un-completing uses uncompleteJob (draft-first)', /await uncompleteJob\(supabase/.test(afe))
check('quick save: completing uses completionPatch', /completionPatch\(job\)/.test(qsj))
check('quick save: un-completing routes through the uncomplete engine', /await uncomplete\(job/.test(qsj))
check('quick save: completing still drafts the invoice from the edited row',
  /createDraftInvoiceForCompletedJob\(supabase, completed\)/.test(qsj))

// ═══ 5. The editor renders no forbidden writable ═══
console.log('\n═══ The form exposes no field whose engine lives elsewhere ═══')

for (const banned of ['quote_id', 'recurrence_id', 'is_initial_visit']) {
  check(`JobForm never registers "${banned}"`, !form.includes(`register('${banned}'`),
    `${banned} must not be a form field`)
}
const amRegisters = [...form.matchAll(/register\('actual_minutes'/g)]
check('actual_minutes has exactly one register site', amRegisters.length === 1, `${amRegisters.length} sites`)
if (amRegisters.length === 1) {
  const before = form.slice(Math.max(0, amRegisters[0].index! - 600), amRegisters[0].index!)
  check('…and it is only offered while CREATING as completed (!isEdit)',
    /\{!isEdit && \(/.test(before),
    'on a saved job the DB owns actual_minutes (work-session sum) — an editable box would be overruled on save')
}

// ═══ 6. More options: relocated panels stay reachable ═══
console.log('\n═══ Deep links land where the panels moved ═══')

check('the work-sessions anchor survives', form.includes('id="job-work-sessions"'))
check('the cost anchor survives', form.includes('id="job-cost"'))
check('the More section opens for a ?panel= deep link (form half)',
  /useState\(!!initialMoreOpen\)/.test(form),
  'anchors inside a closed disclosure are unreachable — initialMoreOpen must seed the open state')
check('…and the page passes the wiring (page half)',
  /initialMoreOpen=\{!!readJobPanel\(panelParam\)\}/.test(page),
  'the page no longer tells the form a panel deep link is in flight')

// ═══ 7. Unsaved changes are protected — including the non-RHF controls ═══
console.log('\n═══ Nothing typed is silently discarded ═══')

check('the form reports BOTH dirt sources', /onDirtyChange\?\.\(isDirty \|\| recDirty\)/.test(form),
  'the Repeat/Ends controls live outside react-hook-form; isDirty alone hides them from the discard guard')
check('touching Repeat marks intent AND dirt together',
  /function markRepeatTouched\(\) \{ repeatTouched\.current = true; setRecDirty\(true\) \}/.test(form))
check('touching Ends marks intent AND dirt together',
  /function markEndTouched\(\) \{ endTouched\.current = true; setRecDirty\(true\) \}/.test(form))
check('the page asks before discarding a dirty editor',
  /if \(!formDirty\.current\) \{ closeForm\(\); return \}/.test(page) && /Discard this job\?/.test(pageRaw))
check('the page guards tab close while the editor is dirty',
  /beforeunload/.test(page) && /formDirty\.current\) e\.preventDefault\(\)/.test(page))
check('the sheet asks before discarding dirty changes',
  /if \(!dirty\) \{ onClose\(\); return \}/.test(sheet) && /Discard these changes\?/.test(read(SHEET)))
check('the sheet guards tab close while dirty', /beforeunload/.test(sheet))
check('the sheet says its save state out loud', /Unsaved changes/.test(read(SHEET)) && /disabled=\{!dirty\}/.test(sheet))
check('the form says its save state out loud', /Unsaved changes/.test(read(FORM)))

// ═══ 8. Rescheduling is explicit ═══
console.log('\n═══ A date change is a reschedule, not a field write ═══')

check('the sheet routes date changes through the move engine',
  /draft\.scheduled_date !== seed\.scheduled_date\) \{\r?\n\s*await onMove\(job, draft\.scheduled_date\)/.test(sheet),
  'quick-edit date changes must go through onMove (warnings, recurring scope, undo) — never the field patch')
check('the board hands the sheet the SAME move engine as drag/drop',
  /<VisitQuickEdit[\s\S]*?onMove=\{onMove\}/.test(board),
  'VisitQuickEdit must receive the board onMove prop, not its own date writer')
check('the board hands the sheet the SAME save engine as before',
  /<VisitQuickEdit[\s\S]*?onSave=\{onQuickSave\}/.test(board))

// ═══ 9. Financial truth is disclosed where the edit happens ═══
console.log('\n═══ Renaming a service never re-prices — and says so ═══')

check('the form disclosure is gated on an actual service change on a quote-linked visit',
  /quoteLinked && dirtyFields\.service_type/.test(form) && /changing the service changes the label, never the amount/.test(read(FORM)))
check('the sheet disclosure is gated the same way',
  /serviceChanged && job\.quote_id/.test(sheet) && /changing the service changes the label, never the amount/.test(read(SHEET)))

// ═══ Summary ═══
console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:job-editor — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:job-editor — patch shapes seeded, engines reused, dirt protected, money disclosed\n')
