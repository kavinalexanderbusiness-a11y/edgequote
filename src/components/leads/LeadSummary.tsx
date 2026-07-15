import type { ReactNode } from 'react'
import { WebsiteLead } from '@/lib/leads'
import { formatCurrency } from '@/lib/utils'
import { Globe, Ruler, Sparkles, MapPin, Phone, Mail, Repeat, DollarSign, CalendarClock, MessageCircle } from 'lucide-react'

const FREQ_LABEL: Record<string, string> = { weekly: 'Weekly', biweekly: 'Bi-weekly', monthly: 'Monthly', one_time: 'One-time' }

// Internal intake sources (Formspree, a generic webhook) shouldn't leak into the
// owner UI — they all read as "Website" to the owner.
function displaySource(raw: string): string {
  const s = raw.trim()
  return !s || /formspree|webhook|api|zapier/i.test(s) ? 'Website' : s
}

// Compact, human freshness — "just now / 5m ago / 2h ago / 3d ago", then a date.
function timeAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24); if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// A raw yard-condition value can be a cryptic overgrowth multiplier ("1.2") — only
// show it when it's a real descriptive word.
function yardConditionLabel(v: string | null): string | null {
  const c = (v || '').trim()
  if (!c || /^[0-9.]+$/.test(c)) return null
  return c
}

// ── Shared website-lead summary ──────────────────────────────────────────────
// The ONE presentational card for a website lead, so it looks identical wherever
// it appears (Messages inbox, customer profile). Leads with the value (website
// estimate) as the hero, a NEW/freshness cue, then the request detail. Purely
// presentational: the host fetches the lead and supplies any actions via `footer`
// (e.g. the Build Quote button in Messages).
export function LeadSummary({ lead, footer, className }: { lead: WebsiteLead; footer?: ReactNode; className?: string }) {
  const est = Number(lead.website_estimated_price) || 0
  const freq = (lead.frequency || '').toLowerCase()
  const services = lead.requested_services
  const submitted = lead.submitted_at || lead.created_at
  const fullAddress = [lead.address, lead.city].filter(Boolean).join(', ')
  const rawSub = lead.raw_submission
  const source = displaySource(rawSub && typeof rawSub.source === 'string' ? rawSub.source : '')
  const recurring = !!freq && !!FREQ_LABEL[freq] && freq !== 'one_time'
  const isFresh = submitted ? (Date.now() - new Date(submitted).getTime()) < 48 * 3600 * 1000 : false
  const yardCond = yardConditionLabel(lead.yard_condition)

  return (
    <div className={`rounded-card border border-accent/30 bg-accent/[0.06] p-3.5 ${className || ''}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-accent flex items-center gap-1.5">
          <Globe className="w-3.5 h-3.5" /> {source} lead
          {isFresh && <span className="text-[9px] font-bold text-black bg-accent rounded-full px-1.5 py-px leading-none tracking-wider">NEW</span>}
        </p>
        {submitted && <span className="text-[10px] text-ink-faint">{timeAgo(submitted)}</span>}
      </div>

      {/* Contact line */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
        {lead.phone && <span className="flex items-center gap-1 text-ink"><Phone className="w-3 h-3 text-ink-faint" /> {lead.phone}</span>}
        {lead.email && <span className="flex items-center gap-1 text-ink"><Mail className="w-3 h-3 text-ink-faint" /> {lead.email}</span>}
      </div>

      {/* Website estimate — the hero number for triaging a lead's value */}
      {est > 0 && (
        <div className="mt-2.5 flex items-baseline gap-2">
          <span className="text-2xl font-bold text-ink tabular-nums">{formatCurrency(est)}</span>
          <span className="text-[11px] text-ink-muted">{recurring ? 'per visit · their website estimate' : 'their website estimate'}</span>
        </div>
      )}

      {/* The request detail */}
      <div className="mt-2.5 space-y-1.5">
        <Field icon={Sparkles} label="Service">{services || <Muted>Not specified</Muted>}</Field>
        <Field icon={MapPin} label="Address">{fullAddress || <Muted>Not provided</Muted>}</Field>
        {lead.budget && <Field icon={DollarSign} label="Budget">{lead.budget}</Field>}
        {lead.preferred_schedule && <Field icon={CalendarClock} label="Prefers">{lead.preferred_schedule}</Field>}
        {lead.preferred_contact && <Field icon={MessageCircle} label="Contact">{lead.preferred_contact}</Field>}
      </div>

      {/* Measurement / condition chips */}
      {(lead.lawn_sqft || (freq && FREQ_LABEL[freq]) || yardCond || lead.travel_distance_km != null) && (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {lead.lawn_sqft ? <Chip icon={Ruler}>{Number(lead.lawn_sqft).toLocaleString()} ft² lawn</Chip> : null}
          {freq && FREQ_LABEL[freq] ? <Chip icon={Repeat}>{FREQ_LABEL[freq]}</Chip> : null}
          {yardCond ? <Chip>{yardCond}</Chip> : null}
          {lead.travel_distance_km != null ? <Chip>{Number(lead.travel_distance_km).toFixed(1)} km away</Chip> : null}
        </div>
      )}

      {lead.notes && <p className="text-xs text-ink-muted mt-2.5 whitespace-pre-wrap border-l-2 border-accent/30 pl-2">{lead.notes}</p>}

      {footer && <div className="mt-3">{footer}</div>}
    </div>
  )
}

function Field({ icon: Icon, label, children }: { icon: typeof Ruler; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <Icon className="w-3.5 h-3.5 text-ink-faint shrink-0 mt-0.5" />
      <span className="text-ink-faint w-16 shrink-0">{label}</span>
      <span className="text-ink min-w-0">{children}</span>
    </div>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-ink-faint italic">{children}</span>
}

function Chip({ icon: Icon, children }: { icon?: typeof Ruler; children: ReactNode }) {
  return (
    <span className="text-[11px] text-ink-muted bg-surface border border-border rounded px-1.5 py-0.5 flex items-center gap-1">
      {Icon && <Icon className="w-3 h-3 text-ink-faint" />} {children}
    </span>
  )
}
