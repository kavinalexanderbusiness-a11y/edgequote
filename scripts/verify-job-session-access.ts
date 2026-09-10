import { readFileSync, readdirSync } from 'node:fs'
import assert from 'node:assert/strict'
import { loadPGlite } from './lib/pg-sql'

async function main() {
  const engine = await loadPGlite()
  if (!engine) {
    console.log('SKIPPED: PGlite is required to prove work-session permissions.')
    process.exit(2)
  }
  const db = new engine.PGlite()
  try {
    const baseline = readdirSync('supabase/migrations').find(f => f.endsWith('_baseline.sql'))!
    const source = readFileSync('supabase/migrations/' + baseline, 'utf8')
    const definition = source.match(/CREATE OR REPLACE FUNCTION public\.job_session_minutes\(p_job_id uuid\)[\s\S]*?\$function\$;/)?.[0]
    assert.ok(definition, 'Use the actual repository function')
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
      create table public.job_work_sessions(job_id uuid, minutes integer);
      insert into public.job_work_sessions values
        ('00000000-0000-0000-0000-000000000001', 25),
        ('00000000-0000-0000-0000-000000000001', 35),
        ('00000000-0000-0000-0000-000000000002', 90);
    `)
    await db.exec(definition)
    await db.exec('grant execute on function public.job_session_minutes(uuid) to anon, authenticated, service_role')
    const migration = readdirSync('supabase/migrations').find(f => f.endsWith('_restrict_job_session_minutes.sql'))!
    await db.exec(readFileSync('supabase/migrations/' + migration, 'utf8'))
    for (const role of ['anon', 'authenticated']) {
      await db.exec('set role ' + role)
      await assert.rejects(
        db.query("select public.job_session_minutes('00000000-0000-0000-0000-000000000001')"),
        (error: any) => error.code === '42501',
        role + ' must be denied even with a known job ID',
      )
      await db.exec('reset role')
      console.log('PASS: ' + role + ' cannot read work-session totals')
    }
    await db.exec('set role service_role')
    const result = await db.query("select public.job_session_minutes('00000000-0000-0000-0000-000000000001') as minutes")
    assert.equal(result.rows[0].minutes, 60)
    await db.exec('reset role')
    const empty = await db.query("select public.job_session_minutes('00000000-0000-0000-0000-000000000003') as minutes")
    assert.equal(empty.rows[0].minutes, null)
    console.log('PASS: server total remains 60 minutes; missing sessions remain unknown')
  } finally {
    await db.close()
  }
}
main().catch(error => { console.error(error); process.exit(1) })
