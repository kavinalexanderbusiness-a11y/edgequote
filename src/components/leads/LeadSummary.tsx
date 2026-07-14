import type { ReactNode } from 'react'
import { WebsiteLead } from '@/lib/leads'
import { formatCurrency } from '@/lib/utils'
import { JobPhotos } from '@/components/photos/JobPhotos'
import { Globe, Ruler, Sparkles, MapPin, Phone, Mail, Repeat, DollarSign, CalendarClock, MessageCircle, Camera } from 'lucide-react'

const FREQ_LABEL: Record<string, string> = { weekly: 'Weekly', biweekly: 'Bi-weekly', monthly: 'Monthly', one_time: 'One-time' }

// ── Shared website-lead summary ──────────────────────────────────────────────
// The ONE presentational card for a website lead, so it looks identical wherever
// it appears (Messages inbox, customer profile). Renders the six fields every lead
// should show — Requested service(s) · Property address · Budget · Preferred
// schedule · Preferred contact · Source — plus the measurement/estimate context.
// Purely presentational: the host fetches the lead and supplies any actions via
// `footer` (e.g. the Build Quote button in Messages).
export function LeadSummary({ lead, footer, className }: { lead: WebsiteLead; footer?: ReactNode; className?: string }) {
  const est = Number(lead.website_estimated_price) || 0
  const freq = (lead.frequency || '').toLowerCase()
  const services = lead.requested_services
  const submitted = lead.submitted_at || lead.created_at
  const fullAddress = [lead.address, lead.city].filter(Boolean).join(', ')
  const rawSub = lead.raw_submission
  const rawSource = rawSub && typeof rawSub.source === 'string' ? rawSub.source.trim() : ''
  const source = rawSource || 'Website'
  const recurring = !!freq && !!FREQ_LABEL[freq] && freq !== 'one_time'

  return (
    <div className={`rounded-card border border-accent/30 bg-accent/[0.06] p-3.5 ${className || ''}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-accent flex items-center gap-1.5">
          <Globe className="w-3.5 h-3.5" /> {source} quote request
        </p>
        {submitted && <span className="text-[10px] text-ink-faint">{new Date(submitted).toLocaleDateString()}</span>}
      </div>

      {/* Contact line */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
        {lead.phone && <span className="flex items-center gap-1 text-ink"><Phone className="w-3 h-3 text-ink-faint" /> {lead.phone}</span>}
        {lead.email && <span className="flex items-center gap-1 text-ink"><Mail className="w-3 h-3 text-ink-faint" /> {lead.email}</span>}
      </div>

      {/* The six lead fields */}
      <div className="mt-2.5 space-y-1.5">
        <Field icon={Sparkles} label="Service">{services || <Muted>Not specified</Muted>}</Field>
        <Field icon={MapPin} label="Address">{fullAddress || <Muted>Not provided</Muted>}</Field>
        {lead.budget && <Field icon={DollarSign} label="Budget">{lead.budget}</Field>}
        {lead.preferred_schedule && <Field icon={CalendarClock} label="Schedule">{lead.preferred_schedule}</Field>}
        {lead.preferred_contact && <Field icon={MessageCircle} label="Contact">Prefers {lead.preferred_contact}</Field>}
        <Field icon={Globe} label="Source">{source}</Field>
      </div>

      {/* Measurement / condition chips */}
      {(lead.lawn_sqft || (freq && FREQ_LABEL[freq]) || lead.yard_condition || lead.travel_distance_km != null) && (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {lead.lawn_sqft ? <Chip icon={Ruler}>{Number(lead.lawn_sqft).toLocaleString()} ft² lawn</Chip> : null}
          {freq && FREQ_LABEL[freq] ? <Chip icon={Repeat}>{FREQ_LABEL[freq]}</Chip> : null}
          {lead.yard_condition ? <Chip>{lead.yard_condition}</Chip> : null}
          {lead.travel_distance_km != null ? <Chip>{Number(lead.travel_distance_km).toFixed(1)} km</Chip> : null}
        </div>
      )}

      {/* Website estimate */}
      {est > 0 && (
        <div className="flex items-baseline gap-2 mt-2.5">
          <span className="text-[11px] uppercase tracking-wide text-ink-faint">Website estimate</span>
          <span className="text-base font-bold text-ink">{formatCurrency(est)}{recurring ? <span className="text-xs font-medium text-ink-muted"> / visit</span> : null}</span>
        </div>
      )}

      {lead.notes && <p className="text-xs text-ink-muted mt-2 whitespace-pre-wrap border-l-2 border-border pl-2">{lead.notes}</p>}

      {/* Photos the customer uploaded with the lead — reuses the SAME gallery +
          lightbox as the rest of the app (read-only: view + enlarge + download). */}
      {(lead.photo_count ?? 0) > 0 && lead.customer_id && (
        <div className="mt-3 pt-3 border-t border-border/60">
          <p className="text-[11px] uppercase tracking-wide text-ink-faint flex items-center gap-1.5 mb-1.5">
            <Camera className="w-3 h-3" /> Customer photos
          </p>
          <JobPhotos customerId={lead.customer_id} propertyId={null} variant="gallery" readOnly />
        </div>
      )}

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
