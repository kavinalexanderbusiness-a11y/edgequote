'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { cn, formatCurrency } from '@/lib/utils'
import type { Opportunity, NextActionKind, PipelineReport } from '@/lib/pipeline'
import { STAGE_ORDER, STAGE_LABELS, STAGE_MEANING, type SalesStage } from '@/lib/salesStage'
import { LOSS_REASON_LABEL } from '@/lib/winLoss'
import { askLostReason } from '@/lib/lostReason'
import { FilterPill } from '@/components/ui/FilterPill'
import { EmptyState } from '@/components/ui/EmptyState'
import {
  PhoneCall, FileText, Send, Bell, PhoneOff, Receipt, Wallet, CalendarPlus,
  DollarSign, Repeat, HelpCircle, Hourglass, CheckCircle2, ArrowRight, PenLine,
} from 'lucide-react'

// ── The pipeline board ───────────────────────────────────────────────────────
// Presentation only. Every stage, every verb, every number and the whole ordering
// come from lib/pipeline; this file maps `action.kind` → an icon and a tone and
// renders rows. That split is what lets the engine be tested without a browser
// and stops a second opinion about "what's next" growing inside a component.
//
// A COMPACT LIST, not a board. A drag-and-drop kanban is the wrong shape here for
// two reasons, and only one of them is the phone: at 375px five columns are five
// horizontal scrolls, and — more fundamentally — the stages are DERIVED, so
// there is nothing to drop a card INTO. Dragging a deal from "Quote sent" to
// "Won" would have to invent a stored stage, which is the one thing this feature
// refuses to build. The rungs are filters over one ranked list instead.

