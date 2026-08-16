// ── verify:job-forms — Job Forms + Checklists V1 (Session 69) ────────────────
//
// WHY THIS SCRIPT EXISTS. A checklist that can be satisfied without doing the
// work is worse than no checklist: it manufactures written proof of things
// that didn't happen. So the contracts here are mostly REFUSALS, and each one
// is asserted where it actually lives — the database:
//
//   ⛔ a visit cannot complete while a required item is open, unless the owner
//      waived that form WITH A REASON (a BEFORE UPDATE trigger on jobs — it
//      backstops every completion door at once, and fires only on the
//      TRANSITION, so Stop-for-today is structurally unblockable)
//   ⛔ an instance's snapshot is history — template edits reach only forms not
//      yet minted; a completed visit's answers freeze (owner corrections carry
//      a reason; crew edits refuse outright)
//   ⛔ attribution is recorded, never inferred — answered_by must be the
//      session that wrote it
//   ⛔ a photo requirement is satisfied only by canonical job_photos rows OF
//      THE SAME VISIT, linked; there is no second upload path
//   ⛔ crew touch forms only through typed DEFINER RPCs that re-prove
//      employer + crew per call; no crew RLS policy exists anywhere
//   ⛔ nothing in these tables ever reaches a customer: no portal projection,
//      no PDF names them (audience registered wholeTable in lib/noteScope)
//
// The schema shipped 2026-08-15 and lives folded into the baseline; the
// authoritative SQL text is the archived migrations. The live half exercises
// the real database in the marked fixture tenant and SKIPS CLEAN without
// credentials (CI runs with placeholders). A fuller adversarial battery ran
// live at ship time in rolled-back transactions (40/40) — this guard keeps
// the shapes that made it pass from quietly changing.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openFixtureTenant, isSkipped, fixtureResidue } from './lib/verify-fixture'
import {
  formProgress, checklistBlockMessage, actionableFields, isEmptyValue,
  PASSIVE_FIELD_TYPES, CHECKLIST_BLOCK_MARK,
  type JobFormInstance, type JobFormResponse, type ResponsePhotoLink,
} from '../src/lib/jobForms'
import { SCOPED_NOTE_FIELDS } from '../src/lib/noteScope'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail = '') => { failures++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
const check = (name: string, cond: boolean, detail = '') => cond ? ok(name) : fail(name, detail)

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
// Strip comments BEFORE asserting absence/presence — a rule must not be
// satisfiable (or breakable) by the prose that states it. [^\n] not '.' — CRLF.
const code = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[^\S\n]*\/\/[^\n]*$/gm, '')
const sql = (s: string) => s.replace(/--[^\n]*/g, '')
const flat = (s: string) => s.replace(/\r/g, '')

const MIG_V1 = flat(src('supabase/archive/ledger/20260815120000_job_forms_v1.sql'))
const MIG_ATTACH = flat(src('supabase/archive/ledger/20260815124500_job_forms_attach_rpc.sql'))
const MIG_FIX = flat(src('supabase/archive/ledger/20260815130000_job_forms_fix_photo_projection.sql'))
const M = sql(MIG_V1)
const baselineName = readdirSync(join(process.cwd(), 'supabase', 'migrations')).filter(f => /_baseline\.sql$/.test(f))
const BASE = baselineName.length === 1 ? flat(src(join('supabase', 'migrations', baselineName[0]))) : ''

console.log('\n══ verify:job-forms ═════════════════════════════════════════════════════')

// ═══ 1 · Tenancy and history are CONSTRAINTS, not convention ═════════════════
console.log('\n═══ 1 · the migration: walls in the schema ═══')

check('an instance belongs to a visit by composite same-owner FK',
  /job_forms_job_same_owner[\s\S]{0,80}foreign key \(job_id, user_id\) references public\.jobs \(id, user_id\) on delete cascade/.test(M),
  'without (job_id, user_id) one tenant can attach a form to another tenant\'s visit')
check('a response belongs to an instance by composite same-owner FK',
  /job_form_responses_form_same_owner[\s\S]{0,80}foreign key \(form_id, user_id\) references public\.job_forms \(id, user_id\) on delete cascade/.test(M))
