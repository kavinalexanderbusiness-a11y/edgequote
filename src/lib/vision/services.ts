// ── AI Vision — canonical service vocabulary ──────────────────────────────────
// One place that maps free text / service_keys to the canonical service keys used
// across opportunities, CRM gaps and marketing. Pure (no server-only) so both the
// server purchase-reader and the scoring engines share it.

export const SERVICE_MATCHERS: { key: string; label: string; re: RegExp }[] = [
  { key: 'mulch', label: 'Mulch refresh', re: /mulch/i },
  { key: 'aeration', label: 'Aeration', re: /aerat/i },
  { key: 'hedge_trim', label: 'Hedge / shrub trimming', re: /hedge|shrub|prun/i },
  { key: 'weed_control', label: 'Weed control', re: /weed/i },
  { key: 'fertilizer', label: 'Fertilizer', re: /fertil|feed/i },
  { key: 'overseeding', label: 'Overseeding', re: /overseed|over-seed|seeding/i },
  { key: 'cleanup', label: 'Seasonal cleanup', re: /clean\s?-?up/i },
  { key: 'edging', label: 'Edging', re: /edg/i },
]

export function serviceLabel(key: string): string {
  return SERVICE_MATCHERS.find(m => m.key === key)?.label || key.replace(/_/g, ' ')
}

// Canonical keys any free text / service_key matches.
export function serviceKeysFor(text: string | null | undefined): string[] {
  if (!text) return []
  return SERVICE_MATCHERS.filter(m => m.re.test(text)).map(m => m.key)
}
