// READ-ONLY probe: run the renewal + reactivation engines against the owner's
// real book, exactly as the page does. No writes, nothing asserted (an existence
// claim over live data is a coin flip) — this exists to watch the engines answer
// on real rows. Scratch tool; not part of the verify suite.
import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { loadRenewals } from '../src/lib/renewals'
import { loadReactivation } from '../src/lib/reactivation'

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { error } = await sb.auth.signInWithPassword({
    email: process.env.PORTAL_RPC_OWNER_EMAIL!,
    password: process.env.PORTAL_RPC_OWNER_PASSWORD!,
  })
  if (error) { console.error('sign-in failed:', error.message); process.exit(1) }

  const r = await loadRenewals(sb)
  console.log('\n== RENEWALS ==')
  if (!r.ok) console.log('  load failed (reported honestly):', r.error)
  else {
    console.log(`  ${r.report.opportunities.length} plan(s) queued | ${r.report.actionable} need the owner | $${r.report.valueAtStake} last cycle`)
    for (const o of r.report.opportunities) {
      console.log(`   - ${o.customer.name} | ${o.cadenceLabel} ${o.serviceName} | [${o.stage}] ${o.reason}`)
    }
  }

  const a = await loadReactivation(sb)
  console.log('\n== REACTIVATION ==')
  if (!a.ok) console.log('  load failed (reported honestly):', a.error)
  else {
    const rep = a.report
    console.log(`  at risk ${rep.atRisk} (ran out ${rep.ranOuts.length}, lapsed ${rep.risks.length}) | dormant ${rep.dormant.length} NOT counted`)
    for (const d of rep.dormant) console.log(`   ~ ${d.customer.name}: [${d.reason}] ${d.note}`)
    for (const x of rep.ranOuts) console.log(`   ! ${x.customer.name}: ran out, ${x.daysSince}d since last service`)
    for (const x of rep.risks) console.log(`   . ${x.customer.name}: lapsed ${x.bucket} (${x.daysSince}d)`)
  }
  await sb.auth.signOut({ scope: 'local' })
}
main()
