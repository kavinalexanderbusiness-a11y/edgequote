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
import { loadEnvLocal } from './lib/verify-fixture'

loadEnvLocal()

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

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

  const candidates: CleanupCandidate[] = []

  // ── Services ───────────────────────────────────────────────────────────────
  head('SERVICE CATALOGUE')
  const { data: svcData, error: svcErr } = await sb
    .from('service_templates')
    .select('id, user_id, name, category, default_rate, is_active, sort_order')
    .order('sort_order')
  if (svcErr) {
    line(`  ⚠️  could not read service_templates: ${svcErr.message}`)
  } else {
    const services = (svcData ?? []) as Array<{
      id: string; user_id: string; name: string; category: string
      default_rate: number; is_active: boolean; sort_order: number
    }>
    const dups = duplicateNameSet(services.map(s => s.name))
    line(`  ${services.length} service(s) read.`)

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

  head('WHAT HAPPENS NEXT')
  line('  ⛔ Nothing above has been changed, and this script cannot change it.')
  line('  Deleting production rows needs an explicit decision on a specific list.')
  line('  Prefer ARCHIVE/DEACTIVATE: the row leaves every live surface and the')
  line('  history that references it stays intact.')
  line('')
  line(`  ${candidates.length} candidate(s).`)
}

main().catch(e => { console.error('hygiene-report failed:', e?.message ?? e); process.exit(1) })
