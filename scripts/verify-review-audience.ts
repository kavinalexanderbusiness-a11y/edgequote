// ── Verify: Review campaign only asks customers we actually SERVED ───────────
//   npm run verify:review-audience
//
// THE bug this pins: the review campaign's audience was `not_reviewed` alone —
// "active customers we haven't asked yet" — with no requirement that the customer
// ever received service. So a brand-new record, an imported contact, or a
// never-served lead was auto-selected to be asked for a review of work that never
// happened. The day-after automation only ever asks per COMPLETED job; the campaign
// (the periodic sweep of "the rest") must draw from the same served population.
//
// The fix gates the review KIND on "has ≥1 job with status='completed'"
// (lib/crm/audience narrowToServed), on BOTH the send path (resolveAudience) and the
// preview (previewAudience), so the preview can't over-promise. These assertions run
// the REAL resolvers against a fake Supabase client — deterministic, no network.

import { resolveAudience, previewAudience, type AudienceSpec, type AudienceCustomer } from '../src/lib/crm/audience'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MsgType } from '../src/lib/comms/templates'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const bad = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => (cond ? ok(n) : bad(n, d))
const ids = (rows: { id: string }[]) => rows.map(r => r.id).sort().join(',')

// A full, reachable, unreviewed customer — so `eligible`/reachability never mask the
// one thing under test: whether SERVICE HISTORY decides selection.
function cust(id: string): AudienceCustomer {
  return { id, name: `Cust ${id}`, phone: '+15875550100', email: `${id}@x.co`, sms_opt_in: true, email_opt_in: true, message_prefs: null, birthday: null, anniversary: null }
}

interface FakeOpts { customers: AudienceCustomer[]; served: string[]; recurring?: string[]; onJobsEq?: (eqs: [string, unknown][]) => void }
function fakeClient(o: FakeOpts): SupabaseClient {
  const api = {
    from(table: string) {
      const eqs: [string, unknown][] = []
      let inIds: string[] | null = null
      const b: Record<string, unknown> = {}
      const self = () => b
      Object.assign(b, {
        select: self, order: self, limit: self, is: self, not: self, gte: self, lt: self, or: self,
        eq(col: string, val: unknown) { eqs.push([col, val]); return b },
        in(_col: string, list: string[]) { inIds = list; return b },
        then(resolve: (v: { data: unknown; error: null }) => void) {
          const within = (set: Set<string>) => (inIds ?? o.customers.map(c => c.id)).filter(id => set.has(id)).map(customer_id => ({ customer_id }))
          if (table === 'customers') return resolve({ data: o.customers, error: null })
          if (table === 'jobs') { o.onJobsEq?.(eqs); return resolve({ data: within(new Set(o.served)), error: null }) }
          if (table === 'job_recurrences') return resolve({ data: within(new Set(o.recurring ?? [])), error: null })
          return resolve({ data: [], error: null })
        },
      })
      return b
    },
  }
  return api as unknown as SupabaseClient
}

const spec = (over: Partial<AudienceSpec>): AudienceSpec => ({
  userId: 'u1', kind: 'review', schedule: {}, audience: { not_reviewed: true }, today: new Date(2026, 6, 26), ...over,
})
const CH = ['sms', 'email']
const TPL = 'review_chase' as MsgType

async function main() {
  // Four active, unreviewed customers. c1/c2 have a completed job; c3/c4 never did
  // (c3 = record with no work yet, c4 = an imported lead).
  const customers = [cust('c1'), cust('c2'), cust('c3'), cust('c4')]

  console.log('\nReview campaign selects ONLY served customers:')
  {
    const sb = fakeClient({ customers, served: ['c1', 'c2'] })
    const { customers: got } = await resolveAudience(sb, spec({}))
    check('served c1,c2 are selected', ids(got) === 'c1,c2', `got [${ids(got)}]`)
    check('never-served c3,c4 are EXCLUDED', !got.some(c => c.id === 'c3' || c.id === 'c4'), `got [${ids(got)}]`)
  }

  console.log('\nPreview matches the send path (can\'t over-promise):')
  {
    const sb = fakeClient({ customers, served: ['c1', 'c2'] })
    const p = await previewAudience(sb, spec({}), CH, TPL)
    check('preview.eligible counts only the 2 served', p.eligible === 2, `eligible=${p.eligible}`)
  }

  console.log('\nThe gate is service history, specifically a COMPLETED job:')
  {
    let seen: [string, unknown][] = []
    const sb = fakeClient({ customers, served: ['c1'], onJobsEq: e => { seen = e } })
    await resolveAudience(sb, spec({}))
    check('jobs lookup filters status=completed', seen.some(([c, v]) => c === 'status' && v === 'completed'), JSON.stringify(seen))
    check('...scoped to the owner (user_id)', seen.some(([c, v]) => c === 'user_id' && v === 'u1'), JSON.stringify(seen))
  }

  console.log('\nAn all-unserved book asks NOBODY (not everybody):')
  {
    const sb = fakeClient({ customers, served: [] })
    const { customers: got } = await resolveAudience(sb, spec({}))
    check('zero served → empty audience', got.length === 0, `got [${ids(got)}]`)
    const p = await previewAudience(sb, spec({}), CH, TPL)
    check('preview agrees: eligible 0', p.eligible === 0, `eligible=${p.eligible}`)
  }

  console.log('\nThe gate is intrinsic to the review kind — other kinds are untouched:')
  {
    // A broadcast over the SAME people must NOT be silently narrowed to the served —
    // the fix must not leak into campaigns that legitimately reach everyone.
    const sb = fakeClient({ customers, served: ['c1'] })
    const { customers: got } = await resolveAudience(sb, spec({ kind: 'broadcast', audience: {} }))
    check('broadcast still reaches all 4 (no served gate)', ids(got) === 'c1,c2,c3,c4', `got [${ids(got)}]`)
  }

  console.log('\nStacks with recurring_only (both narrows apply, AND semantics):')
  {
    const sb = fakeClient({ customers, served: ['c1', 'c2'], recurring: ['c1'] })
    const { customers: got } = await resolveAudience(sb, spec({ audience: { not_reviewed: true, recurring_only: true } }))
    check('served ∩ recurring = c1', ids(got) === 'c1', `got [${ids(got)}]`)
  }

  console.log(
    failures === 0
      ? '\n✅ review-audience verified — never-served customers are never asked for a review.\n'
      : `\n❌ ${failures} review-audience check(s) FAILED\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}
main()
