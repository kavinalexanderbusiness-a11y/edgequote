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

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CalendarPlus, Camera, Check, CheckCircle2, ChevronDown, Loader2, MessageSquarePlus, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn, formatDate, localTodayISO } from '@/lib/utils'
import { formatServicePrice, type PriceableService } from '@/lib/servicePricing'
import { MAX_REQUEST_PHOTOS, requestPhotoExt, type RequestKind } from '@/lib/portalRequests'
import { draftStorageKey, isSendChord, MAX_REQUEST_PRESETS, type PortalData, type PortalService, type SubmitRequestFn } from '../model'
import { autoGrow, type TabProps } from './shared'

// One field style, shared by the composer and the appointment card below.
const FIELD = 'w-full h-10 px-3 rounded-xl bg-bg-tertiary border border-border-strong text-base sm:text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20'

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

      <div className="animate-rise stagger-3">
        <RequestComposer view={view} actions={actions} hasCatalogue={services.length > 0} />
      </div>
    </div>
  )
}

// ── The request composer — one short form for "please do something" ──────────
// This REPLACED a bare "Something else?" textarea. The textarea worked, but it
// made the customer narrate structure the owner then re-typed ("could you also
// do the back beds, and here's a photo — actually I can't send a photo"), and it
// gave the owner no way to tell a quote ask from a schedule change without
// reading every word.
//
// Three types, a note, and up to six photos. It stays ONE card and one screen on
// a phone: a chip row, a textarea, a photo strip, a button.
//
// ⭐ EVERY LINE OF COPY HERE DEFENDS ONE FACT: THIS IS AN ASK, NOT A BOOKING.
// The button says "Send request", the helper under it says nothing is booked or
// charged, and the confirmation says it again with the business's name on it.
// The whole feature is worthless — worse than worthless — if a customer walks
// away believing their visit moved.
type ComposerKind = Extract<RequestKind, 'additional_work' | 'reschedule' | 'service'>
const COMPOSER_TYPES: { key: ComposerKind; label: string; placeholder: string }[] = [
  { key: 'additional_work', label: 'Extra work', placeholder: 'e.g. Could you also do the back beds while you’re here?' },
  { key: 'reschedule', label: 'Change a visit', placeholder: 'e.g. We’ll be away that week — could we push it back?' },
  { key: 'service', label: 'A new quote', placeholder: 'e.g. What would it cost to redo the front walkway?' },
]

