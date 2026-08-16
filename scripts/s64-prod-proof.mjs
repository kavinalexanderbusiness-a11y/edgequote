// ── Session 64 production proof ──────────────────────────────────────────────
// Drives the REAL deployed app at app.edgehq.ca through the whole worker
// lifecycle, using a throwaway tenant that is deleted at the end.
//
// ⚠️ Writes to production. Everything it creates is tagged S64PROOF and removed
// in cleanup(); the run prints a residue count so "cleaned up" is measured, not
// claimed.
//
// Needs: SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, BASE (defaults to
// the production host).
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const BASE = process.env.BASE || 'https://app.edgehq.ca'
const WORKER_EMAIL = process.env.WORKER_EMAIL || 'edgeservicesyyc+s64worker@gmail.com'
if (!URL_ || !KEY || !ANON) { console.error('missing env'); process.exit(1) }

const admin = createClient(URL_, KEY, { auth: { persistSession: false } })
const TAG = 'S64PROOF'
const PW_OWNER = 'S64-proof-owner-' + Math.floor(Math.random() * 1e9)
const PW_WORKER = 'S64-proof-worker-' + Math.floor(Math.random() * 1e9)

let pass = 0, fail = 0
const ok = (n, extra = '') => { pass++; console.log(`  ✅ ${n}${extra ? ' — ' + extra : ''}`) }
const no = (n, d = '') => { fail++; console.log(`  ❌ ${n}${d ? '\n       ' + d : ''}`) }
const t = (n, cond, d = '') => cond ? ok(n, d) : no(n, d)

const made = { users: [], techs: [], settings: [] }

/** A cookie jar + @supabase/ssr client — the ONLY correct way to mint the
 *  session cookies the deployed middleware will accept. Don't hand-roll the
 *  cookie format. */
function browser() {
  const jar = new Map()
  const sb = createServerClient(URL_, ANON, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  })
  return {
    sb,
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
  }
}

