'use client'

import { Sparkles, Loader2, Square, Undo2, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── THE AI experience kit ─────────────────────────────────────────────────────
// Every AI affordance in the product is built from these. Before this file the
// app had twelve AI surfaces and roughly twelve treatments: seven labels for the
// same idea ("Write with AI", "Polish", "Summarize", "Create it", "Pick
// strongest with AI"…), four ways of showing that something was running, two
// disclaimers out of twelve, one undo out of three destructive replaces, and no
// way at all to stop a generation. That is what made it read as a row of
// unrelated buttons instead of one assistant.
//
// DELIBERATELY PROP-DRIVEN, NOT HOOK-DRIVEN. The assist surfaces drive these
// from useAiAssist; the marketing composer drives them from its own local state
// and its own routes. Coupling the kit to the hook would have forced marketing's
// frozen engine through the assist engine to get a consistent button — the tail
// wagging the dog. State stays the caller's; the LOOK and the BEHAVIOUR are
// shared.
//
// The vocabulary these enforce:
//  • The Sparkles icon means AI. So the label never says "with AI" — it says
//    what you get ("Write", "Polish", "Summarize").
//  • Busy is always the -ing form of the same verb, never a different word.
//  • Anything running can be stopped.
//  • Errors are amber, quiet, and announced to screen readers.
//  • Anything the customer will read carries a check-it-first note.

// ── The trigger ───────────────────────────────────────────────────────────────
// `busyLabel` is what makes the busy state consistent: it used to be a ternary
// hand-written at each call site, which is how one surface said "Writing…",
// another said "Cleaning up…", and a third silently said nothing at all.
export function AssistButton({ label, busyLabel, onClick, busy, disabled, title, size = 'sm', className }: {
  label: string
  busyLabel?: string
  onClick: () => void
  busy?: boolean
  disabled?: boolean
  title?: string
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      aria-busy={busy || undefined}
      className={cn(
        'inline-flex items-center gap-1.5 font-medium rounded-lg border border-accent/25 text-accent-text',
        size === 'sm' ? 'text-xs px-2.5 py-1.5' : 'text-sm px-3 py-2',
        'hover:bg-accent/10 hover:border-accent/40 transition-colors disabled:opacity-50 disabled:pointer-events-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        className,
      )}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
      {busy ? (busyLabel || label) : label}
    </button>
  )
}

// ── Stop ──────────────────────────────────────────────────────────────────────
// useAiAssist has exported `cancel` since it was written and NOTHING ever called
// it: every surface in the app made you watch a bad generation finish. Render
// this whenever something is running.
export function AiStop({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Stop generating"
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium rounded-lg px-2.5 py-1.5',
        'border border-line text-ink-muted hover:text-ink hover:border-ink-muted/50 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        className,
      )}
    >
      <Square className="w-3 h-3" /> Stop
    </button>
  )
}

// ── Undo ──────────────────────────────────────────────────────────────────────
// For surfaces that can't use the undo toast because the replace isn't a
// discrete event (a field the owner is still editing). Same idea, same words.
export function AiUndo({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Put back what was there before"
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium rounded-lg px-2.5 py-1.5',
        'border border-line text-ink-muted hover:text-ink hover:border-ink-muted/50 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        className,
      )}
    >
      <Undo2 className="w-3 h-3" /> Undo
    </button>
  )
}

// ── Error ─────────────────────────────────────────────────────────────────────
// One shape, one tone, always announced. Four of five assist surfaces had
// role="alert" and one didn't; marketing used two different treatments again.
export function AiError({ message, className }: { message?: string | null; className?: string }) {
  if (!message) return null
  return (
    <p role="alert" className={cn('text-[11px] text-amber-400', className)}>{message}</p>
  )
}

// ── The note under an AI affordance ───────────────────────────────────────────
// Two jobs, one look:
//  • `explain` — WHAT the assistant read to produce this. The engine computes
//    real facts (a customer's balance, their visit cadence, the owner's own
//    line-item notes) and the UI never said so, which is the difference between
//    a suggestion you can weigh and a black box you have to trust.
//  • `caution` — the check-it-first line, for anything a customer will read.
export function AiNote({ explain, caution, className }: {
  explain?: string
  caution?: string
  className?: string
}) {
  if (!explain && !caution) return null
  return (
    <p className={cn('text-[11px] text-ink-muted leading-relaxed inline-flex items-start gap-1.5', className)}>
      <Info className="w-3 h-3 mt-[1px] shrink-0 opacity-70" aria-hidden />
      <span>
        {explain}
        {explain && caution ? ' ' : ''}
        {caution ? <span className="text-ink-muted/80">{caution}</span> : null}
      </span>
    </p>
  )
}

// The one wording for "this is a draft". Anything whose output a CUSTOMER reads
// gets this; internal-only tools (job notes) don't need it.
export const AI_CHECK_FIRST = 'AI draft — read it before it goes out.'
