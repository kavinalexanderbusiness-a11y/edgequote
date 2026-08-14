'use client'

// ── The owner writes the optional extras ─────────────────────────────────────
// "Additional service +$180", "Extra visit +$95" — things the customer may take
// or leave, decided at the moment they approve.
//
// ⭐ WHAT THIS SCREEN IS CAREFUL ABOUT, and it is the opposite of the options
// editor's care: extras DO add up, so the arithmetic is shown — but every figure
// is labelled with the condition attached to it. "Quote value" is the price with
// nothing ticked, because that is what the quote is worth if the customer says
// yes to the job and no to everything else. The all-in figure is named a CEILING
// and never called the quote's value, because nobody has agreed to it.
//
// ⭐ Pre-ticking is a deliberate, per-row act. A new extra arrives UNTICKED and
// there is no "tick all" — "we'll add it unless you object" is how a customer
// ends up paying for something they never read, and this feature exists to make
// the opposite true.

import { Fragment } from 'react'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { formatCurrency, cn } from '@/lib/utils'
import type { QuoteAddonInput } from '@/types'
import {
  MAX_QUOTE_ADDONS, ADDONS_OWNER_NOTE, ADDONS_AFTER_APPROVAL_NOTE,
  addonProblemMessage, addonSetProblem, addonsSubtotal,
} from '@/lib/quoteAddons'
import { Plus, Trash2, ChevronUp, ChevronDown, AlertTriangle, Lock, Check } from 'lucide-react'

interface Props {
  addons: QuoteAddonInput[]
  onChange: (next: QuoteAddonInput[]) => void
  /** The price the extras sit on top of — the quote's own, or the recommended
   *  option's on an options quote, travel included. Used only to state the
   *  ceiling honestly; no figure here is ever written anywhere. */
  baseAmount: number
  /** The quote is decided. The set becomes read-only, because the ticked extras
   *  are now part of what a real person approved — the database refuses a write
   *  either way (quote_addons_write_guard), and hearing that as a sentence beats
   *  hearing it as a constraint error after tapping Save. */
  locked?: boolean
}

