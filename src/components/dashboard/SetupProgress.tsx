'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { deriveSetupHealth, loadSetupSnapshot, type SetupHealth } from '@/lib/onboarding/setupHealth'
import { cn } from '@/lib/utils'
import { CheckCircle2, Circle, ChevronRight, Rocket, X } from 'lucide-react'

// ── Setup Progress — the dashboard's "finish setting up" card ────────────────
// Renders ONLY while something is incomplete: a finished checklist is a vanity
// stat, and this dashboard doesn't keep those. Every row deep-links to the
// exact settings surface that fixes it, and says what's silently degrading in
// the meantime — the point is never "7/10", it's "your portal isn't offering
// e-transfer and you didn't know".
//
// Dismissal is per-device (localStorage) and keyed to the SET of incomplete
// items: dismissing today's list stays dismissed, but if something NEW becomes
// incomplete the card comes back. No table, nothing to migrate, and a stale
// dismissal can never hide a fresh problem.

// Scoped per USER (found in review): two accounts in one browser must not share
// a dismissal — a fresh account's card would be hidden by the other's dismiss.
const dismissKey = (uid: string) => `eq-setup-dismissed:${uid}`

export function SetupProgress() {
  const supabase = useMemo(() => createClient(), [])
  const [health, setHealth] = useState<SetupHealth | null>(null)
  const [uid, setUid] = useState<string | null>(null)
  const [dismissedSig, setDismissedSig] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user || !alive) return
      setUid(user.id)
      try { setDismissedSig(window.localStorage.getItem(dismissKey(user.id))) } catch { /* ignore */ }
      const snap = await loadSetupSnapshot(supabase, user.id)
      if (!alive) return
      // A failed read renders nothing — never a checklist of guesses.
      if (snap.readError) return
      setHealth(deriveSetupHealth(snap))
    })()
    return () => { alive = false }
  }, [supabase])

  if (!health || health.complete) return null

  const missing = health.items.filter(i => !i.done)
  const sig = missing.map(i => i.key).sort().join(',')
  if (dismissedSig === sig) return null

  function dismiss() {
    if (uid) { try { window.localStorage.setItem(dismissKey(uid), sig) } catch { /* ignore */ } }
    setDismissedSig(sig)
  }

  return (
    <div className="rounded-card border border-border bg-bg-secondary overflow-hidden">
      <div className="px-5 py-4 flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
          <Rocket className="w-4 h-4 text-accent-text" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-base font-bold tracking-tight text-ink">Finish setting up</p>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-xs text-ink-muted tabular-nums">{health.done} of {health.total}</span>
              <button type="button" onClick={dismiss} aria-label="Dismiss setup checklist"
                className="text-ink-faint hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          {/* Progress: one quiet bar, no percentages shouting. */}
          <div className="mt-2 h-1.5 rounded-full bg-bg-tertiary overflow-hidden" role="progressbar"
            aria-valuenow={health.done} aria-valuemin={0} aria-valuemax={health.total}>
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round((health.done / health.total) * 100)}%` }} />
          </div>
        </div>
      </div>
      <div className="border-t border-border divide-y divide-border">
        {missing.map(item => (
          <Link key={item.key} href={item.href}
            className="flex items-center gap-3 px-5 py-3 hover:bg-surface transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset">
            <Circle className="w-4 h-4 text-ink-faint shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{item.label}</p>
              <p className="text-xs text-ink-muted truncate">{item.why}</p>
            </div>
            <ChevronRight className="w-4 h-4 text-ink-faint group-hover:text-accent-text transition-colors shrink-0" />
          </Link>
        ))}
      </div>
      {/* The done rows stay out of the way — a single quiet line, not a trophy list. */}
      {health.done > 0 && (
        <div className="px-5 py-2.5 border-t border-border flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          <p className={cn('text-xs text-ink-faint')}>{health.done} done — this card disappears when everything is.</p>
        </div>
      )}
    </div>
  )
}
