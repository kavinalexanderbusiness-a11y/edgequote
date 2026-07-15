'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Customer } from '@/types'
import { formatDate, getInitials, cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { prefetchCustomer, hoverIntent } from '@/lib/prefetch'
import { ensurePortalToken, portalUrl } from '@/lib/portal'
import { applyConsent, SMS_CONSENT_WARNING, ConsentChannel } from '@/lib/consent'
import { toast as notify } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'
import { useBulkSelect } from '@/hooks/useBulkSelect'
import { useListShortcuts } from '@/hooks/useListShortcuts'
import { BulkActionBar, SelectCheckbox, SelectAllToggle, type BulkAction } from '@/components/ui/BulkActions'
import { SendMessageDialog } from '@/components/comms/SendMessageDialog'
import type { MsgType } from '@/lib/comms/templates'
import { exportRowsToCsv } from '@/lib/csv'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Menu } from '@/components/ui/Menu'
import { FilterPill } from '@/components/ui/FilterPill'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SearchInput } from '@/components/ui/SearchInput'
import { Edit2, Phone, Mail, FileText, Link2, MessageSquare, ShieldAlert, Archive, Download, Send, Users, Star, Smartphone, MoreHorizontal } from 'lucide-react'

type ConsentFilter = '' | 'sms_in' | 'sms_out' | 'email_in' | 'email_out' | 'both' | 'neither'
const CONSENT_FILTERS: { value: ConsentFilter; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'sms_in', label: 'SMS opted in' },
  { value: 'sms_out', label: 'SMS opted out' },
  { value: 'email_in', label: 'Email opted in' },
  { value: 'email_out', label: 'Email opted out' },
  { value: 'both', label: 'Both' },
  { value: 'neither', label: 'Neither' },
]

interface CustomerListProps {
  customers: Customer[]
  onEdit: (customer: Customer) => void
  onDelete: (id: string) => Promise<void>
  onRefresh: () => void | Promise<void>
  /** Opens the page's Add-Customer form — powers the empty state's action. */
  onAdd?: () => void
}

