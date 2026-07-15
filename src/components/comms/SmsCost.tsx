'use client'

import { analyzeSms, smsCost, formatSmsCost } from '@/lib/sms/segments'
import { useSmsPricing } from '@/lib/sms/useSmsPricing'
import { cn } from '@/lib/utils'
import { MessageSquareText } from 'lucide-react'

interface Props {
  text: string                 // the live message body being composed
  recipients?: number          // >1 → bulk totals; omit/1 → single-message view
  mms?: boolean                // media/MMS or another type we can't price → "Estimate unavailable"
  label?: string
  className?: string
}

const DISCLAIMER = 'Estimated messaging cost. Actual carrier/provider charges may vary.'

// Drop-in SMS segment + cost estimate for ANY message composer. Updates live as
// `text` changes. Encoding-aware (GSM-7 vs Unicode) and uses the owner's
// configurable pricing (Business Settings → Messaging). Purely informational — it
// never blocks longer messages. Renders nothing for an empty body.
export function SmsCost({ text, recipients, mms, label = 'Estimated SMS cost', className }: Props) {
  const pricing = useSmsPricing()
  const info = analyzeSms(text)

  // Don't show a (wrong) SMS estimate for an MMS / unknown message type.
  if (mms) {
    return (
      <div className={cn('rounded-lg border border-border bg-surface/40 px-3 py-2 text-[11px]', className)}>
        <p className="flex items-center gap-1.5 text-ink-muted font-semibold uppercase tracking-wide text-[10px] mb-0.5">
          <MessageSquareText className="w-3 h-3" /> {label}
        </p>
        <p className="text-ink-muted leading-snug">Estimate unavailable — this looks like an MMS / media message, which is priced differently.</p>
        <p className="text-ink-faint italic mt-1 leading-snug">{DISCLAIMER}</p>
      </div>
    )
  }

  if (info.segments === 0) return null

  const bulk = recipients != null && recipients > 1
  const count = bulk ? recipients! : 1
  const totalSegments = info.segments * count
  const cost = smsCost(info.segments, info.encoding, count, pricing)
  const note = info.segments < 2 ? null
    : info.segments === 2
      ? 'This message uses 2 SMS segments and may cost approximately twice as much as a standard SMS.'
      : `This message uses ${info.segments} SMS segments and may cost approximately ${info.segments}× as much as a standard SMS.`

  return (
    <div className={cn('rounded-lg border border-border bg-surface/40 px-3 py-2 text-[11px]', className)}>
      <p className="flex items-center gap-1.5 text-ink-muted font-semibold uppercase tracking-wide text-[10px] mb-0.5">
        <MessageSquareText className="w-3 h-3" /> {label}
        {info.encoding === 'Unicode' && (
          <span className="ml-1 normal-case font-normal text-amber-400/90" title="A non-GSM character (e.g. emoji or a curly quote) makes this a Unicode message — fewer characters fit per segment.">Unicode</span>
        )}
      </p>
      {bulk ? (
        <p className="text-ink-muted leading-snug">
          Recipients: <b className="text-ink">{count}</b> · Segments each: <b className="text-ink">{info.segments}</b> · Total: <b className="text-ink">{totalSegments}</b> segments · Est. Total: <b className="text-ink">{formatSmsCost(cost, pricing.currency)}</b>
        </p>
      ) : (
        <p className="text-ink-muted leading-snug">
          Characters: <b className="text-ink">{info.chars}</b> · SMS Segments: <b className="text-ink">{info.segments}</b> · Est. Cost: <b className="text-ink">{formatSmsCost(cost, pricing.currency)}</b>
        </p>
      )}
      {note && <p className="text-ink-faint mt-1 leading-snug">{note}</p>}
      <p className="text-ink-faint italic mt-1 leading-snug">{DISCLAIMER}</p>
    </div>
  )
}
