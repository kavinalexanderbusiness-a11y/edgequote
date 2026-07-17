'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Skeleton } from '@/components/ui/Skeleton'
import { SmsCost } from '@/components/comms/SmsCost'
import { renderMessage, type MsgType } from '@/lib/comms/templates'
import { previewAudience, describeSample, type AudiencePreview } from '@/lib/crm/audience'
import type { CampaignKind, CampaignAudience, CampaignSchedule } from '@/types'
import { cn } from '@/lib/utils'
import { Users, MessageSquare, Mail, AlertTriangle } from 'lucide-react'

// What this campaign will do, before it does it — the two questions an owner has
// before flipping the switch on real customer messages: WHO gets this, and WHAT
// does it say?
//
// Both answers come from the engines that do the actual work: previewAudience()
// is the same resolver the cron sends with, and renderMessage() is the same
// renderer. Nothing here re-implements either, so the preview can't promise
// something the send path won't honour.

interface Props {
  userId: string
  kind: CampaignKind
  schedule: CampaignSchedule
  audience: CampaignAudience
  channels: string[]
  template: MsgType
  customBody: string
  subject: string
  businessName: string
  reviewUrl: string | null
}

export function CampaignPreview({
  userId, kind, schedule, audience, channels, template, customBody, subject, businessName, reviewUrl,
}: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [aud, setAud] = useState<AudiencePreview | null>(null)
  const [loading, setLoading] = useState(true)

  // Re-resolve when anything that changes WHO changes. Serialised so a slow
  // response can't overwrite a newer one.
  const audKey = JSON.stringify({ kind, schedule, audience, channels, template })
  useEffect(() => {
    let alive = true
    setLoading(true)
    previewAudience(supabase, { userId, kind, schedule, audience, today: new Date() }, channels, template)
      .then(r => { if (alive) { setAud(r); setLoading(false) } })
      .catch(() => { if (alive) { setAud(null); setLoading(false) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, userId, audKey])

  // The message exactly as the customer receives it — same engine as the send,
  // addressed to a real name from the audience so it reads like a real message.
  const sampleName = aud?.sample[0] || 'there'
  const rendered = useMemo(() => renderMessage(
    template,
    customBody.trim() ? { [template]: customBody } as Partial<Record<MsgType, string>> : null,
    {
      firstName: sampleName,
      businessName: businessName || 'Your business',
      reviewLink: reviewUrl || 'https://g.page/your-business/review',
      portalLink: 'https://portal.yourbusiness.com/…',
    },
    subject,
  ), [template, customBody, subject, sampleName, businessName, reviewUrl])

  const showSms = channels.includes('sms')
  const showEmail = channels.includes('email')

  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Before you turn it on</span>

      {/* ── WHO ── */}
      <div className="rounded-xl border border-border bg-surface/40 px-3 py-2.5">
        {loading ? (
          <div className="flex flex-col gap-1.5"><Skeleton className="h-3.5 w-40" /><Skeleton className="h-2.5 w-56" /></div>
        ) : !aud ? (
          <p className="text-xs text-ink-faint">Couldn’t work out the audience just now.</p>
        ) : (
          <>
            <p className="text-sm font-semibold text-ink flex items-center gap-1.5 tabular-nums">
              <Users className="w-3.5 h-3.5 text-accent-text shrink-0" />
              {aud.reachable === 0
                ? 'Reaches nobody yet'
                : `Reaches ${aud.reachable} customer${aud.reachable === 1 ? '' : 's'}`}
            </p>
            {aud.eligible > 0 && (
              <p className="text-[11px] text-ink-muted mt-0.5 truncate">{describeSample(aud)}</p>
            )}
            {/* Say the true thing: who is filtered IN but still can't be messaged. */}
            {aud.blocked.length > 0 && (
              <p className="text-[11px] text-ink-faint mt-1 leading-snug">
                {aud.eligible - aud.reachable} of {aud.eligible} can’t be reached —{' '}
                {aud.blocked.map(b => `${b.count} ${b.label}`).join(', ')}.
              </p>
            )}
            {aud.capped && (
              <p className="text-[11px] text-amber-400 mt-1 flex items-start gap-1 leading-snug">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                More than 2,000 customers match. Each run sends to the first 2,000.
              </p>
            )}
            {kind === 'birthday' || kind === 'anniversary' ? (
              <p className="text-[11px] text-ink-faint mt-1 leading-snug">
                This is the pool it watches — each customer only gets it on their own date.
              </p>
            ) : null}
          </>
        )}
      </div>

      {/* ── WHAT ── */}
      {showSms && (
        <div className="rounded-xl border border-border bg-surface/40 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted flex items-center gap-1.5 mb-1.5">
            <MessageSquare className="w-3 h-3" /> Text message
          </p>
          <p className="text-xs text-ink whitespace-pre-wrap leading-relaxed">{rendered.sms}</p>
        </div>
      )}
      {showEmail && (
        <div className="rounded-xl border border-border bg-surface/40 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted flex items-center gap-1.5 mb-1.5">
            <Mail className="w-3 h-3" /> Email
          </p>
          <p className="text-xs font-semibold text-ink truncate">{rendered.subject}</p>
          <p className={cn('text-xs text-ink-muted whitespace-pre-wrap leading-relaxed mt-1')}>{rendered.text}</p>
        </div>
      )}

      {/* Same cost estimate every other composer in the app shows. Informational
          only — it never blocks a send. */}
      {showSms && (
        <SmsCost text={rendered.sms} recipients={Math.max(1, aud?.reachable ?? 1)} label="Estimated cost per run" />
      )}
    </div>
  )
}
