// ── Session 73: the offline layer, proven against the REAL landed RPCs ───────
//   npx tsx scripts/s73-offline-proof.ts            (prove; leaves fixture up)
//   npx tsx scripts/s73-offline-proof.ts --cleanup  (remove the fixture, measure)
//
// ⚠️ THIS WRITES TO THE PRODUCTION TENANT, reusing the Session 61 field fixture
// (scripts/.s61-fixture.json) under the same explicit owner authorisation. It
// touches no real employee, customer, job, wage or setting; every row it makes
// carries S61's fixture tag and is removed by --cleanup, which PRINTS A MEASURED
// residue count rather than claiming success.
//
// ⭐⭐ WHY THIS EXISTS AND THE UNIT GUARD DOES NOT REPLACE IT.
// verify:field-reliability drives lib/field/visitIntent with HAND-WRITTEN facts.
// That proves the engine's logic and nothing about the database. This drives the
// SAME engine against what `crew_set_visit_status` actually returns on the
// landed S65 schema — so if the RPC's shape, its version guard, or its
// work-session banking ever drifts from what the engine assumes, it fails HERE.
// The unit guard says "the engine is right". This says "the engine is right
// ABOUT THIS DATABASE".
//
// ⭐ THE HEADLINE: the ambiguous Start. We deliberately replay the identical
// call — same base version, same client-minted started_at — exactly as a phone
// would after a lost response, and require that (a) the RPC refuses the second
// write, (b) the engine reads that refusal as `applied` rather than a conflict,
// and (c) the database holds exactly ONE work session afterwards.
//
// ⭐ WORKER B, not A. S61's run left an auth account on `+s61a@` that cannot be
// deleted without the service role, so its invite correctly refuses to re-bind
// it (the account-takeover guard). Worker B is on the same fixture roster with
// no login yet, so the CANONICAL invite door works — no back-door user, which
// is an explicit owner ban.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { reconcileVisitIntent, freezeIntent, type VisitIntent } from '../src/lib/field/visitIntent'
import { endProcess } from './lib/shutdown'

for (const f of ['.env.local', '../../edgehq-main/.env.local']) {
  if (!existsSync(f)) continue
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
  }
}
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const OWNER_EMAIL = process.env.PORTAL_RPC_OWNER_EMAIL!
const OWNER_PW = process.env.PORTAL_RPC_OWNER_PASSWORD!
const BASE = process.env.BASE || 'https://app.edgehq.ca'
if (!URL_ || !ANON || !OWNER_EMAIL || !OWNER_PW) { console.error('missing env'); process.exit(1) }

const S61_STATE = 'scripts/.s61-fixture.json'
const S73_STATE = 'scripts/.s73-fixture.json'
const mailboxB = OWNER_EMAIL.replace(/@/, '+s61b@')

let pass = 0, fail = 0
const ok = (n: string, x = '') => { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
const no = (n: string, d = '') => { fail++; console.log(`  ❌ ${n}${d ? '\n       ' + d : ''}`) }
const t = (n: string, c: boolean, d = '') => { c ? ok(n) : no(n, d); return c }

const anonClient = () => createClient(URL_, ANON, { auth: { persistSession: false } })

/** An owner session held as COOKIES, which is what the app's routes read. */
function browserSession() {
  const jar = new Map<string, string>()
  const sb = createServerClient(URL_, ANON, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list: { name: string; value: string }[]) => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  })
  return { sb, header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') }
}
async function signIn(email: string, pw: string) {
  const client = anonClient()
  const { error } = await client.auth.signInWithPassword({ email, password: pw })
  return { client, error }
}

interface S61State {
  crewId: string; techA: string; techB: string; customerId: string; propertyId: string
  jobCrew: string; jobDirectA: string; jobDirectB: string; jobUnassigned: string
  cleaned?: boolean
}
interface S73State { workerPwB?: string; acceptedB?: boolean }

