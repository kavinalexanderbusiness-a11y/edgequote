// ── Verify: the proof-of-work primitive stays trustworthy ────────────────────
//   npm run verify:completion
//
// WHY THIS SCRIPT EXISTS
// A completion record is only worth having if three things stay true, and none
// of them is a type error:
//
//   1. THE VISIBILITY BOUNDARY. The whole reason there are two note fields is
//      that one is written for the customer and one is not. `jobs.notes` — the
//      internal access note ("dog removal, keep gate closed") — was selected by
//      get_portal_data and rendered verbatim in the customer's visit history on
//      49 of 78 completed production visits. The fix was to remove it from the
//      RPC's projection, so a portal component cannot leak what was never
//      serialized. That is a one-line property of a SQL file, and one careless
//      resync puts it straight back. `create or replace` has no merge: whoever
//      re-runs an older copy of that file wins the whole body.
//
//   2. NO SECOND COMPLETION STATE. `status` + `completed_at` answer whether and
//      when, stamped only by lib/jobStatus.completionPatch. If the record
//      writers ever also touched status, completed_at or an invoice, then
//      adding a photo caption to a visit finished last week could re-bill it.
//
//   3. THE CREW DOOR STAYS TYPED. A crew session has no table grants at all, so
//      its write goes through a DEFINER RPC. Typed parameters — never a jsonb
//      patch — are what stop a client naming `price`, and the function must
//      re-check employer + crew itself because DEFINER runs past RLS.
//
// Half the checks run the REAL module against fixtures; half read the real
// source files. Deterministic, no network.

import { portalDataSql } from './lib/schema-source'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COMPLETION_ISSUE_MAX, COMPLETION_SUMMARY_MAX,
  completionEvidence, completionRecordChanged, evidenceLine, normalizeCompletionRecord,
} from '../src/lib/completion'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const root = join(__dirname, '..')
// ⚠️ Normalise CRLF before ANY regex. `.` does not match `\r`, so on a CRLF
// checkout a `.*$` pattern silently matches nothing and every absence check
// below would invert into a false pass.
const read = (rel: string) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')

// ⚠️ Every absence check below MUST run over code with the comments removed.
// This boundary is documented at each site it matters — the SQL projection, the
// portal type, the tab that used to leak — so a guard that greps the raw file
// finds `completion_issue` in the very warnings that exist to keep it out and
// reports the CURE as the DISEASE. Block comments first (JSX `{/* … */}` bodies
// included), then whole-line `//`, `--` and continuation `*`. `[\s\S]` rather
// than `.` so a stray CR can't end the match early.
const codeOf = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|--|\*)/.test(l)).join('\n')
const readCode = (rel: string) => codeOf(read(rel))

// ═══ 1. The input normaliser ═════════════════════════════════════════════════
console.log('\n═══ What a human typed, before it is trusted ═══')
{
  const n = normalizeCompletionRecord({ summary: '  Mowed and edged.  ', issue: '   ' })
  eq('a summary is trimmed', n.completion_summary, 'Mowed and edged.')
  // Whitespace is not a record: an empty box and a box holding three spaces
  // both mean "nothing was said". A '' would render an empty quote block in the
  // customer's portal and make the owner's board claim a note that says nothing.
  eq('whitespace-only becomes null, never an empty string', n.completion_issue, null)

  const blank = normalizeCompletionRecord({})
  eq('a missing summary is null', blank.completion_summary, null)
  eq('a missing issue is null', blank.completion_issue, null)

  const nonString = normalizeCompletionRecord({ summary: 42 as unknown as string })
  eq('a non-string is null, not "42"', nonString.completion_summary, null)

  // Truncation on the way IN rather than a DB constraint: a length error at the
  // end of a day in the field loses the note entirely.
  const long = normalizeCompletionRecord({ summary: 'x'.repeat(COMPLETION_SUMMARY_MAX + 50) })
  eq('an over-long summary is capped', long.completion_summary?.length, COMPLETION_SUMMARY_MAX)
  const longIssue = normalizeCompletionRecord({ issue: 'y'.repeat(COMPLETION_ISSUE_MAX + 50) })
  eq('an over-long issue is capped', longIssue.completion_issue?.length, COMPLETION_ISSUE_MAX)

  eq('normalising twice changes nothing (idempotent)',
    normalizeCompletionRecord({ summary: long.completion_summary }).completion_summary,
    long.completion_summary)
}

