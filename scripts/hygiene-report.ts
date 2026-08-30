// ── Production hygiene report — CLEANUP CANDIDATES, never a cleanup ──────────
//   npx tsx scripts/hygiene-report.ts            # against .env.local's database
//
// ⛔⛔ THIS SCRIPT IS READ-ONLY AND MUST STAY THAT WAY. It performs no insert,
// update, upsert or delete, and verify:production-hygiene asserts that by
// reading this file. A fixture row can be referenced by a job, an invoice or a
// quote that is REAL; deleting it silently would take the owner's history with
// it. So this produces a LIST for a person, with the references spelled out, and
// stops.
//
// It answers the five questions the brief asks for, per row:
//   entity · id · name · fixture evidence · references/dependencies · recommended action
//
// ⭐ "Recommended" means recommended. Archive is preferred over delete wherever
// the entity supports it: it removes the row from every live surface while the
// history that points at it stays intact and auditable.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  catalogueSuspicions, duplicateNameSet, isAnyFixtureName, isFixtureName,
  recommendedAction, type CleanupCandidate,
} from '../src/lib/fixtureData'
import { publicationState } from '../src/lib/servicePublication'
import { formatServicePrice } from '../src/lib/servicePricing'
import { loadEnvLocal } from './lib/verify-fixture'

loadEnvLocal()

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const ownerEmail = process.env.PORTAL_RPC_OWNER_EMAIL
const ownerPassword = process.env.PORTAL_RPC_OWNER_PASSWORD

// ⭐⭐ WHAT "ZERO ROWS" MEANS DEPENDS ENTIRELY ON WHO IS ASKING, and that
// distinction is the difference between a report and a lie.
//
// Every table below is RLS-protected. Read as an ANONYMOUS caller, PostgREST
// returns `{ data: [], error: null }` — a SUCCESSFUL request that saw nothing,
// because the policy matched no rows. There is no error to notice. A report that
// then prints "None — nothing matches a fixture marker" is asserting the
// catalogue is clean when the truth is that it was never visible. That is a
// false all-clear on exactly the surface this report exists to audit, and it is
// what this script did on its first run.
//
// ── The two authorized read paths, in order of LEAST PRIVILEGE ──────────────
//   1. OWNER SESSION (preferred). A normal sign-in; RLS scopes every read to
//      that owner's own tenant, which is precisely the book being audited. It
//      can see rows, and it can see NOTHING it should not. Read-only by intent —
//      this file contains no write of any kind, asserted by the guard.
//   2. SERVICE ROLE. Bypasses RLS entirely. Only needed to audit a tenant the
//      operator cannot sign in as. Strictly more power than this job requires.
//
// ⛔ Anonymous is NOT a path. It is the state in which the answer is unknowable,
// and the script refuses rather than guessing.
type AuthPath = 'owner' | 'service_role' | 'none'
const authPath: AuthPath = ownerEmail && ownerPassword && anonKey ? 'owner'
  : serviceKey ? 'service_role'
  : 'none'
const key = authPath === 'service_role' ? serviceKey! : anonKey

function line(s = '') { console.log(s) }
function head(s: string) { line(''); line(`═══ ${s} ${'═'.repeat(Math.max(0, 66 - s.length))}`) }

async function countRefs(
  sb: SupabaseClient, specs: { table: string; column: string; value: string }[],
): Promise<Array<{ table: string; count: number }>> {
  const out: Array<{ table: string; count: number }> = []
  for (const s of specs) {
    const { count, error } = await sb.from(s.table).select('id', { count: 'exact', head: true }).eq(s.column, s.value)
    // ⚠️ A failed count is reported as UNKNOWN (-1), never as 0. "We could not
    // check" must never render as "nothing points at it" — that is the exact
    // reading that would make a delete look safe when it is not.
    out.push({ table: s.table, count: error ? -1 : (count ?? 0) })
  }
  return out
}