function RequestComposer({ view, actions, hasCatalogue }: TabProps & { hasCatalogue: boolean }) {
  const biz = view.data.business
  const who = biz?.company_name?.trim() || 'We'
  const upcoming = view.derived.upcoming
  const [kind, setKind] = useState<ComposerKind>('additional_work')
  const [note, setNote] = useState('')
  const [jobId, setJobId] = useState('')
  const [date, setDate] = useState('')
  const [files, setFiles] = useState<{ id: string; file: File; preview: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [photoNote, setPhotoNote] = useState<string | null>(null)
  const noteRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // Keep a half-typed request when the customer taps to another tab (this tab
  // unmounts on switch, which used to discard it) — restored on return, cleared
  // once the request is sent. Same per-token sessionStorage as the message
  // composer; the two never share a key. Only the TEXT is kept: a File can't be
  // serialised, and a restored draft that silently lost its photos would be the
  // form lying about what it is about to send.
  const draftKey = draftStorageKey(actions.token, 'request')
  useEffect(() => {
    try { const saved = sessionStorage.getItem(draftKey); if (saved) setNote(saved) } catch { /* storage blocked */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    try { if (note) sessionStorage.setItem(draftKey, note); else sessionStorage.removeItem(draftKey) } catch { /* storage blocked */ }
  }, [note, draftKey])
  useEffect(() => { autoGrow(noteRef.current) }, [note])
  // Object URLs are a leak if nobody revokes them; a customer who picks and
  // removes photos a few times on a phone is exactly who can least afford it.
  useEffect(() => () => { files.forEach(f => URL.revokeObjectURL(f.preview)) }, [files])

  const type = COMPOSER_TYPES.find(t => t.key === kind) ?? COMPOSER_TYPES[0]
  const chosenJob = upcoming.find(j => j.id === jobId) || null
  const canSend = note.trim().length > 0 && !busy

  function addFiles(picked: FileList | null) {
    if (!picked?.length) return
    const room = Math.max(0, MAX_REQUEST_PHOTOS - files.length)
    const accepted: { id: string; file: File; preview: string }[] = []
    let refused = 0
    for (const f of Array.from(picked)) {
      // Refuse here, with a reason, rather than uploading something the request
      // door will reject — the customer finds out now, not after tapping send.
      if (!requestPhotoExt(f.name, f.type)) { refused++; continue }
      if (f.size > 12 * 1024 * 1024) { refused++; continue }
      if (accepted.length >= room) break
      accepted.push({ id: crypto.randomUUID(), file: f, preview: URL.createObjectURL(f) })
    }
    setFiles(prev => [...prev, ...accepted])
    setPhotoNote(
      refused > 0 ? `${refused} file${refused !== 1 ? 's' : ''} couldn’t be attached — photos only, up to 12 MB each.`
      : picked.length > room ? `You can attach up to ${MAX_REQUEST_PHOTOS} photos.`
      : null,
    )
  }
  function removeFile(id: string) {
    setFiles(prev => { const gone = prev.find(f => f.id === id); if (gone) URL.revokeObjectURL(gone.preview); return prev.filter(f => f.id !== id) })
    setPhotoNote(null)
  }

  async function send(e: FormEvent) {
    e.preventDefault()
    if (!canSend) return
    setBusy(true)
    setPhotoNote(null)

    // Upload first. A photo that didn't land must never be counted in the
    // message, so the message is written AFTER we know what actually uploaded.
    let paths: string[] = []
    if (files.length) {
      const res = await actions.uploadRequestPhotos(files.map(f => f.file))
      paths = res.paths
      if (res.failed > 0 && res.paths.length === 0) {
        setPhotoNote('Your photos couldn’t be uploaded — send the request without them, or try again on a stronger connection.')
        setBusy(false)
        return // never send an "with photos" request carrying none
      }
      if (res.failed > 0) setPhotoNote(`${res.failed} photo${res.failed !== 1 ? 's' : ''} couldn’t be uploaded — the rest were sent.`)
    }

    // The message is what the owner reads in their thread, so it states the ask
    // in a sentence, then the customer's own words verbatim.
    const head =
      kind === 'reschedule' ? `Schedule change requested${chosenJob ? `: ${chosenJob.service_type || chosenJob.title} on ${formatDate(chosenJob.scheduled_date)}` : ''}${date ? ` — could we move it to ${formatDate(date)}?` : ''}`
      : kind === 'additional_work' ? 'Extra work requested'
      : 'Quote requested'
    const msg = [head, note.trim(), paths.length ? `(${paths.length} photo${paths.length !== 1 ? 's' : ''} attached)` : '']
      .filter(Boolean).join(' — ')

    const ok = await actions.submitRequest({
      kind,
      message: msg,
      // A date only travels with a schedule change; sending one on a quote ask
      // would put a date on the owner's screen that the customer never gave.
      preferredDate: kind === 'reschedule' && date ? date : null,
      jobId: kind === 'reschedule' && chosenJob ? chosenJob.id : null,
      photos: paths,
    })
    setBusy(false)
    if (ok) {
      setSent(true)
      setNote('') // clears the persisted draft too
      files.forEach(f => URL.revokeObjectURL(f.preview))
      setFiles([])
      setDate(''); setJobId('')
    }
  }

  if (sent) return (
    <div className="rounded-card border border-emerald-500/30 bg-emerald-500/[0.06] p-4">
      <p className="text-sm font-semibold text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> Request sent</p>
      {/* Say what did NOT happen. This is the sentence the whole feature rests on. */}
      <p className="text-xs text-ink-muted mt-1.5">
        {who} {who === 'We' ? 'have' : 'has'} it now — nothing is booked, changed or charged until {who === 'We' ? 'we get' : 'they get'} back to you.
        {' '}You’ll find the reply in your messages below, and anything {who === 'We' ? 'we' : 'they'} schedule shows up in your portal.
      </p>
      <Button size="sm" variant="secondary" className="mt-3" onClick={() => { setSent(false); setPhotoNote(null) }}>Ask for something else</Button>
    </div>
  )

  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4">
      <p className="text-sm font-semibold text-ink flex items-center gap-1.5">
        <MessageSquarePlus className="w-4 h-4 text-accent-text" /> {hasCatalogue ? 'Ask us for something' : 'Request a service'}
      </p>
      <p className="text-xs text-ink-muted mt-0.5 mb-3">Tell us what you need — add a photo if it helps.</p>

      <form onSubmit={send} className="space-y-2.5">
        {/* Three chips, one row on a 375px phone. A radiogroup rather than a
            select: on a phone a select is a modal wheel for three options. */}
        <div role="radiogroup" aria-label="What do you need?" className="flex gap-1.5">
          {COMPOSER_TYPES.map(t => (
            <button
              key={t.key} type="button" role="radio" aria-checked={kind === t.key}
              onClick={() => setKind(t.key)}
              className={cn('tap-target-y flex-1 rounded-xl border px-2 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                kind === t.key ? 'border-accent bg-accent/10 text-ink' : 'border-border bg-bg-tertiary text-ink-muted hover:text-ink')}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Only a schedule change asks about a visit and a date — the other two
            types never show fields they don't use. */}
        {kind === 'reschedule' && (
          upcoming.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-ink mb-1" htmlFor="req-visit">Which visit?</label>
                <select id="req-visit" value={jobId} onChange={e => setJobId(e.target.value)} className={FIELD}>
                  <option value="">Not sure / another one</option>
                  {upcoming.slice(0, 12).map(j => (
                    <option key={j.id} value={j.id}>{formatDate(j.scheduled_date)} · {j.service_type || j.title}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-ink mb-1" htmlFor="req-date">A day that suits you</label>
                <input id="req-date" type="date" value={date} min={localTodayISO()} onChange={e => setDate(e.target.value)} className={FIELD} />
              </div>
            </div>
          ) : (
            // No booked visits: don't render an empty picker that implies there
            // are some. The note still carries the ask.
            <p className="text-[11px] text-ink-faint">You have no visits booked right now — tell us what you’d like changed and we’ll sort it out.</p>
          )
        )}

        <textarea
          ref={noteRef} value={note} onChange={e => setNote(e.target.value)}
          onKeyDown={e => { if (isSendChord(e)) { const form = e.currentTarget.form; if (form?.requestSubmit) { e.preventDefault(); form.requestSubmit() } } }}
          rows={3} aria-label="What do you need?" placeholder={type.placeholder} maxLength={1200}
          className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none resize-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20"
        />

        {/* Photos. `capture` is deliberately absent: on a phone the picker then
            offers BOTH the camera and the camera roll, and most of these photos
            already exist in the roll. */}
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
            onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={files.length >= MAX_REQUEST_PHOTOS}
            className="tap-target-y inline-flex items-center gap-1.5 rounded-xl border border-border bg-bg-tertiary px-3 py-2 text-xs font-medium text-ink-muted hover:text-ink hover:border-border-strong transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
            <Camera className="w-3.5 h-3.5" /> {files.length ? 'Add another' : 'Add photos'}
          </button>
          {files.length > 0 && <span className="text-[11px] text-ink-faint">{files.length} of {MAX_REQUEST_PHOTOS}</span>}
        </div>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {files.map(f => (
              <div key={f.id} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={f.preview} alt="" className="w-16 h-16 rounded-lg object-cover border border-border" />
                <button type="button" onClick={() => removeFile(f.id)} aria-label="Remove photo"
                  className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-bg-secondary border border-border-strong flex items-center justify-center text-ink-muted hover:text-ink">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        {photoNote && <p className="text-[11px] text-amber-400">{photoNote}</p>}

        <div><Button size="sm" type="submit" loading={busy} disabled={!canSend}>Send request</Button></div>
        <p className="text-[11px] text-ink-faint">
          This sends a request — nothing is booked, changed or charged until {who === 'We' ? 'we confirm' : `${who} confirms`} with you.
        </p>
      </form>
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
  const inputCls = FIELD
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
