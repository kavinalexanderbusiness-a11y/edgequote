// ── Verify: the Job Completion Report stays customer-safe and honest ─────────
//   npm run verify:completion-report
//
// WHY THIS SCRIPT EXISTS
// The report is a customer-facing composition of internal records, which makes
// it a leak surface by construction — the exact shape that shipped
// "dog removal, keep gate closed" to a portal. Four things must stay true:
//
//   1. INTERNAL WORDS NEVER ENTER. jobs.notes, completion_issue, crew-typed
//      free text (job_form_responses.value_text/number/date/time), waive
//      reasons and worked MINUTES are not merely unrendered — the composer
//      never selects or copies them, so no surface downstream can leak them.
//
//   2. NOTHING IS INVENTED. Photo organization uses recorded metadata only
//      (kind, taken_at, caption, checklist link labels). A checkbox that was
//      answered-but-unchecked never renders as done. A failed read says
//      "unavailable", never "no photos were taken".
//
//   3. MONEY COMES FROM THE LEDGER ENGINE. GST-inclusive totals via
//      invoiceBalance — an invoice paid only its pre-tax amount must not read
//      as settled. Draft and cancelled invoices never appear.
//
//   4. THE REPORT IS A READ. No table writes, no minting RPCs (a report must
//      not attach a checklist to a historical visit), no report store — the
//      durable document story belongs to Session 74's system.
//
// Half the checks run the REAL module against fixtures; half read the real
// source files. Deterministic, no network.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Invoice, WorkSession } from '../src/types'
import type { JobPhotoView } from '../src/lib/photos'
import type { JobFormInstance, JobFormResponse, ResponsePhotoLink } from '../src/lib/jobForms'
import {
  buildCompletionReport, checklistItemState, formatReportDay, groupReportPhotos,
  photoChecklistLabels, reportPayment, workedDaysLine,
  type CompletionReportInput, type ReportJob,
} from '../src/lib/completionReport'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const root = join(__dirname, '..')
// ⚠️ Normalise CRLF before ANY regex — `.` does not match `\r`, and on a CRLF
// checkout an absence check would invert into a false pass.
const read = (rel: string) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')