async function main() {
  if (!url || !key || url.includes('placeholder')) {
    line('⚠️  No live credentials in .env.local — this report needs a database to read.')
    line('    Set NEXT_PUBLIC_SUPABASE_URL and a key. Nothing was read and nothing was changed.')
    process.exit(2)
  }
  const sb = createClient(url, key, { auth: { persistSession: false } })

  line('╔══════════════════════════════════════════════════════════════════════╗')
  line('║  PRODUCTION HYGIENE — CLEANUP CANDIDATES                              ║')
  line('║  READ-ONLY. Nothing below has been changed. Nothing will be.          ║')
  line('╚══════════════════════════════════════════════════════════════════════╝')
  if (authPath === 'none') {
    line('')
    line('⛔⛔ CANNOT AUDIT — no authorized read path, so this would be running as ANON.')
    line('    Every table below is RLS-protected. An anon read returns an EMPTY list')
    line('    with NO error, so "0 rows" here would mean "invisible", not "clean" —')
    line('    and printing it as clean would be a false all-clear on the exact')
    line('    surface this report exists to audit.')
    line('')
    line('    Provide EITHER an owner sign-in (PORTAL_RPC_OWNER_EMAIL/PASSWORD,')
    line('    preferred — RLS keeps it to that tenant) OR SUPABASE_SERVICE_ROLE_KEY.')
    line('    Nothing was changed either way.')
    line('')
    process.exit(3)
  }

  // ⭐ Prove the session before trusting a single count. A sign-in that silently
  // failed would leave an anonymous client behind and every "0" below would be
  // the false all-clear again, wearing a different hat.
  if (authPath === 'owner') {
    const { data: session, error: authErr } = await sb.auth.signInWithPassword({
      email: ownerEmail!, password: ownerPassword!,
    })
    if (authErr || !session?.user) {
      line('')
      line(`⛔⛔ CANNOT AUDIT — the owner sign-in failed: ${authErr?.message ?? 'no session'}`)
      line('    Refusing to continue as an anonymous reader, because every count')
      line('    would then be an empty RLS result rather than a real zero.')
      line('')
      process.exit(3)
    }
    // ⛔ Identity is confirmed by a SUFFIX, never printed in full, and the
    // credentials themselves are never echoed anywhere in this file.
    line('')
    line(`  Read path: OWNER SESSION (RLS-scoped to this tenant). uid …${String(session.user.id).slice(-6)}`)
  } else {
    line('')
    line('  Read path: SERVICE ROLE (RLS bypassed — more power than this job needs).')
  }
  line('  ⛔ READ-ONLY: this script performs no insert, update, upsert or delete.')

  const candidates: CleanupCandidate[] = []

  // ── Services ───────────────────────────────────────────────────────────────
  head('SERVICE CATALOGUE — PUBLICATION INVENTORY')
  // ⚠️ `published_at` may not exist on whatever database this runs against:
  // migration 20260830130000 IS applied to production, but a fresh, older or
  // second-tenant environment can predate it. Probe rather than assume, so this
  // report works on BOTH sides of that apply and says which side it is on.
  const probe = await sb.from('service_templates').select('published_at').limit(1)
  const HAS_PUBLISHED_AT = !(probe.error && /published_at/.test(probe.error.message))
  const cols = 'id, user_id, name, category, default_rate, pricing_display_type, is_active, sort_order'
  const { data: svcData, error: svcErr } = await sb
    .from('service_templates')
    .select(HAS_PUBLISHED_AT ? cols + ', published_at' : cols)
    .order('sort_order')
  if (svcErr) {
    line(`  ⚠️  could not read service_templates: ${svcErr.message}`)
  } else {
    // ⚠️ Cast through `unknown`: the select list is chosen at runtime (the
    // published_at probe above), so supabase-js cannot infer a row type and
    // widens to its error shape. The runtime columns are exactly the two literals.
    const services = (svcData ?? []) as unknown as Array<{
      id: string; user_id: string; name: string; category: string
      default_rate: number; pricing_display_type: string; is_active: boolean
      sort_order: number; published_at?: string | null
    }>
    const dups = duplicateNameSet(services.map(s => s.name))
    line('')
    line(`  ${services.length} service(s) read.`)
    line(HAS_PUBLISHED_AT
      ? '  published_at EXISTS — publication state below is the real one.'
      : '  ⚠️  published_at does NOT exist yet (migration unapplied). CURRENT EXPOSURE is')
    if (!HAS_PUBLISHED_AT) {
      line('      therefore governed by is_active ALONE: every active service is on the')
      line('      public website and in every customer portal RIGHT NOW.')
    }

    // ── The inventory the landing decision is made from ────────────────────
    // One row per service, with the recommendation stated as a RECOMMENDATION.
    // ⛔ Two rules are absolute here and are why this is a report and not a script:
    //   1. A Tier-1 fixture is NEVER recommended for publication.
    //   2. A Tier-2 warning ($0/$1, duplicate, placeholder, odd wording) is
    //      REVIEW — it is never silently decided in either direction.
    line('')
    line('  ID                                    ACTIVE  EXPOSED  PRICE        T1  RECOMMEND      NAME')
    line('  ' + '─'.repeat(108))
    const publishList: string[] = []
    const reviewList: Array<{ id: string; name: string; why: string }> = []
    for (const s of services) {
      const fixture = isFixtureName(s.name)
      const suspicions = catalogueSuspicions(s, {
        duplicateOfName: dups.has(String(s.name ?? '').trim().toLowerCase()) ? s.name : null,
      })
      // CURRENT exposure, on the database as it stands right now.
      const exposedNow = HAS_PUBLISHED_AT
        ? (s.is_active && !!s.published_at)
        : s.is_active
      const price = formatServicePrice({
        pricing_display_type: s.pricing_display_type as never,
        default_rate: Number(s.default_rate),
      })
      // ⛔ Tier 1 first, and it can never be overridden by anything below it.
      let rec: 'PUBLISH' | 'KEEP INTERNAL' | 'REVIEW'
      let why = ''
      if (fixture) { rec = 'KEEP INTERNAL'; why = 'Tier-1 fixture marker — never auto-published' }
      else if (!s.is_active) { rec = 'KEEP INTERNAL'; why = 'inactive' }
      else if (suspicions.length) { rec = 'REVIEW'; why = suspicions.map(x => x.code).join('+') }
      else { rec = 'PUBLISH'; why = 'clean' }

      if (rec === 'PUBLISH') publishList.push(s.id)
      if (rec === 'REVIEW') reviewList.push({ id: s.id, name: s.name, why: suspicions.map(x => x.message).join(' · ') })

      line(`  ${s.id}  ${(s.is_active ? 'yes' : 'no').padEnd(6)}  ${(exposedNow ? 'YES' : 'no').padEnd(7)}  ${price.padEnd(11)}  ${(fixture ? 'Y' : '·').padEnd(2)}  ${rec.padEnd(13)}  ${s.name}`)
      if (rec === 'REVIEW' && exposedNow) line('        ⚠️  CURRENTLY VISIBLE TO CUSTOMERS with the warning above.')
    }

    head('INITIAL PUBLICATION LIST (proposed — nothing applied)')
    line(`  PUBLISH  ${publishList.length} service(s):`)
    for (const id of publishList) line(`    ${id}`)
    line('')
    line(`  REVIEW   ${reviewList.length} service(s) — a person decides, not this script:`)
    for (const r of reviewList) { line(`    ${r.id}  ${r.name}`); line(`        ${r.why}`) }
    line('')
    line('  ⭐ The cutover publishes ONLY the explicit ids above, by id:')
    line('       update public.service_templates set published_at = now()')
    line("        where user_id = <owner> and id in (<the PUBLISH ids>);")
    line('  ⛔ NEVER a broad set-published_at-over-is_active statement — that is the')
    line('     statement that would republish the fixtures this whole lane removes.')

    head('SERVICE QUALITY DETAIL')
    for (const s of services) {
      const suspicions = catalogueSuspicions(s, {
        duplicateOfName: dups.has(String(s.name ?? '').trim().toLowerCase()) ? s.name : null,
      })
      const fixture = isFixtureName(s.name)
      if (!fixture && !suspicions.length) continue

      // A service is referenced by quotes and quote lines. ON DELETE SET NULL is
      // already on those FKs, so a delete would not orphan — but it WOULD erase
      // which service a real historical quote was for.
      const refs = await countRefs(sb, [
        { table: 'quotes', column: 'service_template_id', value: s.id },
        { table: 'quote_services', column: 'service_template_id', value: s.id },
        { table: 'service_pricing_plans', column: 'service_template_id', value: s.id },
      ])

      if (fixture) {
        candidates.push({
          entity: 'service_templates', id: s.id, name: s.name,
          evidence: `name matches a machine-written fixture marker (${s.name.trim().toLowerCase().slice(0, 12)}…)`,
          references: refs,
          action: recommendedAction(refs, { deactivate: true }),
          reason: 'Created by a guard or harness run. Deactivating removes it from every owner surface; it is already invisible to customers unless someone published it.',
        })
      }
      // NOT a candidate for removal — a report line for the owner to answer.
      const state = publicationState(s as never)
      const flags = suspicions.map(x => x.message).join(' · ')
      if (suspicions.length) {
        line(`  • ${s.name}  [${state}]${fixture ? '  ⟵ FIXTURE' : ''}`)
        line(`      ${flags}`)
        if (state === 'published') {
          line('      ⚠️  THIS IS CURRENTLY VISIBLE TO CUSTOMERS.')
        }
      }
    }
  }

  // ── Workers and crews ──────────────────────────────────────────────────────
  head('WORKFORCE')
  for (const [table, refSpecs] of [
    ['technicians', ['jobs.technician_id', 'time_entries.technician_id', 'pay_run_lines.technician_id', 'pto_entries.technician_id']],
    ['crews', ['jobs.crew_id', 'technicians.crew_id', 'dispatch_notes.crew_id']],
  ] as const) {
    const { data, error } = await sb.from(table).select('id, name').order('name')
    if (error) { line(`  ⚠️  could not read ${table}: ${error.message}`); continue }
    const rows = ((data ?? []) as Array<{ id: string; name: string }>).filter(r => isFixtureName(r.name))
    line(`  ${table}: ${rows.length} fixture row(s).`)
    for (const r of rows) {
      const refs = await countRefs(sb, refSpecs.map(spec => {
        const [t, c] = spec.split('.')
        return { table: t, column: c, value: r.id }
      }))
      candidates.push({
        entity: table, id: r.id, name: r.name,
        evidence: 'name matches a machine-written fixture marker',
        references: refs,
        // Only technicians have archived_at; a crew has is_active.
        action: recommendedAction(refs, table === 'technicians' ? { archive: true } : { deactivate: true }),
        reason: table === 'technicians'
          ? 'Archiving keeps statutory payroll records (time entries, wage history, PTO) intact while removing the person from every roster and from capacity.'
          : 'Deactivating removes the crew from dispatch and capacity while any historical job assignment stays readable.',
      })
    }
  }

  // ── Quotes, customers and jobs created by harness runs ─────────────────────
  head('BOOK (quotes · customers)')
  const { data: qData, error: qErr } = await sb
    .from('quotes').select('id, quote_number, customer_name, status, total').order('created_at', { ascending: false }).limit(2000)
  if (qErr) line(`  ⚠️  could not read quotes: ${qErr.message}`)
  else {
    const rows = ((qData ?? []) as Array<{ id: string; quote_number: string; customer_name: string; status: string; total: number }>)
      .filter(q => isAnyFixtureName(q.quote_number, q.customer_name))
    line(`  quotes: ${rows.length} fixture row(s)${rows.length ? ` worth ${rows.reduce((s, r) => s + (Number(r.total) || 0), 0).toFixed(2)} in reported pipeline` : ''}.`)
    for (const q of rows) {
      const refs = await countRefs(sb, [
        { table: 'jobs', column: 'quote_id', value: q.id },
        { table: 'invoices', column: 'quote_id', value: q.id },
        { table: 'payments', column: 'quote_id', value: q.id },
      ])
      candidates.push({
        entity: 'quotes', id: q.id, name: `${q.quote_number} · ${q.customer_name}`,
        evidence: 'quote number or customer name matches a machine-written fixture marker',
        references: refs,
        action: recommendedAction(refs, {}),
        reason: 'Excluded from the dashboard/analytics loader as of this session, so it no longer moves pipeline or revenue. Deleting it is only safe when nothing points at it.',
      })
    }
  }

  const { data: cData, error: cErr } = await sb.from('customers').select('id, name, archived_at').limit(2000)
  if (cErr) line(`  ⚠️  could not read customers: ${cErr.message}`)
  else {
    const rows = ((cData ?? []) as Array<{ id: string; name: string; archived_at: string | null }>)
      .filter(c => isFixtureName(c.name) && !c.archived_at)
    line(`  customers: ${rows.length} un-archived fixture row(s).`)
    for (const c of rows) {
      const refs = await countRefs(sb, [
        { table: 'quotes', column: 'customer_id', value: c.id },
        { table: 'jobs', column: 'customer_id', value: c.id },
        { table: 'invoices', column: 'customer_id', value: c.id },
        { table: 'customer_portal_tokens', column: 'customer_id', value: c.id },
      ])
      candidates.push({
        entity: 'customers', id: c.id, name: c.name,
        evidence: 'name matches a machine-written fixture marker',
        references: refs,
        action: recommendedAction(refs, { archive: true }),
        reason: 'Archiving hides them from every picker and list while their history stays readable. ⛔ A live portal token means somebody could still open their portal — revoke it first.',
      })
    }
  }

  // ── The list ───────────────────────────────────────────────────────────────
  head('CLEANUP CANDIDATES')
  if (!candidates.length) {
    line('  None. Nothing in this database matches a machine-written fixture marker.')
  } else {
    for (const c of candidates) {
      const refStr = c.references.map(r => `${r.table}=${r.count < 0 ? 'UNKNOWN' : r.count}`).join(' ')
      line('')
      line(`  ${c.entity}  ${c.id}`)
      line(`    name       ${c.name}`)
      line(`    evidence   ${c.evidence}`)
      line(`    references ${refStr}`)
      line(`    ACTION     ${c.action.toUpperCase()}`)
      line(`    why        ${c.reason}`)
      if (c.references.some(r => r.count < 0)) {
        line('    ⚠️  a reference count could not be read — treat this row as REFERENCED until it can.')
      }
    }
  }

  if (authPath === 'owner') await sb.auth.signOut({ scope: 'local' }).catch(() => {})

  head('WHAT HAPPENS NEXT')
  line(`  Read via ${authPath === 'owner' ? 'an OWNER SESSION' : 'the SERVICE ROLE'}, so a zero here means zero — not "invisible".`)
  line('  ⛔ Nothing above has been changed, and this script cannot change it.')
  line('  Deleting production rows needs an explicit decision on a specific list.')
  line('  Prefer ARCHIVE/DEACTIVATE: the row leaves every live surface and the')
  line('  history that references it stays intact.')
  line('')
  line(`  ${candidates.length} candidate(s).`)
}

main().catch(e => { console.error('hygiene-report failed:', e?.message ?? e); process.exit(1) })
