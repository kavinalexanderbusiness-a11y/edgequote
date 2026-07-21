'use client'

// Shared portal primitives + THE tab contract. Every tab is a presentational
// component over { view, actions } — all derivation lives in ../model.ts, all
// mutations live in PortalClient's handlers. A tab that computes a money figure
// or calls supabase directly is a bug.

import { useState } from 'react'
import {
  CalendarClock, CheckCircle2, Download, Eye, Home, Navigation, Play, Printer, Sparkles,
} from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { downloadBlob, printBlob, viewBlob } from '@/lib/portalPdf'
import type { JourneyStep, LiveStatus, PortalView, SubmitRequestFn, TabKey } from '../model'

// ── The contract every tab implements ───────────────────────────────────────

export interface PortalActions {
  token: string
  /** Approve a quote (confirm dialog + portal_accept_quote). */
  accept: (quoteId: string) => void
  accepting: string | null
  /** Start Stripe checkout for one invoice (POST /api/portal/pay). */
  pay: (invoiceId: string) => void
  payingId: string | null
  paymentsEnabled: boolean
  /** Legacy free-text/preset request (portal_request_service). */
  request: (message: string, source: string) => Promise<boolean>
  /** Structured request (portal_submit_request) — reschedule/plan_change/appointment. */
  submitRequest: SubmitRequestFn
  photoUrl: (path: string) => string
  markInvoiceViewed: (invoiceId: string) => void
  /** Re-fetch get_portal_data (post card-change / autopay truth-refresh). */
  refresh: () => Promise<unknown>
  /** Cross-tab navigation, with optional Billing pre-filter / property focus. */
  navigate: (tab: TabKey, opts?: { docsCat?: 'all' | 'quote' | 'invoice'; propertyKey?: string }) => void
}

export interface TabProps { view: PortalView; actions: PortalActions }

// ── Live visit status ───────────────────────────────────────────────────────

