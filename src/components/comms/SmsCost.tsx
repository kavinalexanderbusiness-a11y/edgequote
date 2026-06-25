'use client'

import { analyzeSms, smsCostCad, formatSmsCost } from '@/lib/sms/segments'
import { cn } from '@/lib/utils'
import { MessageSquareText } from 'lucide-react'

interface Props {
  text: string                 // the live message body being composed
  recipients?: number          // >1 → bulk totals; omit/1 → single-message view
  label?: string
  className?: string
}

// Drop-in SMS segment + cost estimate for ANY message composer. Updates live as
// `text` changes. Encoding-aware (GSM-7 vs Unicode) so the segment count is real.
// Never blocks longer messages — it's purely informational. Renders nothing for
// an empty body so it stays out of the way until there's something to send.
export function SmsCost({ text, recipients, label = 'SMS Preview', className }: Props) {
  const info = analyzeSms(text)
  if (info.segments === 0) return null

  const bulk = recipients != null && recipients > 1
  const count = bulk ? recipients! : 1
  const totalSegments = info.segments * count
  const cost = smsCostCad(info.segments, count)
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
          Recipients: <b className="text-ink">{count}</b> · Segments each: <b className="text-ink">{info.segments}</b> · Total: <b className="text-ink">{totalSegments}</b> segments · Est. Total: <b className="text-ink">{formatSmsCost(cost)}</b>
        </p>
      ) : (
        <p className="text-ink-muted leading-snug">
          Characters: <b className="text-ink">{info.chars}</b> · SMS Segments: <b className="text-ink">{info.segments}</b> · Est. Cost: <b className="text-ink">{formatSmsCost(cost)}</b>
        </p>
      )}
      {note && <p className="text-ink-faint mt-1 leading-snug">{note}</p>}
    </div>
  )
}
