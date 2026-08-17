// ── A disposable database with two tenants on it ─────────────────────────────
// Shared by verify:crews and verify:crew-assignments.
//
// WHY A REAL DATABASE AND NOT A MOCK: everything this session made safe is
// enforced BY the database — a CHECK that forbids two assignees, composite
// foreign keys that stop one tenant pointing at another's crew, triggers that
// refuse a lead who is not a member and a delete that would erase history. A
// guard that greps the migration proves only that the text was written. Applying
// it to Postgres and then TRYING THE ATTACK is what proves it holds.
//
// Runs on PGlite (WASM Postgres), in memory, offline — the same engine
// verify:rebuild uses. If PGlite is absent (CI, a fresh clone) the caller SKIPS
// clean rather than failing: the offline half of these guards is a bonus, and
// the pure-engine half runs everywhere.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join('supabase', 'migrations')
const PRELUDE = join('scripts', 'schema', 'platform-prelude.sql')

/** Statements are split on dollar-quote-aware boundaries — a function body full
 *  of semicolons must not be cut in half. Mirrors verify-rebuild's splitter. */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let buf = '', i = 0
  while (i < sql.length) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      const end = nl === -1 ? sql.length : nl
      buf += sql.slice(i, end); i = end
      continue
    }
    if (c === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue }
        if (sql[j] === "'") break
        j++
      }
      buf += sql.slice(i, j + 1); i = j + 1
      continue
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const close = sql.indexOf(tag, i + tag.length)
        const end = close === -1 ? sql.length : close + tag.length
        buf += sql.slice(i, end); i = end
        continue
      }
    }
    if (c === ';') { out.push(buf.trim()); buf = ''; i++; continue }
    buf += c; i++
  }
  if (buf.trim()) out.push(buf.trim())
  return out.filter(s => s && !/^(--[^\n]*\n?)*$/.test(s))
}

const SUBSTITUTIONS: RegExp[] = [
  /^create extension if not exists "?pg_net"?[^;]*;$/gim,
  /^create extension if not exists "?pg_stat_statements"?[^;]*;$/gim,
]

export interface CrewTestDb {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>
  exec: (sql: string) => Promise<void>
  /** Run SQL and return the error message, or null when it unexpectedly succeeded.
   *  The whole attempt is rolled back either way, so one attack cannot disturb
   *  the next. */
  expectRefusal: (sql: string) => Promise<string | null>
  /** Act as a signed-in user (sets the JWT claim the policies read). */
  asUser: (uid: string) => Promise<void>
  close: () => Promise<void>
  /** Tenant + fixture ids seeded by boot(). */
  ids: SeedIds
}

export interface SeedIds {
  ownerA: string
  ownerB: string
  crewA1: string
  crewA2: string
  crewB1: string
  techA1: string
  techA2: string
  techB1: string
  customerA: string
  jobA: string
}

export async function bootCrewDb(): Promise<CrewTestDb | { skipped: string }> {
  let PGlite: any, contribs: any = {}
  try {
    const PGLITE = '@electric-sql/pglite'
    ;({ PGlite } = await import(PGLITE))
    const load = async (p: string, k: string) => { try { return (await import(p))[k] } catch { return undefined } }
    contribs = {
      pg_trgm: await load('@electric-sql/pglite/contrib/pg_trgm', 'pg_trgm'),
      pgcrypto: await load('@electric-sql/pglite/contrib/pgcrypto', 'pgcrypto'),
      uuid_ossp: await load('@electric-sql/pglite/contrib/uuid_ossp', 'uuid_ossp'),
    }
  } catch {
    return { skipped: 'PGlite is not installed — npm i -D @electric-sql/pglite to run the database half' }
  }

  const db = await PGlite.create({ extensions: Object.fromEntries(Object.entries(contribs).filter(([, v]) => v)) })

  const apply = async (sql: string) => {
    let s = sql
    for (const p of SUBSTITUTIONS) { s = s.replace(p, '-- [test substitution]'); p.lastIndex = 0 }
    for (const stmt of splitStatements(s)) await db.exec(stmt + ';')
  }

  await apply(readFileSync(PRELUDE, 'utf8'))
  const files = existsSync(MIGRATIONS) ? readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort() : []
  for (const f of files) await apply(readFileSync(join(MIGRATIONS, f), 'utf8'))

  // ── Two tenants, so every isolation claim has a second tenant to fail against.
  const ids: SeedIds = {
    ownerA: '00000000-0000-0000-0000-00000000000a',
    ownerB: '00000000-0000-0000-0000-00000000000b',
    crewA1: '00000000-0000-0000-0000-0000000000c1',
    crewA2: '00000000-0000-0000-0000-0000000000c2',
    crewB1: '00000000-0000-0000-0000-0000000000c3',
    techA1: '00000000-0000-0000-0000-0000000000t1'.replace(/t/g, 'd'),
    techA2: '00000000-0000-0000-0000-0000000000t2'.replace(/t/g, 'd'),
    techB1: '00000000-0000-0000-0000-0000000000t3'.replace(/t/g, 'd'),
    customerA: '00000000-0000-0000-0000-0000000000e1',
    jobA: '00000000-0000-0000-0000-0000000000f1',
  }

  await db.exec(`insert into auth.users (id, email) values
    ('${ids.ownerA}', 'a@example.test'), ('${ids.ownerB}', 'b@example.test')`)
  await db.exec(`insert into public.business_settings (user_id, company_name) values
    ('${ids.ownerA}', 'Tenant A'), ('${ids.ownerB}', 'Tenant B')`)
  await db.exec(`insert into public.crews (id, user_id, name, sort_order) values
    ('${ids.crewA1}', '${ids.ownerA}', 'Crew A', 0),
    ('${ids.crewA2}', '${ids.ownerA}', 'Crew Two', 1),
    ('${ids.crewB1}', '${ids.ownerB}', 'Other tenant crew', 0)`)
  await db.exec(`insert into public.technicians (id, user_id, name, crew_id) values
    ('${ids.techA1}', '${ids.ownerA}', 'Jane', '${ids.crewA1}'),
    ('${ids.techA2}', '${ids.ownerA}', 'Peter', null),
    ('${ids.techB1}', '${ids.ownerB}', 'Other tenant worker', '${ids.crewB1}')`)
  await db.exec(`insert into public.customers (id, user_id, name) values
    ('${ids.customerA}', '${ids.ownerA}', 'A Customer')`)
  await db.exec(`insert into public.jobs (id, user_id, customer_id, title, scheduled_date, crew_id) values
    ('${ids.jobA}', '${ids.ownerA}', '${ids.customerA}', 'A visit', current_date, '${ids.crewA1}')`)

  return {
    ids,
    query: (sql: string, params?: unknown[]) => db.query(sql, params),
    exec: (sql: string) => db.exec(sql),
    asUser: async (uid: string) => { await db.exec(`set request.jwt.claim.sub = '${uid}'`) },
    close: () => db.close(),
    expectRefusal: async (sql: string) => {
      try {
        await db.exec(`begin; ${sql}; rollback;`)
        // It went through. Undo anything that landed before reporting the hole.
        try { await db.exec('rollback') } catch { /* already rolled back */ }
        return null
      } catch (e: any) {
        try { await db.exec('rollback') } catch { /* transaction already aborted */ }
        return String(e?.message ?? e)
      }
    },
  }
}
