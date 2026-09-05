// Execute the actual webhook handler with synthetic verification, database and
// receipt I/O. No Stripe/Supabase clients, network, messages or charges are used.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const routePath = 'src/app/api/stripe/webhook/route.ts'
const raw = readFileSync(join(process.cwd(), routePath), 'utf8')
const tree = ts.createSourceFile(routePath, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
let handler: ts.FunctionDeclaration | undefined
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'POST') handler = node
  ts.forEachChild(node, visit)
}
visit(tree)
if (!handler) throw new Error('Missing Stripe webhook POST')
const executable = ts.transpileModule(handler.getText(tree).replace(/^export\s+/, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

type Path = 'checkout' | 'autopay' | 'deposit'
type Failure = 'none' | 'cash' | 'dependent'
type Row = Record<string, unknown>
type Response = { status: number; body: unknown }
let passes = 0
function check(label: string, run: () => void) { run(); passes++; console.log(`  PASS ${label}`) }

function fixture(path: Path, failure: Failure) {
  const rows = new Map<string, Row>()
  const receipts: Row[] = []
  const notifications: Row[] = []
  let cashAttempts = 0, dependentAttempts = 0
  const failed = { message: 'Synthetic refused write' }
  const supabase = {
    from(table: string) {
      if (table === 'payments') return {
        upsert(row: Row, options: { onConflict: string; ignoreDuplicates: boolean }) {
          assert.equal(options.onConflict, 'stripe_session_id')
          assert.equal(options.ignoreDuplicates, true)
          const cash = row.kind !== 'credit'
          const attempt = cash ? ++cashAttempts : ++dependentAttempts
          const refused = attempt === 1 && failure === (cash ? 'cash' : 'dependent')
          const key = String(row.stripe_session_id)
          const fresh = !rows.has(key)
          if (!refused && fresh) rows.set(key, row)
          const result = { error: refused ? failed : null, data: !refused && fresh ? [{ id: key }] : [] }
          return { select: async () => result, then: (resolve: (value: typeof result) => void) => resolve(result) }
        },
      }
      if (table === 'invoices') {
        assert.notEqual(path, 'deposit', 'A quote deposit must not write an invoice')
        const predicates: Record<string, string> = {}
        const chain = {
          update(patch: Row) { assert.equal(Object.keys(patch).join(), 'payment_method'); assert.equal(patch.payment_method, 'stripe'); return chain },
          eq(column: string, value: string) { predicates[column] = value; return chain },
          then(resolve: (value: { error: typeof failed | null }) => void) {
            assert.deepEqual(predicates, { id: 'fixture-invoice', user_id: 'fixture-owner' })
            dependentAttempts++
            resolve({ error: failure === 'dependent' && dependentAttempts === 1 ? failed : null })
          },
        }
        return chain
      }
      if (table === 'notifications') {
        const chain = {
          select() { return chain }, eq() { return chain },
          limit: async () => ({ data: notifications.length ? [{ id: 'fixture-notification' }] : [], error: null }),
          insert: async (row: Row) => { notifications.push(row); return { error: null } },
        }
        return chain
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  }
  const metadata = { user_id: 'fixture-owner', customer_id: 'fixture-customer',
    ...(path === 'deposit' ? { quote_deposit: '1', quote_id: 'fixture-quote', quote_number: 'Q-fixture' }
      : { invoice_id: 'fixture-invoice', ...(path === 'autopay' ? { source: 'autopay' } : {}) }),
  }
  const event = path === 'autopay'
    ? { type: 'payment_intent.succeeded', data: { object: { id: 'pi_fixture', amount: 25000, currency: 'cad', metadata } } }
    : { type: 'checkout.session.completed', data: { object: { id: 'cs_fixture', mode: 'payment', payment_status: 'paid', amount_total: 25000, currency: 'cad', metadata } } }
  const context: Record<string, unknown> = {
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic' } },
    constructWebhookEvent: () => ({ ok: true, event }), createClient: () => supabase,
    NextResponse: { json: (body: unknown, options?: { status: number }) => ({ body, status: options?.status ?? 200 }) },
    cleanOrigin: () => null, appOrigin: () => 'https://example.invalid',
    sendPaymentReceipt: async (_sb: unknown, options: Row) => { receipts.push(options) },
    // Resolve the existing timebox without making the guard wait six seconds.
    setTimeout: (resolve: () => void) => { resolve(); return 0 },
    console: { error() {} }, Date, Promise,
  }
  runInNewContext(executable, context)
  const post = context.POST as (request: unknown) => Promise<Response>
  return {
    rows, receipts, notifications,
    deliver: () => post({ text: async () => 'synthetic body', headers: { get: () => 'synthetic signature' }, nextUrl: { origin: 'https://example.invalid' } }),
    cashCount: () => [...rows.values()].filter(row => row.kind !== 'credit').length,
    creditCount: () => [...rows.values()].filter(row => row.kind === 'credit').length,
    dependentAttempts: () => dependentAttempts,
  }
}

async function main() {
  for (const path of ['checkout', 'autopay', 'deposit'] as const) {
    const healthy = fixture(path, 'none')
    const healthyStatuses = [(await healthy.deliver()).status, (await healthy.deliver()).status]
    check(`${path}: healthy delivery and replay record one cash payment and one receipt attempt`, () => {
      assert.deepEqual(healthyStatuses, [200, 200]); assert.equal(healthy.cashCount(), 1); assert.equal(healthy.receipts.length, 1)
      assert.equal(healthy.creditCount(), path === 'deposit' ? 1 : 0)
    })

    const dependent = fixture(path, 'dependent')
    const first = await dependent.deliver()
    check(`${path}: a dependent write failure returns 500 after the new payment's receipt attempt`, () => {
      assert.equal(first.status, 500); assert.equal(dependent.cashCount(), 1); assert.equal(dependent.receipts.length, 1)
      assert.equal(dependent.creditCount(), 0)
    })
    check(`${path}: the receipt acknowledges the actual amount and customer`, () => {
      const receipt = dependent.receipts[0]
      assert.equal(receipt.amount, 250); assert.equal(receipt.userId, 'fixture-owner'); assert.equal(receipt.customerId, 'fixture-customer')
    })
    if (path === 'deposit') check('deposit: no booking notification before its credit leg succeeds', () => assert.equal(dependent.notifications.length, 0))
    const retried = await dependent.deliver()
    check(`${path}: replay repairs the dependent write without another payment or receipt`, () => {
      assert.equal(retried.status, 200); assert.equal(dependent.dependentAttempts(), 2)
      assert.equal(dependent.cashCount(), 1); assert.equal(dependent.receipts.length, 1)
      assert.equal(dependent.creditCount(), path === 'deposit' ? 1 : 0)
    })

    const cash = fixture(path, 'cash')
    const cashFirst = await cash.deliver()
    check(`${path}: refused cash returns 500 and leaves all records/receipt attempts empty`, () => {
      assert.equal(cashFirst.status, 500); assert.equal(cash.rows.size, 0); assert.equal(cash.receipts.length, 0)
      assert.equal(cash.dependentAttempts(), 0); assert.equal(cash.notifications.length, 0)
    })
    const cashRetry = await cash.deliver()
    check(`${path}: a later successful cash retry gets exactly one receipt`, () => {
      assert.equal(cashRetry.status, 200); assert.equal(cash.cashCount(), 1); assert.equal(cash.receipts.length, 1)
      assert.equal(cash.creditCount(), path === 'deposit' ? 1 : 0)
    })
  }
  // The repair must continue through the existing consent/capability-aware
  // sender; adding direct provider calls would escape the synthetic fixture.
  check('all three payment branches still call the existing receipt helper', () => {
    assert.equal((raw.match(/sendPaymentReceipt\(sb, /g) ?? []).length, 3)
    assert.match(raw, /import \{ sendPaymentReceipt \} from '@\/lib\/comms\/receipt'/)
  })
  console.log(`\nverify:stripe-receipt-recovery — ${passes} passed, 0 failed\n`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
