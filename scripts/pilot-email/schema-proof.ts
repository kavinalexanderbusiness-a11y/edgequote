import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { splitStatements, substitutePlatformStatements } from '../lib/pg-sql'
import { DisposableSession, type TestResult } from './database'
import { runCases } from './schema-cases'
import { runExtraCases } from './schema-extra-cases'
import { runConcurrencyCases } from './concurrency-cases'
import { runTransportCases } from './transport-cases'
import { runRuntimeCases } from './runtime-cases'
import { runRuntimeReviewCases } from './runtime-review-cases'
import { runDriverCases } from './driver-cases'
import { runQuoteIdentityBaseline, quoteIdentityBaselineEvidence } from './quote-identity-baseline'
import { runQuoteIdentityCases } from './quote-identity-cases'
import { runQuoteIdentityConcurrency } from './quote-identity-concurrency'
import { runAcceptanceBaseline } from './acceptance-baseline-cases'
import { runQuoteSavePlanCases, quoteSavePlanEvidence } from './quote-save-plan-cases'
import { runQuoteSaveEditorCases, quoteSaveEditorEvidence } from './quote-save-editor-cases'
import { runQuoteSaveNativeCases, runQuoteSaveNativeConcurrency, quoteSaveNativeEvidence } from './quote-save-native-cases'
import { runQuoteVersionedAcceptanceCases } from './quote-versioned-acceptance-cases'

const source = resolve(__dirname, '../..')
const output = join(source, 'outputs/pilot-full-quote-save-20260910')
const PROPOSAL_HASH = '434048ade9a3625a280707f12877f694281e72efbaa78b29ae141503876540fb'
const IDENTITY_PROPOSAL_HASH = '7308c0db5f2f60e5c5ffc338bb9245e7484ff76525be527a12e0352b487b681d'
const sourcePins: Record<string, string> = {}
const read = (path: string) => {
  const text = readFileSync(join(source, path), 'utf8').replace(/\r\n/g, '\n')
  sourcePins[path] = createHash('sha256').update(text).digest('hex')
  return text
}

