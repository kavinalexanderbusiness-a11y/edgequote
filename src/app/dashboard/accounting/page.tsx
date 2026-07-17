'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type {
  ExpenseWithRelations, Vendor, ExpenseCategory, Payment, BusinessSettings,
} from '@/types'
import { expensePaymentMethodLabel, EXPENSE_PAYMENT_METHODS } from '@/types'
import { fetchAllRows } from '@/lib/fetchAll'
import { listExpenses, archiveExpense, restoreExpense } from '@/lib/accounting/expenses'
import { listVendors } from '@/lib/accounting/vendors'
import { listCategories, seedDefaultCategories } from '@/lib/accounting/categories'
import { profitAndLoss, cashFlow } from '@/lib/accounting/report'
import { resolvePeriod, PERIOD_OPTIONS, inPeriod, type PeriodKey } from '@/lib/accounting/period'
import { formatPct } from '@/lib/margin'
import { ExpenseForm } from '@/components/accounting/ExpenseForm'
import { VendorManager } from '@/components/accounting/VendorManager'
import { CategoryManager } from '@/components/accounting/CategoryManager'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { SearchInput } from '@/components/ui/SearchInput'
import { StatTile } from '@/components/ui/StatTile'
import { Tabs } from '@/components/ui/Tabs'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { Th, Td, tableRowHover } from '@/components/ui/Table'
import { Menu } from '@/components/ui/Menu'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { toast } from '@/lib/toast'
import { formatCurrency, formatDate, localTodayISO } from '@/lib/utils'
import {
  Receipt, Plus, TrendingDown, TrendingUp, Wallet, Paperclip, MoreHorizontal,
  Pencil, Trash2, Info, Store, Tags, ExternalLink,
} from 'lucide-react'

// ── Accounting ───────────────────────────────────────────────────────────────
// Money OUT, and the first place the two halves meet: lib/accounting/report.ts
// combines this module's expenses with the payments ledger's cash. Nothing on this
// page does money maths — it renders what the engine returns.
//
// The tone this page has to hold: with an empty expense table the P&L is
// arithmetically perfect and completely useless (revenue $2,680, cost $0, "100%
// margin"). That number is TRUE of the data and false about the business, so the
// page says the books are empty rather than letting a 100% margin read as a fact.

type TabKey = 'expenses' | 'vendors' | 'categories'

