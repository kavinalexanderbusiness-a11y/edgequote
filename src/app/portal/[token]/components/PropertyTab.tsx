'use client'

// ── Property tab — "every property, instantly understood" ───────────────────
// Renders view.propertyModels (built by ../model's buildPropertyModels, THE
// grouping law): one rich page for a single-property customer; one section per
// property for a landlord, with the address as the section TITLE — address is a
// group heading, it anchors, it never becomes a row title. The NO_PROPERTY
// orphan bucket renders last. Calm facts, not dashboards: this tab answers
// "what do they know about my place, and what's happening on it".
//
// Presentational only — every figure here was derived in ../model.ts.

import { format } from 'date-fns'
import {
  Camera, CheckCircle2, MapPin, Receipt, Repeat, Ruler, StickyNote,
} from 'lucide-react'
import { cn, formatCurrency, parseLocalDate } from '@/lib/utils'
import type { PortalProperty, PropertyModel } from '../model'
import { Empty, StatCard, PortalSection, type TabProps } from './shared'

type PlanItem = PropertyModel['plans'][number]

function fmtDate(iso: string): string {
  return format(parseLocalDate(iso), 'MMM d, yyyy')
}

// Stagger utilities only go to 6 — later sections share the last step.
function stagger(i: number): string {
  return `stagger-${Math.min(i + 1, 6)}`
}

