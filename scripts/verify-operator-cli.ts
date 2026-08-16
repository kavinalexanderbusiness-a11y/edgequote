// ── Operator CLI auth — npm run verify:operator-cli ─────────────────────────
//
// THE invariant this pins: minting a beta invite goes through the real operator
// login, asks for the password rather than reading one off disk, never echoes it,
// and fails with a sentence a human can act on.
//
// The incident it was written for (2026-08-16): `npm run beta:invite -- create`
// answered "Sign-in failed: Invalid login credentials" while the same operator
// could sign in through the browser. Three things made that hard to read:
//
//   1. The password lived in .env.local and had been ROTATED hours earlier. The
//      file cannot know that. Diagnosed from auth.users: updated_at (07:33Z) was
//      later than last_sign_in_at (04:11Z) — the signature of a password change.
//   2. Nothing was mangled, but the parser was the natural suspect, so the real
//      cause was easy to miss. This guard removes the suspicion by removing the
//      file from the auth path entirely.
//   3. Node 24 on Windows then aborted with a libuv assertion AFTER the failure,
//      which reads like the crash caused it. It did not — process.exit() ran
//      while undici still held a pooled socket.
//
// ⚠️ NO REAL CREDENTIALS APPEAR HERE. The behavioural half drives the CLI with a
// deliberately invalid account on an .invalid TLD, which can never resolve to a
// real user, and asserts only on the SHAPE of the failure.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = join(__dirname, '..')
const CLI = join(ROOT, 'scripts', 'beta-invite.ts')
const src = readFileSync(CLI, 'utf8')

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`) }
}

// Strip line comments: this file explains the incident at length, and a comment
// naming a symbol is not the symbol being used.
const code = src.split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')

// ═══════════════════════════════════════════════════════════════════════════
H('1. THE PASSWORD DOES NOT COME FROM A FILE')

ok('the real environment is snapshotted BEFORE .env.local is merged',
  /const REAL_ENV = \{[\s\S]{0,200}?\}/.test(code)
  && code.indexOf('const REAL_ENV') < code.indexOf('loadEnvLocal()'),
  'a .env.local password must be indistinguishable from a deliberate export only if it is read first — it must not be')
// The password may be read from process.env EXACTLY ONCE — in the snapshot, before
// loadEnvLocal(). Any read after that point is reading the file, which is the whole
// failure mode. So this is positional, not a blanket ban.
{
  const merge = code.indexOf('loadEnvLocal()')
  const reads = [...code.matchAll(/process\.env\.PORTAL_RPC_OWNER_PASSWORD/g)].map(m => m.index ?? -1)
  ok('the password is read from process.env only BEFORE .env.local is merged',
    reads.length > 0 && reads.every(i => i < merge),
    `reads at ${JSON.stringify(reads)}, merge at ${merge}`)
  ok('the auth call takes the password from the snapshot',
    /REAL_ENV\.password/.test(code))
}
ok('the CLI no longer refuses outright when the file has no password',
  !/Missing PORTAL_RPC_OWNER_EMAIL \/ _PASSWORD in \.env\.local/.test(code))

// ═══════════════════════════════════════════════════════════════════════════
H('2. THE PROMPT')

ok('there is a hidden-input prompt', /function promptHidden/.test(code))
ok('it suppresses the echo of what is typed', /_writeToOutput/.test(code),
  'without this the password lands in the terminal scrollback and shell history')
ok('the prompt is the fallback when the environment is not set',
  /await promptHidden\(/.test(code))
ok('a non-interactive run explains itself instead of hanging',
  /process\.stdin\.isTTY/.test(code) && /OperatorError/.test(code))
ok('the password reference is dropped after it is used',
  /creds\.password = ''/.test(code))

// ═══════════════════════════════════════════════════════════════════════════
H('3. THE AUTHORISATION PATH IS THE REAL ONE')

ok('it authenticates with the anon key through signInWithPassword',
  /signInWithPassword/.test(code) && /createClient\(URL, ANON/.test(code))
ok('it mints through the operator RPC, never a direct table write',
  /rpc\('create_beta_invite'/.test(code) && !/from\('beta_invites'\)/.test(code))
ok('it checks platform_operators and says so in plain words',
  /platform_operators/.test(code) && /not a platform operator/.test(code))
ok('it does NOT use the service role key',
  !/SERVICE_ROLE/.test(code),
  'the operator gate is the point; a service key would walk around it')

// ═══════════════════════════════════════════════════════════════════════════
H('4. THE INVITE URL POINTS AT THE LIVE HOST')

ok('the fallback host is the current one',
  /https:\/\/app\.edgehq\.ca/.test(code))
ok('the retired host is gone',
  !/edgepropertyservicesyyc/.test(code),
  'that domain now answers DEPLOYMENT_NOT_FOUND — an invite built on it is a dead link')
ok('the configured origin is cleaned through lib/appOrigin',
  /cleanOrigin\(process\.env\.NEXT_PUBLIC_APP_URL\)/.test(code))

// ═══════════════════════════════════════════════════════════════════════════
H('5. IT EXITS CLEANLY — the crash that masked the real error')

// The teardown lives in scripts/lib/shutdown.ts — one copy, because three
// scripts hit this same crash. Assert the CLI uses it, and that the helper still
// does the two things that matter.
const shutdownSrc = readFileSync(join(ROOT, 'scripts', 'lib', 'shutdown.ts'), 'utf8')
ok('the CLI ends through the shared endProcess helper',
  /import \{ endProcess \} from '\.\/lib\/shutdown'/.test(code) && /endProcess\(/.test(code))
ok('the helper closes the HTTP pool', /undici\.globalDispatcher/.test(shutdownSrc))
ok('the helper sets exitCode rather than forcing process.exit()',
  /process\.exitCode = code/.test(shutdownSrc)
  && /setTimeout\(\(\) => process\.exit\(code\), graceMs\)\.unref\(\)/.test(shutdownSrc),
  'the forced exit must remain an unref\'d backstop, never the normal path')
ok('the CLI no longer calls process.exit() on the success path',
  !/\.then\(code => process\.exit/.test(code))
ok('token auto-refresh is off (a one-shot CLI needs no refresh timer)',
  /autoRefreshToken: false/.test(code))

// The behavioural half. Deliberately invalid account on a reserved TLD.
const run = spawnSync(process.execPath, [
  join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), CLI, 'list',
], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 120_000,
  env: {
    ...process.env,
    PORTAL_RPC_OWNER_EMAIL: 's75-nonexistent-probe@example.invalid',
    PORTAL_RPC_OWNER_PASSWORD: 'deliberately-not-a-real-password',
  },
})
const out = `${run.stdout ?? ''}${run.stderr ?? ''}`

if (/Cannot find module/i.test(out)) {
  // Do not report green because the harness could not start.
  ok('the CLI could be launched for the behavioural check', false, out.slice(0, 200))
} else {
  ok('a rejected sign-in exits non-zero', run.status === 1, `exit was ${run.status}`)
  ok('…and says the server rejected the pair, not that parsing failed',
    /Invalid login credentials/.test(out) && /not a parsing problem/.test(out))
  ok('…and names the project it tried, so a wrong-project run is visible',
    /Project: https:\/\//.test(out))
  ok('…and does NOT abort with the libuv assertion',
    !/Assertion failed/.test(out),
    'the crash returns the moment process.exit() runs before the pool is closed')
  ok('…and never prints the password it was given',
    !/deliberately-not-a-real-password/.test(out))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} verify:operator-cli — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
