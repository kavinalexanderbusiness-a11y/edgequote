// ── Mutation test for verify:audit-trail ─────────────────────────────────────
//
//   node scripts/mutate-audit-trail.mjs
//
// A guard that has never failed proves nothing. This breaks the audit trail in
// ways that MATTER, one at a time, and requires the guard to go red for each. A
// mutation the guard survives is reported as MISSED — that is the finding.
//
// The breaches are chosen to be the ones that would actually destroy the feature's
// value if they shipped:
//   · the tenant predicate           → one tenant's history leaks into another's
//   · actor assignment               → everything becomes "the owner"
//   · write coupling                 → mutations happen with no record
//   · before/after capture           → "something changed" with no what
//   · atomicity                      → events survive rolled-back writes
//   · customer projection restriction→ internal history reaches the portal
//   · immutability                   → the record becomes editable
//   · the guard's own machinery      → a vacuous check that cannot fail
//
// ⚠️ COMMIT FIRST. This rewrites tracked files and restores with `git checkout --`,
//    which destroys uncommitted work. It refuses to run on a dirty tree.

import { execSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const SQL = 'supabase/pending/2026-08-15-audit-trail-v1.sql'
const GUARD = 'scripts/verify-audit-trail.ts'
const PROJ = 'src/lib/audit/customerProjection.ts'
const LIB = 'scripts/lib/pg-sql.ts'

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim()

if (sh('git status --porcelain')) {
  console.error('✗ working tree is dirty. Commit first — restore is `git checkout -- .`,')
  console.error('  which would destroy uncommitted work. (Untracked files are invisible')
  console.error('  to the applied-check below, so they make a mutation look like a no-op.)')
  process.exit(2)
}

const runGuard = () => {
  const r = spawnSync('npx', ['tsx', GUARD], { encoding: 'utf8', shell: true })
  return { green: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

console.log('── baseline: the guard must be GREEN before we break anything ──')
const base = runGuard()
if (!base.green) {
  console.error('✗ guard is already red — fix that first. Failing lines:')
  console.error(base.out.split('\n').filter(l => l.includes('✗')).join('\n'))
  process.exit(2)
}
console.log('✓ baseline green\n')

/** Each mutation is ONE real breach, with the reason it matters. */
const MUTATIONS = [
  {
    name: 'tenant predicate removed from worker attribution',
    why: 'a technician of ANOTHER business could be named as the actor',
    file: SQL,
    from: `where t.auth_user_id = v_uid and t.user_id = p_tenant`,
    to: `where t.auth_user_id = v_uid`,
  },
  {
    name: 'actor always resolves to owner',
    why: 'the customer portal and the crew would both read as the owner acting',
    file: SQL,
    from: `  if v_uid is not null then
    -- The tenant key IS the owner's auth uid — equality is the ownership test.
    if v_uid = p_tenant then`,
    to: `  if true then
    if true then`,
  },
  {
    name: 'write coupling cut (the reschedule trigger stops firing)',
    why: 'visits move with no record that anyone moved them',
    file: SQL,
    from: `create trigger trg_audit_jobs_update
  after update of scheduled_date, start_time, status, started_at, crew_id, price on public.jobs`,
    to: `create trigger trg_audit_jobs_update
  after update of price on public.jobs`,
  },
  {
    name: 'before-state capture dropped',
    why: '"the date changed" without saying what it changed FROM is not evidence',
    file: SQL,
    from: `      jsonb_build_object('scheduled_date', old.scheduled_date, 'start_time', old.start_time),
      jsonb_build_object('scheduled_date', new.scheduled_date, 'start_time', new.start_time));`,
    to: `      null,
      jsonb_build_object('scheduled_date', new.scheduled_date, 'start_time', new.start_time));`,
  },
  {
    name: 'immutability trigger removed',
    why: 'the audit record becomes editable — the whole trail stops being evidence',
    file: SQL,
    from: `create trigger audit_events_no_mutate
  before delete or update on public.audit_events
  for each row execute function public.audit_events_immutable();`,
    to: `-- [mutation] immutability trigger removed`,
  },
  {
    name: 'authenticated granted INSERT on audit_events',
    why: 'any signed-in client could forge a system event',
    file: SQL,
    from: `grant select on table public.audit_events to authenticated;`,
    to: `grant select, insert on table public.audit_events to authenticated;`,
  },
  {
    name: 'RLS select policy widened to every tenant',
    why: "one business could read another business's history",
    file: SQL,
    from: `  using ((auth.uid() = user_id));`,
    to: `  using (true);`,
  },
  {
    name: 'no-op suppression removed from the reschedule branch',
    why: 'an update that changes nothing would mint a false event',
    file: SQL,
    from: `  if (new.scheduled_date is distinct from old.scheduled_date
      or new.start_time is distinct from old.start_time) then`,
    to: `  if true then`,
  },
  {
    name: 'customer projection turned into a deny-list',
    why: 'every action added later would leak to the portal by default',
    file: PROJ,
    from: `    .filter(r => CUSTOMER_SAFE_ACTIONS.has(r.action))`,
    to: `    .filter(r => r.action !== 'worker_access_disabled')`,
  },
  {
    name: 'projection stops checking which customer is asking',
    why: 'a token proves which TENANT, never which ROW',
    file: PROJ,
    from: `    .filter(r => r.customer_id === customerId)`,
    to: `    .filter(() => true)`,
  },
  // ── the guard's own machinery ──────────────────────────────────────────────
  {
    name: "the guard's comment stripper neutered",
    why: 'an absence assertion that reads comments passes vacuously forever',
    file: GUARD,
    from: `const stripTsComments = (s: string) =>
  s.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/\\/\\/[^\\n\\r]*/g, '')`,
    to: `const stripTsComments = (s: string) => s`,
  },
  {
    // NOT "drop the trailing buffer": every .sql file here ends in `;`, so that
    // buffer only ever holds whitespace and the mutation is a semantic no-op. A
    // mutation that changes nothing is not a blind spot — it is a bad test, and
    // scoring it as MISSED would train the next person to ignore real misses.
    name: 'the statement splitter stops honouring dollar-quoted bodies',
    why: 'function bodies split at their internal semicolons, so the schema applies in fragments',
    file: LIB,
    from: `    if (c === '$') {
      const m = /^\\$[A-Za-z_][A-Za-z0-9_]*\\$|^\\$\\$/.exec(sql.slice(i))`,
    to: `    if (false) {
      const m = /^\\$[A-Za-z_][A-Za-z0-9_]*\\$|^\\$\\$/.exec(sql.slice(i))`,
  },
]

let missed = 0, applied = 0
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8')
  // CRLF-normalise both sides before splicing: the checkout may be CRLF and the
  // patterns here are written LF. A pattern that "did not match" because of line
  // endings is a silent no-mutation, which is the failure this whole script exists
  // to make impossible.
  const lf = original.replace(/\r\n/g, '\n')
  if (!lf.includes(m.from)) {
    console.log(`✗ MUTATION DID NOT APPLY — ${m.name}`)
    console.log(`     pattern not found in ${m.file}. A pattern that missed proves nothing.`)
    missed++
    continue
  }
  const mutated = lf.replace(m.from, m.to)
  writeFileSync(m.file, original.includes('\r\n') ? mutated.replace(/\n/g, '\r\n') : mutated, 'utf8')
  applied++

  const r = runGuard()
  execSync(`git checkout -- "${m.file}"`)

  if (r.green) {
    console.log(`✗ MISSED — ${m.name}`)
    console.log(`     ${m.why}`)
    console.log('     the guard stayed GREEN through this breach.')
    missed++
  } else {
    const first = r.out.split('\n').filter(l => l.includes('✗')).slice(0, 2)
    console.log(`✓ caught — ${m.name}`)
    for (const l of first) console.log(`     ${l.trim()}`)
  }
}

const dirty = sh('git status --porcelain -- src scripts supabase')
console.log(`\n${'─'.repeat(72)}`)
console.log(`${applied}/${MUTATIONS.length} mutations applied, ${missed} missed`)
if (dirty) console.error(`✗ tree not restored:\n${dirty}`)
console.log(missed === 0 && !dirty
  ? '✅ every breach was caught, and the tree is clean.'
  : '❌ the guard has blind spots (or the tree is dirty).')
process.exit(missed === 0 && !dirty ? 0 : 1)
