'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Skeleton } from '@/components/ui/Skeleton'
import { cn, formatDate } from '@/lib/utils'
import { thumbUrl } from '@/lib/photos'
import {
  REQUEST_PHOTO_BUCKET, alternateActions, openRequests, recommendedAction,
  requestDetails, requestKindLabel, requestPhotoPaths, type PortalRequest,
} from '@/lib/portalRequests'
import { AlertTriangle, Check, MessageSquarePlus, X } from 'lucide-react'

// ── The customer-request card ────────────────────────────────────────────────
// What the owner sees at the top of a conversation when that customer has asked
// for something from their portal and is still waiting. It sits in the SAME slot
// as LeadCard, above ConversationInfo, because a request and a website lead are
// the same shape of job: someone wants something, here is what they said, here
// is the one move that answers it.
//
// ⭐ IT IS A CARD ABOUT AN ASK, AND IT SAYS SO EVERYWHERE.
// The header says "asked", the primary button opens a creation door, and the
// hint under it states what has NOT happened. No affordance here writes a job, a
// date, or a price — the only thing this component can write to is
// service_requests.status, and only to close the item.
//
// Mobile: the whole card is one column of full-width rows — customer context
// comes from the header above it, the photos are a wrapping strip, and the
// primary action is a full-width button on a phone.
//
// ⛔ Deliberately NOT here: a reply box (the thread below IS the reply box, and a
// second composer on one screen is two places to type the same message), and any
// owner-only note field (see the resolution comment below).

const SELECT = 'id, created_at, customer_id, message, kind, status, preferred_date, job_id, recurrence_id, details, photos, from_portal'

interface JobLite { id: string; scheduled_date: string; service_type: string | null; title: string | null }

