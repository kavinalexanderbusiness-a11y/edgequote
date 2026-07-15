'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Toggle } from '@/components/ui/Toggle'
import { Skeleton } from '@/components/ui/Skeleton'
import { resolveAutomations, Automations, AUTOMATION_LABELS } from '@/lib/comms/automations'
import { resolveFollowUpPolicy, FOLLOW_UP_DAYS, FOLLOW_UP_MAX, type FollowUpPolicy } from '@/lib/followup'
import { Zap } from 'lucide-react'

const KEYS: (keyof Automations)[] = ['reminder', 'job_complete', 'review', 'marketing_draft', 'quote_followup']
const HINTS: Record<keyof Automations, string> = {
  reminder: 'Texts/emails the customer the evening before their visit.',
  // Honest scope: only the Complete button attempts this send (the quick-edit status
  // dropdown doesn't), and a send can still be skipped for consent/contact reasons —
  // so point the owner at the evidence rather than promising delivery.
  job_complete: 'Attempts a message when you tap Complete on a visit — their timeline shows whether it went.',
  review: 'Asks for a review the day after a completed visit.',
  marketing_draft: 'Prepares a marketing post draft when a job has before & after photos — you review before anything posts.',
  quote_followup: 'Chases quotes the customer hasn’t answered. Stops on its own the moment a quote is accepted, declined or invoiced.',
}

export function AutomationToggles() {
  const supabase = useMemo(() => createClient(), [])
  const [auto, setAuto] = useState<Automations>({ reminder: true, job_complete: true, review: true, marketing_draft: true, quote_followup: false })
  const [policy, setPolicy] = useState<FollowUpPolicy>({ delayDays: FOLLOW_UP_DAYS, maxCount: FOLLOW_UP_MAX })
  // The whole automations blob is one jsonb column, and the follow-up cadence
  // lives in it alongside the toggles. Keep the raw value so a write merges into
  // it instead of replacing it with just the booleans — otherwise flipping any
  // toggle would silently wipe the owner's cadence.
  const [raw, setRaw] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)

  async function load() {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setLoading(false); return }
    const { data } = await supabase.from('business_settings').select('automations').eq('user_id', user.id).maybeSingle()
    const value = (data as { automations: unknown } | null)?.automations
    setRaw((value && typeof value === 'object') ? value as Record<string, unknown> : {})
    setAuto(resolveAutomations(value))
    setPolicy(resolveFollowUpPolicy(value))
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // One writer for the column — merges into the raw blob so nothing is dropped.
  async function persist(patch: Record<string, unknown>): Promise<boolean> {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return false
    const next = { ...raw, ...patch }
    const { error } = await supabase.from('business_settings').update({ automations: next }).eq('user_id', user.id)
    if (error) return false
    setRaw(next)
    return true
  }

  async function toggle(key: keyof Automations, value: boolean) {
    const prev = auto
    setAuto({ ...auto, [key]: value })   // optimistic
    if (!await persist({ [key]: value })) setAuto(prev)   // revert — never show a toggle the cron won't honor
  }

  async function savePolicy(patch: Partial<FollowUpPolicy>) {
    const prev = policy
    const next = { ...policy, ...patch }
    setPolicy(next)   // optimistic
    const ok = await persist({ quote_followup_delay_days: next.delayDays, quote_followup_max: next.maxCount })
    if (!ok) setPolicy(prev)
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><Zap className="w-4 h-4 text-accent-text" /> Automated messages</h2>
        <p className="text-xs text-ink-faint mt-0.5">Which messages send on their own. Per-customer SMS/email opt-in still applies — nothing sends to a customer who hasn’t consented.</p>
      </CardHeader>
      <CardBody>
        {loading ? (
          <div className="space-y-2" aria-hidden>
            {KEYS.map(k => (
              <div key={k} className="flex items-center justify-between gap-3 py-1.5">
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-2.5 w-3/4 mt-1.5" />
                </div>
                <Skeleton className="w-10 h-6 rounded-full shrink-0" />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {KEYS.map(k => (
              <div key={k}>
                <div className="flex items-center justify-between gap-3 py-1.5">
                  <div className="min-w-0">
                    <p className="text-sm text-ink">{AUTOMATION_LABELS[k]}</p>
                    <p className="text-xs text-ink-faint">{HINTS[k]}</p>
                  </div>
                  <Toggle checked={auto[k]} onChange={v => toggle(k, v)} ariaLabel={AUTOMATION_LABELS[k]} />
                </div>
                {/* Cadence sits with the switch that uses it, and only once it's on. */}
                {k === 'quote_followup' && auto.quote_followup && (
                  <div className="mt-1 mb-2 ml-0 sm:ml-4 rounded-xl border border-border bg-bg-secondary p-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Wait before chasing</span>
                      <span className="flex items-center gap-2">
                        <input
                          type="number" min={1} max={60} value={policy.delayDays}
                          onChange={e => setPolicy({ ...policy, delayDays: Number(e.target.value) })}
                          onBlur={e => savePolicy({ delayDays: Math.min(60, Math.max(1, Math.floor(Number(e.target.value)) || FOLLOW_UP_DAYS)) })}
                          className="w-20 bg-bg-tertiary border border-border-strong rounded-lg px-2.5 py-1.5 text-sm text-ink tabular-nums outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20"
                        />
                        <span className="text-xs text-ink-muted">days of silence</span>
                      </span>
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Chase at most</span>
                      <span className="flex items-center gap-2">
                        <input
                          type="number" min={0} max={10} value={policy.maxCount}
                          onChange={e => setPolicy({ ...policy, maxCount: Number(e.target.value) })}
                          onBlur={e => savePolicy({ maxCount: Math.min(10, Math.max(0, Math.floor(Number(e.target.value)) || 0)) })}
                          className="w-20 bg-bg-tertiary border border-border-strong rounded-lg px-2.5 py-1.5 text-sm text-ink tabular-nums outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20"
                        />
                        <span className="text-xs text-ink-muted">times per quote</span>
                      </span>
                    </label>
                    <p className="sm:col-span-2 text-[11px] text-ink-faint">
                      A quote goes quiet for {policy.delayDays} day{policy.delayDays !== 1 ? 's' : ''} → it gets chased, up to {policy.maxCount} time{policy.maxCount !== 1 ? 's' : ''}, then stops. Turning this on also chases quotes already sitting in Sent.
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
