'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { formatCurrency } from '@/lib/utils'
import { ON_BEHALF_REASONS, type OnBehalfReason } from '@/lib/quoteAcceptance'
import { UserCheck, Loader2 } from 'lucide-react'

// ── "Record customer acceptance" ─────────────────────────────────────────────
//
// ⭐⭐ THE WHOLE POINT IS THE SENTENCE THIS DIALOG MAKES TRUE. Before it, an owner
// whose customer said yes on the phone had one door: pick "Approved" from a
// status dropdown. That wrote a quote row indistinguishable from a real portal
// approval — same status, an invented accepted_price, no actor, no timestamp, no
// source — and then the notification bell told the owner that the CUSTOMER had
// accepted a quote the owner had just ticked themselves.
//
// Recording a decision someone else made is a legitimate, everyday act. It is
// simply a DIFFERENT act from the customer making it, and the record has to be
// able to say which one happened. So this dialog asks the one question that
// difference turns on — where the yes actually reached you — and refuses to
// proceed without it. There is no pre-selected reason and no "other" default:
// a defaulted answer is the same lie in a smaller font.
//
// ⛔ NOT A SIGNATURE. This records an owner's attestation, and the ledger stores
// it as exactly that (kind='owner_on_behalf'). Sessions 74/83 own signatures.

export interface RecordAcceptanceOption {
  id: string
  name: string
  price: number
  is_recommended?: boolean
}

interface Props {
  open: boolean
  onClose: () => void
  quoteId: string
  quoteNumber: string
  customerName: string
  /** Travel is added to the option price exactly as the portal's own dialog and
   *  the database's accepted_amount do — one arithmetic, three places. */
  travelFee: number
  /** The whole-quote figure, used only when the quote offers no options. */
  total: number
  options: RecordAcceptanceOption[]
  /** Opened from an option row ("They chose Premium") rather than the general
   *  action — the choice is pre-filled, and still fully changeable here. */
  presetOptionId?: string | null
  /** The tenant's terms as they read RIGHT NOW. Shown, not summarised: the owner
   *  is attesting the customer agreed to this text, and it is snapshotted with
   *  the acceptance so editing Settings later cannot rewrite what they agreed to. */
  termsText: string | null
  /** Selected extras, already priced. Included in the figure the same way the
   *  database includes them, so this dialog and the record cannot disagree. */
  selectedAddonsTotal: number
  onRecorded: () => void
}

