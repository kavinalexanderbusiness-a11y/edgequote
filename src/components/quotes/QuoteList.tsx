'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useListShortcuts } from '@/hooks/useListShortcuts'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { hoverIntent } from '@/lib/prefetch'
import { Quote, QuoteStatus } from '@/types'
import { formatCurrency, formatDate, generateQuoteNumber, localTodayISO, maxNumericSuffix } from '@/lib/utils'
import { needsFollowUp, daysSince, compareFollowUp, chaseBlockedReason } from '@/lib/followup'
import type { ReachCustomer } from '@/lib/comms/reach'
import { describeSkip } from '@/lib/comms/skipReasons'
import { isQuoteExpired, markSentPatch } from '@/lib/quoteStatus'
import { QuoteStatusControl } from '@/components/quotes/QuoteStatusControl'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SearchInput } from '@/components/ui/SearchInput'
import { FilterPill } from '@/components/ui/FilterPill'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { useBulkSelect } from '@/hooks/useBulkSelect'
import { BulkActionBar, SelectCheckbox, SelectAllToggle, type BulkAction } from '@/components/ui/BulkActions'
import { exportRowsToCsv } from '@/lib/csv'
import { addDays, format as formatDfn, parseISO } from 'date-fns'
import { Trash2, Bell, Send, FileText, Copy, Download } from 'lucide-react'

interface QuoteListProps {
  quotes: Quote[]
  onDelete: (id: string) => Promise<void>
  /** Reach fields per customer id, so the follow-up queue can tell "chase this"
   *  apart from "you have no way to chase this". Optional: absent (or a customer
   *  missing from it) means the row behaves exactly as it did before — the queue
   *  must never invent a block it isn't sure about. */
  reachById?: Record<string, ReachCustomer>
}

const STATUS_FILTERS: { value: '' | QuoteStatus; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'completed', label: 'Completed' },
  { value: 'paid', label: 'Paid' },
  { value: 'declined', label: 'Declined' },
]

