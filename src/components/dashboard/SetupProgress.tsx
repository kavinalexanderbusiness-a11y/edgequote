'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { deriveSetupHealth, deriveSetupMilestones, loadSetupSnapshot, type SetupActivity, type SetupSnapshot } from '@/lib/onboarding/setupHealth'
import { Button, ButtonLink } from '@/components/ui/Button'
import { CheckCircle2, Circle, ChevronRight, Rocket, X } from 'lucide-react'

// Dismiss only the optional reminders once the four starting milestones are
// complete. A stored dismissal must never hide a new business's path into work.
const dismissKey = (uid: string) => `eq-setup-dismissed:${uid}`

export function SetupProgress({ activity }: { activity: SetupActivity }) {
  const supabase = useMemo(() => createClient(), [])
  const [snapshot, setSnapshot] = useState<SetupSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [uid, setUid] = useState<string | null>(null)
  const [dismissedSig, setDismissedSig] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setSnapshot(null)
    setFailed(false)
    ;(async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession()
        const user = session?.user
        if (error || !user) throw new Error('Setup session unavailable')
        if (!alive) return
        setUid(user.id)
        setDismissedSig(null)
        try { setDismissedSig(window.localStorage.getItem(dismissKey(user.id))) } catch { /* optional persistence */ }
        const snap = await loadSetupSnapshot(supabase, user.id)
        if (snap.readError) throw new Error('Setup status unavailable')
        if (alive) setSnapshot(snap)
      } catch {
        if (alive) setFailed(true)
      }
    })()
    return () => { alive = false }
  }, [supabase, attempt])

  if (!snapshot) return (
    <div className="rounded-card border border-border bg-bg-secondary p-5" aria-live="polite">
      <p className="font-semibold text-ink">Your setup</p>
      <p className="mt-1 text-sm text-ink-muted">{failed ? 'Couldn’t check your setup. Try again to see your progress.' : 'Checking your setup…'}</p>
      {failed && <Button variant="secondary" size="sm" className="mt-3" onClick={() => setAttempt(value => value + 1)}>Retry</Button>}
    </div>
  )

  const health = deriveSetupHealth(snapshot)
  const milestones = deriveSetupMilestones(snapshot, activity)
  if (!milestones) return null
  const missing = health.items.filter(item => !item.done)
  const sig = missing.map(item => item.key).sort().join(',')
  if (milestones.complete && (health.complete || dismissedSig === sig)) return null
  const next = milestones.items.find(item => !item.done)

  function dismiss() {
    if (uid) { try { window.localStorage.setItem(dismissKey(uid), sig) } catch { /* optional persistence */ } }
    setDismissedSig(sig)
  }

  return (
    <section className="rounded-card border border-border bg-bg-secondary overflow-hidden" aria-label="Your setup">
      <div className="px-5 py-4 flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
          <Rocket className="w-4 h-4 text-accent-text" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-bold tracking-tight text-ink">{milestones.complete ? 'Make it yours' : 'Get your business ready'}</h2>
            {milestones.complete && <Button variant="ghost" size="sm" onClick={dismiss} aria-label="Dismiss optional setup reminders"><X className="w-4 h-4" /></Button>}
          </div>
          <p className="mt-1 text-sm text-ink-muted">{milestones.complete ? 'Your first steps are complete. These extras are here when you need them.' : 'Start here, pick up where you left off, or jump straight into a quote.'}</p>
          {!milestones.complete && <p className="mt-2 text-xs text-ink-muted">{milestones.done} of {milestones.total} steps complete</p>}
        </div>
      </div>

      {!milestones.complete && <>
        <ol className="border-t border-border divide-y divide-border">
          {milestones.items.map(item => (
            <li key={item.key}>
              <Link href={item.href} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset">
                {item.done ? <CheckCircle2 className="w-4 h-4 text-accent-text shrink-0" aria-hidden="true" /> : <Circle className="w-4 h-4 text-ink-faint shrink-0" aria-hidden="true" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{item.label}{item.done && <span className="sr-only"> — Complete</span>}</p>
                  <p className="text-xs text-ink-muted">{item.why}</p>
                </div>
                <ChevronRight className="w-4 h-4 text-ink-faint shrink-0" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ol>
        <div className="px-5 py-4 flex flex-wrap gap-2 border-t border-border">
          {next && <ButtonLink href={next.href} size="sm">{next.label}</ButtonLink>}
          {!activity.hasCustomers && <ButtonLink href="/dashboard/customers/import" variant="secondary" size="sm">Import customers</ButtonLink>}
        </div>
      </>}

      <details className="border-t border-border">
        <summary className="px-5 py-4 cursor-pointer text-sm font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset">
          More setup options <span className="text-ink-muted font-normal">· {health.done} of {health.total} complete</span>
        </summary>
        <div className="border-t border-border divide-y divide-border">
          {health.items.map(item => (
            <Link key={item.key} href={item.href} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset">
              {item.done ? <CheckCircle2 className="w-4 h-4 text-accent-text shrink-0" aria-hidden="true" /> : <Circle className="w-4 h-4 text-ink-faint shrink-0" aria-hidden="true" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{item.label}{item.done && <span className="sr-only"> — Complete</span>}</p>
                <p className="text-xs text-ink-muted">{item.why}</p>
              </div>
              <ChevronRight className="w-4 h-4 text-ink-faint shrink-0" aria-hidden="true" />
            </Link>
          ))}
        </div>
      </details>
    </section>
  )
}
