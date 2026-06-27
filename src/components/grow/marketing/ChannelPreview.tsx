'use client'

import { MoreHorizontal, ThumbsUp, MessageCircle, Share2, Send, Heart, Bookmark, Repeat2, Globe } from 'lucide-react'
import type { MarketingChannel } from '@/lib/marketing/types'

// ── Channel preview ───────────────────────────────────────────────────────────────
// A faithful mock of the post AS IT WILL LOOK on each real platform — authentic chrome,
// typography and colours (rendered on the platform's own light surface, not the app
// theme), so the owner trusts the post before they paste it. Each platform has its own
// layout because a Facebook post genuinely does not look like a LinkedIn one.

interface PreviewProps {
  ch: MarketingChannel
  businessName: string
  logoUrl: string | null
  title?: string | null
  body: string
  hashtags: string[]
  imageUrl?: string | null
}

function Avatar({ logoUrl, businessName, size = 40, ring }: { logoUrl: string | null; businessName: string; size?: number; ring?: boolean }) {
  const initials = businessName.replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'EQ'
  return logoUrl
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={logoUrl} alt="" className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />
    : <div className="rounded-full shrink-0 flex items-center justify-center text-white font-bold bg-gradient-to-br from-emerald-500 to-teal-600" style={{ width: size, height: size, fontSize: Math.round(size * 0.38), boxShadow: ring ? '0 0 0 2px #fff, 0 0 0 4px #ec4899' : undefined }}>{initials}</div>
}

function Body({ body, hashtags, link, placeholder }: { body: string; hashtags?: string[]; link: string; placeholder: string }) {
  return (
    <>
      <p className="whitespace-pre-wrap break-words leading-snug">{body || <span className="italic text-gray-400">{placeholder}</span>}</p>
      {hashtags && hashtags.length > 0 && (
        <p className="mt-1 break-words" style={{ color: link }}>{hashtags.map(h => `#${h.replace(/^#/, '')}`).join(' ')}</p>
      )}
    </>
  )
}

function PostImage({ url, className }: { url: string; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className={className || 'w-full object-cover bg-gray-100'} />
}

const PLACEHOLDER = 'Your post will appear here as you generate it…'

export function ChannelPreview(props: PreviewProps) {
  // The preview is a faithful but READ-ONLY mock: default cursor + non-selectable +
  // pointer-events-none so it never looks or behaves like a text field. The caption
  // is only ever edited in the composer above.
  const Card = ({ children }: { children: React.ReactNode }) => (
    <div aria-hidden className="rounded-xl overflow-hidden border border-gray-200 shadow-sm bg-white text-[13px] cursor-default select-none pointer-events-none">{children}</div>
  )
  switch (props.ch) {
    case 'facebook': return <Card><Facebook {...props} /></Card>
    case 'instagram': return <Card><Instagram {...props} /></Card>
    case 'threads': return <Card><Threads {...props} /></Card>
    case 'gbp': return <Card><Gbp {...props} /></Card>
    case 'nextdoor': return <Card><Nextdoor {...props} /></Card>
    case 'linkedin': return <Card><LinkedIn {...props} /></Card>
  }
}

// ── Facebook ──
function Facebook({ businessName, logoUrl, body, hashtags, imageUrl }: PreviewProps) {
  return (
    <div className="text-[#050505]">
      <div className="flex items-center gap-2 px-3 pt-3">
        <Avatar logoUrl={logoUrl} businessName={businessName} size={40} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-tight truncate">{businessName}</p>
          <p className="text-[11px] text-[#65676b] flex items-center gap-1">Just now · <Globe className="w-3 h-3" /></p>
        </div>
        <MoreHorizontal className="w-5 h-5 text-[#65676b]" />
      </div>
      <div className="px-3 py-2"><Body body={body} hashtags={hashtags} link="#385898" placeholder={PLACEHOLDER} /></div>
      {imageUrl && <PostImage url={imageUrl} className="w-full max-h-72 object-cover" />}
      <div className="flex items-center justify-around border-t border-gray-200 mt-1 px-2 py-1.5 text-[#65676b] text-[12px] font-semibold">
        <span className="flex items-center gap-1.5"><ThumbsUp className="w-4 h-4" /> Like</span>
        <span className="flex items-center gap-1.5"><MessageCircle className="w-4 h-4" /> Comment</span>
        <span className="flex items-center gap-1.5"><Share2 className="w-4 h-4" /> Share</span>
      </div>
    </div>
  )
}

// ── Instagram ──
function Instagram({ businessName, logoUrl, body, hashtags, imageUrl }: PreviewProps) {
  const handle = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24)
  return (
    <div className="text-[#262626]">
      <div className="flex items-center gap-2 px-3 py-2">
        <Avatar logoUrl={logoUrl} businessName={businessName} size={30} ring />
        <p className="font-semibold text-[13px] flex-1 truncate">{handle || 'yourbusiness'}</p>
        <MoreHorizontal className="w-5 h-5" />
      </div>
      {imageUrl
        ? <PostImage url={imageUrl} className="w-full aspect-square object-cover" />
        : <div className="w-full aspect-square bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center text-gray-400 text-xs">Photo goes here</div>}
      <div className="flex items-center gap-4 px-3 pt-2.5">
        <Heart className="w-6 h-6" /><MessageCircle className="w-6 h-6" /><Send className="w-6 h-6" />
        <Bookmark className="w-6 h-6 ml-auto" />
      </div>
      <div className="px-3 py-2">
        <p className="break-words leading-snug"><span className="font-semibold mr-1.5">{handle || 'yourbusiness'}</span>{body || <span className="italic text-gray-400">{PLACEHOLDER}</span>}</p>
        {hashtags.length > 0 && <p className="mt-1 break-words text-[#00376b]">{hashtags.map(h => `#${h.replace(/^#/, '')}`).join(' ')}</p>}
      </div>
    </div>
  )
}

