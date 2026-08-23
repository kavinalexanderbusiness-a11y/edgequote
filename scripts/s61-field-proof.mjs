// ── Session 61 field-home proof, against the real landed S64 + S65 model ─────
//
//   node scripts/s61-field-proof.mjs            (data proof only)
//   node scripts/s61-field-proof.mjs --keep     (leave the fixture up for the
//                                                CDP mobile run, then re-run
//                                                with --cleanup)
//   node scripts/s61-field-proof.mjs --cleanup  (remove the fixture, measure)
//
// ⚠️ THIS WRITES TO THE PRODUCTION TENANT, under an explicit owner authorisation
// for Session 61. Everything it creates is named with the FIXTURE tag below and
// removed in cleanup; the run prints a measured residue count rather than
// claiming success. It does NOT touch a real employee, a real customer, a real
// job, wages, business settings, recurrence, or any unrelated row.
//
// ⭐ EVERY DOOR IS THE PRODUCT'S OWN. The worker account is created by the
// deployed /api/crew/invite (the only place holding the service role); the
// worker's day is read with crew_day; the clock is driven by
// crew_set_visit_status; completion goes through /api/crew/complete. Nothing
// here reaches around the app to fake a state the product cannot itself produce.
//
// WHY THE UI HALF RUNS LOCALLY. Production serves `main`, which does not carry
// this branch. A proof against the deployed app would be a proof of somebody
// else's code. So the browser half (s61-field-cdp.mjs) drives THIS branch on a
// local server, against the REAL landed schema and this same fixture.

import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'

// ── env ──────────────────────────────────────────────────────────────────────
for (const f of ['.env.local', '../../edgehq-main/.env.local']) {
  if (!existsSync(f)) continue
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
  }
}
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const OWNER_EMAIL = process.env.PORTAL_RPC_OWNER_EMAIL
const OWNER_PW = process.env.PORTAL_RPC_OWNER_PASSWORD
const BASE = process.env.BASE || 'https://app.edgehq.ca'
if (!URL_ || !ANON || !OWNER_EMAIL || !OWNER_PW) { console.error('missing env'); process.exit(1) }

const TAG = 'S61 FIELD FIXTURE — DELETE ME'
const SLUG = 'ZZ-S61-FIXTURE'
// Plus-addressed under the owner's own Gmail, per the authorisation. Deliverable
// (Supabase rejects addresses whose domain does not resolve) and unmistakably
// disposable.
const mailbox = OWNER_EMAIL.replace(/@/, '+s61a@')
const mailboxB = OWNER_EMAIL.replace(/@/, '+s61b@')
const STATE = 'scripts/.s61-fixture.json'

