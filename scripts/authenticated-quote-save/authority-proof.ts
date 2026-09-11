import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DisposableSession } from '../pilot-email/database'
import { splitStatements, substitutePlatformStatements } from '../lib/pg-sql'

const root = process.cwd(), output = resolve('outputs/authenticated-quote-authority-20260911')
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

async function main() {
  let db: DisposableSession | undefined
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(), pass: false,
    scope: 'Bounded native/server authority prerequisite on real disposable PostgreSQL17. Auth/JWT/platform prelude and server identity are synthetic. No real Auth service, PostgREST, cookie session, browser, production data or full authenticated Save proof.',
    productionWrites: 0, providerCalls: 0, mountedRoute: false, platformSubstitutions: [], sourcePins: {},
  }
  try {
    const expected = process.env.PILOT_AUTHORITY_EXPECT
    assert.ok(expected === 'vulnerable' || expected === 'corrected', 'Explicit expected source behavior required')
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Cloud runner only; no heavy local database')
    report.expected = expected
    report.head = git('rev-parse', 'HEAD'); report.tree = git('rev-parse', 'HEAD^{tree}')
    assert.equal(report.head, process.env.GITHUB_SHA, 'Actual checkout must match dispatched SHA')
    assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Tracked checkout must be clean')
    const pins = report.sourcePins as Record<string, string>
    for (const file of git('ls-files').split('\n').filter(f => /\.(ts|tsx|mjs|sql|json|yml)$/.test(f))) {
      pins[file] = sha(readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n'))
    }
    db = await DisposableSession.open('authority-bootstrap')
    report.databaseVersion = (await db.query('select version() as version')).rows[0].version
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m')")).rows[0].n, 0)
    const apply = async (file: string) => {
      const transformed = substitutePlatformStatements(readFileSync(join(root, file), 'utf8'))
      ;(report.platformSubstitutions as string[]).push(...transformed.hits.map(hit => file + ': ' + hit))
      for (const [i, statement] of splitStatements(transformed.sql).entries()) {
        try { await db!.exec(statement) }
        catch (error) { throw new Error(`SQL bootstrap failed at ${file} statement${i + 1}: ${error instanceof Error ? error.message : 'unknown'}`) }
      }
    }
    // Explicitly synthetic platform proof, separate from the proposed REAL Auth
    // gate in platform-plan.md. Do not cite this as authentication evidence.
    await apply('scripts/schema/platform-prelude.sql')
    // The old synthetic prelude omits this real-platform namespace permission.
    // Namespace USAGE only: role-RPC EXECUTE remains independently restricted.
    await db.exec('grant usage on schema auth to authenticated')
    report.syntheticCompatibility = ['auth schema USAGE for authenticated; no RPC EXECUTE privilege added']
    for (const file of readdirSync(join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) await apply('supabase/migrations/' + file)
    for (const file of ['pilot-email-core.sql', 'pilot-quote-identity.sql', 'pilot-quote-save.sql']) await apply('supabase/proposals/' + file)
    const { runAuthorityCases } = await import('./authority-native-cases')
    report.native = await runAuthorityCases(db, expected)
    const result = report.native as { pass: boolean; tests: { pass: boolean }[]; allSessionsClosed: boolean }
    report.pass = result.pass === true && result.tests.length > 0 && result.tests.every(t => t.pass) && result.allSessionsClosed
    if (expected === 'corrected') {
      const { runAuthorityHttpCases } = await import('./authority-http-cases')
      const { runQuoteSaveServerCases } = await import('../pilot-email/quote-save-server-cases')
      const { runQuoteSaveBaselineCases } = await import('../pilot-email/quote-save-baseline-cases')
      const http = await runAuthorityHttpCases()
      const regression = [...await runQuoteSaveServerCases(), ...await runQuoteSaveBaselineCases()]
      report.http = http; report.regression = regression
      report.pass = report.pass && http.length === 27 && http.every(t => t.pass)
        && regression.length === 39 && regression.every(t => t.pass)
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message.slice(0, 2000) : 'Authority proof failed'
  } finally {
    if (db) {
      try { await db.close(); report.observerClosed = true }
      catch { report.observerClosed = false; report.pass = false }
    }
    report.completedAt = new Date().toISOString()
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'authority-proof.json'), JSON.stringify(report, null, 2))
    const native = report.native as { tests?: { name: string; pass: boolean; error?: string }[] } | undefined
    console.log(JSON.stringify({ pass: report.pass, expected: report.expected, head: report.head,
      tests: native?.tests, http: report.http, regression: report.regression,
      error: report.error, observerClosed: report.observerClosed }))
    if (!report.pass) process.exitCode = 1
  }
}
void main()
