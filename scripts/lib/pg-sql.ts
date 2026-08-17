// ── Applying repository SQL to a disposable Postgres ─────────────────────────
//
// Two guards build an empty database from the repository and then ask it
// questions: verify:rebuild (does the repo reconstruct production's schema?) and
// verify:audit-trail (does the audit trail behave, from zero?). Both need the same
// two things, so both get them from here rather than each keeping a copy — a second
// splitter would drift, and the failure mode is a guard that silently applies less
// than it thinks.
//
// ⚠️ WHY SPLITTING IS NOT OPTIONAL: handing PGlite the whole 550 KB baseline in one
// exec exhausts the WASM heap. More usefully, splitting means a failure names the
// exact statement instead of the whole file.

/**
 * Split SQL into statements, respecting dollar-quoted bodies ($$ … $$ and
 * $function$ … $function$), line comments and string literals — none of which may
 * have their semicolons treated as terminators.
 */
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
  return out.filter(s => s && !isOnlyComments(s))
}

/**
 * Is this chunk nothing but comments and blank lines?
 *
 * ⚠️ THIS WAS A REGEX AND THE REGEX WAS A TRAP. `/^(--[^\n]*\n?)*$/` looks
 * obviously correct and is linear on the inputs anyone tried — until a statement
 * carries a long comment banner ahead of it. A migration that opens with ~70
 * comment lines and then real SQL makes the nested quantifier backtrack
 * exponentially: the match fails, and it re-partitions those lines forever at
 * 100% CPU. It does not throw and it does not finish — the guard simply hangs,
 * which reads as "slow test" rather than "bug".
 *
 * A line-wise scan is O(n), and says the same thing in a way that cannot explode.
 */
function isOnlyComments(chunk: string): boolean {
  for (const line of chunk.split('\n')) {
    const t = line.trim()
    if (t !== '' && !t.startsWith('--')) return false
  }
  return true
}

/**
 * Load PGlite, or report that it is absent.
 *
 * PGlite is an OPTIONAL dependency — deliberately not in package.json (~100 MB, and
 * Vercel builds already OOM), so on CI and on a fresh clone it is simply missing and
 * the caller SKIPS rather than fails.
 *
 * ⚠️ The specifier is held in a VARIABLE on purpose. A literal import specifier makes
 * `tsc`/`next build` demand types for a package designed to be absent → CI red on a
 * fresh clone. A non-literal one is unresolvable at compile time and resolved at
 * runtime, which is exactly the semantics this needs.
 */
export async function loadPGlite(): Promise<{ PGlite: any; contribs: Record<string, any> } | null> {
  try {
    const PGLITE = '@electric-sql/pglite'
    const { PGlite } = await import(PGLITE)
    const load = async (p: string, k: string) => { try { return (await import(p))[k] } catch { return undefined } }
    const contribs: Record<string, any> = {
      pg_trgm: await load('@electric-sql/pglite/contrib/pg_trgm', 'pg_trgm'),
      pgcrypto: await load('@electric-sql/pglite/contrib/pgcrypto', 'pgcrypto'),
      uuid_ossp: await load('@electric-sql/pglite/contrib/uuid_ossp', 'uuid_ossp'),
    }
    return { PGlite, contribs: Object.fromEntries(Object.entries(contribs).filter(([, v]) => v)) }
  } catch {
    return null
  }
}

/**
 * Statements a rebuild rewrites because the OBJECT is provided by the Supabase
 * platform rather than by this repository, and the prelude already supplies an
 * equivalent. Each substitution is named so it can be printed — never a silent
 * filter, because a quiet skip is how a rebuild test starts lying about what it
 * proved.
 */
export const PLATFORM_SUBSTITUTIONS: { pattern: RegExp; what: string; why: string }[] = [
  {
    pattern: /^create extension if not exists "?pg_net"?[^;]*;$/gim,
    what: 'create extension pg_net',
    why: 'platform-only async HTTP extension; prelude provides net.http_post()',
  },
  {
    pattern: /^create extension if not exists "?pg_stat_statements"?[^;]*;$/gim,
    what: 'create extension pg_stat_statements',
    why: 'platform observability, needs shared_preload_libraries; owns no application object',
  },
]

export function substitutePlatformStatements(sql: string): { sql: string; hits: string[] } {
  const hits: string[] = []
  let out = sql
  for (const s of PLATFORM_SUBSTITUTIONS) {
    if (s.pattern.test(out)) {
      s.pattern.lastIndex = 0
      out = out.replace(s.pattern, `-- [rebuild-test substitution] ${s.what} — ${s.why}`)
      hits.push(`${s.what} → ${s.why}`)
    }
    s.pattern.lastIndex = 0
  }
  return { sql: out, hits }
}