export function PropertyTab({ view, actions }: TabProps) {
  const models = view.propertyModels

  // Nothing measured, no address, no properties at all — say so plainly.
  if (!view.hasProperty) {
    return (
      <div className="animate-rise stagger-1">
        <Empty icon={MapPin} text="Your provider hasn't added property details yet." />
      </div>
    )
  }

  // Provider notes ride on the PRIMARY property only — `data.property`
  // (singular) is exactly that primary, and properties[0] is the same one
  // (model.ts guarantees the ordering), so the note lands on its card and
  // never gets copied onto a second address.
  const notes = view.data.property?.notes?.trim() || null
  const primaryId = view.properties[0]?.id ?? null

  // ── Single property: one unified page ─────────────────────────────────────
  if (models.length === 1) {
    const m = models[0]
    const p = m.property
    return (
      <div className="space-y-4">
        <div className="animate-rise stagger-1 rounded-card border border-border bg-bg-secondary p-4">
          <PropertyHeader property={p} fallbackAddress={view.data.property?.address ?? null} fallbackCity={view.data.property?.city ?? null} />
          <FactsRow model={m} onPhotos={() => actions.navigate('visits')} className="mt-3" />
        </div>

        {m.plans.length > 0 && (
          <div className="animate-rise stagger-2">
            <PortalSection title="Your plans" sub="Ongoing services at this property">
              <div className="space-y-2">
                {m.plans.map(pl => <PlanLine key={pl.recurrenceId} plan={pl} />)}
              </div>
            </PortalSection>
          </div>
        )}

        <div className="animate-rise stagger-3">
          <ActivityRow model={m} actions={actions} />
        </div>

        {notes && (
          <div className="animate-rise stagger-4">
            <NotesCard notes={notes} />
          </div>
        )}
      </div>
    )
  }

  // ── Multi property: one section per model, address as the heading ─────────
  return (
    <div className="space-y-5">
      {models.map((m, i) => {
        const isOrphan = m.property === null
        const title = isOrphan ? 'Not tied to a property' : m.property?.address?.trim() || 'Your property'
        const subBits = isOrphan
          ? 'Work we haven’t matched to one of your properties'
          : [m.property?.city, m.property?.province].filter(Boolean).join(', ') || undefined
        return (
          <div key={m.key} className={cn('animate-rise', stagger(i))}>
            <PortalSection title={title} sub={subBits}>
              <div className="space-y-3">
                {!isOrphan && m.property?.neighborhood && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted rounded-full border border-border bg-bg-tertiary px-2 py-0.5">
                    <MapPin className="w-3 h-3 text-ink-faint" /> {m.property.neighborhood}
                  </span>
                )}
                <FactsRow model={m} onPhotos={() => actions.navigate('visits')} />
                {m.plans.length > 0 && (
                  <div className="space-y-2">
                    {m.plans.map(pl => <PlanLine key={pl.recurrenceId} plan={pl} />)}
                  </div>
                )}
                {m.lastVisitDay && (
                  <p className="text-xs text-ink-muted flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Last visit {fmtDate(m.lastVisitDay)}
                  </p>
                )}
                <ActivityRow model={m} actions={actions} />
                {notes && !isOrphan && m.key === primaryId && <NotesCard notes={notes} />}
              </div>
            </PortalSection>
          </div>
        )
      })}
    </div>
  )
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function PropertyHeader({ property, fallbackAddress, fallbackCity }: { property: PortalProperty | null; fallbackAddress: string | null; fallbackCity: string | null }) {
  const address = property?.address?.trim() || fallbackAddress?.trim() || null
  const locality = [property?.city ?? fallbackCity, property?.province].filter(Boolean).join(', ')
  return (
    <div>
      <p className="text-base font-bold text-ink flex items-start gap-1.5">
        <MapPin className="w-4 h-4 text-ink-faint shrink-0 mt-1" />
        <span>{address || 'Your property'}</span>
      </p>
      {(locality || property?.neighborhood) && (
        <div className="flex flex-wrap items-center gap-2 mt-1.5 ml-[22px]">
          {locality && <span className="text-xs text-ink-muted">{locality}</span>}
          {property?.neighborhood && (
            <span className="text-[11px] font-medium text-ink-muted rounded-full border border-border bg-bg-tertiary px-2 py-0.5">
              {property.neighborhood}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// The facts row: only facts that exist. `lawn_sqft` is a historical column NAME
// holding a measured area of ANY kind (driveway, roof, deck) — the label is
// "Measured area", never the word "lawn".
function FactsRow({ model, onPhotos, className }: { model: PropertyModel; onPhotos: () => void; className?: string }) {
  const sqft = Number(model.property?.lawn_sqft) || 0
  const fence = Number(model.property?.fence_length) || 0
  return (
    <div className={cn('grid grid-cols-2 gap-2', className)}>
      {sqft > 0 && <StatCard label="Measured area" value={`${sqft.toLocaleString()} sq ft`} icon={Ruler} />}
      {fence > 0 && <StatCard label="Fence length" value={`${fence.toLocaleString()} ft`} icon={Ruler} />}
      <StatCard label="Visits completed" value={String(model.completed.length)} icon={CheckCircle2} />
      {model.photoCount > 0 && (
        <StatCard label="Photos" value={String(model.photoCount)} icon={Camera} onClick={onPhotos} />
      )}
    </div>
  )
}

// One plan, compactly — the same ServicePlan fields PlanRow reads, nothing
// inferred here. `paused` = history but no future visit booked; the honest
// label is "No visits booked", not "cancelled".
function PlanLine({ plan }: { plan: PlanItem }) {
  const perVisit = plan.recurringPrice ?? plan.initialPrice
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-border bg-bg-tertiary/40 px-3 py-2.5">
      <span className={cn('w-6 h-6 rounded-lg border flex items-center justify-center shrink-0 mt-0.5',
        plan.paused ? 'border-border bg-bg-tertiary text-ink-faint' : 'border-accent/25 bg-accent/10 text-accent-text')}>
        <Repeat className="w-3 h-3" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {plan.serviceName}
          <span className="text-xs font-normal text-ink-muted">· {plan.cadenceLabel}</span>
          {perVisit != null && perVisit > 0 && (
            <span className="text-xs font-normal text-ink-muted tabular-nums">· {formatCurrency(perVisit)}/visit</span>
          )}
        </p>
        <p className="text-[11px] mt-0.5">
          {plan.paused ? (
            <span className="text-ink-faint">No visits booked</span>
          ) : plan.nextVisitDate ? (
            <span className="text-ink-muted">Next visit <span className="font-semibold text-ink">{fmtDate(plan.nextVisitDate)}</span></span>
          ) : (
            <span className="text-ink-muted">No upcoming visits booked yet.</span>
          )}
        </p>
      </div>
    </div>
  )
}

// Counts as doorways, not dashboards — each one taps through to the tab that
// tells the full story.
function ActivityRow({ model, actions }: { model: PropertyModel; actions: TabProps['actions'] }) {
  const hasDocs = model.quoteCount > 0 || model.invoiceCount > 0
  const hasVisits = model.completed.length > 0
  if (!hasDocs && !hasVisits) return null
  return (
    <div className="flex flex-wrap gap-2">
      {hasDocs && (
        <button
          type="button"
          onClick={() => actions.navigate('billing')}
          className="card-lift inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted rounded-xl border border-border bg-bg-secondary px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <Receipt className="w-3.5 h-3.5 text-ink-faint" />
          {model.quoteCount} {model.quoteCount === 1 ? 'quote' : 'quotes'} · {model.invoiceCount} {model.invoiceCount === 1 ? 'invoice' : 'invoices'}
        </button>
      )}
      {hasVisits && (
        <button
          type="button"
          onClick={() => actions.navigate('visits')}
          className="card-lift inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted rounded-xl border border-border bg-bg-secondary px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <CheckCircle2 className="w-3.5 h-3.5 text-ink-faint" />
          {model.completed.length} {model.completed.length === 1 ? 'visit' : 'visits'}
        </button>
      )}
    </div>
  )
}

function NotesCard({ notes }: { notes: string }) {
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-1.5 flex items-center gap-1">
        <StickyNote className="w-3 h-3" /> Notes from your provider
      </p>
      <p className="text-sm text-ink-muted whitespace-pre-wrap">{notes}</p>
    </div>
  )
}
