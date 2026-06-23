'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Customer } from '@/types'
import { formatDate, getInitials, cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { ensurePortalToken, portalUrl } from '@/lib/portal'
import { applyConsent, SMS_CONSENT_WARNING, ConsentChannel } from '@/lib/consent'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Edit2, Trash2, Phone, Mail, FileText, Search, Link2, ExternalLink, Check, MessageSquare, ShieldAlert } from 'lucide-react'

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
}

export function CustomerList({ customers, onEdit, onDelete, onRefresh }: CustomerListProps) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [consentFilter, setConsentFilter] = useState<ConsentFilter>('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [portalBusy, setPortalBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [smsConfirm, setSmsConfirm] = useState(false)

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
  const filtered = customers.filter(c =>
    (c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.email?.toLowerCase().includes(search.toLowerCase()) ||
      c.city?.toLowerCase().includes(search.toLowerCase())) && matchesConsent(c)
  )

  // Missing-consent report — over ALL customers, not the filtered view.
  const total = customers.length
  const smsIn = customers.filter(c => c.sms_opt_in).length
  const emailIn = customers.filter(c => c.email_opt_in).length

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(null), 2600) }

  const allFilteredSelected = filtered.length > 0 && filtered.every(c => selected.has(c.id))
  function toggleSelect(id: string) {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function toggleSelectAll() { setSelected(allFilteredSelected ? new Set() : new Set(filtered.map(c => c.id))) }

  async function runBulk(channel: ConsentChannel, value: boolean) {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const targets = customers.filter(c => selected.has(c.id)).map(c => ({ id: c.id, sms_opt_in: c.sms_opt_in, email_opt_in: c.email_opt_in }))
    if (!targets.length) return
    setBulkBusy(true)
    const res = await applyConsent(supabase, { targets, channel, value, userId: user.id, changedBy: user.email || user.id, source: 'bulk' })
    setBulkBusy(false)
    if (res.error) { showToast('Could not update consent. Please try again.'); return }
    showToast(`${channel === 'sms' ? 'SMS' : 'Email'} consent ${value ? 'enabled' : 'disabled'} for ${res.changed} customer${res.changed !== 1 ? 's' : ''}.`)
    setSelected(new Set())
    await onRefresh()
  }
  // Enabling SMS always routes through an explicit confirmation first.
  function requestBulk(channel: ConsentChannel, value: boolean) {
    if (channel === 'sms' && value) { setSmsConfirm(true); return }
    runBulk(channel, value)
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this customer? Their quote history will be preserved.')) return
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
      if (!token) { showToast('Could not create the portal link — run the customer-portal migration first.'); return }
      const url = portalUrl(token)
      try { await navigator.clipboard.writeText(url) } catch { window.prompt('Copy this portal link:', url) }
      showToast('Portal link copied to clipboard')
    } finally { setPortalBusy(null) }
  }
  async function openPortal(customerId: string) {
    setPortalBusy(customerId)
    try {
      const token = await getToken(customerId)
      if (!token) { showToast('Could not create the portal link — run the customer-portal migration first.'); return }
      window.open(portalUrl(token), '_blank', 'noopener')
    } finally { setPortalBusy(null) }
  }

  return (
    <div className="space-y-4">
      {/* Missing Consent Report */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <ReportStat label="Customers" value={total} />
        <ReportStat label="SMS opted in" value={smsIn} tone="text-emerald-400" />
        <ReportStat label="SMS opted out" value={total - smsIn} />
        <ReportStat label="Email opted in" value={emailIn} tone="text-emerald-400" />
        <ReportStat label="Email opted out" value={total - emailIn} />
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint" />
        <input
          type="text"
          placeholder="Search customers..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-surface border border-border-strong rounded-xl pl-10 pr-4 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
        />
      </div>

      {/* Consent filters */}
      <div className="flex flex-wrap gap-1.5">
        {CONSENT_FILTERS.map(f => (
          <button key={f.value} onClick={() => setConsentFilter(f.value)}
            className={cn('px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
              consentFilter === f.value ? 'bg-accent text-black border-accent' : 'bg-surface border-border-strong text-ink-muted hover:text-ink')}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-20 flex items-center gap-2 flex-wrap bg-bg-secondary border border-accent/40 rounded-xl px-4 py-2.5 shadow-lg">
          <span className="text-sm font-semibold text-ink">{selected.size} selected</span>
          <span className="text-xs text-ink-faint">consent:</span>
          <Button size="sm" variant="secondary" loading={bulkBusy} onClick={() => requestBulk('email', true)}><Mail className="w-3.5 h-3.5" /> Email on</Button>
          <Button size="sm" variant="ghost" onClick={() => requestBulk('email', false)}>Email off</Button>
          <Button size="sm" variant="secondary" loading={bulkBusy} onClick={() => requestBulk('sms', true)}><MessageSquare className="w-3.5 h-3.5" /> SMS on</Button>
          <Button size="sm" variant="ghost" onClick={() => requestBulk('sms', false)}>SMS off</Button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-xs font-medium text-ink-faint hover:text-ink">Clear</button>
        </div>
      )}

      {/* Select all */}
      {filtered.length > 0 && (
        <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer select-none">
          <input type="checkbox" checked={allFilteredSelected} onChange={toggleSelectAll} className="w-4 h-4 rounded border-border-strong accent-accent" />
          Select all {filtered.length}
        </label>
      )}

      {/* List */}
      {filtered.length === 0 ? (
        <Card className="py-14 text-center text-sm text-ink-muted">
          {search || consentFilter ? 'No customers match your filters.' : 'No customers yet.'}
        </Card>
      ) : (
        <div className="grid gap-3">
          {filtered.map(c => (
            <Card key={c.id} className={cn('flex items-center gap-3 px-5 py-4 transition-colors', selected.has(c.id) ? 'border-accent/50' : 'hover:border-border-strong')}>
              <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)}
                className="w-4 h-4 rounded border-border-strong accent-accent shrink-0" title="Select" />
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
                    <span className="text-[10px] uppercase tracking-wide text-accent border border-accent/30 bg-accent/10 rounded px-1.5 py-0.5">{c.acquisition_source}</span>
                  )}
                </div>
              </div>
              {/* Added */}
              <p className="text-xs text-ink-faint hidden md:block">{formatDate(c.created_at)}</p>
              {/* Actions */}
              <div className="flex items-center gap-1">
                <Button variant="secondary" size="sm" onClick={() => copyPortal(c.id)} loading={portalBusy === c.id}
                  title="Copy this customer's private portal link (quotes, invoices, history, photos)">
                  <Link2 className="w-4 h-4" /> Portal
                </Button>
                <Button variant="ghost" size="sm" onClick={() => openPortal(c.id)} title="Open the customer portal in a new tab">
                  <ExternalLink className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => router.push(`/dashboard/quotes/new?customer=${c.id}`)} title="New quote">
                  <FileText className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => onEdit(c)} title="Edit">
                  <Edit2 className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => handleDelete(c.id)} loading={deleting === c.id} className="hover:text-red-400" title="Delete">
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      <p className="text-xs text-ink-faint text-right">{filtered.length} customer{filtered.length !== 1 ? 's' : ''}</p>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-bg-secondary border border-border-strong rounded-full px-4 py-2 text-sm text-ink shadow-lg flex items-center gap-2">
          <Check className="w-4 h-4 text-emerald-400 shrink-0" /> {toast}
        </div>
      )}

      {/* SMS safety confirmation */}
      {smsConfirm && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setSmsConfirm(false)}>
          <div className="bg-bg-secondary border border-border-strong rounded-card max-w-md w-full p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-bold text-amber-400 flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> Enable SMS consent?</p>
            <p className="text-sm text-ink-muted">{SMS_CONSENT_WARNING}</p>
            <p className="text-xs text-ink-faint">This enables SMS for {selected.size} selected customer{selected.size !== 1 ? 's' : ''}.</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setSmsConfirm(false)}>Cancel</Button>
              <Button size="sm" onClick={() => { setSmsConfirm(false); runBulk('sms', true) }}>I confirm — enable SMS</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ReportStat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={cn('text-lg font-bold', tone || 'text-ink')}>{value}</p>
    </div>
  )
}
