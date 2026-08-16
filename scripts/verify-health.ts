// ── verify-health — the deploy's self-report cannot say "ok" while it is not ──
//
//   npm run verify:health
//
// WHY THIS EXISTS
// /api/health opens by stating its own first design rule: "It must FAIL when the
// app is broken. A health check that always returns 200 is worse than none: it
// converts an outage into a silent one."
//
// It then broke that rule in one specific, expensive way. vercel.json DECLARES
// twelve scheduled jobs. lib/cron/guard's cronSecretOk() opens with
// `if (!expected) return false` — so when CRON_SECRET is absent, every one of
// those twelve is rejected 403 on every run: invoice reminders, quote
// follow-ups, AutoPay charges, scheduled reports. Measured in production on
// 2026-08-11: all four probed cron routes returned 403/401, `automation_runs`
// held zero rows lifetime, and /api/health answered `"status":"ok"` with
// `cron:false` sitting in the same body.
//
// A capability being off is not an outage — email and SMS legitimately report
// false on a deploy that never configured them, and this guard must not force
// those to degrade. The distinction is DECLARED vs OPTIONAL: nothing in the repo
// asserts that SMS must exist, but vercel.json asserts that these crons run.
//
// Pure and deterministic: the decision is re-implemented here from the route's
// own source so the guard pins the RULE, not a running server.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
let pass = 0
let fail = 0

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}
function H(t: string) { console.log(`\n═══ ${t} ═══`) }

const health = readFileSync(join(ROOT, 'src/app/api/health/route.ts'), 'utf8')
const guard = readFileSync(join(ROOT, 'src/lib/cron/guard.ts'), 'utf8')
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as { crons?: { path: string }[] }

// ═══════════════════════════════════════════════════════════════════════════
H('1. THE PREMISE — crons are declared, and they fail closed without the secret')

const cronCount = vercel.crons?.length ?? 0
check('vercel.json declares scheduled jobs', cronCount > 0, true)

// The guard must fail CLOSED on a missing secret. If this ever flips to
// fail-open, the health rule below is not the interesting problem any more —
// an unconfigured deploy would be triggerable by a stranger.
check('cronSecretOk refuses when CRON_SECRET is unset (fails closed)',
  /if\s*\(\s*!\s*expected\s*\)\s*return\s+false/.test(guard), true)

// ═══════════════════════════════════════════════════════════════════════════
H('2. THE RULE — a production deploy with no CRON_SECRET is DEGRADED')

check('health computes a cron-gap signal',
  /cronsDeclaredButUnusable/.test(health), true)

check('the signal is production-scoped (a local run must not cry wolf)',
  /cronsDeclaredButUnusable\s*=\s*process\.env\.VERCEL_ENV\s*===\s*'production'\s*&&\s*!cron/.test(health), true)

check('the cron gap feeds `degraded`',
  /const\s+degraded\s*=[^\n]*cronsDeclaredButUnusable/.test(health), true)

check('the body names the consequence, not just the missing var',
  /cron_warning/.test(health) && /403/.test(health), true)

// ═══════════════════════════════════════════════════════════════════════════
H('3. THE DECISION TABLE — re-implemented from the route, driven through every state')

// Mirrors the route: down is database-only; degraded collects the config gaps.
function statusFor(s: {
  dbOk: boolean; configOk: boolean; vercelEnv?: string
  stripeSecret?: boolean; stripeWebhook?: boolean; cronSecret?: boolean
}): 'down' | 'degraded' | 'ok' {
  const cron = !!s.cronSecret
  const stripeKeyOnly = !!s.stripeSecret && !s.stripeWebhook
  const cronsDeclaredButUnusable = s.vercelEnv === 'production' && !cron
  if (!s.dbOk) return 'down'
  if (!s.configOk || stripeKeyOnly || cronsDeclaredButUnusable) return 'degraded'
  return 'ok'
}

const PROD = { dbOk: true, configOk: true, vercelEnv: 'production', stripeSecret: true, stripeWebhook: true, cronSecret: true }

check('a fully configured production deploy is ok', statusFor(PROD), 'ok')

// THE REGRESSION. This is production's exact shape on 2026-08-11.
check('production WITHOUT CRON_SECRET is degraded, never ok',
  statusFor({ ...PROD, cronSecret: false }), 'degraded')

check('local dev without CRON_SECRET stays ok (no scheduler to be broken)',
  statusFor({ ...PROD, vercelEnv: undefined, cronSecret: false }), 'ok')

check('preview without CRON_SECRET stays ok (crons run on production only)',
  statusFor({ ...PROD, vercelEnv: 'preview', cronSecret: false }), 'ok')

// The pre-existing rules must survive unchanged.
check('half-configured Stripe is still degraded',
  statusFor({ ...PROD, stripeWebhook: false }), 'degraded')

check('a dead database still outranks every other signal',
  statusFor({ ...PROD, dbOk: false, cronSecret: false }), 'down')

check('missing core config is still degraded',
  statusFor({ ...PROD, configOk: false }), 'degraded')

// Capabilities that are genuinely OPTIONAL must never degrade a deploy — the
// guard would be worse than useless if it turned "no SMS configured" into a
// permanent yellow that everyone learns to ignore.
check('no email/SMS configured does NOT degrade (optional, not declared)',
  statusFor(PROD), 'ok')

// ═══════════════════════════════════════════════════════════════════════════
H('4. THE LINK ORIGIN — the deploy must report the origin it stamps into links')

// 2026-08-15: the production domain moved to app.edgehq.ca but Vercel's
// NEXT_PUBLIC_APP_URL still held the old host — so every crew-invite and
// password-reset email carried a link that 404'd, and nothing observable said
// so. The env var cannot be asserted from here; what CAN be pinned is that
// /api/health reports it, so one curl against a deploy answers "which origin do
// generated links use?" instead of a worker's screenshot being the detector.
// 2026-08-15, the sequel: the env var was updated for the new domain and arrived
// with a UTF-8 BOM in front of it. Reporting the RAW value was what made that
// findable — but only to an eye that noticed an invisible character in JSON. So
// the origin is now normalized in lib/appOrigin and health reports the origin
// links ACTUALLY use, plus a warning when the stored value needed repair.
check('health reports the app origin it actually stamps into links',
  /app_url:\s*appOrigin\.origin/.test(health), true)
check('health warns when the configured origin had to be sanitized',
  /appOrigin\.sanitized/.test(health) && /app_url_warning/.test(health), true)
// The degrade is the point: a configured-but-unusable origin means every emailed
// link, Stripe return URL and signature-checked webhook URL is built on sand.
check('a configured-but-unusable app origin degrades the deploy',
  /appOriginUnusable/.test(health) && /degraded\s*=[^\n]*appOriginUnusable/.test(health), true)

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} verify:health — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
