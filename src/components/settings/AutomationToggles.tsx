'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Toggle } from '@/components/ui/Toggle'
import { Skeleton } from '@/components/ui/Skeleton'
import { resolveAutomations, Automations, AUTOMATION_LABELS } from '@/lib/comms/automations'
import { Zap } from 'lucide-react'

const KEYS: (keyof Automations)[] = ['reminder', 'job_complete', 'review', 'marketing_draft']
const HINTS: Record<keyof Automations, string> = {
  reminder: 'Texts/emails the customer the evening before their visit.',
  job_complete: 'Sends automatically when you mark a visit complete.',
  review: 'Asks for a Google review the day after a completed visit.',
  marketing_draft: 'Prepares a marketing post draft when a job has before & after photos — you review before anything posts.',
}

export function AutomationToggles() {
  const supabase = useMemo(() => createClient(), [])
  const [auto, setAuto] = useState<Automations>({ reminder: true, job_complete: true, review: true, marketing_draft: true })
  const [loading, setLoading] = useState(true)

  async function load() {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setLoading(false); return }
    const { data } = await supabase.from('business_settings').select('automations').eq('user_id', user.id).maybeSingle()
    setAuto(resolveAutomations((data as { automations: unknown } | null)?.automations))
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle(key: keyof Automations, value: boolean) {
    const prev = auto
    const next = { ...auto, [key]: value }
    setAuto(next)   // optimistic
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setAuto(prev); return }
    const { error } = await supabase.from('business_settings').update({ automations: next }).eq('user_id', user.id)
    if (error) setAuto(prev)   // revert — never show a toggle the cron won't honor
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><Zap className="w-4 h-4 text-accent" /> Automated messages</h2>
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
              <div key={k} className="flex items-center justify-between gap-3 py-1.5">
                <div className="min-w-0">
                  <p className="text-sm text-ink">{AUTOMATION_LABELS[k]}</p>
                  <p className="text-xs text-ink-faint">{HINTS[k]}</p>
                </div>
                <Toggle checked={auto[k]} onChange={v => toggle(k, v)} ariaLabel={AUTOMATION_LABELS[k]} />
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
