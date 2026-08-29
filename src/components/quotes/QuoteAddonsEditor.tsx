'use client'

// ── The owner writes the optional extras ─────────────────────────────────────
// "Gutter guards +$180", "Haul away the debris +$95" — things the customer may
// ADD to whatever they approve. Unlike options, extras are not a mode: a quote
// with none renders nothing and is exactly as simple as it was, and a quote may
// offer extras alongside options OR alongside service lines, because an extra
// always adds.
//
// ⭐ WHAT THIS SCREEN IS CAREFUL ABOUT — and it is the mirror image of what
// QuoteOptionsEditor is careful about. That editor refuses to add anything up,
// because its rows are alternatives. THIS editor must add up — the rows really
// are additive — but it must never present the sum as the quote's price. So the
// footer states the two figures side by side and names them: what the quote is
// worth today, and what it would be worth if the customer took everything. The
// second is a CEILING, never a total, and it is labelled as one.
//
// ⭐⭐ THERE IS NO "PRE-SELECT THIS ONE" CONTROL, AND THAT IS A DECISION.
// `is_selected` is the one column on the row that costs money: it drives the
// trigger that writes quotes.addons_total, which the GENERATED quotes.total
// reads, which is what the customer's PDF prints, what the pipeline reports and
// what the deposit engine takes a percentage of. An owner ticking an extra here
// would put money the customer has never agreed to into the customer's own
// document — and the schema would record it as selected_via='default', which is
// the database admitting nobody chose it. The database can express that state;
// this application refuses to create it. See lib/quoteAddons.addonRowsFor.

import { Fragment } from 'react'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { formatCurrency, cn } from '@/lib/utils'
import type { QuoteAddonInput } from '@/types'
import {
  MAX_QUOTE_ADDONS, addonProblemMessage, addonSetProblem, emptyAddon,
} from '@/lib/quoteAddons'
import { Plus, Trash2, ChevronUp, ChevronDown, AlertTriangle, Lock } from 'lucide-react'

interface Props {
  addons: QuoteAddonInput[]
  onChange: (next: QuoteAddonInput[]) => void
  /** The figure the quote rests on today (chosen/leading option + travel, or the
   *  plain quote's first-visit total). Used ONLY to say what the ceiling would
   *  be — never summed into anything stored. */
  baseTotal: number
  /**
   * The customer has decided. The set becomes read-only because the DATABASE has
   * already frozen it (quote_addons_write_guard refuses every write once the
   * quote leaves draft/sent) — this makes the owner hear a sentence while the
   * rows are still on screen, instead of a check_violation after they retype a
   * price. `takenNames` is what was actually bought, so the panel can say it.
   */
  frozen?: boolean
  takenNames?: string[]
}

