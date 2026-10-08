// Exercise the real quote→job engine against an in-memory query adapter.
// No credentials, network, browser, or live database are used.
// Run: node --import tsx scripts/verify-schedule-quote-deposit.ts
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Quote } from '../src/types'
import type { GateLedgerRow } from '../src/lib/payments/depositGate'
import { schedulingGate } from '../src/lib/payments/depositGate'
import { scheduleQuoteAsJob } from '../src/lib/scheduleQuote'

type Row = Record<string, unknown>
type Reply = { data: Row | Row[] | null; error: { message: string } | null }
type Write = { table: string; method: string; payload: Row }

const quote = (patch: Partial<Quote> = {}): Quote => ({
  id: 'test-quote', user_id: 'test-owner', customer_id: 'test-customer',
  property_id: 'test-property', customer_name: 'Local fixture',
  service_type: 'Cleanup', hours: 3, crew_size: 2, notes: null,
  status: 'accepted', total: 595, accepted_price: 595,
  deposit_type: 'percent', deposit_value: 50, deposit_override_at: null,
  ...patch,
} as Quote)
const cash = (amount: number): GateLedgerRow => ({ amount, kind: 'payment', provider: 'stripe', status: 'paid' })

class MemoryClient {
  current: Quote | null
  payments: GateLedgerRow[] = []
  writes: Write[] = []
  reads: string[] = []
  failure: 'quotes' | 'payments' | 'acceptance' | 'override' | null = null
  needsReapproval = false
  accepted = true
  constructor(current: Quote = quote()) { this.current = structuredClone(current) }
  from(table: string) { return new MemoryQuery(this, table) }
  async rpc(name: string, params: Row): Promise<Reply> {
    assert.equal(name, 'quote_acceptance_state')
    assert.equal(params.p_quote_id, 'test-quote')
    this.reads.push('acceptance')
    return this.failure === 'acceptance'
      ? { data: null, error: { message: 'fixture read failure' } }
      : { data: { accepted: this.accepted, needs_reapproval: this.needsReapproval, terms_changed: false }, error: null }
  }
  get client() { return this as unknown as SupabaseClient }
}

class MemoryQuery implements PromiseLike<Reply> {
  private method = 'select'
  private payload: Row = {}
  private filters: [string, unknown][] = []
  private columns = '*'
  private singleResult = false
  constructor(private db: MemoryClient, private table: string) {}
  select(columns = '*') { this.columns = columns; return this }
  eq(column: string, value: unknown) { this.filters.push([column, value]); return this }
  is(column: string, value: unknown) { this.filters.push([column, value]); return this }
  insert(payload: Row) { this.method = 'insert'; this.payload = payload; return this }
  update(payload: Row) { this.method = 'update'; this.payload = payload; return this }
  order() { return this }
  limit() { return this }
  single() { this.singleResult = true; return this }
  maybeSingle() { this.singleResult = true; return this }
  then<TResult1 = Reply, TResult2 = never>(
    fulfilled?: ((value: Reply) => TResult1 | PromiseLike<TResult1>) | null,
    rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve().then(() => this.execute()).then(fulfilled, rejected)
  }
  private execute(): Reply {
    const matches = (row: Row) => this.filters.every(([key, value]) => row[key] === value)
    if (this.method !== 'select') {
      this.db.writes.push({ table: this.table, method: this.method, payload: this.payload })
      if (this.table === 'jobs' && this.method === 'insert') {
        return { data: { id: 'test-job' }, error: null }
      }
      assert.equal(this.table, 'quotes', 'unexpected mutation table')
      assert.equal(this.method, 'update')
      if ('deposit_override_at' in this.payload && this.db.failure === 'override') {
        return { data: null, error: { message: 'fixture stamp failure' } }
      }
      if (this.db.current && matches(this.db.current as unknown as Row)) Object.assign(this.db.current, this.payload)
      return { data: null, error: null }
    }
    this.db.reads.push(this.table)
    if (this.db.failure === this.table) return { data: null, error: { message: 'fixture read failure' } }
    let rows: Row[]
    if (this.table === 'quotes') rows = this.db.current ? [this.db.current as unknown as Row] : []
    else if (this.table === 'payments') rows = this.db.payments.map(p => ({ ...p, quote_id: 'test-quote' }))
    else if (this.table === 'quote_services') rows = []
    else throw new Error(`unexpected read table: ${this.table}`)
    rows = rows.filter(matches).map(row => this.columns === '*' ? row : Object.fromEntries(
      this.columns.split(',').map(c => c.trim()).map(c => [c, row[c]]),
    ))
    return { data: this.singleResult ? rows[0] ?? null : rows, error: null }
  }
}