export function RecordAcceptanceDialog({
  open, onClose, quoteId, quoteNumber, customerName,
  travelFee, total, options, presetOptionId, termsText, selectedAddonsTotal, onRecorded,
}: Props) {
  const [optionId, setOptionId] = useState<string | null>(presetOptionId ?? null)
  const [reason, setReason] = useState<OnBehalfReason | ''>('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  // Adopt the preset each time the dialog is OPENED. Seeding from the prop at
  // mount only would leave the second visit showing the first visit's choice —
  // and a stale preselected option on a dialog whose whole job is recording what
  // someone chose is exactly the wrong thing to get slightly wrong. The reason is
  // deliberately NOT carried over: it is a fresh claim every time.
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) { setOptionId(presetOptionId ?? null); setReason(''); setNote('') }
  }

  const chosen = optionId ? options.find(o => o.id === optionId) ?? null : null
  // ⭐ ONE money path. The figure shown here is the figure the database computes
  // (option ?? initial_price, + travel, + selected extras). If the two ever
  // disagree the customer was shown one number and the business banked another —
  // the single failure this whole feature exists to prevent.
  const amount = options.length > 0
    ? (chosen ? chosen.price + travelFee + selectedAddonsTotal : null)
    : total

  const needsOption = options.length > 0 && !chosen
  const canSave = !needsOption && !!reason && !saving

  async function save() {
    if (!canSave || !reason) return
    setSaving(true)
    try {
      const supabase = createClient()
      const { data, error } = await supabase.rpc('owner_record_customer_acceptance', {
        p_quote_id: quoteId,
        p_reason: reason,
        ...(chosen ? { p_option_id: chosen.id } : {}),
        ...(note.trim() ? { p_note: note.trim() } : {}),
      })
      // ⚠️ A null id is a REFUSAL, not a success with nothing to show. The RPC
      // returns the new acceptance's id, so "no id" means no acceptance was
      // recorded — and reporting that as done is how an owner comes to believe a
      // deal is on the record when nothing is.
      if (error || !data) {
        toast.error(error?.message
          ? `Could not record it: ${error.message}`
          : 'Could not record that acceptance — the quote may already be accepted, or it may need to be sent again first.')
        return
      }
      toast.success(`Recorded — ${quoteNumber} is accepted${amount != null ? ` at ${formatCurrency(amount)}` : ''}.`)
      onRecorded()
      onClose()
    } finally { setSaving(false) }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!saving) onClose() }}
      size="md"
      icon={UserCheck}
      title={`Record ${customerName}’s acceptance`}
      onSubmit={save}
      footer={
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={!canSave}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {amount != null ? `Record acceptance — ${formatCurrency(amount)}` : 'Record acceptance'}
          </Button>
        </div>
      }
    >
      {/* Says whose act this is, before anything is filled in. The owner is not
          approving the quote; they are writing down that the customer did. */}
      <p className="text-sm text-ink-muted">
        This records that <span className="text-ink font-medium">{customerName}</span> accepted{' '}
        {quoteNumber} — and that <span className="text-ink font-medium">you</span> wrote it down for them.
        The record will always say so; it will never read as if they approved it in their portal.
      </p>

      {options.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold text-ink uppercase tracking-wide mb-2">Which option did they choose?</p>
          {/* ⛔ Required. A quote that offers alternatives and is accepted without
              naming one is approved with nobody able to say what was approved —
              the database refuses it too (quote_record_acceptance). */}
          <div className="space-y-1.5">
            {options.map(o => (
              <label
                key={o.id}
                className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${
                  optionId === o.id ? 'border-accent/50 bg-accent/10' : 'border-border bg-surface hover:border-border-strong'}`}
              >
                <input
                  type="radio"
                  name="acceptance-option"
                  checked={optionId === o.id}
                  onChange={() => setOptionId(o.id)}
                  className="accent-[var(--accent)]"
                />
                <span className="text-sm text-ink flex-1">{o.name}</span>
                <span className="text-sm text-ink-muted tabular-nums">{formatCurrency(o.price + travelFee + selectedAddonsTotal)}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4">
        <p className="text-xs font-semibold text-ink uppercase tracking-wide mb-2">How did they tell you?</p>
        <div className="flex flex-wrap gap-2">
          {ON_BEHALF_REASONS.map(r => (
            <button
              key={r.value}
              type="button"
              onClick={() => setReason(r.value)}
              className={`min-h-[44px] px-3.5 rounded-xl text-sm font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                reason === r.value
                  ? 'border-accent/50 bg-accent/10 text-accent-text'
                  : 'border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
        {/* Not "optional" phrasing — the button simply cannot be pressed. Saying
            it plainly is kinder than a refusal at submit. */}
        {!reason && (
          <p className="text-xs text-ink-faint mt-2">
            Pick one — it’s what makes this a record of their decision rather than just a status change.
          </p>
        )}
      </div>

      <div className="mt-4">
        <label className="block text-xs font-semibold text-ink uppercase tracking-wide mb-2" htmlFor="acceptance-note">
          Note <span className="text-ink-faint font-normal normal-case tracking-normal">(optional)</span>
        </label>
        <textarea
          id="acceptance-note"
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={2}
          placeholder="e.g. Spoke to Dana at 2pm, confirmed the Standard package"
          className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        />
      </div>

      {termsText && (
        <div className="mt-4 rounded-xl border border-border bg-bg-tertiary p-3">
          <p className="text-xs font-semibold text-ink uppercase tracking-wide mb-1.5">Terms being recorded</p>
          {/* Shown in full, deliberately. The owner is attesting the customer
              agreed to THIS text, and this exact text is stored with the
              acceptance — so editing it in Settings tomorrow cannot change what
              this customer appears to have agreed to today. */}
          <p className="text-xs text-ink-muted whitespace-pre-wrap max-h-32 overflow-y-auto">{termsText}</p>
        </div>
      )}
    </Modal>
  )
}
