// ── Temporary Price Book configuration for the S111 acceptance proof ─────────
//   node scripts/recurring-quote-fixture.mjs setup     # configure + record prior state
//   node scripts/recurring-quote-fixture.mjs teardown  # restore EXACTLY what was there
//
// ⛔⛔ THE RATES HERE ARE NOT THIS BUSINESS'S PRICES AND MUST NEVER BE TREATED AS
// SUCH. They are round, obviously-synthetic figures whose only job is to make the
// arithmetic checkable, and teardown removes every one of them. The owner enters
// their real numbers in the Price Book; nothing in the product ships a default
// rate.
//
// ⭐ WHY THIS EXISTS ALONGSIDE measure-price-fixture.mjs, RATHER THAN REPLACING IT.
// S107's fixture forces `measured_by: 'area'` on both services, because Measure &
// Price was a map feature and a service had to be measured to reach it at all.
// The claim THIS session has to prove is the opposite one:
//
//   A SERVICE CONFIGURED AS *NOT MEASURED* CAN STILL BE SOLD SEVERAL WAYS,
//   AND ITS PLANS REACH A QUOTE WITHOUT ANYONE OPENING A MAP.
//
// So the snow-like fixture here is deliberately `measured_by: null` with FLAT
// plans — $70/visit, $240/month, $900/season, exactly the brief's example. That
// configuration could not be created before this session (the plan editor was
// gated on `measured`) and could not be quoted (the only door was the map, which
// answers "this service isn't measured"). The mowing-like fixture stays measured,
// so both halves are covered by one run.
//
// ⛔ DOES NOT WRITE customer_note / term_label / term_start / term_end. Those
// columns are added by migration 20260827120000, which is UNAPPLIED — Session 106
// owns production schema. Writing them here would fail with 42703 (verified).
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const MODE = process.argv[2] || 'setup'
const STATE = '.recurring-quote-fixture.json'
const E = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z_0-9]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]))
const sb = createClient(E.NEXT_PUBLIC_SUPABASE_URL, E.NEXT_PUBLIC_SUPABASE_ANON_KEY)
const { data: auth, error } = await sb.auth.signInWithPassword({
  email: E.PORTAL_RPC_OWNER_EMAIL, password: E.PORTAL_RPC_OWNER_PASSWORD,
})
if (error) { console.error('login failed:', error.message); process.exit(1) }
const uid = auth.user.id

// ⭐⭐ DISPOSABLE SERVICES, NOT THE OWNER'S OWN. S107's fixture reconfigured the
// tenant's real "Snow Removal" and "Weekly Mowing" catalogue rows — flipping
// is_active and measured_by on live operational records and restoring them
// afterwards. Restoring worked, but the window in which a real service was
// misconfigured is a window in which the owner could have quoted from it.
//
// These two rows are CREATED by setup and DELETED by teardown. Nothing the owner
// configured is read, written or restored, so a crash halfway leaves two obviously
// -named spare services rather than a real service in a state nobody chose.
// service_pricing_plans cascades on the composite FK, so deleting the service
// removes its plans with it.
//
// ⛔ The names are deliberately meaningless. If any assertion in the proof starts
// depending on the WORDS, the universal-CRM rule has already been broken.
const SNOW_LIKE = process.env.FIXTURE_SNOW || 'ZZ S111 Fixture A'
const MOW_LIKE = process.env.FIXTURE_MOW || 'ZZ S111 Fixture B'

// ⭐ The shape is the OWNER'S, not the trade's. Nothing in the product reads
// either service's NAME to decide any of this — swap the two configurations
// between the two services and the app behaves accordingly.
const CONFIG = {
  // NOT measured. Flat prices only. This is the case the session exists for.
  [SNOW_LIKE]: {
    measured_by: null,
    plans: [
      { term: 'one_time', basis: 'flat', rate: 70, is_recommended: false, sort_order: 0 },
      { term: 'monthly', basis: 'flat', rate: 240, is_recommended: true, sort_order: 3 },
      { term: 'seasonal', basis: 'flat', rate: 900, is_recommended: false, sort_order: 4 },
    ],
  },
  // Measured by area, four ways to buy, mixing per-unit and flat.
  [MOW_LIKE]: {
    measured_by: 'area',
    plans: [
      { term: 'one_time', basis: 'per_unit', rate: 0.04, is_recommended: false, sort_order: 0 },
      { term: 'weekly', basis: 'per_unit', rate: 0.03, is_recommended: true, sort_order: 1 },
      { term: 'biweekly', basis: 'per_unit', rate: 0.05, is_recommended: false, sort_order: 2 },
      { term: 'monthly', basis: 'flat', rate: 180, is_recommended: false, sort_order: 3 },
    ],
  },
}

