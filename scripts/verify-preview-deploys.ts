// ── verify:preview-deploys — the automatic-deployment rule can never stop production
//
//   npm run verify:preview-deploys
//
// WHY THIS EXISTS
// `vercel.json` now carries a `git.deploymentEnabled` rule so that pushing a
// per-session work branch does not spend a full Next.js build on a preview
// nobody asked for. The argument is Vercel's DOCUMENTED behaviour, not a count:
// "Vercel allows for automatic deployments on every branch push", and "every
// preview branch automatically receives its own domain ... whenever a commit is
// pushed to it". The great majority of this repo's branches are per-session work
// branches, and review here happens by reading a diff at an exact SHA.
//
// ⛔ NO BUILD COUNT IS CLAIMED, here or in the report. Git holds no push
// telemetry — `%(committerdate)` records when a commit was made, not when it was
// pushed; a rebase rewrites it, an old tip can be pushed today, and several
// pushes to one branch collapse into one tip. Any "N builds" derived from branch
// tips would be a fabrication dressed as a measurement.
//
// ⛔ AND "nothing consumes previews" WOULD BE FALSE. What is true is narrower:
// no AUTOMATED GATE consumes them — ci.yml triggers on `push: [main]`,
// `pull_request` and `workflow_dispatch`, never on a bare branch push. Previews
// are a supported surface: `src/lib/canonicalHost.ts` exempts every
// `*.vercel.app` host from the canonical redirect, and docs/GOOGLE-OAUTH-SETUP.md
// records why — "there the hostname *is* the deployment; redirecting a preview to
// production deletes the preview". That is the counterweight, and it is why this
// rule is scoped to `session*/**` instead of turning previews off.
//
// ⛔⛔ THE HAZARD THIS PINS IS NOT THE SAVING — IT IS THE BLAST RADIUS.
// The same key that turns previews off can turn PRODUCTION off. Two shapes do it:
//   "deploymentEnabled": false          — every branch, main included
//   "deploymentEnabled": { "*": false } — a catch-all that main matches
// Either one is a one-line edit away, silent, and would not be noticed until a
// merge to main failed to ship.
//
// ⭐ WHAT MAKES MAIN SAFE, and it is not "no pattern happens to match it".
// Vercel's documented resolution is: an unspecified branch defaults to true, and
// "if a branch matches multiple rules and at least one rule is `true`, a
// deployment will occur." So an EXPLICIT `"main": true` outranks any false rule
// that could ever be added beside it — including a catch-all. The pin is the
// safety property; this guard exists to keep the pin.
//
// ⭐ Offline and static: it reads two files in this repo. No Vercel API, no
// token, no deployment, no network.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const H = (t: string) => console.log(`\n── ${t} ──\n`)

const cfgRaw = readFileSync(join(ROOT, 'vercel.json'), 'utf8')
const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n')

H('1 · the file still parses, and still carries the crons')

let cfg: Record<string, unknown> = {}
let parsed = true
try { cfg = JSON.parse(cfgRaw) } catch { parsed = false }
check('vercel.json is valid JSON', parsed, 'a malformed file is ignored — the rule would silently not apply')
check('the 12 cron jobs are still declared',
  Array.isArray(cfg.crons) && (cfg.crons as unknown[]).length === 12,
  `found ${Array.isArray(cfg.crons) ? (cfg.crons as unknown[]).length : 'none'} — the deployment rule must not be collateral damage`)

H('2 · ⛔ production can never be switched off by this rule')

const git = cfg.git as { deploymentEnabled?: unknown } | undefined
const rules = git?.deploymentEnabled

check('⛔ deploymentEnabled is an OBJECT, never a bare boolean',
  typeof rules === 'object' && rules !== null,
  '`"deploymentEnabled": false` disables EVERY branch, main included')

const map = (typeof rules === 'object' && rules !== null ? rules : {}) as Record<string, unknown>

// The production branch is whatever CI treats as production. Read it rather than
// assume it, so the two files cannot drift apart.
const prodBranch = /push:\s*\n\s*branches:\s*\[([^\]]+)\]/.exec(ci)?.[1]?.trim().replace(/['"]/g, '')
check('the production branch is read from CI, not assumed here',
  prodBranch === 'main', `ci.yml says ${JSON.stringify(prodBranch)}`)

check(`⛔ "${prodBranch}" is pinned EXPLICITLY true`,
  map[prodBranch as string] === true,
  'an explicit true outranks any false rule beside it — that is the whole safety argument')

check('⛔ no catch-all pattern is present',
  !Object.keys(map).some(k => k === '*' || k === '**' || k === '*/**'),
  'a catch-all is the shape that reaches main if the pin is ever dropped')

check('every rule value is a boolean',
  Object.values(map).every(v => typeof v === 'boolean'),
  'Vercel reads these as booleans; a string is truthy-looking and means nothing')

H('3 · the rule actually saves something (no dead safety)')

const off = Object.entries(map).filter(([, v]) => v === false).map(([k]) => k)
check('at least one pattern is disabled',
  off.length > 0,
  'a rule set with nothing turned off claims a saving it does not make')
check('[negative control] disabling is scoped, not global',
  off.length > 0 && off.every(k => k.includes('/')),
  `patterns without a "/" can match a top-level branch name: ${off.filter(k => !k.includes('/')).join(', ')}`)

console.log(fail === 0
  ? `\n✓ preview-deploys: ${pass} checks passed — production pinned, ${off.length} pattern(s) opted out\n`
  : `\n✗ preview-deploys: ${fail} failed, ${pass} passed\n`)
process.exit(fail === 0 ? 0 : 1)
