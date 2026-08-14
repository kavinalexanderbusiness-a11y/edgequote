// ── Where guards read the schema from ────────────────────────────────────────
//
// Until 2026-08-14 guards read two files that no longer exist:
//
//   supabase/schema.sql                     a 2026-06-25 snapshot, seven weeks stale
//   supabase/CANONICAL-get_portal_data.sql  a hand-maintained copy of a live function
//
// Both are now under supabase/archive/ and are never applied. The single source is
// the generated baseline in supabase/migrations/, which is produced FROM the live
// catalogue — so a guard reading it is asserting against what the database actually
// runs, not against what a file claimed months ago.
//
// That distinction is not academic. On 2026-08-14 the canonical file was missing the
// `change_orders` projection that production had been serving since 05:33 that
// morning. Every guard reading that file was quietly checking a fiction, and the
// deploy checklist said to run it LAST — which would have deleted the projection
// from the live portal.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = 'supabase/migrations'

/** Absolute-ish path of the one baseline file, or '' when it is absent. */
export function baselineFile(): string {
  if (!existsSync(MIGRATIONS)) return ''
  const f = readdirSync(MIGRATIONS).filter(n => /_baseline\.sql$/.test(n)).sort().pop()
  return f ? join(MIGRATIONS, f) : ''
}

/** The whole baseline. Normalised to \n so line-oriented checks behave on Windows. */
export function baselineSql(): string {
  const f = baselineFile()
  if (!f) {
    console.error('✗ no supabase/migrations/*_baseline.sql — run: npm run schema:baseline')
    process.exit(1)
  }
  return readFileSync(f, 'utf8').replace(/\r\n?/g, '\n')
}

/**
 * Just the body of one function, isolated from the baseline.
 *
 * Isolation matters: the baseline defines ~111 functions, so running a projection
 * regex over the whole file lets a phrase from a neighbouring function satisfy a
 * check meant for this one. `internal_notes` appearing ANYWHERE would look like the
 * portal leaking it.
 */
export function functionSql(name: string): string {
  const src = baselineSql()
  const re = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\s*\\([\\s\\S]*?\\$function\\$[\\s\\S]*?\\$function\\$`,
    'gi',
  )
  const hits = src.match(re)
  return hits ? hits[hits.length - 1] : ''
}

/**
 * The customer portal RPC. THE definition — there is exactly one, in the baseline,
 * and verify:portal-canonical fails if that ever stops being true.
 */
export function portalDataSql(): string {
  const body = functionSql('get_portal_data')
  if (!body) {
    console.error('✗ get_portal_data not found in the baseline — has the generator changed its output?')
    process.exit(1)
  }
  return body
}
