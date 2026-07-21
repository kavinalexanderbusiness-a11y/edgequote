'use client'

// ── Visits — ONE surface for the schedule AND the proof of work ─────────────
// Upcoming visits on top (every one of them — Home's hero only shows the
// first), then the full visit history with photos inlined per visit. The old
// separate Photos tab is gone: the before/after pairing now lives INSIDE each
// visit's card, so scrolling this tab is seeing the proof of every dollar
// spent. Purely presentational — every fact comes from view/model; money
// figures come from view.docItems (never recomputed here); URLs come from
// actions.photoUrl; navigation goes through actions.navigate.

import { useState } from 'react'
import { format } from 'date-fns'
import { Camera, CheckCircle2, Clock, History, MapPin, Receipt } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn, parseLocalDate } from '@/lib/utils'
import {
  daysAwayLabel, liveStatusOf, resolveDocAddress, visitDay,
  type PortalInvoice, type PortalJob, type PortalPhoto, type PortalView,
} from '../model'
import {
  Empty, InvoiceStatusPill, PortalSection, StatusPill, Thumb, fmtMoney,
  type PortalActions, type TabProps,
} from './shared'

export function VisitsTab({ view, actions }: TabProps) {
  const upcoming = view.derived.upcoming
  const completed = view.derived.completed
  // Every photo the completed-visit cards below won't already show — loose
  // photos AND photos on a visit that isn't completed yet (a "before" shot on
  // an in-progress job). The old Photos tab showed all of them; without this
  // section they'd vanish until the job flipped to completed.
  const loosePhotos = view.orphanPhotos

  if (upcoming.length === 0 && completed.length === 0 && loosePhotos.length === 0) {
    return (
      <div className="animate-rise">
        <Empty text="Your visit history will appear here after your first visit." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {upcoming.length > 0 && (
        <div className="animate-rise">
          <PortalSection title="Upcoming visits" sub={upcoming.length === 1 ? 'Your next scheduled visit' : `${upcoming.length} visits on the calendar`}>
            <div className="space-y-2">
              {upcoming.map(j => <UpcomingRow key={j.id} j={j} view={view} />)}
            </div>
          </PortalSection>
        </div>
      )}

      <div className={cn('animate-rise', upcoming.length > 0 && 'stagger-2')}>
        <PortalSection title="Visit history" sub="Every visit, with the photos to prove it">
          {completed.length === 0 ? (
            <Empty icon={History} text="Your visit history will appear here after your first visit." />
          ) : (
            <div className="space-y-3">
              {completed.map(j => (
                <VisitCard
                  key={j.id}
                  j={j}
                  view={view}
                  actions={actions}
                  photos={view.photosByJob.get(j.id) ?? []}
                  invoice={view.invoiceByJob.get(j.id) ?? null}
                />
              ))}
            </div>
          )}
        </PortalSection>
      </div>

      {loosePhotos.length > 0 && (
        <div className="animate-rise stagger-3">
          <PortalSection title="More photos" sub="Recent photos from your property">
            <div className="grid grid-cols-3 gap-1.5">
              {loosePhotos.map(p => (
                <Thumb key={p.id} href={actions.photoUrl(p.storage_path)} src={actions.photoUrl(p.storage_path)} alt={p.caption || 'Photo'} />
              ))}
            </div>
          </PortalSection>
        </div>
      )}
    </div>
  )
}

// ── Upcoming row ────────────────────────────────────────────────────────────
// A visit row says WORK — date, what, live status. Never a price: the invoice
// is where money speaks, and putting a figure here would be a second (and
// eventually contradictory) money surface.

function UpcomingRow({ j, view }: { j: PortalJob; view: PortalView }) {
  const away = daysAwayLabel(j.scheduled_date, view.todayISO)
  // Only a multi-property customer needs the address to tell visits apart —
  // for everyone else it's their one home and the line is noise.
  const address = view.multiProperty ? resolveDocAddress(view.propsById, j.property_id, null) : null
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink tracking-tight">
          {format(parseLocalDate(j.scheduled_date), 'EEE, MMM d')}
        </p>
        <StatusPill s={liveStatusOf(j)} />
      </div>
      <div className="flex items-center gap-2 mt-1">
        <p className="text-xs text-ink-muted truncate">{j.service_type || j.title}</p>
        {away && (
          <span className="text-[10px] font-semibold text-accent-text bg-accent/10 border border-accent/25 rounded-full px-2 py-0.5 shrink-0">
            {away}
          </span>
        )}
      </div>
      {address && (
        <p className="text-[11px] text-ink-faint mt-1 flex items-center gap-1 truncate">
          <MapPin className="w-3 h-3 shrink-0" /> {address}
        </p>
      )}
    </div>
  )
}

