// ── Temporary Price Book configuration for the acceptance proof ──────────────
//   node scripts/measure-price-fixture.mjs setup    # configure + record prior state
//   node scripts/measure-price-fixture.mjs teardown # restore EXACTLY what was there
//
// ⛔⛔ THE RATES HERE ARE NOT THIS BUSINESS'S PRICES AND MUST NEVER BE TREATED AS
// SUCH. The brief is explicit: do not invent snow-removal numbers and do not
// infer them from old quotes. These are round, obviously-synthetic figures whose
// only job is to make the arithmetic checkable (0.05 × 1392 = 70), and teardown
// removes every one of them. The owner enters their real numbers in the Price
// Book; nothing in the product ships a default rate.
//
// ⭐ Two shapes are configured because the whole claim of this feature is that
// the shape is the OWNER'S, not the trade's:
//   snow-like  : area → one-time (per unit) + monthly (flat) + seasonal (flat)
//   mowing-like: area → one-time + weekly + bi-weekly (per unit) + monthly (flat)
// Nothing in the product reads either service's NAME to decide this.
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const MODE = process.argv[2] || 'setup'
const STATE = '.measure-price-fixture.json'
const E = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z_0-9]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]))
const sb = createClient(E.NEXT_PUBLIC_SUPABASE_URL, E.NEXT_PUBLIC_SUPABASE_ANON_KEY)
const { data: auth, error } = await sb.auth.signInWithPassword({
  email: E.PORTAL_RPC_OWNER_EMAIL, password: E.PORTAL_RPC_OWNER_PASSWORD,
})
if (error) { console.error('login failed:', error.message); process.exit(1) }
const uid = auth.user.id

const SNOW_LIKE = process.env.FIXTURE_SNOW || 'Snow Removal'
const MOW_LIKE = process.env.FIXTURE_MOW || 'Weekly Mowing'

const PLANS = {
  [SNOW_LIKE]: [
    { term: 'one_time', basis: 'per_unit', rate: 0.05, is_recommended: false, sort_order: 0 },
    { term: 'monthly', basis: 'flat', rate: 240, is_recommended: true, sort_order: 1 },
    { term: 'seasonal', basis: 'flat', rate: 900, is_recommended: false, sort_order: 2 },
  ],
  [MOW_LIKE]: [
    { term: 'one_time', basis: 'per_unit', rate: 0.04, is_recommended: false, sort_order: 0 },
    { term: 'weekly', basis: 'per_unit', rate: 0.03, is_recommended: true, sort_order: 1 },
    { term: 'biweekly', basis: 'per_unit', rate: 0.035, is_recommended: false, sort_order: 2 },
    { term: 'monthly', basis: 'flat', rate: 180, is_recommended: false, sort_order: 3 },
  ],
}

const { data: templates } = await sb.from('service_templates')
  .select('id,name,is_active,measured_by').eq('user_id', uid).in('name', [SNOW_LIKE, MOW_LIKE])

if (MODE === 'setup') {
  const prior = []
  for (const t of templates || []) {
    prior.push({ id: t.id, name: t.name, is_active: t.is_active, measured_by: t.measured_by })
    const { error: e1 } = await sb.from('service_templates')
      .update({ measured_by: 'area', is_active: true }).eq('id', t.id).eq('user_id', uid)
    if (e1) { console.error('template update failed', t.name, e1.message); process.exit(1) }
    const rows = (PLANS[t.name] || []).map(p => ({ ...p, user_id: uid, service_template_id: t.id }))
    const { error: e2 } = await sb.from('service_pricing_plans').insert(rows)
    if (e2) { console.error('plan insert failed', t.name, e2.message); process.exit(1) }
    console.log(`configured ${t.name}: measured_by=area, ${rows.length} plans (was is_active=${t.is_active}, measured_by=${t.measured_by})`)
  }
  writeFileSync(STATE, JSON.stringify({ uid, prior }, null, 2))
  console.log(`\nprior state recorded in ${STATE} — run teardown to restore it exactly.`)
} else {
  if (!existsSync(STATE)) { console.error(`no ${STATE}; nothing to restore`); process.exit(1) }
  const { prior } = JSON.parse(readFileSync(STATE, 'utf8'))
  for (const p of prior) {
    const { error: e1 } = await sb.from('service_pricing_plans')
      .delete().eq('user_id', uid).eq('service_template_id', p.id)
    if (e1) console.error('plan delete failed', p.name, e1.message)
    const { error: e2 } = await sb.from('service_templates')
      .update({ measured_by: p.measured_by, is_active: p.is_active }).eq('id', p.id).eq('user_id', uid)
    if (e2) console.error('template restore failed', p.name, e2.message)
    console.log(`restored ${p.name}: is_active=${p.is_active}, measured_by=${p.measured_by}, plans removed`)
  }
  // Prove it: nothing of ours may survive teardown.
  const { data: left } = await sb.from('service_pricing_plans')
    .select('id').eq('user_id', uid).in('service_template_id', prior.map(p => p.id))
  console.log(`\nremaining fixture plans: ${(left || []).length} (must be 0)`)
}
process.exit(0)
