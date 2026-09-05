'use client'

// ── "Possible duplicate worker records" ──────────────────────────────────────
// A WARNING, and only a warning. Every control on this card either expands
// something or opens the existing worker editor. There is no merge, no delete,
// no archive, and no "fix it for me" — because the rows underneath carry paid
// hours, wage history and PTO, which are statutory records that a person has to
// decide about.
//
// ⭐ IT RENDERS NOTHING when there is nothing to say, which is the ordinary
// case. An empty warning card teaches an owner to scroll past the place warnings
// appear.
//
// ⛔ THE WORD "DUPLICATE" IS NEVER ATTACHED TO A NAME MATCH. The second section
// of this card is about records we could NOT judge, and it says so — it names
// the identifier that would settle the question instead of implying an answer.
// A name is not an identifier, and two people really are called John Smith.

import { useMemo, useState } from 'react'
import type { Technician } from '@/types'
import { createClient } from '@/lib/supabase/client'
import {
  CONFIDENCE_LABEL, CONFIDENCE_MEANING, EVIDENCE_LABEL, mergeBlockedReason,
  missingIdentifierSentence, scanWorkerIdentities, totalHistoryRows,
  type DuplicateWorkerFinding, type IdentityConfidence, type WorkerHistoryCounts,
} from '@/lib/workforceIdentity'
import { loadWorkerHistoryCounts } from '@/lib/workforceIdentityData'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { Users, ChevronDown, ChevronUp, Info, ShieldAlert } from 'lucide-react'

const TONE: Record<IdentityConfidence, string> = {
  confirmed: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  probable: 'text-amber-400/90 border-amber-500/25 bg-amber-500/[0.07]',
  possible: 'text-ink-muted border-border bg-bg-tertiary',
}

