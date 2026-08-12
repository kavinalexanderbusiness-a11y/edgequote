// ── The fixture harness: where a guard is allowed to write ───────────────────
//
// THE INCIDENT THIS EXISTS TO PREVENT. `verify:quote-options` used to create its
// fixture quote in the OWNER's tenant, attach it to a REAL customer — the first
// live portal token in the book — and accept it through that customer's own portal
// door. A quote reaching 'accepted' fires trg_notify_quote_accepted, so every run
// put "Automated guard fixture — safe to delete accepted a quote" in the owner's
// notification bell. Forty-five runs in two hours; forty-five alerts, each linking
// to a quote the guard had already deleted. The customer's portal, meanwhile,
// showed a $5,550 job at "1 Verification Way" for as long as the run took.
//
// THE FIX IS NOT SUPPRESSION. The trigger is right — an accepted quote is exactly
// what an owner must hear about — and a "unless it's a test" branch on a
// notification path is how real alerts go missing. Nothing in `src/` changed.
//
// THE BOUNDARY IS THE TENANT. Every notification, message and RLS policy in this
// schema is scoped by user_id. A fixture that belongs to a DIFFERENT user_id
// cannot reach the owner: the trigger still fires, and it notifies a tenant nobody
// is looking at. The isolation is Postgres's, not a convention this file follows.
//
// ⭐ THE INTERLOCK. openFixtureTenant() calls is_verify_fixture_tenant() and
// ABORTS THE PROCESS if the answer is not exactly `true` — before it has written
// anything. A guard cannot be pointed at the real book by editing an env var,
// because the credentials alone are not enough: the tenant must also be marked in
// a table that RLS makes unreadable and unwritable to every signed-in user. There
// is no header, query flag or request parameter in this design; nothing a caller
// sends can make the application treat them as a test, and the marker relaxes no
// rule anywhere. See supabase/RUN-2026-08-11-verify-fixture-tenant.sql.
//
// ⭐ CONCURRENCY. Fixture rows used to be named by a constant (ZZ-VERIFY-OPTIONS),
// and each run began by deleting every row with that name — so two concurrent runs
// deleted each other's fixtures and reported failures neither had caused. Every
// name now carries this run's own RUN_ID, and a run only ever deletes rows carrying
// its own. Rows from an ABANDONED run (killed mid-way) are swept by AGE, never by
// name, so a sweep can never reach a run still in flight.

import { readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/** Load .env.local without overriding anything already in the environment. */
export function loadEnvLocal(): void {
  if (!existsSync('.env.local')) return
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}

export interface FixtureTenant {
  /** Signed in AS the fixture tenant. Every write in a guard goes through this. */
  db: SupabaseClient
  /** Unauthenticated, for exercising customer-facing doors (portal RPCs). */
  anon: SupabaseClient
  /** The fixture tenant's user_id — never the owner's. */
  uid: string
  /** Unique to THIS process. Two concurrent runs never share one. */
  runId: string
  /** `tag('OPTIONS')` → `ZZ-OPTIONS-<runId>`. Namespaced, so runs cannot collide. */
  tag: (base: string) => string
  /** A customer that belongs to the fixture tenant, created on demand. */
  fixtureCustomer: () => Promise<{ id: string; token: string | null }>
  /**
   * A catalogue entry that belongs to the fixture tenant. A guard used to read
   * the owner's first `service_templates` row — a real service, at a real rate,
   * whose name then appeared on fixture quotes. The fixture tenant starts empty,
   * so anything a guard needs, it makes.
   */
  fixtureTemplate: () => Promise<{ id: string; name: string; default_rate: number }>
  /** Deletes everything this run made, then signs out. Safe to call twice. */
  close: () => Promise<void>
}

/** What a guard gets when the live half cannot run. Never an error — CI is green. */
export interface FixtureSkipped { skipped: string }

export function isSkipped(r: FixtureTenant | FixtureSkipped): r is FixtureSkipped {
  return (r as FixtureSkipped).skipped !== undefined
}

// An abandoned run's rows are swept after this long. Comfortably longer than any
// guard takes (seconds), so a sweep can never touch a run still in flight — which
// is the entire reason the old constant-name sweep was unsafe.
const STALE_AFTER_MS = 60 * 60 * 1000

/**
 * Open a writable fixture session, or explain why the live half is skipped.
 *
 * ⛔ Aborts the process rather than returning if the credentials resolve to a
 * tenant that is NOT marked as a fixture tenant. That is not a skip: it means a
 * guard was one env var away from writing into somebody's real book, and the run
 * must stop loudly rather than quietly do less.
 */
export async function openFixtureTenant(label: string): Promise<FixtureTenant | FixtureSkipped> {
  loadEnvLocal()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const email = process.env.VERIFY_FIXTURE_EMAIL
  const password = process.env.VERIFY_FIXTURE_PASSWORD

  // CI runs with placeholder Supabase values; there is nothing to talk to.
  if (!url || !anonKey || url.includes('placeholder')) {
    return { skipped: 'no live Supabase credentials (CI runs with placeholders)' }
  }
  if (!email || !password) {
    return {
      skipped: 'no fixture tenant — set VERIFY_FIXTURE_EMAIL / VERIFY_FIXTURE_PASSWORD.\n'
        + '      These must name a tenant marked in verify_fixture_tenants; the owner\'s own\n'
        + '      login will be REFUSED. See supabase/RUN-2026-08-11-verify-fixture-tenant.sql.',
    }
  }

  const db = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data: auth, error: authErr } = await db.auth.signInWithPassword({ email, password })
  if (authErr || !auth?.user) {
    return { skipped: `fixture tenant sign-in failed (${authErr?.message ?? 'no user'})` }
  }
  const uid = auth.user.id

  // ── THE INTERLOCK ──────────────────────────────────────────────────────────
  // Asked of the database, about the caller, before a single row is written. A
  // `false` here means these credentials belong to a real business.
  const { data: marked, error: markErr } = await db.rpc('is_verify_fixture_tenant')
  if (markErr || marked !== true) {
    console.error(
      `\n⛔ REFUSING TO WRITE — ${label} signed in as ${email}, which is NOT a marked`
      + `\n   verification fixture tenant (is_verify_fixture_tenant returned `
      + `${markErr ? `error: ${markErr.message}` : JSON.stringify(marked)}).`
      + `\n\n   A guard writes fixtures — quotes, customers, approvals — and those fire the`
      + `\n   same triggers a real record does. Against a real tenant that means alerts in`
      + `\n   somebody's notification bell and fake work in a real customer's portal, which`
      + `\n   is exactly what happened on 2026-08-11. Point VERIFY_FIXTURE_* at a marked`
      + `\n   tenant, or leave them unset and this guard will skip its live half.\n`,
    )
    await db.auth.signOut().catch(() => {})
    process.exit(1)
  }

  const runId = randomUUID().slice(0, 8)
  const tag = (base: string) => `ZZ-${base}-${runId}`
  console.log(`  · fixture tenant ${uid.slice(0, 8)}… run ${runId} (isolated: not the owner's book)`)

  // Sweep ABANDONED runs — by age, never by name. A run killed with Ctrl-C leaves
  // rows behind; without this they accumulate forever. With it, a concurrent run's
  // seconds-old rows are never in range.
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString()
  await db.from('quotes').delete().eq('user_id', uid).like('quote_number', 'ZZ-%').lt('created_at', staleBefore)
  await db.from('service_bundles').delete().eq('user_id', uid).like('name', 'ZZ-%').lt('created_at', staleBefore)

  let customer: { id: string; token: string | null } | null = null

  const fixtureCustomer = async () => {
    if (customer) return customer
    const { data: c, error: cErr } = await db.from('customers').insert({
      user_id: uid,
      name: tag('CUSTOMER'),
      // Structurally undeliverable on both channels. `.invalid` is reserved by
      // RFC 2606 and can never resolve; +1 555 01xx is the reserved fictional
      // range. Even if a send path were ever reached, there is nowhere to send.
      email: `${tag('customer').toLowerCase()}@edgequote.invalid`,
      phone: '+15550100',
      address: 'Verification fixture — not a real address',
      sms_opt_in: false, email_opt_in: false,
    }).select('id').single()
    if (cErr || !c) throw new Error(`could not create the fixture customer: ${cErr?.message}`)
    const id = (c as { id: string }).id
    // A portal token OF THE FIXTURE TENANT'S OWN CUSTOMER. The old guard borrowed a
    // real customer's live token, which is why a real person's portal showed a fake
    // quote. This token addresses nothing but fixture data.
    const { data: t } = await db.from('customer_portal_tokens')
      .insert({ user_id: uid, customer_id: id, token: `zz-fixture-${runId}-${randomUUID()}`, revoked: false })
      .select('token').single()
    customer = { id, token: (t as { token: string } | null)?.token ?? null }
    return customer
  }

  let template: { id: string; name: string; default_rate: number } | null = null

  const fixtureTemplate = async () => {
    if (template) return template
    const { data, error } = await db.from('service_templates').insert({
      user_id: uid, name: tag('SERVICE'), category: 'General', default_rate: 60,
      default_description: 'Verification fixture — not a real service', is_active: true,
    }).select('id, name, default_rate').single()
    if (error || !data) throw new Error(`could not create the fixture service template: ${error?.message}`)
    template = data as { id: string; name: string; default_rate: number }
    return template
  }

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    // Only ever this run's rows. Quotes cascade to their options; customers cascade
    // to their portal tokens.
    await db.from('quotes').delete().eq('user_id', uid).like('quote_number', `%${runId}%`)
    await db.from('service_bundles').delete().eq('user_id', uid).like('name', `%${runId}%`)
    await db.from('service_templates').delete().eq('user_id', uid).like('name', `%${runId}%`)
    if (customer) await db.from('customers').delete().eq('id', customer.id)
    // Notifications the fixture's own triggers raised — in the FIXTURE tenant, so
    // nobody ever saw them. Cleared anyway so the tenant stays a clean room.
    await db.from('notifications').delete().eq('user_id', uid)
    await db.auth.signOut().catch(() => {})
  }

  return { db, anon: createClient(url, anonKey), uid, runId, tag, fixtureCustomer, fixtureTemplate, close }
}

/**
 * Everything this run left behind in the fixture tenant, counted through the
 * tenant's own RLS. A guard calls this after close() and asserts it is empty:
 * cleanup that is claimed but not measured is how ZZ- rows accumulated before.
 */
export async function fixtureResidue(t: FixtureTenant): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const count = async (table: string, col: string, pattern: string) => {
    const { count: n } = await t.db.from(table).select('id', { count: 'exact', head: true })
      .eq('user_id', t.uid).like(col, pattern)
    out[table] = n ?? -1
  }
  await count('quotes', 'quote_number', `%${t.runId}%`)
  await count('service_bundles', 'name', `%${t.runId}%`)
  await count('service_templates', 'name', `%${t.runId}%`)
  await count('customers', 'name', `%${t.runId}%`)
  return out
}