const readState = <T,>(p: string): T => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}) as T
const s73: S73State = readState<S73State>(S73_STATE)
const saveS73 = () => writeFileSync(S73_STATE, JSON.stringify(s73, null, 2))

async function main() {
  const st = readState<S61State>(S61_STATE)
  if (!st.jobDirectB || st.cleaned) {
    console.error('\n⛔ No live S61 fixture. Run: node scripts/s61-field-proof.mjs --keep\n')
    return 1
  }

  console.log(`\n═══ S73 offline proof — ${BASE} ═══`)
  const owner = await signIn(OWNER_EMAIL, OWNER_PW)
  if (owner.error) { no('owner sign-in', owner.error.message); return 1 }
  ok('owner signed in')
  const db = owner.client

  if (process.argv.includes('--cleanup')) return cleanup(db, st)

  // ⭐⭐ DOES THE FIXTURE STILL EXIST? The check above reads the STATE FILE, which
  // only says the ids were recorded once — not that the rows are still there.
  // They belong to Session 61 and live in a shared production tenant, so another
  // session's cleanup can remove them at any moment, and it did: mid-way through
  // this session's browser run the four visits vanished and the next run showed
  // "Nothing booked today". Every positive assertion then fails while every
  // negative one passes, which reads EXACTLY like a catastrophic visibility
  // regression and is nothing of the kind.
  //
  // Third time this session that assuming a precondition beat establishing one
  // (stale date, leaked roster state, and now deleted rows). Fail fast, name the
  // remedy, and never let a missing fixture masquerade as a broken product.
  const { data: live, error: liveErr } = await db.from('jobs')
    .select('id').in('id', [st.jobCrew, st.jobDirectA, st.jobDirectB, st.jobUnassigned].filter(Boolean))
  if (liveErr) { no('check the fixture is still live', liveErr.message); return 1 }
  if ((live || []).length < 4) {
    console.error(`\n⛔ The S61 fixture visits are GONE (${(live || []).length}/4 still present).`)
    console.error('   Another session cleaned them up. Recreate, then re-run this proof:\n')
    console.error('     node scripts/s61-field-proof.mjs --keep\n')
    return 1
  }
  ok('the S61 fixture is still live', `${(live || []).length}/4 visits present`)

  // ── 1. Worker B through the canonical invite door ─────────────────────────
  console.log('\n── 1. Worker B via the canonical S64 invite ───────────────────')
  let pwB = s73.workerPwB
  if (!s73.acceptedB) {
    // ⚠️ The route authenticates by SESSION COOKIE, exactly as the browser does —
    // a Bearer token gets 401 'not-owner'. Same helper shape S61 uses.
    const ob = browserSession()
    const { error: obErr } = await ob.sb.auth.signInWithPassword({ email: OWNER_EMAIL, password: OWNER_PW })
    if (obErr) { no('owner cookie session', obErr.message); return 1 }
    const res = await fetch(`${BASE}/api/crew/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ob.header() },
      body: JSON.stringify({ technicianId: st.techB, email: mailboxB }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.setupUrl) {
      no('invite worker B', `${res.status} ${body.reason || ''} ${body.message || ''}`)
      console.log('       (B already has a login? then set S73_WORKER_PW_B and re-run)')
      if (process.env.S73_WORKER_PW_B) { pwB = process.env.S73_WORKER_PW_B; s73.workerPwB = pwB; s73.acceptedB = true; saveS73() }
      else return 1
    } else {
      ok('invite issued through /api/crew/invite', body.created ? 'account created' : 'account reused')
      // Redeemed exactly as CrewWelcomeForm does: verifyOtp(token_hash) → password.
      // .pop() is string | undefined. An absent final segment means the invite
      // link is not the shape we redeem — say so rather than decoding an empty
      // token and failing later with a confusing auth error.
      const seg = String(body.setupUrl).split('/').pop()
      if (!seg) { no('read the setup token', 'setupUrl had no final path segment'); return 1 }
      const token = decodeURIComponent(seg)
      const c = anonClient()
      const { data: v, error: vErr } = await c.auth.verifyOtp({ token_hash: token, type: 'recovery' })
      if (vErr || !v.user) { no('redeem the setup link', vErr?.message || 'no user'); return 1 }
      pwB = `S73-fixture-${Math.floor(Math.random() * 1e9)}`
      const { error: uErr } = await c.auth.updateUser({ password: pwB })
      if (uErr) { no('set worker B password', uErr.message); return 1 }
      s73.workerPwB = pwB; s73.acceptedB = true; saveS73()
      ok('worker B accepted the invite and set a password', 'same path as /crew/welcome')
    }
  } else ok('worker B already provisioned (resumed)')

  const w = await signIn(mailboxB, pwB!)
  if (w.error) { no('worker B sign-in', w.error.message); return 1 }
  ok('worker B signed in')
  const wc = w.client

  // ⭐⭐ RE-LINK IF THE ROSTER WAS REBUILT. `acceptedB` in the state file only
  // records that this login accepted an invite ONCE. When another session
  // recreates the S61 fixture, the technician ROW is new and this auth account
  // is linked to nothing — so current_app_role() answers 'none' and every crew
  // read below returns empty, which looks like a total access regression and is
  // just a rebuilt fixture. (The fourth and last time this session that a
  // recorded fact was mistaken for a live one.)
  //
  // The remedy is the door the product itself points at when /api/crew/invite
  // refuses to re-bind an existing address — that refusal IS the
  // account-takeover guard, and re-binding is the attack it stops. So: the owner
  // mints a join code, and the worker redeems it themselves. ⛔ No back-door
  // user, no direct auth manipulation, no fresh mailbox per run.
  // ⚠️⚠️ "IS THIS ACCOUNT CREW?" IS A PROXY, AND IT LIED. A rebuilt fixture
  // leaves the OLD technician row active and still linked to this login, while
  // the new visits point at the NEW row. current_app_role() then answers 'crew'
  // — perfectly true, about the wrong row — and every positive assertion below
  // fails while every negative one passes. That reads as a total access
  // regression and is a stale link.
  //
  // ⭐ So assert the SPECIFIC fact: which technician row is this login actually
  // bound to. Never the proxy.
  const { data: me } = await wc.auth.getUser()
  const authUid = me.user?.id
  // ⚠️ ANY bound row, active or not. crew_redeem_invite refuses while this
  // account holds ANY link — it does not check is_active or archived_at — so a
  // lookup that filtered those out would report "unlinked", walk into redeem,
  // and fail with "already linked to an employee" having just proved otherwise.
  // Match what actually blocks, not what looks tidy.
  const linkedRow = async () => (await db.from('technicians')
    .select('id, name').eq('auth_user_id', authUid!)
    .maybeSingle()).data as { id: string; name: string } | null

  let linked = await linkedRow()
  if (linked && linked.id !== st.techB) {
    // ⛔ GUARDED: only ever a row this fixture created. The name check is the
    // whole safety of this branch — archiving is an owner action on their own
    // roster, and it must be impossible for it to touch a real employee.
    if (!/S61 FIELD FIXTURE/i.test(linked.name || '')) {
      no('refusing to touch a non-fixture roster row', `${linked.id} "${linked.name}"`)
      return 1
    }
    // ⭐ THE CANONICAL UNLINK: crew_revoke_access, the owner-callable RPC S64
    // ships for exactly this. An account may hold only ONE link, and
    // crew_redeem_invite refuses while one exists — it does NOT care that the
    // row is archived, so deactivating alone leaves the account stuck ("this
    // account is already linked to an employee"). ⛔ The alternative, writing
    // auth_user_id = null by hand, would be inventing a second unlink path
    // beside the product's own.
    const { error: rvErr } = await db.rpc('crew_revoke_access', { p_technician_id: linked.id })
    if (rvErr) { no('revoke the stale row\'s access', rvErr.message); return 1 }
    const { error: aErr } = await db.from('technicians')
      .update({ is_active: false, archived_at: new Date().toISOString() }).eq('id', linked.id)
    if (aErr) { no('retire the stale fixture roster row', aErr.message); return 1 }
    ok('retired the stale fixture roster row', `${linked.id} — crew_revoke_access + archived`)
    linked = null
  }

  if (!linked) {
    // The door the product points at when /api/crew/invite refuses to re-bind an
    // existing address — that refusal IS the account-takeover guard. The owner
    // mints a code; the worker redeems it themselves. ⛔ No back-door user.
    const { data: code, error: cErr } = await db.rpc('crew_issue_invite',
      { p_technician_id: st.techB, p_hours: 1 })
    if (cErr || !code?.code) { no('owner mints a join code', cErr?.message || 'no code'); return 1 }
    const { error: rErr } = await wc.rpc('crew_redeem_invite', { p_code: code.code })
    if (rErr) { no('worker B redeems the join code', rErr.message); return 1 }
    ok('⭐ worker B joined via the canonical join code', 'they accepted it themselves')
    linked = await linkedRow()
  }

  t('⭐ worker B is bound to THIS fixture\'s roster row', linked?.id === st.techB,
    `linked=${linked?.id} expected=${st.techB}`)
  const role = (await wc.rpc('current_app_role')).data
  t('worker B resolves as crew, not owner', role === 'crew', `got ${role}`)

  // ── 2. What this worker may see ───────────────────────────────────────────
  console.log('\n── 2. Assignment visibility (S65 crew XOR by-name) ────────────')
  const today = new Date(); today.setMinutes(today.getMinutes() - today.getTimezoneOffset())
  const todayISO = today.toISOString().slice(0, 10)

  // ⭐⭐ RE-DATE THE FIXTURE ONTO TODAY, every run.
  //
  // The fixture visits are created once and REUSED across runs, so on any day
  // after the one they were made they sit in the past — and `crew_day(today)`
  // correctly returns nothing. Every positive assertion below then fails while
  // every negative one passes, which reads exactly like a catastrophic
  // visibility regression and is in fact a stale fixture. (It cost a full
  // investigation on the first resumed run: the shapes were all perfect —
  // jobCrew crew-set/tech-null, the direct pair tech-set, unassigned both-null
  // — the rows were simply dated three days earlier.)
  //
  // ⛔ This does NOT weaken anything. It moves the fixture's own rows to the day
  // being asserted on; the ASSIGNMENT columns, which are what section 2 tests,
  // are untouched. Without it the proof is only honest on the day it was
  // written, which is not a proof.
  const fixtureJobs = [st.jobCrew, st.jobDirectA, st.jobDirectB, st.jobUnassigned].filter(Boolean)
  const { error: dateErr } = await db.from('jobs')
    .update({ scheduled_date: todayISO }).in('id', fixtureJobs)
  if (dateErr) { no('re-date the fixture visits onto today', dateErr.message); return 1 }
  ok('fixture visits re-dated onto today', todayISO)

  // ⭐ ESTABLISH THE PRECONDITION, don't assume it. Section 2 tests a CREWLESS
  // worker first and then adds them to the crew — but that second step MUTATES
  // the roster and the script never put it back, so every re-run began with B
  // already on the crew and "…nor the crew's work, while they are on no crew"
  // failed while describing a state that no longer existed.
  //
  // A proof that only holds on its first execution is not a proof. Same lesson
  // as the stale fixture date directly above: reusable fixtures must be RESET
  // to the documented starting state, never inherited from the last run.
  const { error: crewlessErr } = await db.from('technicians')
    .update({ crew_id: null }).eq('id', st.techB)
  if (crewlessErr) { no('reset worker B to crewless', crewlessErr.message); return 1 }
  ok('worker B reset to CREWLESS (the precondition section 2 asserts on)')

  const { data: dayRaw, error: dErr } = await wc.rpc('crew_day', { p_date: todayISO })
  if (dErr) { no('crew_day', dErr.message); return 1 }
  const day = dayRaw as { stops: Record<string, unknown>[] } | null
  if (!day) { no('crew_day returned null (worker not active?)'); return 1 }
  const ids = new Set((day.stops || []).map(s => String(s.id)))
  t('⭐ direct-to-me assignment is visible', ids.has(st.jobDirectB))
  t('⛔ another worker\'s by-name visit stays invisible', !ids.has(st.jobDirectA))
  // ⭐⭐ THE NULL-VS-NULL TRAP, proven on the real predicate. Worker B is
  // CREWLESS (crew_id null) and the unassigned visit also has crew_id null — a
  // naive `job.crew_id = worker.crew_id` compare would match null to null and
  // hand this worker somebody else's work ([[worker-access-privacy-v1]]).
  t('⛔⛔ a CREWLESS worker is not handed unassigned work (null ≠ null)',
    !ids.has(st.jobUnassigned))
  t('⛔ …nor the crew\'s work, while they are on no crew', !ids.has(st.jobCrew))

  // Now put B on the crew through the owner, and prove the crew path for the
  // SAME worker — before/after on one identity is a stronger test than two.
  const { error: joinErr } = await db.from('technicians').update({ crew_id: st.crewId }).eq('id', st.techB)
  if (joinErr) { no('owner adds B to the crew', joinErr.message); return 1 }
  const { data: day2raw } = await wc.rpc('crew_day', { p_date: todayISO })
  const ids2 = new Set((((day2raw as { stops?: Record<string, unknown>[] })?.stops) || []).map(s => String(s.id)))
  t('⭐ crew assignment becomes visible once they are ON the crew', ids2.has(st.jobCrew))
  t('⭐ …and the by-name visit still is too (crew XOR by-name, both land)', ids2.has(st.jobDirectB))
  t('⛔ …while unassigned work STILL stays invisible', !ids2.has(st.jobUnassigned))
  t('⛔ …and another worker\'s by-name visit still does', !ids2.has(st.jobDirectA))

  // ⭐ The live shape the cache projects. A field that silently stops arriving
  // caches as null and reads as "this visit has no checklist" — the exact
  // regression S65 caused once already for `checklist`.
  const sample = (day.stops || []).find(s => String(s.id) === st.jobDirectB) as Record<string, unknown> | undefined
  if (!sample) { no('direct stop present in payload'); return 1 }
  for (const k of ['id', 'status', 'started_at', 'completed_at', 'updated_at', 'actual_minutes', 'notes', 'customer', 'property']) {
    t(`crew_day still returns \`${k}\``, k in sample, `LIVE payload keys: ${Object.keys(sample).join(',')}`)
  }
  t('⭐ crew_day returns `personal` (the cache now carries it)', 'personal' in sample,
    `LIVE keys: ${Object.keys(sample).join(',')}`)
  t('⭐ crew_day returns `checklist` (lost once before — [[crew-day-checklist-regression-s65]])',
    'checklist' in sample, `LIVE keys: ${Object.keys(sample).join(',')}`)

  // ── 3. ⭐⭐ THE AMBIGUOUS START ────────────────────────────────────────────
  console.log('\n── 3. Start Work: server committed, response lost, worker retries ──')
  const jobId = st.jobDirectB
  const base = String(sample.updated_at)
  const startedAt = new Date().toISOString()          // ⭐ minted ONCE, as the phone does
  const intent: VisitIntent = freezeIntent({
    kind: 'start', jobId, baseUpdatedAt: base, token: 'proof-1',
    next: { status: 'in_progress', started_at: startedAt, completed_at: null, actual_minutes: null },
  })

  const call = () => wc.rpc('crew_set_visit_status', {
    p_job_id: jobId, p_status: 'in_progress', p_base_updated_at: base,
    p_started_at: startedAt, p_completed_at: null, p_actual_minutes: null,
  })

  const { data: first, error: e1 } = await call()
  if (e1) { no('first Start', e1.message); return 1 }
  t('the first Start is accepted', (first as { ok?: boolean })?.ok === true, JSON.stringify(first))

  // The retry: byte-identical, exactly as a queued replay would send it.
  const { data: second, error: e2 } = await call()
  if (e2) { no('replayed Start', e2.message); return 1 }
  t('⭐ the RPC REFUSES the replayed write (version guard held)',
    (second as { ok?: boolean })?.ok === false, JSON.stringify(second))

  // …and the engine must read that refusal as APPLIED, not as a conflict.
  const after = await reread(wc, todayISO, jobId)
  const verdict = reconcileVisitIntent(intent, after)
  t('⭐⭐ the engine reads the landed write as APPLIED, not a conflict',
    verdict.kind === 'applied', `got ${verdict.kind} · server=${JSON.stringify(after)}`)
  // ⚠️ COMPARE THE INSTANT, not the text — the very trap this run exposed in the
  // engine, which this assertion then fell into itself. The client sent `…042Z`
  // and the timestamptz came back `…042+00:00`: one moment, two spellings. A
  // `===` here would fail forever while the product is perfectly correct, and
  // "the proof is red" is how a correct product gets 'fixed' into a broken one.
  t('…and the server holds OUR client-minted started_at',
    after?.started_at != null && Date.parse(after.started_at) === Date.parse(startedAt),
    `${after?.started_at} vs ${startedAt}`)

  // The database itself: exactly one clock is running, and no session banked yet.
  const { data: openSessions } = await db.from('job_work_sessions').select('id').eq('job_id', jobId)
  t('⭐⭐ no duplicate work session was banked by the retry',
    (openSessions || []).length === 0, `${(openSessions || []).length} session(s) after a double Start`)

  // ── 4. Done for today ≠ Complete ──────────────────────────────────────────
  console.log('\n── 4. Two exits from the clock ────────────────────────────────')
  const cur1 = await reread(wc, todayISO, jobId)
  const { data: stopRes } = await wc.rpc('crew_set_visit_status', {
    p_job_id: jobId, p_status: 'in_progress', p_base_updated_at: cur1!.updated_at,
    p_started_at: null, p_completed_at: null, p_actual_minutes: null,
  })
  t('“Done for today” is accepted', (stopRes as { ok?: boolean })?.ok === true)
  const afterStop = await reread(wc, todayISO, jobId)
  t('⭐ it banks the day but LEAVES THE VISIT OPEN',
    afterStop?.status === 'in_progress' && afterStop?.started_at === null,
    JSON.stringify(afterStop))
  const { data: banked } = await db.from('job_work_sessions').select('id,minutes').eq('job_id', jobId)
  t('⭐ exactly ONE work session is banked (not two)',
    (banked || []).length === 1, `${(banked || []).length} session(s)`)

  // The stop_for_day intent reconciles as applied off the real row.
  const stopIntent: VisitIntent = freezeIntent({
    kind: 'stop_for_day', jobId, baseUpdatedAt: cur1!.updated_at, token: 'proof-2',
    next: { status: 'in_progress', started_at: null, completed_at: null, actual_minutes: null },
  })
  t('⭐ a replayed “Done for today” reconciles as APPLIED',
    reconcileVisitIntent(stopIntent, afterStop).kind === 'applied')

  // ── 5. Foreign work is refused at the WRITE door too ──────────────────────
  console.log('\n── 5. A write against work that is not mine ───────────────────')
  const { data: foreign } = await wc.rpc('crew_set_visit_status', {
    p_job_id: st.jobDirectA, p_status: 'in_progress', p_base_updated_at: new Date().toISOString(),
    p_started_at: new Date().toISOString(), p_completed_at: null, p_actual_minutes: null,
  })
  t('⛔ starting another worker\'s by-name visit is refused',
    !(foreign as { ok?: boolean })?.ok, JSON.stringify(foreign))
  const { data: unassigned } = await wc.rpc('crew_set_visit_status', {
    p_job_id: st.jobUnassigned, p_status: 'in_progress', p_base_updated_at: new Date().toISOString(),
    p_started_at: new Date().toISOString(), p_completed_at: null, p_actual_minutes: null,
  })
  t('⛔ starting unassigned work is refused',
    !(unassigned as { ok?: boolean })?.ok, JSON.stringify(unassigned))

  // ── 6. Reset the visit so the browser half starts clean ───────────────────
  const cur2 = await reread(wc, todayISO, jobId)
  await db.from('jobs').update({ status: 'scheduled', started_at: null, completed_at: null, actual_minutes: null })
    .eq('id', jobId)
  await db.from('job_work_sessions').delete().eq('job_id', jobId)
  ok('visit reset for the browser half', `was ${cur2?.status}`)

  console.log(`\n── ${pass} passed, ${fail} failed ──`)
  if (!fail) {
    console.log(`\n⭐ fixture LEFT UP for the CDP run.`)
    console.log(`   worker: ${mailboxB}`)
    console.log(`   then:   npx tsx scripts/s73-offline-proof.ts --cleanup\n`)
  }
  return fail ? 1 : 0
}

