// ── Audit trail + accountability — `npm run verify:audit-trail` ──────────────
//
// THE CLAIM THIS EXISTS TO TEST: EdgeHQ can answer, for every meaningful business
// mutation, WHO changed WHAT, WHEN, from WHERE, what it was BEFORE and what it
// BECAME — and can be trusted when it answers.
//
// "Trusted" is the hard half, and it decomposes into things a test can pin:
//
//   1. NO FALSE EVENTS. An event exists only if the write it describes committed.
//      A rolled-back reschedule must leave NOTHING behind. This is why capture is
//      in triggers, inside the mutating transaction, and it is section 3f.
//   2. NO SILENT GAPS. A mutation that happens through a path nobody thought about
//      — a portal RPC, a crew RPC, a service-role webhook, another trigger — is
//      still recorded, because the trigger is downstream of all of them (§3b–3e).
//   3. HONEST ACTORS. A customer's portal action says customer; a worker's says
//      worker; automation says system. Not everything is the owner (§3b).
//   4. IMMUTABLE. No client can insert, edit or delete an audit row; not even
//      service_role can edit one (§3g, §3h).
//   5. TENANT-ISOLATED. Another tenant's history is invisible, and a forged
//      tenant id is refused (§3h).
//
// ── HOW IT RUNS ──────────────────────────────────────────────────────────────
// §1–2 are offline and always run: the schema lifecycle, and structural rules over
//       the audit SQL and the app source.
// §3    builds an EMPTY POSTGRES from the repository (baseline + the audit
//       migration) in PGlite and drives real mutations through it. This is the
//       behavioural proof, and it needs no credentials — which matters, because
//       the fixture-tenant credentials do not exist on every machine and never
//       exist in CI. SKIPS clean if PGlite is not installed.
// §4    live half over real HTTP against the fixture tenant. SKIPS clean without
//       credentials, as every live guard here does.
//
// ⚠️ §3 is the section that has to be right. A structural guard that greps the SQL
//    for the word "trigger" proves nothing — the repo has been bitten by exactly
//    that (a tenancy-COUNT guard satisfied by a COMMENT). Every assertion below
//    that matters is made against a database that actually ran the schema.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { baselineSql } from './lib/schema-source'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'
import { openFixtureTenant, isSkipped, fixtureResidue } from './lib/verify-fixture'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, detail = '') => { failures++; console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ''}`) }
const check = (n: string, cond: boolean, detail = '') => (cond ? ok(n) : fail(n, detail))
const eq = (n: string, actual: unknown, expected: unknown) =>
  check(n, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const PENDING_DIR = join('supabase', 'pending')
const APP = (p: string) => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n')

/**
 * Strip SQL comments before any ABSENCE assertion.
 * ⚠️ `[^\n\r]` not `.` — `.` does not match `\r`, so on a CRLF checkout a `.*$`
 * stripper leaves the comment body in place and every absence check passes
 * vacuously. That has happened here before.
 */
const stripSqlComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n\r]*/g, '')

/** The same rule for TypeScript. `[^\n\r]`, again, for the same CRLF reason. */
const stripTsComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n\r]*/g, '')

// ═══════════════════════════════════════════════════════════════════════════
// 1 · WHERE THE AUDIT SCHEMA LIVES  (the lifecycle this file must not lose)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n■ 1. Schema lifecycle — the audit schema has exactly one home\n')

const base = baselineSql()
const baselineHasTable = /create table if not exists public\."audit_events"/i.test(base)

const pendingFiles = existsSync(PENDING_DIR)
  ? readdirSync(PENDING_DIR).filter(f => f.endsWith('.sql'))
  : []
const pendingAudit = pendingFiles.filter(f =>
  /create table if not exists public\.audit_events/i.test(APP(join(PENDING_DIR, f))))

check('the audit schema exists in exactly one place — pending/ or the baseline, never both',
  baselineHasTable !== (pendingAudit.length > 0),
  baselineHasTable && pendingAudit.length > 0
    ? `defined BOTH in the baseline and in ${pendingAudit.join(', ')}. Once production has ` +
      'applied it and the baseline is regenerated, DELETE the pending file — a second ' +
      'copy of live DDL is the retired-CANONICAL-file mistake.'
    : 'defined in neither. The audit trail has no schema.')

const auditSqlPath = baselineHasTable ? '' : join(PENDING_DIR, pendingAudit[0] ?? '')
const auditSql = baselineHasTable ? base : (pendingAudit.length ? APP(auditSqlPath) : '')
check('the audit schema is readable', auditSql.length > 0)

if (!baselineHasTable) {
  console.log(`  · not yet applied to production — reading ${auditSqlPath}`)
  console.log('  · until it is applied, History surfaces report the missing table honestly')
  check('a pending migration is NOT in the apply path (supabase/migrations/)',
    !existsSync(join('supabase', 'migrations', pendingAudit[0] ?? 'x.sql')),
    'a migration in supabase/migrations/ that production has not run turns verify:rebuild red')
}

const auditBody = stripSqlComments(auditSql)

// ═══════════════════════════════════════════════════════════════════════════
// 2 · STRUCTURAL RULES  (things whose absence is the bug)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n■ 2. Structure — the rules that keep the record honest\n')

// -- 2a. immutability is declared, both locks -------------------------------
check('audit_events has an immutability trigger',
  /create trigger audit_events_no_mutate\s+before delete or update on public\.audit_events/i.test(auditBody),
  'without it a row can be edited by anything holding service_role')
check('the immutability function raises rather than returning',
  /function public\.audit_events_immutable\(\)[\s\S]*?raise exception/i.test(auditBody))
check('audit_events has a select policy and NO insert/update/delete policy',
  /create policy "audit_events: select own"/i.test(auditBody) &&
  !/create policy "audit_events: (insert|update|delete)/i.test(auditBody),
  'a client-facing write policy would make the trail forgeable')

// -- 2b. grants: revoke names PUBLIC first, then each role ------------------
// ⚠️ `revoke ... from anon` alone leaves the PUBLIC grant (`=X/postgres`) standing
//    and has_*_privilege stays TRUE. This repo has been bitten twice.
const tableRevoke = /revoke all on table public\.audit_events from ([^;]+);/i.exec(auditBody)
check('the table revoke names public, anon, authenticated and service_role',
  !!tableRevoke && ['public', 'anon', 'authenticated', 'service_role']
    .every(r => new RegExp(`\\b${r}\\b`).test(tableRevoke[1])),
  tableRevoke ? `revoke list is: ${tableRevoke[1].trim()}` : 'no table revoke found')
check('anon is granted nothing on audit_events',
  !/grant [^;]*on table public\.audit_events to [^;]*\banon\b/i.test(auditBody))
check('authenticated may SELECT but never INSERT/UPDATE/DELETE',
  /grant select on table public\.audit_events to authenticated;/i.test(auditBody) &&
  !/grant [^;]*\b(insert|update|delete)\b[^;]*on table public\.audit_events to authenticated/i.test(auditBody))
const fnRevokes = auditBody.match(/revoke all on function public\.audit_\w+\([^)]*\) from ([^;]+);/gi) ?? []
check(`every audit function revokes EXECUTE by role name (${fnRevokes.length} found)`,
  fnRevokes.length >= 13 && fnRevokes.every(r => /\bpublic\b/.test(r) && /\banon\b/.test(r) &&
    /\bauthenticated\b/.test(r) && /\bservice_role\b/.test(r)),
  'a create-or-replace restores Supabase default EXECUTE grants; revoking by role name is the only removal')
check('audit_log is not granted back to any client role',
  !/grant execute on function public\.audit_log/i.test(auditBody),
  'a client-callable audit_log would let anyone forge an event')

// -- 2c. the migration proves its own grants --------------------------------
check('the migration asserts its own privileges with has_*_privilege',
  /has_table_privilege\('anon'/.test(auditBody) &&
  /has_function_privilege\('authenticated'/.test(auditBody) &&
  /raise exception/.test(auditBody),
  'house rule: a migration proves itself rather than hoping')

// -- 2d. no whole-row dumps -------------------------------------------------
check('no trigger dumps a whole row into the audit JSON',
  !/to_jsonb\((new|old)\)/i.test(auditBody) && !/row_to_json\((new|old)\)/i.test(auditBody),
  'before/after must be the MEANINGFUL changed values, never the entire row')

// -- 2e. no-op suppression --------------------------------------------------
// `update jobs set status = status` fires an UPDATE OF status trigger without
// changing anything. A no-op is not an act and must not mint an event.
// ⚠️ The body regex must span BOTH $function$ delimiters. An earlier version
//    stopped at the opening one, so it matched 0 functions and the check passed
//    vacuously — the same shape of bug as a comment satisfying a code assertion.
const auditFnBodies = auditBody.match(
  /create or replace function public\.audit_\w+\(\)[\s\S]*?\$function\$[\s\S]*?\$function\$/gi) ?? []
check(`the capture functions were actually found (${auditFnBodies.length})`,
  auditFnBodies.length >= 10,
  'the body regex matched nothing — every assertion below it would pass vacuously')

// audit_events_immutable is the immutability guard, not a capture function: it
// raises unconditionally and has no before/after to compare. Naming the exclusion
// keeps the rule honest instead of loosening it for everyone.
const captureFns = auditFnBodies
  .map(b => ({ name: (/function public\.(\w+)/i.exec(b) ?? [])[1] ?? '?', body: b }))
  .filter(f => f.name !== 'audit_events_immutable')
// Two shapes of change guard, both correct: a value that moved (IS DISTINCT FROM)
// or a stamp that appeared (null → not null, e.g. resolved_at).
const CHANGE_GUARD = /is distinct from|is null and new\.\w+ is not null/i
const unguarded = captureFns.filter(f => !CHANGE_GUARD.test(f.body))
check(`every capture function guards its branches against a no-op (${captureFns.length} functions)`,
  captureFns.length >= 10 && unguarded.length === 0,
  unguarded.map(f => f.name).join(', ') || 'without it a no-op update mints a false event')

// -- 2f. actor resolution is in the database, not the client ---------------
check('actor_type is constrained to the four kinds',
  /check \(actor_type in \('owner', 'worker', 'customer', 'system'\)\)/i.test(auditBody))
check('actor resolution reads auth.uid() rather than a parameter',
  /function public\.audit_actor_context\([\s\S]*?auth\.uid\(\)/i.test(auditBody),
  'a client-supplied actor is a forged actor')
check('the worker branch matches technicians.auth_user_id within the tenant',
  /technicians t\s+where t\.auth_user_id = v_uid and t\.user_id = p_tenant/i.test(auditBody),
  'without the tenant predicate a technician of another business could be named as the actor')
check('worker attribution does not require is_active',
  !/auth_user_id = v_uid and t\.user_id = p_tenant[\s\S]{0,80}is_active/i.test(auditBody),
  'a just-deactivated worker\'s in-flight write is still that worker\'s act — authorization is the RPCs\' job')

// -- 2g. ordering + dedup primitives ---------------------------------------
check('occurred_at uses clock_timestamp(), not now()',
  /"occurred_at"\s+timestamp with time zone default clock_timestamp\(\)/i.test(auditBody),
  'now() is transaction start and ties every row written in one transaction')
check('a monotonic seq gives a provably total order',
  /"seq"\s+bigint generated by default as identity/i.test(auditBody))
check('txid_current() is captured so one write folds into one act',
  /"txid"\s+bigint default txid_current\(\)/i.test(auditBody),
  'the dedup contract: merge what ONE WRITE caused, never two acts a second apart')

// -- 2h. one engine per responsibility -------------------------------------
// These already have their own audit tables. A second copy in audit_events would
// be a second answer to a settled question.
for (const [what, pattern] of [
  ['wages (wage_history owns it)', /hourly_wage/i],
  ['consent (consent_changes owns it)', /sms_opt_in|email_opt_in/i],
] as const) {
  check(`the audit triggers do not duplicate ${what}`, !pattern.test(auditBody),
    'one engine per responsibility — extend the existing table instead')
}

// -- 2i. app source: the customer projection is separate --------------------
console.log('')
const projection = existsSync('src/lib/audit/customerProjection.ts')
  ? APP('src/lib/audit/customerProjection.ts') : ''
check('a customer-facing projection module exists', projection.length > 0,
  'the customer portal must never receive the internal audit log')
if (projection) {
  const projBody = projection.replace(/\/\/[^\n\r]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  check('the projection is an ALLOW-list, not a deny-list',
    /CUSTOMER_SAFE_ACTIONS/.test(projBody) && /\.has\(/.test(projBody),
    'a deny-list leaks every action added after it was written')
  for (const internal of ['worker_access_disabled', 'worker_added', 'visit_price_changed', 'worker_crew_changed']) {
    check(`"${internal}" is not customer-visible`, !new RegExp(`'${internal}'`).test(projBody))
  }
  check('the projection never emits actor identity to a customer',
    !/actor_label|actor_id/.test(projBody),
    'a customer must not learn which worker did what')
  check('the projection filters by the asking customer as well as by action',
    /r\.customer_id === customerId/.test(projBody),
    'a token proves which TENANT, never which ROW — the customer must be checked here too')
}

// -- 2j. the read path is one engine, and it pages ---------------------------
const historyLib = existsSync('src/lib/audit/history.ts') ? APP('src/lib/audit/history.ts') : ''
check('there is one history loader', historyLib.length > 0)
if (historyLib) {
  // ⚠️ Strip comments FIRST. An earlier version of the OFFSET check failed on this
  //    file's own comment explaining why OFFSET is not used — the grep-your-own-
  //    subject trap. Every absence assertion below reads the stripped body.
  const code = stripTsComments(historyLib)
  check('the comment stripper works (else every absence check below is vacuous)',
    !/keyset-paginated/.test(code) && /supabase\.from\('audit_events'\)/.test(code),
    'the stripper removed too much or too little')
  check('history reads are keyset-paginated, never OFFSET',
    /\.lt\('seq'/.test(code) && !/\.range\(|\boffset\b/i.test(code),
    'OFFSET re-scans, and shifts rows between pages as new events arrive')
  check('a failed read is reported, not rendered as an empty history',
    /failed: true/.test(code) && /reason/.test(code),
    'supabase-js resolves failures with {data:null,error} — `data || []` says "nothing happened"')
  check('the loader never scopes by a caller-supplied tenant',
    !/\.eq\('user_id'/.test(code),
    'RLS scopes the rows; a client that can name a tenant can name someone else\'s')
  check('grouping is by txid, not by a time window',
    /txid/.test(code) && !/SETTLE_WINDOW|\b\d{4,}\s*\)?\s*(?:ms|milliseconds)/i.test(code),
    'the dedup contract is causal here — merge what ONE WRITE caused')
}

const panel = existsSync('src/components/audit/HistoryPanel.tsx')
  ? APP('src/components/audit/HistoryPanel.tsx') : ''
check('there is one history renderer', panel.length > 0)
if (panel) {
  check('a failed load says so instead of showing an empty state',
    /could not be loaded/.test(panel) && /Try again/.test(panel),
    'an empty history and an unreadable one are opposite messages')
  check('the row shows who, what and when without expanding',
    /actorName\(/.test(panel) && /actionLabel\(/.test(panel) && /<time/.test(panel))
  check('the timestamp never wraps under the text on a phone',
    /whitespace-nowrap[^"]*shrink-0|shrink-0[^"]*whitespace-nowrap/.test(panel))
  check('long values wrap instead of forcing a horizontal scroll',
    (panel.match(/break-words/g) ?? []).length >= 3,
    'a 430px viewport must not scroll sideways to read a change')
  check('the phrasing lives in the engine, not in the component',
    !/'Rescheduled|'Approved quote|'Disabled access/.test(panel),
    'a second vocabulary is a second thing to keep in sync')
  // ⭐ Measured at 375/390/430: the disclosure used to be a 48×16px control — a
  //   finger-sized miss on every phone. The whole row is the target now, which is
  //   why the button wraps the row body instead of sitting inside it.
  check('the expandable row is itself the tap target',
    /expandable \? \(\s*<button/.test(panel) && /w-full text-left/.test(panel),
    'a small inline disclosure fails a 44px tap target on every phone width')
}

// -- 2k. the business feed filters server-side -------------------------------
const activity = existsSync('src/app/dashboard/activity/page.tsx')
  ? APP('src/app/dashboard/activity/page.tsx') : ''
check('a business-wide activity surface exists', activity.length > 0)
if (activity) {
  check('its filters are passed to the query, not applied in the browser',
    /filter=\{filter\}/.test(activity) && !/\.filter\(e =>/.test(activity),
    'filtering in the browser means fetching every audit record ever')
  check('it offers the practical filters: who, what and when',
    /actorType/.test(activity) && /actions:/.test(activity) && /from:/.test(activity))
}
const modules = APP('src/lib/modules.ts')
check('the activity surface is registered, so the sidebar and ⌘K agree',
  /href: '\/dashboard\/activity'/.test(modules),
  'never hand-keep a nav list — the registry is what the sidebar, palette and manager read')

// ═══════════════════════════════════════════════════════════════════════════
// 3 · BEHAVIOUR, FROM ZERO  (an empty Postgres + this repository)
// ═══════════════════════════════════════════════════════════════════════════
async function behaviour() {
  console.log('\n■ 3. Behaviour — an empty Postgres built from this repository\n')

  const pglite = await loadPGlite()
  if (!pglite) {
    console.log('  ⏭  SKIPPED — PGlite is not installed (this is the behavioural proof).')
    console.log('     npm i -D @electric-sql/pglite && npm run verify:audit-trail')
    return
  }
  const { PGlite, contribs } = pglite
  const db = await PGlite.create({ extensions: contribs })

  const apply = async (label: string, rawSql: string) => {
    const { sql } = substitutePlatformStatements(rawSql)
    const statements = splitStatements(sql)
    let n = 0
    try {
      for (const s of statements) { await db.exec(s + ';'); n++ }
      return true
    } catch (e: any) {
      fail(`applied ${label}`, `statement ${n + 1}/${statements.length}: ${String(e.message).slice(0, 200)}\n      ` +
        (statements[n] ?? '').replace(/\s+/g, ' ').slice(0, 200))
      return false
    }
  }

  if (!await apply('platform prelude', readFileSync(join('scripts', 'schema', 'platform-prelude.sql'), 'utf8'))) return
  for (const f of readdirSync(join('supabase', 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
    if (!await apply(f, readFileSync(join('supabase', 'migrations', f), 'utf8'))) return
  }
  if (!baselineHasTable) {
    if (!await apply(auditSqlPath, readFileSync(auditSqlPath, 'utf8'))) return
  }
  ok('the audit schema applies from zero, on top of the baseline')

  const rows = async (sql: string, params: any[] = []) =>
    (await db.query(sql, params)).rows as any[]
  const one = async (sql: string, params: any[] = []) => (await rows(sql, params))[0]

  // ── actors ────────────────────────────────────────────────────────────────
  // The prelude models Supabase's JWT the way PostgREST presents it: auth.uid()
  // reads request.jwt.claim.sub, and request.jwt.claims carries the role. Setting
  // those is exactly what a real request does.
  const OWNER = '00000000-0000-0000-0000-00000000a001'
  const OTHER = '00000000-0000-0000-0000-00000000a002'
  const WORKER = '00000000-0000-0000-0000-00000000a003'

  const asOwner = async () => {
    await db.exec(`set request.jwt.claim.sub = '${OWNER}'`)
    await db.exec(`set request.jwt.claims = '{"role":"authenticated","sub":"${OWNER}"}'`)
  }
  const asWorker = async () => {
    await db.exec(`set request.jwt.claim.sub = '${WORKER}'`)
    await db.exec(`set request.jwt.claims = '{"role":"authenticated","sub":"${WORKER}"}'`)
  }
  const asCustomer = async () => {
    await db.exec(`set request.jwt.claim.sub = ''`)
    await db.exec(`set request.jwt.claims = '{"role":"anon"}'`)
  }
  const asService = async () => {
    await db.exec(`set request.jwt.claim.sub = ''`)
    await db.exec(`set request.jwt.claims = '{"role":"service_role"}'`)
  }
  const asCron = async () => {
    // No PostgREST claims at all — a direct database session (cron, MCP, psql).
    await db.exec(`set request.jwt.claim.sub = ''`)
    await db.exec(`set request.jwt.claims = ''`)
  }

  await db.exec(`insert into auth.users (id, email) values
    ('${OWNER}', 'owner@example.test'), ('${OTHER}', 'other@example.test'), ('${WORKER}', 'worker@example.test')`)

  // Seed both tenants. Written as the service role so seeding itself is
  // attributed to system and cannot be mistaken for the owner's acts.
  await asService()
  // A business_settings row is what makes this uid an owner in the app's own terms
  // (current_app_role()). The audit path does not consult it — it compares uid to
  // the row's tenant — but seeding it keeps the fixture a realistic tenant.
  await db.exec(`insert into public.business_settings (user_id, company_name) values ('${OWNER}', 'Fixture Yard')`)
  const cust = await one(`insert into public.customers (user_id, name, email, phone)
    values ('${OWNER}', 'Dana Reyes', 'dana@example.test', '+15550111') returning id`)
  const crewA = await one(`insert into public.crews (user_id, name) values ('${OWNER}', 'Crew A') returning id`)
  const crewB = await one(`insert into public.crews (user_id, name) values ('${OWNER}', 'Crew B') returning id`)
  const tech = await one(`insert into public.technicians (user_id, name, crew_id) values ('${OWNER}', 'Mike', $1) returning id`, [crewA.id])
  await db.exec(`update public.technicians set auth_user_id = '${WORKER}' where id = '${tech.id}'`)

  const events = async (where: string, params: any[] = []) =>
    rows(`select * from public.audit_events where ${where} order by seq`, params)
  const latest = async (action: string) =>
    (await rows(`select * from public.audit_events where action = $1 order by seq desc limit 1`, [action]))[0]

  // ── 3a. seeding attributed to system, not to the owner ───────────────────
  console.log('\n  — actor attribution —')
  const seeded = await latest('customer_added')
  eq('a service-role write is attributed to system', seeded?.actor_type, 'system')
  eq('  …and its source is service', seeded?.source, 'service')

  // ── 3b. the four actors ───────────────────────────────────────────────────
  await asOwner()
  const job = await one(`insert into public.jobs (user_id, customer_id, title, scheduled_date, start_time, status, price)
    values ('${OWNER}', $1, 'Weekly mow', date '2026-08-18', time '10:00', 'scheduled', 120) returning id`, [cust.id])
  const booked = await latest('visit_booked')
  eq('an owner mutation is attributed to owner', booked?.actor_type, 'owner')
  eq('  …with the owner uid as actor_id', booked?.actor_id, OWNER)
  eq('  …and source dashboard', booked?.source, 'dashboard')
  eq('  …and the entity label is a display reference', booked?.entity_label, 'Weekly mow')
  eq('  …and the customer is carried for per-customer history', booked?.customer_id, cust.id)

  await asWorker()
  await db.exec(`update public.jobs set status = 'in_progress', started_at = now() where id = '${job.id}'`)
  const started = await latest('visit_started')
  eq('a worker mutation is attributed to worker', started?.actor_type, 'worker')
  eq('  …with the worker name snapshotted at write time', started?.actor_label, 'Mike')
  eq('  …and source crew', started?.source, 'crew')

  await asCustomer()
  const req = await one(`insert into public.service_requests (user_id, customer_id, message, kind, from_portal)
    values ('${OWNER}', $1, 'Can we move to Thursday?', 'reschedule', true) returning id`, [cust.id])
  const received = await latest('request_received')
  eq('a portal (anon) mutation is attributed to customer', received?.actor_type, 'customer')
  eq('  …with the customer as actor_id', received?.actor_id, cust.id)
  eq('  …and source portal', received?.source, 'portal')
  eq('  …and the customer name snapshotted', received?.actor_label, 'Dana Reyes')

  await asCron()
  // service_requests_resolved_at_check: a resolved request may not still be 'new'.
  await db.exec(`update public.service_requests set status = 'handled', resolved_at = now() where id = '${req.id}'`)
  const resolved = await latest('request_resolved')
  eq('a direct database session is attributed to system', resolved?.actor_type, 'system')
  eq('  …and source db', resolved?.source, 'db')

  // ── 3c. before / after are meaningful, not whole rows ────────────────────
  console.log('\n  — before and after —')
  await asOwner()
  await db.exec(`update public.jobs set scheduled_date = date '2026-08-20', start_time = time '13:00' where id = '${job.id}'`)
  const moved = await latest('visit_rescheduled')
  eq('a reschedule records the date it moved from', moved?.before?.scheduled_date, '2026-08-18')
  eq('  …and the date it moved to', moved?.after?.scheduled_date, '2026-08-20')
  eq('  …and the time it moved from', moved?.before?.start_time, '10:00:00')
  eq('  …and the time it moved to', moved?.after?.start_time, '13:00:00')
  check('the event carries only the changed values, not the whole row',
    Object.keys(moved?.after ?? {}).length <= 3 && !('notes' in (moved?.after ?? {})),
    `after was: ${JSON.stringify(moved?.after)}`)

  await db.exec(`update public.jobs set crew_id = '${crewA.id}' where id = '${job.id}'`)
  await db.exec(`update public.jobs set crew_id = '${crewB.id}' where id = '${job.id}'`)
  const reassigned = await latest('visit_crew_changed')
  eq('a crew change names the crew it came from', reassigned?.before?.crew, 'Crew A')
  eq('  …and the crew it went to', reassigned?.after?.crew, 'Crew B')

  // ── 3d. a no-op is not an act ────────────────────────────────────────────
  const beforeNoop = (await events(`entity_id = $1`, [job.id])).length
  await db.exec(`update public.jobs set scheduled_date = scheduled_date, status = status where id = '${job.id}'`)
  eq('an update that changes nothing records nothing',
    (await events(`entity_id = $1`, [job.id])).length, beforeNoop)

  // ── 3e. mutations that arrive through OTHER triggers are still caught ────
  console.log('\n  — the paths nobody remembers —')
  // A jobs UPDATE that clears started_at is banked as a work session by
  // aa_bank_job_clock_session. Nothing inserted into job_work_sessions directly;
  // the audit trail must still see the work.
  await asWorker()
  await db.exec(`update public.jobs set status = 'in_progress', started_at = now() - interval '2 hours' where id = '${job.id}'`)
  const beforeBank = (await events(`action = 'work_recorded'`)).length
  await db.exec(`update public.jobs set started_at = null where id = '${job.id}'`)
  const banked = await events(`action = 'work_recorded'`)
  check('work banked by another trigger is still audited', banked.length > beforeBank,
    'the capture must sit downstream of every write path, including other triggers')
  eq('  …and is attributed to the worker who stopped', banked.at(-1)?.actor_type, 'worker')
  const paused = await latest('work_paused')
  check('stopping for the day is recorded without inventing a status', !!paused)

  // A payment insert flips the invoice to paid via recompute_invoice_paid. Two
  // events, ONE transaction — the dedup contract made structural.
  await asOwner()
  const inv = await one(`insert into public.invoices (user_id, customer_id, job_id, invoice_number, customer_name, amount, status)
    values ('${OWNER}', $1, $2, 'INV-0001', 'Dana Reyes', 120, 'unpaid') returning id`, [cust.id, job.id])
  await db.exec(`insert into public.payments (user_id, customer_id, invoice_id, amount, kind, method, provider, status)
    values ('${OWNER}', '${cust.id}', '${inv.id}', 120, 'payment', 'cash', 'manual', 'paid')`)
  const pay = await latest('payment_recorded')
  const paid = await latest('invoice_paid')
  check('a manual payment is recorded', !!pay)
  eq('  …with the amount and method', Number(pay?.after?.amount), 120)
  eq('  …naming cash', pay?.after?.method, 'cash')
  check('the invoice reaching paid is recorded too', !!paid)
  eq('  …and both share one txid, because ONE write caused them', pay?.txid, paid?.txid)

  // ── 3f. a failed mutation leaves NO event ────────────────────────────────
  console.log('\n  — atomicity —')
  const beforeRollback = (await events(`entity_id = $1`, [job.id])).length
  try {
    await db.exec('begin')
    await db.exec(`update public.jobs set scheduled_date = date '2026-09-09' where id = '${job.id}'`)
    await db.exec('rollback')
  } catch { await db.exec('rollback').catch(() => {}) }
  eq('a rolled-back reschedule leaves no event behind',
    (await events(`entity_id = $1`, [job.id])).length, beforeRollback)
  // to_char, not String(row.scheduled_date): a date column comes back as a JS Date
  // in the driver's local zone, so string-slicing it compares a rendering, not a value.
  const stillOn = await one(`select to_char(scheduled_date, 'YYYY-MM-DD') as d from public.jobs where id = '${job.id}'`)
  eq('  …and the visit really did not move', stillOn.d, '2026-08-20')

  // A write that the database refuses must not be narrated either.
  const beforeRefused = (await events(`entity_type = 'change_order'`)).length
  const co = await one(`insert into public.change_orders (user_id, job_id, customer_id, description, amount, status)
    values ('${OWNER}', '${job.id}', '${cust.id}', 'Extra hedge trimming', 200, 'draft') returning id, co_number`)
  await db.exec(`update public.change_orders set status = 'pending' where id = '${co.id}'`)
  await db.exec(`update public.change_orders set status = 'approved', decided_via = 'owner' where id = '${co.id}'`)
  const approved = await latest('change_order_approved')
  eq('a change order approval is recorded', approved?.entity_label, co.co_number)
  eq('  …naming how the decision was taken', approved?.after?.decided_via, 'owner')
  let refused = false
  try {
    await db.exec(`update public.change_orders set decided_via = 'portal' where id = '${co.id}'`)
  } catch { refused = true }
  check('the decided-row freeze still refuses a rewrite', refused,
    'Session 51\'s guarantee must survive the audit triggers')
  eq('  …and the refused write minted no event',
    (await events(`entity_type = 'change_order'`)).length, beforeRefused + 3)

  // ── 3g. recurrence + destructive actions ─────────────────────────────────
  console.log('\n  — schedule, recurrence, destruction —')
  const rec = await one(`insert into public.job_recurrences (user_id, customer_id, freq, interval_unit, interval_count, start_date)
    values ('${OWNER}', '${cust.id}', 'weekly', 'week', 1, date '2026-05-01') returning id`)
  await db.exec(`update public.job_recurrences set freq = 'biweekly', interval_count = 2 where id = '${rec.id}'`)
  const planChanged = await latest('plan_changed')
  eq('a cadence change records what it was', planChanged?.before?.freq, 'weekly')
  eq('  …and what it became', planChanged?.after?.freq, 'biweekly')
  await db.exec(`update public.job_recurrences set end_date = date '2026-10-15' where id = '${rec.id}'`)
  const ended = await latest('plan_changed')
  check('giving a season an end records the null it replaced',
    ended?.before !== null && 'end_date' in (ended?.before ?? {}) && ended?.before?.end_date === null,
    `before was: ${JSON.stringify(ended?.before)}`)
  eq('  …and the end date it gained', ended?.after?.end_date, '2026-10-15')

  // Deleting a visit cascades its work sessions, line items and photos. The
  // event must count them BEFORE the cascade takes them.
  const doomed = await one(`insert into public.jobs (user_id, customer_id, title, scheduled_date, status)
    values ('${OWNER}', '${cust.id}', 'One-off cleanup', date '2026-08-25', 'completed') returning id`)
  await db.exec(`insert into public.job_work_sessions (user_id, job_id, worked_on, minutes, workers, source)
    values ('${OWNER}', '${doomed.id}', date '2026-08-25', 90, 2, 'manual')`)
  await db.exec(`delete from public.jobs where id = '${doomed.id}'`)
  const deleted = await latest('visit_deleted')
  eq('deleting a visit records what the cascade destroyed', deleted?.meta?.cascade?.work_sessions, 1)
  eq('  …and the visit it was', deleted?.entity_label, 'One-off cleanup')
  check('  …and the event survives its subject',
    (await events(`entity_id = $1`, [doomed.id])).length >= 1,
    'the audit row must not be cascaded away with the row it describes')

  // ── 3h. worker accountability ────────────────────────────────────────────
  console.log('\n  — worker accountability —')
  await asOwner()
  await db.exec(`update public.technicians set is_active = false where id = '${tech.id}'`)
  const disabled = await latest('worker_access_disabled')
  eq('disabling a worker is recorded', disabled?.entity_label, 'Mike')
  eq('  …by the owner who did it', disabled?.actor_type, 'owner')
  await db.exec(`update public.technicians set crew_id = '${crewB.id}', is_active = true where id = '${tech.id}'`)
  const crewMoved = await latest('worker_crew_changed')
  eq('a crew move records the crew left', crewMoved?.before?.crew, 'Crew A')
  eq('  …and the crew joined', crewMoved?.after?.crew, 'Crew B')

  // ── 3i. immutability, over the roles a client actually has ───────────────
  console.log('\n  — immutability and isolation —')
  const anyEvent = await one(`select id from public.audit_events order by seq limit 1`)

  /**
   * Run something AS a PostgREST role, inside a transaction that is always rolled
   * back.
   *
   * ⚠️ The transaction is not tidiness — it is what makes SET LOCAL ROLE work.
   * `SET LOCAL` outside a transaction block is a documented NO-OP (it warns and
   * does nothing), so an earlier version of this helper ran every "as authenticated"
   * probe as the SUPERUSER: the forged insert succeeded, RLS was bypassed, and the
   * guard reported those as failures of the schema rather than of itself. A
   * privilege test that never changed privilege is worse than no test.
   */
  const asRole = async <T>(role: string, uid: string | null, fn: () => Promise<T>): Promise<T> => {
    await db.exec('begin')
    try {
      await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? ''])
      await db.query(`select set_config('request.jwt.claims', $1, true)`,
        [uid ? `{"role":"${role}","sub":"${uid}"}` : `{"role":"${role}"}`])
      await db.exec(`set local role ${role}`)
      return await fn()
    } finally {
      await db.exec('rollback').catch(() => {})
    }
  }

  /** True when the statement was REFUSED for that role. */
  const refusedFor = async (role: string, sql: string, uid: string | null = OWNER) => {
    try {
      await asRole(role, uid, () => db.query(sql))
      return false
    } catch {
      return true
    }
  }

  // Prove the harness can actually change role — otherwise every refusal below
  // could be a superuser silently succeeding at something a client cannot do.
  const whoami = await asRole('authenticated', OWNER, async () =>
    (await db.query(`select current_user as u`)).rows[0] as any)
  eq('the harness really switches role (otherwise every check below is vacuous)',
    whoami.u, 'authenticated')

  check('authenticated cannot INSERT an audit event',
    await refusedFor('authenticated',
      `insert into public.audit_events (user_id, actor_type, action, entity_type, source)
       values ('${OWNER}', 'system', 'forged', 'quote', 'db')`),
    'a client-forgeable event makes the whole trail worthless')
  check('authenticated cannot UPDATE an audit event',
    await refusedFor('authenticated', `update public.audit_events set action = 'rewritten' where id = '${anyEvent.id}'`))
  check('authenticated cannot DELETE an audit event',
    await refusedFor('authenticated', `delete from public.audit_events where id = '${anyEvent.id}'`))
  check('anon cannot read the audit trail at all',
    await refusedFor('anon', `select count(*) from public.audit_events`, null),
    'a customer must never reach the internal record')

  // Even the trusted role cannot rewrite history: the trigger raises for
  // everyone, so retention/erasure has to be a deliberate superuser act.
  check('not even service_role can edit an audit event',
    await refusedFor('service_role',
      `update public.audit_events set action = 'rewritten' where id = '${anyEvent.id}'`, null))

  let superuserRefused = false
  try { await db.query(`delete from public.audit_events where id = '${anyEvent.id}'`) }
  catch { superuserRefused = true }
  check('the table owner cannot delete one either — the trigger has no exemption', superuserRefused,
    'maintenance must be a deliberate DISABLE TRIGGER, never an accident')

  // ── 3j. tenant isolation ─────────────────────────────────────────────────
  const total = (await rows(`select id from public.audit_events`)).length
  const countAs = (uid: string) => asRole('authenticated', uid, async () =>
    Number((await db.query(`select count(*)::int as n from public.audit_events`)).rows[0].n))

  const visibleToStranger = await countAs(OTHER)
  check(`another tenant sees none of the ${total} events`, visibleToStranger === 0,
    `a stranger could read ${visibleToStranger}`)

  const visibleToOwner = await countAs(OWNER)
  check(`the owner sees their own history (${visibleToOwner} events)`, visibleToOwner === total,
    `owner saw ${visibleToOwner} of ${total}`)

  // A worker is `authenticated` too, and their uid is nobody's tenant key — so the
  // business-wide audit trail is invisible to them by construction, not by a filter
  // some future page could forget to apply.
  const visibleToWorker = await countAs(WORKER)
  check('a worker sees no business-wide audit history', visibleToWorker === 0,
    `a worker could read ${visibleToWorker}`)

  // A forged tenant id cannot be smuggled in: the FK and the actor context both
  // key off real ids, and RLS hides the result regardless.
  await asService()
  await db.exec(`insert into public.jobs (user_id, customer_id, title, scheduled_date, status)
    values ('${OTHER}', null, 'Stranger visit', date '2026-08-30', 'scheduled')`)
  const strangerEvent = await one(
    `select user_id from public.audit_events where entity_label = 'Stranger visit'`)
  eq('an event is filed under the tenant that owns the row', strangerEvent?.user_id, OTHER)

  // ── 3k. ordering and pagination ──────────────────────────────────────────
  console.log('\n  — ordering and pagination —')
  const ordered = await rows(`select seq, occurred_at from public.audit_events order by seq`)
  check('seq is strictly increasing', ordered.every((r, i) => i === 0 || Number(r.seq) > Number(ordered[i - 1].seq)))
  // ⚠️ NOT `check(..., true)`. An assertion that cannot fail is decoration; this
  //    repo has already shipped a tenancy check that a COMMENT satisfied. The real
  //    invariant is that seq is unique, so ORDER BY seq is a TOTAL order however
  //    many rows share a timestamp.
  const ties = await one(`select count(*)::int as n from (
    select occurred_at from public.audit_events group by occurred_at having count(*) > 1) t`)
  const dupSeq = await one(`select count(*)::int as n from (
    select seq from public.audit_events group by seq having count(*) > 1) t`)
  eq('seq is unique, so the order is total even when timestamps tie', dupSeq.n, 0)
  console.log(`  · ${ties.n} timestamp collision group(s) in this run — seq is what separates them`)
  const page1 = await rows(`select seq from public.audit_events order by seq desc limit 5`)
  const page2 = await rows(`select seq from public.audit_events where seq < $1 order by seq desc limit 5`, [page1.at(-1)!.seq])
  check('keyset pagination returns disjoint pages',
    page2.every(r => !page1.some(p => String(p.seq) === String(r.seq))))
  check('  …and never skips a row', Number(page1.at(-1)!.seq) - Number(page2[0]?.seq ?? 0) === 1 || page2.length === 0)

  const idx = await rows(`select indexname from pg_indexes where tablename = 'audit_events'`)
  check(`the pagination path is indexed (${idx.length} indexes)`,
    idx.some(i => i.indexname === 'audit_events_tenant_seq') &&
    idx.some(i => i.indexname === 'audit_events_entity'),
    'without (user_id, seq desc) the business feed degrades to a full scan')

  await db.close()
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 · LIVE  (the same rules, over real HTTP, against the fixture tenant)
// ═══════════════════════════════════════════════════════════════════════════
async function live() {
  console.log('\n■ 4. Live enforcement — over real HTTP\n')
  const t = await openFixtureTenant('verify:audit-trail')
  if (isSkipped(t)) { console.log(`  ⏭  SKIPPED (${t.skipped})`); return }

  const jobIds: string[] = []
  try {
    const probe = await t.db.from('audit_events').select('id').limit(1)
    if (probe.error && /does not exist|schema cache/i.test(probe.error.message)) {
      console.log('  ⏭  audit_events is not in production yet — apply supabase/pending/ first.')
      console.log(`     (${probe.error.message.slice(0, 90)})`)
      return
    }

    const customer = await t.fixtureCustomer()
    const ins = await t.db.from('jobs').insert({
      user_id: t.uid, customer_id: customer.id, title: t.tag('AUDIT'),
      scheduled_date: '2026-09-01', status: 'scheduled',
    }).select('id').single()
    check('the fixture visit was created', !ins.error, ins.error?.message)
    if (ins.data) jobIds.push(ins.data.id)

    if (ins.data) {
      await t.db.from('jobs').update({ scheduled_date: '2026-09-03' }).eq('id', ins.data.id)
      const evs = await t.db.from('audit_events').select('*')
        .eq('entity_id', ins.data.id).order('seq')
      check('the mutations were recorded', !evs.error && (evs.data?.length ?? 0) >= 2,
        evs.error?.message ?? `saw ${evs.data?.length ?? 0} events`)
      const move = evs.data?.find(e => e.action === 'visit_rescheduled')
      eq('a real HTTP reschedule records the date it moved from', move?.before?.scheduled_date, '2026-09-01')
      eq('  …and is attributed to the signed-in owner', move?.actor_type, 'owner')
      eq('  …with the tenant that owns the row', move?.user_id, t.uid)

      const upd = await t.db.from('audit_events').update({ action: 'rewritten' }).eq('id', move?.id)
      check('an audit row cannot be rewritten over the API', !!upd.error,
        'PostgREST accepted an UPDATE on audit_events')
      const del = await t.db.from('audit_events').delete().eq('id', move?.id)
      const stillThere = await t.db.from('audit_events').select('id').eq('id', move?.id)
      check('nor deleted', !!del.error || (stillThere.data?.length ?? 0) === 1,
        'the row disappeared')

      const forge = await t.db.from('audit_events').insert({
        user_id: t.uid, actor_type: 'system', action: 'forged', entity_type: 'quote', source: 'db',
      })
      check('a client cannot inject a fake system event', !!forge.error, 'the insert was accepted')

      const stranger = await t.db.from('audit_events').insert({
        user_id: '00000000-0000-0000-0000-0000000000ff',
        actor_type: 'owner', action: 'forged', entity_type: 'quote', source: 'db',
      })
      check('nor forge one against another tenant', !!stranger.error)

      const anonRead = await t.anon.from('audit_events').select('id').limit(1)
      check('an unauthenticated client reads nothing',
        !!anonRead.error || (anonRead.data?.length ?? 0) === 0,
        `anon read ${anonRead.data?.length} row(s)`)
    }
  } catch (e: any) {
    fail('the live half completed', String(e?.message ?? e).slice(0, 200))
  } finally {
    if (jobIds.length) await t.db.from('jobs').delete().in('id', jobIds)
    await t.close()
    const residue = await fixtureResidue(t)
    check('the fixture tenant is left clean',
      Object.entries(residue).every(([, n]) => n === 0), JSON.stringify(residue))
  }
}

behaviour()
  .then(live)
  .then(() => {
    console.log(`\n${'─'.repeat(72)}`)
    console.log(failures === 0
      ? '✅ AUDIT TRAIL VERIFIED — who, what, when, before and after, and it cannot be edited.'
      : `❌ ${failures} check(s) failed`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch(err => { console.error(err); process.exit(1) })
