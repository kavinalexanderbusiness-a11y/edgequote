'use client'

// ── Requests tab — the portal's honest "recommendations" surface ─────────────
// The owner's OWN catalogue (service_templates via get_portal_data) rendered as
// tappable cards, in the owner's order. The catalogue IS the recommendation:
// things this business actually sells — never an invented score, prediction or
// urgency (the customer-experience audit is explicit the data cannot support
// those). Price labels come from THE service pricing formatter
// (lib/servicePricing.formatServicePrice) so "/hr" and "Starting from" are never
// hardcoded a second time; a service with no rate makes NO price claim.
//
// Presentational only — every send goes through actions.request /
// actions.submitRequest (portal_request_service / portal_submit_request), which
// thread into the owner's ONE Messages hub. Nothing here mutates jobs or plans.

import { useState } from 'react'
import { CalendarPlus, Check, CheckCircle2, ChevronDown, Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn, formatDate, localTodayISO } from '@/lib/utils'
import { formatServicePrice, type PriceableService } from '@/lib/servicePricing'
import { MAX_REQUEST_PRESETS, type PortalData, type PortalService, type SubmitRequestFn } from '../model'
import type { TabProps } from './shared'

// The honest price label. No rate ⇒ no label — formatServicePrice would render
// "$0", which is a claim, so we stay silent instead. A rate with a null
// display type takes the formatter's OWN default branch ("Starting from $X") —
// we reuse its fallback rather than inventing a format here.
function priceLabelOf(s: PortalService): string | null {
  const rate = Number(s.default_rate)
  if (!(rate > 0)) return null
  return formatServicePrice({
    pricing_display_type: (s.pricing_display_type ?? 'starting_from') as PriceableService['pricing_display_type'],
    default_rate: rate,
  })
}