export function CustomerList({ customers, onEdit, onDelete, onRefresh, onAdd }: CustomerListProps) {
  const router = useRouter()
  const searchRef = useRef<HTMLInputElement>(null)
  // '/' focuses search, 'n' opens the Add-Customer form — the shared list idiom.
  useListShortcuts({ search: searchRef, onNew: onAdd })
  const [search, setSearch] = useState('')
  const [consentFilter, setConsentFilter] = useState<ConsentFilter>('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [portalBusy, setPortalBusy] = useState<string | null>(null)
  // Which template the Send-Message dialog opens on (null = closed; 'choose' = let the
  // owner pick). Lets "Send introduction" / "Review request" be one-tap entries into
  // THE same dialog instead of separate UIs.
  const [msgTemplate, setMsgTemplate] = useState<'choose' | MsgType | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  function matchesConsent(c: Customer): boolean {
    switch (consentFilter) {
      case 'sms_in': return c.sms_opt_in
      case 'sms_out': return !c.sms_opt_in
      case 'email_in': return c.email_opt_in
      case 'email_out': return !c.email_opt_in
      case 'both': return c.sms_opt_in && c.email_opt_in
      case 'neither': return !c.sms_opt_in && !c.email_opt_in
      default: return true
    }
  }
  // Memoized so typing in a search box or ticking a bulk-select checkbox (which
  // changes unrelated state) doesn't re-run these O(n) passes over every customer.
  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return customers.filter(c =>
      (c.name.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.city?.toLowerCase().includes(q)) && matchesConsent(c)
    )
  }, [customers, search, consentFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  // Missing-consent report — over ALL customers, not the filtered view.
  const total = customers.length
  const { smsIn, emailIn } = useMemo(() => ({
    smsIn: customers.filter(c => c.sms_opt_in).length,
    emailIn: customers.filter(c => c.email_opt_in).length,
  }), [customers])

  // Shared multi-select — same behavior as every other list.
  const sel = useBulkSelect(filtered)

  async function runBulk(channel: ConsentChannel, value: boolean) {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const targets = sel.selectedItems.map(c => ({ id: c.id, sms_opt_in: c.sms_opt_in, email_opt_in: c.email_opt_in }))
    if (!targets.length) return
    setBusyKey(channel === 'sms' ? 'sms-on' : 'email-on')
    const res = await applyConsent(supabase, { targets, channel, value, userId: user.id, changedBy: user.email || user.id, source: 'bulk' })
    setBusyKey(null)
    if (res.error) { notify.error('Could not update consent. Please try again.'); return }
    notify.success(`${channel === 'sms' ? 'SMS' : 'Email'} consent ${value ? 'enabled' : 'disabled'} for ${res.changed} customer${res.changed !== 1 ? 's' : ''}.`)
    sel.clear()
    await onRefresh()
  }
  // Enabling SMS always routes through an explicit confirmation first — THE shared
  // confirm dialog (same title/message/handler as before, one confirm experience app-wide).
  async function requestBulk(channel: ConsentChannel, value: boolean) {
    if (channel === 'sms' && value) {
      const ok = await confirmDialog({
        title: 'Enable SMS consent?',
        icon: ShieldAlert,
        confirmLabel: 'Enable SMS',
        message: (
          <>
            <p>{SMS_CONSENT_WARNING}</p>
            <p className="text-xs text-ink-faint mt-2">This enables SMS for {sel.count} selected customer{sel.count !== 1 ? 's' : ''}.</p>
          </>
        ),
      })
      if (!ok) return
    }
    runBulk(channel, value)
  }

  // Bulk archive — reversible, with the shared Undo pattern (restores archived_at=null).
  async function bulkArchive() {
    const ids = sel.selectedItems.map(c => c.id)
    if (!ids.length) return
    const supabase = createClient()
    setBusyKey('archive')
    const { error } = await supabase.from('customers').update({ archived_at: new Date().toISOString() }).in('id', ids)
    setBusyKey(null)
    if (error) { notify.error('Could not archive: ' + error.message); return }
    sel.clear()
    await onRefresh()
    notify.undo(`Archived ${ids.length} customer${ids.length !== 1 ? 's' : ''}`, async () => {
      await supabase.from('customers').update({ archived_at: null }).in('id', ids); await onRefresh()
    })
  }

  function exportSelected() {
    const rows = sel.selectedItems
    if (!rows.length) return
    exportRowsToCsv(`customers-${rows.length}`, rows, [
      { label: 'Name', value: c => c.name },
      { label: 'Email', value: c => c.email },
      { label: 'Phone', value: c => c.phone },
      { label: 'Address', value: c => c.address },
      { label: 'City', value: c => c.city },
      { label: 'Province', value: c => c.province },
      { label: 'SMS opt-in', value: c => (c.sms_opt_in ? 'yes' : 'no') },
      { label: 'Email opt-in', value: c => (c.email_opt_in ? 'yes' : 'no') },
      { label: 'Source', value: c => c.acquisition_source },
      { label: 'Added', value: c => c.created_at },
    ])
    notify.success(`Exported ${rows.length} customer${rows.length !== 1 ? 's' : ''} to CSV.`)
  }

  const bulkActions: BulkAction[] = [
    { key: 'message', label: 'Message', icon: Send, tone: 'primary', onClick: () => setMsgTemplate('choose') },
    // One-tap entries into THE same dialog, preselected — not separate UIs.
    { key: 'introduction', label: 'Send introduction', icon: MessageSquare, onClick: () => setMsgTemplate('introduction') },
    { key: 'review', label: 'Send review request', icon: Star, onClick: () => setMsgTemplate('review_request') },
    { key: 'archive', label: 'Archive', icon: Archive, onClick: bulkArchive },
    { key: 'export', label: 'Export', icon: Download, onClick: exportSelected },
    { key: 'email-on', label: 'Enable email', icon: Mail, onClick: () => requestBulk('email', true) },
    { key: 'sms-on', label: 'Enable SMS', icon: Smartphone, onClick: () => requestBulk('sms', true) },
  ]

  async function handleDelete(id: string) {
    // The page runs a record-aware safety check + an accurate confirmation
    // (archives the customer when any history exists, rather than destroying it).
    setDeleting(id)
    await onDelete(id)
    setDeleting(null)
  }

  async function getToken(customerId: string): Promise<string | null> {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null
    return ensurePortalToken(supabase, user.id, customerId)
  }
  async function copyPortal(customerId: string) {
    setPortalBusy(customerId)
    try {
      const token = await getToken(customerId)
      if (!token) { notify.error('Could not create the portal link — run the customer-portal migration first.'); return }
      const url = portalUrl(token)
      try { await navigator.clipboard.writeText(url) } catch { notify('Portal link (copy manually): ' + url, { duration: 20000 }) }
      notify.success('Portal link copied to clipboard')
    } finally { setPortalBusy(null) }
  }

  return (
    <div className="space-y-4">
      {/* Search — THE shared SearchInput */}
      <SearchInput
        ref={searchRef}
        placeholder="Search customers…  ( / )"
        value={search}
        onChange={e => setSearch(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') { setSearch(''); e.currentTarget.blur() } }}
      />

      {/* Consent filters — the shared FilterPill (aria-pressed + focus ring built in) */}
      <div className="flex flex-wrap gap-1.5">
        {CONSENT_FILTERS.map(f => (
          <FilterPill key={f.value} active={consentFilter === f.value} onClick={() => setConsentFilter(f.value)}>
            {f.label}
          </FilterPill>
        ))}
      </div>

      {/* Shared bulk action bar — same everywhere */}
      <BulkActionBar count={sel.count} actions={bulkActions} onClear={sel.clear} busyKey={busyKey} />

      {/* Select all */}
      <SelectAllToggle allSelected={sel.allSelected} onToggle={sel.toggleAll} count={filtered.length} noun="customer" />

      {/* List */}
      {filtered.length === 0 ? (
        customers.length === 0 ? (
          // Truly empty → lead to the next action, don't dead-end.
          <Card>
            <EmptyState icon={Users} title="No customers yet"
              description="Add your first customer, or import your existing list from a CSV in one step."
              action={onAdd ? { label: 'Add customer', onClick: onAdd } : { label: 'Import customers', onClick: () => router.push('/dashboard/customers/import') }} />
          </Card>
        ) : (
          <Card><InlineEmpty>No customers match your filters.</InlineEmpty></Card>
        )
      ) : (
        <div className="grid gap-3">
          {filtered.map((c, i) => (
            <Card key={c.id} {...hoverIntent(() => prefetchCustomer(c.id))}
              className={cn('flex items-center gap-3 px-5 py-4 transition-colors card-lift animate-rise', i < 6 && `stagger-${i + 1}`, sel.isSelected(c.id) ? 'border-accent/50' : 'hover:border-border-strong')}>
              <SelectCheckbox checked={sel.isSelected(c.id)} onToggle={shift => sel.toggle(c.id, shift)} />
              {/* Avatar */}
              <div className="w-10 h-10 rounded-full bg-accent/10 border border-accent/20 flex items-center justify-center flex-shrink-0">
                <span className="text-sm font-bold text-accent">{getInitials(c.name)}</span>
              </div>
              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link href={`/dashboard/customers/${c.id}`} className="text-sm font-semibold text-ink hover:text-accent transition-colors">{c.name}</Link>
                  {c.sms_opt_in && <span className="text-[10px] uppercase tracking-wide text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-1.5 py-0.5">SMS</span>}
                  {c.email_opt_in && <span className="text-[10px] uppercase tracking-wide text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-1.5 py-0.5">Email</span>}
                </div>
                <div className="flex items-center gap-4 mt-1 flex-wrap">
                  {c.email && (
                    <a href={`mailto:${c.email}`} className="flex items-center gap-1 text-xs text-ink-muted hover:text-ink hover:underline">
                      <Mail className="w-3 h-3" /> {c.email}
                    </a>
                  )}
                  {c.phone && (
                    <a href={`tel:${c.phone}`} className="flex items-center gap-1 text-xs text-accent hover:underline">
                      <Phone className="w-3 h-3" /> {c.phone}
                    </a>
                  )}
                  {c.city && <span className="text-xs text-ink-faint">{c.city}, {c.province}</span>}
                  {c.acquisition_source && (
                    <span className="text-[10px] uppercase tracking-wide text-ink-muted border border-border rounded px-1.5 py-0.5">{c.acquisition_source}</span>
                  )}
                </div>
              </div>
              {/* Added */}
              <p className="text-xs text-ink-faint hidden md:block">{formatDate(c.created_at)}</p>
              {/* Actions — the quoting workflow's entry point stays labeled and first;
                  the secondary actions live in one shared overflow menu. */}
              <div className="flex items-center gap-1">
                <Button variant="secondary" size="sm" onClick={() => router.push(`/dashboard/quotes/new?customer=${c.id}`)} title="Start a new quote for this customer">
                  <FileText className="w-4 h-4" /> Quote
                </Button>
                <Menu align="end" width={220} items={[
                  { key: 'portal', label: 'Copy portal link', icon: Link2, onSelect: () => copyPortal(c.id) },
                  { key: 'edit', label: 'Edit customer', icon: Edit2, onSelect: () => onEdit(c) },
                  // Archive, not delete — reversible (the undo toast restores it).
                  { key: 'archive', label: 'Archive customer', icon: Archive, onSelect: () => handleDelete(c.id) },
                ]}>
                  {({ toggle, triggerProps }) => (
                    <Button size="sm" variant="ghost" onClick={toggle} aria-label="More actions" title="More actions"
                      loading={portalBusy === c.id || deleting === c.id} {...triggerProps}>
                      <MoreHorizontal className="w-4 h-4" />
                    </Button>
                  )}
                </Menu>
              </div>
            </Card>
          ))}
        </div>
      )}
      <p className="text-xs text-ink-faint text-right">{filtered.length} customer{filtered.length !== 1 ? 's' : ''}</p>

      {/* Consent overview — compliance reference, below the work surface so the
          list (what the owner came for) is never pushed a screen down. */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <ReportStat label="Customers" value={total} />
        <ReportStat label="SMS opted in" value={smsIn} tone="text-emerald-400" />
        <ReportStat label="SMS opted out" value={total - smsIn} />
        <ReportStat label="Email opted in" value={emailIn} tone="text-emerald-400" />
        <ReportStat label="Email opted out" value={total - emailIn} />
      </div>

      {/* THE shared multi-recipient Send-Message dialog — 'choose' opens on the default
          template list; a specific value ("introduction"/"review_request") preselects it. */}
      {msgTemplate && (
        <SendMessageDialog
          open
          recipients={sel.selectedItems.map(c => ({ customerId: c.id, name: c.name, phone: c.phone }))}
          title="Message customers"
          defaultTemplate={msgTemplate === 'choose' ? undefined : msgTemplate}
          onClose={sent => { setMsgTemplate(null); if (sent) sel.clear() }}
        />
      )}
    </div>
  )
}

function ReportStat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-card border border-border bg-bg-secondary px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={cn('text-lg font-bold tabular-nums', tone || 'text-ink')}>{value}</p>
    </div>
  )
}
