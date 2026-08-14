'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Textarea'
import { formatDate } from '@/lib/utils'
import { describeTypicalDuration, type LocationSummary } from '@/lib/locationSummary'
import { CalendarClock, History, Timer, Camera, KeyRound, Edit2, AlertTriangle } from 'lucide-react'

// ── The field summary: what you need standing on the driveway ────────────────
// Ordered by what a phone at the gate is actually for, not by what is easiest to
// compute:
//   1. how do I get in            (the private access note)
//   2. what am I here to do       (next visit)
//   3. what happened last time    (last visit)
//   4. how long does this take    (typical duration, with its sample size)
//   5. what do we do here at all  (services, photos)
//
// It is deliberately NOT a dashboard. The timeline below already lists every
// event at this address and the properties list already carries the dossier
// (health, plan, pricing, performance) — so this restates neither. Every row is
// one line, and a row whose data does not exist is ABSENT rather than rendered
// as a dash, because a column of dashes is what makes a summary unscannable.

interface Props {
  summary: LocationSummary | null   // null while loading
  internalNotes: string | null
  onSaveInternalNotes: (v: string) => Promise<boolean>
  onRetry: () => void
  photosHref: string
}

/** One line of the summary. The icon is the scan anchor on a narrow screen. */
function Row({ icon: Icon, label, children }: {
  icon: typeof Timer; label: string; children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5 text-sm">
      <Icon className="w-4 h-4 text-ink-faint shrink-0 mt-0.5" aria-hidden />
      <div className="min-w-0 flex-1">
        <span className="text-ink-faint text-xs block leading-tight">{label}</span>
        <div className="text-ink leading-snug">{children}</div>
      </div>
    </div>
  )
}

export function LocationSummaryCard({
  summary, internalNotes, onSaveInternalNotes, onRetry, photosHref,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    const ok = await onSaveInternalNotes(draft)
    setSaving(false)
    if (ok) setEditing(false)
  }

  const note = (internalNotes || '').trim()

  return (
    <Card>
      <CardBody className="space-y-4">
        {/* ── Access ──────────────────────────────────────────────────────────
            First, because it is the only thing here that is useless once you
            have already knocked. PRIVATE — the label says so every time it is
            read, not just while editing, so nobody has to remember which of the
            two note fields they are looking at. */}
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-xs text-ink-faint inline-flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5" aria-hidden /> Access &amp; site notes
              <span className="text-ink-faint">· private</span>
            </span>
            {!editing && (
              <button type="button"
                onClick={() => { setDraft(internalNotes || ''); setEditing(true) }}
                // min-h-[40px] + negative margin: a thumb target that meets the
                // 40px floor without pushing the row taller, because this button
                // is tapped standing at a gate, one-handed.
                className="text-xs text-ink-muted hover:text-ink transition-colors inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded px-2 -mx-2 -my-2 min-h-[40px]">
                <Edit2 className="w-3 h-3" aria-hidden /> {note ? 'Edit' : 'Add'}
              </button>
            )}
          </div>
          {editing ? (
            <div className="space-y-2">
              <Textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} autoFocus
                // Same keyboard contract as ui/Modal and the two other note
                // editors on this page: ⌘/Ctrl+Enter saves, Escape cancels.
                onKeyDown={e => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (!saving) save() }
                  else if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
                }}
                placeholder="Gate on the east side · dog in the back yard · controller beside the garage" />
              <p className="text-[11px] text-ink-faint">
                Only you and your crew see this. Notes for the customer go in “Property notes” below.
              </p>
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>Cancel</Button>
                <Button size="sm" type="button" loading={saving} onClick={save}>Save</Button>
              </div>
            </div>
          ) : note ? (
            <p className="text-sm text-ink whitespace-pre-wrap leading-snug">{note}</p>
          ) : (
            <p className="text-sm text-ink-faint">
              Nothing recorded — gate, dog, parking, shut-off.
            </p>
          )}
        </div>

        {/* ── Visit memory ────────────────────────────────────────────────────
            One branch per STATE, and "we could not read it" is one of them. A
            failed visit read must never fall through to the empty copy below:
            "Never serviced" is a claim about the property, and this request
            never learned anything about the property at all. */}
        {summary == null ? (
          <div className="space-y-2" aria-busy="true">
            <div className="h-3 w-24 rounded bg-bg-tertiary animate-pulse" />
            <div className="h-3 w-40 rounded bg-bg-tertiary animate-pulse" />
          </div>
        ) : summary.visitsUnknown ? (
          <div className="rounded-xl border border-border bg-bg-tertiary px-3 py-2.5">
            <p className="text-sm text-ink inline-flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden />
              <span>Couldn’t load this property’s visits — so its history is unknown, not empty.</span>
            </p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>Retry</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Row icon={CalendarClock} label="Next visit">
              {summary.nextVisit
                ? <span><span className="font-semibold">{formatDate(summary.nextVisit.date!)}</span> · {summary.nextVisit.title}</span>
                : <span className="text-ink-muted">Nothing booked</span>}
            </Row>

            <Row icon={History} label="Last completed visit">
              {summary.lastVisit
                ? <span><span className="font-semibold">{formatDate(summary.lastVisit.date!)}</span> · {summary.lastVisit.title}</span>
                : <span className="text-ink-muted">No completed visits yet</span>}
            </Row>

            {/* Typical duration. Rendered ONLY when the engine returned one — it
                withholds below MIN_TYPICAL_SAMPLE rather than let a single visit
                masquerade as a norm. The sample size is not a tooltip: it is in
                the sentence, because "about 45 min" alone is a specification and
                "about 45 min · 3 timed visits" is an observation.
                When it is withheld but SOME visits are timed, say why — that is
                a fixable state ("time a few visits"), not an absence. */}
            {summary.typicalDuration ? (
              <Row icon={Timer} label="Typical visit">
                <span className="font-semibold">{describeTypicalDuration(summary.typicalDuration)}</span>
              </Row>
            ) : summary.completedCount ? (
              <Row icon={Timer} label="Typical visit">
                <span className="text-ink-muted">
                  {summary.timedVisits
                    ? `Not enough timed visits yet (${summary.timedVisits} of ${summary.completedCount})`
                    : `No visits here have been timed yet`}
                </span>
              </Row>
            ) : null}

            {/* What gets done here. Grouped ONLY by lib/serviceKey's declared
                table — "Lawn Mowing" and "Lawn mowing" are one service because
                that table says so, never because the strings look alike. */}
            {summary.services.length > 0 && (
              <Row icon={History} label={`Services performed · ${summary.completedCount} visit${summary.completedCount === 1 ? '' : 's'}`}>
                <span className="flex flex-wrap gap-1.5 mt-0.5">
                  {summary.services.map(s => (
                    <span key={s.key}
                      className="text-[11px] text-ink-muted border border-border rounded-lg px-2 py-0.5 bg-bg-tertiary whitespace-nowrap">
                      {s.label} <span className="text-ink font-semibold tabular-nums">{s.completed}</span>
                    </span>
                  ))}
                </span>
              </Row>
            )}

            {/* Photos are a DOOR, not a gallery — the timeline below renders them.
                A failed count is null and simply omits the row rather than
                claiming this address has no pictures. */}
            {summary.photoCount != null && summary.photoCount > 0 && (
              <Row icon={Camera} label="Photos">
                <Link href={photosHref}
                  className="text-accent-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded">
                  {summary.photoCount} photo{summary.photoCount === 1 ? '' : 's'} at this address
                </Link>
              </Row>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
