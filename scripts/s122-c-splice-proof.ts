// ── RUN-S122C: both apply paths must land on the SAME body ───────────────────
//   npx tsx scripts/s122-c-splice-proof.ts
//
// An earlier version of RUN-S122C projected `acceptance_kind` alone. A database
// that took it is no longer baseline, and v2 splicing at the baseline anchor
// re-inserted a projection it already had — measured `kind=2, is_current=1`.
//
// Postgres ACCEPTS a duplicate output column and the emitted JSON is still
// correct, so this was never a payload defect. The harm is that two databases
// end up with different `get_portal_data` bodies for no functional reason, and
// that every later anchor patch in this lane refuses unless its anchor matches
// exactly once — which would strand precisely the upgraded ones.
//
// ⭐ So the property under test is CONVERGENCE, not merely "it applies":
//
//     baseline ──────────────► v2      ┐
//     baseline ► old C ──────► v2      ┘  must be byte-identical
//
// ⛔ Offline, disposable in-memory PGlite, synthetic only. No production, no
// credential, no applied schema — the proposals are read from disk and executed
// against a throwaway database that is discarded at the end.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, d?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.error(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
}
const ROOT = process.cwd()
const git = (a: string[]) => { try { return execFileSync('git', a, { cwd: ROOT }).toString() } catch { return '' } }

const C_V2 = readFileSync(join(ROOT, 'supabase/proposals/RUN-S122C-portal-acceptance-evidence.sql'), 'utf8')
// ⭐ The REAL earlier version, read out of git rather than hand-rebuilt — a
// re-typed "old C" would prove convergence with my memory of it, not with it.
const C_OLD = git(['show', '166fc0eb:supabase/proposals/RUN-S122C-portal-acceptance-evidence.sql'])

const count = (s: string, needle: string) => s.split(needle).length - 1

