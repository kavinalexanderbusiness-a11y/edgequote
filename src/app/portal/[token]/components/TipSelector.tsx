'use client'

// ── The tip selector ─────────────────────────────────────────────────────────
// Shown above the Pay button on an invoice that is being paid in FULL, when the
// business has turned tips on. It collects an INTENT — a percentage or a typed
// amount — which /api/portal/pay re-derives, re-validates and clamps server-side
// before a single cent reaches Stripe. Nothing here is authoritative.
//
// ── WHAT THIS DELIBERATELY IS NOT ────────────────────────────────────────────
// No option is pre-selected. "No tip" is the FIRST chip, the same size as every
// other, in the same row, with the same affordance — not a greyed-out link
// underneath, not smaller text, not hidden behind "other options". The customer
// is deciding what to do with their own money after the work is already done;
// the honest job here is legibility, not conversion.
//
// So: no default tip, no guilt copy, no sad-face on the low option, no
// pre-ticked percentage, no "most customers tip 20%", no countdown, no
// double-negative confirm ("Are you sure you don't want to tip?"). If the owner
// wants a tip they can ask for one; the software will not ask on their behalf.
//
// ── PHONE FIRST ──────────────────────────────────────────────────────────────
// This is a portal surface, which means it is a phone surface. The chips are a
// 2-column grid at 375/390/430 — never a horizontal scroller, never four across
// — and every one clears the 44px touch target through `.tap-target-y`. The
// custom field uses inputMode="decimal" so the numeric keypad opens, and it is
// type="text" on purpose: type="number" gives a spinner nobody wants, silently
// accepts "1e5", and reports an empty string for an invalid value so we could
// not tell "cleared" from "typed nonsense".

import { useId, useMemo, useState } from 'react'
import { Heart } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  TIP_MAX_CENTS, formatCents, parseTipInputToCents, tipPresetsFor, type TipConfig,
} from '@/lib/payments/tips'

/** 'none' until the customer picks — never a preset. */
export type TipChoice = { kind: 'none' } | { kind: 'preset'; percent: number } | { kind: 'custom' }

export interface TipSelectorProps {
  /** The owner's normalised configuration (from /api/payments/status). */
  config: TipConfig
  /** The amount being charged for the invoice itself, in cents. Presets are of THIS. */
  chargeCents: number
  choice: TipChoice
  onChoice: (c: TipChoice) => void
  /** The raw custom-field text, owned by the parent so it survives a re-render. */
  customText: string
  onCustomText: (v: string) => void
  /** True while a checkout is being started — the whole selector locks. */
  busy?: boolean
}

/**
 * Resolve a choice + typed text into the cents to POST.
 *
 * Exported because the parent needs the same answer to render the total and to
 * decide whether Continue is enabled — one expression, so the figure on the
 * button and the figure in the request body cannot disagree.
 *
 * Returns null when the customer has chosen "custom" but not yet typed a valid
 * amount: that is "not ready", which is different from "$0".
 */
export function tipCentsFor(choice: TipChoice, customText: string, chargeCents: number): number | null {
  if (choice.kind === 'none') return 0
  if (choice.kind === 'preset') {
    const base = Math.max(0, Math.round(chargeCents))
    return Math.round(base * choice.percent / 100)
  }
  const parsed = parseTipInputToCents(customText)
  if (parsed === null) return null
  return parsed > TIP_MAX_CENTS ? null : parsed
}

