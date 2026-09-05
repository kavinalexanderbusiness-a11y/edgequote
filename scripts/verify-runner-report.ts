// ── Verify: the suite runner's own end-of-run report ────────────────────────
//   npm run verify:runner-report
//
// WHY THIS SCRIPT EXISTS
// The runner reports on 157 guards and, until this change, reported on itself
// badly in two ways that both hid work from the reader:
//
//   1. Any failure exited inside the failure branch, BEFORE the could-not-run
//      list and before any totals. A real run printed "✗ 1/157 FAILED" and
//      nothing else — `verify:schema` had not run at all and the console never
//      said so. The reader then reconstructed the pass count from an earlier
//      prediction and published 156 + 1 + 1 against a total of 157.
//   2. A guard that PASSED having skipped its live half was counted as a plain
//      pass and said so nowhere, because child stdout is shown only on failure.
//
// ⭐ FOUR FAKE CHILDREN, SPAWNED THE SAME WAY THE RUNNER SPAWNS REAL ONES — pass,
// partial-skip, exit-2 and failure, together in one run, because "together" is
// the case that broke: it takes a failure present to hide the skip list.
//
// ⛔ It does not run the real suite, touch a real guard, or need any env.

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { summarize, skipReason, partialSkipNotice, type Failure, type Unrunnable, type Notice } from './lib/verify-summary'

let pass = 0, fail = 0
const H = (t: string) => console.log(`\n═══ ${t} ═══`)
const ok = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}`) }
  else { fail++; console.log(`  ❌ ${n}${d ? `\n     ${d}` : ''}`) }
}

// ── The fake children ───────────────────────────────────────────────────────
const CHILDREN: Record<string, string> = {
  'zz-pass': `console.log('  ✓ everything checked'); process.exit(0)`,
  'zz-partial': `console.log('  ✓ offline half checked'); console.log('  ⏭ live half skipped — no credentials'); process.exit(0)`,
  'zz-unrunnable': `console.log('SKIPPED — no credentials, so production was never contacted'); process.exit(2)`,
  'zz-fail': `console.log('  ✗ a real check broke'); process.exit(1)`,
}

const dir = mkdtempSync(join(tmpdir(), 'zz-runner-'))
const failures: Failure[] = []
const unrunnable: Unrunnable[] = []
const notices: Notice[] = []
let passed = 0

try {
  H('1. four children, classified exactly as the runner classifies them')
  for (const [name, body] of Object.entries(CHILDREN)) {
    const file = join(dir, `${name}.ts`)
    writeFileSync(file, body)
    const r = spawnSync(process.execPath, [require.resolve('tsx/cli'), file], { encoding: 'utf8' })
    const out = r.stdout ?? ''
    if (r.status === 2) { unrunnable.push({ domain: name, why: skipReason(out) }) }
    else if (r.status === 0) {
      passed++
      const note = partialSkipNotice(out)
      if (note) notices.push({ domain: name, note })
    } else { failures.push({ domain: name, code: r.status, output: out }) }
  }
  ok('two children passed', passed === 2, `passed=${passed}`)
  ok('one failed', failures.length === 1, `failures=${failures.length}`)
  ok('one could not run (exit 2)', unrunnable.length === 1)
  ok('⭐ the partial-skip notice was captured from a PASSING child', notices.length === 1)
  ok('…and it is the child\'s own line', /live half skipped/.test(notices[0]?.note ?? ''))

  // ── The report, with a failure present — the case that used to hide things ─
  H('2. ⛔ with a failure present, the report is still COMPLETE')
  const lines: string[] = []
  const code = summarize({
    total: 4, failures, unrunnable, notices, seconds: '0.1',
    out: l => lines.push(l), err: l => lines.push(l),
  })
  const text = lines.join('\n')

  ok('exit code is 1 (a failure is present)', code === 1)
  ok('the failure detail is still shown', /zz-fail/.test(text) && /a real check broke/.test(text))
  ok('⭐ passed count is printed', /passed\s+2/.test(text))
  ok('⭐ failed count is printed', /failed\s+1/.test(text))
  ok('⭐⭐ the could-not-run guard is LISTED despite the failure', /zz-unrunnable/.test(text))
  ok('…with its reason', /production was never contacted/.test(text))
  ok('…and the total is printed', /total\s+4/.test(text))
  ok('⭐ the partial skip is surfaced', /live half skipped/.test(text))
  ok('…and is NOT counted as a fourth category', !/passed\s+3/.test(text) && !/passed\s+1\b/.test(text))
  ok('⛔ the counts are non-overlapping and sum to the total',
    !/SUMMARY INCONSISTENT/.test(text))

  // [negative control] the old behaviour is what this replaces: prove the
  // assertion above would fail if the list were omitted.
  const withoutList = text.replace(/zz-unrunnable/g, '')
  ok('[negative control] the could-not-run assertion is discriminating',
    !/zz-unrunnable/.test(withoutList))

  // ── And with no failure, the same report still prints ─────────────────────
  H('3. with NO failure, the report is unchanged in shape and exits 0')
  const lines2: string[] = []
  const code2 = summarize({
    total: 3, failures: [], unrunnable, notices, seconds: '0.1',
    out: l => lines2.push(l), err: l => lines2.push(l),
  })
  const text2 = lines2.join('\n')
  ok('exit code is 0 (nothing failed)', code2 === 0)
  ok('the could-not-run guard is still listed', /zz-unrunnable/.test(text2))
  ok('the partial skip is still surfaced', /live half skipped/.test(text2))
  ok('and the green headline still prints', /verify suites passed/.test(text2))

  // ── The notice detector must not fire on prose ────────────────────────────
  H('4. the notice detector reports a guard\'s notice, not its vocabulary')
  ok('a real notice line is picked up', partialSkipNotice('  ⏭ live half skipped — no creds') !== null)
  ok('[negative control] a check NAMED about skipping is not a notice',
    partialSkipNotice('  ✓ a cancelled visit is skipped by the planner') === null)
  ok('[negative control] silence yields nothing', partialSkipNotice('  ✓ all good') === null)
  // ── WIRING: the runner must actually USE this reporter ───────────────────
  // Sections 1–4 prove the reporter. This proves the RUNNER routes through it,
  // so reverting verify-all.ts to its old inline tail fails here.
  H('5. the runner reports through this module')
  const runner = readFileSync(join(__dirname, 'verify-all.ts'), 'utf8')
  ok('verify-all imports the shared reporter',
    /from '\.\/lib\/verify-summary'/.test(runner))
  ok('⭐ its run exits THROUGH the summary, so the report cannot be skipped',
    /process\.exit\(summarize\(/.test(runner))
  ok('⛔ the old tail that exited before the summary is gone',
    !/const ran = fileDomains\.length/.test(runner))
  ok('⛔ …and its inline could-not-run block is gone too',
    !/suite\(s\) COULD NOT RUN/.test(runner))

} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
if (fail) { console.log(`✗ runner-report: ${fail} check(s) failed (${pass} held)\n`); process.exit(1) }
console.log(`✓ runner-report: the summary is complete, non-overlapping and honest (${pass} checks)\n`)
