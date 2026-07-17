'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Toggle } from '@/components/ui/Toggle'
import { Input } from '@/components/ui/Input'
import { Skeleton } from '@/components/ui/Skeleton'
import { resolveAutomations, Automations, AUTOMATION_LABELS } from '@/lib/comms/automations'
import { resolveFollowUpPolicy, type FollowUpPolicy } from '@/lib/followup'
import { resolveReminderPolicy } from '@/lib/payments/dunning'
import { Zap } from 'lucide-react'
import { HelpLink } from '@/components/help/HelpLink'

const KEYS: (keyof Automations)[] = ['reminder', 'job_complete', 'review', 'marketing_draft', 'quote_followup', 'invoice_reminder']

// The two chasers are tuned the same way — one cadence panel, driven by which
// jsonb keys each writes, rather than a second copy of the same two inputs.
interface Cadence {
  delayKey: string; maxKey: string
  delayLabel: string; maxLabel: string
  delayUnit: string; maxUnit: string
  summary: (p: FollowUpPolicy) => string
}
const CADENCE: Partial<Record<keyof Automations, Cadence>> = {
  quote_followup: {
    delayKey: 'quote_followup_delay_days', maxKey: 'quote_followup_max',
    delayLabel: 'Wait before chasing', maxLabel: 'Chase at most',
    delayUnit: 'days of silence', maxUnit: 'times per quote',
    summary: p => `A quote goes quiet for ${p.delayDays} day${p.delayDays !== 1 ? 's' : ''} → it gets chased, up to ${p.maxCount} time${p.maxCount !== 1 ? 's' : ''}, then stops. Turning this on also chases quotes already sitting in Sent.`,
  },
  invoice_reminder: {
    delayKey: 'invoice_reminder_delay_days', maxKey: 'invoice_reminder_max',
    delayLabel: 'Wait after due date', maxLabel: 'Remind at most',
    delayUnit: 'days overdue', maxUnit: 'times per invoice',
    summary: p => `An invoice is ${p.delayDays} day${p.delayDays !== 1 ? 's' : ''} past due → a reminder goes out, up to ${p.maxCount} time${p.maxCount !== 1 ? 's' : ''}, then stops. It stops on its own the moment the invoice is paid or cancelled. Turning this on also chases invoices already overdue.`,
  },
}
const HINTS: Record<keyof Automations, string> = {
  reminder: 'Texts/emails the customer the evening before their visit.',
  // Honest scope: only the Complete button attempts this send (the quick-edit status
  // dropdown doesn't), and a send can still be skipped for consent/contact reasons —
  // so point the owner at the evidence rather than promising delivery.
  job_complete: 'Attempts a message when you tap Complete on a visit — their timeline shows whether it went.',
  review: 'Asks for a review the day after a completed visit.',
  marketing_draft: 'Prepares a marketing post draft when a job has before & after photos — you review before anything posts.',
  quote_followup: 'Chases quotes the customer hasn’t answered. Stops on its own the moment a quote is accepted, declined or invoiced.',
  invoice_reminder: 'Chases invoices past their due date. Stops on its own as soon as the invoice is paid or cancelled.',
}

export function AutomationToggles() {
  const supabase = useMemo(() => createClient(), [])
  const [auto, setAuto] = useState<Automations>(() => resolveAutomations(null))
  // One policy per chaser, both resolved from (and written back into) the same
  // automations jsonb.
  const [policies, setPolicies] = useState<Record<string, FollowUpPolicy>>({
    quote_followup: resolveFollowUpPolicy(null),
    invoice_reminder: resolveReminderPolicy(null),
  })
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
    setPolicies({ quote_followup: resolveFollowUpPolicy(value), invoice_reminder: resolveReminderPolicy(value) })
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

  async function savePolicy(key: keyof Automations, patch: Partial<FollowUpPolicy>) {
    const cfg = CADENCE[key]
    if (!cfg) return
    const prev = policies
    const next = { ...policies[key], ...patch }
    setPolicies({ ...policies, [key]: next })   // optimistic
    const ok = await persist({ [cfg.delayKey]: next.delayDays, [cfg.maxKey]: next.maxCount })
    if (!ok) setPolicies(prev)
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
          <Zap className="w-4 h-4 text-accent-text" /> Automated messages
          <HelpLink id="what-sends-itself" />
        </h2>
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
                {CADENCE[k] && auto[k] && (
                  <div className="mt-1 mb-2 ml-0 sm:ml-4 rounded-xl border border-border bg-bg-secondary p-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="flex items-end gap-2">
                      <Input
                        label={CADENCE[k]!.delayLabel} fieldSize="sm" className="w-20 tabular-nums"
                        type="number" min={1} max={60} value={policies[k].delayDays}
                        onChange={e => setPolicies({ ...policies, [k]: { ...policies[k], delayDays: Number(e.target.value) } })}
                        onBlur={e => savePolicy(k, { delayDays: Math.min(60, Math.max(1, Math.floor(Number(e.target.value)) || 3)) })}
                      />
                      <span className="text-xs text-ink-muted pb-2">{CADENCE[k]!.delayUnit}</span>
                    </div>
                    <div className="flex items-end gap-2">
                      <Input
                        label={CADENCE[k]!.maxLabel} fieldSize="sm" className="w-20 tabular-nums"
                        type="number" min={0} max={10} value={policies[k].maxCount}
                        onChange={e => setPolicies({ ...policies, [k]: { ...policies[k], maxCount: Number(e.target.value) } })}
                        onBlur={e => savePolicy(k, { maxCount: Math.min(10, Math.max(0, Math.floor(Number(e.target.value)) || 0)) })}
                      />
                      <span className="text-xs text-ink-muted pb-2">{CADENCE[k]!.maxUnit}</span>
                    </div>
                    <p className="sm:col-span-2 text-[11px] text-ink-faint">{CADENCE[k]!.summary(policies[k])}</p>
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
