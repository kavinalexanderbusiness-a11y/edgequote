// Pure monetary checks + real Supabase request construction over synthetic I/O.
// No environment files, credentials, network, business rows or charge attempts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import ts from 'typescript'
import { buildInvoiceLineItems, createDraftInvoiceForCompletedJob, syncDraftInvoiceAmounts } from '../src/lib/invoicing'
import { applyDiscount, applyFeeRecovery, roundInvoiceAmount } from '../src/lib/invoiceTotals'
import type { Job } from '../src/types'

let passed = 0
const check = (name: string, actual: unknown, expected: unknown) => {
  assert.deepEqual(actual, expected, name)
  passed++
  console.log(`  ✓ ${name}`)
}
type Row = Record<string, unknown>
type Tables = Record<string, Row[]>
type RequestLog = { method: string; table: string; url: URL; body: Row | null }

// Simulates the relevant PostgREST row-selection semantics, not the production
// invoice algorithm. The actual SDK constructs every request and parses results.
function fixture(tables: Tables, opts: { beforePatch?: (tables: Tables) => void; insertConflict?: boolean; writeError?: boolean; readError?: string; readNull?: string } = {}) {
  const requests: RequestLog[] = []
  const db = structuredClone(tables)
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://invoice-fixture.invalid')
    const table = url.pathname.split('/').pop()!
    const method = init?.method || 'GET'
    assert.ok(['GET', 'POST', 'PATCH'].includes(method), `unexpected operation ${method}`)
    assert.ok(Object.hasOwn(db, table), `unexpected table ${table}`)
    const body = init?.body ? JSON.parse(String(init.body)) as Row : null
    requests.push({ method, table, url, body })
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
    if (method === 'GET' && opts.readError === table) return response({ code: '42501', message: 'synthetic denied read' }, 403)
    if (method === 'GET' && opts.readNull === table) return response(null)
    if (method === 'PATCH') {
      opts.beforePatch?.(db)
      if (opts.writeError) return response({ code: '42501', message: 'synthetic denied write' }, 403)
    }
    const matches = (row: Row) => [...url.searchParams].every(([field, filter]) => {
      if (['select', 'limit', 'order'].includes(field)) return true
      if (filter.startsWith('eq.')) return String(row[field]) === filter.slice(3)
      if (filter === 'is.null') return row[field] == null
      if (filter.startsWith('in.(')) return filter.slice(4, -1).split(',').includes(String(row[field]))
      throw new Error(`unsupported fixture predicate ${field}=${filter}`)
    })
    let rows = db[table].filter(matches)
    if (method === 'POST') {
      if (opts.insertConflict) return response({ code: '23505', message: 'synthetic duplicate' }, 409)
      assert.ok(body)
      const inserted = { id: 'created-invoice', ...body }
      db[table].push(inserted)
      rows = [inserted]
    } else if (method === 'PATCH') {
      for (const row of rows) Object.assign(row, body)
    }
    const limit = Number(url.searchParams.get('limit'))
    if (limit > 0) rows = rows.slice(0, limit)
    const single = new Headers(init?.headers).get('accept')?.includes('vnd.pgrst.object+json')
    return response(single ? rows[0] ?? null : rows)
  }
  const client = createClient('https://invoice-fixture.invalid', 'synthetic-public-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetcher },
  }) as unknown as Parameters<typeof syncDraftInvoiceAmounts>[0]
  return { client, db, requests }
}

const job = { id: 'job-1', price: 100.25, quote_id: 'quote-1', recurrence_id: null, is_initial_visit: false,
  service_type: 'Synthetic service', customer_id: null, property_id: null, scheduled_date: '2026-09-05' } as Job
const draft = { id: 'inv-1', job_id: job.id, invoice_number: 'INV-0001', amount: 100, status: 'draft', notes: null,
  line_items: null, discount_type: null, discount_value: null, line_items_edited: false }
