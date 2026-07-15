'use client'

import { confirm as confirmDialog } from '@/lib/confirm'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { Customer, PaymentMethod } from '@/types'
import { usePaymentsStatus } from '@/hooks/usePaymentsStatus'
import { cardExpLabel, cardExpiryState } from '@/lib/payments/card'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { Select } from '@/components/ui/Select'
import { Banner } from '@/components/ui/Banner'
import { CreditCard, ShieldCheck, Trash2, Zap, AlertCircle, AlertTriangle } from 'lucide-react'

type Mode = 'inherit' | 'auto' | 'manual_review'

// Customer-profile card: shows the saved card + AutoPay state and lets the owner
// save/replace/remove the card, toggle AutoPay, and override the charge mode. The
// card itself is entered on Stripe's hosted page (no card data here); the webhook
// persists brand/last4/expiry, which arrive live via the payment_methods realtime
// sub + a short poll after returning from Stripe (?cardsaved=1).
export function PaymentMethodCard({ customer, onCustomerChange }: {
  customer: Customer
  onCustomerChange?: (patch: Partial<Customer>) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [card, setCard] = useState<PaymentMethod | null>(null)
  const { enabled: paymentsEnabled, webhook: webhookReady } = usePaymentsStatus()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [autopay, setAutopay] = useState(!!customer.autopay_enabled)
  const [mode, setMode] = useState<Mode>((customer.autopay_charge_mode as Mode) || 'inherit')
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { setAutopay(!!customer.autopay_enabled); setMode((customer.autopay_charge_mode as Mode) || 'inherit') }, [customer.autopay_enabled, customer.autopay_charge_mode])

  async function loadCard() {
    const { data } = await supabase.from('payment_methods')
      .select('*').eq('customer_id', customer.id).order('is_default', { ascending: false }).order('created_at', { ascending: false }).limit(1).maybeSingle()
    setCard((data as PaymentMethod | null) ?? null)
  }

  useEffect(() => {
    loadCard()
    // Just back from Stripe? The webhook writes the card a beat later — poll briefly.
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('cardsaved') === '1') {
      window.history.replaceState({}, '', `/dashboard/customers/${customer.id}`)
      let tries = 0
      const tick = () => { loadCard(); if (++tries < 5) pollRef.current = setTimeout(tick, 1500) }
      pollRef.current = setTimeout(tick, 1200)
    }
    return () => { if (pollRef.current) clearTimeout(pollRef.current) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Live: the webhook saving/removing a card updates this card instantly.
  useRealtimeRefresh('payment_methods', `customer_id=eq.${customer.id}`, loadCard)

  async function saveCard() {
    setBusy('save'); setError(null)
    try {
      const res = await fetch('/api/payments/setup-card', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: customer.id }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.url) { setError(d.error || 'Could not start card setup.'); setBusy(null); return }
      window.location.href = d.url   // hosted Stripe setup; returns to ?cardsaved=1
    } catch { setError('Could not reach the server.'); setBusy(null) }
  }

  async function removeCard() {
    const ok = await confirmDialog({ title: 'Remove this saved card?', message: 'AutoPay will be turned off until a new card is added.', confirmLabel: 'Remove card', destructive: true })
    if (!ok) return
    setBusy('remove'); setError(null)
    try {
      const res = await fetch('/api/payments/remove-card', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: customer.id }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Could not remove the card.'); return }
      setCard(null); setAutopay(false); onCustomerChange?.({ autopay_enabled: false })
    } finally { setBusy(null) }
  }

  async function toggleAutopay() {
    if (!card && !autopay) { setError('Add a card before turning on AutoPay.'); return }
    const next = !autopay
    setAutopay(next); setError(null)   // optimistic
    const { error } = await supabase.from('customers').update({ autopay_enabled: next }).eq('id', customer.id)
    if (error) { setAutopay(!next); setError('Could not update AutoPay.'); return }
    onCustomerChange?.({ autopay_enabled: next })
  }

  async function changeMode(next: Mode) {
    const prev = mode
    setMode(next); setError(null)   // optimistic
    const value = next === 'inherit' ? null : next
    const { error } = await supabase.from('customers').update({ autopay_charge_mode: value }).eq('id', customer.id)
    if (error) { setMode(prev); setError('Could not update charge timing.'); return }   // revert — never leave autopay charging against intent
    onCustomerChange?.({ autopay_charge_mode: value })
  }

  const expLabel = cardExpLabel(card)
  const expState = cardExpiryState(card)
  const brandLabel = card?.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : 'Card'

  // AutoPay is only truthfully "on" when it can actually charge. The badge used to
  // key off the toggle alone, so it stayed green while the engine skipped every
  // invoice for a reason the owner was never shown.
  const autopayBlocked = !!card && autopay && (!webhookReady || expState === 'expired')
  const autopayLive = !!card && autopay && !autopayBlocked

  return (
    <Card>
      <CardHeader className="flex items-center gap-2">
        <CreditCard className="w-4 h-4 text-accent-text" />
        <h2 className="text-sm font-semibold text-ink">Payment Method &amp; AutoPay</h2>
        {autopayLive && (
          <span className="ml-auto text-[10px] uppercase tracking-wide text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-1.5 py-0.5 font-semibold flex items-center gap-1">
            <Zap className="w-3 h-3" /> AutoPay on
          </span>
        )}
        {autopayBlocked && (
          <span className="ml-auto text-[10px] uppercase tracking-wide text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-1.5 py-0.5 font-semibold flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> AutoPay can&rsquo;t charge
          </span>
        )}
      </CardHeader>
      <CardBody className="space-y-4">
        {!paymentsEnabled && (
          <Banner tone="warn" icon={AlertCircle} className="text-xs">
            Connect Stripe (STRIPE_SECRET_KEY) to enable saved cards &amp; AutoPay.
          </Banner>
        )}

        {/* Stripe half-configured. attemptAutoPayCharge hard-refuses without the webhook
            ('webhook-unconfigured') because the webhook is the only writer of paid-state —
            charging with no way to record it would take money and leave the invoice open.
            That refusal was correct and completely invisible: every recurring visit
            silently skipped, forever, while this card showed a green AutoPay badge. */}
        {paymentsEnabled && !webhookReady && (
          <Banner tone="warn" icon={AlertTriangle} className="text-xs">
            AutoPay is turned on but <strong>can&rsquo;t charge yet</strong> — the Stripe webhook isn&rsquo;t
            configured (STRIPE_WEBHOOK_SECRET), so a charge couldn&rsquo;t be recorded against the invoice.
            Recurring visits are being invoiced as normal; they just won&rsquo;t be paid automatically until it&rsquo;s set up.
          </Banner>
        )}

        {/* The expiry was already on screen — as grey text that never made a claim.
            An expired card declines every charge, so it's the owner's problem now, not
            a footnote. */}
        {card && expState === 'expired' && (
          <Banner tone="warn" icon={AlertTriangle} className="text-xs">
            This card expired{expLabel ? ` in ${expLabel}` : ''} — AutoPay charges will decline.
            Ask {customer.name.split(' ')[0]} for a new card, or send a payment link instead.
          </Banner>
        )}

        {/* Saved card */}
        {card ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-lg bg-surface border border-border flex items-center justify-center shrink-0">
                <CreditCard className="w-4 h-4 text-ink-muted" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{brandLabel} •••• {card.last4 || '????'}</p>
                {expState === 'expired' ? (
                  <p className="text-[11px] text-amber-400 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3 shrink-0" /> Expired {expLabel}
                  </p>
                ) : expState === 'expiring' ? (
                  <p className="text-[11px] text-amber-400 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3 shrink-0" /> Expires {expLabel} — ask for a new card soon
                  </p>
                ) : (
                  <p className="text-[11px] text-ink-faint flex items-center gap-1">
                    <ShieldCheck className="w-3 h-3 text-emerald-400" /> Stored securely by Stripe{expLabel ? ` · exp ${expLabel}` : ''}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button size="sm" variant="secondary" onClick={saveCard} loading={busy === 'save'} disabled={!paymentsEnabled} title={!paymentsEnabled ? "Connect Stripe in Settings to enable card payments" : undefined}>Replace</Button>
              <Button size="sm" variant="ghost" onClick={removeCard} loading={busy === 'remove'} className="text-red-400/70 hover:text-red-400" aria-label="Remove card" title="Remove card">
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-border p-3">
            <p className="text-sm text-ink-muted">No card on file.</p>
            <Button size="sm" onClick={saveCard} loading={busy === 'save'} disabled={!paymentsEnabled} title={!paymentsEnabled ? "Connect Stripe in Settings to enable card payments" : undefined}>
              <CreditCard className="w-3.5 h-3.5" /> Add card
            </Button>
          </div>
        )}

        {/* AutoPay toggle */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">AutoPay recurring invoices</p>
            <p className="text-[11px] text-ink-faint">Automatically charge the saved card when a recurring visit is completed.</p>
          </div>
          <Toggle checked={autopay} onChange={() => toggleAutopay()} disabled={!card && !autopay} ariaLabel="AutoPay recurring invoices" />
        </div>

        {/* Charge-mode override (only relevant when AutoPay is on) */}
        {autopay && (
          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">Charge timing</p>
              <p className="text-[11px] text-ink-faint">Override the business default for this customer.</p>
            </div>
            <Select
              fieldSize="sm"
              value={mode}
              onChange={e => changeMode(e.target.value as Mode)}
              className="w-auto shrink-0"
              options={[
                { value: 'inherit', label: 'Use business default' },
                { value: 'auto', label: 'Charge on completion' },
                { value: 'manual_review', label: 'Hold for my review' },
              ]}
            />
          </div>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}
      </CardBody>
    </Card>
  )
}