let checks = 0
async function check(name: string, run: () => Promise<void>) {
  await run()
  checks++
  console.log(`  ✓ ${name}`)
}
const run = (db: MemoryClient, input = quote(), confirmed = false) => scheduleQuoteAsJob(db.client, 'test-owner', input, {
  date: '2026-10-20', services: [], depositOverrideConfirmed: confirmed,
})
function assertBlocked(db: MemoryClient, result: Awaited<ReturnType<typeof run>>, message: RegExp) {
  assert.equal(result.jobId, null)
  assert.match(result.error ?? '', message)
  assert.deepEqual(db.writes, [], 'a blocked read/gate must perform no writes')
}

async function main() {
  globalThis.fetch = async () => { throw new Error('Network is forbidden in this test') }
  console.log('Quote→job scheduling deposit guard (in memory)')

  await check('unpaid 50% deposit blocks the notification-style call before writes', async () => {
    const db = new MemoryClient()
    const result = await scheduleQuoteAsJob(db.client, 'test-owner', quote())
    assertBlocked(db, result, /\$297\.50.*still outstanding/)
  })
  await check('partial payment blocks with the actual remaining amount', async () => {
    const db = new MemoryClient(); db.payments = [cash(100)]
    assertBlocked(db, await run(db), /\$197\.50.*still outstanding/)
  })
  await check('fully paid percentage deposit schedules one job without an override', async () => {
    const db = new MemoryClient(); db.payments = [cash(297.50)]
    assert.deepEqual(await run(db), { jobId: 'test-job', error: null })
    assert.deepEqual(db.writes.map(w => [w.table, w.method]), [['jobs', 'insert'], ['quotes', 'update']])
    assert.equal(db.writes[0].payload.scheduled_date, '2026-10-20')
    assert.equal(db.writes[0].payload.duration_minutes, 180)
    assert.equal(db.current?.status, 'scheduled')
    assert.equal(db.current?.deposit_override_at, null)
  })
  await check('fixed deposits block unpaid and permit a fully paid booking', async () => {
    const q = quote({ deposit_type: 'fixed', deposit_value: 125 })
    const unpaid = new MemoryClient(q)
    assertBlocked(unpaid, await run(unpaid, q), /\$125\.00.*still outstanding/)
    const paid = new MemoryClient(q); paid.payments = [cash(125)]
    assert.equal((await run(paid, q)).jobId, 'test-job')
  })
  await check('deposit off keeps normal scheduling and does not require a ledger read', async () => {
    const q = quote({ deposit_type: null, deposit_value: null })
    const db = new MemoryClient(q); db.failure = 'payments'
    assert.equal((await run(db, q)).jobId, 'test-job')
    assert.ok(!db.reads.includes('payments'))
  })
  await check('credit bookkeeping cannot masquerade as a paid cash deposit', async () => {
    const db = new MemoryClient()
    db.payments = [{ amount: 297.50, kind: 'credit', provider: 'credit', status: 'paid' }]
    assertBlocked(db, await run(db), /\$297\.50.*still outstanding/)
  })
  await check('refunds reopen the requirement before the next booking attempt', async () => {
    const db = new MemoryClient(); db.payments = [cash(297.50), cash(-297.50)]
    assertBlocked(db, await run(db), /\$297\.50.*still outstanding/)
  })
  await check('the accepted price supplies the percentage basis', async () => {
    const q = quote({ total: 1000, accepted_price: 595 })
    const db = new MemoryClient(q); db.payments = [cash(297.50)]
    assert.equal((await run(db, q)).jobId, 'test-job')
  })
  await check('stale deposit-off props cannot bypass a saved requirement', async () => {
    const db = new MemoryClient()
    assertBlocked(db, await run(db, quote({ deposit_type: null, deposit_value: null })), /\$297\.50.*still outstanding/)
  })
  await check('a freshly removed requirement is honored despite stale on props', async () => {
    const db = new MemoryClient(quote({ deposit_type: null, deposit_value: null }))
    assert.equal((await run(db)).jobId, 'test-job')
  })
  await check('a prior override stamp does not silently authorize another attempt', async () => {
    const q = quote({ deposit_override_at: '2026-10-01T10:00:00Z' })
    const db = new MemoryClient(q)
    assertBlocked(db, await run(db, q), /still outstanding/)
  })
  await check('explicit override records intent before the job and leaves the money owed', async () => {
    const db = new MemoryClient()
    assert.equal((await run(db, quote(), true)).jobId, 'test-job')
    assert.deepEqual(db.writes.map(w => [w.table, w.method]), [['quotes', 'update'], ['jobs', 'insert'], ['quotes', 'update']])
    assert.ok(db.current?.deposit_override_at)
    assert.equal(schedulingGate(db.current!, db.payments).outstanding, 297.50)
    assert.equal(db.current?.deposit_type, 'percent')
    assert.equal(db.current?.deposit_value, 50)
  })
  await check('explicit retry preserves the original audit stamp', async () => {
    const q = quote({ deposit_override_at: '2026-10-01T10:00:00Z' })
    const db = new MemoryClient(q)
    assert.equal((await run(db, q, true)).jobId, 'test-job')
    assert.equal(db.current?.deposit_override_at, q.deposit_override_at)
  })
  await check('a failed audit stamp stops before creating a job', async () => {
    const db = new MemoryClient(); db.failure = 'override'
    const result = await run(db, quote(), true)
    assert.equal(result.jobId, null)
    assert.match(result.error ?? '', /Could not record your deposit override/)
    assert.deepEqual(db.writes.map(w => w.table), ['quotes'])
  })
  for (const failure of ['quotes', 'payments', 'acceptance'] as const) {
    await check(`${failure} read failure blocks even with explicit override, with no writes`, async () => {
      const db = new MemoryClient(); db.failure = failure
      assertBlocked(db, await run(db, quote(), true), /Could not check/)
    })
  }
  await check('missing quote blocks before any write', async () => {
    const db = new MemoryClient(); db.current = null
    assertBlocked(db, await run(db), /no longer exists/)
  })
  await check('quote read is scoped to the acting owner', async () => {
    const db = new MemoryClient(quote({ user_id: 'another-owner' }))
    assertBlocked(db, await run(db), /no longer exists/)
  })
  await check('changed status requires a refresh instead of stale scheduling', async () => {
    const db = new MemoryClient(quote({ status: 'scheduled' }))
    assertBlocked(db, await run(db), /status changed/)
  })
  for (const mode of ['needsReapproval', 'accepted'] as const) {
    await check(`deposit override cannot bypass acceptance (${mode})`, async () => {
      const db = new MemoryClient()
      if (mode === 'needsReapproval') db.needsReapproval = true
      else db.accepted = false
      assertBlocked(db, await run(db, quote(), true), /accept|approval/i)
    })
  }
  for (const status of ['draft', 'sent'] as const) {
    await check(`${status} estimate visits preserve existing non-commercial scheduling behavior`, async () => {
      const q = quote({ status }); const db = new MemoryClient(q)
      assert.equal((await run(db, q)).jobId, 'test-job')
      assert.deepEqual(db.reads, ['quotes'])
      assert.equal(db.current?.status, status)
    })
  }
  console.log(`\n${checks} scheduling deposit engine checks passed.`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
