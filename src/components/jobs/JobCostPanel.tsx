'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, Receipt } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { parseMoney, createExpense, archiveExpense } from '@/lib/accounting/expenses'
import { listCategories } from '@/lib/accounting/categories'
import type { ExpenseCategory } from '@/types'
import {
  CATEGORY_LABEL, UNKNOWN_REASON_LABEL, COST_CATEGORIES,
  describeCost, formatCost, costCapturePrompt,
  type CostCategory, type CostLine, type JobActualCost,
} from '@/lib/jobCost'
import { loadJobCost, type JobCostLoad, type JobCostTarget } from '@/lib/jobCostData'
import { formatMinutes } from '@/lib/estimateVsActual'

// ── What this visit actually cost, and what nobody wrote down ────────────────
// THE door from a finished visit to its real cost. It exists because the whole
// costing stack already existed and had no entrance from the work:
// lib/accounting/expenses (write), lib/accounting/jobCosting (read),
// /dashboard/accounting/job-costing (report) and 30 seeded expense categories
// were all shipped and correct — and the ONLY place to record a receipt was the
// Accounting hub, a back-office screen the field workflow never opens. Production
// ran 223 jobs and 79 completions through to 0 expense rows. The feature was not
// missing; the door was.
//
// So this is deliberately NOT an expense form. Amount and what-it-was are the two
// things someone standing at a truck can answer, and the job is already known
// because they are looking at it. Everything else the schema supports — vendor,
// tax, reference, paid/unpaid, capital, receipt image — stays in the full form at
// /dashboard/accounting, which is unchanged and remains the place to do books.
//
// ⚠️ TAX IS NOT GUESSED. The quick door records `tax_amount: 0` because the
// person tapping it has not told us what tax was on the receipt, and inventing a
// rate would put a fabricated input tax credit into the GST return. A registrant
// who needs the credit edits the row in Accounting, where the field exists. 0 is
// the honest value for "not stated", and it is the only figure here that is not
// straight from the owner's fingers.
//
// ⚠️ ESTIMATED MATERIALS NEVER BECOME ACTUAL ONES. Nothing on this panel reads a
// quote line, a service template's material_cost, or job_line_items (which are
// priced EXTRAS — revenue — not cost). A cost appears here only because a human
// typed it. Copying an estimate into the actuals would make every job look
// perfectly predicted and destroy the only signal this lane exists to create.
//
// ⚠️ EVERY BUTTON IS type="button". This panel renders INSIDE JobForm's <form>,
// where a bare <button> submits the visit. `Button` already defaults to
// type="button" for exactly this reason; do not override it here.

