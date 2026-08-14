'use client'

// ── The owner writes the alternatives ────────────────────────────────────────
// Budget / Standard / Premium — three versions of ONE job, of which the customer
// picks one. This editor exists only while the "Offer multiple options" switch is
// on; a normal quote never renders it and is exactly as simple as it was.
//
// ⭐ WHAT THIS SCREEN IS CAREFUL ABOUT: nothing here adds up. There is no
// subtotal, no running total, no "3 options · $16,400" summary — because the one
// misreading this feature exists to prevent is "the alternatives are components
// of one price". Each row states its own price as the whole job, and the note
// under the list says so in words.
//
// The Recommended badge is a RADIO, not a checkbox. Two recommendations tell the
// customer nothing, and the database refuses them anyway (a partial unique
// index) — so the control's own shape makes the invalid state unreachable rather
// than reporting it after a failed save.

import { Fragment } from 'react'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { formatCurrency, cn } from '@/lib/utils'
import type { QuoteOptionInput } from '@/types'
import {
  MAX_QUOTE_OPTIONS, MIN_QUOTE_OPTIONS, duplicateOption, optionProblemMessage, optionSetProblem,
  headlineOptionPrice, recommendedOption,
} from '@/lib/quoteOptions'
import { Plus, Trash2, ChevronUp, ChevronDown, Copy, Star, AlertTriangle, Lock } from 'lucide-react'

interface Props {
  options: QuoteOptionInput[]
  onChange: (next: QuoteOptionInput[]) => void
  /** Travel, so each row can state the figure the customer will actually see —
   *  the same `option + travel` the approval RPC snapshots. Never summed across
   *  rows; added to each row independently. */
  travelFee: number
  /** The customer has already chosen. The set becomes read-only: the approved
   *  alternative can't be deleted (ON DELETE RESTRICT) and rewriting the others
   *  would change what the record says was offered. */
  lockedSelectedName?: string | null
}

