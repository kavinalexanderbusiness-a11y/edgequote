'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Invoice, InvoiceStatus, INVOICE_STATUS_LABELS, INVOICE_STATUS_COLORS, BusinessSettings } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { formatCurrency, formatDate } from '@/lib/utils'
import { FileText, User, Check, FileDown } from 'lucide-react'

const STATUS_CYCLE: InvoiceStatus[] = ['unpaid', 'sent', 'paid']

export default function InvoicesPage() {
  const supabase = createClient()
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [openingId, setOpeningId] = useState<string | null>(null)

  async function fetchInvoices() {
    const { data: { user } } = await supabase.auth.getUser()
    const [iRes, sRes] = await Promise.all([
      supabase
        .from('invoices')
        .select('*, customers(id, name, email, phone)')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false }),
      supabase.from('business_settings').select('*').eq('user_id', user!.id).maybeSingle(),
    ])
    setInvoices((iRes.data as Invoice[]) || [])
    setSettings(sRes.data as BusinessSettings | null)
    setLoading(false)
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
    await supabase.from('invoices').update({ status: next }).eq('id', inv.id)
  }

  const outstanding = invoices
    .filter(i => i.status !== 'paid')
    .reduce((sum, i) => sum + Number(i.amount || 0), 0)
  const paidTotal = invoices
    .filter(i => i.status === 'paid')
    .reduce((sum, i) => sum + Number(i.amount || 0), 0)

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Invoices"
        description={`${invoices.length} invoice${invoices.length !== 1 ? 's' : ''}`}
      />

      {!loading && invoices.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
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

      {loading ? (
        <div className="text-center py-16 text-sm text-ink-muted">Loading invoices...</div>
      ) : invoices.length === 0 ? (
        <div className="text-center py-16 text-sm text-ink-muted">
          No invoices yet. Open an accepted quote and click <span className="font-medium text-ink">Convert to Invoice</span>.
        </div>
      ) : (
        <div className="space-y-3">
          {invoices.map(inv => (
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