export function TipSelector({
  config, chargeCents, choice, onChoice, customText, onCustomText, busy,
}: TipSelectorProps) {
  const customInputId = useId()
  const [touched, setTouched] = useState(false)
  const presets = useMemo(() => tipPresetsFor(chargeCents, config.presets), [chargeCents, config.presets])

  // Nothing to offer: no presets survived (a percentage of a tiny charge rounds
  // to nothing) and no custom field. Render nothing rather than an empty box.
  if (!config.enabled || (presets.length === 0 && !config.customAllowed)) return null

  const parsedCustom = parseTipInputToCents(customText)
  const customTooBig = parsedCustom !== null && parsedCustom > TIP_MAX_CENTS
  const customInvalid = choice.kind === 'custom' && touched && customText.trim() !== '' && (parsedCustom === null || customTooBig)

  const chip = (
    key: string,
    label: string,
    sub: string | null,
    selected: boolean,
    onSelect: () => void,
  ) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={busy}
      onClick={onSelect}
      className={cn(
        'tap-target-y rounded-xl border px-3 py-2.5 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        'disabled:opacity-60 disabled:cursor-not-allowed',
        selected ? 'border-accent bg-accent/[0.08] ring-1 ring-accent/40' : 'border-border bg-bg-tertiary/40 hover:border-border-strong',
      )}
    >
      <span className="flex items-center gap-2">
        {/* A real radio look, so "you are choosing ONE, and nothing is chosen
            yet" is visible before anything is tapped rather than inferred after. */}
        <span
          className={cn('w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center',
            selected ? 'border-accent' : 'border-border-strong')}
          aria-hidden
        >
          {selected && <span className="w-2 h-2 rounded-full bg-accent" />}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink truncate">{label}</span>
          {sub && <span className="block text-[11px] text-ink-muted tabular-nums">{sub}</span>}
        </span>
      </span>
    </button>
  )

  return (
    <div className="mt-3 pt-3 border-t border-border/60">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint flex items-center gap-1.5">
        <Heart className="w-3 h-3" aria-hidden /> Add a tip
      </p>
      <p className="text-[11px] text-ink-muted mt-0.5 mb-2">
        Entirely optional, and it goes to the business on top of your invoice — your invoice total doesn’t change.
      </p>

      {/* TWO columns at every width, never more. Measured in real Chrome at
          320 / 375 / 390 / 430: chips come out 123 / 151 / 158 / 178px wide and
          44px tall, with no text clipping and no sideways overflow at any of
          them. One column was the first attempt (the quote-options precedent),
          but those are rich option cards carrying scope text; these are five
          short chips, and stacking them cost five rows instead of three —
          ~130px that pushed the Pay button off a 375px screen for no gain.
          Three columns is the line: it would put "20% $100.00" in ~100px. */}
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Add a tip">
        {/* No tip is FIRST and identical in weight to every other choice. */}
        {chip('none', 'No tip', null, choice.kind === 'none', () => onChoice({ kind: 'none' }))}
        {presets.map(p => chip(
          `p${p.percent}`,
          `${p.percent}%`,
          formatCents(p.cents),
          choice.kind === 'preset' && choice.percent === p.percent,
          () => onChoice({ kind: 'preset', percent: p.percent }),
        ))}
        {config.customAllowed && chip(
          'custom', 'Custom', null, choice.kind === 'custom', () => onChoice({ kind: 'custom' }),
        )}
      </div>

      {choice.kind === 'custom' && config.customAllowed && (
        <div className="mt-2">
          <label htmlFor={customInputId} className="block text-[11px] font-medium text-ink-muted mb-1">
            Tip amount
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-muted pointer-events-none" aria-hidden>$</span>
            <input
              id={customInputId}
              // text + inputMode=decimal: opens the numeric keypad on iOS and
              // Android without type="number"'s spinner, its silent "1e5"
              // acceptance, or its empty-string-for-invalid behaviour.
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={customText}
              disabled={busy}
              onChange={e => onCustomText(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={customInvalid || undefined}
              aria-describedby={customInvalid ? `${customInputId}-err` : undefined}
              className={cn(
                'tap-target-y w-full rounded-xl border bg-bg-tertiary/40 pl-7 pr-3 py-2.5 text-sm text-ink tabular-nums',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                'disabled:opacity-60',
                customInvalid ? 'border-red-500/50' : 'border-border',
              )}
            />
          </div>
          {customInvalid && (
            <p id={`${customInputId}-err`} className="text-[11px] text-red-400 mt-1">
              {customTooBig
                ? `Please enter ${formatCents(TIP_MAX_CENTS)} or less.`
                : 'Enter an amount like 25 or 25.50.'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The three-line breakdown of what the card is about to be charged.
 *
 * Separate from the selector because it is also the shape the receipt uses:
 * invoice payment, tip, total — with the invoice figure NEVER changing when the
 * tip does. That is the whole accounting model, said out loud to the person
 * paying.
 */
export function TipBreakdown({ invoiceCents, tipCents }: { invoiceCents: number; tipCents: number }) {
  if (tipCents <= 0) return null
  return (
    <dl className="mt-3 rounded-xl border border-border bg-bg-tertiary/40 p-3 space-y-1.5 text-sm tabular-nums">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-ink-muted">Invoice payment</dt>
        <dd className="text-ink font-medium">{formatCents(invoiceCents)}</dd>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-ink-muted">Tip</dt>
        <dd className="text-ink font-medium">{formatCents(tipCents)}</dd>
      </div>
      <div className="flex items-baseline justify-between gap-3 pt-1.5 border-t border-border/60">
        <dt className="text-ink font-semibold">Total charged</dt>
        <dd className="text-ink font-semibold">{formatCents(invoiceCents + tipCents)}</dd>
      </div>
    </dl>
  )
}