export function QuoteOptionsEditor({ options, onChange, travelFee, lockedSelectedName }: Props) {
  const locked = !!lockedSelectedName
  const problem = optionSetProblem(options)
  const headline = headlineOptionPrice(options)
  const rec = recommendedOption(options)

  function patch(i: number, fields: Partial<QuoteOptionInput>) {
    onChange(options.map((o, k) => (k === i ? { ...o, ...fields } : o)))
  }
  // Exactly one badge, enforced by the control rather than reported by the save.
  function recommend(i: number) {
    onChange(options.map((o, k) => ({ ...o, is_recommended: k === i })))
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= options.length) return
    const next = [...options]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  function remove(i: number) {
    const next = options.filter((_, k) => k !== i)
    // Removing the recommended row would leave the set with no badge, and the
    // headline would silently fall back to "the first one" — a different price,
    // chosen by nothing. Move the badge to the top row instead, visibly.
    if (options[i]?.is_recommended && next.length) next[0] = { ...next[0], is_recommended: true }
    onChange(next)
  }
  function duplicate(i: number) {
    if (options.length >= MAX_QUOTE_OPTIONS) return
    const d = duplicateOption(options[i], options)
    const next = [...options]
    next.splice(i + 1, 0, { name: d.name, description: String(d.description ?? ''), price: Number(d.price) || 0, is_recommended: false })
    onChange(next)
  }
  function add() {
    if (options.length >= MAX_QUOTE_OPTIONS) return
    onChange([...options, { name: '', description: '', price: 0, is_recommended: options.length === 0 }])
  }

  return (
    <div className="space-y-3">
      {locked ? (
        <Banner tone="info" icon={Lock}>
          <span className="font-semibold text-ink">{lockedSelectedName} was approved.</span>{' '}
          The options are part of the record now — they show what this customer was offered and which one they took.
          To change the price, send a revised quote.
        </Banner>
      ) : (
        <p className="text-[11px] text-ink-faint leading-snug">
          Each option is a <span className="text-ink-muted font-medium">complete alternative</span> — the customer picks one and pays
          that price. They are never added together. Names are yours to write; “Budget / Standard / Premium” is just a starting point.
        </p>
      )}

      <div className="space-y-2.5">
        {options.map((o, i) => {
          const price = Number(o.price) || 0
          return (
            <Fragment key={o.id || `new-${i}`}>
              <div className={cn('rounded-xl border p-3 space-y-2.5',
                o.is_recommended ? 'border-accent/40 bg-accent/[0.04]' : 'border-border bg-bg-secondary')}>
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0 space-y-2.5">
                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2.5">
                      <Input
                        label={`Option ${i + 1} name`}
                        placeholder="e.g. Standard"
                        value={o.name}
                        disabled={locked}
                        onChange={e => patch(i, { name: e.target.value })}
                      />
                      {/* An UNPRICED option renders EMPTY, not "0". This file's
                          sibling (QuoteBuilder's BLANK constant) documents why:
                          a 0 seed paints a literal zero into a fresh field,
                          permanently hides the placeholder, and turns "type your
                          price" into select-the-0-then-retype. Clearing the field
                          keeps it empty for the same reason. Every reader
                          normalises through Number(), and Number('') === 0, so
                          the maths, the save and the guards are unchanged. */}
                      <Input
                        label="Price ($)"
                        type="number" step="1" min="0"
                        placeholder="e.g. 5400"
                        className="text-base font-semibold tabular-nums sm:w-36"
                        value={o.price === 0 || o.price == null ? '' : String(o.price)}
                        disabled={locked}
                        onChange={e => patch(i, { price: e.target.value === '' ? 0 : Number(e.target.value) })}
                      />
                    </div>
                    {/* rows=3: at 375px a two-row box sliced its own placeholder
                        in half mid-glyph, and the field exists to hold the
                        sentence that tells two options apart. */}
                    <Textarea
                      label="What this option includes"
                      placeholder="What they get for this price."
                      rows={3}
                      value={o.description}
                      disabled={locked}
                      onChange={e => patch(i, { description: e.target.value })}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                  {/* A radio, so two recommendations are not a state this control
                      can produce. Rendered as a real input for keyboard + a11y. */}
                  <label className={cn('inline-flex items-center gap-1.5 text-xs rounded-lg px-2 py-1 border cursor-pointer',
                    o.is_recommended ? 'border-accent/40 bg-accent/10 text-accent-text font-semibold' : 'border-border text-ink-muted hover:text-ink',
                    locked && 'cursor-default opacity-70')}>
                    <input
                      type="radio" name="eq-recommended-option" className="sr-only"
                      checked={!!o.is_recommended} disabled={locked}
                      onChange={() => recommend(i)}
                    />
                    <Star className={cn('w-3.5 h-3.5', o.is_recommended && 'fill-current')} aria-hidden />
                    Recommended
                  </label>
                  {/* Per-row, never a column total: this is what the customer
                      sees on THIS option, travel included, from the same
                      arithmetic the approval RPC does (option + travel). */}
                  <span className="text-[11px] text-ink-faint tabular-nums">
                    {travelFee > 0
                      ? <>Customer sees <span className="text-ink-muted font-medium">{formatCurrency(price + travelFee)}</span> (incl. {formatCurrency(travelFee)} travel)</>
                      : <>Customer sees <span className="text-ink-muted font-medium">{formatCurrency(price)}</span></>}
                  </span>
                  {!locked && (
                    <div className="flex items-center gap-0.5 ml-auto">
                      <IconBtn label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp className="w-4 h-4" /></IconBtn>
                      <IconBtn label="Move down" disabled={i === options.length - 1} onClick={() => move(i, 1)}><ChevronDown className="w-4 h-4" /></IconBtn>
                      <IconBtn label="Duplicate this option" disabled={options.length >= MAX_QUOTE_OPTIONS} onClick={() => duplicate(i)}><Copy className="w-4 h-4" /></IconBtn>
                      <IconBtn label="Remove this option" onClick={() => remove(i)} danger><Trash2 className="w-4 h-4" /></IconBtn>
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
          <Button type="button" variant="secondary" size="sm" onClick={add} disabled={options.length >= MAX_QUOTE_OPTIONS}>
            <Plus className="w-3.5 h-3.5" /> Add option
          </Button>
          <span className="text-[11px] text-ink-faint">
            {options.length} of {MAX_QUOTE_OPTIONS} · at least {MIN_QUOTE_OPTIONS}
          </span>
        </div>
      )}

      {/* Say what the quote is WORTH right now, and say which of the two things
          that number means. Before a choice it is the recommended option — a real
          price really offered, but nobody has agreed to it. That distinction is
          the whole reporting semantics of this feature, stated where the owner
          sets the numbers rather than only in a report they might read later. */}
      {!problem && headline != null && (
        <div className="rounded-xl border border-border bg-bg-tertiary/40 px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-ink-muted">
              {locked ? 'Approved at' : 'This quote is worth'}
            </span>
            <span className="text-lg font-bold text-accent-text tabular-nums">{formatCurrency(headline + travelFee)}</span>
          </div>
          <p className="text-[11px] text-ink-faint mt-0.5">
            {locked
              ? `${lockedSelectedName} — the option the customer chose.`
              : rec
                ? `Your recommended option (${rec.name}). It counts as this quote’s value in your pipeline until the customer picks one — never the three added together.`
                : `The first option (${options[0]?.name || 'Option 1'}) — mark one Recommended to lead with it.`}
          </p>
        </div>
      )}

      {problem && !locked && (
        <p className="text-xs text-amber-400 flex items-start gap-1.5 leading-snug">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
          {optionProblemMessage(problem)}
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
      // so these stay a compact 32px icon row under a mouse and grow to a real
      // thumb target on the phone the owner actually builds quotes on. Four of
      // them sit in one row; at 32px on a 375px screen, Delete is next to
      // Duplicate and the wrong tap costs a written-out option.
      className={cn('w-8 h-8 tap-target rounded-lg inline-flex items-center justify-center transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        disabled ? 'text-ink-faint/40 cursor-not-allowed' : danger ? 'text-ink-muted hover:text-red-400 hover:bg-red-500/10' : 'text-ink-muted hover:text-ink hover:bg-bg-tertiary')}
    >
      {children}
    </button>
  )
}
