// ── Brand voice ─────────────────────────────────────────────────────────────────
// Turns the owner's existing business_settings (company name, owner, location,
// contact, review link) into a reusable voice profile + a prompt fragment, so the
// AI sounds like THIS business without the owner ever filling out a "brand voice"
// form. Pure + deterministic; consumed by the generate route and (via a hook) the UI.

// We only need a slice of business_settings — keep this decoupled from the full type.
export interface BrandSource {
  company_name?: string | null
  owner_name?: string | null
  phone?: string | null
  website?: string | null
  email_primary?: string | null
  base_address?: string | null
  review_url?: string | null
}

export interface BrandVoice {
  businessName: string
  ownerName: string | null
  phone: string | null
  website: string | null
  email: string | null
  city: string | null            // inferred from base_address for "local" framing
  reviewUrl: string | null
}

// Best-effort city from a free-text base address ("123 5 Ave SW, Calgary, AB").
function cityFromAddress(addr?: string | null): string | null {
  if (!addr) return null
  const parts = addr.split(',').map(p => p.trim()).filter(Boolean)
  // ".., City, Province PostalCode" → the city is usually the second-to-last part.
  if (parts.length >= 2) return parts[parts.length - 2] || null
  return null
}

export function deriveBrandVoice(src: BrandSource | null | undefined): BrandVoice {
  return {
    businessName: src?.company_name?.trim() || 'our company',
    ownerName: src?.owner_name?.trim() || null,
    phone: src?.phone?.trim() || null,
    website: src?.website?.trim() || null,
    email: src?.email_primary?.trim() || null,
    city: cityFromAddress(src?.base_address),
    reviewUrl: src?.review_url?.trim() || null,
  }
}

// A compact, stable system-prompt fragment describing the business. Kept terse so
// it caches well and doesn't drown the per-job context.
export function brandVoicePromptBlock(v: BrandVoice): string {
  const lines: string[] = [
    `Business name: ${v.businessName}`,
  ]
  if (v.ownerName) lines.push(`Owner: ${v.ownerName}`)
  if (v.city) lines.push(`Based in: ${v.city}`)
  if (v.phone) lines.push(`Phone: ${v.phone}`)
  if (v.website) lines.push(`Website: ${v.website}`)
  return lines.join('\n')
}
