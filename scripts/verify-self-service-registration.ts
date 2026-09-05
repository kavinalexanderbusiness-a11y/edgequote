// ── Verify: self-service registration — the gate is licensed, closed, and honest ──
//   npm run verify:self-service-registration
//
// WHY THIS SCRIPT EXISTS
// Migration 20260905191549_self_service_registration adds a THIRD licence to the
// business_settings INSERT policy: a verified email, behind an operator switch
// that is born closed. Everything that could go wrong with that is a database
// fact, so the second half of this guard does not read text — it builds the
// apply path from zero in PGlite (the prelude + the baseline + the migration)
// and drives the gate as real sessions would: anon, six shaped accounts, the
// switch closed, then open, then closed again.
//
// The four things it refuses to take on faith:
//   1. the switch is service-role only and born CLOSED (a client cannot read or
//      flip it; a missing row reads closed);
//   2. the decision reads GoTrue's server-set email_confirmed_at and NOTHING a
//      client can write (no user_metadata, no app_metadata, no auth.jwt());
//   3. every existing licence survives byte-for-byte in outcome — an owner's
//      UPSERT, a redeemed invite — and a crew-linked account never provisions;
//   4. a self-service tenant is born with ZERO platform_capabilities.
//
// PGlite absent is a FAILURE here, as in verify:tenant-weld — the executed half
// is the half that matters, and "not attempted" must never print as green.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'

let pass = 0, fail = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const H = (t: string) => console.log(`\n═══ ${t} ═══`)
const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r/g, '')
const stripSql = (s: string) => s.replace(/^\s*--.*$/gm, '')

let summarised = false
const watchdog = setTimeout(() => {
  if (!summarised) { console.log('\n❌ verify:self-service-registration — did not reach its summary (hung or drained). FAILURE.\n'); process.exit(1) }
}, 8 * 60 * 1000)
watchdog.unref()

// ═══════════════════════════════════════════════════════════════════════════
H('1. the migration text — what it claims, and what it must not touch')
const MIG_DIR = join(ROOT, 'supabase', 'migrations')
const migrationFiles = readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()
const migName = migrationFiles.filter(f => /_self_service_registration\.sql$/.test(f))
check('exactly one self-service migration in the apply path', migName.length === 1, migName.join(', '))
const MIG = migName[0] ? read(`supabase/migrations/${migName[0]}`) : ''
const code = stripSql(MIG)
const baselineName = migrationFiles.find(f => /_baseline\.sql$/.test(f)) ?? ''
check('…versioned after the baseline (14-digit UTC prefix)',
  /^\d{14}_self_service_registration\.sql$/.test(migName[0] ?? '') && (migName[0] ?? '') > baselineName)

// The switch
check('the switch table is RLS-on', /alter table public\.platform_registration enable row level security/.test(code))
check('…with ZERO policies in the migration', !/create policy[^;]*platform_registration/.test(code))
check('…revoked from public, anon, authenticated, service_role, then granted to service_role only',
  /revoke all on table public\.platform_registration from public, anon, authenticated, service_role;/.test(code)
  && /grant all on table public\.platform_registration to service_role;/.test(code)
  && !/grant [^;]*platform_registration to (anon|authenticated)/.test(code))
check('…born CLOSED (default false, inserted false)',
  /self_service_open boolean not null default false/.test(code) && /values \(true, false\)/.test(code))
check('…exactly one row by construction', /check \(id\)/.test(code) && /id boolean primary key default true/.test(code))

// The decision
const status = /create or replace function public\.provisioning_status\(\)[\s\S]*?\$function\$([\s\S]*?)\$function\$/.exec(code)?.[1] ?? ''
check('provisioning_status() exists, STABLE SECURITY DEFINER with a pinned search_path',
  /function public\.provisioning_status\(\)\s*returns text\s*language plpgsql\s*stable security definer\s*set search_path to 'public', 'pg_temp'/.test(code))
check('…executable by authenticated + service_role and nobody else',
  /revoke all on function public\.provisioning_status\(\) from public, anon, authenticated, service_role;/.test(code)
  && /grant execute on function public\.provisioning_status\(\) to authenticated;/.test(code)
  && /grant execute on function public\.provisioning_status\(\) to service_role;/.test(code)
  && !/grant execute on function public\.provisioning_status\(\) to anon/.test(code))
