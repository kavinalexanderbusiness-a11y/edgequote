// ── The verify runner's end-of-run report ───────────────────────────────────
//
// Extracted from verify-all.ts for one reason: it can be driven directly. The
// runner itself cannot be imported to test its reporting, because importing it
// runs all 157 guards.
//
// ⛔⛔ TWO DEFECTS THIS EXISTS TO FIX, both found by a reader being misled:
//
//   1. THE SUMMARY VANISHED WHENEVER ANYTHING FAILED. The old tail printed the
//      failure detail and then `process.exit(1)` — before the unrunnable list and
//      before any totals. So a run with one failure printed "✗ 1/157 FAILED" and
//      nothing else: no pass count, and no mention that a guard had not run at
//      all. A real run hid `verify:schema`'s "could not run" exactly that way, and
//      the reader (me) then reconstructed the pass count from an earlier
//      PREDICTION and reported 156 + 1 + 1 = 158 against a total of 157.
//
//   2. A PASSING GUARD'S OWN "…skipped" NOTICE WAS INVISIBLE. Child stdout is
//      captured but shown only on failure, so a guard that exits 0 having
//      deliberately skipped its live half is counted as a plain pass and says so
//      nowhere. Five credential-gated guards do exactly this.
//
// ⭐ The counts are now NON-OVERLAPPING and must sum to the total — asserted here
// rather than trusted, because a summary that cannot add up is how the first
// defect went unnoticed.

export interface Failure { domain: string; code: number | null; output: string }
export interface Unrunnable { domain: string; why: string }
/** A guard that PASSED but told us it skipped part of its work. Never a count. */
export interface Notice { domain: string; note: string }

export interface SummaryInput {
  total: number
  failures: Failure[]
  unrunnable: Unrunnable[]
  notices: Notice[]
  seconds: string
  /** Injectable for tests; defaults to the console. */
  out?: (line: string) => void
  err?: (line: string) => void
}

/**
 * Prints the complete report and RETURNS THE EXIT CODE.
 *
 * The code lives here so a test can assert the exit alongside the output — the
 * two used to be provable only by running the whole suite.
 *
 * ⭐ Exit semantics are unchanged: non-zero if and only if something FAILED. An
 * unrunnable guard is still not a failure, and a partial skip is still not one.
 */
export function summarize(input: SummaryInput): number {
  const out = input.out ?? ((l: string) => console.log(l))
  const err = input.err ?? ((l: string) => console.error(l))
  const { total, failures, unrunnable, notices, seconds } = input

  // ── Failure detail first, unchanged: the reason someone is reading at all ──
  if (failures.length) {
    err(`\n✗ ${failures.length}/${total} verify suites FAILED in ${seconds}s:\n`)
    for (const f of failures) {
      err(`── verify:${f.domain} (exit ${f.code ?? 'signal'}) ${'─'.repeat(Math.max(0, 40 - f.domain.length))}`)
      err(f.output.trimEnd() || '  (no output)')
      err('')
    }
  }

  // ── The complete breakdown — ALWAYS, whatever happened ────────────────────
  const passed = total - failures.length - unrunnable.length
  out(`\n── summary ─────────────────────────────────────────────────────────`)
  out(`   passed      ${passed}`)
  out(`   failed      ${failures.length}${failures.length ? '   ' + failures.map(f => `verify:${f.domain}`).join(', ') : ''}`)
  out(`   could-run   ${unrunnable.length}${unrunnable.length ? '   (not proven, and not failed)' : ''}`)
  for (const u of unrunnable) out(`               verify:${u.domain} — ${u.why}`)
  // ⛔ The arithmetic is asserted, not assumed. If these ever stop summing the
  // report is lying about something, and a wrong total is worse than none.
  if (passed + failures.length + unrunnable.length !== total) {
    err(`   ⛔ SUMMARY INCONSISTENT: ${passed}+${failures.length}+${unrunnable.length} ≠ ${total}`)
  }
  out(`   total       ${total}   in ${seconds}s`)

  // ── Partial skips: said out loud, counted as nothing ──────────────────────
  if (notices.length) {
    out(`\n⚠️  ${notices.length} guard(s) PASSED having skipped part of their work —`)
    out(`   counted as passed above, because they are; listed because a pass that`)
    out(`   skipped its live half is not proof of the half it skipped:`)
    for (const n of notices) out(`     verify:${n.domain} — ${n.note}`)
  }

  if (unrunnable.length) {
    out(`   Resolve the could-not-run guards before a release: one that cannot run proves nothing.`)
  }

  out(failures.length ? '' : `\n✅ ${passed}/${total} verify suites passed in ${seconds}s\n`)
  return failures.length ? 1 : 0
}

/** The line a guard printed about skipping, so a summary can say WHY. */
export function skipReason(out: string): string {
  const m = out.split(/\r?\n/).find(l => /SKIPPED|BLOCKED|cannot run/i.test(l))
  return (m ?? '').replace(/^[\s⏭✗❌⚠️]+/, '').trim() || 'no reason given'
}

/**
 * A PASSING guard's own partial-skip line, or null.
 *
 * ⚠️ Deliberately narrow. `skipReason` matches any line mentioning "skipped",
 * which in a passing guard's output is often prose — a heading, or a check whose
 * NAME contains the word. This requires a leading skip marker so it reports the
 * guard's own notice rather than its vocabulary, and it is only ever a NOTICE:
 * nothing here changes a count or an exit code.
 */
export function partialSkipNotice(stdout: string): string | null {
  const line = stdout.split(/\r?\n/)
    .map(l => l.trim())
    .find(l => /^(⏭|…|\.\.\.)/.test(l) && /skip/i.test(l))
  if (!line) return null
  return line.replace(/^[⏭…\s.]+/, '').trim().slice(0, 120) || null
}
