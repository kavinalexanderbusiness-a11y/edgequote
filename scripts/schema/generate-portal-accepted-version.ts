// ── Generate the portal accepted-version migration from the CURRENT baseline ──
//   npx tsx scripts/schema/generate-portal-accepted-version.ts [version]
//
// THE LANDING PROPERTY THIS ENCODES (review blocker 3): S112 must add the
// acceptance projection to whatever get_portal_data has BECOME by landing day —
// preserving every privacy/publication/security predicate that has landed since
// this branch was cut — and must never ship a stale full-body copy. So the
// migration is not hand-kept: it is GENERATED from the newest baseline in the
// apply path, and this generator REFUSES to run when the function no longer
// looks the way the transformation expects. verify:accepted-document-truth
// closes the loop: it strips the injected block from the committed migration and
// requires the remainder to be BYTE-IDENTICAL to the current baseline's body —
// so the moment main moves the function (S113's publication gate, anything
// else), the guard goes red and the answer is to re-run this generator, never
// to hand-edit.
//
// AT LANDING (S106): reconcile onto final main, re-run this generator, assign
// the version from the LIVE LEDGER (this file's default is a placeholder in
// exactly the sense d6be0bf7 re-versioned S114's), apply schema first,
// recapture contract/baseline, deploy the app after.
//
// The 20260830090000 lesson is also encoded here: the first cut of this
// migration sliced the baseline by LINE RANGE to "the first standalone
// $function$; line" — but get_portal_data terminates INLINE (`end; $function$;`)
// and its alphabetical neighbours (guard_*, handle_updated_at, inbox_counts)
// rode along, each a stale CREATE OR REPLACE able to erase another lane's fix.
// This parser finds the function's own dollar-quoted terminator, and the guard
// refuses a migration defining anything but get_portal_data.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIG = join(process.cwd(), 'supabase', 'migrations')

export const MARK_START = '-- >>> s112-accepted-version projection >>>'
export const MARK_END = '-- <<< s112-accepted-version projection <<<'

/** The injected projection — the ONLY thing this migration changes. */
export const PROJECTION = [
  `             ${MARK_START}`,
  '             -- The LATEST acceptance-ledger row for this quote, so the portal can',
  '             -- render what was ACCEPTED as a document distinct from the live row an',
  '             -- owner may since have edited. needs_reapproval is DERIVED from the',
  '             -- material fingerprint at read time — the same single expression',
  '             -- quote_acceptance_state() uses — never a stored flag. `kind` is the',
  '             -- normalized EVIDENCE KIND (customer | owner_on_behalf |',
  '             -- legacy_unrecorded) the customer-facing labels need to stay honest;',
  '             -- actor ids, on-behalf notes and other operational internals are',
  '             -- deliberately NOT projected. NULL when nothing was accepted.',
  '             (select json_build_object(',
  "                'accepted_at',        a.accepted_at,",
  "                'kind',               a.kind,",
  "                'accepted_amount',    a.accepted_amount,",
  "                'selected_option_id', a.selected_option_id,",
  "                'document',           a.document,",
  "                'terms_acknowledged', a.terms_acknowledged,",
  "                'terms_text',         a.terms_text,",
  "                'needs_reapproval',",
  '                  public.quote_material_fingerprint(qt.id) is distinct from a.document_fingerprint',
  '              ) from public.quote_acceptances a',
  '              where a.quote_id = qt.id',
  '              order by a.seq desc limit 1) as acceptance',
  `             ${MARK_END}`,
].join('\n')

/** Where the projection goes: immediately before the quotes subquery's SELECT
 *  list ends. This anchor line closes the nested services agg — the LAST column
 *  of the projection — inside the quotes subquery. */
const ANCHOR = ") s), '[]'::json) as services"

export function latestBaseline(): string {
  const b = readdirSync(MIG).filter(f => /_baseline\.sql$/i.test(f)).sort().at(-1)
  if (!b) throw new Error('no *_baseline.sql in the apply path')
  return b
}

/** Extract EXACTLY get_portal_data from a baseline: the CREATE line through the
 *  function's OWN dollar-quoted terminator (which is inline: `end; $function$;`).
 *  Refuses on zero or multiple definitions. */
export function extractPortalFn(baselineSql: string): string {
  const starts = [...baselineSql.matchAll(/CREATE OR REPLACE FUNCTION public\.get_portal_data\(p_token text\)/g)]
  if (starts.length !== 1) throw new Error(`expected exactly one get_portal_data definition, found ${starts.length}`)
  const start = starts[0].index!
  const opener = baselineSql.indexOf('AS $function$', start)
  if (opener < 0) throw new Error('get_portal_data body opener not found')
  const close = baselineSql.indexOf('$function$;', opener + 'AS $function$'.length)
  if (close < 0) throw new Error('get_portal_data body terminator not found')
  return baselineSql.slice(start, close + '$function$;'.length)
}

