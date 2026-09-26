import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { buildSync } from 'esbuild'
import { optionSetProblem, optionsConflictWithLines } from '../../src/lib/quoteOptions'
import { quoteSaveIntentFixture } from './quote-save-plan-cases'
import { quoteSaveBaselineFixture } from './quote-save-baseline-fixtures'
import { copyPilotQuoteSaveJson } from '../../src/lib/quotes/pilotQuoteSaveReceipt'
import { parsePilotQuoteSaveIntent as planParser, PilotQuoteSavePlanError as PlanError } from '../../src/lib/quotes/pilotQuoteSavePlan'
import { parsePilotQuoteSaveIntent, PilotQuoteSavePlanError, validatePilotQuoteSaveDraftValues, validatePilotQuoteSaveSubmission,
  normalizePilotQuoteSaveNumericInput, isPilotQuoteSaveNumericPath, quoteSaveJsonCopy } from '../../src/lib/quotes/pilotQuoteSaveValues'
import type { TestResult } from './database'

type Row = Record<string, unknown>
export const quoteSaveValuesEvidence: Row[] = []
function priorParser(): (input: unknown) => unknown {
  // TEST ONLY: compare the actual pre-extraction parser, not a copied shipping
  // validator. Its immutable Git source is available in cloud's full checkout.
  const source = execFileSync('git', ['show', 'bace8b7a5dc7b9833d0e5cd59d85b11d8ae68c5d:src/lib/quotes/pilotQuoteSavePlan.ts'], { encoding: 'utf8', maxBuffer: 100_000 }).replace(/\r\n/g, '\n')
  const block = source.slice(source.indexOf('export class PilotQuoteSavePlanError'), source.indexOf('function versioned'))
  assert.ok(block.includes('export function parsePilotQuoteSaveIntent'))
  const js = ts.transpileModule('const PILOT_QUOTE_SAVE_REQUEST_BYTES = 200000;\n' + block + '\nreturn parsePilotQuoteSaveIntent;',
    { compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS } }).outputText
  quoteSaveValuesEvidence.push({ kind: 'frozen-parser-parity', ref: 'bace8b7a5dc7b9833d0e5cd59d85b11d8ae68c5d', sourceSha256: createHash('sha256').update(source).digest('hex') })
  return new Function('exports', 'optionSetProblem', 'optionsConflictWithLines', js)({}, optionSetProblem, optionsConflictWithLines) as (input: unknown) => unknown
}
export async function runQuoteSaveValuesCases(): Promise<TestResult[]> {
  const results: TestResult[] = []; quoteSaveValuesEvidence.length = 0
  const test = async (name: string, work: () => void) => { try { work(); results.push({ name: 'Save values: ' + name, pass: true }) }
    catch (error) { results.push({ name: 'Save values: ' + name, pass: false, error: error instanceof Error ? error.message.slice(0,1500) : 'Values assertion failed' }) } }
  await test('canonical parser extraction preserves normalized outputs and exact error codes', () => {
    const before = priorParser(), original = quoteSaveIntentFixture(quoteSaveBaselineFixture())
    const changed = (field: string, value: unknown) => ({ ...structuredClone(original), values: { ...structuredClone(original.values), [field]: value } })
    const inputs: unknown[] = [original, JSON.stringify(original), '{', null, {}, { ...original, owner: 'spoof' },
      { ...original, editorGeneration: 'invalid generation' }, changed('customer_name',''), changed('service_type',''),
      changed('initial_price',''), changed('hours',null), changed('initial_price',12.345), changed('initial_price','12.345'),
      changed('initial_price',Infinity), changed('initial_price',true), changed('measurement_snapshot', { v: 1 }),
      changed('notes', 'x'.repeat(200_001)), changed('has_options',true), changed('options',[{ name:'',description:'',price:'',is_recommended:false }]),
      changed('services',[{ service_type:'',service_template_id:'',quantity:'',unit:'',unit_price:null,est_minutes:0,discount_type:'',discount_value:0,notes:'',kind:'service' }])]
    const outcome = (parser: (value: unknown) => unknown, input: unknown) => { try { return { ok:true, value:parser(input) } }
      catch (error) { return { ok:false, code:(error as {code?:string}).code } } }
    for (const input of inputs) assert.deepEqual(outcome(parsePilotQuoteSaveIntent,input), outcome(before,input))
    assert.equal(planParser, parsePilotQuoteSaveIntent); assert.equal(PlanError, PilotQuoteSavePlanError)
    quoteSaveValuesEvidence.push({ kind: 'parser-matrix', compared: inputs.length })
  })
  await test('structural drafts preserve exact blank/null/incomplete bytes while final submission refuses', () => {
    const intent = quoteSaveIntentFixture(quoteSaveBaselineFixture()), draft = intent.values as unknown as Row
    Object.assign(draft, { customer_name:'', service_type:'', initial_price:'', hours:null, has_options:true,
      options:[{name:'',description:'',price:'',is_recommended:false}],
      services:[{service_type:'',service_template_id:'',quantity:null,unit:'',unit_price:'',est_minutes:0,discount_type:'',discount_value:0,notes:'',kind:'material'}] })
    const bytes = JSON.stringify(draft), checked = validatePilotQuoteSaveDraftValues(draft)
    assert.ok(checked); assert.equal(JSON.stringify(checked), bytes); assert.equal(JSON.stringify(draft), bytes)
    assert.deepEqual(validatePilotQuoteSaveSubmission(intent), {ok:false,code:'invalid_intent'})
  })
  await test('valid raw blanks survive submission validation and only parser COPY normalizes them', () => {
    const intent = quoteSaveIntentFixture(quoteSaveBaselineFixture()); Object.assign(intent.values, {hours:null,initial_price:'',deposit_type:'',deposit_value:''})
    const bytes=JSON.stringify(intent)
    assert.deepEqual(validatePilotQuoteSaveSubmission(intent),{ok:true}); assert.equal(JSON.stringify(intent),bytes)
    const normalized=parsePilotQuoteSaveIntent(intent); assert.equal(normalized.values.hours,0); assert.equal(normalized.values.initial_price,0)
  })
  await test('shared final validation includes canonical deposit and option gates', () => {
    const intent = quoteSaveIntentFixture(quoteSaveBaselineFixture()); intent.values.deposit_type='percent'; intent.values.deposit_value=101
    assert.deepEqual(validatePilotQuoteSaveSubmission(intent),{ok:false,code:'invalid_deposit'})
    assert.ok(validatePilotQuoteSaveDraftValues(intent.values)); assert.ok(parsePilotQuoteSaveIntent(intent))
    intent.values.deposit_type=''; intent.values.has_options=true; intent.values.options=[]
    assert.deepEqual(validatePilotQuoteSaveSubmission(intent),{ok:false,code:'invalid_options'})
  })
  await test('malformed, foreign-shaped, executable, oversized and nonfinite drafts never validate', () => {
    const values=quoteSaveIntentFixture(quoteSaveBaselineFixture()).values
    for (const value of [{...values,extra:'hidden'}, {...values,hours:'1.5'}, {...values,hours:NaN}, {...values,notes:'x'.repeat(200_001)},
      {...values,customer_name:undefined}, {...values,measurement_snapshot:{v:1}}, Object.assign(new Date(),values)]) assert.equal(validatePilotQuoteSaveDraftValues(value),null)
    let read=false; const getter={...values}; Object.defineProperty(getter,'notes',{enumerable:true,get(){read=true;return 'executed'}})
    assert.equal(validatePilotQuoteSaveDraftValues(getter),null); assert.equal(read,false)
    assert.equal(copyPilotQuoteSaveJson(getter,200_000),null); assert.equal(read,false)
    for (const [key,descriptor] of [
      ['toJSON',{value(){read=true;return values}}], ['toJSON',{get(){read=true;return ()=>values}}],
      ['hidden',{value:'unserialized'}], ['hidden',{get(){read=true;return 'executed'}}],
    ] as [string,PropertyDescriptor][]) {
      const hidden={...values}; Object.defineProperty(hidden,key,descriptor)
      assert.equal(validatePilotQuoteSaveDraftValues(hidden),null); assert.equal(read,false)
      assert.equal(copyPilotQuoteSaveJson(hidden,200_000),null); assert.equal(read,false)
      assert.throws(()=>parsePilotQuoteSaveIntent({...quoteSaveIntentFixture(quoteSaveBaselineFixture()),values:hidden}),{code:'invalid_intent'})
      assert.equal(read,false)
    }
    const symbol={...values,[Symbol('hidden')]:'unserialized'}
    assert.equal(validatePilotQuoteSaveDraftValues(symbol),null)
    assert.equal(copyPilotQuoteSaveJson(symbol,200_000),null)
    const inherited:unknown[]=[]; Object.setPrototypeOf(inherited,{get toJSON(){read=true;return ()=>[]}})
    assert.equal(validatePilotQuoteSaveDraftValues({...values,services:inherited}),null)
    assert.equal(copyPilotQuoteSaveJson(inherited,200_000),null); assert.equal(read,false)
    const shared={value:'legal'}, repeated={first:shared,second:shared}
    assert.deepEqual(quoteSaveJsonCopy(repeated,200_000,'invalid_intent','request_too_large'),repeated)
    assert.deepEqual(copyPilotQuoteSaveJson(repeated,200_000),repeated)
    const cycle:Row={};cycle.self=cycle
    assert.throws(()=>quoteSaveJsonCopy(cycle,200_000,'invalid_intent','request_too_large'),{code:'invalid_intent'})
    assert.equal(copyPilotQuoteSaveJson(cycle,200_000),null)
    quoteSaveValuesEvidence.push({kind:'executable-input-refusal',accessorOrToJsonInvocations:0,hiddenFieldsRejected:true,symbolsRejected:true,sharedReferencesAllowed:true,cyclesRejected:true})
  })
  await test('opt-in numeric paths and DOM coercion preserve null/blank and reject malformed values', () => {
    for (const path of ['initial_price','hours','deposit_value','services.0.quantity','services.9.discount_value','options.2.price']) assert.equal(isPilotQuoteSaveNumericPath(path),true)
    for (const path of ['customer_name','value_grade','services.0.notes','options.0.id','services.-1.unit_price','services.01.quantity']) assert.equal(isPilotQuoteSaveNumericPath(path),false)
    for (const [input,output] of [['', ''],[null,null],[12.345,12.345],['12.345',12.345],['.5',0.5],['-2e2',-200],['1e-3',0.001]]) assert.equal(normalizePilotQuoteSaveNumericInput(input),output)
    for (const input of [' ', '0x10', '1,000', 'Infinity', 'NaN', '1e309', true, {}, undefined, Infinity, NaN]) assert.throws(()=>normalizePilotQuoteSaveNumericInput(input),{code:'invalid_intent'})
  })
  await test('browser schema entrypoints bundle without server/planner/identity or Node runtime imports', () => {
    const build=buildSync({entryPoints:['src/lib/quotes/pilotQuoteSaveValues.ts','src/lib/quotes/pilotQuoteSaveBaseline.ts'],
      bundle:true,write:false,outdir:'unused-in-memory',platform:'browser',format:'esm',metafile:true,logLevel:'silent'})
    const inputs=Object.keys(build.metafile!.inputs)
    assert.equal(inputs.some(p=>/pilotQuote(?:Identity|Save(?:Plan|BaselineServer|Http))\.ts$/.test(p)),false)
    assert.equal(build.outputFiles.length,2)
    quoteSaveValuesEvidence.push({kind:'browser-schema-bundle',serverModulesPresent:false,outputCount:build.outputFiles.length})
  })
  return results
}