// ── Completed visit card (the proof) ────────────────────────────────────────

function VisitCard({ j, view, actions, photos, invoice }: {
  j: PortalJob; view: PortalView; actions: PortalActions
  photos: PortalPhoto[]; invoice: PortalInvoice | null
}) {
  // The invoice's DISPLAY figures come from the doc engine (GST + discount +
  // overdue overlay already applied) — this tab never runs money maths.
  const invDoc = invoice ? view.docItems.find(d => d.kind === 'invoice' && d.rawId === invoice.id) ?? null : null
  const address = view.multiProperty ? resolveDocAddress(view.propsById, j.property_id, null) : null

  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink tracking-tight flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> {j.service_type || j.title}
        </p>
        {/* Dated by when the visit HAPPENED (visitDay) — photos and praise for
            Thursday's work must not be filed under the Tuesday it was booked for. */}
        <span className="text-xs text-ink-muted shrink-0">{format(parseLocalDate(visitDay(j)), 'MMM d, yyyy')}</span>
      </div>
      {address && (
        <p className="text-[11px] text-ink-faint mt-0.5 flex items-center gap-1 truncate">
          <MapPin className="w-3 h-3 shrink-0" /> {address}
        </p>
      )}
      {/* started_at/completed_at were already in the payload and never rendered — so
          "we were there" was an assertion with no substance behind it. Showing the
          real window is the difference between a claim and a record. Only shown when
          both stamps exist and the span is sane (a forgotten 'start' would otherwise
          report an 11-hour visit). */}
      {(() => {
        const st = j.started_at ? new Date(j.started_at).getTime() : null
        const en = j.completed_at ? new Date(j.completed_at).getTime() : null
        if (!st || !en || en <= st) return null
        const mins = Math.round((en - st) / 60000)
        if (mins < 1 || mins > 600) return null
        const span = mins < 60 ? `${mins} min` : `${Number((mins / 60).toFixed(1))} hr`
        return (
          <p className="text-xs text-ink-muted mt-1 flex items-center gap-1.5">
            <Clock className="w-3 h-3 text-ink-faint shrink-0" />
            On site {new Date(j.started_at!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            {' – '}{new Date(j.completed_at!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            <span className="text-ink-faint">· {span}</span>
          </p>
        )
      })()}

      <VisitPhotos photos={photos} photoUrl={actions.photoUrl} />

      {j.notes && <p className="text-xs text-ink-muted mt-2.5 whitespace-pre-wrap border-l-2 border-border pl-2">{j.notes}</p>}

      {/* The bill this visit produced — tap through to Billing to see (and pay)
          it. Figures + status come from the doc engine above, not local maths. */}
      {invoice && (
        <button
          type="button"
          onClick={() => actions.navigate('billing')}
          className="w-full flex items-center justify-between gap-2 mt-3 pt-2.5 border-t border-border text-xs card-lift rounded-lg px-1 py-1 -mx-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          aria-label={`View invoice ${invoice.invoice_number} in Billing`}
        >
          <span className="text-ink-muted flex items-center gap-1"><Receipt className="w-3.5 h-3.5" /> {invoice.invoice_number}</span>
          <span className="flex items-center gap-2">
            <span className="font-semibold text-ink tabular-nums">{fmtMoney(invDoc ? invDoc.amount : Number(invoice.amount) || 0)}</span>
            <InvoiceStatusPill status={invDoc ? invDoc.status : invoice.status} />
          </span>
        </button>
      )}
    </div>
  )
}

// ── The photo block: before/after pairing inlined into the visit ────────────
// When a visit has BOTH kinds, the two-column labelled layout (the old Photos
// tab's best view) renders right here. Otherwise: a 4-photo preview whose last
// tile carries the overflow and expands IN PLACE — the crew took every photo
// for the customer, and hiding any of them makes the work look smaller than it
// was. There is no separate gallery to hand off to anymore.

function VisitPhotos({ photos, photoUrl }: { photos: PortalPhoto[]; photoUrl: (p: string) => string }) {
  const [showAll, setShowAll] = useState(false)
  if (photos.length === 0) return null

  const before = photos.filter(p => p.kind === 'before')
  const after = photos.filter(p => p.kind === 'after')
  const other = photos.filter(p => p.kind !== 'before' && p.kind !== 'after')
  const hasBA = before.length > 0 && after.length > 0

  if (hasBA) {
    return (
      <div className="mt-3">
        <div className="grid grid-cols-2 gap-2">
          <PhotoCol label="Before" photos={before} photoUrl={photoUrl} />
          <PhotoCol label="After" photos={after} photoUrl={photoUrl} />
        </div>
        {/* Photos that are neither kind still happened on this visit — the old
            gallery silently dropped them in this layout; every photo shows now. */}
        {other.length > 0 && (
          <div className="grid grid-cols-4 gap-1.5 mt-2">
            {other.map(p => (
              <Thumb key={p.id} href={photoUrl(p.storage_path)} src={photoUrl(p.storage_path)} alt={p.caption || 'Photo'} />
            ))}
          </div>
        )}
      </div>
    )
  }

  const visible = showAll ? photos : photos.slice(0, 4)
  const hidden = photos.length - 4

  return (
    <div className="mt-3">
      <div className="grid grid-cols-4 gap-1.5">
        {visible.map((p, i) => {
          const isOverflow = !showAll && i === 3 && hidden > 0
          if (isOverflow) return (
            <button
              key={p.id} type="button" onClick={() => setShowAll(true)}
              aria-label={`Show all ${photos.length} photos from this visit`}
              className="relative aspect-square rounded-lg overflow-hidden border border-border bg-bg-tertiary group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photoUrl(p.storage_path)} alt="" loading="lazy" className="w-full h-full object-cover" />
              <span className="absolute inset-0 bg-black/60 group-hover:bg-black/50 transition-colors flex items-center justify-center text-sm font-semibold text-white tabular-nums">
                +{hidden}
              </span>
            </button>
          )
          return (
            <Thumb key={p.id} href={photoUrl(p.storage_path)} src={photoUrl(p.storage_path)} alt={p.caption || 'Photo'} />
          )
        })}
      </div>
      {showAll && hidden > 0 && (
        <div className="mt-2">
          <Button size="sm" variant="ghost" onClick={() => setShowAll(false)}>
            <Camera className="w-3.5 h-3.5" /> Show fewer photos
          </Button>
        </div>
      )}
    </div>
  )
}

function PhotoCol({ label, photos, photoUrl }: { label: string; photos: PortalPhoto[]; photoUrl: (p: string) => string }) {
  return (
    <div>
      <p className={cn('text-[10px] font-bold uppercase tracking-wide mb-1', label === 'Before' ? 'text-amber-400' : 'text-emerald-400')}>{label}</p>
      <div className="space-y-1.5">
        {photos.map(p => (
          <Thumb key={p.id} href={photoUrl(p.storage_path)} src={photoUrl(p.storage_path)} alt={p.caption || label} wide />
        ))}
      </div>
    </div>
  )
}
