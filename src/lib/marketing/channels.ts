import { Facebook, Instagram, Linkedin, Store, Home, AtSign, type LucideIcon } from 'lucide-react'
import type { MarketingChannel } from './types'

// ── Marketing channels ──────────────────────────────────────────────────────────
// The 6 organic social surfaces a lawn-care owner posts to. Each entry drives the
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
  // A one-line note on the platform's voice — used by the rewrite tools.
  styleHint: string
  // The full platform "playbook": tone, formatting and rhythm. This is what makes a
  // Facebook post not read like a LinkedIn post. Fed into the generation prompt.
  playbook: string
  // How much emoji this platform should carry. Caps the owner's emoji toggle: 'none'
  // always wins (GBP/Nextdoor read as spam with emoji); 'sparing'/'ok' respect it.
  emoji: 'none' | 'sparing' | 'ok'
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
    playbook: 'Facebook reads like a warm community update from a real owner. Two to four short sentences with a line break or two so it breathes. Conversational and a little proud — room for a small story or a neighbourly note. Hashtags are minimal here (1-3, at the very end).',
    emoji: 'sparing',
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
    playbook: 'Instagram is visual-first — the photo does the heavy lifting. A punchy one-line hook, then one or two tight lines of caption. Energetic and modern. This is where hashtags earn discovery, so a fuller, well-chosen set belongs at the end.',
    emoji: 'ok',
    openUrl: 'https://www.instagram.com/',
    usesTitle: false,
  },
  {
    key: 'threads',
    label: 'Threads',
    icon: AtSign,
    maxChars: 450,
    usesHashtags: true,
    styleHint: 'Casual and conversational, text-first — like a real person thinking out loud. One strong hook line, then a thought or two. Keep hashtags minimal (1-2 topic tags at most).',
    playbook: 'Threads is text-first and casual — like a real person thinking out loud, not an ad. One strong opening line, then a thought or two. Dry wit lands here. Keep hashtags to 1-2 topic tags at most.',
    emoji: 'sparing',
    openUrl: 'https://www.threads.net/',
    usesTitle: false,
  },
  {
    key: 'gbp',
    label: 'Google Business',
    icon: Store,
    maxChars: 700,
    usesHashtags: false,
    styleHint: 'Professional and local-SEO aware. Name the neighborhood and the service plainly. End with a clear booking CTA. No hashtags.',
    playbook: 'Google Business is a short, confident business note that also helps local search. Name the service and the area plainly in natural sentences (a neighbour searching would use those words). End with one clear booking line. No emoji, no hashtags — those read as spam here.',
    emoji: 'none',
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
    playbook: 'Nextdoor is neighbour-to-neighbour. Plain-spoken, helpful, zero hype or sales gloss — these readers distrust marketing. Reference the specific area and sound like someone who actually lives and works there. No emoji, no hashtags.',
    emoji: 'none',
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
    playbook: 'LinkedIn is the owner speaking in first person — a short reflection on craft, reliability, or running a good local business. Professional and human, never a brochure. A few focused hashtags at the end; little to no emoji.',
    emoji: 'sparing',
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
