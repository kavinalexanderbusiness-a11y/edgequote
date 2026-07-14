'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { resolveAutomations, Automations, AUTOMATION_LABELS } from '@/lib/comms/automations'
import { cn } from '@/lib/utils'
import { Zap, Loader2 } from 'lucide-react'

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
    <Card className="mt-6">
      <CardHeader>
        <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><Zap className="w-4 h-4 text-accent" /> Automated messages</h2>
        <p className="text-xs text-ink-faint mt-0.5">Which messages send on their own. Per-customer SMS/email opt-in still applies — nothing sends to a customer who hasn’t consented.</p>
      </CardHeader>
      <CardBody>
        {loading ? (
          <p className="text-xs text-ink-muted flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>
        ) : (
          <div className="space-y-2">
            {KEYS.map(k => (
              <div key={k} className="flex items-center justify-between gap-3 py-1.5">
                <div className="min-w-0">
                  <p className="text-sm text-ink">{AUTOMATION_LABELS[k]}</p>
                  <p className="text-xs text-ink-faint">{HINTS[k]}</p>
                </div>
                <button onClick={() => toggle(k, !auto[k])} role="switch" aria-checked={auto[k]}
                  className={cn('w-11 h-6 rounded-full border transition-colors shrink-0 relative', auto[k] ? 'bg-accent border-accent' : 'bg-bg-tertiary border-border')}>
                  <span className={cn('absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all', auto[k] ? 'left-[22px]' : 'left-0.5')} />
                </button>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