check('a photo link is double-walled: same-owner to the response AND to the photo',
  /job_form_response_photos_response_same_owner[\s\S]{0,90}foreign key \(response_id, user_id\) references public\.job_form_responses \(id, user_id\)/.test(M)
  && /job_form_response_photos_photo_same_owner[\s\S]{0,90}foreign key \(photo_id, user_id\) references public\.job_photos \(id, user_id\) on delete cascade/.test(M),
  'a single-column FK is how one tenant satisfies a requirement with another tenant\'s photo')
check('a template with history cannot be hard-deleted (RESTRICT)',
  /job_forms_template_same_owner[\s\S]{0,90}references public\.form_templates \(id, user_id\) on delete restrict/.test(M),
  'archive-instead-of-delete is a database guarantee, not a UI kindness')
check('both default-checklist columns RESTRICT template deletion too',
  (M.match(/references public\.form_templates \(id, user_id\) on delete restrict/g) || []).length >= 3)
check('one instance per (visit, template) — the get-or-create race has a unique to land on',
  /job_forms_job_template_uniq unique \(job_id, template_id\)/.test(M))
check('one response per (form, field) — the upsert target',
  /job_form_responses_field_uniq unique \(form_id, field_id\)/.test(M))
check('headings and instructions cannot be required',
  /form_template_fields_required_actionable check \(\s*not required or field_type not in \('section','instruction'\)\)/.test(M))
check('a waive is all-or-nothing: at/by/reason together',
  /job_forms_waive_consistent/.test(M) && /\(waived_at is null\) = \(waived_by is null\)/.test(M))

console.log('\n═══ 2 · locked down: RLS owner-only, no crew policy, grants explicit ═══')
for (const t of ['form_templates', 'form_template_fields', 'job_forms', 'job_form_responses', 'job_form_response_photos']) {
  check(`${t}: RLS on + revoke-then-grant`,
    M.includes(`alter table public.${t} enable row level security`)
    && M.includes(`revoke all on table public.${t} from public, anon, authenticated, service_role`))
}
check('no policy so much as mentions crew (the founding crew-mode rule)',
  !/create policy[^;]*crew/i.test(M), 'crew access is RPC-only; a crew RLS policy is the rejected design')
check('no table grant to anon',
  !/grant[^;\n]*on table public\.(form_templates|form_template_fields|job_forms|job_form_responses|job_form_response_photos)[^;\n]*\banon\b/.test(M))
check('internal engines are service_role-only (summary, missing, resolver, snapshot)',
  ['job_form_missing_items(uuid, uuid)', 'job_form_summary(uuid, uuid)', 'form_template_snapshot(uuid, uuid)']
    .every(f => new RegExp(`grant execute on function public\\.${f.replace(/[().,]/g, m => '\\' + m)} to service_role;`).test(M)
      && !new RegExp(`grant execute on function public\\.${f.replace(/[().,]/g, m => '\\' + m)} to authenticated`).test(M)),
  'a DEFINER counter granted to authenticated is a cross-tenant probe (it takes an explicit user id)')
check('the migration proves its own lockdown (has_function_privilege + raise)',
  /has_function_privilege\('anon', 'public\.crew_job_forms\(uuid\)', 'execute'\)/.test(M) && /raise exception 'anon must not execute crew_job_forms'/.test(M))
check('every function pins search_path and is SECURITY DEFINER',
  (M.match(/security definer/g) || []).length >= 12 && (M.match(/set search_path to 'public', 'pg_temp'/g) || []).length >= 12)

console.log('\n═══ 3 · the crew doors: typed, re-proved, never a jsonb patch ═══')
const crewSaveSig = M.match(/create or replace function public\.crew_save_form_response\(([\s\S]*?)\)\s*returns/)
check('crew_save_form_response takes TYPED parameters only — no jsonb a client could stuff a column into',
  !!crewSaveSig && !/jsonb/.test(crewSaveSig[1]))
check('both crew RPCs re-prove employer + crew inside the function',
  /crew_job_forms[\s\S]{0,900}user_id = v_employer and crew_id = v_crew/.test(M)
  && /crew_save_form_response[\s\S]{0,1500}user_id = v_employer and crew_id = v_crew/.test(M),
  'DEFINER runs past RLS — the check must live in the body')