export const STATUS_META: Record<LiveStatus, { label: string; icon: typeof Play; tone: string }> = {
  scheduled: { label: 'Scheduled', icon: CalendarClock, tone: 'text-ink-muted border-border bg-bg-tertiary' },
  on_my_way: { label: 'On My Way', icon: Navigation, tone: 'text-sky-400 border-sky-500/30 bg-sky-500/10' },
  in_progress: { label: 'In Progress', icon: Play, tone: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
  completed: { label: 'Completed', icon: CheckCircle2, tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
}

export function StatusPill({ s }: { s: LiveStatus }) {
  const m = STATUS_META[s]
  return <span className={cn('inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', m.tone)}><m.icon className="w-3 h-3" /> {m.label}</span>
}

export function StatusStepper({ s }: { s: LiveStatus }) {
  const order: LiveStatus[] = ['scheduled', 'on_my_way', 'in_progress', 'completed']
  const idx = order.indexOf(s)
  return (
    <div className="flex items-center gap-1 mt-3">
      {order.map((step, i) => (
        <div key={step} className="flex-1 flex items-center gap-1">
          <div className={cn('h-1.5 flex-1 rounded-full', i <= idx ? 'bg-accent' : 'bg-border')} />
        </div>
      ))}
    </div>
  )
}

// ── The journey rail (quote → paid progress) ────────────────────────────────
// Renders model.quoteJourney's steps: done segments solid, the current one
// pulses quietly, future ones stay border-toned. Labels only at the ends +
// current on small screens keeps it readable at 320px.

export function JourneyRail({ steps }: { steps: JourneyStep[] }) {
  const current = steps.find(s => s.current)
  return (
    <div className="mt-2.5">
      <div className="flex items-center gap-1">
        {steps.map(s => (
          <div key={s.key} className={cn('h-1.5 flex-1 rounded-full', s.done ? 'bg-accent' : s.current ? 'bg-accent/60' : 'bg-border')} />
        ))}
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] text-ink-faint">{steps[0].label}</span>
        {current && <span className="text-[10px] font-semibold text-accent-text">{current.label}</span>}
        <span className="text-[10px] text-ink-faint">{steps[steps.length - 1].label}</span>
      </div>
    </div>
  )
}

// ── Status pills (homeowner language — never leak internal statuses) ────────

export function QuoteStatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; tone: string }> = {
    accepted:  { label: 'Approved',               tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
    scheduled: { label: 'Scheduled',              tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
    completed: { label: 'Completed',              tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
    paid:      { label: 'Completed',              tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
    declined:  { label: 'Declined',               tone: 'text-red-400 border-red-500/30 bg-red-500/10' },
    sent:      { label: 'Awaiting your approval', tone: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
    // Derived, never stored (lib/quoteStatus). Deliberately NOT red: an expired
    // quote isn't a failure — the price simply lapsed; asking for a fresh one is
    // a normal thing to do.
    expired:   { label: 'Expired',                tone: 'text-ink-muted border-border bg-bg-tertiary' },
  }
  const m = map[status] ?? { label: 'Quote', tone: 'text-ink-muted border-border bg-bg-tertiary' }
  return <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', m.tone)}>{m.label}</span>
}

export function InvoiceStatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; tone: string }> = {
    paid:     { label: 'Paid',           tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
    overpaid: { label: 'Overpaid',       tone: 'text-violet-400 border-violet-500/30 bg-violet-500/10' },
    partial:  { label: 'Partially Paid', tone: 'text-sky-400 border-sky-500/30 bg-sky-500/10' },
    // Customer language: an issued invoice is simply "Due" — 'sent'/'unpaid' are
    // owner-side workflow states that mean nothing to the payer.
    sent:     { label: 'Due',            tone: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
    unpaid:   { label: 'Due',            tone: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
    // Derived from due_date, never stored. Red because it's genuinely
    // time-sensitive, but the copy stays neutral: being late happens, and the
    // row right here is how they fix it.
    overdue:  { label: 'Past due',       tone: 'text-red-400 border-red-500/30 bg-red-500/10' },
    cancelled:{ label: 'Cancelled',      tone: 'text-ink-muted border-border bg-bg-tertiary' },
    draft:    { label: 'Not yet issued', tone: 'text-ink-muted border-border bg-bg-tertiary' },
  }
  const m = map[status] || { label: 'Due', tone: 'text-amber-400 border-amber-500/30 bg-amber-500/10' }
  return <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', m.tone)}>{m.label}</span>
}

// ── Small bits ──────────────────────────────────────────────────────────────

export function Empty({ text, icon: Icon = Sparkles }: { text: string; icon?: typeof Home }) {
  return (
    <div className="rounded-card border border-dashed border-border bg-bg-secondary/40 py-10 px-6 text-center">
      <Icon className="w-7 h-7 text-ink-faint mx-auto mb-2.5" />
      <p className="text-sm text-ink-muted max-w-xs mx-auto">{text}</p>
    </div>
  )
}

export function StatCard({ label, value, icon: Icon, onClick }: { label: string; value: string; icon: typeof Home; onClick?: () => void }) {
  const inner = (
    <>
      <div className="flex items-center gap-1.5 text-[11px] text-ink-faint"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className="text-lg font-bold text-ink mt-0.5 tabular-nums">{value}</div>
    </>
  )
  if (onClick) {
    return <button type="button" onClick={onClick} className="rounded-card border border-border bg-bg-secondary p-3 text-left card-lift">{inner}</button>
  }
  return <div className="rounded-card border border-border bg-bg-secondary p-3">{inner}</div>
}

export function Thumb({ href, src, alt, wide }: { href: string; src: string; alt: string; wide?: boolean }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cn('block overflow-hidden rounded-lg border border-border bg-bg-tertiary', wide ? 'aspect-video' : 'aspect-square')}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} loading="lazy" className="w-full h-full object-cover" />
    </a>
  )
}

// ── PDF actions (View / Download / Print, unchanged behavior) ───────────────
// Compact utility row — quiet on purpose, so it never outweighs the Accept/Pay
// CTA above it. Download PDF gets a secondary tint; View/Print stay ghost.

export function DocActions({ getBlob, filename }: { getBlob: () => Promise<Blob>; filename: string }) {
  const [busy, setBusy] = useState<'view' | 'download' | 'print' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  async function run(kind: 'view' | 'download' | 'print') {
    if (busy) return
    setBusy(kind); setErr(null)
    try {
      const blob = await getBlob()
      if (kind === 'download') downloadBlob(blob, filename)
      else if (kind === 'print') printBlob(blob)
      else viewBlob(blob)
    } catch {
      setErr('Could not generate the PDF — please try again.')
    } finally { setBusy(null) }
  }
  return (
    <div className="mt-3 pt-3 border-t border-border">
      <div className="flex flex-wrap items-center gap-2">
        <DocBtn icon={Eye} label="View" loading={busy === 'view'} disabled={busy !== null} onClick={() => run('view')} />
        <DocBtn icon={Download} label="Download PDF" loading={busy === 'download'} disabled={busy !== null} onClick={() => run('download')} primary />
        <DocBtn icon={Printer} label="Print" loading={busy === 'print'} disabled={busy !== null} onClick={() => run('print')} />
      </div>
      {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
    </div>
  )
}

function DocBtn({ icon: Icon, label, loading, disabled, onClick, primary }: { icon: typeof Eye; label: string; loading?: boolean; disabled?: boolean; onClick: () => void; primary?: boolean }) {
  return (
    <Button size="sm" variant={primary ? 'secondary' : 'ghost'} loading={loading} disabled={disabled} onClick={onClick} className="flex-1 min-w-[92px]">
      {!loading && <Icon className="w-4 h-4" />} {label}
    </Button>
  )
}

// Section heading used across tabs — one look for "a new part of the story starts".
export function PortalSection({ title, sub, action, children }: { title: string; sub?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-ink">{title}</h2>
          {sub && <p className="text-[11px] text-ink-faint mt-0.5">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

export function fmtMoney(n: number): string {
  return formatCurrency(Number(n) || 0)
}