export function WorkerIdentityWarnings({ technicians, onOpen }: {
  /** Everyone, archived included — a rehire is exactly the pair that matters. */
  technicians: Technician[]
  /** The EXISTING door. Review means "open the worker", nothing more. */
  onOpen: (t: Technician) => void
}) {
  const supabase = createClient()
  const byId = useMemo(() => Object.fromEntries(technicians.map(t => [t.id, t])), [technicians])

  // Pure, synchronous, and free — no fetch happens unless a person expands a row.
  const { findings, uncheckable } = useMemo(
    () => scanWorkerIdentities(technicians), [technicians],
  )

  const [openPair, setOpenPair] = useState<string | null>(null)
  const [showUncheckable, setShowUncheckable] = useState(false)
  const [history, setHistory] = useState<Record<string, WorkerHistoryCounts>>({})
  const [unreadable, setUnreadable] = useState<string[]>([])
  const [loadingPair, setLoadingPair] = useState<string | null>(null)

  // ⭐ Renders nothing when there is nothing to say.
  if (!findings.length && !uncheckable.length) return null

  async function expand(f: DuplicateWorkerFinding) {
    const key = `${f.aId}:${f.bId}`
    if (openPair === key) { setOpenPair(null); return }
    setOpenPair(key)
    if (history[f.aId] && history[f.bId]) return
    const uid = byId[f.aId]?.user_id
    if (!uid) return
    setLoadingPair(key)
    try {
      const res = await loadWorkerHistoryCounts(supabase, uid, [f.aId, f.bId])
      setHistory(h => ({ ...h, ...res.counts }))
      setUnreadable(res.unreadable)
    } finally { setLoadingPair(null) }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-lg border border-amber-500/30 bg-amber-500/10 flex items-center justify-center shrink-0">
            <Users className="w-4 h-4 text-amber-400" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">Possible duplicate worker records</p>
            <p className="text-xs text-ink-muted mt-0.5 leading-snug">
              Two records that may belong to one person. Nothing here changes anything —
              open a record to look, and decide yourself.
            </p>
          </div>
        </div>

        {findings.map(f => {
          const key = `${f.aId}:${f.bId}`
          const a = byId[f.aId], b = byId[f.bId]
          if (!a || !b) return null
          const expanded = openPair === key
          return (
            <div key={key} className={cn('rounded-xl border', TONE[f.confidence])}>
              <button type="button" onClick={() => expand(f)} aria-expanded={expanded}
                className="w-full text-left px-3 py-2.5 flex items-start justify-between gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-xl">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">
                    {a.name} <span className="text-ink-faint" aria-hidden>·</span> {b.name}
                  </p>
                  {/* ⭐ The state of EACH record, on the collapsed row. A rehire
                      pair reads completely differently from two live records, and
                      the owner should not have to expand to learn which it is. */}
                  <p className="text-[11px] text-ink-muted mt-0.5">
                    {standing(a)} <span className="text-ink-faint" aria-hidden>·</span> {standing(b)}
                  </p>
                  <p className="text-[11px] mt-1 font-semibold uppercase tracking-wide">
                    {CONFIDENCE_LABEL[f.confidence]}
                  </p>
                </div>
                {/* ⭐ aria-hidden, matching every other icon in this file (Users,
                    Info, ShieldAlert above/below). The button's own
                    aria-expanded already tells a screen reader whether this is
                    open or closed — an unlabelled <svg> with no aria-hidden can
                    be announced as an unnamed graphic on some screen readers,
                    which is noise the text content doesn't need. */}
                {expanded
                  ? <ChevronUp className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
                  : <ChevronDown className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />}
              </button>

              {expanded && (
                <div className="px-3 pb-3 space-y-2.5 border-t border-border/40 pt-2.5">
                  <p className="text-[11px] text-ink-muted">{CONFIDENCE_MEANING[f.confidence]}</p>

                  {/* WHY it was flagged — the evidence, named. */}
                  <div className="flex flex-wrap gap-1.5">
                    {f.evidence.map(e => (
                      <span key={e.kind} className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border border-border bg-bg-secondary text-ink-muted">
                        {EVIDENCE_LABEL[e.kind]}
                      </span>
                    ))}
                  </div>
                  <ul className="space-y-1">
                    {f.reasons.map((r, i) => (
                      <li key={i} className="text-xs text-ink-muted flex items-start gap-1.5">
                        <Info className="w-3 h-3 shrink-0 mt-0.5 text-ink-faint" aria-hidden />{r}
                      </li>
                    ))}
                  </ul>

                  {/* What each record carries. ⭐ This is the number that explains
                      why there is no merge button. */}
                  <div className="grid grid-cols-2 gap-2">
                    {[a, b].map(t => (
                      <div key={t.id} className="rounded-lg border border-border bg-bg-secondary px-2.5 py-2">
                        <p className="text-xs font-medium text-ink truncate">{t.name}</p>
                        <p className="text-[11px] text-ink-faint mt-0.5">{standing(t)}</p>
                        <p className="text-[11px] text-ink-muted mt-1 tabular-nums">
                          {loadingPair === key && !history[t.id]
                            ? 'checking history…'
                            : history[t.id]
                              ? `${totalHistoryRows(history[t.id])} linked record${totalHistoryRows(history[t.id]) === 1 ? '' : 's'}`
                              : '—'}
                        </p>
                        {history[t.id] && (
                          <p className="text-[10px] text-ink-faint mt-0.5 leading-snug">
                            {history[t.id].timeEntries} shifts · {history[t.id].payRunLines} pay lines · {history[t.id].wageHistory} wage · {history[t.id].ptoEntries} PTO · {history[t.id].jobs} visits
                          </p>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* ⚠️ A count that could not be read is NOT zero. Saying so is
                      what stops "nothing points at this record" being inferred
                      from a failed request. */}
                  {unreadable.length > 0 && (
                    <p className="text-[11px] text-amber-400 flex items-start gap-1.5">
                      <ShieldAlert className="w-3 h-3 shrink-0 mt-0.5" aria-hidden />
                      Some history could not be checked ({unreadable.join(', ')}) — treat these counts as incomplete.
                    </p>
                  )}

                  {/* ⛔ THE ONLY ACTIONS: open one record, or open the other. */}
                  <p className="text-[11px] text-ink-faint leading-snug">
                    {mergeBlockedReason(history[a.id], history[b.id])}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" size="sm" onClick={() => onOpen(a)}>
                      Review {a.name}
                    </Button>
                    <Button type="button" variant="secondary" size="sm" onClick={() => onOpen(b)}>
                      Review {b.name}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )
        })}

        {/* ── Records we could NOT judge ────────────────────────────────────
            ⛔ Deliberately NOT called duplicates, and deliberately below the
            findings. A shared name is not evidence; this section exists to name
            the identifier that would let the question be answered at all. */}
        {uncheckable.length > 0 && (
          <div className="pt-1">
            <button type="button" onClick={() => setShowUncheckable(v => !v)}
              aria-expanded={showUncheckable}
              className="text-xs text-ink-muted hover:text-ink rounded px-1 -mx-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              {showUncheckable ? 'Hide' : 'Show'} {uncheckable.length} pair{uncheckable.length === 1 ? '' : 's'} sharing a name
              <span className="text-ink-faint"> — not enough information to tell</span>
            </button>
            {showUncheckable && (
              <div className="mt-2 space-y-2">
                {uncheckable.map(u => {
                  const a = byId[u.aId], b = byId[u.bId]
                  if (!a || !b) return null
                  return (
                    <div key={`${u.aId}:${u.bId}`} className="rounded-xl border border-border bg-bg-tertiary/40 px-3 py-2.5">
                      <p className="text-sm font-medium text-ink">{u.sharedName} <span className="text-ink-faint">×2</span></p>
                      <p className="text-[11px] text-ink-muted mt-0.5">{standing(a)} <span className="text-ink-faint" aria-hidden>·</span> {standing(b)}</p>
                      <p className="text-[11px] text-ink-muted mt-1 leading-snug">{missingIdentifierSentence(u.missing)}</p>
                      <div className="flex flex-wrap gap-2 mt-2">
                        <Button type="button" variant="ghost" size="sm" onClick={() => onOpen(a)}>Review {a.name}</Button>
                        <Button type="button" variant="ghost" size="sm" onClick={() => onOpen(b)}>Review the other</Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

/** Active / paused / former, in the roster's own vocabulary. */
function standing(t: Technician): string {
  if (t.archived_at) return 'Former'
  if (!t.is_active) return 'Paused'
  return 'Active'
}