/** The transformation. Refuses when the function no longer matches the shape it
 *  expects — the review's "narrow guarded transformation" property. */
export function injectProjection(fnBody: string): string {
  // Idempotent: strip a previously injected block first (regeneration).
  const stripped = fnBody.replace(
    new RegExp(`\\s*${MARK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '')

  // ── REFUSAL ANCHORS — each one is a predicate this migration must not lose ──
  const REQUIRED: [string, RegExp][] = [
    ['the quotes projection anchor (services agg close)', new RegExp(ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))],
    ['draft-QUOTE privacy predicate', /from public\.quotes qt where qt\.customer_id = v_customer and qt\.user_id = v_user and qt\.status <> 'draft'/],
    ['draft-INVOICE privacy predicate', /from public\.invoices where customer_id = v_customer and user_id = v_user and status <> 'draft'/],
    ['tenant filter on the customer row', /from public\.customers where id = v_customer and user_id = v_user/],
  ]
  for (const [name, re] of REQUIRED) {
    if (!re.test(stripped)) throw new Error(`REFUSED: expected shape missing — ${name}. The function has changed; update this generator deliberately.`)
  }
  const FORBIDDEN: [string, RegExp][] = [
    ['internal job notes must not be projected', /\binternal_notes\b/],
    ['completion issues must not be projected', /\bcompletion_issue\b/],
  ]
  // ⚠️ Strip comments first: the live body documents absent columns BY NAME in
  // `--` comments (the verify-portal-requests lesson).
  const sqlOnly = stripped.split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n')
  for (const [name, re] of FORBIDDEN) {
    if (re.test(sqlOnly)) throw new Error(`REFUSED: ${name}.`)
  }
  // The anchor must be UNIQUE, or the injection point is ambiguous — and the
  // injection assumes `services` is the quotes subquery's LAST column (the
  // `from public.quotes qt …` clause follows directly). If either stops being
  // true the function's shape has changed: refuse, don't guess.
  if (stripped.split(ANCHOR).length !== 2) throw new Error('REFUSED: the services anchor is not unique.')
  if (!new RegExp(ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\r?\\n\\s*from public\\.quotes qt\\b').test(stripped)) {
    throw new Error('REFUSED: services is no longer the last column of the quotes subquery — re-anchor this generator deliberately.')
  }

  // services keeps no trailing comma today; acceptance becomes the new last
  // column, so the comma moves onto the anchor line and acceptance ends bare.
  return stripped.replace(ANCHOR, ANCHOR + ',\n' + PROJECTION)
}

export function buildMigration(version: string): { file: string; sql: string; baseline: string } {
  const baseline = latestBaseline()
  const fn = extractPortalFn(readFileSync(join(MIG, baseline), 'utf8'))
  const out = injectProjection(fn)
  const header = `-- ── Session 112 · accepted-document-truth: the portal learns what was ACCEPTED ──
--
-- GENERATED by scripts/schema/generate-portal-accepted-version.ts from
-- ${baseline} — regenerate, never hand-edit. verify:accepted-document-truth
-- fails if this file's body (minus the marked projection) is not byte-identical
-- to the current baseline's get_portal_data, so a baseline moving under this
-- lane (S113's publication gate, anything else) turns this file stale LOUDLY.
--
-- WHAT CHANGES: each quote row gains a marked \`acceptance\` object read from the
-- LATEST quote_acceptances row. Everything outside the markers is the current
-- effective function, verbatim. This file defines get_portal_data and NOTHING
-- else (the 20260830090000 lesson: a sliced baseline dragged five unrelated
-- stale function bodies along; the guard now refuses any second definition).
--
-- LANDING (S106): reconcile onto final main → re-run the generator → assign the
-- version from the LIVE ledger → schema first → recapture contract/baseline →
-- deploy app. Same signature, plain CREATE OR REPLACE — no overload is created.

`
  return { file: `${version}_portal_accepted_version.sql`, sql: header + out + '\n', baseline }
}

// CLI
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('generate-portal-accepted-version.ts')
if (isMain) {
  const version = process.argv[2] || '20260830150000'
  if (!/^\d{14}$/.test(version)) { console.error('version must be 14 digits'); process.exit(2) }
  const { file, sql, baseline } = buildMigration(version)
  // Refuse to write a version that does not sort after the baseline it reads.
  if (file <= baseline) { console.error(`REFUSED: ${file} must sort after ${baseline}`); process.exit(2) }
  writeFileSync(join(MIG, file), sql)
  console.log(`wrote supabase/migrations/${file} from ${baseline} (${sql.length} bytes)`)
}
