'use client'

import { useRef, useState } from 'react'
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
  // The synchronous in-flight latch. See save() for why state alone cannot do this.
  const inFlight = useRef(false)
  // ── The repair step ────────────────────────────────────────────────────────
  // Set only when the server refuses with repairRequired: the quote is flagged
  // accepted, has no evidence, and its price has moved since. Holds the two
  // figures and the fingerprint of the version being confirmed, so the
  // attestation names a specific document rather than "the quote".
  // `kind` distinguishes the two shapes the server refuses with: 'revised' — the
  // document moved under a marked acceptance — and 'unnamed', where nothing moved
  // but nobody is named on the record (a pre-records quote, or a status set by
  // hand). ⛔ They must not share a headline: telling an owner their quote
  // "changed after it was marked Accepted" when it did not is a false statement
  // on the very screen asking them to make a true one.
  const [repair, setRepair] = useState<
    { kind: 'revised' | 'unnamed'; priorAmount: number; currentAmount: number; fingerprint: string; why: string } | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  // Adopt the preset each time the dialog is OPENED. Seeding from the prop at
  // mount only would leave the second visit showing the first visit's choice —
  // and a stale preselected option on a dialog whose whole job is recording what
  // someone chose is exactly the wrong thing to get slightly wrong. The reason is
  // deliberately NOT carried over: it is a fresh claim every time.
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) { setOptionId(presetOptionId ?? null); setReason(''); setNote(''); setRepair(null); setConfirmed(false) }
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
  // The repair step demands MORE than the ordinary one: the checkbox naming the
  // current amount, and a note. Both are the difference between an attestation
  // and a shrug.
  const canConfirm = !!repair && !!reason && confirmed && !!note.trim() && !saving

  async function save() {
    // ⚠️⚠️ A REF, not the `saving` state, is what makes this one-request-per-click.
    // `canSave` closes over the value `saving` had at RENDER time, so two clicks
    // inside one frame — or a click plus the modal's ⌘/Ctrl+Enter — both read
    // `saving === false`, both pass, and both fire. That is how the owner's
    // screen came to show the same refusal stacked several times over: not one
    // bug emitting twice, but two requests each honestly reporting their own
    // failure. The ref flips synchronously, so the second caller returns here.
    if (inFlight.current) return
    if (!canSave || !reason) return
    inFlight.current = true
    setSaving(true)
    try {
      // ⭐ Through the owner route, not straight to the RPC. The route makes the
      // stored terms classification CURRENT first (the canonical classifier,
      // server-side, owner-authenticated) and then calls the same RPC. The
      // database gate is unchanged and still decides — a real contradiction is
      // still refused. See app/api/quotes/record-acceptance.
      const res = await fetch('/api/quotes/record-acceptance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId, reason,
          ...(chosen ? { optionId: chosen.id } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      })
      const out = await res.json().catch(() => null) as {
        ok?: boolean; error?: string; sentence?: string | null
        repairRequired?: boolean; repairKind?: string
        priorAmount?: number; currentAmount?: number
        currentFingerprint?: string | null
      } | null

      // ⭐ The one refusal that is not a dead end: the quote is flagged accepted
      // with no evidence and a price that moved. The owner may genuinely know
      // the customer accepted THIS version — so the dialog offers that
      // attestation instead of stopping. It is a second, explicit step on
      // purpose: naming the current amount is the whole point.
      if (out?.repairRequired) {
        setRepair({
          kind: out.repairKind === 'unnamed' ? 'unnamed' : 'revised',
          priorAmount: Number(out.priorAmount),
          currentAmount: Number(out.currentAmount),
          fingerprint: String(out.currentFingerprint ?? ''),
          why: String(out.error ?? ''),
        })
        setConfirmed(false)
        return
      }
      // ⚠️ A refusal is a refusal — never a success with nothing to show.
      if (!res.ok || !out?.ok) {
        toast.error(out?.error
          ? `Could not record it: ${out.error}`
          : 'Could not record that acceptance — the quote may already be accepted, or it may need to be sent again first.')
        return
      }
      toast.success(`Recorded — ${quoteNumber} is accepted${amount != null ? ` at ${formatCurrency(amount)}` : ''}.`)
      onRecorded()
      onClose()
    } catch {
      toast.error('Could not record that acceptance — check your connection and try again.')
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  /**
   * The explicit attestation about the CURRENT version.
   *
   * ⛔ Sends the fingerprint the owner was LOOKING AT. If the quote changed
   * between opening this and confirming it, the server refuses rather than
   * recording evidence against a version nobody saw — the amount on the
   * confirmation would be a different document's amount.
   */
  async function confirmCurrent() {
    if (inFlight.current) return
    if (!repair || !reason || !confirmed || !note.trim()) return
    inFlight.current = true
    setSaving(true)
    try {
      const res = await fetch('/api/quotes/confirm-current-acceptance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId, reason, note: note.trim(),
          expectedFingerprint: repair.fingerprint,
          expectedAmount: repair.currentAmount,
        }),
      })
      const out = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null
      if (!res.ok || !out?.ok) {
        toast.error(out?.error ? `Could not record it: ${out.error}` : 'Could not record that acceptance.')
        return
      }
      toast.success(`Recorded — ${quoteNumber} is accepted at ${formatCurrency(repair.currentAmount)}.`)
      onRecorded()
      onClose()
    } catch {
      toast.error('Could not record that acceptance — check your connection and try again.')
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!saving) onClose() }}
      size="md"
      icon={UserCheck}
      title={`Record ${customerName}’s acceptance`}
      onSubmit={repair ? confirmCurrent : save}
      footer={
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          {repair ? (
            // ⭐ The button NAMES the amount being attested to. A generic
            // "Confirm" would let an owner agree to a figure they never read,
            // which is the whole thing this step exists to prevent.
            <Button onClick={confirmCurrent} disabled={!canConfirm}>
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Confirm acceptance of {formatCurrency(repair.currentAmount)}
            </Button>
          ) : (
            <Button onClick={save} disabled={!canSave}>
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {amount != null ? `Record acceptance — ${formatCurrency(amount)}` : 'Record acceptance'}
            </Button>
          )}
        </div>
      }
    >
      {repair && (
        // ── The repair step ────────────────────────────────────────────────
        // Both figures, named. The owner is being asked to make a claim about a
        // specific document, so the document has to be in front of them: the
        // quote number, what it says NOW, and the unsupported figure that was
        // sitting on the record.
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3.5 py-3 space-y-2.5 mb-4">
          <p className="text-sm font-semibold text-amber-400">
            {repair.kind === 'unnamed'
              ? 'No acceptance naming who agreed is on file'
              : 'This quote changed after it was marked Accepted'}
          </p>
          <p className="text-xs text-ink-muted">{repair.why}</p>
          <div className="rounded-lg border border-border bg-bg-secondary px-3 py-2 text-xs space-y-1">
            {/* ⛔ Struck through only when there IS a prior figure to strike. On
                the 'unnamed' shape the two amounts are the same number, and
                showing it crossed out would invent a revision that never
                happened. */}
            {repair.kind === 'revised' && (
              <div className="flex justify-between gap-3">
                <span className="text-ink-muted">Previous unsupported acceptance figure</span>
                <span className="text-ink-muted line-through tabular-nums">{formatCurrency(repair.priorAmount)}</span>
              </div>
            )}
            <div className="flex justify-between gap-3">
              <span className="text-ink font-medium">Current quote {quoteNumber}</span>
              <span className="text-ink font-semibold tabular-nums">{formatCurrency(repair.currentAmount)}</span>
            </div>
          </div>
          <label className="flex items-start gap-2 text-xs text-ink cursor-pointer">
            <input type="checkbox" className="mt-0.5 shrink-0" checked={confirmed}
              onChange={e => setConfirmed(e.target.checked)} />
            <span>
              I confirm the customer accepted the current quote for{' '}
              <span className="font-semibold tabular-nums">{formatCurrency(repair.currentAmount)}</span>
              {repair.kind === 'revised' ? ' after the quote was changed.' : '.'}
            </span>
          </label>
          <p className="text-[11px] text-ink-faint">
            This is recorded as your attestation on the customer’s behalf — never as their own portal acceptance.
            A note is required.
          </p>
        </div>
      )}
      {/* Says whose act this is, before anything is filled in. The owner is not
          approving the quote; they are writing down that the customer did. */}
      <p className="text-sm text-ink-muted">
        This records that <span className="text-ink font-medium">{customerName}</span> accepted{' '}
        {quoteNumber} — and that <span className="text-ink font-medium">you</span> wrote it down for them.
        The record will always say so; it will never read as if they accepted it in their portal.
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
                // min-h-[44px]: measured at 42px on 375/390/430 by
                // scripts/s121-acceptance-cdp.mjs. This row IS the control — the
                // radio inside it is 13px and is reached by tapping the label —
                // so the label is what has to clear the touch minimum.
                className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 min-h-[44px] cursor-pointer transition-colors ${
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
          {/* ⛔ The word has to follow the STEP, not the field. On the ordinary
              path a note genuinely is optional. On the repair step `canConfirm`
              refuses without one — so a label still reading "(optional)" there
              contradicted the panel's own "A note is required." three inches
              above it, on the one screen whose entire job is getting an owner to
              make a careful, true statement. */}
          Note <span className="text-ink-faint font-normal normal-case tracking-normal">{repair ? '(required)' : '(optional)'}</span>
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