if (MODE === 'setup') {
  if (existsSync(STATE)) {
    console.error(`${STATE} already exists — a previous run was not torn down. Refusing to run twice.`)
    process.exit(1)
  }
  // Refuse to collide with anything real. If a service already carries one of
  // these names it is the owner's, not ours, and we must not touch it.
  const { data: clash } = await sb.from('service_templates')
    .select('id,name').eq('user_id', uid).in('name', [SNOW_LIKE, MOW_LIKE])
  if (clash?.length) {
    console.error(`a service named ${clash.map(c => `"${c.name}"`).join(' / ')} already exists — refusing to touch a real record`)
    process.exit(1)
  }

  const created = []
  for (const [name, cfg] of Object.entries(CONFIG)) {
    const { data: t, error: e1 } = await sb.from('service_templates').insert({
      user_id: uid, name, category: 'ZZ S111 Fixture', is_active: true,
      // A required column with an obviously-synthetic value. ⭐ It is also the
      // fallback the demotion rule talks about: once plans exist, THIS figure
      // must stop pricing the quote.
      default_rate: 1, pricing_display_type: 'starting_from',
      measured_by: cfg.measured_by,
    }).select('id,name').single()
    if (e1) { console.error('fixture service insert failed', name, e1.message); process.exit(1) }
    created.push({ id: t.id, name: t.name })
    // Written to disk as soon as the row exists, so a crash on the NEXT statement
    // still leaves a record of what to delete.
    writeFileSync(STATE, JSON.stringify({ uid, created }, null, 2))

    const rows = cfg.plans.map(x => ({ ...x, user_id: uid, service_template_id: t.id }))
    const { error: e2 } = await sb.from('service_pricing_plans').insert(rows)
    if (e2) { console.error('plan insert failed', name, e2.message); process.exit(1) }
    console.log(`created ${name}: measured_by=${cfg.measured_by ?? 'NOT MEASURED'}, ${rows.length} plans`)
  }
  console.log(`\ncreated ${created.length} disposable services — recorded in ${STATE}. Run teardown to delete them.`)
  console.log('⛔ No existing service, plan, quote or customer was read or modified.')
} else {
  if (!existsSync(STATE)) { console.error(`no ${STATE}; nothing to remove`); process.exit(1) }
  const { created } = JSON.parse(readFileSync(STATE, 'utf8'))
  for (const c of created) {
    // Plans go with the service via the composite FK's ON DELETE CASCADE, but
    // delete them explicitly first so a failure is visible here rather than
    // inferred from a cascade that may or may not have fired.
    await sb.from('service_pricing_plans').delete().eq('user_id', uid).eq('service_template_id', c.id)
    const { error } = await sb.from('service_templates').delete().eq('id', c.id).eq('user_id', uid)
    if (error) console.error('fixture service delete failed', c.name, error.message)
    else console.log(`deleted ${c.name}`)
  }
  // Prove it: nothing of ours may survive teardown.
  const { data: svcLeft } = await sb.from('service_templates')
    .select('id').eq('user_id', uid).in('id', created.map(c => c.id))
  const { data: planLeft } = await sb.from('service_pricing_plans')
    .select('id').eq('user_id', uid).in('service_template_id', created.map(c => c.id))
  const ok = (svcLeft || []).length === 0 && (planLeft || []).length === 0
  console.log(`\nfixture services remaining: ${(svcLeft || []).length} · fixture plans remaining: ${(planLeft || []).length} (both must be 0)`)
  console.log(ok ? '✓ tenant clean' : '⚠️  TEARDOWN INCOMPLETE — inspect before trusting this tenant')
  process.exit(ok ? 0 : 1)
}
process.exit(0)
