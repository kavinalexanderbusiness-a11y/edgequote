// ── The fixture's dev server, started with a SCRUBBED environment ────────────
//   node scripts/s122-fixture-serve.mjs [port]
//
// ⛔⛔ WHY NOT `npm run dev`. A dev server inherits the shell it was started
// from. If that shell ever held a real `SUPABASE_SERVICE_ROLE_KEY`, a Stripe
// secret, or a production URL, the fixture's server would hold it too — and
// `src/middleware.ts` runs on EVERY request and constructs a Supabase client from
// `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY`. A fixture that reaches a real auth
// server is not an offline fixture, whatever its page says.
//
// So this starts Next with an env built from an ALLOWLIST — nothing is inherited
// that is not named — and points the only two variables the middleware reads at a
// synthetic, closed local port. Any auth attempt therefore fails instantly,
// locally, against nothing, with no credential in the process to leak.
//
// ⛔ It also REFUSES to start if a .env.local exists in this worktree, because
// Next loads that file itself and the scrub above could not see it. Absent or
// synthetic — never real.
//
// ⛔ Binds 127.0.0.1 only. No other machine can reach this server.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] || 3000)

// ── 1 · Nothing real may be on disk where Next will find it ─────────────────
for (const f of ['.env.local', '.env.development.local', '.env.production.local', '.env']) {
  if (existsSync(join(ROOT, f))) {
    console.error(`✗ REFUSING TO START: ${f} exists in this worktree.`)
    console.error('  Next loads it before any scrub here can apply, so the fixture could not')
    console.error('  honestly claim it holds no real credential. Move it aside and re-run.')
    process.exit(2)
  }
}

// ── 2 · An allowlisted environment, not a filtered one ──────────────────────
// ⚠️ A denylist is the wrong shape: it has to predict every secret name anyone
// will ever add. This names what Node and Next genuinely need and drops the rest,
// so a new secret in the parent shell is excluded by default rather than by luck.
const ALLOW = [
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'PATHEXT',
]
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ALLOW.includes(k)))

env.NODE_ENV = 'development'
env.S122_FIXTURE = '1'
// ⭐ SYNTHETIC AND INVALID BY CONSTRUCTION. Port 1 is not listenable by an
// ordinary process, so an auth call cannot succeed, cannot leave the machine, and
// cannot reach anything real — while still letting the middleware build its
// client and take its `unavailable` branch, which is the path production takes
// when the auth server cannot be reached.
env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:1'
env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'zz-synthetic-invalid-anon-key'
// ⛔ Deliberately ABSENT: SERVICE_ROLE, every Stripe key, every provider token.
// Their absence is what makes the api routes inert, and the fixture never calls
// one anyway (its transport refuses).

const dropped = Object.keys(process.env).filter(k => !(k in env))
const sensitive = dropped.filter(k => /SUPABASE|STRIPE|SECRET|KEY|TOKEN|TWILIO|RESEND|SENDGRID|GOOGLE|VERCEL|DATABASE|POSTGRES|AWS|OPENAI|ANTHROPIC/i.test(k))

const sha = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim() }
  catch { return 'unknown' }
})()
const productSha = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: ROOT }).toString().trim() }
  catch { return 'unknown' }
})()

console.log('── S122 fixture server ──────────────────────────────────────────')
console.log(`  fixture SHA : ${sha}`)
console.log(`  product SHA : ${productSha}   (the parent commit this fixture proves)`)
console.log(`  bind        : 127.0.0.1:${PORT}  (localhost only)`)
console.log(`  env kept    : ${Object.keys(env).sort().join(', ')}`)
console.log(`  env dropped : ${dropped.length} vars, of which ${sensitive.length} matched a secret-ish name`)
if (sensitive.length) console.log(`                ${sensitive.sort().join(', ')}`)
console.log(`  supabase    : ${env.NEXT_PUBLIC_SUPABASE_URL} (synthetic, closed port — no live auth call is possible)`)
console.log('  ⛔ no .env.local present · no service role · no Stripe key · no session')
console.log('─────────────────────────────────────────────────────────────────')

const next = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
if (!existsSync(next)) {
  console.error(`✗ next binary not found at ${next}`)
  process.exit(2)
}
const child = spawn(process.execPath, [next, 'dev', '--hostname', '127.0.0.1', '--port', String(PORT)], {
  cwd: ROOT, env, stdio: 'inherit',
})
const stop = () => { try { child.kill() } catch { /* already gone */ } }
process.on('SIGINT', () => { stop(); process.exit(0) })
process.on('SIGTERM', () => { stop(); process.exit(0) })
child.on('exit', c => process.exit(c ?? 0))