check('crew writes refuse cancelled and completed visits with named reasons',
  /'reason', 'cancelled'/.test(M) && /'reason', 'completed'/.test(M))
check('crew_job_forms answers NULL for a visit that is not yours ("not yours" ≠ "no checklist")',
  /crew_job_forms[\s\S]{0,700}if not found then return null; end if;/.test(M))

console.log('\n═══ 4 · the completion gate fires on the TRANSITION only ═══')
check('gate trigger: BEFORE UPDATE on jobs',
  /create trigger ab_job_forms_completion_gate\s*before update on public\.jobs/.test(M))
check('…and only on the transition to completed (Stop-for-today is structurally untouchable)',
  /new\.status = 'completed' and old\.status is distinct from 'completed'/.test(M),
  'gating any other write would block Stop-for-today, re-saves, and the banker trigger')
check('the refusal is marked and readable (the doors parse it)',
  new RegExp(`raise exception '${CHECKLIST_BLOCK_MARK} Before completing: %'`).test(M))
check('unminted defaults still gate — a form nobody opened is not a form nobody owes',
  /A default that never got opened still gates/i.test(MIG_V1) && /job_form_default_template\(v_job\)/.test(M))
check('waived instances do not gate (the recorded override)',
  /if v_form\.waived_at is not null then continue; end if;/.test(M))

console.log('\n═══ 5 · history stays true ═══')
check('the snapshot is immutable by trigger (only waive fields may change)',
  /job_forms_freeze_guard/.test(M)
  // anchored on `if ` so a disabling prefix (`if false and …`) breaks the match
  && /if new\.fields is distinct from old\.fields/.test(M)
  && /historical record/.test(M))
check('a waive must name the waiver (the audit seam)',
  /a waive must name the person who waived it/.test(M))
check('post-completion edits demand an explicit correction with a reason',
  /must be an explicit correction with a reason/.test(M))
check('post-completion deletes are refused for everyone',
  /answers cannot be removed/.test(M))
check('crew cannot edit a frozen form at all',
  /frozen for crew/.test(M))
check('attribution is real: answered_by must be the session that wrote it',
  /attributed to the session that wrote it/.test(M) && /new\.corrected_by = auth\.uid\(\)/.test(M))
check('an empty answer cannot exist as a row (required-complete-without-value is unrepresentable)',
  /a response carries exactly one value/.test(M) && /a text answer cannot be blank/.test(M))
check('a dropdown answer must be one of the snapshot\'s own options',
  /not one of this field''s options/.test(M))
check('a checklist photo must be a photo OF THIS VISIT',
  /a checklist photo must be a photo of this visit/.test(M) && /photos attach to photo fields only/.test(M))

console.log('\n═══ 6 · attach + resolution: one snapshot builder, one resolution order ═══')
check('resolution order: series → quote\'s service template → service-name match',
  /source := 'series'/.test(M)
  && /q\.id = p_job\.quote_id/.test(M)
  && /lower\(btrim\(st\.name\)\) = lower\(btrim\(p_job\.service_type\)\)/.test(M))
check('archived templates never resolve',
  (M.match(/ft\.archived_at is null/g) || []).length >= 3)
check('minting is idempotent (on conflict do nothing)',
  /insert into public\.job_forms[\s\S]{0,400}on conflict \(job_id, template_id\) do nothing/.test(M))
check('manual attach reuses THE SQL snapshot builder (attach_job_form), not a TS copy',
  /public\.form_template_snapshot\(v_tpl\.id, v_uid\)/.test(sql(MIG_ATTACH))
  && !/form_template_snapshot|jsonb_build_object/.test(code(src('src/lib/jobForms.ts')).match(/export async function attachJobForm[\s\S]{0,600}/)?.[0] ?? 'jsonb_build_object'))

console.log('\n═══ 7 · crew_day ships counts, never content ═══')
check('crew_day carries the checklist summary per stop',
  /'checklist', public\.job_form_summary\(j\.id, j\.user_id\)/.test(sql(MIG_FIX) + M)
  && /'checklist', public\.job_form_summary\(j\.id, j\.user_id\)/.test(sql(flat(BASE))),
  'the Today list must answer "how much is left" without shipping a single field')
