import assert from 'node:assert/strict'
import { assertDisposableEnvironment, bindParameters, DISPOSABLE_MARKER, type Database, type TestResult } from './database'

export async function runDriverCases(db?: Database): Promise<TestResult[]> {
  const results: TestResult[] = []
  const test = async (name: string, work: () => unknown | Promise<unknown>) => {
    try { await work(); results.push({ name, pass: true }) }
    catch (error) { results.push({ name, pass: false, error: error instanceof Error ? error.message : 'Driver assertion failed' }) }
  }
  const marker = { PILOT_EMAIL_DISPOSABLE: DISPOSABLE_MARKER }
  await test('no disposable marker refuses before spawning psql', () => assert.throws(() => assertDisposableEnvironment({})))
  await test('marked constant local target is accepted', () => assert.doesNotThrow(() => assertDisposableEnvironment(marker)))
  for (const [key, value] of Object.entries({ PGHOST: 'database.example.invalid', PGPORT: '6543', PGDATABASE: 'production', PGUSER: 'app_user', DATABASE_URL: 'postgres://example.invalid/unused', PGSERVICE: 'saved-service', PGSERVICEFILE: '/unused', PGPASSFILE: '/unused', SUPABASE_DB_URL: 'postgres://example.invalid/unused' })) {
    await test('external override ' + key + ' refuses', () => assert.throws(() => assertDisposableEnvironment({ ...marker, [key]: value })))
  }
  await test('fixture binder leaves quoted/commented positional text inert', () => {
    assert.equal(bindParameters(`select $1, '$2', "$3", $$ $4 $$ /* $5 /* $6 */ */ -- $7\n`, ['hello']),
      `select 'hello', '$2', "$3", $$ $4 $$ /* $5 /* $6 */ */ -- $7\n`)
  })
  await test('missing parameters and non-finite values refuse', () => {
    assert.throws(() => bindParameters('select $2', ['one']))
    assert.throws(() => bindParameters('select $1', [Infinity]))
    assert.throws(() => bindParameters('select $1', ['nul\0byte']))
  })
  if (!db) return results
  await test('actual server receives dangerous-looking fixture text only as a value', async () => {
    const value = "O'Brien'); select pg_sleep(20); -- \\echo fake\n$1 é"
    assert.equal((await db.query<{ value: string }>('select $1::text as value', [value])).rows[0].value, value)
  })
  await test('actual server returns null, number and boolean parameter types', async () => {
    assert.deepEqual((await db.query('select $1::text as missing,$2::numeric as amount,$3::boolean as enabled', [null, 42.5, true])).rows,
      [{ missing: null, amount: 42.5, enabled: true }])
  })
  await test('SQLSTATE survives a failed transaction and savepoint recovery', async () => {
    await db.exec('begin; savepoint expected_failure')
    try {
      await assert.rejects(() => db.query('select 1/0 as value'), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === '22012')
      await assert.rejects(() => db.query('select 1 as value'), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === '25P02')
      await db.exec('rollback to savepoint expected_failure; release savepoint expected_failure')
      assert.equal((await db.query<{ value: number }>('select 7 as value')).rows[0].value, 7)
    } finally { await db.exec('rollback') }
  })
  return results
}
