'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardBody } from '@/components/ui/Card'
import { formatCurrency, formatDate } from '@/lib/utils'
import { CreditCard } from 'lucide-react'

interface PaymentRow {
  id: string; amount: number; currency: string; status: string
  paid_at: string | null; created_at: string; invoice_id: string | null
  invoices?: { invoice_number: string } | null
}

// Collected-online history — Stripe payments recorded by the webhook. Hidden
// until there's at least one (no empty-state noise before payments are live).
export function PaymentHistory() {
  const supabase = createClient()
  const [rows, setRows] = useState<PaymentRow[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { if (active) setLoaded(true); return }
      const { data } = await supabase.from('payments')
        .select('id, amount, currency, status, paid_at, created_at, invoice_id, invoices(invoice_number)')
        .eq('user_id', user.id).order('created_at', { ascending: false }).limit(25)
      if (active) { setRows((data as unknown as PaymentRow[]) || []); setLoaded(true) }
    })()
    return () => { active = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!loaded || rows.length === 0) return null
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0)

  return (
    <Card>
      <CardBody>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-ink flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-accent" /> Online payments
          </p>
          <p className="text-xs text-ink-muted">{formatCurrency(total)} collected</p>
        </div>
        <div className="divide-y divide-border">
          {rows.map(r => (
            <div key={r.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink truncate">{r.invoices?.invoice_number || 'Payment'}</p>
                <p className="text-xs text-ink-faint">{formatDate(r.paid_at || r.created_at)} · Stripe</p>
              </div>
              <span className="text-sm font-bold text-emerald-400 shrink-0">{formatCurrency(Number(r.amount))}</span>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}