export function QuoteAddonsEditor({ addons, onChange, baseTotal, frozen, takenNames }: Props) {
  const problem = addonSetProblem(addons)
  // The CEILING — every extra taken. Named as such in the footer and nowhere
  // else: it is not the quote's price and no stored column ever holds it.
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
  function remove(i: number) { onChange(addons.filter((_, k) => k !== i)) }
  function add() {
    if (addons.length >= MAX_QUOTE_ADDONS) return
    onChange([...addons, emptyAddon()])
  }

  if (frozen) {
    const taken = takenNames ?? []
    return (
      <div className="space-y-3">
        <Banner tone="info" icon={Lock}>
          <span className="font-semibold text-ink">
            {taken.length ? `${taken.join(', ')} ${taken.length === 1 ? 'was' : 'were'} taken.` : 'No extras were taken.'}
          </span>{' '}
          This quote has been decided, so its optional extras are part of the record now — they show what
          was offered and what was bought. Additional work goes on a <span className="text-ink font-medium">change order</span>.
        </Banner>
        <div className="space-y-2">
          {addons.map((a, i) => {
            const wasTaken = taken.includes(String(a.name).trim())
            return (
              <div key={a.id || `frozen-${i}`}
                className={cn('rounded-xl border px-3 py-2.5 flex items-start justify-between gap-3',
                  wasTaken ? 'border-emerald-500/35 bg-emerald-500/[0.06]' : 'border-border bg-bg-tertiary/30 opacity-70')}>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">{a.name}</p>
                  <p className={cn('text-[10px] font-semibold uppercase tracking-wide mt-0.5',
                    wasTaken ? 'text-emerald-400' : 'text-ink-faint')}>
                    {wasTaken ? 'Taken' : 'Not taken'}
                  </p>
                  {a.description ? <p className="text-xs text-ink-muted mt-1 whitespace-pre-wrap leading-relaxed">{a.description}</p> : null}
                </div>
                <span className={cn('text-sm font-bold shrink-0 tabular-nums', wasTaken ? 'text-ink' : 'text-ink-muted')}>
                  +{formatCurrency(Number(a.price) || 0)}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-ink-faint leading-snug">
        Extras the customer can <span className="text-ink-muted font-medium">add to whatever they approve</span>. Each one is
        optional and priced on its own. Nothing here is charged unless the customer picks it —{' '}
        <span className="text-ink-muted font-medium">you can&rsquo;t tick one for them</span>, and none of it counts toward this
        quote&rsquo;s value until they do.
      </p>

      <div className="space-y-2.5">
        {addons.map((a, i) => (
          <Fragment key={a.id || `new-${i}`}>
            <div className="rounded-xl border border-border bg-bg-secondary p-3 space-y-2.5">
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2.5">
                <Input
                  label={`Extra ${i + 1} name`}
                  placeholder="e.g. Gutter guards"
                  value={a.name}
                  onChange={e => patch(i, { name: e.target.value })}
                />
                {/* An UNPRICED extra renders EMPTY, not "0" — same reason as the
                    options editor and QuoteBuilder's BLANK constant: a 0 seed
                    paints a literal zero into a fresh field, permanently hides
                    the placeholder, and turns "type your price" into
                    select-the-0-then-retype. Every reader normalises through
                    Number(), and Number('') === 0. */}
                <Input
                  label="Adds ($)"
                  type="number" step="1" min="0"
                  placeholder="e.g. 180"
                  className="text-base font-semibold tabular-nums sm:w-36"
                  value={a.price === 0 || a.price == null ? '' : String(a.price)}
                  onChange={e => patch(i, { price: e.target.value === '' ? 0 : Number(e.target.value) })}
                />
              </div>
              {/* rows=2: an extra needs a sentence, not a scope document — the
                  decision it supports is "do I want this?", not "how do these
                  two differ?" (which is what the options editor's 3 rows are
                  for). At 375px two rows still clear the placeholder. */}
              <Textarea
                label="What the customer sees"
                placeholder="What they get if they add this. Written for them, not for you."
                rows={2}
                value={a.description}
                onChange={e => patch(i, { description: e.target.value })}
              />
              <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                <span className="text-[11px] text-ink-faint tabular-nums">
                  Customer sees <span className="text-ink-muted font-medium">+{formatCurrency(Number(a.price) || 0)}</span> on top of what they approve
                </span>
                <div className="flex items-center gap-0.5 ml-auto">
                  <IconBtn label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp className="w-4 h-4" /></IconBtn>
                  <IconBtn label="Move down" disabled={i === addons.length - 1} onClick={() => move(i, 1)}><ChevronDown className="w-4 h-4" /></IconBtn>
                  <IconBtn label="Remove this extra" onClick={() => remove(i)} danger><Trash2 className="w-4 h-4" /></IconBtn>
                </div>
              </div>
            </div>
          </Fragment>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={add} disabled={addons.length >= MAX_QUOTE_ADDONS}>
          <Plus className="w-3.5 h-3.5" /> Add optional extra
        </Button>
        <span className="text-[11px] text-ink-faint">
          {addons.length} of {MAX_QUOTE_ADDONS}
        </span>
      </div>

      {/* ⭐ TWO figures, both named. The left is what this quote is worth — the
          number the pipeline reports and the number on the customer's document
          today, because no extra is selected. The right is what it would reach if
          they took everything: a CEILING, said in words, never a total. Printing
          only the second is how an owner ends up forecasting money nobody has
          agreed to. */}
      {!problem && addons.length > 0 && ceiling > 0 && (
        <div className="rounded-xl border border-border bg-bg-tertiary/40 px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-ink-muted">This quote is worth</span>
            <span className="text-lg font-bold text-accent-text tabular-nums">{formatCurrency(baseTotal)}</span>
          </div>
          <div className="flex items-baseline justify-between gap-3 mt-1">
            <span className="text-[11px] text-ink-faint">If they take every extra</span>
            <span className="text-sm font-semibold text-ink-muted tabular-nums">{formatCurrency(baseTotal + ceiling)}</span>
          </div>
          <p className="text-[11px] text-ink-faint mt-1 leading-snug">
            Only the first figure counts as this quote&rsquo;s value. Extras are worth nothing until the customer
            takes them — then the quote&rsquo;s total moves on its own.
          </p>
        </div>
      )}

      {problem && (
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
      // compact under a mouse, a real thumb target on the phone the owner builds
      // quotes on. Only three buttons here (no Duplicate): an extra is a line, not
      // a tier, and Delete sitting next to Duplicate is what costs a typed row.
      className={cn('w-8 h-8 tap-target rounded-lg inline-flex items-center justify-center transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        disabled ? 'text-ink-faint/40 cursor-not-allowed' : danger ? 'text-ink-muted hover:text-red-400 hover:bg-red-500/10' : 'text-ink-muted hover:text-ink hover:bg-bg-tertiary')}
    >
      {children}
    </button>
  )
}