check('…reads GoTrue\'s email_confirmed_at from auth.users', /select u\.email_confirmed_at into v_confirmed from auth\.users u where u\.id = v_uid/.test(status))
check('…reads NOTHING a client can write (no user/app metadata, no JWT claims)',
  !/raw_user_meta_data|user_metadata|app_metadata|auth\.jwt\(\)|raw_app_meta_data/.test(code))
check('…mirrors the INSERT trigger\'s crew predicate (ANY technician link)',
  /from public\.technicians t where t\.auth_user_id = v_uid/.test(status)
  && /from public\.technicians t where t\.auth_user_id = new\.user_id/.test(read(`supabase/migrations/${baselineName}`)))
check('…keeps the invite licence on redeemed_by, keyed on the uid', /from public\.beta_invites i where i\.redeemed_by = v_uid/.test(status))
check('…a missing switch row reads closed', /coalesce\(\(select r\.self_service_open from public\.platform_registration r where r\.id\), false\)/.test(status))
const order = ['not-signed-in', 'already-owner', 'crew-account', 'invited', 'email-unverified', 'self-service', 'closed'].map(w => status.indexOf(`return '${w}'`))
check('…answers in the documented order (owner, crew, invite, verification, switch)', order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), order.join(','))

// The gate
check('can_provision_business() is derived from the decision — one engine',
  /function public\.can_provision_business\(\)\s*returns boolean\s*language sql\s*stable security definer\s*set search_path to 'public', 'pg_temp'\s*as \$function\$\s*select public\.provisioning_status\(\) in \('already-owner', 'invited', 'self-service'\)\s*\$function\$/.test(code))
check('…its ACL restated: revoked from public/anon, granted to authenticated + service_role',
  /revoke all on function public\.can_provision_business\(\) from public, anon, authenticated, service_role;/.test(code)
  && /grant execute on function public\.can_provision_business\(\) to authenticated;/.test(code))

// What it must not touch
check('the INSERT policy text is not rewritten', !/create policy "settings: insert own"/.test(code) && !/drop policy/.test(code))
check('claim_beta_invite() and beta_invites are untouched',
  !/function public\.claim_beta_invite/.test(code) && !/alter table public\.beta_invites/.test(code) && !/create table[^;]*beta_invites/.test(code))
check('platform_capabilities is never named (grants stay fail-closed)', !/platform_capabilities/.test(code))
check('no other function or policy is redefined',
  (code.match(/create or replace function/g) ?? []).length === 2 && (code.match(/create table/g) ?? []).length === 1)
check('the migration reads its own claims back (self-verify block)',
  /^do \$\$[\s\S]*has_function_privilege\('anon', 'public\.provisioning_status\(\)', 'execute'\)[\s\S]*born CLOSED[\s\S]*end \$\$;/m.test(code))