async function main() {
  console.log(`\n═══ Session 64 production proof — ${BASE} ═══\n`)

  const health = await fetch(`${BASE}/api/health`).then(r => r.json())
  console.log(`  deploy commit=${health.commit} app_url=${JSON.stringify(health.app_url)}`)
  t('production reports the correct link origin', health.app_url === 'https://app.edgehq.ca',
    `got ${JSON.stringify(health.app_url)}`)
  t('the raw env value carries no BOM or stray whitespace',
    health.app_url_raw === 'https://app.edgehq.ca', `raw=${JSON.stringify(health.app_url_raw)}`)

  // ── A throwaway tenant, and a second one to prove isolation ────────────────
  const mk = async (email) => {
    const { data, error } = await admin.auth.admin.createUser({
      email, password: PW_OWNER, email_confirm: true, user_metadata: { [TAG]: true },
    })
    if (error) throw new Error(`createUser ${email}: ${error.message}`)
    made.users.push(data.user.id)
    return data.user.id
  }
  const ownerA = await mk(`edgeservicesyyc+s64ownerA@gmail.com`)
  const ownerB = await mk(`edgeservicesyyc+s64ownerB@gmail.com`)
  for (const [uid, name] of [[ownerA, `${TAG} Alpha`], [ownerB, `${TAG} Beta`]]) {
    const { error } = await admin.from('business_settings').insert({ user_id: uid, company_name: name })
    if (error) throw new Error(`settings ${name}: ${error.message}`)
    made.settings.push(uid)
  }

  const tech = async (uid, name, email) => {
    const { data, error } = await admin.from('technicians')
      .insert({ user_id: uid, name, email, is_active: true }).select('id').single()
    if (error) throw new Error(`technician ${name}: ${error.message}`)
    made.techs.push(data.id)
    return data.id
  }
  const techA = await tech(ownerA, `${TAG} Worker`, WORKER_EMAIL)
  const techB = await tech(ownerB, `${TAG} Other`, 'edgeservicesyyc+s64other@gmail.com')

  // ── Sign in as owner A against PRODUCTION ─────────────────────────────────
  const oA = browser()
  {
    const { error } = await oA.sb.auth.signInWithPassword({
      email: `edgeservicesyyc+s64ownerA@gmail.com`, password: PW_OWNER,
    })
    t('owner A signs in to production', !error, error?.message)
  }

  const post = (cookie, body) => fetch(`${BASE}/api/crew/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  })

  // ── 1. The invitation ─────────────────────────────────────────────────────
  console.log('\n── The invitation ──')
  let setupUrl = null
  {
    const res = await post(oA.header(), { technicianId: techA, email: WORKER_EMAIL })
    const body = await res.json()
    t('owner can invite their own worker', res.status === 200 && body.ok === true,
      `${res.status} ${JSON.stringify(body).slice(0, 200)}`)
    setupUrl = body.setupUrl
    t('the link is on the LIVE domain', !!setupUrl && setupUrl.startsWith('https://app.edgehq.ca/crew/welcome/'),
      setupUrl)
    t('the emailed link has no "=" and no "?"', !!setupUrl && !setupUrl.includes('=') && !setupUrl.includes('?'))
    t('production reports the email as SENT', body.emailed === true, `emailed=${body.emailed}`)
  }

  // ── 2. Tenant isolation on the invite door ────────────────────────────────
  console.log('\n── Tenant isolation ──')
  {
    const res = await post(oA.header(), { technicianId: techB, email: 'edgeservicesyyc+s64steal@gmail.com' })
    const body = await res.json().catch(() => ({}))
    t('owner A cannot invite owner B\'s worker', res.status === 404 && body.reason === 'not-your-technician',
      `${res.status} ${body.reason}`)
  }
  {
    const res = await post('', { technicianId: techA, email: WORKER_EMAIL })
    t('an anonymous caller is refused', res.status === 401, `status ${res.status}`)
  }
  {
    const res = await post(oA.header(), { technicianId: '00000000-0000-0000-0000-000000000000', email: WORKER_EMAIL })
    t('a forged technician id is refused', res.status === 404, `status ${res.status}`)
  }

  // ── 3. The link loads, and acceptance works ───────────────────────────────
  console.log('\n── Accepting ──')
  {
    const res = await fetch(setupUrl, { redirect: 'manual' })
    t('the setup link loads (no 404, no redirect to login)', res.status === 200, `status ${res.status}`)
  }
  const token = setupUrl.split('/crew/welcome/')[1]
  const w = browser()
  {
    const { data, error } = await w.sb.auth.verifyOtp({ token_hash: token, type: 'recovery' })
    t('the worker redeems the one-time token', !error && !!data?.user, error?.message)
    if (!error) {
      const { error: uErr } = await w.sb.auth.updateUser({ password: PW_WORKER })
      t('the worker sets a password', !uErr, uErr?.message)
    }
  }
  {
    // Replay the SAME token from a clean client.
    const r = browser()
    const { error } = await r.sb.auth.verifyOtp({ token_hash: token, type: 'recovery' })
    t('replaying the used token is REFUSED', !!error, error ? `refused: ${error.message}` : 'ACCEPTED — replay hole')
  }

  // ── 4. Sign in, land in crew mode, stay there ─────────────────────────────
  console.log('\n── The worker session ──')
  const wSess = browser()
  {
    const { error } = await wSess.sb.auth.signInWithPassword({ email: WORKER_EMAIL, password: PW_WORKER })
    t('the worker signs in with their new password', !error, error?.message)
  }
  const role = async (jar) => {
    const { data } = await jar.sb.rpc('current_app_role')
    return data
  }
  t('the worker\'s role is crew', await role(wSess) === 'crew')
  {
    const res = await fetch(`${BASE}/dashboard`, { headers: { cookie: wSess.header() }, redirect: 'manual' })
    const loc = res.headers.get('location') || ''
    t('a worker asking for the owner CRM is sent to /crew',
      res.status >= 300 && res.status < 400 && loc.includes('/crew'), `${res.status} → ${loc}`)
  }
  {
    const res = await fetch(`${BASE}/login`, { headers: { cookie: wSess.header() }, redirect: 'manual' })
    const loc = res.headers.get('location') || ''
    t('a signed-in worker at /login lands in crew mode', loc.includes('/crew'), `${res.status} → ${loc}`)
  }
  {
    const res = await fetch(`${BASE}/crew`, { headers: { cookie: wSess.header() }, redirect: 'manual' })
    t('the worker reaches the crew app (session persists across requests)', res.status === 200, `status ${res.status}`)
  }
  {
    const { data, error } = await wSess.sb.rpc('crew_day', { p_date: new Date().toISOString().slice(0, 10) })
    t('the worker can read their own day', !error && data !== null, error?.message ?? 'day returned')
    const s = JSON.stringify(data ?? {})
    t('the day carries no price or wage field', !/"price"|hourly_wage/.test(s))
  }

  // ── 5. Cannot self-promote ────────────────────────────────────────────────
  console.log('\n── A worker cannot become an owner ──')
  {
    const { error } = await wSess.sb.from('business_settings')
      .insert({ user_id: (await wSess.sb.auth.getUser()).data.user.id, company_name: 'S64 self promotion' })
    t('a worker cannot create a business for themselves', !!error, error ? `refused: ${error.code}` : 'INSERT SUCCEEDED')
  }
  {
    const { data } = await wSess.sb.from('technicians').select('id, hourly_wage')
    t('a worker cannot read the roster table', !data || data.length === 0, `rows=${data?.length ?? 0}`)
  }
  {
    const { data } = await wSess.sb.from('customers').select('id')
    t('a worker cannot read customers', !data || data.length === 0, `rows=${data?.length ?? 0}`)
  }

  // ── 6. Disable → refused; reactivate → works ──────────────────────────────
  console.log('\n── Disable and reactivate ──')
  await admin.from('technicians').update({ is_active: false }).eq('id', techA)
  t('a disabled worker loses the crew role immediately (same JWT)', await role(wSess) === 'none')
  {
    const { data } = await wSess.sb.rpc('crew_day', { p_date: new Date().toISOString().slice(0, 10) })
    t('a disabled worker\'s day read returns revoked (null)', data === null)
  }
  {
    const res = await fetch(`${BASE}/crew`, { headers: { cookie: wSess.header() }, redirect: 'manual' })
    const loc = res.headers.get('location') || ''
    t('a disabled worker is redirected out of the crew app', loc.includes('/crew/join'), `${res.status} → ${loc}`)
  }
  {
    const res = await fetch(`${BASE}/crew/join`, { headers: { cookie: wSess.header() } })
    const html = await res.text()
    t('the disabled worker is TOLD their access is off, not asked for a code',
      /turned off/i.test(html) && !/Enter the code/i.test(html),
      /turned off/i.test(html) ? 'shows the turned-off panel' : 'still shows the join form')
    t('the disabled screen says nothing was deleted', /nothing of yours has been deleted/i.test(html))
  }
  {
    // History must survive being disabled.
    const { count } = await admin.from('technicians').select('id', { count: 'exact', head: true }).eq('id', techA)
    t('the worker record still exists while disabled', count === 1)
  }
  await admin.from('technicians').update({ is_active: true }).eq('id', techA)
  t('reactivation restores the crew role without a new invite', await role(wSess) === 'crew')
  {
    const res = await fetch(`${BASE}/crew`, { headers: { cookie: wSess.header() }, redirect: 'manual' })
    t('the reactivated worker reaches the crew app again', res.status === 200, `status ${res.status}`)
  }

  // ── 7. Logout, then sign back in ──────────────────────────────────────────
  console.log('\n── Logout and return ──')
  {
    await wSess.sb.auth.signOut({ scope: 'local' })
    const res = await fetch(`${BASE}/crew`, { headers: { cookie: wSess.header() }, redirect: 'manual' })
    const loc = res.headers.get('location') || ''
    t('after logout the crew app requires a login', loc.includes('/login'), `${res.status} → ${loc}`)
  }
  {
    const again = browser()
    const { error } = await again.sb.auth.signInWithPassword({ email: WORKER_EMAIL, password: PW_WORKER })
    t('the worker can sign back in', !error, error?.message)
    t('and is crew again', await role(again) === 'crew')
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} production proof: ${pass} passed, ${fail} failed`)
  console.log(`\nsetup link used: ${setupUrl?.slice(0, 48)}…  (worker: ${WORKER_EMAIL})`)
}

