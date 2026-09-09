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

const source = resolve(__dirname, '../..')
const output = join(source, 'outputs/pilot-quote-reassignment-20260909')
const PROPOSAL_HASH = '434048ade9a3625a280707f12877f694281e72efbaa78b29ae141503876540fb'
const IDENTITY_PROPOSAL_HASH = '7a4b94422309f1318f6f708b645ce0ff041357bcc59e9a9f2013adf76788985e'
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
    report.allSessionsClosed = mainClosed && concurrencyClosed && identityConcurrencyClosed && quoteIdentityBaselineEvidence.every(e => e.sessionsClosed === true)
    if (!report.allSessionsClosed) report.pass = false
    report.completedAt = new Date().toISOString()
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'native-pg17-proof.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ pass: report.pass, passed: report.passed, failed: report.failed, groups, error: report.error }))
    if (!report.pass) process.exitCode = 1
  }
}
void main()