async function main() {
  const pg = await loadPGlite()
  if (!pg) { console.log('\n⏭  s122-c-splice-proof SKIPPED — PGlite not installed.\n'); process.exit(0) }

  console.log('\n══ RUN-S122C · both paths, one body ════════════════════════════════')
  console.log(`   v2  read from disk            (${C_V2.length} bytes)`)
  console.log(`   old read from git 166fc0eb    (${C_OLD.length} bytes)\n`)
  check('the earlier C really is the one-field version',
    C_OLD.length > 0 && !C_OLD.includes('acceptance_is_current'),
    'if this fails the comparison below is against the wrong artifact')

  const baselineFile = readdirSync(join(ROOT, 'supabase/migrations'))
    .filter(f => f.endsWith('_baseline.sql')).sort().pop()!

  /** A fresh disposable database with the baseline applied. */
  const fresh = async () => {
    const db = await pg.PGlite.create({ extensions: Object.fromEntries(Object.entries(pg.contribs).filter(([, v]) => v)) })
    const apply = async (label: string, raw: string) => {
      const { sql } = substitutePlatformStatements(raw)
      for (const st of splitStatements(sql)) {
        try { await db.exec(st) } catch (e) { throw new Error(`${label}: ${(e as Error).message}`) }
      }
    }
    await apply('prelude', readFileSync(join(ROOT, 'scripts/schema/platform-prelude.sql'), 'utf8'))
    await apply('baseline', readFileSync(join(ROOT, 'supabase/migrations', baselineFile), 'utf8'))
    const body = async () => String(((await db.query(
      `select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='get_portal_data' and p.prokind='f'`,
    )).rows[0] as { d: string }).d).replace(/\r\n/g, '\n')
    return { db, apply, body }
  }

  console.log('■ 1. PATH 1 — baseline → v2')
  const p1 = await fresh()
  const before = await p1.body()
  check('the baseline body carries neither projection',
    count(before, 'as acceptance_kind') === 0 && count(before, 'as acceptance_is_current') === 0)
  await p1.apply('C v2', C_V2)
  const body1 = await p1.body()
  check('…and after v2 it carries exactly one of each',
    count(body1, ') as acceptance_kind,') === 1 && count(body1, ' as acceptance_is_current,') === 1,
    `kind=${count(body1, ') as acceptance_kind,')} cur=${count(body1, ' as acceptance_is_current,')}`)

  console.log('\n■ 2. PATH 2 — baseline → OLD C → v2')
  const p2 = await fresh()
  await p2.apply('C old', C_OLD)
  const mid = await p2.body()
  check('old C leaves the kind alone, with no currentness',
    count(mid, ') as acceptance_kind,') === 1 && count(mid, ' as acceptance_is_current,') === 0,
    `kind=${count(mid, ') as acceptance_kind,')} cur=${count(mid, ' as acceptance_is_current,')}`)
  await p2.apply('C v2 (upgrade)', C_V2)
  const body2 = await p2.body()
  check('⭐ the upgrade adds currentness WITHOUT duplicating the kind',
    count(body2, ') as acceptance_kind,') === 1 && count(body2, ' as acceptance_is_current,') === 1,
    `kind=${count(body2, ') as acceptance_kind,')} cur=${count(body2, ' as acceptance_is_current,')}`)

  console.log('\n■ 3. ⭐⭐ CONVERGENCE')
  {
    const same = body1 === body2
    check('both paths produce the byte-identical function body', same,
      same ? '' : `path1 ${body1.length} bytes, path2 ${body2.length} bytes — first difference at index ${
        [...body1].findIndex((c, i) => c !== body2[i])}`)
  }

  console.log('\n■ 4. Re-applying is a no-op on both')
  await p1.apply('C v2 again', C_V2)
  await p2.apply('C v2 again', C_V2)
  check('path 1 body unchanged by a second apply', (await p1.body()) === body1)
  check('path 2 body unchanged by a second apply', (await p2.body()) === body2)

  console.log('\n■ 5. ⛔ A malformed body is refused, not patched')
  {
    const p3 = await fresh()
    await p3.apply('C v2', C_V2)
    // Hand-build the damage the old splice used to cause: two kind projections.
    const dup = (await p3.body()).replace(
      '               where qa.quote_id = qt.id order by qa.seq desc limit 1) as acceptance_kind,',
      '               where qa.quote_id = qt.id order by qa.seq desc limit 1) as acceptance_kind,\n'
      + '             (select qa.kind from public.quote_acceptances qa\n'
      + '               where qa.quote_id = qt.id order by qa.seq desc limit 1) as acceptance_kind,')
    await p3.db.exec(dup)
    const now = await p3.body()
    check('the damaged body really has two kind projections',
      count(now, ') as acceptance_kind,') === 2)
    let refused = ''
    try { await p3.apply('C v2 on damage', C_V2) } catch (e) { refused = (e as Error).message }
    // ⚠️ The proposal raises INSIDE its own `begin; … commit;`, so the session is
    // left in an aborted transaction and every later statement answers 25P02.
    // Clearing it is what lets the next assertion read the body at all — and the
    // rollback is also the proof that nothing was committed.
    try { await p3.db.exec('rollback') } catch { /* nothing open */ }
    check('⛔ v2 REFUSES it rather than patching around it',
      /expected exactly 1 of each|refusing to touch a body this patch did not produce/.test(refused),
      refused || '(it did not refuse)')
    check('…and the damaged body is left exactly as it was', (await p3.body()) === now)
    await p3.db.close()
  }

  console.log('\n■ 6. The proposal is still a CANDIDATE')
  check('⛔ never applied — the header still says so', /CANDIDATE — NOT APPLIED/.test(C_V2))

  await p1.db.close(); await p2.db.close()
  console.log(fail > 0 ? `\n✗ ${fail} FAILURE(S) — ${pass} passed` : `\n✓ C splice: ${pass} checks passed`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
