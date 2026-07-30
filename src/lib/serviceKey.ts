// ── Service identity — the leaf every learning bucket keys off ──────────────
// Moved out of lib/labor because labor.ts imports the PRICING engine and the
// economics model, and serviceKey has exactly one consumer that has nothing to
// do with either: lib/dedup (photo de-duplication), which the always-mounted
// UploadQueueWidget pulls into the dashboard LAYOUT bundle on every page. Two
// pure functions and a regex table were dragging pricing into the shell.
//
// This module imports NOTHING — that is the entire point. lib/labor re-exports
// serviceKey/serviceLabel, so all nine existing importers are unchanged.

// Every service builds its OWN knowledge: mowing learns only from mowing, mulch
// only from mulch, rock only from rock, spring cleanup only from spring cleanup.
// Edging/trimming fold INTO mowing (they ride along on a mow visit); everything
// else stays separate. Unknown/ad-hoc services slug to their own bucket so even a
// service we never enumerated still accrues history. Keyed off the free-text
// service_type — the only service identity labor_observations / quotes both carry.
// Order matters: more specific patterns win (snow & seasonal cleanups before the
// generic ones; mowing last so its broad /cut|trim|edg/ never steals another service).
interface ServiceDef { key: string; label: string; re: RegExp }
const SERVICE_DEFS: ServiceDef[] = [
  { key: 'snow',           label: 'Snow removal',     re: /snow|plow|plough|shovel|\bice\b|salt|de-?ice/i },
  { key: 'spring-cleanup', label: 'Spring cleanup',   re: /spring[\s-]*(clean|clear|tidy|refresh)/i },
  { key: 'fall-cleanup',   label: 'Fall cleanup',     re: /(fall|autumn)[\s-]*(clean|clear|tidy)|leaf|leaves/i },
  { key: 'cleanup',        label: 'Yard cleanup',     re: /clean[\s-]*up|yard[\s-]*clean|debris|tidy[\s-]*up/i },
  { key: 'mulch',          label: 'Mulch',            re: /mulch/i },
  { key: 'rock',           label: 'Rock / stone',     re: /\brock|\bstone|gravel|river[\s-]*rock|aggregate|landscape[\s-]*fabric/i },
  { key: 'sod',            label: 'Sod / new lawn',   re: /\bsod\b|turf[\s-]*install|new[\s-]*lawn|lawn[\s-]*install/i },
  { key: 'aeration',       label: 'Aeration',         re: /aerat|dethatch|de-?thatch|overseed|core[\s-]*aerat/i },
  { key: 'fertilizing',    label: 'Fertilizing',      re: /fertil|weed[\s&]*feed|lawn[\s-]*treatment|nutrient/i },
  { key: 'weed-control',   label: 'Weed control',     re: /weed/i },
  { key: 'hedge',          label: 'Hedge / shrub',    re: /hedge|shrub|bush|prun|topiary/i },
  { key: 'garden-beds',    label: 'Garden beds',      re: /garden|flower[\s-]*bed|\bbed[\s-]*(prep|maint|install)|planting/i },
  { key: 'gutter',         label: 'Gutter cleaning',  re: /gutter|eaves?[\s-]*trough/i },
  { key: 'pressure-wash',  label: 'Pressure washing', re: /pressure[\s-]*wash|power[\s-]*wash/i },
  { key: 'mowing',         label: 'Mowing',           re: /mow|grass[\s-]*cut|lawn[\s-]*cut|\bcut\b|trim|whipper|string|edg/i },
]
const SERVICE_LABELS: Record<string, string> = Object.fromEntries(SERVICE_DEFS.map(d => [d.key, d.label]))
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
}
// THE service key for all learning (labor + pricing). Same input → same bucket.
export function serviceKey(serviceType: string | null | undefined): string {
  const s = (serviceType || '').trim()
  if (!s) return 'other'
  for (const d of SERVICE_DEFS) if (d.re.test(s)) return d.key
  return slugify(s) || 'other'
}
export function serviceLabel(key: string): string {
  return SERVICE_LABELS[key] || key.split('-').map(t => t ? t[0].toUpperCase() + t.slice(1) : t).join(' ') || 'Service'
}