export function RequestCard({ customerId, onResolved }: { customerId: string; onResolved?: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<PortalRequest[]>([])
  const [jobs, setJobs] = useState<Record<string, JobLite>>({})
  const [loading, setLoading] = useState(true)
  // A failed read is NOT "no requests". This card is the only place these are
  // actionable, so swallowing the error would render the conversation as though
  // the customer had never asked — the same trap LeadCard documents.
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const fetchRequests = useCallback(async () => {
    setLoading(true)
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { setLoading(false); return }
    const { data, error } = await supabase.from('service_requests').select(SELECT)
      .eq('user_id', uid).eq('customer_id', customerId).eq('from_portal', true).eq('status', 'new')
      .order('created_at', { ascending: false }).limit(5)
    setLoadError(!!error)
    // Filtered through THE engine's predicate as well as the query, so this card
    // and the dashboard row can never disagree about what "waiting" means.
    const open = error ? [] : openRequests((data as PortalRequest[] | null) ?? [])
    setRows(open)
    setLoading(false)

    // The visit a schedule change names, so the card can say WHICH one instead of
    // making the owner match a job id. Scoped by user_id as well as the ids —
    // never trust an id from a row to be enough on its own.
    const jobIds = open.map(r => r.job_id).filter((j): j is string => !!j)
    if (jobIds.length) {
      const { data: js } = await supabase.from('jobs').select('id, scheduled_date, service_type, title')
        .eq('user_id', uid).eq('customer_id', customerId).in('id', jobIds)
      const map: Record<string, JobLite> = {}
      for (const j of (js as JobLite[]) || []) map[j.id] = j
      setJobs(map)
    } else setJobs({})
  }, [customerId, supabase])

  useEffect(() => { fetchRequests() }, [fetchRequests])

  /**
   * Close one request. 'handled' = you acted on it; 'dismissed' = you won't.
   *
   * ⭐ The write is verified before the row leaves the screen. A Supabase update
   * RESOLVES on failure, so an unchecked one is a request the owner believes they
   * closed — and the customer is still waiting on the other side of it. The row
   * only disappears once the server says it changed.
   *
   * No resolution NOTE is recorded on purpose: what the owner did is evidenced by
   * the artefact they created (a quote, a moved visit), and a free-text second
   * record of the same fact is a second source of truth that nothing reads.
   */
  async function close(id: string, status: 'handled' | 'dismissed') {
    if (busy) return
    setBusy(id)
    const { data, error } = await supabase.from('service_requests')
      .update({ status, resolved_at: new Date().toISOString() })
      .eq('id', id).select('id')
    setBusy(null)
    if (error || !data?.length) {
      toast.error(error?.message ? `Couldn’t close this request: ${error.message}` : 'Couldn’t close this request — please try again.')
      return
    }
    setRows(prev => prev.filter(r => r.id !== id))
    toast.success(status === 'handled' ? 'Request marked handled.' : 'Request dismissed — the conversation stays.')
    onResolved?.()
  }

  // Reserve the space while it loads so the thread below doesn't jump.
  if (loading) return (
    <div className="rounded-card border border-accent/20 bg-accent/[0.04] p-3.5 mb-3 space-y-2.5">
      <Skeleton className="h-3.5 w-40" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-9 w-36" />
    </div>
  )
  if (loadError) return (
    <Banner tone="warn" icon={AlertTriangle} className="mb-3"
      action={<Button size="sm" variant="secondary" onClick={fetchRequests}>Retry</Button>}>
      Couldn’t load this customer’s requests — anything they sent still exists.
    </Banner>
  )
  if (!rows.length) return null

  return (
    <div className="space-y-2 mb-3">
      {rows.map(r => (
        <RequestRow key={r.id} r={r} job={r.job_id ? jobs[r.job_id] ?? null : null}
          busy={busy === r.id} onClose={close} supabaseUrlFor={p => supabase.storage.from(REQUEST_PHOTO_BUCKET).getPublicUrl(p).data.publicUrl} />
      ))}
    </div>
  )
}

function RequestRow({ r, job, busy, onClose, supabaseUrlFor }: {
  r: PortalRequest
  job: { scheduled_date: string; service_type: string | null; title: string | null } | null
  busy: boolean
  onClose: (id: string, status: 'handled' | 'dismissed') => void
  supabaseUrlFor: (path: string) => string
}) {
  const action = recommendedAction(r)
  const others = alternateActions(r)
  const details = requestDetails(r.details)
  // Sanitised at render as well as at write. The DB CHECK is the enforcement;
  // this is a refusal to PAINT anything that check would not have accepted, so a
  // row written before the constraint existed still cannot put a foreign URL in
  // front of the owner.
  const photos = requestPhotoPaths(r.photos)

  return (
    <div className="rounded-card border border-accent/25 bg-accent/[0.04] p-3.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-accent-text flex items-center gap-1.5">
          <MessageSquarePlus className="w-3.5 h-3.5" /> {requestKindLabel(r.kind)}
        </p>
        <p className="text-[11px] text-ink-faint shrink-0">{formatDate(r.created_at)}</p>
      </div>

      {/* The customer's own words. Wrapped, never truncated — the ask is the
          whole point of the card, and a "…" here means opening something else. */}
      <p className="text-sm text-ink mt-1.5 whitespace-pre-wrap break-words">{r.message}</p>

      {/* The facts that make it actionable, each only when it exists. */}
      {(job || r.preferred_date || details.window || details.service) && (
        <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          {job && <Fact label="Their visit" value={`${formatDate(job.scheduled_date)} · ${job.service_type || job.title || 'Visit'}`} />}
          {r.preferred_date && <Fact label="Day they asked for" value={formatDate(r.preferred_date)} />}
          {details.window && details.window !== 'anytime' && <Fact label="Time of day" value={details.window} />}
          {details.service && <Fact label="Service" value={details.service} />}
        </dl>
      )}

      {photos.length > 0 && (
        <div className="mt-2.5">
          <p className="text-[11px] text-ink-muted mb-1.5">{photos.length} photo{photos.length !== 1 ? 's' : ''} they sent</p>
          <div className="flex flex-wrap gap-1.5">
            {photos.map(p => {
              const full = supabaseUrlFor(p)
              return (
                // Opens full-size in a new tab rather than pulling a lightbox into
                // the inbox — one tap on a phone, and no new modal layer in a
                // panel that already scrolls.
                <a key={p} href={full} target="_blank" rel="noopener noreferrer" className="block rounded-lg overflow-hidden border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={thumbUrl(full, 160, 160)} alt="Photo the customer attached to their request" className="w-16 h-16 object-cover" loading="lazy" />
                </a>
              )
            })}
          </div>
        </div>
      )}

      {/* ── The recommended next action ────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <ButtonLink href={action.href} size="sm" className="w-full sm:w-auto">{action.label}</ButtonLink>
        {others.map(a => (
          <Link key={a.key} href={a.href}
            className="inline-flex items-center h-9 px-3 rounded-xl border border-border bg-surface text-xs font-medium text-ink-muted hover:text-ink hover:border-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
            {a.label}
          </Link>
        ))}
      </div>
      {/* Says what has NOT happened. The owner reading this card must never come
          away thinking the visit already moved or the price is already agreed. */}
      <p className="text-[11px] text-ink-muted mt-1.5">{action.hint}</p>

      {/* ── Closing it ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 mt-2.5 pt-2.5 border-t border-border/50">
        <Button size="sm" variant="secondary" loading={busy} onClick={() => onClose(r.id, 'handled')}
          title="Close this request — you've dealt with it">
          <Check className="w-3.5 h-3.5" /> Mark handled
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onClose(r.id, 'dismissed')}
          className="text-ink-faint hover:text-ink" title="Close this request without acting — the conversation stays">
          <X className="w-3.5 h-3.5" /> Dismiss
        </Button>
        <span className={cn('text-[11px] text-ink-faint')}>Closing it here doesn’t message the customer — reply in the thread below.</span>
      </div>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-ink-faint shrink-0">{label}</dt>
      <dd className="text-ink font-medium capitalize">{value}</dd>
    </div>
  )
}