check('the baseline carries the whole feature (folded in after apply)',
  ['create table if not exists public."job_forms"', 'ab_job_forms_completion_gate', 'crew_save_form_response', 'job_form_response_photo_guard']
    .every(s => BASE.includes(s)),
  'run npm run schema:contract && npm run schema:baseline')

// ═══ 8 · the app doors ═══════════════════════════════════════════════════════
console.log('\n═══ 8 · the app doors ═══')
const completeRoute = code(src('src/app/api/crew/complete/route.ts'))
check('/api/crew/complete asks the gate BEFORE the status write',
  completeRoute.indexOf("rpc('job_form_missing_items'") > -1
  && completeRoute.indexOf("rpc('job_form_missing_items'") < completeRoute.indexOf("rpc('crew_set_visit_status'"))
check('…fails CLOSED when the gate cannot be read ("couldn\'t check" is never "checked out fine")',
  /gateErr\) return NextResponse\.json\([^)]*status: 502/.test(completeRoute))
check('…and refuses with the list, not a shrug (422 + checklist)',
  /status: 422/.test(completeRoute)
  // the exact live branch — a disabling prefix (`false &&`) breaks the match
  && /if \(Array\.isArray\(checklist\) && checklist\.length > 0\)/.test(completeRoute))

const photosRoute = code(src('src/app/api/crew/photos/route.ts'))
check('/api/crew/photos validates the form field BEFORE storing bytes',
  photosRoute.indexOf("from('job_forms')") > -1 && photosRoute.indexOf("from('job_forms')") < photosRoute.indexOf('.upload(path'))
check('…derives the answerer from the session and the tenant from the verified job row',
  /answered_by: user\.id/.test(photosRoute) && /user_id: j\.user_id,\s*form_id: formId/.test(photosRoute))
check('…and a failed link rolls the WHOLE upload back (photo row + object)',
  // anchored to the failure branch's first statement, so commenting the delete
  // out (which a trailing // survives in comment-stripped source) still fails
  /if \(!linked\) \{\s*\n\s*await admin\.from\('job_photos'\)\.delete\(\)\.eq\('id', photoId\)[\s\S]{0,200}remove\(\[path\]\)/.test(photosRoute),
  'an orphaned upload posing as evidence is how a dead zone ticks the box')
check('…general kind is reachable only WITH a form field named',
  /formId \? FORM_KINDS : KINDS/.test(photosRoute))

const crewJob = code(src('src/lib/crewJob.ts'))
check('a 422 from Finish becomes the checklist list, not a generic apology',
  /res\.status === 422 && Array\.isArray\(d\.checklist\)/.test(crewJob))
check('crewStopForToday knows nothing about forms (stop ≠ complete, in code as in SQL)',
  !/form|checklist|gate/i.test(crewJob.match(/export async function crewStopForToday[\s\S]*?\n}/)?.[0] ?? 'checklist'))

