'use client'

import { useEffect, useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { MsgType, renderMessage, toDisplayBody, fromDisplayBody } from '@/lib/comms/templates'
import { summarizeSendOutcome as summarize, type SendOutcome as Outcome } from '@/lib/comms/sendOutcome'
import { SmsCost } from '@/components/comms/SmsCost'
import { localTodayISO, cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import {
  Navigation, Clock, MapPin, CheckCircle2, CalendarCheck, CalendarClock, CloudRain, Sparkles, Star,
  MessageSquare, Mail, Send, Check, AlertTriangle, X,
} from 'lucide-react'

// One-tap field messaging for a single visit, with an EDITABLE preview before
// sending. Every action auto-fills the customer's name, the visit date and the
// arrival window, renders the owner's own template, and lets them tweak the
// wording before one-tap send. Routes through /api/comms/send — opt-in-gated,
// disabled-safe, and logged into the customer timeline + message center.
interface Props {
  jobId: string
  customerId: string | null
  customerName: string
  visitDate?: string   // yyyy-MM-dd — the job's scheduled date
  timeWindow?: string  // e.g. "8:15–10:15 AM"
  address?: string
}

// The scheduler quick actions, in field order. needsEta = uses the minutes input;
// reschedule = exposes the date pickers (new date, and old date for weather delay).
const ACTIONS: { type: MsgType; label: string; icon: typeof Navigation; tone?: string; needsEta?: boolean; reschedule?: 'date' | 'weather' }[] = [
  { type: 'eta', label: 'Send ETA', icon: Clock },
  { type: 'on_my_way', label: 'On my way', icon: Navigation, needsEta: true, tone: 'text-sky-300 border-sky-400/30 bg-sky-400/10 hover:bg-sky-400/20' },
  { type: 'running_late', label: 'Running late', icon: Clock, needsEta: true, tone: 'text-amber-300 border-amber-400/30 bg-amber-400/10 hover:bg-amber-400/20' },
  { type: 'arrived', label: 'Arrived', icon: MapPin },
  { type: 'early_arrival', label: 'Finished early', icon: Sparkles },
  { type: 'confirm', label: 'Confirm visit', icon: CalendarCheck },
  { type: 'job_complete', label: 'Completed', icon: CheckCircle2, tone: 'text-emerald-300 border-emerald-400/30 bg-emerald-400/10 hover:bg-emerald-400/20' },
  { type: 'review_request', label: 'Review request', icon: Star, tone: 'text-violet-300 border-violet-400/30 bg-violet-400/10 hover:bg-violet-400/20' },
  { type: 'rescheduled', label: 'Rescheduled', icon: CalendarClock, reschedule: 'date' },
  { type: 'rain_delay', label: 'Weather delay', icon: CloudRain, reschedule: 'weather', tone: 'text-sky-300 border-sky-400/30 bg-sky-400/10 hover:bg-sky-400/20' },
]

export function JobMessages({ jobId, customerId, customerName, visitDate, timeWindow, address }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [custom, setCustom] = useState<Partial<Record<MsgType, string>> | null>(null)
  const [company, setCompany] = useState('Edge Property Services')
  const [reviewUrl, setReviewUrl] = useState('')
  const [reviewed, setReviewed] = useState(false)  // customer already left a review → hide review request

  const [active, setActive] = useState<MsgType | null>(null)
  const [eta, setEta] = useState('15')
  const [newDate, setNewDate] = useState(visitDate || localTodayISO())
  const [oldDate, setOldDate] = useState(visitDate || localTodayISO())
  const [text, setText] = useState('')
  const [ch, setCh] = useState<{ sms: boolean; email: boolean }>({ sms: true, email: true })
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  // Load the owner's templates + business name once, so the preview is exactly
  // what gets sent (same engine, same overrides) and renders instantly.
  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) return
      const [bizRes, custRes] = await Promise.all([
        supabase.from('business_settings').select('company_name, review_url, message_templates').eq('user_id', uid).maybeSingle(),
        customerId ? supabase.from('customers').select('reviewed_at').eq('id', customerId).maybeSingle() : Promise.resolve({ data: null }),
      ])
      const d = bizRes.data as { company_name: string | null; review_url: string | null; message_templates: Partial<Record<MsgType, string>> | null } | null
      if (d?.company_name) setCompany(d.company_name)
      setReviewUrl(d?.review_url || '')
      setCustom(d?.message_templates || {})
      setReviewed(!!(custRes.data as { reviewed_at: string | null } | null)?.reviewed_at)
    })()
  }, [supabase, customerId])

  const fmtDate = (iso: string) => { try { return format(parseISO(iso + 'T00:00:00'), 'EEE, MMM d') } catch { return iso } }

  // Render the message for a type from the current inputs — the one engine,
  // owner overrides included. This is the editable starting text.
  function compose(type: MsgType, opts?: { eta?: string; newDate?: string; oldDate?: string }): string {
    const e = opts?.eta ?? eta
    const nd = opts?.newDate ?? newDate
    const od = opts?.oldDate ?? oldDate
    const dateLabel = (type === 'rescheduled' || type === 'rain_delay') ? fmtDate(nd) : (visitDate ? fmtDate(visitDate) : undefined)
    // Only the server knows the customer's portal token — the composer shows a
    // friendly [Customer Portal Link] placeholder; send() converts it back to the
    // {{portal_link}} token so the route injects the real URL.
    return toDisplayBody(renderMessage(type, custom, {
      firstName: customerName,
      businessName: company,
      eta: e,
      reviewLink: reviewUrl || undefined,
      portalLink: '{{portal_link}}',
      dateLabel,
      timeWindow: timeWindow,
      oldDateLabel: fmtDate(od),
      address,
    }).sms)
  }

  function open(type: MsgType) {
    if (active === type) { setActive(null); return }
    setOutcome(null)
    setActive(type)
    setText(compose(type))
  }

  // Re-generate the editable text when an input changes (owner edits are replaced
  // only when they deliberately change a variable — name/date/eta drive the copy).
  function setEtaAndRecompose(v: string) { setEta(v); if (active) setText(compose(active, { eta: v })) }
  function setNewDateAndRecompose(v: string) { setNewDate(v); if (active) setText(compose(active, { newDate: v })) }
  function setOldDateAndRecompose(v: string) { setOldDate(v); if (active) setText(compose(active, { oldDate: v })) }

  async function send() {
    if (!active) return
    if (!customerId) { setOutcome({ ok: false, text: 'No customer linked to this job.' }); return }
    const channels = (['sms', 'email'] as const).filter(c => ch[c])
    if (!channels.length) { setOutcome({ ok: false, text: 'Pick at least one channel.' }); return }
    setBusy(true); setOutcome(null)
    try {
      const dateLabel = (active === 'rescheduled' || active === 'rain_delay') ? fmtDate(newDate) : (visitDate ? fmtDate(visitDate) : undefined)
      const res = await fetch('/api/comms/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId, template: active, jobId, channels, bodyOverride: fromDisplayBody(text),
          vars: { eta, dateLabel, timeWindow, oldDateLabel: fmtDate(oldDate), address },
        }),
      })
      setOutcome(summarize(await res.json()))
    } catch (e) {
      setOutcome({ ok: false, text: e instanceof Error ? e.message : 'Could not send the message.' })
    }
    setBusy(false)
  }

  const activeAction = ACTIONS.find(a => a.type === active)

  return (
    <div className="space-y-2.5">
      {/* Action buttons — hide Review request once the customer has reviewed */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {ACTIONS.filter(a => a.type !== 'review_request' || !reviewed).map(a => (
          <button key={a.type} type="button" onClick={() => open(a.type)} disabled={busy}
            className={cn('h-9 rounded-lg border text-xs font-medium flex items-center justify-center gap-1.5 active:scale-95 transition-transform disabled:opacity-50',
              active === a.type ? 'border-accent bg-accent/15 text-accent-text ring-1 ring-accent/40'
                : a.tone || 'border-border text-ink-muted hover:text-ink hover:bg-black/10')}>
            <a.icon className="w-3.5 h-3.5" /> {a.label}
          </button>
        ))}
      </div>

      {/* Editable composer for the chosen action */}
      {activeAction && (
        <div className="rounded-lg border border-border bg-bg-secondary p-2.5 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold text-ink flex items-center gap-1.5"><activeAction.icon className="w-3.5 h-3.5 text-accent-text" /> {activeAction.label}</p>
            <button type="button" onClick={() => setActive(null)} className="text-ink-faint hover:text-ink" aria-label="Close"><X className="w-3.5 h-3.5" /></button>
          </div>
          <p className="text-[10px] text-ink-faint">
            To {customerName.split(' ')[0]}{visitDate ? ` · ${fmtDate(visitDate)}` : ''}{timeWindow ? ` · ${timeWindow}` : ''}
          </p>

          {/* Variable inputs that drive the copy */}
          {activeAction.needsEta && (
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-ink-faint">
              ETA (min)
              <input type="number" min="1" step="5" value={eta} onChange={e => setEtaAndRecompose(e.target.value)}
                className="w-16 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
            </label>
          )}
          {activeAction.reschedule && (
            <div className="flex flex-wrap items-center gap-3">
              {activeAction.reschedule === 'weather' && (
                <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink-faint">From
                  <input type="date" value={oldDate} onChange={e => setOldDateAndRecompose(e.target.value)}
                    className="bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
                </label>
              )}
              <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink-faint">To
                <input type="date" value={newDate} onChange={e => setNewDateAndRecompose(e.target.value)}
                  className="bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
              </label>
            </div>
          )}

          {/* Editable message */}
          <textarea value={text} onChange={e => { setText(e.target.value); setOutcome(null) }} rows={4}
            aria-label="Message text"
            className="w-full bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20 resize-none" />
          {ch.sms ? <SmsCost text={text} className="mt-0.5" /> : <p className="text-[10px] text-ink-faint">{text.length} characters · edit freely before sending</p>}
          {active === 'review_request' && !reviewUrl && (
            <p className="text-[10px] text-amber-400">Add your Google review link in Settings → Message templates so it&apos;s inserted automatically.</p>
          )}

          {/* Channels + send */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <ChannelChip label="SMS" icon={MessageSquare} on={ch.sms} onClick={() => setCh(c => ({ ...c, sms: !c.sms }))} />
            <ChannelChip label="Email" icon={Mail} on={ch.email} onClick={() => setCh(c => ({ ...c, email: !c.email }))} />
            <span className="text-[11px] text-ink-faint" title="Push notifications — coming soon">Push — coming soon</span>
            {/* After a successful send the action becomes Done (collapses the
                panel) — no accidental double-send, clear next step. */}
            {outcome?.ok ? (
              <button type="button" onClick={() => setActive(null)}
                className="ml-auto h-8 px-3 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition-transform">
                <Check className="w-3.5 h-3.5" /> Done
              </button>
            ) : (
              <Button size="sm" className="ml-auto" loading={busy} disabled={busy} onClick={send}>
                <Send className="w-3.5 h-3.5" /> Send
              </Button>
            )}
          </div>

          {outcome && (
            <div className={cn('flex items-start gap-1.5 text-[11px] rounded-lg px-2.5 py-1.5 border',
              outcome.ok ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-amber-400 border-amber-500/30 bg-amber-500/10')}>
              {outcome.ok ? <Check className="w-3.5 h-3.5 shrink-0 mt-px" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />}
              <span>{outcome.text}{outcome.ok ? ' Logged in the customer’s conversation.' : ''}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ChannelChip({ label, icon: Icon, on, onClick }: { label: string; icon: typeof Mail; on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('h-7 px-2 rounded-lg border text-[11px] font-medium flex items-center gap-1 transition-colors',
        on ? 'border-accent/40 bg-accent/10 text-accent-text' : 'border-border text-ink-faint hover:text-ink')}>
      <Icon className="w-3 h-3" /> {label} {on && <Check className="w-3 h-3" />}
    </button>
  )
}