export default function AccountingPage() {
  const supabase = useMemo(() => createClient(), [])
  const todayISO = useMemo(() => localTodayISO(), [])

  const [tab, setTab] = useState<TabKey>('expenses')
  const [userId, setUserId] = useState<string | null>(null)
  const [expenses, setExpenses] = useState<ExpenseWithRelations[]>([])
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [jobs, setJobs] = useState<{ id: string; label: string }[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Filters
  const [periodKey, setPeriodKey] = useState<PeriodKey>('this_year')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [vendorId, setVendorId] = useState('')
  const [method, setMethod] = useState('')
  const [search, setSearch] = useState('')

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ExpenseWithRelations | null>(null)

  const period = useMemo(
    () => resolvePeriod(periodKey, todayISO, { from: customFrom, to: customTo }),
    [periodKey, todayISO, customFrom, customTo],
  )

  const fetchExpenses = useCallback(async (uid: string) => {
    const { rows, error } = await listExpenses(supabase, uid)
    if (error) { setLoadError(error); return }
    setExpenses(rows)
  }, [supabase])

  const load = useCallback(async () => {
    const { data: auth } = await supabase.auth.getUser()
    const uid = auth.user?.id
    if (!uid) { setLoading(false); return }
    setUserId(uid)

    const [, vs, cs] = await Promise.all([
      fetchExpenses(uid),
      listVendors(supabase, uid),
      // Seeds on first visit only, and never resurrects a default the owner deleted.
      seedDefaultCategories(supabase, uid),
    ])
    setVendors(vs)
    setCategories(cs)

    // Money IN comes from the ledger untouched — read every row, because a P&L
    // missing payment 1001 is wrong in the direction nobody checks.
    const { rows: pays, error: payErr } = await fetchAllRows<Payment>(async (from, to) => {
      const { data, error } = await supabase
        .from('payments')
        .select('id, amount, method, provider, paid_at, kind, status, invoice_id, customer_id, currency, created_at, user_id, notes')
        .eq('user_id', uid)
        .order('paid_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
      return { data: (data as unknown as Payment[]) || [], error }
    })
    if (payErr) setLoadError(payErr)
    setPayments(pays)

    const { data: jobRows } = await supabase
      .from('jobs')
      .select('id, title, service_type, scheduled_date')
      .eq('user_id', uid)
      .order('scheduled_date', { ascending: false })
      .limit(200)
    setJobs(
      (jobRows || []).map(j => ({
        id: j.id as string,
        label: `${(j.title as string) || (j.service_type as string) || 'Job'}${j.scheduled_date ? ` — ${formatDate(j.scheduled_date as string)}` : ''}`,
      })),
    )

    const { data: s } = await supabase.from('business_settings').select('*').eq('user_id', uid).maybeSingle()
    setSettings((s as BusinessSettings) || null)
    setLoading(false)
  }, [supabase, fetchExpenses])

  useEffect(() => { load() }, [load])
  useRealtimeRefresh('expenses', userId ? `user_id=eq.${userId}` : null, () => { if (userId) fetchExpenses(userId) })

  // ── Client-side filtering (the rows are already all here) ─────────────────
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return expenses.filter(e => {
      // inPeriod(), NOT a hand-rolled `e.spent_at >= from` comparison. An unpaid
      // bill has spent_at = null, and JS compares null numerically against a date
      // string: BOTH bounds come out false, so the row passes and an unpaid bill
      // lands in every period at once. inPeriod treats null as "no period".
      if (!inPeriod(e.spent_at, period)) return false
      if (categoryId && e.category_id !== categoryId) return false
      if (vendorId && e.vendor_id !== vendorId) return false
      if (method && e.payment_method !== method) return false
      if (term) {
        const hay = [e.description, e.reference, e.notes, e.vendors?.name, e.expense_categories?.name]
          .filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(term)) return false
      }
      return true
    })
  }, [expenses, period, categoryId, vendorId, method, search])

  // THE engine. Filters narrow the expense side; the P&L always sees the whole
  // payment set for the period, so a category filter can't quietly restate revenue.
  const pl = useMemo(
    () => profitAndLoss({ payments, expenses: filtered, settings, period }),
    [payments, filtered, settings, period],
  )
  const cf = useMemo(
    () => cashFlow({ payments, expenses: filtered, settings, period }),
    [payments, filtered, settings, period],
  )

  const booksEmpty = pl.expenseCount === 0
  const filtersOn = Boolean(categoryId || vendorId || method || search.trim())

  async function handleArchive(e: ExpenseWithRelations) {
    const { error } = await archiveExpense(supabase, e.id)
    if (error) { toast.error(error); return }
    if (userId) await fetchExpenses(userId)
    toast.undo(`Removed ${formatCurrency(Number(e.amount))} — receipt kept`, async () => {
      await restoreExpense(supabase, e.id)
      if (userId) await fetchExpenses(userId)
    })
  }

  return (
    <div className="rise">
      <PageHeader
        title="Accounting"
        description="What the business spends, and what's left after it."
        action={
          <Button onClick={() => { setEditing(null); setFormOpen(true) }}>
            <Plus className="w-4 h-4" /> Log expense
          </Button>
        }
      />

      {loadError && (
        <Banner tone="danger" className="mb-4">
          Some figures may be incomplete — {loadError}
        </Banner>
      )}

      <Tabs
        tabs={[
          { key: 'expenses', label: 'Expenses', icon: Receipt },
          { key: 'vendors', label: 'Vendors', icon: Store },
          { key: 'categories', label: 'Categories', icon: Tags },
        ]}
        active={tab}
        onChange={k => setTab(k as TabKey)}
      />

      {tab === 'expenses' && (
        <div className="mt-5 flex flex-col gap-5">
          {/* ── Period ─────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label="Period"
              fieldSize="sm"
              options={PERIOD_OPTIONS}
              value={periodKey}
              onChange={e => setPeriodKey(e.target.value as PeriodKey)}
              className="w-44"
            />
            {periodKey === 'custom' && (
              <>
                <Input label="From" type="date" fieldSize="sm" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
                <Input label="To" type="date" fieldSize="sm" value={customTo} onChange={e => setCustomTo(e.target.value)} />
              </>
            )}
            <span className="text-sm text-ink-faint pb-2">{period.label}</span>
          </div>

          {loading ? (
            <SkeletonTiles count={4} />
          ) : (
            <>
              {/* ── The figures ────────────────────────────────────────── */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatTile
                  label="Revenue"
                  value={<span className="tabular-nums">{formatCurrency(pl.revenue)}</span>}
                  sub={`${pl.paymentCount} payment${pl.paymentCount === 1 ? '' : 's'} collected`}
                  icon={TrendingUp}
                />
                <StatTile
                  label="Spend"
                  value={<span className="tabular-nums">{formatCurrency(pl.cost)}</span>}
                  sub={
                    pl.registrant
                      ? `net of ${formatCurrency(pl.taxPaid)} tax reclaimed`
                      : `${pl.expenseCount} expense${pl.expenseCount === 1 ? '' : 's'}`
                  }
                  icon={TrendingDown}
                />
                <StatTile
                  label="Profit"
                  value={<span className="tabular-nums">{formatCurrency(pl.profit)}</span>}
                  sub={booksEmpty ? 'no expenses recorded yet' : `${formatPct(pl.margin)} margin`}
                  icon={Wallet}
                  tone={booksEmpty ? undefined : pl.profit >= 0 ? 'success' : 'danger'}
                  accent={!booksEmpty}
                />
                <StatTile
                  label="Cash movement"
                  value={<span className="tabular-nums">{formatCurrency(cf.net)}</span>}
                  sub={`${formatCurrency(cf.inflow)} in · ${formatCurrency(cf.outflow)} out`}
                  icon={Wallet}
                />
              </div>

              {/* The honest banner. An empty expense table produces a flawless,
                  meaningless P&L — say so instead of letting 100% margin pass. */}
              {booksEmpty && (
                <Banner tone="info" icon={Info}>
                  <strong>These books are empty.</strong> With no expenses recorded, profit is just
                  revenue and the margin reads 100% — arithmetically right, and not true of any real
                  business. Log what you spend and these figures start meaning something.
                </Banner>
              )}

              {/* Money that can't be dated belongs to no period, so it silently
                  lowers revenue everywhere. Say it out loud instead. */}
              {pl.undatedCashCount > 0 && (
                <Banner tone="warn">
                  {formatCurrency(pl.undatedCash)} of collected payments have no payment date, so
                  they can&apos;t appear in this or any other period. Revenue here is short by that
                  much until they&apos;re dated.
                </Banner>
              )}

              {pl.uncategorisedCount > 0 && (
                <Banner tone="warn">
                  {pl.uncategorisedCount} expense{pl.uncategorisedCount === 1 ? ' has' : 's have'} no
                  category — {formatCurrency(pl.byCategory.find(c => c.categoryId === null)?.cost ?? 0)} of
                  spend that no report can group.
                </Banner>
              )}

              {/* ── Where it goes ──────────────────────────────────────── */}
              {pl.byCategory.length > 0 && (
                <Card>
                  <CardBody>
                    <h2 className="text-sm font-semibold text-ink mb-3">Where the money goes</h2>
                    <div className="flex flex-col gap-2">
                      {pl.byCategory.slice(0, 8).map(c => (
                        <button
                          key={c.categoryId ?? 'none'}
                          type="button"
                          onClick={() => setCategoryId(c.categoryId ?? '')}
                          className="flex items-center gap-3 text-left group"
                        >
                          <span className="w-32 shrink-0 text-sm text-ink-muted truncate group-hover:text-ink">
                            {c.name}
                          </span>
                          <span className="flex-1 h-2 rounded-full bg-surface-sunken overflow-hidden">
                            <span
                              className="block h-full rounded-full bg-accent/70"
                              style={{ width: `${Math.max(2, c.share * 100)}%` }}
                            />
                          </span>
                          <span className="w-24 shrink-0 text-right text-sm tabular-nums text-ink">
                            {formatCurrency(c.cost)}
                          </span>
                          {!c.tax_deductible && <Badge tone="neutral">not deductible</Badge>}
                        </button>
                      ))}
                    </div>
                  </CardBody>
                </Card>
              )}

              {/* ── Filters ────────────────────────────────────────────── */}
              <div className="flex flex-wrap items-center gap-2">
                <SearchInput
                  fieldSize="sm"
                  placeholder="Search description, reference, vendor…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full sm:w-72"
                />
                <Select
                  fieldSize="sm"
                  placeholder="All categories"
                  options={categories.map(c => ({ value: c.id, label: c.name }))}
                  value={categoryId}
                  onChange={e => setCategoryId(e.target.value)}
                  className="w-44"
                />
                <Select
                  fieldSize="sm"
                  placeholder="All vendors"
                  options={vendors.map(v => ({ value: v.id, label: v.name }))}
                  value={vendorId}
                  onChange={e => setVendorId(e.target.value)}
                  className="w-44"
                />
                <Select
                  fieldSize="sm"
                  placeholder="Any method"
                  options={EXPENSE_PAYMENT_METHODS}
                  value={method}
                  onChange={e => setMethod(e.target.value)}
                  className="w-36"
                />
                {filtersOn && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { setCategoryId(''); setVendorId(''); setMethod(''); setSearch('') }}
                  >
                    Clear
                  </Button>
                )}
                <span className="ml-auto text-sm text-ink-faint tabular-nums">
                  {filtered.length} of {expenses.length}
                </span>
              </div>

              {/* ── The list ───────────────────────────────────────────── */}
              {filtered.length === 0 ? (
                expenses.length === 0 ? (
                  <EmptyState
                    icon={Receipt}
                    title="No expenses yet"
                    description="Log fuel, materials, insurance — anything the business pays for. Every report here is built from these."
                    action={{ label: 'Log your first expense', onClick: () => { setEditing(null); setFormOpen(true) } }}
                  />
                ) : (
                  <InlineEmpty icon={Receipt}>No expenses match those filters in {period.label}.</InlineEmpty>
                )
              ) : (
                <Card>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr>
                          <Th>Date</Th>
                          <Th>Description</Th>
                          <Th>Vendor</Th>
                          <Th>Category</Th>
                          <Th className="text-right">Amount</Th>
                          <Th />
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map(e => (
                          <tr key={e.id} className={tableRowHover}>
                            <Td className="whitespace-nowrap text-ink-muted">
                              {e.spent_at
                                ? formatDate(e.spent_at)
                                // An unpaid bill has no cash date. Show when it was
                                // billed and say it's owed — never a blank cell, and
                                // never the bill date dressed as a payment date.
                                : <span className="text-warn">Owed · billed {formatDate(e.bill_date)}</span>}
                            </Td>
                            <Td>
                              <span className="flex items-center gap-2">
                                <span className="text-ink">{e.description || '—'}</span>
                                {e.receipt_path && <Paperclip className="w-3.5 h-3.5 text-ink-faint" aria-label="Receipt attached" />}
                                {e.jobs && (
                                  <Badge tone="neutral" icon={ExternalLink}>{e.jobs.title || 'job'}</Badge>
                                )}
                              </span>
                              {e.reference && <span className="block text-xs text-ink-faint">#{e.reference}</span>}
                            </Td>
                            <Td className="text-ink-muted">{e.vendors?.name || '—'}</Td>
                            <Td>
                              {e.expense_categories
                                ? <span className="text-ink-muted">{e.expense_categories.name}</span>
                                : <Badge tone="warn">Uncategorised</Badge>}
                            </Td>
                            <Td className="text-right">
                              <span className="tabular-nums text-ink font-medium">{formatCurrency(Number(e.amount))}</span>
                              {Number(e.tax_amount) > 0 && (
                                <span className="block text-xs text-ink-faint tabular-nums">
                                  incl. {formatCurrency(Number(e.tax_amount))} tax
                                </span>
                              )}
                            </Td>
                            <Td className="text-right">
                              <Menu
                                align="end"
                                width={180}
                                ariaLabel="Expense actions"
                                items={[
                                  { key: 'edit', label: 'Edit', icon: Pencil, onSelect: () => { setEditing(e); setFormOpen(true) } },
                                  { key: 'remove', label: 'Remove', icon: Trash2, danger: true, onSelect: () => handleArchive(e) },
                                ]}
                              >
                                {({ toggle, triggerProps }) => (
                                  <Button variant="ghost" size="sm" onClick={toggle} {...triggerProps} aria-label="Expense actions">
                                    <MoreHorizontal className="w-4 h-4" />
                                  </Button>
                                )}
                              </Menu>
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'vendors' && (
        <div className="mt-5">
          {loading ? <SkeletonRows count={5} /> : (
            <VendorManager
              sb={supabase}
              userId={userId}
              vendors={vendors}
              expenses={expenses}
              onChanged={async () => { if (userId) setVendors(await listVendors(supabase, userId)) }}
            />
          )}
        </div>
      )}

      {tab === 'categories' && (
        <div className="mt-5">
          {loading ? <SkeletonRows count={5} /> : (
            <CategoryManager
              sb={supabase}
              userId={userId}
              categories={categories}
              expenses={expenses}
              onChanged={async () => { if (userId) setCategories(await listCategories(supabase, userId)) }}
            />
          )}
        </div>
      )}

      {userId && (
        <ExpenseForm
          open={formOpen}
          onClose={() => { setFormOpen(false); setEditing(null) }}
          sb={supabase}
          userId={userId}
          todayISO={todayISO}
          vendors={vendors}
          categories={categories}
          jobs={jobs}
          editing={editing}
          onSaved={async () => { if (userId) await fetchExpenses(userId) }}
          onVendorCreated={async () => { if (userId) setVendors(await listVendors(supabase, userId)) }}
        />
      )}
    </div>
  )
}
