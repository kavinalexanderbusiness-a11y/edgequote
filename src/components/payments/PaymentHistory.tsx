'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardBody } from '@/components/ui/Card'
import { formatCurrency, formatDate } from '@/lib/utils'
import { paymentMethodLabel, type Payment, type Invoice, type BusinessSettings } from '@/types'
import { receiptNumberFor } from '@/lib/payments/ledger'
import { toast } from '@/lib/toast'
import { Wallet, FileDown, Loader2 } from 'lucide-react'

type PaymentRow = Payment & { invoices?: (Partial<Invoice> & { invoice_number: string }) | null }

// The payment TIMELINE — every ledger movement (manual, Stripe, AutoPay, credits,
// refunds), newest first, each invoice-linked payment with a one-click receipt PDF.
// One source (the payments ledger), one receipt engine — an accountant can pull a
// receipt for ANY payment ever recorded, not just the one they just entered.
export function PaymentHistory({ settings }: { settings?: BusinessSettings | null }) {
  const supabase = createClient()
  const [rows, setRows] = useState<PaymentRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [receiptId, setReceiptId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { if (active) setLoaded(true); return }
      const { data } = await supabase.from('payments')
        .select('*, invoices(*)')
        .eq('user_id', user.id).order('created_at', { ascending: false }).limit(25)
      if (active) { setRows((data as unknown as PaymentRow[]) || []); setLoaded(true) }
    })()
    return () => { active = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function downloadReceipt(r: PaymentRow) {
    if (!r.invoices) return
    setReceiptId(r.id)
    try {
      const [{ renderReceiptBlob }, { downloadBlob }] = await Promise.all([
        import('@/components/payments/ReceiptPDF'), import('@/lib/portalPdf'),
      ])
      downloadBlob(await renderReceiptBlob(r, r.invoices as Invoice, settings ?? null), `${receiptNumberFor(r.id)}.pdf`)
    } catch { toast.error('Could not generate the receipt PDF.') }
    setReceiptId(null)
  }

  if (!loaded || rows.length === 0) return null
  const paidRows = rows.filter(r => r.kind === 'payment' && Number(r.amount) > 0)
  const total = paidRows.reduce((s, r) => s + Number(r.amount || 0), 0)

  return (
    <Card>
      <CardBody>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-ink flex items-center gap-2">
            <Wallet className="w-4 h-4 text-accent" /> Payment timeline
          </p>
          <p className="text-xs text-ink-muted">{formatCurrency(total)} received · last {paidRows.length} payment{paidRows.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="divide-y divide-border">
          {rows.map(r => {
            const negative = Number(r.amount) < 0
            const isCredit = r.kind === 'credit'
            return (
              <div key={r.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink truncate">
                    {r.invoices?.invoice_number || (isCredit ? 'Customer credit' : 'Payment')}
                    {isCredit && r.invoices?.invoice_number ? ' · credit' : ''}
                  </p>
                  <p className="text-xs text-ink-faint">{formatDate(r.paid_at || r.created_at)} · {paymentMethodLabel(r.method || r.provider)}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-sm font-bold ${negative ? 'text-red-400' : isCredit ? 'text-violet-400' : 'text-emerald-400'}`}>
                    {negative ? '−' : ''}{formatCurrency(Math.abs(Number(r.amount)))}
                  </span>
                  {r.kind === 'payment' && Number(r.amount) > 0 && r.invoices && (
                    <button onClick={() => downloadReceipt(r)} disabled={receiptId === r.id}
                      className="text-ink-faint hover:text-accent transition-colors" title={`Download receipt ${receiptNumberFor(r.id)}`}>
                      {receiptId === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </CardBody>
    </Card>
  )
}
