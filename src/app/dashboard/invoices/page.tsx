'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Invoice, InvoiceStatus, INVOICE_STATUS_LABELS, INVOICE_STATUS_COLORS, BusinessSettings } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { FileText, User, Check, FileDown, Trash2 } from 'lucide-react'

const STATUS_CYCLE: InvoiceStatus[] = ['unpaid', 'sent', 'paid']
const FILTERS: { value: '' | InvoiceStatus; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'sent', label: 'Sent' },
  { value: 'paid', label: 'Paid' },
]

export default function InvoicesPage() {
  const supabase = createClient()
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'' | InvoiceStatus>('')

  async function fetchInvoices() {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      const [iRes, sRes] = await Promise.all([
        supabase
          .from('invoices')
          .select('*, customers(id, name, email, phone)')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        supabase.from('business_settings').select('*').eq('user_id', user.id).maybeSingle(),
      ])
      // A failed fetch must NOT render as "No invoices yet" on billing day.
      if (iRes.error) { setLoadError('Could not load invoices: ' + iRes.error.message); return }
      setLoadError(null)
      setInvoices((iRes.data as Invoice[]) || [])
      setSettings(sRes.data as BusinessSettings | null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load invoices.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchInvoices() }, [])

  async function openInvoicePdf(inv: Invoice) {
    setOpeningId(inv.id)
    try {
      const { renderInvoiceBlob } = await import('@/components/quotes/InvoicePDF')
      const blob = await renderInvoiceBlob(inv, settings)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${inv.invoice_number}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    } catch {
      alert('Could not generate the invoice PDF. Please try again.')
    } finally {
      setOpeningId(null)
    }
  }

  async function cycleStatus(inv: Invoice) {
    const idx = STATUS_CYCLE.indexOf(inv.status)
    const next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length]
    setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, status: next } : i))
    const { error } = await supabase.from('invoices').update({ status: next }).eq('id', inv.id)
    if (error) { setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, status: inv.status } : i)); alert('Could not update status: ' + error.message) }
  }

  // One tap straight to paid — the most common action on billing day shouldn't
  // require cycling through "sent".
  async function markPaid(inv: Invoice) {
    setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, status: 'paid' as InvoiceStatus } : i))
    const { error } = await supabase.from('invoices').update({ status: 'paid' }).eq('id', inv.id)
    if (error) { setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, status: inv.status } : i)); alert('Could not update status: ' + error.message) }
  }

  // ── Undo (same pattern as the Schedule page) ──
  const [undoAction, setUndoAction] = useState<{ label: string; run: () => Promise<void> } | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function offerUndo(label: string, run: () => Promise<void>) {
    setUndoAction({ label, run })
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = setTimeout(() => setUndoAction(null), 8000)
  }
  async function runUndo() {
    const a = undoAction
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndoAction(null)
    if (a) { await a.run(); await fetchInvoices() }
  }

  // Insertable row (strips the joined customers object) so Undo can restore the
  // invoice with the SAME id — every relationship (job, quote, customer,
  // property) reconnects exactly as it was. The job itself is never touched.
  function invoiceInsertRow(i: Invoice) {
    return {
      id: i.id, user_id: i.user_id, quote_id: i.quote_id, customer_id: i.customer_id,
      property_id: i.property_id, job_id: i.job_id, invoice_number: i.invoice_number,
      customer_name: i.customer_name, address: i.address, service_type: i.service_type,
      amount: i.amount, status: i.status, issued_date: i.issued_date, due_date: i.due_date,
      notes: i.notes,
    }
  }

  // Delete any invoice — confirm first, with a stronger warning for Paid
  // (it's part of your collected-revenue history). Undo restores it fully.
  async function deleteInvoice(inv: Invoice) {
    const msg = inv.status === 'paid'
      ? `${inv.invoice_number} is PAID (${formatCurrency(Number(inv.amount))}) — deleting it removes collected revenue from your records. Delete anyway?`
      : `Delete ${inv.invoice_number} (${formatCurrency(Number(inv.amount))})?`
    if (!confirm(msg)) return
    setDeletingId(inv.id)
    const row = invoiceInsertRow(inv)
    const { error } = await supabase.from('invoices').delete().eq('id', inv.id)
    if (error) alert('Could not delete: ' + error.message)
    else {
      setInvoices(prev => prev.filter(i => i.id !== inv.id))
      offerUndo(`Deleted ${inv.invoice_number}`, async () => { await supabase.from('invoices').insert(row) })
    }
    setDeletingId(null)
  }

  const drafts = invoices.filter(i => i.status === 'draft')
  const draftsTotal = drafts.reduce((sum, i) => sum + Number(i.amount || 0), 0)
  const outstanding = invoices
    .filter(i => i.status === 'unpaid' || i.status === 'sent')
    .reduce((sum, i) => sum + Number(i.amount || 0), 0)
  const paidTotal = invoices
    .filter(i => i.status === 'paid')
    .reduce((sum, i) => sum + Number(i.amount || 0), 0)
  const visible = filter ? invoices.filter(i => i.status === filter) : invoices

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Invoices"
        description={`${invoices.length} invoice${invoices.length !== 1 ? 's' : ''}`}
      />

      {loadError && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5">
          {loadError} <button onClick={() => { setLoading(true); fetchInvoices() }} className="underline font-medium ml-1">Retry</button>
        </div>
      )}

      {/* Undo toast — restore the last deleted invoice */}
      {undoAction && (
        <div className="flex items-center justify-between gap-3 text-sm bg-ink text-bg border border-border-strong rounded-xl px-4 py-2.5 shadow-lg">
          <span className="font-medium">{undoAction.label}</span>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={runUndo} className="font-bold underline">Undo</button>
            <button onClick={() => setUndoAction(null)} className="opacity-60 hover:opacity-100">✕</button>
          </div>
        </div>
      )}

      {!loading && !loadError && invoices.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {/* Drafts are the auto-invoiced recurring pipeline — they were invisible
              (Outstanding only counts unpaid/sent) and silently went unsent. */}
          <button onClick={() => setFilter(filter === 'draft' ? '' : 'draft')} className="text-left">
            <Card className={cn(filter === 'draft' && 'border-accent/50')}>
              <CardBody>
                <p className="text-xs text-ink-faint uppercase tracking-wide font-semibold mb-1">Drafts to review</p>
                <p className={cn('text-2xl font-bold', drafts.length ? 'text-sky-400' : 'text-ink-faint')}>{drafts.length ? formatCurrency(draftsTotal) : '—'}</p>
                {drafts.length > 0 && <p className="text-[11px] text-ink-faint mt-0.5">{drafts.length} draft{drafts.length !== 1 ? 's' : ''} — tap to review</p>}
              </CardBody>
            </Card>
          </button>
          <Card>
            <CardBody>
              <p className="text-xs text-ink-faint uppercase tracking-wide font-semibold mb-1">Outstanding</p>
              <p className="text-2xl font-bold text-amber-400">{formatCurrency(outstanding)}</p>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <p className="text-xs text-ink-faint uppercase tracking-wide font-semibold mb-1">Paid</p>
              <p className="text-2xl font-bold text-accent">{formatCurrency(paidTotal)}</p>
            </CardBody>
          </Card>
        </div>
      )}

      {!loading && !loadError && invoices.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {FILTERS.map(f => (
            <button key={f.value} onClick={() => setFilter(f.value)}
              className={cn('px-3.5 py-2 rounded-lg text-xs font-medium border transition-colors',
                filter === f.value ? 'bg-accent text-black border-accent' : 'bg-surface border-border-strong text-ink-muted hover:text-ink')}>
              {f.label}{f.value === 'draft' && drafts.length > 0 ? ` (${drafts.length})` : ''}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-sm text-ink-muted">Loading invoices...</div>
      ) : loadError ? null : invoices.length === 0 ? (
        <div className="text-center py-16 text-sm text-ink-muted">
          No invoices yet. Completing a recurring visit drafts one automatically — or open an accepted quote and click <span className="font-medium text-ink">Convert to Invoice</span>.
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-12 text-sm text-ink-muted">No {filter} invoices.</div>
      ) : (
        <div className="space-y-3">
          {visible.map(inv => (
            <Card key={inv.id}>
              <CardBody>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
                      <FileText className="w-4 h-4 text-accent" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-ink">{inv.invoice_number}</p>
                        <span className="text-xs text-ink-faint">{formatDate(inv.issued_date || inv.created_at)}</span>
                      </div>
                      <p className="text-xs text-ink-muted flex items-center gap-1 mt-0.5">
                        <User className="w-3 h-3" /> {inv.customer_name}
                      </p>
                      {inv.service_type && <p className="text-xs text-ink-faint mt-0.5 truncate">{inv.service_type}</p>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-lg font-bold text-ink">{formatCurrency(Number(inv.amount))}</span>
                    <Button onClick={() => openInvoicePdf(inv)} variant="secondary" size="sm" loading={openingId === inv.id}>
                      <FileDown className="w-3.5 h-3.5" /> PDF
                    </Button>
                    <button
                      onClick={() => cycleStatus(inv)}
                      title="Click to change status"
                      className={`text-[10px] px-2.5 py-1 rounded-full border uppercase tracking-wide font-semibold flex items-center gap-1 transition-opacity hover:opacity-80 ${INVOICE_STATUS_COLORS[inv.status]}`}
                    >
                      {inv.status === 'paid' && <Check className="w-3 h-3" />}
                      {INVOICE_STATUS_LABELS[inv.status]}
                    </button>
                    {(inv.status === 'unpaid' || inv.status === 'sent') && (
                      <Button onClick={() => markPaid(inv)} variant="secondary" size="sm" title="Mark paid">
                        <Check className="w-3.5 h-3.5" /> Paid
                      </Button>
                    )}
                    <Button onClick={() => deleteInvoice(inv)} variant="ghost" size="sm" loading={deletingId === inv.id}
                      className="hover:text-red-400" title="Delete invoice">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}