export function RequestsTab({ view, actions }: TabProps) {
  const services = view.data.services ?? []
  const biz = view.data.business
  const company = biz?.company_name?.trim() || null

  // Per-card send state. One request in flight at a time (matching the original
  // tab's single reqBusy), but every sent card keeps its confirmation.
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [sentKeys, setSentKeys] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState(false)

  // Free-text "Something else?" ask — always available, always works.
  const [reqMsg, setReqMsg] = useState('')
  const [customSent, setCustomSent] = useState(false)

  const shown = expanded ? services : services.slice(0, MAX_REQUEST_PRESETS)
  const hiddenCount = services.length - MAX_REQUEST_PRESETS

  async function requestService(name: string) {
    const key = `preset:${name}`
    if (busyKey !== null || sentKeys.has(key)) return
    setBusyKey(key)
    // Same message format as the original preset flow — this string is what the
    // owner reads in their Messages hub.
    const ok = await actions.request(`Service request: ${name} quote`, key)
    setBusyKey(null)
    if (ok) setSentKeys(prev => new Set(prev).add(key))
  }

  return (
    <div className="space-y-3">
      {/* Only render the catalogue when this business actually has one. An empty
          grid under "Services we offer" would read as broken; the appointment
          card and the free-text ask below are always available and do the same
          job — the original tab's degradation, preserved. */}
      {services.length > 0 && (
        <div className="animate-rise stagger-1 rounded-card border border-border bg-bg-secondary p-4">
          <p className="text-sm font-semibold text-ink flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-accent-text" /> Services {company || 'we'} offer{company ? 's' : ''}
          </p>
          <p className="text-xs text-ink-muted mt-0.5 mb-3">Things we can help with — tap one to request a quote.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {shown.map((s, i) => {
              const key = `preset:${s.name}`
              const sent = sentKeys.has(key)
              const busy = busyKey === key
              const price = priceLabelOf(s)
              return (
                <button
                  key={`${s.name}-${i}`}
                  type="button"
                  onClick={() => requestService(s.name)}
                  disabled={busyKey !== null || sent}
                  className={cn(
                    'rounded-xl border p-3 text-left transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                    sent ? 'border-emerald-500/30 bg-emerald-500/[0.06]' : 'border-border bg-bg-tertiary hover:border-accent/40',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold text-ink">{s.name}</p>
                    {busy ? (
                      <Loader2 className="w-4 h-4 animate-spin text-ink-muted shrink-0 mt-0.5" />
                    ) : sent ? (
                      <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    ) : null}
                  </div>
                  {s.default_description && (
                    <p className="text-xs text-ink-muted mt-0.5 line-clamp-2">{s.default_description}</p>
                  )}
                  {sent ? (
                    <p className="text-xs text-emerald-400 mt-1.5">
                      Request sent — {company || 'we'} will get back to you.
                    </p>
                  ) : price ? (
                    <p className="text-[11px] font-medium text-accent-text mt-1.5">{price}</p>
                  ) : null}
                </button>
              )
            })}
          </div>
          {!expanded && hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-2 w-full h-9 rounded-xl border border-border bg-bg-tertiary text-xs font-medium text-ink-muted hover:border-accent/40 transition-colors flex items-center justify-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <ChevronDown className="w-3.5 h-3.5" /> +{hiddenCount} more
            </button>
          )}
        </div>
      )}

      <div className="animate-rise stagger-2">
        <AppointmentCard presets={view.requestPresets} biz={biz} submitRequest={actions.submitRequest} />
      </div>

      <div className="animate-rise stagger-3 rounded-card border border-border bg-bg-secondary p-4">
        <p className="text-sm font-semibold text-ink mb-1">{services.length > 0 ? 'Something else?' : 'Request a service'}</p>
        {customSent ? (
          <p className="text-sm text-emerald-400 flex items-center gap-1.5 py-2"><CheckCircle2 className="w-4 h-4" /> Request sent — we’ll be in touch soon.</p>
        ) : (
          <form
            onSubmit={async e => {
              e.preventDefault()
              if (!reqMsg.trim() || busyKey !== null) return
              setBusyKey('custom')
              const ok = await actions.request(reqMsg, 'custom')
              setBusyKey(null)
              if (ok) setCustomSent(true)
            }}
          >
            <textarea
              value={reqMsg}
              onChange={e => setReqMsg(e.target.value)}
              rows={3}
              aria-label="Your request"
              placeholder="e.g. Can you add a fall cleanup this month?"
              className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <div className="mt-2"><Button size="sm" type="submit" loading={busyKey === 'custom'} disabled={!reqMsg.trim()}>Send request</Button></div>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Appointment request (a visit on a date, not just "a service sometime") ────
// The service cards above ask for a QUOTE; this asks for a VISIT — with the date
// preference that makes it schedulable. Free text alone forced customers to
// narrate a date ("sometime the week of the 20th, mornings") that the owner then
// re-typed into the calendar; preferred_date arrives structured now.
function AppointmentCard({ presets, biz, submitRequest }: { presets: string[]; biz: PortalData['business']; submitRequest: SubmitRequestFn }) {
  const [svc, setSvc] = useState('')
  const [date, setDate] = useState('')
  const [win, setWin] = useState<'anytime' | 'morning' | 'afternoon'>('anytime')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const inputCls = 'w-full h-10 px-3 rounded-xl bg-bg-tertiary border border-border-strong text-base sm:text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20'
  if (sent) return (
    <div className="rounded-card border border-emerald-500/30 bg-emerald-500/[0.06] p-4">
      <p className="text-sm font-semibold text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> Appointment request sent</p>
      {/* "We'll be in touch" leaves people watching their phone — say where the
          answer lands. The booked visit appears on the Home tab like every other. */}
      <p className="text-xs text-ink-muted mt-1">{biz?.company_name || 'We'}&rsquo;ll confirm a time with you. Once it&rsquo;s booked, the visit shows up right here in your portal.</p>
      <Button size="sm" variant="secondary" className="mt-3" onClick={() => { setSent(false); setDate(''); setNote('') }}>Request another time</Button>
    </div>
  )
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4">
      <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><CalendarPlus className="w-4 h-4 text-accent-text" /> Request an appointment</p>
      <p className="text-xs text-ink-muted mt-0.5 mb-3">Pick a day that suits you — {biz?.company_name || 'we'}&rsquo;ll confirm the time.</p>
      <form className="space-y-2"
        onSubmit={async e => {
          e.preventDefault()
          if (!date || busy) return
          setBusy(true)
          const ok = await submitRequest({
            kind: 'appointment', preferredDate: date,
            details: { window: win, service: svc || null },
            message: `Appointment request: ${svc || 'a visit'} — preferred ${formatDate(date)}${win !== 'anytime' ? `, ${win}` : ''}.${note.trim() ? ` ${note.trim()}` : ''}`,
          })
          setBusy(false)
          if (ok) setSent(true)
        }}>
        {presets.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-ink mb-1" htmlFor="appt-svc">Service</label>
            <select id="appt-svc" value={svc} onChange={e => setSvc(e.target.value)} className={inputCls}>
              <option value="">Not sure yet</option>
              {presets.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs font-medium text-ink mb-1" htmlFor="appt-date">Preferred date</label>
            <input id="appt-date" type="date" required value={date} min={localTodayISO()} onChange={e => setDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink mb-1" htmlFor="appt-win">Time of day</label>
            <select id="appt-win" value={win} onChange={e => setWin(e.target.value as 'anytime' | 'morning' | 'afternoon')} className={inputCls}>
              <option value="anytime">Anytime</option>
              <option value="morning">Morning</option>
              <option value="afternoon">Afternoon</option>
            </select>
          </div>
        </div>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} aria-label="Anything we should know?" placeholder="Anything we should know? (optional)"
          className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
        <Button size="sm" type="submit" loading={busy} disabled={!date}><CalendarPlus className="w-4 h-4" /> Request this day</Button>
        <p className="text-[11px] text-ink-faint">This sends a request — nothing is booked until we confirm with you.</p>
      </form>
    </div>
  )
}