// ═══ 2. Change detection ═════════════════════════════════════════════════════
console.log('\n═══ A save that changes nothing must not be sent ═══')
{
  const row = { completion_summary: 'Mowed.', completion_issue: null }
  check('identical input is not a change',
    !completionRecordChanged(row, normalizeCompletionRecord({ summary: 'Mowed.', issue: '' })))
  // A bumped updated_at breaks the optimistic-concurrency guard every other
  // queued job patch rides on, so a no-op write is not harmless.
  check('re-typed whitespace around the same words is not a change',
    !completionRecordChanged(row, normalizeCompletionRecord({ summary: '  Mowed.  ' })))
  check('a real edit IS a change',
    completionRecordChanged(row, normalizeCompletionRecord({ summary: 'Mowed and edged.' })))
  check('adding an issue IS a change',
    completionRecordChanged(row, normalizeCompletionRecord({ summary: 'Mowed.', issue: 'Leak.' })))
  check('a row with the fields absent still compares',
    completionRecordChanged({}, normalizeCompletionRecord({ summary: 'Mowed.' })))
}

// ═══ 3. Reading the record back ══════════════════════════════════════════════
console.log('\n═══ Evidence describes only what is there ═══')
{
  const none = completionEvidence({ completed_at: null, actual_minutes: null })
  eq('an unfinished visit reports no completion', none.completedAt, null)
  check('nothing recorded means no proof', !none.hasProof)
  eq('no evidence produces no line, never "0 photos"', evidenceLine(none), '')

  // A visit with no check-in has NULL minutes, never 0 — completionPatch's rule.
  // A fabricated zero is a 100%-margin job.
  eq('unknown minutes stay unknown', none.minutes, null)

  const ev = completionEvidence(
    { completed_at: '2026-08-11T18:30:00Z', actual_minutes: 45, completion_summary: 'Mowed.' },
    [{ kind: 'before' }, { kind: 'after' }, { kind: 'after' }, { kind: 'general' }],
  )
  eq('photos are counted', ev.photos, 4)
  eq('before is counted', ev.before, 1)
  eq('after is counted', ev.after, 2)
  check('a summary alone counts as proof', ev.hasProof)
  eq('the compact line reads as expected', evidenceLine(ev), '4 photos · 45 min')

  const onePhoto = completionEvidence({ completed_at: 'x', actual_minutes: null }, [{ kind: 'after' }])
  eq('one photo is singular', evidenceLine(onePhoto), '1 photo')
  check('a photo alone counts as proof', onePhoto.hasProof)

  const issueOnly = completionEvidence({ completed_at: 'x', actual_minutes: null, completion_issue: 'Leak.' })
  check('an internal issue alone counts as proof', issueOnly.hasProof)
  eq('an internal issue never enters the compact line', evidenceLine(issueOnly), '')
}

// ═══ 4. ⭐ THE VISIBILITY BOUNDARY, at the source ════════════════════════════
console.log('\n═══ Internal fields never reach the customer ═══')
{
  const canonical = portalDataSql()
  // The `jobs` projection line specifically — checking the whole file would pass
  // on the word "notes" appearing in the properties or invoices projections,
  // both of which legitimately carry one.
  const jobsLine = canonical.split('\n').find(l => l.includes("'jobs', coalesce("))
  check('the portal RPC still builds a jobs projection', !!jobsLine)
  if (jobsLine) {
    // ⛔ The whole defect in one assertion.
    check('⛔ the jobs projection does NOT select the internal `notes`',
      !/\bnotes\b/.test(jobsLine),
      'jobs.notes is the internal access note (gate codes) and was rendered to customers — it must not be in the payload')
    check('⛔ the jobs projection does NOT select `completion_issue`',
      !jobsLine.includes('completion_issue'),
      'completion_issue is internal — a customer must never receive it')
    check('⭐ the jobs projection DOES select `completion_summary`',
      jobsLine.includes('completion_summary'),
      'the customer-visible half of the record is what replaced notes')
  }
  // Nowhere else in the portal RPC either.
  check('completion_issue appears nowhere in the portal RPC',
    !codeOf(canonical).includes('completion_issue'))

  const model = read('src/app/portal/[token]/model.ts')
  const portalJob = model.split('\n').find(l => l.startsWith('export interface PortalJob'))
  check('the PortalJob type exists', !!portalJob)
  if (portalJob) {
    check('PortalJob carries no `notes` field', !/\bnotes:/.test(portalJob),
      'a type that still names notes invites a component to render it')
    check('PortalJob carries completion_summary', portalJob.includes('completion_summary:'))
    check('PortalJob carries no completion_issue', !portalJob.includes('completion_issue'))
  }

  // Every portal surface, not just the one that had the bug.
  for (const f of [
    'components/VisitsTab.tsx', 'components/HomeTab.tsx', 'components/PropertyTab.tsx',
    'components/BillingTab.tsx', 'components/MessagesTab.tsx', 'components/RequestsTab.tsx',
    'components/shared.tsx', 'PortalClient.tsx',
  ]) {
    const src = readCode(`src/app/portal/[token]/${f}`)
    check(`${f} never reads completion_issue`, !src.includes('completion_issue'))
    // j.notes / job.notes on a JOB is the exact leak. (Quote and invoice notes
    // are customer documents and legitimately render their own `notes`.)
    check(`${f} never renders a visit's internal notes`, !/\bj\.notes\b/.test(src))
  }
}

