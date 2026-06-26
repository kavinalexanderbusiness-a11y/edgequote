import { Facebook, Instagram, Linkedin, Store, Home, type LucideIcon } from 'lucide-react'
import type { MarketingChannel } from './types'

// ── Marketing channels ──────────────────────────────────────────────────────────
// The 5 organic social surfaces a lawn-care owner posts to. Each entry drives the
// channel tabs, the AI prompt constraints, and the v1 "copy & open" publish flow
// (we generate + brand + copy-to-clipboard + deep-link the owner into the platform;
// direct publishing via platform APIs is a later phase). `openUrl` is where the
// owner goes to paste; `usesHashtags` and `maxChars` shape the generated draft.

export interface ChannelDef {
  key: MarketingChannel
  label: string
  icon: LucideIcon
  // Soft length target handed to the model — not a hard cap (the owner edits).
  maxChars: number
  usesHashtags: boolean
  // A one-line note on the platform's voice, fed into the prompt.
  styleHint: string
  // Where to post in v1. The composer copies the caption + downloads the image,
  // then opens this so the owner pastes into the real composer.
  openUrl: string
  // Whether a separate headline/title is meaningful (GBP/LinkedIn) vs caption-only.
  usesTitle: boolean
}

export const CHANNELS: ChannelDef[] = [
  {
    key: 'facebook',
    label: 'Facebook',
    icon: Facebook,
    maxChars: 600,
    usesHashtags: true,
    styleHint: 'Friendly, community-minded, a little proud. Conversational. A clear call to message or book.',
    openUrl: 'https://www.facebook.com/',
    usesTitle: false,
  },
  {
    key: 'instagram',
    label: 'Instagram',
    icon: Instagram,
    maxChars: 400,
    usesHashtags: true,
    styleHint: 'Punchy and visual-first. Short hook up top. Heavier on relevant hashtags. Emoji are welcome but sparing.',
    openUrl: 'https://www.instagram.com/',
    usesTitle: false,
  },
  {
    key: 'gbp',
    label: 'Google Business',
    icon: Store,
    maxChars: 700,
    usesHashtags: false,
    styleHint: 'Professional and local-SEO aware. Name the neighborhood and the service plainly. End with a clear booking CTA. No hashtags.',
    openUrl: 'https://business.google.com/posts',
    usesTitle: true,
  },
  {
    key: 'nextdoor',
    label: 'Nextdoor',
    icon: Home,
    maxChars: 500,
    usesHashtags: false,
    styleHint: 'Neighbourly and trustworthy — you live and work here. Reference the specific neighborhood. No salesy hype, no hashtags.',
    openUrl: 'https://nextdoor.com/',
    usesTitle: false,
  },
  {
    key: 'linkedin',
    label: 'LinkedIn',
    icon: Linkedin,
    maxChars: 700,
    usesHashtags: true,
    styleHint: 'Owner-operator voice. A short story about craft, reliability, or growth. Professional but human. A few focused hashtags.',
    openUrl: 'https://www.linkedin.com/feed/',
    usesTitle: false,
  },
]

const BY_KEY: Record<MarketingChannel, ChannelDef> = CHANNELS.reduce(
  (acc, c) => { acc[c.key] = c; return acc },
  {} as Record<MarketingChannel, ChannelDef>,
)

export function channel(key: MarketingChannel): ChannelDef {
  return BY_KEY[key]
}

export function isChannel(v: unknown): v is MarketingChannel {
  return typeof v === 'string' && v in BY_KEY
}