/** The narrow slice the engine compares, read through the worker's own RPC. */
async function reread(wc: SupabaseClient, dateISO: string, jobId: string) {
  const { data } = await wc.rpc('crew_day', { p_date: dateISO })
  const d = data as { stops: Record<string, unknown>[] } | null
  const s = (d?.stops || []).find(x => String(x.id) === jobId)
  return s
    ? {
        status: s.status as 'scheduled' | 'in_progress' | 'completed' | 'cancelled',
        started_at: (s.started_at as string) ?? null,
        completed_at: (s.completed_at as string) ?? null,
        updated_at: String(s.updated_at),
      }
    : null
}

async function cleanup(db: SupabaseClient, st: S61State) {
  console.log('\n── Cleanup (measured, not claimed) ────────────────────────────')
  const jobs = [st.jobCrew, st.jobDirectA, st.jobDirectB, st.jobUnassigned].filter(Boolean)
  for (const j of jobs) await db.from('job_work_sessions').delete().eq('job_id', j)
  await db.from('jobs').delete().in('id', jobs)
  await db.from('properties').delete().eq('id', st.propertyId)
  await db.from('customers').delete().eq('id', st.customerId)
  await db.from('technicians').delete().in('id', [st.techA, st.techB].filter(Boolean))
  await db.from('crews').delete().eq('id', st.crewId)

  const { data: jLeft } = await db.from('jobs').select('id').in('id', jobs)
  const { data: cLeft } = await db.from('customers').select('id').eq('id', st.customerId)
  const { data: tLeft } = await db.from('technicians').select('id').in('id', [st.techA, st.techB].filter(Boolean))
  const { data: crLeft } = await db.from('crews').select('id').eq('id', st.crewId)
  const residue = (jLeft?.length || 0) + (cLeft?.length || 0) + (tLeft?.length || 0) + (crLeft?.length || 0)
  t('fixture residue is zero', residue === 0, `${residue} row(s) still present`)
  console.log('  ⚠️ the two auth mailboxes cannot be deleted without the service role;')
  console.log('     they hold no roster row now, so they resolve as \'none\' and see nothing.')
  writeFileSync(S61_STATE, JSON.stringify({ cleaned: true }, null, 2))
  writeFileSync(S73_STATE, JSON.stringify({ cleaned: true }, null, 2))
  console.log(`\n── ${pass} passed, ${fail} failed ──\n`)
  return fail ? 1 : 0
}

main().then(code => endProcess(code ?? 0)).catch(e => { console.error(e); return endProcess(1) })