async function cleanup() {
  console.log('\n── Cleanup ──')
  for (const id of made.techs) await admin.from('technicians').delete().eq('id', id)
  for (const uid of made.settings) await admin.from('business_settings').delete().eq('user_id', uid)
  // The worker account too — find it by address.
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const worker = list?.users?.find(u => (u.email || '').toLowerCase() === WORKER_EMAIL.toLowerCase())
  if (worker) made.users.push(worker.id)
  for (const uid of made.users) await admin.auth.admin.deleteUser(uid).catch(() => {})

  const { count: techLeft } = await admin.from('technicians')
    .select('id', { count: 'exact', head: true }).like('name', `${TAG}%`)
  const { count: setLeft } = await admin.from('business_settings')
    .select('user_id', { count: 'exact', head: true }).like('company_name', `${TAG}%`)
  const { data: after } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const usersLeft = (after?.users ?? []).filter(u => (u.email || '').includes('+s64')).length
  console.log(`  residue → technicians:${techLeft} business_settings:${setLeft} auth users:${usersLeft}`)
  if ((techLeft ?? 0) + (setLeft ?? 0) + usersLeft > 0) { console.log('  ⚠️ RESIDUE REMAINS'); process.exitCode = 1 }
  else console.log('  ✅ zero fixture residue')
}

main()
  .catch(e => { console.error('\n💥', e.message); fail++ })
  .finally(async () => { await cleanup(); process.exit(fail === 0 ? 0 : 1) })
