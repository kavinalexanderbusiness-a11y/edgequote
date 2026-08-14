// ── Cron reliability verification — npm run verify:cron ─────────────────────
//
// THE invariant this pins: a scheduled job is either RUNNING AND OBSERVABLE, or it
// is visibly broken. Never configured-but-dead behind a green check.
//
// The production state it was written for: vercel.json declared twelve crons and
// CRON_SECRET was never set, so every one of them answered 403 to the scheduler
// from the day it shipped. `automation_sweeps` and `automation_runs` were both
// empty — no reminder, no follow-up and no AutoPay sweep had ever run — and
// /api/health reported `status: "ok"` throughout, because it treated the cron
// capability as informational. Nine of the twelve wrote no durable record of a run
// at all, so even once the secret is set, "did anyone get billed last night?" had
// no answer outside Vercel's log retention.
//
// Four halves, so a regression on any of them fails loudly:
//   1. sweepVerdict — every branch of the decision that says whether a run is
//      recorded and whether it counts as healthy. Pure, no I/O.
//   2. recordSweep — the exact row that reaches Postgres, via a recording stub.
//   3. Registry parity — vercel.json ↔ CRON_JOBS ↔ route files on disk, three ways.
//   4. Source invariants — one heartbeat writer, shared auth guard, daily-only
//      schedules, and a health endpoint that degrades on a dead scheduler.
//
// Same discipline as verify-day-settings / verify-recurrence: the behavioural half
// is pure and deterministic (the supabase client is a recording stub), and the
// source half reads files rather than trusting a comment.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  CRON_JOBS, CUSTOMER_FACING_JOBS, sweepVerdict, recordSweep, counts, classifyCronHealth, type CronJob,
} from '../src/lib/cron/heartbeat'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`) }
}

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const routePath = (job: string) => `src/app/api/cron/${job}/route.ts`

// Everything runs inside main(): the guards execute under tsx, which transpiles to
// CommonJS, and top-level await is a transform error there.
async function main() {
// ════════════════════════════════════════════════════════════════════════════
H('1. sweepVerdict — what gets recorded, and what counts as healthy')

// An unauthenticated request writes NOTHING. This is the load-bearing one: it stops
// a stranger filling the table, AND it is what leaves the absence that /api/health
// reads as "declared but never ran". Recording a 403 would paper over the exact
// outage this lane exists to surface.
check('403 is never recorded', sweepVerdict(403, null), { record: false, ok: false, error: null })
check('401 is never recorded', sweepVerdict(401, null), { record: false, ok: false, error: null })
check('403 with a body is still never recorded', sweepVerdict(403, { ok: true }), { record: false, ok: false, error: null })

// A clean run.
check('200 + {ok:true} is a healthy run', sweepVerdict(200, { ok: true }), { record: true, ok: true, error: null })
check('200 with no body is a healthy run', sweepVerdict(200, null), { record: true, ok: true, error: null })

// THE honesty rule: a job that says it failed is failed, whatever its status code.
// signals/engine/autopay all report a partial failure as {ok:false} behind a 200,
// because a 500 would tell the scheduler a mostly-good night was a broken deploy.
check('200 + {ok:false} is a FAILED run', sweepVerdict(200, { ok: false }), { record: true, ok: false, error: null })
check('200 + {ok:false} keeps its error', sweepVerdict(200, { ok: false, error: 'all 3 owners failed' }),
  { record: true, ok: false, error: 'all 3 owners failed' })

// And the converse: a non-2xx cannot be talked up into a healthy run by its body.
check('500 + {ok:true} is still a FAILED run', sweepVerdict(500, { ok: true }), { record: true, ok: false, error: null })
check('503 (no service client) is a FAILED run', sweepVerdict(503, null), { record: true, ok: false, error: null })
check('500 carries its error text', sweepVerdict(500, { error: 'relation does not exist' }),
  { record: true, ok: false, error: 'relation does not exist' })

// A non-boolean `ok` must not be read as truthy/falsey — only a real boolean is a
// verdict. `{ok:'yes'}` is a malformed body, not a claim of health or failure.
check('a non-boolean ok is ignored, status decides', sweepVerdict(200, { ok: 'yes' }), { record: true, ok: true, error: null })
check('a non-string error is dropped', sweepVerdict(500, { error: { code: 42 } }), { record: true, ok: false, error: null })

// ════════════════════════════════════════════════════════════════════════════
H('2. recordSweep — the exact row that reaches Postgres')

function stubSupabase() {
  const seen: { table: string; row: Record<string, unknown>; opts: unknown }[] = []
  const client = {
    from(table: string) {
      return {
        upsert(row: Record<string, unknown>, opts: unknown) {
          seen.push({ table, row, opts })
          return Promise.resolve({ error: null })
        },
      }
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, seen }
}

{
  const { client, seen } = stubSupabase()
  await recordSweep(client, 'autopay', { ok: true, ms: 120, requestId: 'iad1::abc', detected: 4, written: 2 })
  const w = seen[0]
  check('writes to automation_sweeps', w.table, 'automation_sweeps')
  // (job, ran_on) is the PK — this is what makes a same-day retry an UPDATE instead
  // of a duplicate row.
  check('upserts on the (job, ran_on) key', w.opts, { onConflict: 'job,ran_on' })
  check('job is the registry key', w.row.job, 'autopay')
  check('ok is carried', w.row.ok, true)
  check('counts are carried', [w.row.detected, w.row.written], [4, 2])
  check('a missing count is NULL, never 0', w.row.owners, null)
  check('request id is carried', w.row.request_id, 'iad1::abc')
  // ran_at MUST be set explicitly: the PK means a second run today UPDATEs, and a
  // column default only fires on INSERT — so without this the row would carry the
  // first run's timestamp beside the latest run's verdict.
  ok('ran_at is set explicitly, not left to the column default', typeof w.row.ran_at === 'string' && (w.row.ran_at as string).includes('T'))
  ok('ran_on is a bare date', typeof w.row.ran_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w.row.ran_on as string))
}

{
  const { client, seen } = stubSupabase()
  await recordSweep(client, 'signals', { ok: false, ms: 9, error: 'x'.repeat(500) })
  // The column is text but an unbounded provider error in a health table is a way to
  // turn a bad night into a bloated row.
  check('error is truncated to 200 chars', (seen[0].row.error as string).length, 200)
}

{
  // Recording a run must never BECOME the run's failure. A night's reminders that
  // went out are not allowed to report failure because their proof-of-life row
  // didn't land.
  const exploding = {
    from() { return { upsert() { throw new Error('table is gone') } } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  let threw = false
  try { await recordSweep(exploding, 'engine', { ok: true, ms: 1 }) } catch { threw = true }
  ok('a heartbeat write that THROWS is swallowed', !threw)

  const erroring = {
    from() { return { upsert: () => Promise.resolve({ error: { message: 'permission denied' } }) } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  let threw2 = false
  try { await recordSweep(erroring, 'engine', { ok: true, ms: 1 }) } catch { threw2 = true }
  ok('a heartbeat write that ERRORS is swallowed', !threw2)
}

// The counts helper maps a job's own nouns onto the shared columns.
check('counts() reads named fields', counts({ owners: 3, signals: 9, written: 9 }, 'owners', 'signals', 'written'),
  { owners: 3, detected: 9, written: 9 })
check('counts() nulls an absent field', counts({ sent: 2 }, undefined, 'chased', 'sent'),
  { owners: null, detected: null, written: 2 })
check('counts() refuses a non-number', counts({ sent: 'lots' }, undefined, undefined, 'sent'),
  { owners: null, detected: null, written: null })

// ════════════════════════════════════════════════════════════════════════════
H('2b. classifyCronHealth — is the scheduler actually working?')

// The freshness boundary is passed in, so these run identically on any day.
const CUT = '2026-08-11'
const all = Object.keys(CRON_JOBS) as CronJob[]
const fresh = (job: CronJob, ok = true, ran_on = '2026-08-12') => ({ job, ok, ran_on })
const everyJobHealthy = all.map(j => fresh(j))

{
  // TODAY'S PRODUCTION STATE: twelve declared jobs, an empty run log, no secret.
  // This must not read as healthy — it is the entire reason this lane exists.
  const v = classifyCronHealth([], { configured: false, freshCutoff: CUT })
  check('no secret + empty log → not operational', v.operational, false)
  check('…and every declared job is reported as never having run', v.neverRan.length, 12)
  check('…and the customer-facing ones are named', v.customerImpacting,
    ['autopay', 'campaigns', 'invoice-reminders', 'notifications', 'quote-followup', 'reports', 'scheduled-messages'])
}
{
  // The secret is the gate: even a perfect run log cannot make an unconfigured
  // scheduler operational — those rows would be history from before it broke.
  const v = classifyCronHealth(everyJobHealthy, { configured: false, freshCutoff: CUT })
  check('a healthy log but no secret → still not operational', v.operational, false)
  check('…with nothing wrongly blamed on the jobs', [v.neverRan, v.stale, v.failing], [[], [], []])
}
{
  const v = classifyCronHealth(everyJobHealthy, { configured: true, freshCutoff: CUT })
  check('every job fresh and successful → operational', v.operational, true)
  check('…and nothing is flagged', [v.neverRan, v.stale, v.failing, v.customerImpacting], [[], [], [], []])
}
{
  // A job whose latest run failed.
  const rows = everyJobHealthy.filter(r => r.job !== 'autopay').concat([fresh('autopay', false)])
  const v = classifyCronHealth(rows, { configured: true, freshCutoff: CUT })
  check('a failing job is named', v.failing, ['autopay'])
  check('…a failed run is not "fresh" — it is also stale', v.stale, ['autopay'])
  check('…the deploy is not operational', v.operational, false)
  check('…and it is flagged as customer-impacting', v.customerImpacting, ['autopay'])
}
{
  // Succeeded, but four days ago: the job stopped and nothing said so.
  const rows = everyJobHealthy.filter(r => r.job !== 'signals').concat([fresh('signals', true, '2026-08-08')])
  const v = classifyCronHealth(rows, { configured: true, freshCutoff: CUT })
  check('a job that stopped running is stale', v.stale, ['signals'])
  check('…but is NOT reported as failing (its last run worked)', v.failing, [])
  check('…and signals is internal, so nothing customer-facing is claimed', v.customerImpacting, [])
}
{
  // Failed last night, succeeded the night before — must NOT read as fresh, or a job
  // that breaks tonight looks fine for two more days.
  const rows = everyJobHealthy.filter(r => r.job !== 'reports')
    .concat([fresh('reports', true, '2026-08-12'), fresh('reports', false, '2026-08-13')])
  const v = classifyCronHealth(rows, { configured: true, freshCutoff: CUT })
  check('the LATEST row decides failing, not the best one', v.failing, ['reports'])
  check('…and a recent success still counts for freshness', v.stale, [])
}
{
  const v = classifyCronHealth([fresh('autopay')], { configured: true, freshCutoff: CUT })
  check('one job running does not vouch for the other eleven', v.neverRan.length, 11)
  check('…and declared is the registry size, not the row count', v.declared, 12)
}

// ════════════════════════════════════════════════════════════════════════════
H('3. Registry parity — vercel.json ↔ CRON_JOBS ↔ route files')

interface VercelCron { path: string; schedule: string }
const vercel = JSON.parse(read('vercel.json')) as { crons?: VercelCron[] }
const declared = vercel.crons ?? []
const registry = Object.keys(CRON_JOBS) as CronJob[]

ok('vercel.json declares at least one cron', declared.length > 0)

// Every declared path must be in the registry, or /api/health cannot know it should
// have run — a cron added to vercel.json alone is invisible to the health surface.
for (const c of declared) {
  const job = registry.find(j => CRON_JOBS[j] === c.path)
  ok(`vercel.json ${c.path} is registered in CRON_JOBS`, !!job,
    `add it to CRON_JOBS in src/lib/cron/heartbeat.ts, or /api/health will never notice it stopped`)
}
// …and the reverse, or health reports a job that can never run as permanently stale.
for (const job of registry) {
  ok(`CRON_JOBS.${job} is declared in vercel.json`, declared.some(c => c.path === CRON_JOBS[job]),
    `remove it from CRON_JOBS or add the schedule back — health will otherwise report it as never-ran forever`)
}
// …and the route has to exist on disk.
for (const job of registry) {
  ok(`${job} has a route file`, existsSync(join(ROOT, routePath(job))), routePath(job))
}
// The registry key IS the folder name — the heartbeat's `job` column and the route
// path must agree or a row can't be traced back to what wrote it.
for (const job of registry) {
  check(`CRON_JOBS.${job} path matches its key`, CRON_JOBS[job], `/api/cron/${job}`)
}
// Every customer-facing job is a real job.
for (const job of CUSTOMER_FACING_JOBS) {
  ok(`CUSTOMER_FACING_JOBS.${job} is a registered job`, registry.includes(job))
}

// ⚠️ Vercel HOBBY rejects ANY sub-daily cron AT DEPLOY TIME — and it fails the WHOLE
// deployment, not just that cron. This has caused two outages already (0b7f10f, then
// ed9dc44, where every main deploy failed for ~6 commits and nobody noticed because
// local build/tsc/verify all pass — the rejection happens only inside Vercel).
for (const c of declared) {
  const [min, hour, ...rest] = c.schedule.trim().split(/\s+/)
  ok(`${c.path} runs at most daily (${c.schedule})`,
    /^\d+$/.test(min) && /^\d+$/.test(hour) && rest.join(' ') === '* * *',
    `Hobby rejects sub-daily schedules and fails the ENTIRE deployment. Use "m h * * *".`)
}

// ════════════════════════════════════════════════════════════════════════════
H('4. Source invariants — one writer, one guard, honest health')

const routes = registry.map(job => ({ job, src: read(routePath(job)) }))

// ── Every cron files a heartbeat, under its own name ────────────────────────
for (const { job, src } of routes) {
  ok(`${job} exports GET through withCronSweep`, new RegExp(`export const GET = withCronSweep\\(\\s*'${job}'`).test(src),
    `wrap it: export const GET = withCronSweep('${job}', handler)`)
  // A leftover bare handler export would bypass the wrapper entirely while looking wired.
  ok(`${job} has no second, unwrapped GET export`, !/export\s+(async\s+function|const)\s+GET\b(?!\s*=\s*withCronSweep)/.test(src),
    `the handler must not also be exported as GET — the wrapper would be bypassed`)
}

// ── ONE heartbeat writer ───────────────────────────────────────────────────
// Three routes used to hand-roll this upsert with different shapes; integrations
// even keyed its day off UTC while the others used the server's local date, so two
// jobs could file the same night under different days.
// Matches the table ACCESS, not the word: four of these routes now explain in a
// comment where their old heartbeat went, and a guard that greps its own subject
// would report the cure as the disease.
{
  const offenders = routes.filter(r => r.src.includes("from('automation_sweeps')"))
  ok('no cron route writes automation_sweeps directly', offenders.length === 0,
    `${offenders.map(o => o.job).join(', ')} must go through lib/cron/heartbeat, the single writer`)
  ok('lib/cron/heartbeat is the writer', read('src/lib/cron/heartbeat.ts').includes("from('automation_sweeps')"))
}

// ── ONE auth guard ─────────────────────────────────────────────────────────
// campaigns and scheduled-messages used to re-type the token parsing and compare the
// secret with a plain `!==`, which leaks it a byte at a time through response timing.
for (const { job, src } of routes) {
  ok(`${job} authenticates via cronSecretOk`, /if \(!cronSecretOk\(req\)\)/.test(src),
    `use the shared guard — a hand-rolled compare is not constant-time`)
  ok(`${job} rejects with 403`, /!cronSecretOk\(req\)\) return NextResponse\.json\(\{ error: 'forbidden' \}, \{ status: 403 \}\)/.test(src))
  ok(`${job} does not read CRON_SECRET itself`, !src.includes('process.env.CRON_SECRET'),
    `the secret is compared in exactly one place: lib/cron/guard`)
}
ok('lib/cron/guard compares in constant time', read('src/lib/cron/guard.ts').includes('timingSafeEqual'))
// Fail CLOSED: an unconfigured deploy must reject everything rather than run open.
ok('cronSecretOk fails closed when CRON_SECRET is unset', /if \(!expected\) return false/.test(read('src/lib/cron/guard.ts')))

// ── Health must degrade on a dead scheduler ────────────────────────────────
// The bug: health reported `capabilities.cron: false` and still called itself "ok",
// so twelve declared-and-never-run jobs read as a clean bill for weeks.
{
  const health = read('src/app/api/health/route.ts')
  ok('health computes cron liveness', health.includes('cronHealth('))
  ok('health reads the shared registry', health.includes("from '@/lib/cron/heartbeat'"))
  // The decision must stay in the pinned pure function — a second copy inside the
  // route would drift from the one these tests actually exercise.
  ok('health delegates the verdict to classifyCronHealth', health.includes('classifyCronHealth('))
  // An unreadable run log must never be reported as a healthy one.
  ok('health treats an unreadable run log as not-operational', /operational: false, readable: false/.test(health))
  // Down is still reserved for the database. A dead cron must never page anyone.
  ok('a dead cron is degraded, never down', /const down = !checks\.database\.ok/.test(health))
  ok('health reports which jobs, not just a boolean', /^\s+crons,$/m.test(health))

  // ⚠️ The missing-secret rule landed separately (b4343036) and is pinned by
  // verify:health. Re-asserted here so THIS lane cannot quietly undo it while
  // adding the liveness half — the two answer different questions and the deploy
  // needs both.
  ok('the landed missing-secret rule survives',
    /const cronsDeclaredButUnusable = process\.env\.VERCEL_ENV === 'production' && !cron/.test(health),
    `verify:health pins this exact expression`)
  ok('…and still feeds degraded', /const degraded = [^\n]*cronsDeclaredButUnusable/.test(health))

  // The liveness half: a job that CAN authenticate and has quietly stopped.
  ok('health degrades when a working scheduler stops running jobs',
    /const degraded = [^\n]*cronsStopped/.test(health),
    `without this, health goes green the moment CRON_SECRET is set, whatever the crons then do`)
  // Only once the secret exists — otherwise "no secret" is the precise diagnosis and
  // every job trivially reads as never-run. Say the useful thing once.
  ok('…only once the secret exists, so the two signals never double-report',
    /cronsStopped = process\.env\.VERCEL_ENV === 'production' && cron && crons\.readable && !crons\.operational/.test(health))
}

// ── The money and comms crons keep their claim-before-send guards ───────────
// Each of these is the one line standing between an at-least-once scheduler and a
// customer being charged or messaged twice. Deleting one is silent at runtime.
{
  const src = (p: string) => read(p)
  ok('autopay dedupes on a deterministic payments key',
    src(routePath('autopay')).includes('attemptAutoPayCharge')
    && src('src/lib/payments/autopay.ts').includes("eq('stripe_session_id', `autopay:${invoiceId}`)"))
  ok('autopay sends a STABLE Stripe idempotency key on the automatic path',
    /if \(!opts\.manual\) return `autopay:\$\{opts\.invoiceId\}`/.test(src('src/lib/stripe/config.ts')),
    `a per-attempt key on the cron path would let a retry raise a second charge`)
  ok('invoice-reminders claims on the exact reminder_count it read',
    /\.eq\('id', inv\.id\)\.eq\('reminder_count', seen\)/.test(src(routePath('invoice-reminders'))))
  ok('quote-followup claims on the exact follow_up_count it read',
    /\.eq\('follow_up_count', seen\)/.test(src(routePath('quote-followup'))))
  ok('notifications reserves through the shared claimSend',
    src(routePath('notifications')).includes('claimSend(supabase, j.user_id, claimKey'))
  ok('campaigns claims a crm_campaign_log row before sending',
    src(routePath('campaigns')).includes("from('crm_campaign_log').insert"))
  ok('scheduled-messages claims pending → sending',
    /\.eq\('id', row\.id\)\.eq\('status', 'pending'\)/.test(src(routePath('scheduled-messages'))))
  // The one that was missing: reports read last_period_to, sent, then advanced it
  // unconditionally — so two overlapping runs both emailed the same period.
  ok('reports claims the period BEFORE sending (compare-and-swap)',
    /claim\.eq\('last_period_to', row\.last_period_to\)/.test(src(routePath('reports'))),
    `without the CAS, an at-least-once retry emails the owner the same report twice`)
  ok('reports handles a never-yet-sent schedule with .is(null)',
    /claim\.is\('last_period_to', null\)/.test(src(routePath('reports'))),
    `PostgREST renders .eq(col, null) as "col = null", which never matches`)
  ok('reports releases the period when the mail did not go out',
    /const release = async/.test(src(routePath('reports'))))
}

}

main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} verify:cron — ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
})
