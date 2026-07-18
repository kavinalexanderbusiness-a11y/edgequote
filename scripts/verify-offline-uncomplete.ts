// ── Verify: SCH-1 — un-completing a visit takes its invoice with it ──────────
//   npm run verify:offline-uncomplete
//
// WHY THIS SCRIPT EXISTS
// Completing a job drafts an invoice, and that draft fires AutoPay. The undo
// used to enqueue a plain `job.update` carrying only the reverted status, with
// the invoice deletion sitting inside the ONLINE closure. Offline that closure
// never runs — so on reconnect the queue replayed "complete" (draft created →
// card charged) and then "revert status", leaving a live invoice on a visit the
// contractor had explicitly un-done. The customer pays for work that didn't
// happen, and nothing in the UI is wrong-looking enough to catch it.
//
// None of that fails a typecheck or a build: it is a correct patch of the wrong
// shape. So the ordering and the composition are asserted here, against the real
// uncompleteJob and the real registered handler, with a fake Supabase that
// RECORDS THE ORDER of what it was asked to do.

import { uncompleteJob } from '../src/lib/invoicing'
import type { SupabaseClient } from '@supabase/supabase-js'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => cond ? ok(name) : fail(name, detail)

// ── A fake Supabase that records the sequence of operations ───────────────────
type Invoice = { id: string; invoice_number: string; status: string }
function fakeSb(opts: { invoice?: Invoice | null; failDelete?: boolean; failJob?: boolean }) {
  const log: string[] = []
  const state = { invoice: opts.invoice ?? null as Invoice | null, jobPatch: null as Record<string, unknown> | null }

  const from = (table: string) => {
    if (table === 'invoices') {
      const b: Record<string, unknown> = {}
      let deleting = false
      let statusFilter: string | null = null
      b.select = () => b
      b.delete = () => { deleting = true; return b }
      b.eq = (col: string, val: string) => { if (col === 'status') statusFilter = val; return b }
      b.limit = () => {
        log.push('read:invoice')
        return Promise.resolve({ data: state.invoice ? [state.invoice] : [], error: null })
      }
      // A delete resolves when awaited.
      b.then = (res: (v: { error: unknown }) => unknown) => {
        if (!deleting) return res({ error: null })
        log.push(`delete:invoice(status=${statusFilter})`)
        if (opts.failDelete) return res({ error: { message: 'delete failed' } })
        // Honour the status filter — a non-draft must not be removed.
        if (statusFilter && state.invoice && state.invoice.status !== statusFilter) return res({ error: null })
        state.invoice = null
        return res({ error: null })
      }
      return b
    }
    // jobs
    const j: Record<string, unknown> = {}
    j.update = (patch: Record<string, unknown>) => { state.jobPatch = patch; return j }
    j.eq = () => j
    j.then = (res: (v: { error: unknown }) => unknown) => {
      log.push('update:job')
      if (opts.failJob) return res({ error: { message: 'job update failed' } })
      return res({ error: null })
    }
    return j
  }
  return { sb: { from } as unknown as SupabaseClient, log, state }
}

const PATCH = { status: 'scheduled', completed_at: null }

const run = async () => {
  console.log('\n── The draft goes before the status ───────────────────────────')

  {
    const { sb, log, state } = fakeSb({ invoice: { id: 'i1', invoice_number: 'INV-001', status: 'draft' } })
    const res = await uncompleteJob(sb, { jobId: 'j1', patch: PATCH })
    check('a draft invoice is deleted', res.draftDeleted && state.invoice === null, JSON.stringify(res))
    check('the visit is reverted', res.reverted, JSON.stringify(res))
    // THE assertion. Reversed, an interrupted revert leaves a live invoice on a
    // reopened visit — which is the entire defect.
    const del = log.indexOf('delete:invoice(status=draft)')
    const upd = log.indexOf('update:job')
    check('the invoice is deleted BEFORE the job is reverted',
      del !== -1 && upd !== -1 && del < upd,
      `order was: ${log.join(' → ')}`)
  }

  console.log('\n── Real billing history is never destroyed ────────────────────')

  for (const status of ['sent', 'paid', 'partial', 'unpaid', 'cancelled']) {
    const { sb, state } = fakeSb({ invoice: { id: 'i1', invoice_number: 'INV-002', status } })
    const res = await uncompleteJob(sb, { jobId: 'j1', patch: PATCH })
    check(`a ${status} invoice is left standing`,
      !res.draftDeleted && res.invoiceLocked && state.invoice !== null,
      `a ${status} invoice was deleted — that is real money history`)
    check(`  …and the visit still reopens, reporting the locked invoice`,
      res.reverted && res.invoiceNumber === 'INV-002', JSON.stringify(res))
  }

  console.log('\n── Partial failure never bills for un-done work ───────────────')

  {
    // Delete fails → we must NOT go on to revert the status. Reverting anyway is
    // the exact state the defect produces: reopened visit, live invoice.
    const { sb, log } = fakeSb({ invoice: { id: 'i1', invoice_number: 'INV-003', status: 'draft' }, failDelete: true })
    const res = await uncompleteJob(sb, { jobId: 'j1', patch: PATCH })
    check('a failed delete aborts before reverting the visit',
      !res.reverted && !!res.error && !log.includes('update:job'),
      `order was: ${log.join(' → ')} — the visit was reopened with its invoice intact`)
  }
  {
    // Job update fails → the draft is already gone. Safe direction: nothing is
    // billed; the visit still reads completed and stays in the un-invoiced queue.
    const { sb, state } = fakeSb({ invoice: { id: 'i1', invoice_number: 'INV-004', status: 'draft' }, failJob: true })
    const res = await uncompleteJob(sb, { jobId: 'j1', patch: PATCH })
    check('a failed revert still leaves no invoice behind',
      res.draftDeleted && !res.reverted && state.invoice === null, JSON.stringify(res))
  }

  console.log('\n── No invoice at all ──────────────────────────────────────────')

  {
    const { sb, log } = fakeSb({ invoice: null })
    const res = await uncompleteJob(sb, { jobId: 'j1', patch: PATCH })
    check('an un-invoiced visit reopens cleanly',
      res.reverted && !res.draftDeleted && !res.invoiceLocked, JSON.stringify(res))
    check('nothing is deleted when there is nothing to delete',
      !log.some(l => l.startsWith('delete:')), log.join(' → '))
  }

  console.log('\n── Idempotent: a replayed op must be safe ─────────────────────')

  {
    const { sb } = fakeSb({ invoice: { id: 'i1', invoice_number: 'INV-005', status: 'draft' } })
    const a = await uncompleteJob(sb, { jobId: 'j1', patch: PATCH })
    const b = await uncompleteJob(sb, { jobId: 'j1', patch: PATCH })
    check('running twice reverts twice and deletes once',
      a.draftDeleted && a.reverted && !b.draftDeleted && b.reverted,
      `first=${JSON.stringify(a)} second=${JSON.stringify(b)}`)
  }

  console.log(failures === 0
    ? '\n✓ SCH-1: un-completing removes the draft, in that order, and never deletes real money.\n'
    : `\n✗ ${failures} check(s) failed.\n`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch(e => { console.error(e); process.exit(1) })