// ═══ 5. ⛔ NO SECOND COMPLETION STATE ════════════════════════════════════════
console.log('\n═══ Recording is not a transition ═══')
{
  const lib = read('src/lib/completion.ts')
  // Everything below the header comment — the header necessarily discusses the
  // words this section forbids in code.
  const code = lib.split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')
  check('⛔ the record writer never writes `status`', !/status\s*:/.test(code),
    'status is completionPatch\'s alone')
  check('⛔ the record writer never writes `completed_at`', !/completed_at\s*:/.test(code))
  check('⛔ the record writer never writes `actual_minutes`', !/actual_minutes\s*:/.test(code))
  check('⛔ no invoice engine is reachable from the record writer',
    !/invoic/i.test(code),
    'a note added to a visit billed last week must not be able to re-bill it')
  check('the only table it touches is jobs',
    (code.match(/\.from\(/g) || []).length === (code.match(/\.from\('jobs'\)/g) || []).length)
  // A PostgREST update matching zero rows returns success with no error — the
  // false-Saved shape. Asking for the row back is what makes that observable.
  check('the write asserts a row was actually updated',
    code.includes(".select('id')") && /data\.length === 0/.test(code),
    'without this an RLS-dropped write reports "Saved"')

  const crewJob = read('src/lib/crewJob.ts')
  check('the crew record writer never writes a lifecycle field',
    !/crew_set_visit_status/.test(crewJob.split('crewSaveCompletionRecord')[1] ?? ''),
    'crewSaveCompletionRecord must not reach the status RPC')

  // The stamp itself is still the one-stamp rule's (verify:job-completion owns
  // that); this only asserts nothing here competes with it.
  const jobStatus = readCode('src/lib/jobStatus.ts')
  check('completionPatch is still the completion stamp', jobStatus.includes('export function completionPatch'))
  check('jobStatus does not know about the record fields',
    !jobStatus.includes('completion_summary') && !jobStatus.includes('completion_issue'),
    'the stamp and the record are separate concerns and must stay so')
}

// ═══ 6. The crew door ════════════════════════════════════════════════════════
console.log('\n═══ A crew session writes through a typed RPC only ═══')
{
  const sql = read('supabase/archive/run/RUN-2026-08-11-proof-of-work.sql')
  const fn = sql.split('create or replace function public.crew_set_completion_record')[1] ?? ''
  check('the crew record RPC is defined', fn.length > 0)
  check('it takes TYPED parameters, never a jsonb patch',
    fn.includes('p_summary text') && fn.includes('p_issue   text') && !/jsonb\s*(,|\))/.test(fn.split('as $$')[0] ?? ''),
    'a jsonb patch is what would let a client name `price`')
  check('it is SECURITY DEFINER', fn.includes('security definer'))
  // An unpinned search_path makes a DEFINER function hijackable.
  check('its search_path is pinned (with pg_temp)', fn.includes('set search_path = public, pg_temp'))
  // DEFINER runs past RLS, so the function must re-check authorization itself.
  check('it re-checks the employer', fn.includes('crew_employer()'))
  check('it re-checks the crew', fn.includes('crew_crew_id()'))
  check('it refuses a cancelled visit', fn.includes("j.status <> 'cancelled'"))
  check('it writes ONLY the two record columns',
    fn.includes('set completion_summary') && fn.includes('completion_issue   =')
      && !/set[\s\S]{0,400}\bstatus\s*=/.test(fn),
    'a lifecycle write here would make recording a completion door')
  check('a non-match is reported, never silently succeeded', fn.includes("'ok', false"))
  // Supabase's DEFAULT PRIVILEGES grant EXECUTE to anon at CREATE time and
  // `revoke ... from public` does NOT remove it — revoke by role name.
  check('EXECUTE is revoked from anon by name',
    sql.includes('revoke all on function public.crew_set_completion_record(uuid, text, text) from anon'))

  const crewJob = readCode('src/lib/crewJob.ts')
  check('the client calls the RPC, not a table', crewJob.includes("rpc('crew_set_completion_record'"))
  check('the crew path never updates jobs directly',
    !crewJob.includes(".from('jobs')"),
    'a crew session holds no table grants — a direct write would be a lie about what works')
  check('a failed crew save is reported', crewJob.includes('ok: false'))
}