// ── Threads ──
function Threads({ businessName, logoUrl, body, hashtags, imageUrl }: PreviewProps) {
  const handle = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24)
  return (
    <div className="text-black px-3 py-3">
      <div className="flex gap-2.5">
        <Avatar logoUrl={logoUrl} businessName={businessName} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="font-semibold truncate">{handle || 'yourbusiness'}</p>
            <span className="text-gray-400 text-[12px]">· just now</span>
            <MoreHorizontal className="w-4 h-4 text-gray-400 ml-auto" />
          </div>
          <div className="mt-0.5"><Body body={body} hashtags={hashtags.slice(0, 2)} link="#1d9bf0" placeholder={PLACEHOLDER} /></div>
          {imageUrl && <PostImage url={imageUrl} className="w-full max-h-64 object-cover rounded-xl border border-gray-200 mt-2" />}
          <div className="flex items-center gap-5 mt-2.5 text-black">
            <Heart className="w-[18px] h-[18px]" /><MessageCircle className="w-[18px] h-[18px]" /><Repeat2 className="w-[18px] h-[18px]" /><Send className="w-[18px] h-[18px]" />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Google Business Profile ──
function Gbp({ businessName, logoUrl, title, body, imageUrl }: PreviewProps) {
  return (
    <div className="text-[#202124]">
      {imageUrl && <PostImage url={imageUrl} className="w-full max-h-56 object-cover" />}
      <div className="px-3.5 py-3">
        <div className="flex items-center gap-2 mb-2">
          <Avatar logoUrl={logoUrl} businessName={businessName} size={28} />
          <div className="min-w-0">
            <p className="font-medium text-[13px] truncate">{businessName}</p>
            <p className="text-[11px] text-[#5f6368]">Google Business · Update</p>
          </div>
        </div>
        {title && <p className="font-semibold text-[15px] mb-1">{title}</p>}
        <p className="text-[#3c4043] whitespace-pre-wrap break-words leading-snug">{body || <span className="italic text-gray-400">{PLACEHOLDER}</span>}</p>
        <button className="mt-3 text-[#1a73e8] font-medium text-[13px] border border-[#dadce0] rounded-full px-4 py-1.5 hover:bg-[#f8faff]">Book online</button>
      </div>
    </div>
  )
}

// ── Nextdoor ──
function Nextdoor({ businessName, logoUrl, body, imageUrl }: PreviewProps) {
  return (
    <div className="text-[#222]">
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <Avatar logoUrl={logoUrl} businessName={businessName} size={38} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-tight truncate">{businessName}</p>
          <p className="text-[11px] text-[#767676]">Local business · Just now</p>
        </div>
        <MoreHorizontal className="w-5 h-5 text-[#767676]" />
      </div>
      <div className="px-3.5 py-2"><p className="whitespace-pre-wrap break-words leading-snug">{body || <span className="italic text-gray-400">{PLACEHOLDER}</span>}</p></div>
      {imageUrl && <PostImage url={imageUrl} className="w-full max-h-64 object-cover" />}
      <div className="flex items-center gap-6 border-t border-gray-200 mt-1 px-3.5 py-2 text-[#767676] text-[12px] font-medium">
        <span className="flex items-center gap-1.5"><ThumbsUp className="w-4 h-4" /> Like</span>
        <span className="flex items-center gap-1.5"><MessageCircle className="w-4 h-4" /> Reply</span>
        <span className="flex items-center gap-1.5"><Share2 className="w-4 h-4" /> Share</span>
      </div>
    </div>
  )
}

// ── LinkedIn ──
function LinkedIn({ businessName, logoUrl, body, hashtags, imageUrl }: PreviewProps) {
  return (
    <div className="text-[rgba(0,0,0,0.9)]">
      <div className="flex items-start gap-2 px-3 pt-3">
        <Avatar logoUrl={logoUrl} businessName={businessName} size={44} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-tight truncate">{businessName}</p>
          <p className="text-[11px] text-[rgba(0,0,0,0.6)] leading-tight">Local property care · Owner</p>
          <p className="text-[11px] text-[rgba(0,0,0,0.6)] flex items-center gap-1">Just now · <Globe className="w-3 h-3" /></p>
        </div>
        <MoreHorizontal className="w-5 h-5 text-[rgba(0,0,0,0.6)]" />
      </div>
      <div className="px-3 py-2"><Body body={body} hashtags={hashtags} link="#0a66c2" placeholder={PLACEHOLDER} /></div>
      {imageUrl && <PostImage url={imageUrl} className="w-full max-h-72 object-cover" />}
      <div className="flex items-center justify-around border-t border-gray-200 mt-1 px-2 py-1.5 text-[rgba(0,0,0,0.6)] text-[12px] font-semibold">
        <span className="flex items-center gap-1.5"><ThumbsUp className="w-4 h-4" /> Like</span>
        <span className="flex items-center gap-1.5"><MessageCircle className="w-4 h-4" /> Comment</span>
        <span className="flex items-center gap-1.5"><Repeat2 className="w-4 h-4" /> Repost</span>
        <span className="flex items-center gap-1.5"><Send className="w-4 h-4" /> Send</span>
      </div>
    </div>
  )
}
