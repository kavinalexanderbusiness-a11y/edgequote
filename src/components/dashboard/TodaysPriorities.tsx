import Link from 'next/link'
import { cn } from '@/lib/utils'
import type { Priority, PriorityKind } from '@/lib/dashboard/priorities'
import {
  ListChecks, CheckCircle2, ArrowRight,
  DollarSign, FileText, Bell, CalendarPlus, AlertTriangle, MessageSquare, Repeat, UserPlus, HeartPulse,
} from 'lucide-react'

// ONE ranked queue of the highest-value things to do right now. The ranking and
// the numbers come from lib/dashboard/priorities (pure, shared with nothing else
// to disagree with); this file is presentation only — it maps each `kind` to its
// icon and tone and renders links. Server-rendered: no fetch, no skeleton, the
// queue is simply there when the page paints.

const META: Record<PriorityKind, { icon: typeof DollarSign; tone: string }> = {
  unpaid:       { icon: DollarSign,    tone: 'text-red-400 bg-red-500/10 border-red-500/20' },
  leads:        { icon: UserPlus,      tone: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  unscheduled:  { icon: CalendarPlus,  tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  missed:       { icon: AlertTriangle, tone: 'text-red-400 bg-red-500/10 border-red-500/20' },
  drafts:       { icon: FileText,      tone: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
  followups:    { icon: Bell,          tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  reactivation: { icon: Repeat,        tone: 'text-accent-text bg-accent/10 border-accent/20' },
  lapsed:       { icon: HeartPulse,    tone: 'text-violet-400 bg-violet-500/10 border-violet-500/20' },
  messages:     { icon: MessageSquare, tone: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
}

export function TodaysPriorities({ items }: { items: Priority[] }) {
  return (
    <div className="rounded-card border border-accent/20 hero-aurora overflow-hidden">
      <div className="px-4 sm:px-5 py-3.5 border-b border-border flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-lg bg-accent/15 border border-accent/25 icon-glow flex items-center justify-center shrink-0">
          <ListChecks className="w-4 h-4 text-accent-text" />
        </span>
        <h2 className="text-sm font-bold tracking-tight text-ink">Today&rsquo;s Priorities</h2>
      </div>

      {items.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <div className="w-11 h-11 mx-auto rounded-full bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center mb-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          </div>
          <p className="text-sm font-semibold text-ink">You&rsquo;re all caught up</p>
          <p className="text-xs text-ink-muted mt-1">No leads waiting, unpaid invoices, follow-ups or unread replies right now.</p>
        </div>
      ) : (
        <ol className="divide-y divide-border">
          {items.map((p, i) => {
            const meta = META[p.kind]
            const Icon = meta.icon
            return (
              <li key={p.kind}>
                <Link
                  href={p.href}
                  className="group flex items-center gap-3 px-4 sm:px-5 py-3.5 hover:bg-surface/40 active:bg-surface/60 transition-colors"
                >
                  {/* Both decorative: this is an <ol>, so assistive tech already
                      conveys the rank, and the icon just restates the label. */}
                  <span aria-hidden className={cn('shrink-0 w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center tabular-nums',
                    i === 0 ? 'bg-accent/15 text-accent-text' : 'bg-bg-tertiary text-ink-faint')}>{i + 1}</span>
                  <span aria-hidden className={cn('shrink-0 w-9 h-9 rounded-lg border flex items-center justify-center', meta.tone)}>
                    <Icon className="w-4 h-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold tracking-tight text-ink truncate">{p.label}</span>
                    <span className="block text-xs text-ink-muted truncate mt-0.5 tabular-nums">{p.detail}</span>
                  </span>
                  <ArrowRight className="w-4 h-4 text-ink-faint shrink-0 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