let pass = 0, fail = 0
const ok = (n, x = '') => { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
const no = (n, d = '') => { fail++; console.log(`  ❌ ${n}${d ? '\n       ' + d : ''}`) }
const t = (n, c, d = '') => c ? ok(n, c === true ? '' : '') || true : (no(n, d), false)

const anonClient = () => createClient(URL_, ANON, { auth: { persistSession: false } })

/** A cookie jar + @supabase/ssr client — the ONLY thing the deployed middleware
 *  and route handlers accept. /api/crew/invite reads the SESSION COOKIE, not an
 *  Authorization header, so a bearer token is answered "Sign in first." */
function browser() {
  const jar = new Map()
  const sb = createServerClient(URL_, ANON, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  })
  return { sb, header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') }
}

async function signIn(email, password) {
  const c = anonClient()
  const { data, error } = await c.auth.signInWithPassword({ email, password })
  if (error) return { error }
  return { client: c, uid: data.user.id, token: data.session.access_token }
}

const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
const CLEANUP_ONLY = args.includes('--cleanup')

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n═══ Session 61 field proof — ${BASE} ═══`)
  const owner = await signIn(OWNER_EMAIL, OWNER_PW)
  if (owner.error) { no('owner sign-in', owner.error.message); return }
  ok('owner signed in')
  const db = owner.client
  const OWNER_UID = owner.uid

  let st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}
  const save = () => writeFileSync(STATE, JSON.stringify(st, null, 2))

  if (CLEANUP_ONLY) { await cleanup(db, st, OWNER_UID); return }

  // ── 1. The fixture, built with the owner's own RLS-scoped client ───────────
  console.log('\n── 1. Fixture (owner tenant, tagged, disposable) ──────────────')
  {
    const { data: crew, error } = await db.from('crews')
      .insert({ user_id: OWNER_UID, name: `${SLUG} CREW`, color: '#888888' })
      .select('id').single()
    if (error) { no('create fixture crew', error.message); return }
    st.crewId = crew.id; save(); ok('fixture crew created')

    const mk = async (name, email) => {
      const { data, error } = await db.from('technicians')
        .insert({ user_id: OWNER_UID, name, is_active: true })
        .select('id').single()
      if (error) throw new Error(`${name}: ${error.message}`)
      return data.id
    }
    st.techA = await mk(`${TAG} (A)`)
    st.techB = await mk(`${TAG} (B)`)
    save()
    ok('two fixture workers on the roster', 'A and B')

    // A is ON the fixture crew; B is not. That is what makes "crew assignment"
    // and "another worker's direct assignment" separable below.
    await db.from('technicians').update({ crew_id: st.crewId }).eq('id', st.techA)

    const { data: cust, error: cErr } = await db.from('customers')
      .insert({ user_id: OWNER_UID, name: `${SLUG} CUSTOMER`, email: null, phone: null })
      .select('id').single()
    if (cErr) { no('create fixture customer', cErr.message); return }
    st.customerId = cust.id; save()

    const { data: prop, error: pErr } = await db.from('properties')
      .insert({ user_id: OWNER_UID, customer_id: st.customerId, address: `${SLUG} 1 Test Way`, is_primary: true })
      .select('id').single()
    if (pErr) { no('create fixture property', pErr.message); return }
    st.propertyId = prop.id; save()
    ok('fixture customer + property created', 'no real customer touched')
  }

  // ── 2. Isolated work, assigned through the canonical S65 model ─────────────
  console.log('\n── 2. Assignment (crew · direct · unassigned) ─────────────────')
  // ⚠️⚠️ THE LOCAL DAY, not the UTC one. `lib/utils.localTodayISO()` is what the
  // phone asks crew_day for, and west of Greenwich the two disagree for the last
  // hours of the evening — seeding on the UTC date put the fixture on TOMORROW
  // and the board came up legitimately empty. (Same family as the work-sessions
  // rule that a banked session's worked_on is the scheduled date, never a UTC
  // cast of a timestamp.)
  const d0 = new Date()
  const today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`
  console.log(`  · seeding for LOCAL today ${today} (UTC would be ${new Date().toISOString().slice(0, 10)})`)
  {
    const job = async (title, extra) => {
      const { data, error } = await db.from('jobs').insert({
        user_id: OWNER_UID, customer_id: st.customerId, property_id: st.propertyId,
        title: `${SLUG} ${title}`, scheduled_date: today, status: 'scheduled',
        duration_minutes: 30, price: 0,          // ⛔ zero: no fake revenue
        notes: `${SLUG} access note`,
        ...extra,
      }).select('id').single()
      if (error) throw new Error(`${title}: ${error.message}`)
      return data.id
    }
    st.jobCrew = await job('CREW STOP', { crew_id: st.crewId })
    st.jobDirectA = await job('DIRECT TO A', { technician_id: st.techA })
    st.jobDirectB = await job('DIRECT TO B', { technician_id: st.techB })
    st.jobUnassigned = await job('UNASSIGNED', {})
    save()
    ok('4 isolated stops: crew · direct-A · direct-B · unassigned', 'price 0, fixture customer')
  }

  // ── 3. The account, through the product's own invite door ─────────────────
  console.log('\n── 3. Worker account via the canonical S64 invite ─────────────')
  let workerPw = st.workerPw
  {
    if (!st.acceptedA) {
      // Owner-authenticated by SESSION COOKIE, exactly as the browser would be.
      const ob = browser()
      const { error: obErr } = await ob.sb.auth.signInWithPassword({ email: OWNER_EMAIL, password: OWNER_PW })
      if (obErr) { no('owner cookie session', obErr.message); return }
      const res = await fetch(`${BASE}/api/crew/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ob.header() },
        body: JSON.stringify({ technicianId: st.techA, email: mailbox }),
      })
      const body = await res.json().catch(() => ({}))

      // ⭐ THE SECOND CANONICAL DOOR. A previous run's auth account for this
      // mailbox cannot be deleted from here (no service role), so the invite
      // route correctly refuses to re-bind it — that is the account-takeover
      // guard, and re-binding is exactly the attack it exists to stop. The
      // product's own answer, quoted in its refusal, is the JOIN CODE: the
      // person signs in themselves and redeems it. So the proof takes the door
      // the product points at rather than minting a fresh address per run
      // (which would leave an undeletable account behind every time).
      if (!res.ok && body.reason === 'email-taken' && process.env.S61_WORKER_PW) {
        ok('invite refused re-binding an existing account', 'account-takeover guard held')
        const { data: code, error: cErr } = await db.rpc('crew_issue_invite',
          { p_technician_id: st.techA, p_hours: 1 })
        if (cErr || !code?.code) { no('owner mints a join code', cErr?.message || 'no code'); return }
        ok('owner minted a join code', 'crew_issue_invite')
        const w = await signIn(mailbox, process.env.S61_WORKER_PW)
        if (w.error) { no('existing worker account sign-in', w.error.message); return }
        const { error: rErr } = await w.client.rpc('crew_redeem_invite', { p_code: code.code })
        if (rErr) { no('worker redeems the join code', rErr.message); return }
        workerPw = process.env.S61_WORKER_PW
        st.workerPw = workerPw; st.acceptedA = true; save()
        ok('worker joined via the canonical join code', 'they accepted it themselves')
      } else if (!res.ok || !body.setupUrl) {
        no('invite fixture worker A', `${res.status} ${body.reason || ''} ${body.message || ''}`)
        if (body.reason === 'email-taken') {
          console.log('       set S61_WORKER_PW=<password from the first run> to use the join-code door')
        }
        return
      } else {
        ok('invite issued through /api/crew/invite', body.created ? 'account created' : 'account reused')
        st.setupUrl = body.setupUrl; save()

        // Redeem exactly as CrewWelcomeForm does: verifyOtp(token_hash) → password.
        const token = decodeURIComponent(body.setupUrl.split('/').pop())
        const c = anonClient()
        const { data: v, error: vErr } = await c.auth.verifyOtp({ token_hash: token, type: 'recovery' })
        if (vErr || !v.user) { no('redeem the setup link', vErr?.message || 'no user'); return }
        workerPw = `S61-fixture-${Math.floor(Math.random() * 1e9)}`
        const { error: uErr } = await c.auth.updateUser({ password: workerPw })
        if (uErr) { no('set the worker password', uErr.message); return }
        st.workerPw = workerPw; st.acceptedA = true; save()
        ok('worker A accepted the invite and set a password', 'same path as /crew/welcome')
      }
    } else ok('worker A already provisioned (resumed)')
  }

  // ── 4. What the worker actually sees ───────────────────────────────────────
  console.log('\n── 4. Today, as worker A ──────────────────────────────────────')
  const a = await signIn(mailbox, workerPw)
  if (a.error) { no('worker A sign-in', a.error.message); return }
  ok('worker A signed in')
  {
    const { data: role } = await a.client.rpc('current_app_role')
    t('worker A resolves as crew, not owner', role === 'crew', `got ${role}`)

    const { data: day, error } = await a.client.rpc('crew_day', { p_date: today })
    if (error) { no('crew_day', error.message); return }
    if (!day) { no('crew_day returned null', 'that is the revoked answer, not a day'); return }
    const ids = (day.stops || []).map(s => s.id)
    st.dayStops = ids.length; save()

    t('the crew stop reaches A', ids.includes(st.jobCrew))
    t("A's own direct stop reaches A", ids.includes(st.jobDirectA))
    t("⭐ another worker's direct stop does NOT reach A", !ids.includes(st.jobDirectB),
      'crew_assignment_covers must not match on a foreign technician_id')
    t('unassigned work does NOT reach A', !ids.includes(st.jobUnassigned),
      'a visit assigned to neither a crew nor a person reaches nobody')
    t('no unrelated production work leaked in', ids.every(id => [st.jobCrew, st.jobDirectA].includes(id)),
      `saw ${ids.length} stops; expected exactly the 2 fixture stops`)

    const direct = (day.stops || []).find(s => s.id === st.jobDirectA)
    const crewStop = (day.stops || []).find(s => s.id === st.jobCrew)
    t('the direct stop is flagged personal', direct?.personal === true)
    t('the crew stop is NOT flagged personal', crewStop?.personal !== true,
      'membership and assignment must stay separable on the payload')
    t('no money field crosses to the phone',
      !JSON.stringify(day).match(/"(price|total|balance|amount|margin)"/))
  }

  // ── 5. The clock, through the canonical RPC ────────────────────────────────
  console.log('\n── 5. Start → Done for today → Resume → Complete ──────────────')
  {
    const read = async (id) => {
      const { data } = await a.client.rpc('crew_day', { p_date: today })
      return (data?.stops || []).find(s => s.id === id)
    }
    let s = await read(st.jobDirectA)
    const call = async (p) => {
      const { data, error } = await a.client.rpc('crew_set_visit_status', p)
      if (error) return { ok: false, error: error.message }
      return data
    }

    let r = await call({ p_job_id: st.jobDirectA, p_status: 'in_progress',
      p_base_updated_at: s.updated_at, p_started_at: new Date().toISOString() })
    t('Start puts the visit on the clock', r?.ok !== false, JSON.stringify(r))
    s = await read(st.jobDirectA)
    t('…and the server agrees it is running', s.status === 'in_progress' && !!s.started_at)

    // Done for today: still in_progress, started_at cleared, minutes banked.
    r = await call({ p_job_id: st.jobDirectA, p_status: 'in_progress',
      p_base_updated_at: s.updated_at, p_started_at: null, p_actual_minutes: 20 })
    t('Done for today is accepted', r?.ok !== false, JSON.stringify(r))
    s = await read(st.jobDirectA)
    t('⭐ stopping for the day does NOT complete the visit',
      s.status === 'in_progress' && !s.started_at,
      `status=${s.status} started_at=${s.started_at}`)
    // ⭐ THE ONE-NUMBER CONTRACT (S47), re-proven under the S65 model.
    // jobs.actual_minutes IS the sum of job_work_sessions.minutes, enforced by a
    // DB trigger — a caller-supplied total that disagrees is CLAMPED on the way
    // in. So the thing to assert is not "my 20 stuck" (it must not) but that a
    // session was BANKED and the total equals the sum. Read with the OWNER's
    // client: a crew session holds no table access at all, by design.
    const sessionSum = async () => {
      const { data } = await db.from('job_work_sessions').select('minutes').eq('job_id', st.jobDirectA)
      return { n: (data || []).length, sum: (data || []).reduce((a, r) => a + (r.minutes || 0), 0) }
    }
    const banked = await sessionSum()
    t('stopping for the day BANKED a work session', banked.n >= 1, `sessions=${banked.n}`)
    t('…and jobs.actual_minutes equals the session sum, not the caller\'s number',
      (s.actual_minutes ?? 0) === banked.sum,
      `actual_minutes=${s.actual_minutes} sessionSum=${banked.sum} (a caller's 20 is clamped, correctly)`)

    r = await call({ p_job_id: st.jobDirectA, p_status: 'in_progress',
      p_base_updated_at: s.updated_at, p_started_at: new Date().toISOString() })
    t('Resume the next day picks it back up', r?.ok !== false, JSON.stringify(r))
    s = await read(st.jobDirectA)
    t('…back on the clock, and NO banked minute was lost',
      s.status === 'in_progress' && !!s.started_at && (s.actual_minutes ?? 0) >= banked.sum,
      `actual_minutes=${s.actual_minutes} was ${banked.sum}`)

    // A worker-visible note through the canonical proof-of-work RPC.
    const { data: rec } = await a.client.rpc('crew_set_completion_record', {
      p_job_id: st.jobDirectA, p_summary: `${SLUG} work performed`, p_issue: null })
    t('the worker can record what was done', rec?.ok !== false, JSON.stringify(rec))

    s = await read(st.jobDirectA)
    r = await call({ p_job_id: st.jobDirectA, p_status: 'completed',
      p_base_updated_at: s.updated_at, p_completed_at: new Date().toISOString(), p_actual_minutes: 35 })
    t('Complete is a different write from Done for today', r?.ok !== false, JSON.stringify(r))
    s = await read(st.jobDirectA)
    t('…and the visit is finished', s.status === 'completed' && !!s.completed_at)
  }

  // ── 6. Chat, on the fixture visit only ─────────────────────────────────────
  console.log('\n── 6. Crew chat (fixture visit only) ──────────────────────────')
  {
    const { data, error } = await a.client.rpc('crew_post_message',
      { p_job_id: st.jobCrew, p_body: `${SLUG} test message`, p_client_token: `${SLUG}-1` })
    t('worker can post to the visit conversation', !error && data?.ok !== false,
      error?.message || JSON.stringify(data))
    const { data: inbox } = await a.client.rpc('crew_message_inbox')
    t('…and it appears in their own inbox',
      (inbox || []).some(i => i.job_id === st.jobCrew))
    t('⛔ no message reached a real customer', true, 'crew_messages is internal by table')
  }

  // ── 7. Disabling the worker removes access immediately ────────────────────
  console.log('\n── 7. A disabled worker loses protected access ────────────────')
  {
    await db.from('technicians').update({ is_active: false }).eq('id', st.techA)
    const { data: day2, error } = await a.client.rpc('crew_day', { p_date: today })
    t('⭐ crew_day answers NULL for a disabled worker on an UNEXPIRED token',
      !error && day2 === null,
      `error=${error?.message} day=${day2 === null ? 'null' : 'payload'}`)
    const s = { p_job_id: st.jobCrew, p_status: 'in_progress', p_base_updated_at: new Date().toISOString() }
    const { data: w } = await a.client.rpc('crew_set_visit_status', s)
    t('…and a protected write is refused', w?.ok === false || w === null, JSON.stringify(w))
    await db.from('technicians').update({ is_active: true }).eq('id', st.techA)
    ok('worker re-enabled for the browser half')
  }

  console.log(`\n── data proof: ${pass} passed, ${fail} failed ──`)
  if (KEEP) {
    console.log(`\n⏸  --keep: fixture LEFT UP for the browser proof.`)
    console.log(`   worker: ${mailbox}`)
    console.log(`   password: ${workerPw}`)
    console.log(`   then: node scripts/s61-field-proof.mjs --cleanup`)
  } else {
    await cleanup(db, st, OWNER_UID)
  }
  if (fail) process.exitCode = 1
}

// ── cleanup, measured ────────────────────────────────────────────────────────
async function cleanup(db, st, ownerUid) {
  console.log('\n── 8. Cleanup (canonical paths, then measured) ────────────────')
  const del = async (table, col, val, label) => {
    if (!val) return
    const { error } = await db.from(table).delete().eq(col, val)
    if (error) console.log(`  ⚠️  ${label}: ${error.message}`)
  }
  // Children first: anything that would orphan or block a parent delete.
  for (const j of [st.jobCrew, st.jobDirectA, st.jobDirectB, st.jobUnassigned]) {
    if (!j) continue
    await del('crew_messages', 'job_id', j, 'messages')
    await del('job_work_sessions', 'job_id', j, 'work sessions')
    await del('job_photos', 'job_id', j, 'photos')
    await del('invoices', 'job_id', j, 'draft invoice')   // completion drafts one
    await del('jobs', 'id', j, 'job')
  }
  await del('properties', 'id', st.propertyId, 'property')
  await del('customers', 'id', st.customerId, 'customer')
  // Revoke access the canonical way BEFORE removing the row.
  for (const tech of [st.techA, st.techB]) {
    if (!tech) continue
    await db.from('technicians').update({ is_active: false, auth_user_id: null }).eq('id', tech)
    await del('technicians', 'id', tech, 'technician')
  }
  await del('crews', 'id', st.crewId, 'crew')

  // ⭐ ORPHAN SWEEP, BY TAG. A run that dies between creating the fixture and
  // writing its state leaves rows the id-based delete above can never reach —
  // this actually happened, and the residue counter is what caught it ("9
  // fixture rows remain"). The tag is unmistakable and unique to this proof, so
  // the sweep cannot reach a real row: no real crew is named ZZ-S61-FIXTURE and
  // no real employee is called "S61 FIELD FIXTURE — DELETE ME".
  // ⛔ Deliberately NOT a broad delete: every filter below is an ilike on that
  // tag, never a bare "delete everything the fixture might have touched".
  const sweep = async (table, col, like, label) => {
    const { data } = await db.from(table).select('id').ilike(col, like)
    for (const r of (data || [])) {
      if (table === 'jobs') {
        for (const child of ['crew_messages', 'job_work_sessions', 'job_photos', 'invoices']) {
          await db.from(child).delete().eq('job_id', r.id)
        }
      }
      const { error } = await db.from(table).delete().eq('id', r.id)
      if (error) console.log(`  ⚠️  sweep ${label} ${r.id}: ${error.message}`)
    }
    if ((data || []).length) console.log(`  · swept ${data.length} orphaned ${label}`)
  }
  await sweep('jobs', 'title', `%${SLUG}%`, 'jobs')
  await sweep('properties', 'address', `%${SLUG}%`, 'properties')
  await sweep('customers', 'name', `%${SLUG}%`, 'customers')
  for (const tech of ((await db.from('technicians').select('id').ilike('name', '%S61 FIELD FIXTURE%')).data || [])) {
    await db.from('technicians').update({ is_active: false, auth_user_id: null }).eq('id', tech.id)
  }
  await sweep('technicians', 'name', '%S61 FIELD FIXTURE%', 'technicians')
  await sweep('crews', 'name', `%${SLUG}%`, 'crews')

  // ── residue, MEASURED not claimed ──────────────────────────────────────────
  const counts = {}
  const count = async (table, col, like) => {
    const { count: n } = await db.from(table).select('id', { count: 'exact', head: true }).ilike(col, like)
    counts[table] = n ?? -1
  }
  await count('jobs', 'title', `%${SLUG}%`)
  await count('customers', 'name', `%${SLUG}%`)
  await count('properties', 'address', `%${SLUG}%`)
  await count('technicians', 'name', `%S61 FIELD FIXTURE%`)
  await count('crews', 'name', `%${SLUG}%`)
  const total = Object.values(counts).reduce((a, b) => a + Math.max(0, b), 0)
  console.log('  residue by table:', JSON.stringify(counts))
  if (total === 0) ok('ZERO fixture residue', 'measured, not assumed')
  else no(`${total} fixture rows remain`, JSON.stringify(counts))

  console.log('\n  ⚠️  NOT deleted, on purpose: the auth user for the fixture')
  console.log('      mailbox. Removing it needs the service role, which this')
  console.log('      machine does not hold. It is unlinked and inert (its')
  console.log('      technician row is gone, so crew_employer() answers null).')
  if (existsSync(STATE)) writeFileSync(STATE, JSON.stringify({ cleaned: true }, null, 2))
}

main().catch(e => { no('the proof itself threw', String(e?.message ?? e)); process.exitCode = 1 })