function tables(invoice: Row | null = draft): Tables {
  return {
    invoices: invoice ? [invoice] : [], jobs: [{ ...job }],
    quotes: [{ id: 'quote-1', show_travel_separately: true, travel_fee: 2.35 }], job_recurrences: [],
    job_line_items: [{ job_id: job.id, description: 'Small extra', amount: 0.49 }], customers: [], properties: [],
  }
}
const money = (baseAmount: number, addons: { description: string; amount: number }[] = [], quote: Row | null = null) =>
  buildInvoiceLineItems({ serviceType: 'Test', baseAmount, freq: null, isInitial: false, addons, quote })

async function main() {
  const recovered = applyFeeRecovery(65, { payment_fee_strategy: 'global_price_increase', fee_recovery_percent: 3 })!
  check('existing fee recovery generates a valid cent price', recovered, 66.95)
  check('builder preserves the fee-recovered quoted price', money(recovered).total, 66.95)
  const built = money(100.25, [{ description: 'Small extra', amount: 0.49 }], { show_travel_separately: true, travel_fee: 2.35 })
  check('base, sub-dollar add-on and separate travel keep their cents', built.lineItems.map(l => l.amount), [100.25, 0.49, 2.35])
  check('the rounded total equals the sum of invoice lines', built.total, 103.09)
  check('existing whole-dollar prices stay unchanged', money(100, [{ description: 'Extra', amount: 10 }], { show_travel_separately: true, travel_fee: 5 }).total, 115)
  check('included travel is not counted twice', money(100.25, [], { show_travel_separately: false, travel_fee: 2.35 }).total, 100.25)
  check('negative adjustments retain cents', money(100.25, [{ description: 'Adjustment', amount: -2.35 }]).total, 97.9)
  check('a billable amount under one dollar is not erased', money(0.49).total, 0.49)

  {
    const f = fixture(tables(null))
    const result = await createDraftInvoiceForCompletedJob(f.client, job, { ownerId: 'synthetic-owner' })
    check('completion creates a draft with cents', result.created, true)
    check('created amount and breakdown agree', [f.db.invoices[0].amount, (f.db.invoices[0].line_items as Row[]).map(l => l.amount)], [103.09, [100.25, 0.49, 2.35]])
    check('creation still produces a draft', f.db.invoices[0].status, 'draft')
    const duplicate = await createDraftInvoiceForCompletedJob(f.client, job, { ownerId: 'synthetic-owner' })
    check('repeated completion keeps one invoice', [duplicate.reason, f.db.invoices.length], ['exists', 1])
  }
  {
    const data = tables(null)
    data.quotes[0] = { id: 'quote-1', initial_price: 66.95, travel_fee: 0 }
    data.job_line_items = []
    const f = fixture(data)
    const result = await createDraftInvoiceForCompletedJob(f.client, { ...job, price: null }, { ownerId: 'synthetic-owner' })
    check('quote-derived completion creates without a manual job-price override', result.created, true)
    check('quote-derived draft preserves the applicable $66.95 price', f.db.invoices[0].amount, 66.95)
  }
  {
    const f = fixture(tables(null), { insertConflict: true })
    check('atomic duplicate conflict stays benign',
      (await createDraftInvoiceForCompletedJob(f.client, job, { ownerId: 'synthetic-owner' })).reason, 'exists')
  }
  for (const [type, value, expected] of [[null, null, 103.09], ['percent', 10, 92.78], ['amount', 2.35, 100.74]] as const) {
    const f = fixture(tables({ ...draft, discount_type: type, discount_value: value }))
    check(`sync preserves ${type || 'no'} discount at cent precision`, await syncDraftInvoiceAmounts(f.client, [job.id, job.id]), { changed: 1, failed: 0 })
    check('synced net uses the canonical discount policy', f.db.invoices[0].amount, expected)
    check('discount calculation is unchanged', applyDiscount(103.09, { type, value }).net, expected)
    check('a second sync is a true no-op', await syncDraftInvoiceAmounts(f.client, [job.id]), { changed: 0, failed: 0 })
    check('no repeat write occurs after a cent-precise match', f.requests.filter(r => r.method === 'PATCH').length, 1)
  }
  for (const status of ['sent', 'unpaid', 'partial', 'paid', 'overpaid', 'cancelled']) {
    const f = fixture(tables({ ...draft, status }))
    check(`${status} invoice history is excluded from sync`, await syncDraftInvoiceAmounts(f.client, [job.id]), { changed: 0, failed: 0 })
    check('no historical write is attempted', f.requests.some(r => r.method === 'PATCH'), false)
  }
  {
    const f = fixture(tables({ ...draft, line_items_edited: true }))
    check('owner-authored draft stays unchanged', await syncDraftInvoiceAmounts(f.client, [job.id]), { changed: 0, failed: 0 })
    check('manual breakdown is never overwritten', f.requests.some(r => r.method === 'PATCH'), false)
  }
  for (const [name, change] of [
    ['issued during source loading', { status: 'sent' }],
    ['paid during source loading', { status: 'paid', amount: 100 }],
    ['line items edited during source loading', { line_items_edited: true }],
    ['amount edited during source loading', { amount: 50.05 }],
    ['discount added during source loading', { discount_type: 'amount', discount_value: 3.25 }],
  ] as const) {
    const f = fixture(tables(), { beforePatch: db => Object.assign(db.invoices[0], change) })
    check(`${name}: conditional write reports no change`, await syncDraftInvoiceAmounts(f.client, [job.id]), { changed: 0, failed: 0 })
    check('newer document survives intact', f.db.invoices[0], { ...draft, ...change })
  }
  {
    const f = fixture(tables({ ...draft, discount_type: 'percent', discount_value: 10 }), {
      beforePatch: db => { db.invoices[0].discount_value = 15 },
    })
    check('changing an existing discount also wins the race', await syncDraftInvoiceAmounts(f.client, [job.id]), { changed: 0, failed: 0 })
    check('existing discount value survives', f.db.invoices[0].discount_value, 15)
  }
  {
    const f = fixture(tables(), { beforePatch: db => { db.invoices[0].notes = 'New owner note' } })
    check('concurrent note edit wins over a re-price reason append', await syncDraftInvoiceAmounts(f.client, [job.id], { reason: 'Changed service' }), { changed: 0, failed: 0 })
    check('new owner note survives intact', f.db.invoices[0].notes, 'New owner note')
  }
  for (const table of ['invoices', 'jobs', 'quotes', 'job_recurrences', 'job_line_items']) {
    const data = tables()
    data.jobs[0].recurrence_id = 'rec-1'
    data.job_recurrences = [{ id: 'rec-1', freq: 'weekly', interval_unit: 'week', interval_count: 1 }]
    const f = fixture(data, { readError: table })
    check(`failed ${table} read cannot re-price an invoice from incomplete sources`, await syncDraftInvoiceAmounts(f.client, [job.id]), { changed: 0, failed: 1 })
    check('failed read causes zero writes', f.requests.some(r => r.method !== 'GET'), false)
  }
  {
    const f = fixture(tables(), { readNull: 'job_line_items' })
    check('null add-on data is unknown, not an empty billable list', await syncDraftInvoiceAmounts(f.client, [job.id]), { changed: 0, failed: 1 })
  }
  for (const table of ['jobs', 'quotes', 'job_recurrences']) {
    const data = tables()
    data.jobs[0].recurrence_id = 'rec-1'
    data.job_recurrences = [{ id: 'rec-1', freq: 'weekly', interval_unit: 'week', interval_count: 1 }]
    data[table] = []
    const f = fixture(data)
    check(`missing referenced ${table} row cannot change the invoice`, await syncDraftInvoiceAmounts(f.client, [job.id]), { changed: 0, failed: 1 })
    check('missing referenced row causes zero writes', f.requests.some(r => r.method !== 'GET'), false)
  }
  for (const table of ['invoices', 'quotes', 'job_recurrences', 'job_line_items', 'customers', 'properties']) {
    const data = tables(null)
    data.job_recurrences = [{ id: 'rec-1', freq: 'weekly', interval_unit: 'week', interval_count: 1 }]
    data.customers = [{ id: 'cust-1', name: 'Synthetic customer' }]
    data.properties = [{ id: 'prop-1', address: 'Synthetic address' }]
    const f = fixture(data, { readError: table })
    const result = await createDraftInvoiceForCompletedJob(f.client, { ...job, recurrence_id: 'rec-1', customer_id: 'cust-1', property_id: 'prop-1' }, { ownerId: 'synthetic-owner' })
    check(`failed ${table} read cannot create an incomplete invoice`, result.reason, 'error')
    check('failed creation read causes zero writes', f.requests.some(r => r.method !== 'GET'), false)
  }
  {
    const f = fixture(tables(), { writeError: true })
    check('write failure remains a failure, never a successful re-price', await syncDraftInvoiceAmounts(f.client, [job.id]), { changed: 0, failed: 1 })
  }
  const schema = readFileSync('supabase/migrations/20260830150001_baseline.sql', 'utf8')
  check('manual-line marker cannot be null in the supported schema', /"line_items_edited" boolean default false not null/.test(schema), true)
  // Execute the editor's actual monetary expressions. This catches a later
  // dollar-rounding regression even if the creation/sync engine stays correct.
  const editorText = readFileSync('src/app/dashboard/invoices/page.tsx', 'utf8')
  const ast = ts.createSourceFile('page.tsx', editorText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const editor = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'DraftInvoiceEditor') as ts.FunctionDeclaration
  assert.ok(editor?.body)
  const declarations = new Map<string, ts.VariableDeclaration>()
  let saveAmount = ''
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(ast), node)
    if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)
      && node.expression.left.getText(ast) === 'patch.amount') saveAmount = node.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(editor)
  const expression = (name: string) => { const node = declarations.get(name); assert.ok(node, name); return `const ${node.getText(ast)};` }
  const program = ['lineAmount', 'toPersisted', 'itemsSum', 'grossNum'].map(expression).join('\n')
    + '\nconst {net} = applyDiscount(grossNum, discount); const patch = {};\n' + saveAmount
    + '\nreturn { lines: toPersisted(items), amount: patch.amount };'
  assert.ok(saveAmount)
  const evaluate = new Function('roundInvoiceAmount', 'applyDiscount', 'items', 'editItems', 'base', 'discount',
    ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText)
  check('editor amount-only save retains cents', evaluate(roundInvoiceAmount, applyDiscount, [], false, '66.95', null).amount, 66.95)
  const editable = [{ description: 'Fractional quantity', qty: '1.5', unit: '2.35', kind: 'service' }, { description: 'Extra', qty: '1', unit: '0.49', kind: 'addon' }]
  const edited = evaluate(roundInvoiceAmount, applyDiscount, editable, true, '0', { type: 'percent', value: 10 })
  check('editor rounds the extended line at cent precision', edited.lines.map((l: Row) => l.amount), [3.53, 0.49])
  check('editor saves the canonical discounted net without re-rounding dollars', edited.amount, 3.62)
  check('editor retains finer unit rate without quantizing it before multiplication',
    evaluate(roundInvoiceAmount, applyDiscount, [{ description: 'Measured', qty: '100', unit: '0.035', kind: 'service' }], true, '0', null).amount, 3.5)
  console.log(`\nPASS ${passed} — invoice cents and draft history guards (synthetic I/O only)`)
}
main().catch(e => { console.error(e); process.exitCode = 1 })