// ═══ 7. One editor, one writer per audience ══════════════════════════════════
console.log('\n═══ One primitive, not two ═══')
{
  const sheet = read('src/components/completion/CompletionSheet.tsx')
  const sheetCode = codeOf(sheet)
  check('the sheet never uploads anything itself',
    !sheetCode.includes('uploadPhoto') && !sheetCode.includes('/api/crew/photos') && !sheetCode.includes('.storage'),
    'photos go through the canonical uploader the caller hands in')
  check('the sheet never writes the database itself',
    !sheetCode.includes(".from('") && !sheetCode.includes('.rpc('),
    'the transport is the caller\'s — owner table write or crew RPC')
  // The boundary is not only enforced, it is SAID — a worker deciding where to
  // type "customer was rude" must be able to see the answer.
  check('the customer-visible box says so on screen', /customer reads this/i.test(sheet))
  check('the internal box says so on screen', /office only/i.test(sheet))
  // Honesty: photos travel on their own path, so a confirmation must not widen
  // to cover evidence this save never handled.
  check('a save with photos outstanding says so instead of just "Saved"',
    sheet.includes('photosOutstanding') && /still to upload/.test(sheet))
  check('a failed save keeps the typed words', /setError\(/.test(sheet) && !/setSummary\(''\)/.test(sheet))

  const crewToday = readCode('src/components/crew/CrewToday.tsx')
  // Completion must stay ONE tap. An auto-opening sheet would tax every routine
  // mow on a 15-stop day.
  // Completion must stay ONE tap: an auto-opening sheet would tax every routine
  // mow on a 15-stop day, which is exactly the "don't turn mowing into a
  // 12-field inspection" failure. Counting the call sites is what makes that
  // provable — there are precisely two legitimate ones (the card button opens
  // it, the sheet closes it), so ANY third call, wherever it hides, fails here.
  const opens = (crewToday.match(/setRecordingId\(/g) || []).length
  eq('the crew screen has exactly two setRecordingId call sites', opens, 2)
  check('…and they are the card button and the close handler',
    crewToday.includes('onClick={() => setRecordingId(stop.id)}') && crewToday.includes('setRecordingId(null)'),
    'a third call site means something other than the button opens the sheet')
  check('the crew card offers the record affordance', crewToday.includes('setRecordingId(stop.id)'))
  check('the crew sheet writes through the crew seam', crewToday.includes('crewSaveCompletionRecord'))

  const dispatch = readCode('src/app/dashboard/dispatch/page.tsx')
  check('the owner board offers the record affordance', dispatch.includes('onRecord'))
  check('the owner sheet writes through the shared engine', dispatch.includes('saveCompletionRecord'))
  check('the owner sheet reuses the canonical photo gallery', dispatch.includes('<JobPhotos'))
}

// ═══ 8. The crew read path ═══════════════════════════════════════════════════
console.log('\n═══ The sheet opens on the real row ═══')
{
  const crewSql = read('supabase/archive/run/RUN-2026-08-07-crew-mode.sql')
  check('crew_day returns the recorded summary', crewSql.includes("'completion_summary', j.completion_summary"))
  check('crew_day returns the recorded issue', crewSql.includes("'completion_issue', j.completion_issue"))
  const access = readCode('src/lib/crewAccess.ts')
  check('CrewStop carries both fields',
    access.includes('completion_summary: string | null') && access.includes('completion_issue: string | null'),
    'without them the sheet opens blank and saves over what is there')
}

console.log(`\n${failures === 0 ? '✓' : '✗'} completion checks: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