export function QuoteAddonsEditor({ addons, onChange, baseAmount, locked }: Props) {
  const problem = addonSetProblem(addons)
  // Two different questions, two different figures, and neither is "the total".
  // THE shared sum for the first (it reads each row's own `is_selected` when no
  // id set is supplied) — never a second implementation of "what do the ticked
  // ones come to". The ceiling is arithmetic no engine owns because no engine
  // may: it is a hypothetical, and it is only ever shown labelled as one.
  const ticked = addonsSubtotal(addons)
  const ceiling = addons.reduce((s, a) => s + (Number(a.price) || 0), 0)

  function patch(i: number, fields: Partial<QuoteAddonInput>) {
    onChange(addons.map((a, k) => (k === i ? { ...a, ...fields } : a)))
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= addons.length) return
    const next = [...addons]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  function remove(i: number) {
    onChange(addons.filter((_, k) => k !== i))
  }
  function add() {
    if (addons.length >= MAX_QUOTE_ADDONS) return
    onChange([...addons, { name: '', description: '', price: 0, is_selected: false }])
  }

  return (
    <div className="space-y-3">
      {locked ? (
        <Banner tone="info" icon={Lock}>
          <span className="font-semibold text-ink">These extras are settled.</span>{' '}
          {ADDONS_AFTER_APPROVAL_NOTE}
        </Banner>
      ) : (
        <p className="text-[11px] text-ink-faint leading-snug">{ADDONS_OWNER_NOTE}</p>
      )}

      <div className="space-y-2.5">
        {addons.map((a, i) => {
          const price = Number(a.price) || 0
          return (
            <Fragment key={a.id || `new-${i}`}>
              <div className={cn('rounded-xl border p-3 space-y-2.5',
                a.is_selected ? 'border-accent/40 bg-accent/[0.04]' : 'border-border bg-bg-secondary')}>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2.5">
                  <Input
                    label={`Extra ${i + 1}`}
                    placeholder="e.g. Extra visit"
                    value={a.name}
                    disabled={locked}
                    onChange={e => patch(i, { name: e.target.value })}
                  />
                  {/* An UNPRICED extra renders EMPTY, not "0" — a 0 seed paints a
                      literal zero into a fresh field, hides the placeholder for
                      good and turns "type your price" into select-then-retype.
                      Every reader normalises through Number(), and Number('')
                      === 0, so the maths and the save are unchanged. */}
                  <Input
                    label="Adds ($)"
                    type="number" step="1" min="0"
                    placeholder="e.g. 180"
                    className="text-base font-semibold tabular-nums sm:w-36"
                    value={a.price === 0 || a.price == null ? '' : String(a.price)}
                    disabled={locked}
                    onChange={e => patch(i, { price: e.target.value === '' ? 0 : Number(e.target.value) })}
                  />
                </div>
                <Textarea
                  label="What this includes (optional)"
                  placeholder="Only if the name doesn’t say it."
                  rows={2}
                  value={a.description}
                  disabled={locked}
                  onChange={e => patch(i, { description: e.target.value })}
                />

                <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                  {/* A real checkbox, off by default, one row at a time. There is
                      deliberately no "tick all". */}
                  <label className={cn('inline-flex items-center gap-1.5 text-xs rounded-lg px-2 py-1 border',
                    a.is_selected ? 'border-accent/40 bg-accent/10 text-accent-text font-semibold' : 'border-border text-ink-muted hover:text-ink',
                    locked ? 'cursor-default opacity-70' : 'cursor-pointer')}>
                    <input
                      type="checkbox" className="sr-only"
                      checked={!!a.is_selected} disabled={locked}
                      onChange={e => patch(i, { is_selected: e.target.checked })}
                    />
                    <span className={cn('w-3.5 h-3.5 rounded border inline-flex items-center justify-center',
                      a.is_selected ? 'bg-accent border-accent' : 'border-border')} aria-hidden>
                      {a.is_selected ? <Check className="w-2.5 h-2.5 text-white" /> : null}
                    </span>
                    Suggest this one (pre-ticked)
                  </label>
                  <span className="text-[11px] text-ink-faint tabular-nums">
                    Customer sees <span className="text-ink-muted font-medium">+{formatCurrency(price)}</span>
                  </span>
                  {!locked && (
                    <div className="flex items-center gap-0.5 ml-auto">
                      <IconBtn label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp className="w-4 h-4" /></IconBtn>
                      <IconBtn label="Move down" disabled={i === addons.length - 1} onClick={() => move(i, 1)}><ChevronDown className="w-4 h-4" /></IconBtn>
                      <IconBtn label="Remove this extra" onClick={() => remove(i)} danger><Trash2 className="w-4 h-4" /></IconBtn>
                    </div>
                  )}
                </div>
              </div>
            </Fragment>
          )
        })}
      </div>

      {!locked && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={add} disabled={addons.length >= MAX_QUOTE_ADDONS}>
            <Plus className="w-3.5 h-3.5" /> Add an extra
          </Button>
          {addons.length > 0 && (
            <span className="text-[11px] text-ink-faint">{addons.length} of {MAX_QUOTE_ADDONS}</span>
          )}
        </div>
      )}

      {/* ⭐ Two figures, each with its condition stated. The first is what the
          quote is WORTH — what gets reported, invoiced and deposited against if
          the customer ticks nothing, which is the default and the likeliest
          outcome. The second is a CEILING and is never called a value: nobody
          has agreed to it and it must not be mistaken for the quote's price. */}
      {!problem && addons.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-tertiary/40 px-3 py-2.5 space-y-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-ink-muted">{locked ? 'Approved at' : 'This quote is worth'}</span>
            <span className="text-lg font-bold text-accent-text tabular-nums">{formatCurrency(baseAmount + ticked)}</span>
          </div>
          <p className="text-[11px] text-ink-faint">
            {locked
              ? ticked > 0
                ? `Includes ${formatCurrency(ticked)} of extras the customer took.`
                : 'The customer took none of the extras offered.'
              : ticked > 0
                ? `Includes ${formatCurrency(ticked)} of pre-ticked extras — the customer can untick them.`
                : 'Extras are on top and count only once the customer ticks them.'}
            {!locked && ceiling > ticked
              ? ` If they take everything, it comes to ${formatCurrency(baseAmount + ceiling)}.`
              : ''}
          </p>
        </div>
      )}

      {problem && !locked && (
        <p className="text-xs text-amber-400 flex items-start gap-1.5 leading-snug">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
          {addonProblemMessage(problem)}
        </p>
      )}
    </div>
  )
}

function IconBtn({ label, onClick, disabled, danger, children }: {
  label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode
}) {
  return (
    <button
      type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}
      // `.tap-target` is the project's 44×44 floor, gated on `pointer: coarse` —
      // compact under a mouse, a real thumb target on the phone the owner
      // actually writes quotes on, where Remove sits beside Move down.
      className={cn('w-8 h-8 tap-target rounded-lg inline-flex items-center justify-center transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        disabled ? 'text-ink-faint/40 cursor-not-allowed' : danger ? 'text-ink-muted hover:text-red-400 hover:bg-red-500/10' : 'text-ink-muted hover:text-ink hover:bg-bg-tertiary')}
    >
      {children}
    </button>
  )
}