export function JobCostPanel({
  job, className, onChange,
}: {
  job: JobCostTarget
  className?: string
  /**
   * Fired after a cost is recorded or an undo removes it. The profit review
   * below this panel reads the same rows, so without it the two panels sit on
   * screen disagreeing about the same visit until the form is reopened — and the
   * one showing the stale answer is the one with the margin on it.
   */
  onChange?: () => void
}) {
  const supabase = createClient()
  const [load, setLoad] = useState<JobCostLoad | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState('')

  const refresh = useCallback(async (uid: string) => {
    setLoad(await loadJobCost(supabase, uid, job))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, job.status, job.actual_minutes, job.crew_size, job.service_type])

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!alive) return
      const uid = user?.id ?? ''
      setUserId(uid || null)
      const [next, cats] = await Promise.all([
        loadJobCost(supabase, uid, job),
        uid ? listCategories(supabase, uid) : Promise.resolve([]),
      ])
      if (!alive) return
      setLoad(next)
      setCategories(cats)
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id])

  // Loading is its own state and shows NO figures. A skeleton that renders zeros
  // is the same lie as a failed read that renders zeros, half a second earlier.
  if (!load) return shell(className, <p className="mt-2 text-xs text-ink-muted">Loading costs…</p>)

  // A read that did not happen. `load.cost` is already all-unknown, so even the
  // figures below would be honest — but an owner must be told the difference
  // between "nothing was spent" and "we could not look".
  if (load.outcome === 'unavailable') {
    return shell(className, (
      <p className="mt-2 text-xs leading-relaxed text-ink-muted">
        Costs for this visit could not be loaded. This is a loading problem, not a finding that the
        visit cost nothing.
      </p>
    ))
  }

  const cost = load.cost
  const prompt = costCapturePrompt({ cost, status: job.status, pricedPeers: load.pricedPeers })

  const save = async () => {
    if (!userId) { toast.error('Sign in again to record a cost.'); return }
    const parsed = parseMoney(amount)
    if (parsed == null) { toast.error('Enter an amount like 185 or 42.50'); return }
    if (parsed < 0) { toast.error('An amount cannot be negative.'); return }
    setSaving(true)
    const today = new Date().toISOString().slice(0, 10)
    const { expense, error } = await createExpense(supabase, {
      userId,
      values: {
        vendor_id: '', category_id: categoryId, job_id: job.id,
        amount: String(parsed),
        // See the header: not stated is not zero-rated, but 0 is the only honest
        // stand-in and the full form is where a registrant states the real figure.
        tax_amount: '',
        bill_date: today, paid: true, spent_at: today, is_capital: false,
        description: description.trim(), payment_method: '', reference: '', notes: '',
      },
    })
    setSaving(false)
    if (error || !expense) { toast.error(error || 'Could not record that cost.'); return }
    setAmount(''); setDescription(''); setCategoryId(''); setAdding(false)
    // Undo removes the row it JUST created — never "the last expense", which
    // after a second tap would archive someone else's. It branches on the
    // archive's own error: a Supabase write resolves on failure, so an unchecked
    // undo leaves the cost on the visit while the toast says it was taken off.
    toast.undo(`Recorded ${formatCurrency(parsed)} on this visit.`, async () => {
      const { error: undoError } = await archiveExpense(supabase, expense.id)
      if (undoError) { toast.error(`Could not remove that cost: ${undoError}`); return }
      if (userId) await refresh(userId)
      onChange?.()
    })
    await refresh(userId)
    onChange?.()
  }

  return shell(className, (
    <>
      {/* The headline refuses to name a total unless one exists — describeCost
          words an incomplete cost as "At least $X", which is the floor and reads
          as one. */}
      <p className={cn('mt-1.5 text-sm', cost.total.state === 'known' ? 'font-semibold text-ink' : 'text-ink')}>
        {describeCost(cost)}
      </p>

      {/* The contract itself: three categories, each answered independently.
          Nothing is collapsed, so "materials — nothing recorded" cannot be read
          as "materials — $0". */}
      <dl className="mt-2.5 space-y-1">
        {COST_CATEGORIES.map(key => (
          <CostRow key={key} line={lineFor(cost, key)} />
        ))}
      </dl>

      {/* Hours are reported even when cost is not, and they carry their source.
          Clocked minutes are an attendance record; actual_minutes × crew size is
          an estimate of effort built on the PLANNED crew, so it says so and can
          never become a dollar figure. */}
      {cost.labourTime.personMinutes != null && (
        <p className="mt-2 text-xs text-ink-muted tabular-nums">
          {formatMinutes(cost.labourTime.personMinutes)} of labour
          {cost.labourTime.source === 'clock'
            ? ` · clocked over ${cost.labourTime.shifts} ${cost.labourTime.shifts === 1 ? 'shift' : 'shifts'}`
            : ` · estimated from ${formatMinutes(cost.labourTime.visitMinutes)} on site × ${cost.labourTime.crewSize} crew`}
        </p>
      )}
      {cost.labour.reason === 'no_rate' && (
        <p className="mt-1 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
          Those hours have no pay rate on them, so labour cost is unknown rather than low. Set the rate
          on the shift in Time &amp; pay.
        </p>
      )}

      {/* Spend that is tagged here but is not a cost OF this visit. Surfaced
          rather than silently subtracted — an owner who can see the receipt in
          Accounting must be able to see why it is not in this figure. */}
      {cost.excluded.count > 0 && (
        <p className="mt-1 text-xs text-ink-muted">
          {cost.excluded.count} tagged {cost.excluded.count === 1 ? 'row' : 'rows'} ({formatCost(cost.excluded.amount)})
          {' '}not counted — equipment or owner draws are not this visit&apos;s cost.
        </p>
      )}

      {prompt && (
        <p className="mt-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
          {prompt}
        </p>
      )}

      {/* The receipts themselves, so a figure can always be traced to a row. */}
      {load.expenses.length > 0 && (
        <ul className="mt-2.5 space-y-1 border-t border-border pt-2">
          {load.expenses.map(e => (
            <li key={e.id} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-ink-muted">
                {e.description || e.expense_categories?.name || 'Cost'}
                {e.expense_categories?.name && e.description ? ` · ${e.expense_categories.name}` : ''}
              </span>
              <span className="shrink-0 tabular-nums text-ink">{formatCurrency(Number(e.amount) || 0)}</span>
            </li>
          ))}
        </ul>
      )}

      {/* ── The door ── */}
      {!adding ? (
        <Button variant="secondary" size="sm" className="mt-2.5 w-full" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" /> Record a cost
        </Button>
      ) : (
        <div className="mt-2.5 space-y-2 rounded-lg border border-border bg-surface-2 p-2.5">
          <div className="grid grid-cols-2 gap-2">
            <Input
              fieldSize="sm" label="Amount" inputMode="decimal" placeholder="185.00" autoFocus
              value={amount} onChange={e => setAmount(e.target.value)} />
            <Select
              fieldSize="sm" label="Category" placeholder="Uncategorised"
              options={categories.map(c => ({ value: c.id, label: c.name }))}
              value={categoryId} onChange={e => setCategoryId(e.target.value)} />
          </div>
          <Input
            fieldSize="sm" label="What was it?" placeholder="6 yd mulch"
            value={description} onChange={e => setDescription(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" loading={saving} onClick={save}>Save cost</Button>
            <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setAmount(''); setDescription(''); setCategoryId('') }}>
              Cancel
            </Button>
          </div>
          <p className="text-[11px] leading-relaxed text-ink-faint">
            Recorded against this visit, dated today, with no tax split. Add a vendor, tax or a receipt
            photo in Accounting.
          </p>
        </div>
      )}
    </>
  ))
}

function lineFor(cost: JobActualCost, key: CostCategory): CostLine {
  return key === 'labour' ? cost.labour : key === 'materials' ? cost.materials : cost.other
}

/**
 * One category. An unknown renders its REASON, never a dash on its own and never
 * a zero — "Nothing recorded" is a different sentence from "$0.00" and the whole
 * contract lives in keeping them apart on screen.
 */
function CostRow({ line }: { line: CostLine }) {
  const known = line.state === 'known'
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-ink-muted">{CATEGORY_LABEL[line.category]}</dt>
      <dd className={cn('shrink-0 text-xs tabular-nums', known ? 'font-medium text-ink' : 'text-ink-faint')}>
        {known ? formatCost(line.amount) : UNKNOWN_REASON_LABEL[line.reason!]}
      </dd>
    </div>
  )
}

function shell(className: string | undefined, children: React.ReactNode) {
  return (
    <div className={cn('rounded-xl border border-border bg-surface p-3.5', className)}>
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
        <Receipt className="h-3.5 w-3.5" /> Actual cost
      </div>
      {children}
    </div>
  )
}
