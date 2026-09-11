'use client'

import { Loader2, UserCheck } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { formatCurrency } from '@/lib/utils'
import { ON_BEHALF_REASONS, TERMS_ACK_LABEL, termsRequired } from '@/lib/quoteAcceptance'
import { requiredDeposit } from '@/lib/payments/depositGate'
import { approvalTimingLine, paymentTiming } from '@/lib/payments/paymentTiming'
import { pilotAcceptanceBlock, type PilotAcceptanceController } from '@/hooks/usePilotQuoteAcceptance'
import type { PilotAcceptanceDocument } from '@/lib/quotes/pilotQuoteAcceptance'

const money = (value: number | null) => value === null ? 'Not set' : formatCurrency(value)

/** A display of the native public projection. No cached quote, private snapshot,
 * browser total, inferred add-on set or owner/customer authority enters here. */
function OfferedDocument({ document: p }: { document: PilotAcceptanceDocument }) {
  const chosen = p.options.find(o => o.id === p.offered_option_id)
  const included = new Set(p.included_addon_ids)
  const extras = p.addons.filter(a => included.has(a.id)), excluded = p.addons.filter(a => !included.has(a.id))
  const consented = { status: p.status, accepted_price: p.accepted_amount, total: p.accepted_amount,
    deposit_type: p.deposit_type, deposit_value: p.deposit_value }
  const deposit = requiredDeposit(consented)
  const base = chosen ? chosen.price : p.initial_price
  const unpriced = !p.no_charge && (base === null || base <= 0)
  return <div className="space-y-4" data-pilot-acceptance-document>
    <div>
      <p className="text-xs text-ink-muted">{p.company_name || 'Your service provider'} · {p.quote_number}</p>
      <h3 className="font-semibold text-ink">{p.customer_name}</h3>
      <p className="text-sm text-ink-muted whitespace-pre-wrap">{p.address}</p>
      {p.valid_until && <p className="text-xs text-ink-muted">Valid through {p.valid_until}</p>}
    </div>
    <section aria-label="Quoted work" className="space-y-2">
      <h3 className="font-semibold text-ink">{p.service_type}</h3>
      {chosen && <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
        <p className="font-medium text-ink">Included option: {chosen.name}</p>
        {chosen.description !== null && <p className="text-sm text-ink-muted whitespace-pre-wrap">{chosen.description}</p>}
        <p className="text-sm text-ink">Option price: {money(chosen.price)}</p>
      </div>}
      {p.services.length > 0 && <ul className="space-y-2" aria-label="Quoted service and material lines">
        {p.services.map(s => <li key={s.id} className="rounded-xl border border-border p-3 text-sm">
          <p className="font-medium text-ink">{s.service_type}{s.kind === 'material' ? ' (material)' : ''}</p>
          <p className="text-ink-muted">{s.quantity} {s.unit ?? 'units'} × {money(s.unit_price)}</p>
          {s.discount_type !== null && <p className="text-ink-muted">Discount: {s.discount_value === null ? 'Not set'
            : s.discount_type === 'percent' ? `${s.discount_value}%` : money(s.discount_value)}</p>}
          {s.est_minutes !== null && <p className="text-xs text-ink-muted">Estimated work time: {s.est_minutes} minutes</p>}
          {s.notes !== null && <p className="text-ink-muted whitespace-pre-wrap">{s.notes}</p>}
        </li>)}
      </ul>}
      {p.notes !== null && <p className="text-sm text-ink-muted whitespace-pre-wrap">{p.notes}</p>}
    </section>
    <section aria-label="Included extras" className="rounded-xl border border-border p-3">
      <h3 className="text-sm font-semibold text-ink">Included extras</h3>
      {extras.length ? <ul className="mt-2 space-y-1 text-sm text-ink-muted">{extras.map(a => <li key={a.id}>
        {a.name} — {money(a.price)}
      </li>)}</ul> : <p className="mt-1 text-sm text-ink-muted">No extras included.</p>}
      <p className="mt-2 text-xs text-ink-muted">These extras are part of this acceptance. To change them, cancel and update the selection first.</p>
    </section>
    {(p.options.some(o => o.id !== p.offered_option_id) || excluded.length > 0) && <section aria-label="Not included" className="text-sm text-ink-muted">
      <h3 className="font-semibold text-ink">Not included</h3>
      <ul className="mt-1 space-y-1">{p.options.filter(o => o.id !== p.offered_option_id).map(o => <li key={o.id}>
        Option {o.name} — {money(o.price)}{o.description !== null && <p className="whitespace-pre-wrap">{o.description}</p>}
      </li>)}{excluded.map(a => <li key={a.id}>Extra {a.name} — {money(a.price)}</li>)}</ul>
      <p className="mt-1 text-xs">These alternatives and extras are not ordered by this acceptance.</p>
    </section>}
    <section aria-label="Quote amount" className="rounded-xl bg-bg-tertiary border border-border p-3 space-y-1 text-sm">
      <p className="text-ink-muted">{chosen ? 'Chosen option' : 'Initial service price'}: {unpriced ? 'Not set' : money(base)}</p>
      <p className="text-ink-muted">Travel: {money(p.travel_fee)}</p>
      <p className="text-ink-muted">Included extras total: {money(p.addons_total)}</p>
      <p className="text-lg font-semibold text-ink">Amount being accepted: {unpriced ? 'Price needed' : money(p.accepted_amount)}</p>
      {p.no_charge && p.accepted_amount === 0 && <p className="text-ink-muted">Recorded as no charge.</p>}
      {p.gst_percent !== null && p.gst_percent > 0 && <p className="text-ink-muted">Plus GST ({p.gst_percent}%) on your invoice.</p>}
      {[['weekly', p.weekly_price], ['bi-weekly', p.biweekly_price], ['monthly', p.monthly_price]].some(([, amount]) => typeof amount === 'number' && amount > 0)
        && <div className="pt-2 text-ink-muted"><p>Ongoing plan prices are per visit:</p><ul>
          {([['weekly', p.weekly_price], ['bi-weekly', p.biweekly_price], ['monthly', p.monthly_price]] as const)
            .filter(([, amount]) => amount !== null && amount > 0).map(([name, amount]) => <li key={name}>{money(amount)} per {name} visit</li>)}
        </ul><p className="text-xs">Your ongoing schedule is confirmed separately.</p></div>}
      {!unpriced && <p className="pt-2 text-ink-muted">{approvalTimingLine(paymentTiming(consented))}</p>}
      {!unpriced && deposit > 0 && <p className="text-ink-muted">Scheduling deposit: {money(deposit)}. Accepting does not charge your card.</p>}
    </section>
    <section aria-label="Terms in this quote">
      <h3 className="text-sm font-semibold text-ink">Terms in this quote</h3>
      <p className="mt-2 text-sm text-ink-muted whitespace-pre-wrap">{p.terms_text ?? 'No additional written terms are included in this version.'}</p>
    </section>
  </div>
}

