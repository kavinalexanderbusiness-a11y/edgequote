'use client'

import { cn } from '@/lib/utils'
import { channel as channelDef } from '@/lib/marketing/channels'
import type { MarketingChannel } from '@/lib/marketing/types'

// A lightweight "this is what it'll look like" mock of the post on the chosen
// platform — header (logo + business name + channel), optional image, body,
// hashtags. Not pixel-perfect per platform; enough that the owner trusts the post
// before they paste it.
export function ChannelPreview({ ch, businessName, logoUrl, title, body, hashtags, imageUrl }: {
  ch: MarketingChannel
  businessName: string
  logoUrl: string | null
  title?: string | null
  body: string
  hashtags: string[]
  imageUrl?: string | null
}) {
  const def = channelDef(ch)
  const Icon = def.icon
  return (
    <div className="rounded-card border border-border bg-bg-secondary overflow-hidden">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-border">
        <div className="w-8 h-8 rounded-full overflow-hidden bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <span className="text-[11px] font-bold text-accent">{businessName.slice(0, 2).toUpperCase()}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-ink truncate">{businessName}</p>
          <p className="text-[10px] text-ink-faint inline-flex items-center gap-1"><Icon className="w-3 h-3" />{def.label}</p>
        </div>
      </div>
      {imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt="" className="w-full max-h-72 object-cover bg-bg-tertiary" />
      )}
      <div className="px-3.5 py-3 space-y-2">
        {title && <p className="text-sm font-semibold text-ink">{title}</p>}
        <p className={cn('text-sm text-ink whitespace-pre-wrap leading-relaxed', !body && 'text-ink-faint italic')}>
          {body || 'Your post will appear here.'}
        </p>
        {hashtags.length > 0 && (
          <p className="text-sm text-accent break-words">
            {hashtags.map(h => `#${h}`).join(' ')}
          </p>
        )}
      </div>
    </div>
  )
}
