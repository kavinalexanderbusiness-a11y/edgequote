// ── Ending a script that made HTTP calls ─────────────────────────────────────
//
// Node 24 on Windows aborts the runtime with
//     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94
// when process.exit() runs while undici still holds a pooled keep-alive socket.
//
// It is a nasty failure to read for two reasons:
//   · it happens AFTER the work finished, so a script that SUCCEEDED prints its
//     green summary and then aborts — and the abort is what the shell reports.
//   · inside `npm run verify`, it kills the runner mid-suite, so the whole suite
//     ends with no summary and an exit code that means "the shell survived",
//     not "the guards passed".
//
// Measured with process.getActiveResourcesInfo(): after a Supabase call the live
// handles are ["PipeWrap","TCPSocketWrap","Immediate"]; closing the global
// dispatcher removes the TCPSocketWrap and the process then ends on its own. So
// the fix is to close the pool and set an exit CODE rather than force an exit.

/**
 * Close the HTTP keep-alive pool, then ask the process to end with `code`.
 *
 * Does NOT call process.exit() on the normal path — that call is the bug. The
 * unref'd timer is a backstop for a script that leaves something else open: it
 * cannot keep the process alive by itself, and a hung CLI is worse than an
 * ungraceful one.
 */
export async function endProcess(code: number, graceMs = 5000): Promise<void> {
  try {
    const d = (globalThis as Record<symbol, unknown>)[Symbol.for('undici.globalDispatcher.1')] as
      { close?: () => Promise<void> } | undefined
    await d?.close?.()
  } catch { /* best effort — cleanup must never change the outcome */ }
  process.exitCode = code
  setTimeout(() => process.exit(code), graceMs).unref()
}