// ⚠️ Absence checks run over code with comments removed, or the guard greps the
// very warnings that exist to keep a field out and reports the cure as the
// disease. LINE comments strip FIRST (a `--` line can hold an unterminated
// `/*`), and the block opener must not be preceded by a word/quote char, or
// `accept="image/*"` opens a "comment" that eats real code.
const codeOf = (src: string) => src
  .split('\n').filter(l => !/^\s*(\/\/|--|\*)/.test(l)).join('\n')
  .replace(/(?<![\w"'`])\/\*[\s\S]*?\*\//g, '')
const readCode = (rel: string) => codeOf(read(rel))

const LIB = 'src/lib/completionReport.ts'
const PDF = 'src/components/completion/CompletionReportPDF.tsx'
const SHEET = 'src/components/completion/CompletionReportSheet.tsx'
const DISPATCH = 'src/app/dashboard/dispatch/page.tsx'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const job = (over: Partial<ReportJob> & Record<string, unknown> = {}): ReportJob => ({
  id: 'j1',
  title: 'Spring cleanup',
  service_type: 'Cleanup',
  status: 'completed',
  scheduled_date: '2026-08-14',
  completed_at: '2026-08-15T20:10:00Z',
  actual_minutes: 95,
  completion_summary: 'Beds weeded, lawn mowed and edged.',
  crew_id: null,
  ...over,
});

const photo = (id: string, kind: string, takenAt: string, caption: string | null = null) => ({
  id, kind, url: `https://x.example/storage/v1/object/public/job-photos/u/p/${id}.jpg`,
  caption, taken_at: takenAt,
}) as unknown as JobPhotoView;

const form = (over: Partial<JobFormInstance> = {}): JobFormInstance => ({
  id: 'f1',
  job_id: 'j1',
  template_id: 't1',
  template_name: 'Cleanup checklist',
  fields: [
    { id: 'fa', position: 1, type: 'checkbox', label: 'Gates closed on exit', required: true },
    { id: 'fb', position: 2, type: 'yes_no', label: 'Sprinklers checked', required: false },
    { id: 'fc', position: 3, type: 'short_text', label: 'Condition notes', required: false },
    { id: 'fd', position: 4, type: 'photo', label: 'Front beds after service', required: true },
    { id: 'fe', position: 5, type: 'dropdown', label: 'Lawn condition', required: false, options: ['Good', 'Fair'] },
    { id: 'ff', position: 6, type: 'section', label: 'Internal section' },
  ],
  source: 'manual',
  waived_at: null,
  waived_by: null,
  waive_reason: null,
  created_at: '2026-08-15T10:00:00Z',
  ...over,
});

const resp = (id: string, fieldId: string, over: Partial<JobFormResponse> = {}): JobFormResponse => ({
  id, form_id: 'f1', field_id: fieldId,
  value_text: null, value_number: null, value_bool: null,
  value_date: null, value_time: null, value_choice: null,
  answered_by: 'u1', answered_role: 'crew', answered_at: '2026-08-15T19:00:00Z',
  corrected_at: null, correction_reason: null,
  ...over,
});

const session = (workedOn: string, minutes: number, workers = 1) => ({
  id: `s-${workedOn}`, user_id: 'u1', job_id: 'j1', worked_on: workedOn,
  started_at: null, ended_at: null, minutes, workers,
  labour_minutes: minutes * workers, note: 'SECRET-SESSION-NOTE', source: 'manual',
  created_at: `${workedOn}T20:00:00Z`, updated_at: `${workedOn}T20:00:00Z`,
}) as unknown as WorkSession;

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  invoice_number: 'INV-0042', status: 'sent', amount: 100, amount_paid: 0,
  discount_type: null, discount_value: null, due_date: '2026-08-20',
  viewed_at: null,
  ...over,
} as unknown as Invoice);

const baseInput = (over: Partial<CompletionReportInput> = {}): CompletionReportInput => ({
  job: job(),
  customerName: 'Pat Doe',
  address: '12 Elm Street',
  business: { name: 'Edge Property Services', phone: null, email: null, website: null, logoUrl: null },
  photos: [photo('p2', 'after', '2026-08-15T19:50:00Z'), photo('p1', 'before', '2026-08-15T15:00:00Z')],
  forms: [form()],
  responses: [
    resp('r1', 'fa', { value_bool: true }),
    resp('r2', 'fb', { value_bool: false }),
    resp('r3', 'fc', { value_text: 'SECRET-CREW-TEXT gate code 4411' }),
    resp('r4', 'fd'),
    resp('r5', 'fe', { value_choice: 'Good' }),
  ],
  photoLinks: [{ response_id: 'r4', photo_id: 'p2', storage_path: null }],
  sessions: [session('2026-08-14', 60), session('2026-08-15', 35)],
  invoice: invoice(),
  fees: { gst_percent: 5 },
  crewName: 'North crew',
  todayISO: '2026-08-16',
  ...over,
});

// ═══ 1. Internal words never enter the report ════════════════════════════════
console.log('\n═══ The report cannot say what it was never given ═══')
{
  const report = buildCompletionReport({
    ...baseInput(),
    job: job({
      notes: 'SECRET-GATE dog removal, keep gate closed',
      completion_issue: 'SECRET-ISSUE sprinkler head leaking',
    }),
  })
  const text = JSON.stringify(report)
  // The composer copies named fields off a narrow ReportJob — a wider row (the
  // realistic caller mistake) must still shed the internal halves.
  check('jobs.notes never appears, even when handed in', !text.includes('SECRET-GATE'),
    'the internal access note reached the report payload')
  check('completion_issue never appears, even when handed in', !text.includes('SECRET-ISSUE'),
    'the internal issue field reached the report payload')
  check('crew-typed free text never appears', !text.includes('SECRET-CREW-TEXT'),
    'a short_text response value reached the report payload')
  check('work-session notes never appear', !text.includes('SECRET-SESSION-NOTE'),
    'a session note reached the report payload')
  check('the customer summary DOES appear (positive control)',
    text.includes('Beds weeded, lawn mowed and edged.'),
    'the one field written FOR the customer is missing — the guard would pass on an empty report')
}

{
  const waived = form({
    waived_at: '2026-08-15T18:00:00Z', waived_by: 'u1',
    waive_reason: 'SECRET-WHY customer asked us to skip it',
  })
  const report = buildCompletionReport(baseInput({ forms: [waived] }))
  eq('a waived checklist is excluded entirely', report.checklists.length, 0)
  check('the waive reason never appears', !JSON.stringify(report).includes('SECRET-WHY'),
    'an internal operational decision reached the customer report')
}

// ═══ 2. Checklist states claim only what was recorded ════════════════════════
console.log('\n═══ Checklist honesty ═══')
{
  const report = buildCompletionReport(baseInput())
  const list = report.checklists[0]
  check('one checklist composed', !!list, 'no checklist came out of a formed visit')
  const by = new Map(list.items.map(i => [i.label, i]))
  eq('a ticked checkbox is done', by.get('Gates closed on exit')?.state, 'done')
  eq('a yes_no answered No says so — never a tick', by.get('Sprinklers checked')?.state, 'no')
  eq('free text renders as Recorded, value withheld', by.get('Condition notes')?.state, 'recorded')
  eq('a photo field is satisfied by its LINK', by.get('Front beds after service')?.state, 'photo')
  eq('a dropdown shows its owner-authored option', by.get('Lawn condition')?.choice, 'Good')
  check('passive fields (section/instruction) are not items', !by.has('Internal section'),
    'a section heading was counted as an answerable item')
  eq('done counts answered items', list.done, 5)

  const unchecked = checklistItemState(
    { id: 'x', position: 1, type: 'checkbox', label: 'L' }, resp('rx', 'x', { value_bool: false }), new Set())
  eq('an answered-but-UNCHECKED checkbox stays pending', unchecked.state, 'pending')
  const unlinked = checklistItemState(
    { id: 'x', position: 1, type: 'photo', label: 'L' }, resp('rx', 'x'), new Set())
  eq('a photo response without a linked photo stays pending', unlinked.state, 'pending')
}

// ═══ 3. Photo organization is recorded metadata only ═════════════════════════
console.log('\n═══ Photos: kind, time, caption, link — nothing invented ═══')
{
  const labels = photoChecklistLabels(
    [form()],
    [resp('r4', 'fd')],
    [{ response_id: 'r4', photo_id: 'p2', storage_path: null }],
  )
  eq('a linked photo carries its owner-authored field label', labels.get('p2'), 'Front beds after service')

  const groups = groupReportPhotos([
    photo('g1', 'weird-kind', '2026-08-15T12:00:00Z'),
    photo('a2', 'after', '2026-08-15T19:50:00Z', 'All tidy'),
    photo('a1', 'after', '2026-08-15T19:40:00Z'),
    photo('b1', 'before', '2026-08-15T15:00:00Z'),
  ], labels)
  eq('groups run in story order: before → general → after',
    groups.map(g => g.kind).join(','), 'before,general,after')
  check('an unconstrained DB kind lands in general, honestly labelled "Photo"',
    groups[1].kind === 'general' && groups[1].label === 'Photo' && groups[1].photos[0].id === 'g1',
    'job_photos.kind has no CHECK constraint — an unknown kind must not vanish or masquerade')
  eq('inside a group, oldest first (a report reads forward in time)',
    groups[2].photos.map(p => p.id).join(','), 'a1,a2')
  eq('a caption rides along', groups[2].photos[1].caption, 'All tidy')
}

{
  const failed = buildCompletionReport(baseInput({ photos: null }))
  eq('a FAILED photo read is not an empty gallery', failed.photosKnown, false)
  check('…and is named in unavailable', failed.unavailable.includes('photos'),
    '"couldn\'t load" must be said, never rendered as "no photos were taken"')
  const none = buildCompletionReport(baseInput({ photos: [] }))
  check('genuinely no photos is known-and-empty', none.photosKnown && none.photoCount === 0,
    'an empty catalogue read is a real answer')
}

// ═══ 4. Days worked; completion is the gate ══════════════════════════════════
console.log('\n═══ Dates and the completion gate ═══')
{
  const report = buildCompletionReport(baseInput())
  check('multi-day work reports first/last/count from the session log',
    report.workedDays?.first === '2026-08-14' && report.workedDays?.last === '2026-08-15'
    && report.workedDays?.count === 2, JSON.stringify(report.workedDays))
  eq('the headline says the span', workedDaysLine(report), 'Aug 14, 2026 – Aug 15, 2026 (2 days)')

  const sessionless = buildCompletionReport(baseInput({ sessions: [] }))
  check('a session-less visit worked the day it completed',
    sessionless.workedDays?.count === 1 && sessionless.workedDays?.first === '2026-08-15',
    JSON.stringify(sessionless.workedDays))

  const unknown = buildCompletionReport(baseInput({ sessions: null }))
  check('a failed session read claims no days', unknown.workedDays === null
    && unknown.unavailable.includes('days worked'), 'a failed read must not invent a date')

  // '2026-08-16' parsed as a Date would be UTC midnight — yesterday in Calgary.
  eq('date-only strings never pass through Date()', formatReportDay('2026-08-16'), 'Aug 16, 2026')

  const open = buildCompletionReport(baseInput({ job: job({ status: 'in_progress', completed_at: null }) }))
  eq('an unfinished visit is not a completed report', open.completed, false)

  // Production holds completed visits from before the stamp existed:
  // status='completed', completed_at NULL. They are finished work.
  const legacy = buildCompletionReport(baseInput({ job: job({ status: 'completed', completed_at: null }), sessions: [] }))
  eq('a legacy completion (status set, no stamp) IS completed', legacy.completed, true)
  eq('…and its date line falls back to the scheduled day', workedDaysLine(legacy), 'Aug 14, 2026')
}

// ═══ 5. Money: the ledger engine, GST-inclusive, drafts private ══════════════
console.log('\n═══ Payment honesty ═══')
{
  const gst = { gst_percent: 5 }
  const paidPreTaxOnly = reportPayment(invoice({ amount_paid: 100 } as Partial<Invoice>), gst, '2026-08-16')
  check('paying the pre-tax amount of a taxed invoice is NOT settled',
    paidPreTaxOnly?.state === 'partial' && Math.abs(paidPreTaxOnly.balance - 5) < 0.001,
    `naive amount−amount_paid arithmetic: got ${JSON.stringify(paidPreTaxOnly)}`)
  const settled = reportPayment(invoice({ amount_paid: 105 } as Partial<Invoice>), gst, '2026-08-16')
  eq('the GST-inclusive total settles it', settled?.state, 'paid')
  eq('a draft invoice is private — no payment section', reportPayment(invoice({ status: 'draft' } as Partial<Invoice>), gst, '2026-08-16'), null)
  eq('a cancelled invoice is a withdrawn charge — no payment section', reportPayment(invoice({ status: 'cancelled' } as Partial<Invoice>), gst, '2026-08-16'), null)
  const overdue = reportPayment(invoice({ status: 'unpaid', due_date: '2026-08-01' } as Partial<Invoice>), gst, '2026-08-16')
  check('overdue is derived from the display engine', overdue?.overdue === true, JSON.stringify(overdue))
  eq('no invoice, no claim', reportPayment(null, gst, '2026-08-16'), null)
}

// ═══ 6. The source holds the boundary structurally ═══════════════════════════
console.log('\n═══ Static: the composer cannot reach what it must not say ═══')
{
  const lib = readCode(LIB)
  check('the job select names completion_summary (positive control)',
    /completion_summary/.test(lib), 'the select shrank past the one customer field')
  check('the composer never selects or names jobs.notes',
    !/[^_\w]notes[^_\w]/.test(lib.replace(/customers\(name\)/g, '')),
    'a bare `notes` reference appeared in lib/completionReport.ts')
  check('the composer never names completion_issue', !/completion_issue/.test(lib),
    'the internal issue field is referenced — it must never enter this module')
  check('crew free-text value columns are never referenced',
    !/value_text|value_number|value_date|value_time/.test(lib),
    'only value_bool and value_choice (DB-constrained to owner vocabulary) may render')
  check('the payroll clock is never read', !/time_entries|hourly_rate/.test(lib),
    'time_entries carries a wage on every row — it must never feed a customer document')
  check('the report is a READ: no table writes',
    !/\.insert\(|\.update\(|\.upsert\(|\.delete\(/.test(lib),
    'a write appeared in the report composer')
  check('the report never mints: no RPCs at all', !/\.rpc\(|ensureJobForms|ensure_job_forms/.test(lib),
    'ensure_job_forms MINTS a form instance — a report must not alter the visit it describes')
  check('no report store: nothing here creates or names a report table',
    !/completion_reports|report_versions|from\(\s*['"]documents/.test(lib),
    'durable report storage belongs to the Session 74 document system')
  check('money goes through the ledger engine',
    /invoiceBalance/.test(lib) && /displayInvoiceStatus/.test(lib),
    'reportPayment must derive from lib/payments/ledger, never local arithmetic')
  check('no network of its own: all IO rides the supabase client', !/fetch\(/.test(lib),
    'a bare fetch appeared — evidence reads must go through the canonical readers')
}

{
  const pdfSrc = read(PDF)
  const pdf = codeOf(pdfSrc)
  check('every PDF image is BOUNDED: logo via pdfLogoUrl',
    /src=\{pdfLogoUrl\(/.test(pdf), 'an unbounded logo once produced 11.3 MB invoices')
  check('every PDF image is BOUNDED: photos via thumbUrl',
    /src=\{thumbUrl\(/.test(pdf), 'full-resolution photos would make a 20-photo report undownloadable')
  const images = (pdf.match(/<Image\b/g) ?? []).length
  const bounded = (pdf.match(/src=\{(?:pdfLogoUrl|thumbUrl)\(/g) ?? []).length
  eq('…and there is no third, unbounded <Image>', images, bounded)
  check('the PDF never names minutes', !/minutes|actual_minutes|evidenceLine/.test(pdf),
    'worked minutes are internal — the portal has never exposed them and the report must not widen that')
  check('the PDF never names the internal fields', !/completion_issue|value_text|crewMedia|crew-media/.test(pdf),
    'an internal field is referenced by the customer artifact')
}

{
  const sheet = readCode(SHEET)
  check('the sheet composes through the one engine', /loadCompletionReport/.test(sheet),
    'the preview must render lib/completionReport, never its own read')
  check('the sheet writes nothing', !/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/.test(sheet),
    'the preview is a READ')
  check('the sheet renders the unavailable warning', /unavailable/.test(sheet),
    'a failed half must be SAID, not silently blank')
  check('the sheet never names the internal fields', !/completion_issue|value_text|actual_minutes/.test(sheet),
    'an internal field is referenced by the preview')
  check('the PDF library loads on demand', /await import\('@\/components\/completion\/CompletionReportPDF'\)/.test(read(SHEET)),
    '@react-pdf must not enter the dispatch bundle')
}

{
  const dispatch = readCode(DISPATCH)
  const doors = (dispatch.match(/setReportJobId\(job\.id\)/g) ?? []).length
  eq('exactly ONE door opens the report preview', doors, 1)
  check('the door only exists on a completed visit',
    /job\.status === 'completed' && \(/.test(dispatch),
    'a report preview on an unfinished visit would invite reporting work not yet done')
}

// ═══ Verdict ═════════════════════════════════════════════════════════════════
console.log('')
if (failures > 0) {
  console.log(`✗ verify:completion-report — ${failures} failure(s)`)
  process.exit(1)
}
console.log('✓ verify:completion-report — the report says only what was recorded')
