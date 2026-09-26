import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { Quote, QuoteOption, QuoteService, QuoteFormValues } from '../../src/types'
import { splitServices } from '../../src/lib/quoteServices'
import { sortedOptions } from '../../src/lib/quoteOptions'
import { pilotQuoteSaveEditorDefaults } from '../../src/lib/quotes/pilotQuoteSaveEditor'
import type { TestResult } from './database'

const sourcePath = 'src/app/dashboard/quotes/[id]/page.tsx'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
export const quoteSaveEditorEvidence: Record<string, unknown>[] = []

// Test only: execute the actual existing JSX defaultValues expression. The
// application adapter does not evaluate source code or carry this test helper.
function existingDefaults() {
  const source = readFileSync(resolve(sourcePath), 'utf8').replace(/\r\n/g, '\n')
  const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const expressions: ts.Expression[] = []
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'QuoteBuilder') {
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'defaultValues'
          && attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
          expressions.push(attribute.initializer.expression)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.equal(expressions.length, 1, 'One actual editor initializer must remain identifiable')
  const expression = expressions[0].getText(file)
  const compiled = ts.transpileModule(`const {primary:primaryLine,extras:extraServiceRows}=splitServices(services); const result=(${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText
  quoteSaveEditorEvidence.push({ sourcePath, sourceSha256: hash(source), initializerSha256: hash(expression) })
  return new Function('quote', 'services', 'options', 'splitServices', 'sortedOptions', compiled + '\nreturn result;') as (
    q: Quote, s: QuoteService[], o: QuoteOption[], split: typeof splitServices, sort: typeof sortedOptions,
  ) => Partial<QuoteFormValues>
}

const snapshot: NonNullable<Quote['measurement_snapshot']> = {
  v: 2, type: 'area', unit: 'sqft', value: 1200,
  parts: [{ label: 'Original area', value: 1200, ring: [{lat:51,lng:-114},{lat:51.001,lng:-114},{lat:51,lng:-114.001}] }],
  measuredAt: '2026-09-10T12:00:00.000Z', serviceTemplateId: null, serviceName: 'Lawn', term: 'one_time', basis: 'flat', rate: 100, price: 100,
}
function quote(): Quote {
  return {
    customer_id: '82000000-0000-4000-8000-000000000002', customer_name: 'Synthetic customer',
    address: '100 Synthetic Avenue', service_type: 'Synthetic service', service_template_id: null,
    initial_price: 500, weekly_price: 45, biweekly_price: null, monthly_price: 100,
    measured_sqft: 1200, measurement_snapshot: structuredClone(snapshot), suggested_price: 490,
    hours: 2, crew_size: 2, rate: 50, travel_fee: 15, custom_travel_required: true, show_travel_separately: true,
    notes: 'Customer-facing scope', internal_notes: 'Private planning note', status: 'sent',
    deposit_type: 'percent', deposit_value: 50,
  } as Quote
}
function service(sort_order: number, kind: 'service' | 'material'): QuoteService {
  return {
    id: `82000000-0000-4000-8000-${String(10 + sort_order).padStart(12,'0')}`,
    service_type: kind === 'material' ? 'Mulch' : 'Lawn care', service_template_id: null,
    quantity: kind === 'material' ? 6 : 1, unit: kind === 'material' ? 'yd' : 'each',
    unit_price: kind === 'material' ? 55 : 170, est_minutes: 30,
    kind, discount_type: 'percent', discount_value: 10, notes: 'Saved line note', sort_order,
  } as QuoteService
}
export async function runQuoteSaveEditorCases(): Promise<TestResult[]> {
  const results: TestResult[] = []
  const test = async (name: string, run: () => void) => {
    try { run(); results.push({ name, pass: true }) }
    catch (e) { results.push({ name, pass: false, error: e instanceof Error ? e.message : String(e) }) }
  }
  const actual = existingDefaults()
  await test('Complete editor defaults match actual page for plain, services/materials, options and blank records', () => {
    const options = [
      { id:'82000000-0000-4000-8000-000000000051',name:'Premium',description:'Included scope',price:650,is_recommended:true,sort_order:1 },
      { id:'82000000-0000-4000-8000-000000000050',name:'Standard',description:null,price:500,is_recommended:false,sort_order:0 },
    ] as QuoteOption[]
    const blank = {...quote(),customer_id:null,initial_price:null,weekly_price:null,biweekly_price:null,monthly_price:null,
      notes:null,internal_notes:null,measurement_snapshot:null,deposit_type:null,deposit_value:null} as Quote
    for (const fixture of [
      { quote:quote(), services:[] as QuoteService[], options:[] as QuoteOption[] },
      { quote:quote(), services:[service(2,'material'),service(0,'service'),service(1,'service')], options:[] as QuoteOption[] },
      { quote:quote(), services:[] as QuoteService[], options },
      { quote:blank, services:[] as QuoteService[], options:[] as QuoteOption[] },
    ]) {
      const before = structuredClone(fixture)
      const expected = actual(fixture.quote,fixture.services,fixture.options,splitServices,sortedOptions)
      const result = pilotQuoteSaveEditorDefaults(fixture.quote,fixture.services,fixture.options)
      assert.deepEqual(result,{...expected,measurement_snapshot:fixture.quote.measurement_snapshot ?? null})
      assert.deepEqual(fixture,before)
    }
  })
  await test('Existing page snapshot omission is reproduced; dormant initializer preserves a separate copy', () => {
    const q = quote(), old = actual(q,[],[],splitServices,sortedOptions)
    assert.equal(Object.hasOwn(old,'measurement_snapshot'),false)
    const result = pilotQuoteSaveEditorDefaults(q,[],[])
    assert.deepEqual(result.measurement_snapshot,q.measurement_snapshot)
    assert.notEqual(result.measurement_snapshot,q.measurement_snapshot)
    result.measurement_snapshot!.parts[0].label = 'Later form edit'
    assert.equal(q.measurement_snapshot!.parts[0].label,'Original area')
    assert.notEqual(result.notes,result.internal_notes)
  })
  return results
}