const ACTION_META: Record<NextActionKind, { icon: typeof PhoneCall; tone: string }> = {
  collect_deposit: { icon: DollarSign,   tone: 'text-red-400 bg-red-500/10 border-red-500/20' },
  collect_payment: { icon: Wallet,       tone: 'text-red-400 bg-red-500/10 border-red-500/20' },
  call_lead:       { icon: PhoneCall,    tone: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  price_quote:     { icon: PenLine,      tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  link_customer:   { icon: PenLine,      tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  send_quote:      { icon: Send,         tone: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
  schedule_work:   { icon: CalendarPlus, tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  send_invoice:    { icon: Receipt,      tone: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
  follow_up:       { icon: Bell,         tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  prepare_quote:   { icon: FileText,     tone: 'text-accent-text bg-accent/10 border-accent/20' },
  // Muted deliberately: real money, but nothing can be DONE about it until a
  // contact detail exists, so it must not compete with rows you can act on. Same
  // treatment the Owner Action queue gives its blocked follow-ups.
  add_contact:     { icon: PhoneOff,     tone: 'text-ink-muted bg-bg-tertiary border-border' },
  renew_service:   { icon: Repeat,       tone: 'text-violet-400 bg-violet-500/10 border-violet-500/20' },
  log_loss:        { icon: HelpCircle,   tone: 'text-ink-muted bg-bg-tertiary border-border' },
  // "Nothing to do" must LOOK like nothing to do.
  wait:            { icon: Hourglass,    tone: 'text-ink-faint bg-bg-tertiary border-border' },
}

export function PipelineBoard({ report }: { report: PipelineReport }) {
  const [stage, setStage] = useState<SalesStage | ''>('')
  // Reasons recorded in THIS session. The rows come from a server render, so
  // without this a just-tagged loss keeps asking until the page is reloaded.
  const [taggedNow, setTaggedNow] = useState<Record<string, string>>({})

  // THE shared ask (lib/lostReason → the host in the dashboard layout), the same
  // door the decline control uses — one vocabulary, one recorder, two entrances.
  async function explain(o: Opportunity) {
    if (!o.quoteId) return
    const reason = await askLostReason({ quoteId: o.quoteId, customerName: o.name })
    // null = skipped, which is a complete answer. The row keeps offering it.
    if (reason) setTaggedNow(t => ({ ...t, [o.quoteId!]: reason }))
  }

  const items = useMemo(
    () => (stage ? report.items.filter(o => o.stage === stage) : report.items),
    [report.items, stage],
  )

  if (report.items.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        tone="positive"
        title="Nothing in the pipeline"
        description="No leads waiting, no quotes out, and nothing won that still needs something from you. New leads and quotes land here on their own."
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* ── The rungs ──────────────────────────────────────────────────────────
          A scrollable pill row on phones, wrapping on wider screens. Each pill
          carries its own count, so the shape of the pipeline reads at a glance
          without a chart. -mx-4 px-4 lets the row bleed to the screen edge on a
          375px phone rather than being boxed in by the page gutter. */}
      <div className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto sm:overflow-visible">
        <div className="flex sm:flex-wrap items-center gap-2 w-max sm:w-auto pb-0.5">
          <FilterPill active={stage === ''} onClick={() => setStage('')}>
            All <span className="tabular-nums opacity-70">{report.items.length}</span>
          </FilterPill>
          {STAGE_ORDER.map(s => (
            <FilterPill
              key={s}
              active={stage === s}
              onClick={() => setStage(stage === s ? '' : s)}
              title={STAGE_MEANING[s]}
              disabled={report.counts[s] === 0}
            >
              {STAGE_LABELS[s]} <span className="tabular-nums opacity-70">{report.counts[s]}</span>
            </FilterPill>
          ))}
        </div>
      </div>

      {/* What the selected rung MEANS — one line, in the owner's words. The
          stages are derived, so saying what puts a deal on one is the difference
          between a filter and a claim the owner can trust. */}
      {stage && <p className="text-xs text-ink-muted px-0.5">{STAGE_MEANING[stage]}</p>}

      {items.length === 0 ? (
        <p className="text-sm text-ink-muted px-0.5 py-6">Nothing on this rung right now.</p>
      ) : (
        <ol className="rounded-card border border-border bg-bg-secondary divide-y divide-border overflow-hidden">
          {items.map(o => (
            <PipelineRow
              key={o.key}
              o={o}
              lossReason={o.quoteId ? (taggedNow[o.quoteId] ?? o.lossReason ?? null) : o.lossReason ?? null}
              onExplain={() => explain(o)}
            />
          ))}
        </ol>
      )}
    </div>
  )
}

function PipelineRow({ o, lossReason, onExplain }: {
  o: Opportunity
  lossReason: string | null
  onExplain: () => void
}) {
  const meta = ACTION_META[o.action.kind]
  const Icon = meta.icon
  const isWait = o.action.kind === 'wait'
  // A loss explained in this session stops asking, right where it stands.
  const settled = o.stage === 'lost' && !!lossReason

  return (
    <li>
      {/* ONE TAP = open the deal. The whole row is the link; the action button
          sits on top of it as a separate target. min-h-[68px] and the 44px action
          button keep both comfortably above the touch-target floor at 375px. */}
      <div className="relative">
        <Link
          href={o.href}
          className="group flex items-center gap-3 px-3.5 sm:px-4 py-3 min-h-[68px] hover:bg-surface-raised/40 active:bg-surface-raised/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
        >
          <span aria-hidden className={cn('shrink-0 w-9 h-9 rounded-lg border flex items-center justify-center', meta.tone)}>
            <Icon className="w-4 h-4" />
          </span>

          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="text-sm font-semibold tracking-tight text-ink truncate">{o.name}</span>
              {o.value != null && (
                <span className="ml-auto shrink-0 text-sm font-bold tabular-nums tracking-tight text-ink">
                  {formatCurrency(o.value)}
                </span>
              )}
            </span>
            {/* The verb, then why. On a 375px phone the verb must survive the
                truncation, so it is its own element and the reason is what
                clips. */}
            <span className="flex items-baseline gap-1.5 mt-0.5 min-w-0">
              <span className={cn('shrink-0 text-xs font-semibold',
                settled ? 'text-emerald-400' : isWait ? 'text-ink-faint' : 'text-accent-text')}>
                {settled ? (LOSS_REASON_LABEL[lossReason!] || lossReason) : o.action.label}
              </span>
              {!settled && (
                <span className="text-xs text-ink-muted truncate">· {o.action.detail}</span>
              )}
            </span>
            <span className="block text-[11px] text-ink-faint truncate mt-0.5">
              {STAGE_LABELS[o.stage]}{o.service ? ` · ${o.service}` : ''}
            </span>
          </span>

          <ArrowRight className="w-4 h-4 text-ink-faint shrink-0 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>

      {/* The action itself. A second, explicit target rather than making the row
          do two jobs — "open it" and "do it" are different intents and a phone
          gives you no hover to tell them apart. `wait` gets none: there is
          nothing to press, and a button that does nothing is worse than silence.
          A settled loss gets none either — it has already been explained. */}
      {!isWait && !settled && (
        <div className="px-3.5 sm:px-4 pb-3 -mt-1">
          {o.action.kind === 'log_loss' ? (
            <button
              type="button"
              onClick={onExplain}
              className="w-full sm:w-auto min-h-[44px] px-4 rounded-xl text-sm font-semibold border border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              {o.action.label}
              <span className="ml-1.5 text-xs font-normal text-ink-faint">optional</span>
            </button>
          ) : (
            <Link
              href={o.action.href}
              className={cn(
                'w-full sm:w-auto min-h-[44px] px-4 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-1.5 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                o.action.kind === 'add_contact'
                  ? 'border border-border bg-surface text-ink-muted hover:text-ink'
                  : 'bg-accent text-black hover:opacity-90',
              )}
            >
              <Icon className="w-4 h-4" aria-hidden />
              {o.action.label}
            </Link>
          )}
        </div>
      )}
    </li>
  )
}
