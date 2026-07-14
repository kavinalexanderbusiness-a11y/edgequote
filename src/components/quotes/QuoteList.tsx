'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useListShortcuts } from '@/hooks/useListShortcuts'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { hoverIntent } from '@/lib/prefetch'
import { Quote, QuoteStatus } from '@/types'
import { formatCurrency, formatDate, generateQuoteNumber, localTodayISO, maxNumericSuffix } from '@/lib/utils'
import { needsFollowUp, daysSince, compareFollowUp } from '@/lib/followup'
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

export function QuoteList({ quotes, onDelete }: QuoteListProps) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'' | QuoteStatus>('')
  const [followUpOnly, setFollowUpOnly] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // '/' focuses search, 'n' starts a new quote — the shared list idiom.
  useListShortcuts({ search: searchRef, onNew: () => router.push('/dashboard/quotes/new') })

  // Date math over every quote — memoized so it doesn't re-run on each search keystroke.
  const followUpCount = useMemo(() => quotes.filter(needsFollowUp).length, [quotes])

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
          if (q.status === 'draft') {
            await supabase.from('quotes').update({ status: 'sent' }).eq('id', q.id)
            await supabase.from('quotes').update({ sent_at: new Date().toISOString() }).eq('id', q.id).is('sent_at', null)
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
    toast.undo(`Deleted ${rows.length} quote${rows.length !== 1 ? 's' : ''}`, async () => {
      await supabase.from('quotes').insert(rows.map(({ ...q }) => q))
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
                        {needsFollowUp(q) && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Needs follow-up" />}
                        {q.quote_number}
                      </span>
                    </td>
                    <td className="px-3 sm:px-5 py-3.5 font-medium text-ink">
                      {q.customer_name}
                      {needsFollowUp(q) && q.sent_at && (
                        <span className="block text-[10px] font-semibold text-amber-400 mt-0.5">Sent {daysSince(q.sent_at)}d ago · follow up</span>
                      )}
                    </td>
                    <td className="px-3 sm:px-5 py-3.5 text-ink-muted hidden md:table-cell">{q.service_type}</td>
                    <td className="px-3 sm:px-5 py-3.5 font-semibold text-ink tabular-nums">{formatCurrency(q.total)}</td>
                    <td className="px-3 sm:px-5 py-3.5" onClick={e => e.stopPropagation()}><QuoteStatusControl quoteId={q.id} status={q.status} followUpCount={q.follow_up_count} /></td>
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