export function PilotQuoteAcceptanceModal({ controller: c, mode, preliminaryOptions = [], onClose }: {
  controller: PilotAcceptanceController; mode: 'portal' | 'owner'; preliminaryOptions?: { id: string; name: string }[]; onClose?: () => void
}) {
  const s = c.state, p = s.expected?.offered.public
  const busy = s.phase === 'saving'
  const mutable = ['loading', 'review', 'refused'].includes(s.phase)
  const choices = p ? p.options : preliminaryOptions
  const block = s.expected ? pilotAcceptanceBlock(s.expected, mode, s.termsAck) : null
  const canSubmit = c.available && s.phase === 'review' && !block && (mode !== 'owner' || !!s.reason)
  const dismiss = () => { if (!busy) { c.close(); onClose?.() } }
  return <Modal open={s.open} onClose={dismiss} dismissable={!busy} onSubmit={() => { void c.submit() }}
    icon={UserCheck} size="lg" title={mode === 'owner' ? 'Record customer acceptance' : 'Review and accept quote'}
    footer={<div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={dismiss} disabled={busy}>{['accepted', 'unknown', 'refused'].includes(s.phase) ? 'Close' : 'Cancel'}</Button>
      {s.phase === 'review' || busy ? <Button onClick={() => { void c.submit() }} disabled={!canSubmit}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}{mode === 'owner' ? 'Record this acceptance' : 'Accept this quote'}
      </Button> : null}
    </div>}>
    <div className="space-y-4">
      {s.phase === 'loading' && <p role="status" className="text-sm text-ink-muted">Loading the current quote for review…</p>}
      {s.message && <p role={s.phase === 'accepted' ? 'status' : 'alert'} className="text-sm font-medium text-ink">{s.message}</p>}
      {choices.length > 0 && mutable && <fieldset className="space-y-2" disabled={busy}>
        <legend className="text-sm font-semibold text-ink">{p ? 'Choose an option to review' : 'Choose an option to load its current quote'}</legend>
        <p className="text-xs text-ink-muted">Changing an option loads a new version for you to review before confirming.</p>
        <div className="flex flex-wrap gap-2">{choices.map(o => <Button key={o.id} variant="ghost" onClick={() => c.selectOption(o.id)}>{o.name}</Button>)}</div>
      </fieldset>}
      {p && s.phase !== 'loading' && <OfferedDocument document={p} />}
      {s.receipt && s.phase === 'accepted' && <p className="font-semibold text-ink">Recorded amount: {money(s.receipt.accepted_amount)}</p>}
      {p && mode === 'owner' && (s.phase === 'review' || busy) && <fieldset disabled={busy} className="space-y-3">
        <legend className="text-sm font-semibold text-ink">How did the customer tell you?</legend>
        <div className="flex flex-wrap gap-2">{ON_BEHALF_REASONS.map(r => <button key={r.value} type="button"
          className={`min-h-[44px] rounded-xl border px-3 text-sm ${s.reason === r.value ? 'border-accent text-accent-text' : 'border-border text-ink-muted'}`}
          aria-pressed={s.reason === r.value} onClick={() => c.setReason(r.value)}>{r.label}</button>)}</div>
        <label className="block text-sm text-ink">Note (optional)
          <textarea className="mt-1 block w-full rounded-xl border border-border bg-surface p-3 text-ink" rows={2}
            value={s.note} onChange={e => c.setNote(e.target.value)} />
        </label>
        <p className="text-sm text-ink-muted">By recording this, you confirm the customer accepted this scope, included extras, amount and terms.
          The record says you wrote down their decision; it is not a customer signature.</p>
      </fieldset>}
      {p && mode === 'portal' && termsRequired(p.terms_text) && (s.phase === 'review' || busy) && <label className="flex items-start gap-3 text-sm text-ink">
        <input type="checkbox" checked={s.termsAck} disabled={busy} onChange={e => c.setTermsAck(e.target.checked)} className="mt-1" />
        {TERMS_ACK_LABEL}
      </label>}
      {p && mode === 'portal' && s.phase === 'review' && <p className="text-xs text-ink-muted">Accepting confirms this itemized quote. It does not make a payment.</p>}
      {s.phase === 'review' && block && <p role="status" className="text-sm text-ink-muted">{block}</p>}
    </div>
  </Modal>
}