async function main() {
  let db: DisposableSession | undefined
  let concurrencyClosed = true
  let identityConcurrencyClosed = true
  let acceptanceBaselineClosed = true
  let saveConcurrencyClosed = true
  let versionedAcceptanceClosed = true
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(), sourcePins, groups: {}, platformSubstitutions: [],
    scope: 'Actual baseline/all migrations/proposal on isolated marked PostgreSQL17 service, including native triggers/publication/RLS. Separate psql backends prove recorded lock interleavings. Supabase auth/storage/net are the existing platform test doubles; external provider/auth calls are synthetic. No production database, live client or provider activation.',
    productionCalls: 0, providerCalls: 0, realBusinessWrites: 0,
  }
  const groups = report.groups as Record<string, TestResult[]>
  try {
    // Verify the reviewed proposal before even opening the synthetic database.
    read('supabase/proposals/pilot-email-core.sql')
    if (sourcePins['supabase/proposals/pilot-email-core.sql'] !== PROPOSAL_HASH) throw new Error('Proposal differs from independently reviewed SQL; rebind explicitly')
    read('supabase/proposals/pilot-quote-identity.sql')
    if (sourcePins['supabase/proposals/pilot-quote-identity.sql'] !== IDENTITY_PROPOSAL_HASH) throw new Error('Quote identity proposal differs from independently reviewed SQL; rebind explicitly')
    read('src/lib/quotes/pilotQuoteIdentity.ts')
    read('src/lib/customers.ts')
    read('src/lib/attribution.ts')
    read('src/app/dashboard/quotes/[id]/page.tsx')
    read('src/app/portal/[token]/PortalClient.tsx')
    read('src/components/quotes/RecordAcceptanceDialog.tsx')
    read('src/lib/payments/termsTimingConflict.ts')
    read('supabase/proposals/pilot-quote-save-contract.md')
    read('supabase/proposals/pilot-quote-save-contract-resolutions.md')
    for (const file of [
      'src/lib/quotes/pilotQuoteSavePlan.ts', 'src/lib/quotes/pilotQuoteSaveEditor.ts',
      'src/lib/quotes/pilotQuoteSaveReceipt.ts', 'src/lib/quotes/pilotQuoteSave.ts',
      'src/lib/quotes/pilotQuoteSaveValues.ts', 'src/lib/quotes/pilotQuoteSaveBaseline.ts',
      'src/lib/quotes/pilotQuoteSaveBaselineServer.ts', 'src/lib/quotes/pilotQuoteSaveHttp.ts',
      'src/types/index.ts', 'src/lib/quoteServices.ts', 'src/lib/quoteOptions.ts',
      'src/lib/payments/depositGate.ts', 'src/lib/pricingConfig.ts', 'src/lib/servicePricing.ts',
      'src/lib/utils.ts', 'src/lib/measure/data.ts', 'src/lib/measurePricing.ts',
    ]) read(file)
    read('.github/workflows/pilot-email-schema.yml')
    for (const file of readdirSync(join(source, 'scripts/pilot-email')).filter(f => /\.(ts|sql|md)$/.test(f)).sort()) read('scripts/pilot-email/' + file)
    for (const file of readdirSync(join(source, 'src/lib/comms')).filter(f => /^pilotEmail.*\.ts$/.test(f)).sort()) read('src/lib/comms/' + file)
    db = await DisposableSession.open('schema-main')
    report.databaseVersion = (await db.query('select version() as version')).rows[0].version
    groups.driver = await runDriverCases(db)
    if (groups.driver.some(test => !test.pass)) throw new Error('Disposable driver controls failed; schema application refused')
    const empty = (await db.query<{ count: number }>(`select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m')`)).rows[0]
    if (empty.count !== 0) throw new Error('Disposable database is not empty; refusing application over existing data')
    const apply = async (file: string) => {
      const transformed = substitutePlatformStatements(read(file))
      ;(report.platformSubstitutions as string[]).push(...transformed.hits.map(hit => file + ': ' + hit))
      for (const [index, statement] of splitStatements(transformed.sql).entries()) {
        try { await db!.exec(statement) }
        catch (error) { throw new Error(`SQL application failed at ${file}:${index + 1}: ${error instanceof Error ? error.message : 'unknown error'}`) }
      }
    }
    await apply('scripts/schema/platform-prelude.sql')
    for (const file of readdirSync(join(source, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) await apply('supabase/migrations/' + file)
    await apply('supabase/proposals/pilot-email-core.sql')
    await apply('supabase/proposals/pilot-quote-identity.sql')
    const nativeDefinition = async () => (await db!.query<{ value: unknown }>(`select jsonb_build_object(
      'triggers',(select jsonb_agg(pg_get_triggerdef(t.oid) order by t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal and c.relname in ('messages','notification_log','customers','conversations')),
      'publications',(select jsonb_agg(to_jsonb(p) order by p.pubname) from pg_publication p),
      'published_tables',(select jsonb_agg(to_jsonb(p) order by p.pubname,p.schemaname,p.tablename) from pg_publication_tables p),
      'policies',(select jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname) from pg_policies p where schemaname='public' and tablename in ('messages','notification_log','customers','conversations'))
    ) as value`)).rows[0].value
    const nativeBefore = await nativeDefinition()
    const quoteNativeDefinition = async () => (await db!.query<{ value: {
      relations: unknown; functions: { signature: string; definition_md5: string; acl: unknown }[];
    } }>(`select jsonb_build_object(
      'relations',(select jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
        'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'required',a.attnotnull,
          'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
          from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
        'constraints',(select jsonb_agg(pg_get_constraintdef(k.oid) order by k.conname) from pg_constraint k where k.conrelid=c.oid),
        'triggers',(select jsonb_agg(pg_get_triggerdef(t.oid) order by t.tgname) from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal),
        'policies',(select jsonb_agg(to_jsonb(p) order by p.policyname) from pg_policies p where p.schemaname='public' and p.tablename=c.relname)
      ) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname in ('quotes','quote_options','quote_services','quote_addons','quote_acceptances','customers','properties',
        'property_measurements','property_measurement_events','business_settings','service_templates','customer_portal_tokens','pricing_config_versions')),
      'functions',(select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition_md5',md5(pg_get_functiondef(p.oid)),
        'acl',p.proacl) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prokind='f')
    ) as value`)).rows[0].value
    const quoteNativeBefore = await quoteNativeDefinition()
    groups.schema = await runCases(db)
    groups.supplemental = await runExtraCases(db)
    groups.transport = await runTransportCases()
    groups.runtime = await runRuntimeCases(db)
    groups.runtimeReview = await runRuntimeReviewCases(db)
    concurrencyClosed = false
    const concurrency = await runConcurrencyCases(db)
    concurrencyClosed = true
    groups.concurrency = concurrency.tests
    report.concurrency = { barriers: concurrency.barriers, sessions: concurrency.sessions, observer: db.pid }
    groups.quoteIdentityBaseline = await runQuoteIdentityBaseline(db)
    report.quoteIdentityBaseline = quoteIdentityBaselineEvidence
    groups.quoteIdentity = await runQuoteIdentityCases(db)
    identityConcurrencyClosed = false
    const identityConcurrency = await runQuoteIdentityConcurrency(db)
    identityConcurrencyClosed = true
    groups.quoteIdentityConcurrency = identityConcurrency.tests
    report.quoteIdentityConcurrency = { barriers: identityConcurrency.barriers, sessions: identityConcurrency.sessions, observer: db.pid }
    const nativeAfter = await nativeDefinition()
    groups.preservation = [{ name: 'native trigger, RLS and publication definitions remain intact after all cases', pass: JSON.stringify(nativeBefore) === JSON.stringify(nativeAfter) }]
    report.nativeDefinitions = nativeAfter
    // Phase separation is deliberate: the preceding 183 are predecessor safety
    // cases. The next group reproduces defects in unchanged native acceptance;
    // passing reproductions do not mean full Save or acceptance has been fixed.
    acceptanceBaselineClosed = false
    const acceptanceBaseline = await runAcceptanceBaseline(db)
    acceptanceBaselineClosed = acceptanceBaseline.allSessionsClosed
    groups.acceptanceBaseline = acceptanceBaseline.tests
    report.acceptanceBaseline = acceptanceBaseline
    const baseline = Object.values(groups).flat()
    report.preCandidate = {
      passed: baseline.filter(t => t.pass).length, failed: baseline.filter(t => !t.pass).length,
      scope: 'Unchanged predecessor assertions and defect reproductions before candidate proposals are installed',
    }
    if (baseline.some(test => !test.pass)) throw new Error('Pre-candidate safety or defect reproduction failed; candidate application refused')
    groups.quoteSavePlan = await runQuoteSavePlanCases()
    report.quoteSavePlan = quoteSavePlanEvidence
    groups.quoteSaveEditor = await runQuoteSaveEditorCases()
    report.quoteSaveEditor = quoteSaveEditorEvidence
    // Candidate-only SQL is installed after preserving the unchanged baseline.
    // Neither proposal is a migration or mounted production API.
    await apply('supabase/proposals/pilot-quote-save.sql')
    await apply('supabase/proposals/pilot-quote-versioned-acceptance.sql')
    // The platform prelude permits deferred body validation. Compile the new
    // entrypoints with empty, rejected authority before running fault cases so
    // a syntax error cannot masquerade as an intended transactional rollback.
    const compiled = (await db.query<{ value: string[] }>(`select jsonb_build_array(
      public.pilot_quote_save(null,null,null)->>'code',
      public.pilot_quote_acceptance_preview(null,null,null,null)->>'code',
      public.pilot_quote_acceptance_commit(null,null,null,null,null,null,null,null,false)->>'code',
      public.pilot_quote_acceptance_reconcile(null,null,null,null,null,null,null,null)->>'code'
    ) as value`)).rows[0].value
    if (JSON.stringify(compiled) !== JSON.stringify(['not_found','invalid_request','invalid_request','invalid_request'])) {
      throw new Error('Candidate entrypoint compile/refusal preflight returned unexpected verdicts')
    }
    groups.candidateEntrypoints = [{ name: 'Candidate entrypoints compile and reject empty authority before transactional fault cases', pass: true }]
    report.candidateFullSaveImplemented = true
    report.candidateVersionedAcceptanceImplemented = true
    report.mountedFullSaveImplemented = false
    report.mountedVersionedAcceptanceImplemented = false
    groups.quoteSaveNative = await runQuoteSaveNativeCases(db)
    report.quoteSaveNative = quoteSaveNativeEvidence
    saveConcurrencyClosed = false
    const saveConcurrency = await runQuoteSaveNativeConcurrency(db)
    saveConcurrencyClosed = saveConcurrency.allSessionsClosed
    groups.quoteSaveConcurrency = saveConcurrency.tests
    report.quoteSaveConcurrency = saveConcurrency
    versionedAcceptanceClosed = false
    const versionedAcceptance = await runQuoteVersionedAcceptanceCases(db)
    versionedAcceptanceClosed = versionedAcceptance.allSessionsClosed
    groups.quoteVersionedAcceptance = versionedAcceptance.tests
    report.quoteVersionedAcceptance = versionedAcceptance
    const nativeAfterCandidate = await nativeDefinition()
    groups.candidatePreservation = [{
      name: 'Candidate proposals preserve native message/customer trigger, RLS and publication definitions',
      pass: JSON.stringify(nativeBefore) === JSON.stringify(nativeAfterCandidate),
    }]
    report.candidateNativeDefinitions = { before: nativeBefore, after: nativeAfterCandidate }
    const quoteNativeAfter = await quoteNativeDefinition()
    const afterFunctions = new Map(quoteNativeAfter.functions.map(fn => [fn.signature, fn]))
    const changedFunctions = quoteNativeBefore.functions.filter(fn => fn.definition_md5 !== afterFunctions.get(fn.signature)?.definition_md5)
      .map(fn => fn.signature).sort()
    const intendedChanges = [
      'quote_apply_choice(uuid,uuid,uuid[],text)',
      'quote_record_acceptance(uuid,text,text,uuid,text,text,text,boolean)',
      'portal_accept_quote(text,uuid,uuid,uuid[],boolean)',
      'owner_record_customer_acceptance(uuid,text,uuid,uuid[],text)',
      'owner_select_quote_option(uuid,uuid,uuid[],text,text)',
    ].sort()
    groups.candidatePreservation.push({
      name: 'Quote, choice, acceptance, measurement and dependency table definitions remain unchanged',
      pass: JSON.stringify(quoteNativeBefore.relations) === JSON.stringify(quoteNativeAfter.relations),
    }, {
      name: 'Only the five explicitly reviewed native acceptance function definitions change; existing function grants stay intact',
      pass: JSON.stringify(changedFunctions) === JSON.stringify(intendedChanges)
        && quoteNativeBefore.functions.every(fn => JSON.stringify(fn.acl) === JSON.stringify(afterFunctions.get(fn.signature)?.acl)),
    })
    report.quoteNativeDefinitions = { before: quoteNativeBefore, after: quoteNativeAfter, changedFunctions, intendedChanges }
    const all = Object.values(groups).flat()
    report.passed = all.filter(t => t.pass).length
    report.failed = all.filter(t => !t.pass).length
    report.pass = Object.values(groups).every(group => group.length > 0) && all.every(t => t.pass)
  } catch (error) {
    report.pass = false
    report.error = error instanceof Error ? error.message.slice(0, 2000) : 'Native PostgreSQL proof failed'
  } finally {
    let mainClosed = true
    try { await db?.close() } catch {
      mainClosed = false
      report.pass = false
      report.error = 'Main fixture session exit could not be confirmed'
    }
    report.allSessionsClosed = mainClosed && concurrencyClosed && identityConcurrencyClosed && acceptanceBaselineClosed
      && saveConcurrencyClosed && versionedAcceptanceClosed && quoteIdentityBaselineEvidence.every(e => e.sessionsClosed === true)
    if (!report.allSessionsClosed) report.pass = false
    report.completedAt = new Date().toISOString()
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'native-pg17-proof.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ pass: report.pass, passed: report.passed, failed: report.failed, groups, error: report.error }))
    if (!report.pass) process.exitCode = 1
  }
}
void main()