// Where the rest of the repo must agree
const manifest = JSON.parse(read('scripts/schema/tenant-weld-manifest.json'))
check('the new DEFINER function is on the reviewed manifest (verify:tenant-weld R3)', (manifest.securityDefiners as string[]).includes('provisioning_status'))
check('the platform prelude\'s auth.users stub carries email_confirmed_at', /email_confirmed_at timestamptz/.test(read('scripts/schema/platform-prelude.sql')))

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  H('2. built from zero — prelude + baseline + this migration')
  const pglite = await loadPGlite()
  if (!pglite) {
    console.log('\n❌ verify:self-service-registration CANNOT RUN — PGlite is not installed.')
    console.log('   The executed half is the half that matters; this is a FAILURE, not a skip.  npm i -D @electric-sql/pglite\n')
    process.exit(1)
  }
  const { PGlite, contribs } = pglite
  const db = await PGlite.create({ extensions: contribs })
  const PRELUDE = join(ROOT, 'scripts', 'schema', 'platform-prelude.sql')
  const t0 = Date.now()
  for (const [label, raw] of [
    ['platform prelude', readFileSync(PRELUDE, 'utf8')] as const,
    ...migrationFiles.map(f => [f, readFileSync(join(MIG_DIR, f), 'utf8')] as const),
  ]) {
    const { sql } = substitutePlatformStatements(raw)
    for (const s of splitStatements(sql)) {
      try { await db.exec(s + ';') } catch (e: any) {
        console.log(`  ✗ failed applying ${label}: ${String(e.message).slice(0, 240)}`)
        fail++; summarise(); return
      }
    }
  }
  check(`the apply path builds from zero (${migrationFiles.length} files, ${Math.round((Date.now() - t0) / 1000)}s) — the self-verify block passed`, true)

  const q = (sql: string, params?: unknown[]) => db.query(sql, params)
  const one = async (sql: string, params?: unknown[]) => (await q(sql, params)).rows[0] as any

  // ── ACLs as the database reports them, not as the file claims ──────────────
  H('3. who can reach what')
  const priv = async (role: string, fn: string) => (await one(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn])).ok as boolean
  check('anon cannot execute provisioning_status()', !(await priv('anon', 'public.provisioning_status()')))
  check('anon cannot execute can_provision_business()', !(await priv('anon', 'public.can_provision_business()')))
  check('authenticated can execute provisioning_status()', await priv('authenticated', 'public.provisioning_status()'))
  check('authenticated can execute can_provision_business() (the policy calls it as DEFINER anyway)', await priv('authenticated', 'public.can_provision_business()'))
  const tpriv = async (role: string, p: string) => (await one(`select has_table_privilege($1, 'public.platform_registration', $2) as ok`, [role, p])).ok as boolean
  check('anon cannot SELECT the switch', !(await tpriv('anon', 'select')))
  check('authenticated cannot SELECT the switch', !(await tpriv('authenticated', 'select')))
  check('authenticated cannot UPDATE the switch', !(await tpriv('authenticated', 'update')))
  check('service_role can UPDATE the switch (the operator door)', await tpriv('service_role', 'update'))
  const rls = await one(`select c.relrowsecurity as rls, (select count(*)::int from pg_policies where schemaname='public' and tablename='platform_registration') as pols from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='platform_registration'`)
  check('the switch table is RLS-on with zero policies', rls.rls === true && rls.pols === 0)
  const row = await one(`select count(*)::int as n, bool_and(self_service_open = false) as closed from public.platform_registration`)
  check('exactly one switch row, closed', row.n === 1 && row.closed === true)
  const secdef = await one(`select p.prosecdef, p.provolatile, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='provisioning_status'`)
  check('provisioning_status() is SECURITY DEFINER, STABLE, search_path pinned',
    secdef.prosecdef === true && secdef.provolatile === 's' && String(secdef.proconfig).includes('search_path=public, pg_temp'), JSON.stringify(secdef))

  // ── Six shaped accounts ─────────────────────────────────────────────────────
  H('4. six accounts, the switch CLOSED')
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a' // verified, nothing else — the self-service candidate
  const B = 'bbbbbbbb-0000-4000-8000-00000000000b' // UNVERIFIED
  const C = 'cccccccc-0000-4000-8000-00000000000c' // verified + linked to an employee record (crew)
  const D = 'dddddddd-0000-4000-8000-00000000000d' // verified + REDEEMED beta invite
  const E = 'eeeeeeee-0000-4000-8000-00000000000e' // an existing owner
  const F = 'ffffffff-0000-4000-8000-00000000000f' // verified + redeemed invite + ALSO crew-linked
  const G = '99999999-0000-4000-8000-000000000009' // verified, arrives after the switch closes again
  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at) values
      ('${A}', 'a@fixture.test', now()), ('${B}', 'b@fixture.test', null), ('${C}', 'c@fixture.test', now()),
      ('${D}', 'd@fixture.test', now()), ('${E}', 'e@fixture.test', now()), ('${F}', 'f@fixture.test', now()),
      ('${G}', 'g@fixture.test', now());
    insert into public.business_settings (user_id, company_name) values ('${E}', 'Existing Co');
    insert into public.technicians (user_id, name, auth_user_id) values ('${E}', 'Crew C', '${C}'), ('${E}', 'Crew F', '${F}');
    insert into public.beta_invites (token_hash, label, expires_at, redeemed_by, redeemed_at) values
      (repeat('d', 64), 'fixture D', now() + interval '1 day', '${D}', now()),
      (repeat('f', 64), 'fixture F', now() + interval '1 day', '${F}', now());
  `)
  check('fixtures seeded (owner E, crew C/F, invited D/F, verified A/G, unverified B)', true)

  // A real session: the authenticated role with the JWT sub the prelude reads.
  async function asUser(uid: string | null, sql: string, role = 'authenticated'): Promise<{ ok: true; rows: any[] } | { ok: false; err: string }> {
    await q('begin')
    try {
      await q(`set local role ${role}`)
      await q(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? ''])
      const r = await q(sql)
      await q('commit')
      return { ok: true, rows: r.rows as any[] }
    } catch (e: any) {
      await q('rollback')
      return { ok: false, err: String(e.message) }
    }
  }
  const statusOf = async (uid: string | null) => {
    const r = await asUser(uid, `select public.provisioning_status() as s, public.can_provision_business() as c`)
    return r.ok ? { s: r.rows[0].s as string, c: r.rows[0].c as boolean } : { s: `ERROR ${r.err.slice(0, 80)}`, c: false }
  }
  const LICENSED = new Set(['already-owner', 'invited', 'self-service'])
  const expectClosed: Record<string, string> = { [A]: 'closed', [B]: 'email-unverified', [C]: 'crew-account', [D]: 'invited', [E]: 'already-owner', [F]: 'crew-account', [G]: 'closed' }
  for (const [uid, want] of Object.entries(expectClosed)) {
    const got = await statusOf(uid)
    check(`${uid.slice(0, 8)} → ${want}`, got.s === want, `got ${got.s}`)
    check(`  …and can_provision_business() agrees (${got.c})`, got.c === LICENSED.has(got.s))
  }
  const none = await statusOf(null)
  check('no sub → not-signed-in, unlicensed', none.s === 'not-signed-in' && none.c === false, none.s)
  const anonAsk = await asUser(null, `select public.provisioning_status()`, 'anon')
  check('anon cannot even ask (execute refused)', !anonAsk.ok && /permission denied/i.test(anonAsk.ok ? '' : anonAsk.err), anonAsk.ok ? 'it answered' : anonAsk.err.slice(0, 80))

  const tryInsert = (uid: string, extra = '') => asUser(uid, `insert into public.business_settings (user_id${extra ? ', company_name' : ''}) values ('${uid}'${extra ? `, '${extra}'` : ''})`)
  const isRls = (r: Awaited<ReturnType<typeof asUser>>) => !r.ok && /row-level security/i.test(r.err)
  // A BEFORE ROW trigger fires before the policy's WITH CHECK is evaluated, so a
  // crew-linked account is refused by guard_business_settings_owner() (42501,
  // "linked to an employee record") first. The policy agrees — its predicate was
  // asserted false above — so the outcome is the same by two independent gates.
  const isCrewRefusal = (r: Awaited<ReturnType<typeof asUser>>) => !r.ok && /linked to an employee record/i.test(r.err)
  check('CLOSED: a verified self-service candidate (A) is refused by the policy', isRls(await tryInsert(A)))
  check('CLOSED: an unverified account (B) is refused by the policy', isRls(await tryInsert(B)))
  check('CLOSED: a crew-linked account (C) is refused by the existing trigger (fires before the policy; the policy agrees)', isCrewRefusal(await tryInsert(C)))
  check('CLOSED: a crew-linked account WITH a redeemed invite (F) is still refused by that trigger', isCrewRefusal(await tryInsert(F)))
  const dIns = await tryInsert(D, 'Invited Co')
  check('CLOSED: a redeemed invite (D) still provisions — the invite flow is intact', dIns.ok, dIns.ok ? '' : dIns.err.slice(0, 120))
  const eUp = await asUser(E, `insert into public.business_settings (user_id, company_name) values ('${E}', 'Existing Co (renamed)') on conflict (user_id) do update set company_name = excluded.company_name`)
  check('CLOSED: an existing owner\'s UPSERT still passes the INSERT check (the grandfather licence)', eUp.ok, eUp.ok ? '' : eUp.err.slice(0, 120))
  check('…and updated its own row', (await one(`select company_name from public.business_settings where user_id = '${E}'`)).company_name === 'Existing Co (renamed)')
  const flip = await asUser(A, `update public.platform_registration set self_service_open = true where id`)
  check('a signed-in account cannot open the switch', !flip.ok && /permission denied/i.test(flip.ok ? '' : flip.err))
  const peek = await asUser(A, `select self_service_open from public.platform_registration`)
  check('a signed-in account cannot read the switch', !peek.ok && /permission denied/i.test(peek.ok ? '' : peek.err))
  check('the switch is still closed after those attempts', (await one(`select self_service_open as o from public.platform_registration`)).o === false)

  // ── The operator opens it ───────────────────────────────────────────────────
  H('5. the operator opens the switch (service role — one UPDATE, no deploy)')
  await db.exec(`update public.platform_registration set self_service_open = true, opened_at = now(), note = 'fixture' where id`)
  const expectOpen: Record<string, string> = { [A]: 'self-service', [B]: 'email-unverified', [C]: 'crew-account', [E]: 'already-owner', [F]: 'crew-account' }
  for (const [uid, want] of Object.entries(expectOpen)) {
    const got = await statusOf(uid)
    check(`${uid.slice(0, 8)} → ${want}`, got.s === want, `got ${got.s}`)
    check(`  …and can_provision_business() agrees (${got.c})`, got.c === LICENSED.has(got.s))
  }
  const aIns = await tryInsert(A, 'Self Service Co')
  check('OPEN: the verified candidate (A) provisions through the unchanged policy', aIns.ok, aIns.ok ? '' : aIns.err.slice(0, 120))
  check('…and is now already-owner (the grandfather licence takes over)', (await statusOf(A)).s === 'already-owner')
  const aAgain = await asUser(A, `insert into public.business_settings (user_id, company_name) values ('${A}', 'Self Service Co') on conflict (user_id) do update set company_name = excluded.company_name`)
  check('…a repeated submit is an UPDATE of the same row (idempotent), not a second tenant', aAgain.ok && (await one(`select count(*)::int as n from public.business_settings where user_id = '${A}'`)).n === 1)
  check('OPEN: an unverified account (B) is still refused', isRls(await tryInsert(B)))
  check('OPEN: a crew-linked account (C) is still refused by the trigger (and the policy still says crew-account)', isCrewRefusal(await tryInsert(C)))
  check('OPEN: a crew-linked, invited account (F) is still refused', isCrewRefusal(await tryInsert(F)))
  // Defence in depth, made visible: with the trigger out of the way, the POLICY
  // alone still refuses a crew-linked account — the new decision is not leaning
  // on the trigger for this answer.
  await db.exec(`alter table public.business_settings disable trigger business_settings_no_crew_owner`)
  check('OPEN: with the trigger disabled, the policy ALONE still refuses a crew-linked account (C)', isRls(await tryInsert(C)))
  await db.exec(`alter table public.business_settings enable trigger business_settings_no_crew_owner`)
  const caps = await one(`select count(*)::int as n from public.platform_capabilities where user_id = '${A}'`)
  check('the new tenant has ZERO platform_capabilities (no shared email/SMS/payments)', caps.n === 0)
  const aOwnCaps = await asUser(A, `select count(*)::int as n from public.platform_capabilities`)
  check('…and sees none through RLS either', aOwnCaps.ok && aOwnCaps.rows[0].n === 0)
  const isolation = await asUser(A, `select count(*)::int as n from public.business_settings`)
  check('tenant isolation: A sees exactly one settings row — its own', isolation.ok && isolation.rows[0].n === 1)
  const crossRead = await asUser(A, `select count(*)::int as n from public.technicians`)
  check('…and none of E\'s employees', crossRead.ok && crossRead.rows[0].n === 0)

  // ── Closing is instant and does not evict anyone ────────────────────────────
  H('6. the operator closes it again')
  await db.exec(`update public.platform_registration set self_service_open = false where id`)
  check('a later verified arrival (G) is closed out', (await statusOf(G)).s === 'closed' && isRls(await tryInsert(G)))
  check('the tenant provisioned while open keeps its grandfather licence', (await statusOf(A)).s === 'already-owner')
  const aUp2 = await asUser(A, `insert into public.business_settings (user_id, company_name) values ('${A}', 'Self Service Co 2') on conflict (user_id) do update set company_name = excluded.company_name`)
  check('…and its settings UPSERT still passes', aUp2.ok)
  await db.exec(`delete from public.platform_registration where id`)
  check('a MISSING switch row reads closed (fail-closed)', (await statusOf(G)).s === 'closed' && isRls(await tryInsert(G)))

  summarise()
}

function summarise() {
  summarised = true
  clearTimeout(watchdog)
  console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
  if (fail > 0) {
    console.log('\n❌ verify:self-service-registration — the sign-up gate is not what the migration claims\n')
    process.exit(1)
  }
  console.log('\n✅ verify:self-service-registration — verified email + operator switch, born closed, existing licences intact\n')
  process.exit(0)
}

main().catch(err => { console.error(err); fail++; summarise() })
