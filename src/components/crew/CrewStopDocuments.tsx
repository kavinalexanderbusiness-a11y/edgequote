'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { sizeLabel } from '@/lib/documents'
import { ChevronDown, Download, FileText, RotateCw } from 'lucide-react'

// ── The paperwork for this visit, on the phone ───────────────────────────────
// The permit, the site plan, the access letter — documents the office shared TO
// THE WORK. Same shape as CrewStopMedia, for the same reasons.
//
// ⛔ NOT the customer's copy. `crew_job_documents` returns only
// visibility='worker' documents on a visit this crew is assigned to. A document
// shared with the CUSTOMER is deliberately unreachable here: pricing letters and
// signed acknowledgements are not crew-audience material, and widening the read
// to include them would put them on every crew phone.
//
// ⛔ READ ONLY. There is no crew upload and no crew signing door. Field capture
// is Session 69 Forms' eventual territory, and a second signature path racing it
// is exactly the competing engine this session was told not to build.
//
// ⭐ IT NEVER LOADS UNTIL IT IS OPENED. The day view already knows the COUNTS
// (one summary request for the whole day), so the card can honestly offer
// "2 documents" without a request per stop.

interface CrewDocument {
  id: string
  name: string
  category: string | null
  file_name: string
  mime: string | null
  size_bytes: number | null
  version_no: number
  created_at: string
}

type Load =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; docs: CrewDocument[] }
  | { kind: 'error'; message: string }

export function CrewStopDocuments({ jobId, count }: { jobId: string; count: number }) {
  const supabase = useState(() => createClient())[0]
  const [open, setOpen] = useState(false)
  const [load, setLoad] = useState<Load>({ kind: 'idle' })
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const fetchDocs = useCallback(async () => {
    setLoad({ kind: 'loading' })
    // A crew session has ZERO table access, so this is an RPC — the same door
    // every other crew read uses. It re-proves employer AND crew assignment.
    const { data, error } = await supabase.rpc('crew_job_documents', { p_job_id: jobId })
    if (!alive.current) return
    const res = data as { ok?: boolean; documents?: CrewDocument[] } | null
    if (error || !res?.ok) {
      setLoad({ kind: 'error', message: 'Couldn’t load the documents for this visit.' })
      return
    }
    setLoad({ kind: 'ok', docs: res.documents ?? [] })
  }, [supabase, jobId])

  // Nothing shared → no affordance at all. An empty disclosure that always says
  // "nothing here" is a dead end on every card of the day.
  if (count === 0) return null

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && load.kind === 'idle') void fetchDocs()
  }

  return (
    <div data-scoped-notes className="mt-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="tap-target w-full min-h-10 px-3 py-2 rounded-lg border border-violet-500/30 bg-violet-500/10 flex items-center gap-2 text-left"
      >
        <FileText className="w-3.5 h-3.5 shrink-0 text-violet-400" aria-hidden />
        <span className="text-xs font-semibold text-violet-200">Documents</span>
        <span className="text-[11px] text-violet-300/70 truncate">
          {count} document{count === 1 ? '' : 's'}
        </span>
        <ChevronDown className={cn('w-4 h-4 ml-auto shrink-0 text-violet-400/70 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {load.kind === 'loading' && (
            <p className="text-[11px] text-ink-muted" role="status">Loading…</p>
          )}

          {load.kind === 'error' && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-2.5">
              <p className="text-[11px] text-red-300">{load.message}</p>
              <button type="button" onClick={() => void fetchDocs()}
                className="tap-target mt-1.5 h-9 px-2.5 rounded-md border border-red-500/40 text-[11px] font-medium text-red-200 inline-flex items-center gap-1.5">
                <RotateCw className="w-3 h-3" aria-hidden /> Try again
              </button>
            </div>
          )}

          {/* The count said there were some and the list came back empty — that is
              a real disagreement (a document archived mid-shift), and saying so is
              better than an empty box that looks like a broken screen. */}
          {load.kind === 'ok' && load.docs.length === 0 && (
            <p className="text-[11px] text-ink-muted">Nothing attached to this visit any more.</p>
          )}

          {load.kind === 'ok' && load.docs.map(d => (
            <div key={d.id} className="rounded-lg border border-border bg-bg-secondary p-2.5">
              <p className="text-xs font-medium text-ink break-words">{d.name}</p>
              <p className="text-[11px] text-ink-faint mt-0.5">
                {[d.category, sizeLabel(d.size_bytes)].filter(Boolean).join(' · ')}
                {d.version_no > 1 ? ` · version ${d.version_no}` : ''}
              </p>
              {/* A plain navigation: the route re-proves the assignment, then
                  redirects to a short-lived signed URL. The worker's phone never
                  holds a storage path or a bucket name. */}
              <a
                href={`/api/crew/documents/file?document=${encodeURIComponent(d.id)}`}
                className="tap-target mt-1.5 h-9 px-2.5 rounded-md border border-border text-[11px] font-medium text-ink-muted inline-flex items-center gap-1.5"
              >
                <Download className="w-3 h-3" aria-hidden /> Open
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