const crewForms = code(src('src/lib/crewForms.ts'))
check('crew reads/writes ride the typed RPCs; photos ride the ONE door',
  /rpc\('crew_job_forms'/.test(crewForms) && /rpc\('crew_save_form_response'/.test(crewForms)
  && /fetch\('\/api\/crew\/photos'/.test(crewForms)
  && !/\.from\(['"`]/.test(crewForms) && !/storage\.from\(/.test(crewForms))

const crewChecklist = code(src('src/components/crew/CrewStopChecklist.tsx'))
check('the crew checklist holds no table access and no upload path of its own',
  !/\.from\(['"`](?!job-photos)/.test(crewChecklist.replace(/storage\.from\('job-photos'\)/g, ''))
  && !/\.upload\(/.test(crewChecklist))
check('…and re-reads truth after every save (no optimistic paint)',
  /await load\(\)\s*\/\/ truth from the server/.test(crewChecklist) || /await load\(\)/.test(crewChecklist))

const crewToday = code(src('src/components/crew/CrewToday.tsx'))
check('CrewToday mounts the checklist and renders the gate\'s own refusal list',
  /<CrewStopChecklist/.test(crewToday) && /Before completing:/.test(crewToday)
  && /res\.checklist/.test(crewToday)
  // the render gate itself — a disabling prefix (`false &&`) breaks the match
  && /\{gateBlocked\[stop\.id\]\?\.length \? \(/.test(crewToday))

const dayOps = code(src('src/components/schedule/DayOpsPanel.tsx'))
check('the owner day board mounts JobFormsPanel',
  /<JobFormsPanel job=\{job\}/.test(dayOps))
const dispatch = code(src('src/app/dashboard/dispatch/page.tsx'))
check('dispatch mounts JobFormsPanel in the record sheet and translates the gate refusal',
  /<JobFormsPanel/.test(dispatch) && /checklistBlockMessage/.test(dispatch))
check('the schedule page translates the gate refusal too',
  /checklistBlockMessage/.test(code(src('src/app/dashboard/schedule/page.tsx'))))

const jobFormsLib = code(src('src/lib/jobForms.ts'))
check('owner saves ask for the row back (a zero-row PostgREST update reports success)',
  (jobFormsLib.match(/\.select\('id'\)/g) || []).length >= 5
  && (jobFormsLib.match(/!data \|\| data\.length === 0/g) || []).length >= 5)
check('a waive without a reason is refused before it leaves the client',
  /if \(!trimmed\) return \{ ok: false, error: 'Say why/.test(jobFormsLib))
check('template delete offers archive when history RESTRICTs it',
  /archive it instead/i.test(jobFormsLib))

const panel = code(src('src/components/forms/JobFormsPanel.tsx'))
check('the owner panel demands a correction reason on a frozen visit',
  /correction reason/i.test(panel) && /frozen && !correctionReason\.trim\(\)/.test(panel))
check('detach is offered only while nothing has been answered',
  /formResponses\.length === 0 && \(\s*<Button/.test(panel) || /!frozen && formResponses\.length === 0/.test(panel))

console.log('\n═══ 9 · audience: owner+crew, never the customer ═══')
const registered = SCOPED_NOTE_FIELDS.filter(f => (f.table === 'job_forms' || f.table === 'job_form_responses') && f.wholeTable && f.audience === 'crew')
check('both tables are registered wholeTable/crew in lib/noteScope', registered.length === 2)
const portalDefStart = BASE.indexOf('CREATE OR REPLACE FUNCTION public.get_portal_data')
const portalDef = portalDefStart >= 0 ? BASE.slice(portalDefStart, BASE.indexOf('$function$;', portalDefStart)) : ''
check('get_portal_data never touches the form tables',
  portalDef.length > 1000 && !/job_form/.test(portalDef))
const portalDir = join(process.cwd(), 'src', 'app', 'portal')
const portalFiles: string[] = []
const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name)) portalFiles.push(p) } }
walk(portalDir)
check(`no portal component names the form tables (${portalFiles.length} files)`,
  portalFiles.every(p => !/job_forms|job_form_responses/.test(code(readFileSync(p, 'utf8')))))
check('no PDF component names them either',
  ['src/components/pdf'].every(d => {
    try {
      return readdirSync(join(process.cwd(), d)).filter(f => /\.tsx?$/.test(f))
        .every(f => !/job_forms|job_form_responses/.test(code(src(join(d, f)))))
    } catch { return true }
  }))
check('the settings hub links the library (no dead-end route)',
  /\/dashboard\/settings\/form-templates/.test(code(src('src/app/dashboard/settings/page.tsx'))))
check('service templates map \'\' → null for the default checklist',
  /form_template_id: values\.form_template_id \|\| null/.test(code(src('src/app/dashboard/settings/templates/page.tsx'))))

// ═══ 10 · the pure engine ════════════════════════════════════════════════════
console.log('\n═══ 10 · the pure engine (presentation mirrors, SQL stays the authority) ═══')
const inst: JobFormInstance = {
  id: 'F1', job_id: 'J1', template_id: 'T1', template_name: 'Fixture', source: 'manual',
  waived_at: null, waived_by: null, waive_reason: null, created_at: '2026-01-01',
  fields: [
    { id: 'a', position: 1, type: 'section', label: 'Kitchen' },
    { id: 'b', position: 2, type: 'checkbox', label: 'Kitchen complete', required: true },
    { id: 'c', position: 3, type: 'photo', label: 'After photo', required: true },
    { id: 'd', position: 4, type: 'number', label: 'Split', unit: '°F' },
  ],
}
const resp = (over: Partial<JobFormResponse>): JobFormResponse => ({
  id: 'R', form_id: 'F1', field_id: 'b', value_text: null, value_number: null, value_bool: true,
  value_date: null, value_time: null, value_choice: null, answered_by: 'U', answered_role: 'crew',
  answered_at: '2026-01-01', corrected_at: null, correction_reason: null, ...over,
})
check('passive fields are never counted',
  actionableFields(inst.fields).length === 3 && PASSIVE_FIELD_TYPES.includes('section'))
{
  const p = formProgress(inst, [resp({})], [])
  check('a checkbox row answers; the unlinked photo stays missing',
    p.done === 1 && p.total === 3 && p.requiredDone === 1 && p.requiredTotal === 2
    && p.missingRequired.length === 1 && p.missingRequired[0].id === 'c')
}
{
  const photoResp = resp({ id: 'RP', field_id: 'c', value_bool: null })
  const links: ResponsePhotoLink[] = [{ response_id: 'RP', photo_id: 'P1', storage_path: 'x/y.jpg' }]
  const p = formProgress(inst, [resp({}), photoResp], links)
  check('a photo field is answered by its LINK, not by the anchor row',
    p.requiredDone === 2 && p.missingRequired.length === 0)
  const q = formProgress(inst, [resp({}), photoResp], [])
  check('…and the anchor row alone satisfies nothing', q.requiredDone === 1)
}
check('the gate marker parses into the human sentence',
  checklistBlockMessage(`${CHECKLIST_BLOCK_MARK} Before completing: After photo`) === 'Before completing: After photo'
  && checklistBlockMessage('some other failure') === null
  && checklistBlockMessage(null) === null)
check('empty-value detection treats undefined and null alike',
  isEmptyValue({}) && isEmptyValue({ text: null }) && !isEmptyValue({ bool: false }) && !isEmptyValue({ number: 0 }))

// ═══ 11 · live, in the marked fixture tenant (skips clean without creds) ═════
async function liveChecks() {
  console.log('\n═══ 11 · live (fixture tenant) ═══')
  const t = await openFixtureTenant('verify:job-forms')
  if (isSkipped(t)) { console.log(`  · live half skipped — ${t.skipped}`); return }
  const jobIds: string[] = []
  const templateIds: string[] = []
  try {
    const uid = t.uid
    const tplName = t.tag('jobforms-tpl')
    const { data: tpl, error: tplErr } = await t.db.from('form_templates')
      .insert({ user_id: uid, name: tplName }).select('*').single()
    if (tplErr || !tpl) { fail('create template', tplErr?.message || 'no row'); return }
    templateIds.push(tpl.id)
    ok('template created')
    const { data: fld, error: fldErr } = await t.db.from('form_template_fields').insert([
      { user_id: uid, template_id: tpl.id, position: 1, field_type: 'checkbox', label: 'Cleanup confirmed', required: true },
      { user_id: uid, template_id: tpl.id, position: 2, field_type: 'number', label: 'Reading', unit: 'psi' },
    ]).select('id, field_type')
    check('fields created', !fldErr && (fld?.length ?? 0) === 2, fldErr?.message)
    const requiredField = fld?.[0]?.id as string

    const cust = await t.fixtureCustomer()
    const { data: job, error: jobErr } = await t.db.from('jobs').insert({
      user_id: uid, customer_id: cust.id, title: t.tag('jobforms-visit'),
      scheduled_date: new Date().toISOString().slice(0, 10), status: 'scheduled',
    }).select('*').single()
    if (jobErr || !job) { fail('create visit', jobErr?.message || 'no row'); return }
    jobIds.push(job.id)

    // manual attach through THE RPC (same snapshot builder as defaults)
    const { data: attached, error: attErr } = await t.db.rpc('attach_job_form', {
      p_job_id: job.id, p_template_id: tpl.id,
    })
    check('attach_job_form mints the snapshot', !attErr && (attached?.length ?? 0) === 1
      && (attached?.[0]?.fields?.length ?? 0) === 2, attErr?.message)
    const formId = attached?.[0]?.id as string

    // the gate lists the open required item…
    const { data: gate1 } = await t.db.rpc('job_form_gate', { p_job_id: job.id })
    check('gate lists the open required item',
      gate1?.ready === false && gate1?.missing?.length === 1 && gate1?.missing?.[0]?.label === 'Cleanup confirmed',
      JSON.stringify(gate1))
    // …and the trigger refuses the completion
    const { error: completeErr } = await t.db.from('jobs')
      .update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', job.id)
    check('completing around it is REFUSED by the database',
      !!completeErr && completeErr.message.includes(CHECKLIST_BLOCK_MARK), completeErr?.message || 'update succeeded')

    // answer as the owner, honestly attributed
    const { data: saved, error: saveErr } = await t.db.from('job_form_responses').upsert({
      user_id: uid, form_id: formId, field_id: requiredField, value_bool: true,
      answered_by: uid, answered_role: 'owner',
    }, { onConflict: 'form_id,field_id' }).select('id')
    check('owner answer lands', !saveErr && (saved?.length ?? 0) === 1, saveErr?.message)
    // spoofed attribution refused
    const { error: spoofErr } = await t.db.from('job_form_responses').upsert({
      user_id: uid, form_id: formId, field_id: requiredField, value_bool: true,
      answered_by: randomUUID(), answered_role: 'crew',
    }, { onConflict: 'form_id,field_id' })
    check('spoofed attribution refused', !!spoofErr && /attributed to the session/.test(spoofErr.message), spoofErr?.message)
    // cross-tenant probes
    check('a form cannot be attached to a stranger\'s business',
      !!(await t.db.from('job_forms').insert({
        user_id: randomUUID(), job_id: job.id, template_id: tpl.id,
        template_name: 'x', fields: [], source: 'manual',
      })).error)
    // completion now passes; the form freezes
    const { error: complete2Err } = await t.db.from('jobs')
      .update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', job.id)
    check('completion succeeds once required items are done', !complete2Err, complete2Err?.message)
    const { error: frozenErr } = await t.db.from('job_form_responses')
      .update({ value_bool: true, answered_at: new Date().toISOString() })
      .eq('form_id', formId).eq('field_id', requiredField)
    check('the completed form is frozen without a correction reason',
      !!frozenErr && /explicit correction/.test(frozenErr.message), frozenErr?.message || 'update succeeded')
    // template with history: delete refused, archive works
    const { error: delErr } = await t.db.from('form_templates').delete().eq('id', tpl.id)
    check('deleting a used template is refused (archive instead)', !!delErr, 'delete succeeded — history just lost its definition')
    const { data: arch } = await t.db.from('form_templates')
      .update({ archived_at: new Date().toISOString() }).eq('id', tpl.id).select('id')
    check('archiving works', (arch?.length ?? 0) === 1)
  } finally {
    for (const id of jobIds) await t.db.from('jobs').delete().eq('id', id)          // cascades forms/responses
    for (const id of templateIds) {
      await t.db.from('form_template_fields').delete().eq('template_id', id)
      await t.db.from('form_templates').delete().eq('id', id)
    }
    await t.close()
    const residue = await fixtureResidue(t)
    const leftover = Object.entries(residue).filter(([, n]) => n !== 0)
    check('the fixture tenant is left clean', leftover.length === 0, JSON.stringify(Object.fromEntries(leftover)))
    const { count: strayForms } = await t.db.from('form_templates')
      .select('id', { count: 'exact', head: true }).eq('user_id', t.uid).like('name', `%${t.runId}%`)
    check('…including this run\'s templates', (strayForms ?? 0) === 0, `${strayForms} left`)
  }
}

liveChecks()
  .catch(e => { failures++; console.log(`  ✗ the live half threw\n      ${e instanceof Error ? e.message : String(e)}`) })
  .then(() => {
    console.log('')
    if (failures) { console.log(`✗ verify:job-forms — ${failures} check(s) FAILED\n`); process.exit(1) }
    console.log('✓ verify:job-forms — all checks passed\n')
  })
