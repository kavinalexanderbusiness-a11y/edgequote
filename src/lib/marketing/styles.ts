import type { WritingStyle } from './types'

// ── Writing styles ────────────────────────────────────────────────────────────────
// The brand attributes (professional, friendly, local, premium, honest, confident) are
// ALWAYS on. A style is a lens layered on top — it shifts emphasis, not the voice. Each
// is one directive line fed into the prompt, so a new style is one row here, never a
// new prompt. Picked by the owner before generating.

export const WRITING_STYLES: Record<WritingStyle, { label: string; blurb: string; directive: string }> = {
  professional: {
    label: 'Professional',
    blurb: 'Polished and credible',
    directive: 'Style: clear, polished and credible. Lead with quiet competence. No fluff, no filler — every line earns its place.',
  },
  premium: {
    label: 'Premium',
    blurb: 'Quality-first, understated',
    directive: 'Style: quietly premium. The confidence of a business that never needs to discount. Refined and quality-first, never flashy or boastful.',
  },
  friendly: {
    label: 'Friendly',
    blurb: 'Warm neighbour next door',
    directive: 'Style: warm and conversational, like a trusted neighbour talking over the fence. Easy, human, genuine.',
  },
  educational: {
    label: 'Educational',
    blurb: 'Teach one useful thing',
    directive: 'Style: teach ONE genuinely useful insight about this kind of work or the season, tied to this job. Helpful first, never a lecture, never salesy. The reader should learn something.',
  },
  storytelling: {
    label: 'Storytelling',
    blurb: 'A tiny true moment',
    directive: 'Style: tell a tiny true story — a moment, a detail noticed, a before-to-after arc. A real beginning and a satisfying end in just a few lines.',
  },
  luxury: {
    label: 'Luxury',
    blurb: 'White-glove, elegant',
    directive: 'Style: high-end and aspirational with elegant restraint — a white-glove, concierge feel. Evocative but never overwrought or purple.',
  },
  community: {
    label: 'Community',
    blurb: 'Local pride & belonging',
    directive: 'Style: neighbourhood pride and belonging — we live and work here too. Grounded, local, a little civic. Make the reader feel part of the area.',
  },
  funny: {
    label: 'Funny',
    blurb: 'One light, tasteful joke',
    directive: 'Style: one light, tasteful touch of humour — a wry line or a knowing wink. Stay professional; never goofy, corny, or at the customer’s expense.',
  },
  promotional: {
    label: 'Promotional',
    blurb: 'A clear, tasteful nudge',
    directive: 'Style: a clear, tasteful reason to act now — a seasonal opening or a genuine prompt to book. Confident and specific, never pushy or discount-y.',
  },
}

export function styleDirective(style: WritingStyle): string {
  return (WRITING_STYLES[style] || WRITING_STYLES.professional).directive
}