export function QuoteList({ quotes, onDelete, reachById }: QuoteListProps) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'' | QuoteStatus>('')
  const [followUpOnly, setFollowUpOnly] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // '/' focuses search, 'n' starts a new quote — the shared list idiom.
  useListShortcuts({ search: searchRef, onNew: () => router.push('/dashboard/quotes/new') })

  // Why a quote's follow-up can't go out — null when it can, or when we simply
  // don't know the customer (never invent a block). Same engine the sender uses.
  const blockedFor = useCallback((q: Quote) => {
    const c = q.customer_id ? reachById?.[q.customer_id] : undefined
    return c ? chaseBlockedReason(c) : null
  }, [reachById])

  // Date math over every quote — memoized so it doesn't re-run on each search keystroke.
  // Counts only the follow-ups the owner can actually DO, so the pill agrees with the
  // dashboard queue rather than promising work that has no channel to happen on.
  const followUpCount = useMemo(
    () => quotes.filter(q => needsFollowUp(q) && !blockedFor(q)).length,
    [quotes, blockedFor],
  )

  // Deep-link from the Weekly Review (and elsewhere): ?followup=1 opens straight to
  // the follow-up queue, ?status=sent to a status — one tap, no re-filtering. Read
  // from window (not useSearchParams) so no Suspense boundary is needed.
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search)
      if (p.get('followup') === '1') setFollowUpOnly(true)
      const s = p.get('status')
      if (s && STATUS_FILTERS.some(f => f.value === s)) setStatusFilter(s as QuoteStatus)
    } catch { /* ignore */ }
  }, [])

  // Memoized (scale) so the O(n) filter + sort doesn't re-run on every keystroke.
  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    const matched = quotes.filter(quote => {
      const matchSearch =
        quote.customer_name.toLowerCase().includes(q) ||
        quote.quote_number.toLowerCase().includes(q) ||
        quote.service_type.toLowerCase().includes(q)
      const matchStatus = statusFilter ? quote.status === statusFilter : true
      const matchFollowUp = followUpOnly ? needsFollowUp(quote) : true
      return matchSearch && matchStatus && matchFollowUp
    })
    // The follow-up queue orders by URGENCY (the shared comparator), not created-at —
    // the quote that's been waiting longest is the one to chase first.
    return followUpOnly ? [...matched].sort(compareFollowUp) : matched
  }, [quotes, search, statusFilter, followUpOnly])

  async function handleDelete(id: string) {
    setDeleting(id)
    await onDelete(id)
    setDeleting(null)
  }

  // ── Bulk actions (shared selection system) ──
  const sel = useBulkSelect(filtered)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  // Send: texts/emails each quote's customer their portal quote link (the one comms
  // pipeline) and arms the follow-up clock (draft → sent + sent_at).
  async function bulkSend() {
    const supabase = createClient()
    const targets = sel.selectedItems.filter(q => q.customer_id)
    if (!targets.length) { toast.error('None of the selected quotes have a linked customer.'); return }
    setBusyKey('send')
    let sent = 0, skipped = 0
    for (const q of targets) {
      try {
        const res = await fetch('/api/comms/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId: q.customer_id, template: 'quote', channels: ['sms', 'email'] }),
        })
        const d = (await res.json().catch(() => ({}))) as { results?: Record<string, { sent?: boolean }> }
        if (Object.values(d.results || {}).some(r => r?.sent)) {
          sent++
          // ONE patch, ONE write — this was two updates that between them never wrote
          // valid_until, which is why the expiry feature has never fired. The
          // draft-only guard is unchanged: re-sending an already-sent quote must not
          // re-stamp it, and the owner's no-backfill decision means legacy sent quotes
          // keep their absent expiry.
          if (q.status === 'draft') {
            await supabase.from('quotes')
              .update(markSentPatch({ sent_at: q.sent_at, valid_until: q.valid_until }, localTodayISO()))
              .eq('id', q.id)
          }
        } else skipped++
      } catch { skipped++ }
    }
    setBusyKey(null); sel.clear(); router.refresh()
    toast.success(`Quote sent to ${sent} customer${sent !== 1 ? 's' : ''}${skipped ? ` · ${skipped} skipped (no opt-in/contact)` : ''}.`)
  }

  // Convert to invoice: eligible (accepted/scheduled/completed) + not already
  // invoiced. Sequential INV-#### from the current max — same rules as the
  // single-quote Convert (quote_id recorded so auto-invoice can never double-bill).
  async function bulkConvert() {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const eligible = sel.selectedItems.filter(q => ['accepted', 'scheduled', 'completed'].includes(q.status))
    if (!eligible.length) { toast.error('Select accepted, scheduled or completed quotes to convert.'); return }
    setBusyKey('convert')
    const [{ data: nums }, { data: existing }] = await Promise.all([
      supabase.from('invoices').select('invoice_number').eq('user_id', user.id),
      supabase.from('invoices').select('quote_id').in('quote_id', eligible.map(q => q.id)),
    ])
    const already = new Set(((existing as { quote_id: string | null }[]) || []).map(r => r.quote_id))
    let next = maxNumericSuffix(((nums as { invoice_number: string }[]) || []).map(n => n.invoice_number)) + 1
    const issued = localTodayISO()
    const dueISO = formatDfn(addDays(parseISO(issued), 14), 'yyyy-MM-dd')
    let created = 0
    for (const q of eligible) {
      if (already.has(q.id)) continue
      const { error } = await supabase.from('invoices').insert({
        user_id: user.id, quote_id: q.id, customer_id: q.customer_id, property_id: q.property_id,
        invoice_number: `INV-${String(next).padStart(4, '0')}`, customer_name: q.customer_name,
        address: q.address, service_type: q.service_type, amount: q.total, status: 'unpaid',
        issued_date: issued, due_date: dueISO, notes: q.notes,
      })
      if (!error) { created++; next++ }
    }
    setBusyKey(null); sel.clear()
    toast.success(`Created ${created} invoice${created !== 1 ? 's' : ''}${already.size ? ` · ${already.size} already invoiced` : ''}.`)
  }

  // Duplicate each selected quote as a fresh draft (same field set as the
  // single-quote Duplicate; sequential Q-#### numbers).
  async function bulkDuplicate() {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    setBusyKey('duplicate')
    const { data: qnums } = await supabase.from('quotes').select('quote_number').eq('user_id', user.id)
    let next = maxNumericSuffix(((qnums as { quote_number: string }[]) || []).map(n => n.quote_number)) + 1
    let created = 0
    for (const q of sel.selectedItems) {
      const { error } = await supabase.from('quotes').insert({
        quote_number: generateQuoteNumber(next), user_id: user.id, status: 'draft', issued_date: localTodayISO(),
        customer_id: q.customer_id, customer_name: q.customer_name, address: q.address,
        service_type: q.service_type, service_template_id: q.service_template_id,
        initial_price: q.initial_price, weekly_price: q.weekly_price, biweekly_price: q.biweekly_price, monthly_price: q.monthly_price,
        overgrowth_multiplier: q.overgrowth_multiplier, custom_travel_required: q.custom_travel_required,
        show_travel_separately: q.show_travel_separately, notes: q.notes, hours: q.hours, crew_size: q.crew_size,
        rate: q.rate, travel_fee: q.travel_fee, property_id: q.property_id,
        measured_sqft: q.measured_sqft, suggested_price: q.suggested_price, travel_distance_km: q.travel_distance_km,
        pricing_confidence: q.pricing_confidence,
      })
      if (!error) { created++; next++ }
    }
    setBusyKey(null); sel.clear(); router.refresh()
    toast.success(`Duplicated ${created} quote${created !== 1 ? 's' : ''} as drafts.`)
  }

  function bulkExport() {
    exportRowsToCsv(`quotes-${sel.count}`, sel.selectedItems, [
      { label: 'Quote #', value: q => q.quote_number },
      { label: 'Customer', value: q => q.customer_name },
      { label: 'Service', value: q => q.service_type },
      { label: 'Address', value: q => q.address },
      { label: 'Total', value: q => q.total },
      { label: 'Status', value: q => q.status },
      { label: 'Created', value: q => q.created_at },
    ])
    toast.success(`Exported ${sel.count} quote${sel.count !== 1 ? 's' : ''} to CSV.`)
  }

  // Bulk delete with full-row Undo (re-insert restores ids + relationships).
  async function bulkDelete() {
    const supabase = createClient()
    const rows = sel.selectedItems
    if (!rows.length) return
    setBusyKey('delete')
    const { error } = await supabase.from('quotes').delete().in('id', rows.map(q => q.id))
    setBusyKey(null)
    if (error) { toast.error('Could not delete: ' + error.message); return }
    sel.clear(); router.refresh()
    // Restore must OMIT the GENERATED columns (man_hours/subtotal/total) — Postgres
    // rejects an insert that supplies them, so the old `({ ...q }) => q` no-op made this
    // Undo fail EVERY time: the toast dismissed, router.refresh() ran, and the quotes were
    // gone with no error. Same omit the single-quote delete already does (quotes/page.tsx:69).
    const insertable = rows.map(q => {
      const row = { ...(q as unknown as Record<string, unknown>) }
      delete row.man_hours; delete row.subtotal; delete row.total
      return row
    })
    toast.undo(`Deleted ${rows.length} quote${rows.length !== 1 ? 's' : ''}`, async () => {
      const { error: rErr } = await supabase.from('quotes').insert(insertable)
      if (rErr) { toast.error('Could not restore the quotes: ' + rErr.message); return }
      router.refresh()
    })
  }

  const bulkActions: BulkAction[] = [
    { key: 'send', label: 'Send', icon: Send, tone: 'primary', onClick: bulkSend },
    { key: 'convert', label: 'Convert to invoice', icon: FileText, onClick: bulkConvert },
    { key: 'duplicate', label: 'Duplicate', icon: Copy, onClick: bulkDuplicate },
    { key: 'export', label: 'Export', icon: Download, onClick: bulkExport },
    { key: 'delete', label: 'Delete', icon: Trash2, tone: 'danger', onClick: bulkDelete },
  ]

  return (
    <div className="space-y-4">
      {/* Filters — THE shared SearchInput + FilterPill (one chip shape app-wide) */}
      <div className="flex flex-col sm:flex-row gap-3">
        <SearchInput
          ref={searchRef}
          className="flex-1"
          placeholder="Search quotes…  ( / )"
          onKeyDown={e => { if (e.key === 'Escape') { setSearch(''); e.currentTarget.blur() } }}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {/* One scrollable row on phones (the wrap made a 3-row wall of pills
            before any quotes); wraps normally on desktop. */}
        <div className="flex items-center gap-1.5 flex-nowrap overflow-x-auto sm:flex-wrap sm:overflow-visible pb-1 sm:pb-0">
          {/* Follow-up queue toggle — FilterPill geometry, but it keeps its amber
              identity (amber = follow-up everywhere), so no accent pill-glow. */}
          {followUpCount > 0 && (
            <FilterPill active={followUpOnly} onClick={() => setFollowUpOnly(v => !v)}
              className={followUpOnly ? '!bg-amber-400 !border-amber-400' : '!border-amber-500/30 !bg-amber-500/10 !text-amber-400 hover:!bg-amber-500/20'}>
              <Bell className="w-3 h-3" /> Follow up <span className="tabular-nums">({followUpCount})</span>
            </FilterPill>
          )}
          {STATUS_FILTERS.map(f => (
            <FilterPill key={f.value} active={statusFilter === f.value} onClick={() => setStatusFilter(f.value)}>
              {f.label}
            </FilterPill>
          ))}
        </div>
      </div>

      {/* Shared bulk-action bar + select-all (same system as every list) */}
      <BulkActionBar count={sel.count} actions={bulkActions} onClear={sel.clear} busyKey={busyKey} />
      <SelectAllToggle allSelected={sel.allSelected} onToggle={sel.toggleAll} count={filtered.length} noun="quote" />

      {/* Table */}
      {filtered.length === 0 ? (
        quotes.length === 0 ? (
          // Truly empty (not just a filter miss) → lead to the next action.
          <Card>
            <EmptyState icon={FileText} title="No quotes yet"
              description="Create your first quote — measure the lawn, pick a service, and send it in minutes."
              action={{ label: 'New quote', onClick: () => router.push('/dashboard/quotes/new') }} />
          </Card>
        ) : (
          <Card><InlineEmpty>No quotes match your filters.</InlineEmpty></Card>
        )
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="w-10 px-3 py-3" aria-label="Select" />
                  <th className="text-left px-3 sm:px-5 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wide hidden sm:table-cell">Quote #</th>
                  <th className="text-left px-3 sm:px-5 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wide">Customer</th>
                  <th className="text-left px-3 sm:px-5 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wide hidden md:table-cell">Service</th>
                  <th className="text-left px-3 sm:px-5 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wide">Total</th>
                  <th className="text-left px-3 sm:px-5 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wide">Status</th>
                  <th className="text-left px-3 sm:px-5 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wide hidden lg:table-cell">Date</th>
                  <th className="px-3 sm:px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map(q => (
                  <tr key={q.id} {...hoverIntent(() => router.prefetch(`/dashboard/quotes/${q.id}`))}
                    onClick={() => router.push(`/dashboard/quotes/${q.id}`)}
                    className="hover:bg-surface-raised transition-colors group cursor-pointer">
                    <td className="px-3 py-3.5" onClick={e => e.stopPropagation()}>
                      <SelectCheckbox checked={sel.isSelected(q.id)} onToggle={shift => sel.toggle(q.id, shift)} />
                    </td>
                    {/* Hidden on phones — the follow-up state it carried is already
                        shown as "Sent Xd ago · follow up" under the customer name. */}
                    <td className="px-3 sm:px-5 py-3.5 font-mono text-xs text-ink-muted hidden sm:table-cell">
                      <span className="flex items-center gap-1.5">
                        {/* An expired quote is NOT a follow-up: the automatic chaser
                            has stopped on it, so the dot would promise work the app
                            has already abandoned. Show why instead. */}
                        {/* The dot means "there is work here for you". A quote whose
                            customer can't be messaged fails that test the same way an
                            expired one does — the chaser has no way to act on it — so
                            it goes grey and says why rather than amber and beckoning. */}
                        {needsFollowUp(q) && !isQuoteExpired(q, localTodayISO()) && (
                          blockedFor(q)
                            ? <span className="w-1.5 h-1.5 rounded-full bg-ink-faint/50 shrink-0" title={describeSkip(blockedFor(q)).label} />
                            : <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Needs follow-up" />
                        )}
                        {q.quote_number}
                        {isQuoteExpired(q, localTodayISO()) && (
                          <span className="text-[9px] font-semibold uppercase tracking-wide text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-1 py-0.5 shrink-0" title={`Expired ${formatDate(q.valid_until!)}`}>Expired</span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 sm:px-5 py-3.5 font-medium text-ink">
                      {/* A real link makes the row keyboard-operable (the row's own
                          onClick only serves the mouse) and gives it an accessible name. */}
                      <Link href={`/dashboard/quotes/${q.id}`} onClick={e => e.stopPropagation()}
                        className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 hover:text-accent-text transition-colors">
                        {q.customer_name}
                      </Link>
                      {/* "Sent 12d ago · follow up" is a promise the app can only keep
                          if a message can actually go out. When it can't, say so and
                          point at the fix instead — chasing a customer with no phone
                          and no email is not work the owner can do, and on the live
                          book that was 6 of 9 rows in this very queue. */}
                      {needsFollowUp(q) && q.sent_at && (() => {
                        const blocked = blockedFor(q)
                        if (!blocked) return (
                          <span className="block text-[10px] font-semibold text-amber-400 mt-0.5">Sent {daysSince(q.sent_at)}d ago · follow up</span>
                        )
                        return (
                          <Link href={`/dashboard/customers/${q.customer_id}`} onClick={e => e.stopPropagation()}
                            className="block text-[10px] font-semibold text-ink-muted hover:text-ink mt-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                            Sent {daysSince(q.sent_at)}d ago · {describeSkip(blocked).label} →
                          </Link>
                        )
                      })()}
                    </td>
                    <td className="px-3 sm:px-5 py-3.5 text-ink-muted hidden md:table-cell">{q.service_type}</td>
                    <td className="px-3 sm:px-5 py-3.5 font-semibold text-ink tabular-nums">{formatCurrency(q.total)}</td>
                    {/* The send/expiry stamps go with the row so the shared patch can
                        leave an existing one alone, and the total so a status flip to
                        Accepted snapshots what was bought rather than nothing. */}
                    <td className="px-3 sm:px-5 py-3.5" onClick={e => e.stopPropagation()}>
                      <QuoteStatusControl quoteId={q.id} status={q.status} followUpCount={q.follow_up_count}
                        sentAt={q.sent_at} validUntil={q.valid_until} total={q.total} />
                    </td>
                    <td className="px-3 sm:px-5 py-3.5 text-ink-faint hidden lg:table-cell">{formatDate(q.created_at)}</td>
                    <td className="px-3 sm:px-5 py-3.5" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-1 justify-end">
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => handleDelete(q.id)}
                          loading={deleting === q.id}
                          title="Delete quote"
                          aria-label="Delete quote"
                          className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                        {/* No arrow button — the whole row navigates (one less
                            tap target squeezing phone rows). */}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}