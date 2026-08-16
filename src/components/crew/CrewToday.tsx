'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createClient } from '@/lib/supabase/client'
import { loadCrewDay, nextCrewStop, partitionCrewStops, type ActiveCrewStop, type CrewDay } from '@/lib/crewAccess'
import { crewStartVisit, crewCompleteVisit, crewStopForToday, crewRevertVisit, crewUncompleteVisit, type VisitState } from '@/lib/crewJob'
import { localTodayISO, cn } from '@/lib/utils'
import { directionsUrl } from '@/lib/route'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { StickyActionBar } from '@/components/ui/StickyActionBar'
import {
  CheckCircle2, Play, Navigation, Phone, StickyNote, Users, Check, Clock, AlertTriangle, Megaphone,
  NotebookPen, Eye, Lock, PauseCircle,
} from 'lucide-react'
import { CrewStopPhotos } from '@/components/crew/CrewStopPhotos'
import { CrewStopMedia } from '@/components/crew/CrewStopMedia'
import { CrewStopConversation } from '@/components/crew/CrewStopConversation'
import {
  startCrewInboxFeed, subscribeCrewInbox, getCrewInboxSnapshot, getCrewInboxServerSnapshot,
} from '@/lib/crewMessages'
import { CompletionSheet } from '@/components/completion/CompletionSheet'
import { crewSaveCompletionRecord } from '@/lib/crewJob'
import { CrewChanges } from '@/components/crew/CrewChanges'
import { crewDaySnapshot, diffCrewDay, crewOrderBasis, type CrewDaySnapshot } from '@/lib/crewBrief'
import { readCrewDayBaseline, writeCrewDayBaseline } from '@/lib/crewBriefStore'
import {
  cacheUserId, readCachedDay, writeCachedDay, clearCachedDays, lastUpdatedLabel,
} from '@/lib/field/todayCache'
import { buildVisitIntent, runVisitIntent, runCompletionRecord } from '@/lib/field/fieldWrite'
import { readDraft, saveDraft, clearDraft } from '@/lib/field/drafts'
import { useOnline } from '@/hooks/useOnline'

// ── Today ────────────────────────────────────────────────────────────────────
// The seven questions a worker has, answered in the order they ask them:
//   Where am I going?      → the next stop's address, first thing on the screen
//   What is the work?      → service + duration + the access note
//   Who is with me?        → the crew line
//   What state is it in?   → one badge per stop, from the canonical status
//   What CHANGED?          → the banner above the list (lib/crewBrief), because
//                            this screen silently re-reads itself every few
//                            minutes and the office edits the day after the
//                            worker has already read it
//   What do I do next?     → ONE button, pinned in the thumb zone
//   Did that save?         → the button reports the write; a failure says so and
//                            the row does not move
//
// State is re-read from the database after every write. There is no optimistic
// paint here on purpose: this screen exists to be TRUE, and the alternative
// (paint first, reconcile later) is exactly how a field app ends up showing a
// job as done that the server never accepted.

function timeLabel(t: string | null): string | null {
  if (!t) return null
  const [h, m] = t.split(':')
  const hh = Number(h)
  return `${((hh + 11) % 12) + 1}:${m} ${hh < 12 ? 'am' : 'pm'}`
}
function elapsedMin(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
}

export function CrewToday() {
  const supabase = createClient()
  const [day, setDay] = useState<CrewDay | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [revoked, setRevoked] = useState(false)
  // When a REFRESH fails, the day already on screen stays (it is still the best
  // truth held) — but the screen says so, with the time it was loaded, instead
  // of quietly posing as current. Cleared by the next successful load.
  const [staleAsOf, setStaleAsOf] = useState<number | null>(null)
  // ⭐ TRUE only while the board on screen came off the phone rather than the
  // server. Kept separate from `staleAsOf` because the two say different things:
  // a stale board was loaded live earlier THIS session; a cached one was
  // restored from disk and may predate the app being opened at all.
  const [fromCache, setFromCache] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  // The proof-of-work editor. Held by STOP ID rather than by a copy of the stop,
  // so the sheet always reads the freshest row `load()` put on screen — a note
  // the office edited mid-shift must not be overwritten by a snapshot taken when
  // the button was tapped. ⛔ It never opens itself: finishing a visit stays ONE
  // tap, and this is the affordance for the times there is something to say.
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [photosOutstanding, setPhotosOutstanding] = useState<Record<string, number>>({})
  // How much reference media the office attached to each of today's stops.
  // COUNTS ONLY — one request for the whole day, holding no URLs and nothing
  // signed. It exists so a card can offer "2 photos · 1 video" without a request
  // per stop; the signed URLs are minted only when a worker actually opens one
  // (a signature taken at 7am is dead by the eighth stop).
  //
  // A failure here is deliberately SILENT: the counts drive an affordance, not a
  // fact about the work. Missing them hides an optional section; an error banner
  // over it would push the day's real work off the screen.
  const [mediaCounts, setMediaCounts] = useState<Record<string, { photos: number; videos: number }>>({})
  // ⭐ ONE inbox fetch feeds BOTH the per-stop "Crew chat · 2 new" badges here
  // and the count on the Messages tab. Two components each running their own
  // effect against the same source is the bug NotificationBell already paid for
  // (its second bell's subscription threw and its badge was dead all session),
  // so the feed is a ref-counted module store subscribed to from both.
  const inboxItems = useSyncExternalStore(subscribeCrewInbox, getCrewInboxSnapshot, getCrewInboxServerSnapshot)
  const unreadByJob = useMemo(() => {
    const out: Record<string, number> = {}
    for (const i of inboxItems) out[i.job_id] = i.unread || 0
    return out
  }, [inboxItems])
  const today = localTodayISO()
  // Drives the wording of the cached-board banner only. ⛔ Never a gate on a
  // write: navigator.onLine is famously true on a captive portal, so the write
  // path asks the reconciliation engine what actually happened instead of
  // trusting this (lib/field/fieldWrite).
  const online = useOnline()
  // This device's signed-in user, resolved WITHOUT the network (a local session
  // read) — so drafts and the cached day are still scoped correctly on a cold
  // offline start, which is exactly when they are needed.
  const [cacheUid, setCacheUid] = useState<string | null>(null)
  const alive = useRef(true)
  const dayRef = useRef<CrewDay | null>(null)
  useEffect(() => { dayRef.current = day }, [day])
  const loadedAt = useRef<number>(Date.now())

  // loadCrewDay reports THREE outcomes, and this screen must keep them apart:
  //   ok      → the day, as truth (and the refresh timestamp advances)
  //   revoked → the DATABASE said this account is off the roster — the only
  //             time the "access turned off" message may render
  //   error   → the request never got an answer. Dead signal must never read
  //             as revocation OR as an empty day: with data on screen it keeps
  //             it and says it's stale; with none it says "couldn't load".
  const load = useCallback(async () => {
    const res = await loadCrewDay(supabase, today)
    if (!alive.current) return
    if (res.kind === 'ok') {
      setDay(res.day)
      setRevoked(false)
      setLoadFailed(false)
      setStaleAsOf(null)
      setFromCache(false)
      loadedAt.current = Date.now()
      // Keep the last good day on the phone. Best-effort and deliberately after
      // the render decision — a cache that refuses to write must never affect
      // what is on screen.
      void cacheUserId(supabase).then(uid => {
        if (uid) void writeCachedDay(uid, today, res.day, loadedAt.current)
      })
    } else if (res.kind === 'revoked') {
      setRevoked(true)
      setLoadFailed(false)
      // ⭐ The database ANSWERED that this account is off the roster. A
      // revocation the phone has actually heard must not leave the day's
      // customer addresses readable on it. (An `error` must never do this —
      // dead signal is not revocation.)
      void clearCachedDays()
    } else {
      // Couldn't reach the server. Three sub-cases, and they are not the same
      // sentence: a day already on screen goes stale; a COLD start falls back to
      // the phone's cached copy; with neither, we say we couldn't load.
      if (dayRef.current) setStaleAsOf(loadedAt.current)
      else {
        const uid = await cacheUserId(supabase)
        const hit = uid ? await readCachedDay(uid, today) : null
        if (!alive.current) return
        if (hit) {
          // ⛔ Rendered as CACHED, never as live: `fromCache` drives a banner
          // carrying the moment the server last answered. A cached day that
          // looked live would let a worker drive to a stop the office moved.
          setDay(hit.day)
          setFromCache(true)
          setStaleAsOf(hit.fetchedAt)
          loadedAt.current = hit.fetchedAt
        } else {
          setLoadFailed(true)
        }
      }
    }
    setLoading(false)

    // Ride along with the day refresh so a gate photo the office attaches
    // mid-morning appears on the next poll, exactly as a rewritten note does.
    // Kept OUT of the branch above on purpose: it must not be able to affect
    // whether the day renders, or in which of the three states.
    try {
      const res = await fetch(`/api/crew/media?date=${encodeURIComponent(today)}`)
      const d = await res.json().catch(() => ({}))
      if (alive.current && res.ok && d.ok) setMediaCounts(d.counts || {})
    } catch { /* an optional affordance, never the day */ }
  }, [supabase, today])

  useEffect(() => {
    let on = true
    void cacheUserId(supabase).then(uid => { if (on) setCacheUid(uid) })
    return () => { on = false }
  }, [supabase])

  useEffect(() => {
    alive.current = true
    load()
    // The board changes while the phone rides in the truck: the dispatcher
    // reassigns a stop, reschedules a visit, writes a gate code. Crew Mode has
    // no realtime channel BY DESIGN (a crew session holds no table access, and
    // postgres_changes needs it) — so this screen re-asks the RPC when the tab
    // comes back to the foreground, when the connection returns, and every few
    // minutes while open. A failed refresh keeps the current day + says stale.
    const onWake = () => { if (document.visibilityState === 'visible') load() }
    window.addEventListener('online', onWake)
    document.addEventListener('visibilitychange', onWake)
    const t = setInterval(onWake, 5 * 60_000)
    return () => {
      alive.current = false
      window.removeEventListener('online', onWake)
      document.removeEventListener('visibilitychange', onWake)
      clearInterval(t)
    }
  }, [load])

  // The conversation feed runs the same liveness contract (mount / visible /
  // online / slow tick) and for the same reason — no realtime is available to a
  // crew session. Its own module owns the loop; this just holds a reference so
  // it is running while Today is on screen.
  useEffect(() => startCrewInboxFeed(supabase), [supabase])

  // Returns the SAME map when the count hasn't moved, so React bails out of the
  // re-render. Without that the child's report-up effect and this setter would
  // chase each other forever (new object → re-render → new callback → effect).
  const reportPhotosOutstanding = useCallback((id: string, n: number) => {
    setPhotosOutstanding(m => (m[id] ?? 0) === n ? m : { ...m, [id]: n })
  }, [])

  // The live minute tick — an on-the-clock stop shows how long it has been
  // running, and that number has to keep moving.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 60000)
    return () => clearInterval(t)
  }, [])

  // ONE partition decides what counts as work: the header tally, the card list
  // and the cancelled line all read it, so a stop can't be counted on one side
  // and rendered on the other. Cancelled stops never enter `active`, never
  // become `next` (nextCrewStop skips them anyway), and get no buttons.
  const { active, cancelled } = partitionCrewStops(day?.stops ?? [])
  const next = nextCrewStop(active)
  const done = active.filter(s => s.status === 'completed').length

  // ── What changed since this worker last acknowledged ───────────────────────
  // The baseline is held in state rather than recomputed per load ON PURPOSE:
  // `load()` runs on focus, on reconnect and every five minutes, and a baseline
  // that advanced with it would consume the office's schedule change before the
  // worker ever looked at the phone (lib/crewBrief honesty rule 3). Only the
  // "Got it" button moves it.
  const [baseline, setBaseline] = useState<CrewDaySnapshot | null>(null)
  const [baselineReady, setBaselineReady] = useState(false)

  // What the worker is being shown right now, in comparable form. Derived, so
  // it tracks BOTH the day payload and the inbox feed — a message arriving
  // between day refreshes still counts as a change.
  const snapshot = useMemo(
    () => (day ? crewDaySnapshot(day, unreadByJob) : null),
    [day, unreadByJob],
  )

  // First successful day only. With nothing stored, TODAY becomes the baseline
  // and nothing is reported: a phone with cleared storage must not announce an
  // ordinary morning as eight changes (honesty rule 1). The technician id comes
  // from the payload, so this cannot run before the first load resolves — and
  // a failed load leaves `day` null, so an offline start never sets a baseline
  // it would later diff against (rule 4).
  useEffect(() => {
    if (baselineReady || !day || !snapshot) return
    const stored = readCrewDayBaseline(day.me?.id ?? null, today)
    if (stored) {
      setBaseline(stored)
    } else {
      writeCrewDayBaseline(snapshot)
      setBaseline(snapshot)
    }
    setBaselineReady(true)
  }, [baselineReady, day, snapshot, today])

  const changes = useMemo(
    () => (baselineReady && snapshot ? diffCrewDay(baseline, snapshot) : []),
    [baselineReady, baseline, snapshot],
  )

  // ⛔ The one place the baseline advances.
  const acknowledgeChanges = useCallback(() => {
    if (!snapshot) return
    writeCrewDayBaseline(snapshot)
    setBaseline(snapshot)
  }, [snapshot])

  const goToStop = useCallback((jobId: string) => {
    document.getElementById(`crew-stop-${jobId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  // Whose plan the numbered list is. 'booked' means nobody chose this order —
  // see lib/crewBrief.crewOrderBasis. The sequence itself is the RPC's and is
  // never recomputed here.
  const orderBasis = crewOrderBasis(day?.stops ?? [])

  async function act(stop: ActiveCrewStop, kind: 'start' | 'complete' | 'stop') {
    if (acting) return
    setActing(stop.id)
    try {
      const prev: VisitState = {
        status: stop.status, started_at: stop.started_at,
        completed_at: stop.completed_at, actual_minutes: stop.actual_minutes,
      }
      // ⭐⭐ ONE call for all three transitions, and it answers with one of
      // exactly three words: saved · pending · failed. The intent — including
      // the client-minted timestamp that makes a retry safe — is built ONCE
      // here, at the tap, and carried through every replay
      // (lib/field/visitIntent).
      const intent = buildVisitIntent(kind === 'stop' ? 'stop_for_day' : kind, stop)
      const res = await runVisitIntent(supabase, { stop, intent, date: today })

      if (res.state === 'failed') {
        toast.error(res.message || 'That didn’t save. Try again.')
        await load()
        return
      }
      const who = stop.customer?.name || stop.title

      // ⛔ Queued work is NOT done work, and the sentence must say so. No undo is
      // offered: the op is on disk and will reconcile itself on reconnect, so an
      // "undo" here would race its own replay — and the honest affordance for a
      // mis-tap with no signal is to act again once the board is live.
      if (res.state === 'pending') {
        toast(
          kind === 'start' ? `Started ${who} — saved on your phone, will sync`
            : kind === 'stop' ? `${who} — today’s time saved on your phone, will sync`
            : `${who} — finish saved on your phone, will sync`,
          { tone: 'info', duration: 6000 },
        )
        await load()
        return
      }
      // ⛔ "Done for today" must never read as "done". The words are as different
      // as the writes are.
      toast.undo(
        kind === 'start' ? `Started ${who}`
          : kind === 'stop' ? `${who} — today’s time recorded, still to finish`
          : `${who} — done`,
        async () => {
          // Undoing a COMPLETION goes through the server route: the draft invoice
          // this completion just created must die WITH the status (only the
          // server may touch invoices). Undoing a start or a stop is a plain
          // field revert — neither one billed anything.
          //
          // ⚠️ Undoing a STOP puts the four lifecycle fields back, and the work
          // session the database banked stays. That is deliberate: the time WAS
          // worked, and a crew tapping undo means "I'm not done for the day
          // after all", not "that hour didn't happen". The office can correct
          // the session in the job's work history if it really was a mis-tap.
          const reverted = { ...stop, updated_at: res.nextUpdatedAt ?? stop.updated_at }
          const r = kind === 'complete'
            ? await crewUncompleteVisit(supabase, reverted, prev)
            : await crewRevertVisit(supabase, reverted, prev)
          if (!r.ok) toast.error(r.error || 'Couldn’t undo that.')
          await load()
        })
      await load()
    } finally {
      if (alive.current) setActing(null)
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 rounded-card" />
        <Skeleton className="h-24 rounded-card" />
        <Skeleton className="h-24 rounded-card" />
      </div>
    )
  }

  if (revoked) {
    return (
      <Notice tone="amber" icon={AlertTriangle} title="Your access has been turned off">
        Your account is no longer active on this crew. Ask your manager to switch it back on.
      </Notice>
    )
  }

  if (loadFailed || !day) {
    return (
      <Notice tone="amber" icon={AlertTriangle} title="Couldn’t load today">
        We couldn’t reach the server. Check your signal and try again — nothing on this screen is out of date, because nothing loaded.
        <div className="mt-3"><Button size="sm" variant="secondary" onClick={() => { setLoading(true); load() }}>Try again</Button></div>
      </Notice>
    )
  }

  return (
    <div className={cn('space-y-3', next && 'pb-24')}>
      {/* Who and where I am today */}
      <header className="pb-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          {new Date(today + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
        </p>
        <h1 className="text-xl font-bold tracking-tight text-ink">
          {active.length === 0 ? 'Nothing booked today' : `${active.length - done} of ${active.length} to go`}
        </h1>
        <p className="mt-0.5 text-xs text-ink-muted flex items-center gap-1.5 flex-wrap">
          {day.crew?.name && <span className="font-medium text-ink">{day.crew.name}</span>}
          {day.teammates.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Users className="w-3.5 h-3.5" aria-hidden /> with {day.teammates.map(t => t.name).join(', ')}
            </span>
          )}
          {day.teammates.length === 0 && day.crew?.name && <span>· on your own today</span>}
        </p>
      </header>

      {/* ⭐⭐ The board below is not live, and this is the line that says so.
          Two phrasings for two different facts, because collapsing them would
          make one of them a lie:
            offline / cached → the day was restored from this phone, and the
                               time given is when the SERVER last answered
            stale            → it loaded live earlier this session and the
                               latest refresh couldn't reach the server
          ⛔ Never render a cached board without this. It is the entire
          justification for storing the day at all (lib/field/todayCache). */}
      {staleAsOf != null && (
        <div className="rounded-card border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 flex items-center justify-between gap-2" role="status">
          <p className="text-[11px] text-ink-muted">
            {fromCache ? (
              <>
                <span className="font-semibold text-ink">{online ? 'Can’t reach the server' : 'Offline'}</span>
                {' · '}{lastUpdatedLabel(staleAsOf)}. The office may have changed your day since.
              </>
            ) : (
              <>
                Couldn’t refresh — showing your board from{' '}
                {new Date(staleAsOf).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.
              </>
            )}
          </p>
          <Button size="sm" variant="secondary" onClick={() => load()}>Retry</Button>
        </div>
      )}

      {/* What the office wrote for today — the dispatch board's day + crew notes
          (gate codes, weather calls), which used to render only on the one
          screen a worker cannot open. The crew's own note first: specific beats
          general when both exist. */}
      {(day.crew_note?.trim() || day.day_note?.trim()) && (
        <div className="rounded-card border border-accent/30 bg-accent/[0.07] p-3.5">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent-text">
            <Megaphone className="w-3.5 h-3.5" aria-hidden /> From the office
          </p>
          {day.crew_note?.trim() && (
            <p className="mt-1.5 text-sm text-ink whitespace-pre-wrap break-words">{day.crew_note.trim()}</p>
          )}
          {day.day_note?.trim() && (
            <p className={cn('text-xs text-ink-muted whitespace-pre-wrap break-words', day.crew_note?.trim() ? 'mt-2 pt-2 border-t border-border/60' : 'mt-1.5')}>
              {day.day_note.trim()}
            </p>
          )}
        </div>
      )}

      {/* WHAT CHANGED. Above the work, because its whole purpose is to be read
          before the worker acts on a day they have already read once. Renders
          nothing when nothing changed, and nothing at all on a first open. */}
      <CrewChanges changes={changes} onDismiss={acknowledgeChanges} onGoToStop={goToStop} />

      {/* WHOSE ORDER THIS IS. The list below is the sequence crew_day returned
          and this screen never re-sorts it — but on a day nobody hand-ordered,
          that sequence is the order the visits were BOOKED in, not a route the
          office chose. One line, so the numbers stop implying a plan that does
          not exist. */}
      {orderBasis === 'booked' && (
        <p className="px-0.5 text-[11px] text-ink-faint">
          The office hasn’t set an order for today — these are listed as they were booked.
        </p>
      )}

      {active.length === 0 && (
        // "Nothing assigned" and "everything you saw got cancelled" are
        // different mornings — say which one it is.
        cancelled.length > 0 ? (
          <Notice tone="neutral" icon={Check} title="Nothing left to do today">
            Today’s work was cancelled by the office — the stops are listed below. Check the Week tab for what’s coming.
          </Notice>
        ) : (
          <Notice tone="neutral" icon={Check} title="No stops on the board">
            Nothing is assigned to your crew today. Check the Week tab for what’s coming.
          </Notice>
        )
      )}

      {active.map((stop, i) => {
        const isNext = next?.id === stop.id
        const finished = stop.status === 'completed'
        // `running` = this visit is UNDERWAY (it may have been worked on an
        // earlier day). `onClock` = somebody is on it right now. They came apart
        // the moment a job could be stopped for the day without being finished,
        // and conflating them is what would put "Finish" under a job nobody has
        // started today.
        const running = stop.status === 'in_progress'
        const onClock = running && !!stop.started_at
        return (
          <section
            key={stop.id}
            id={`crew-stop-${stop.id}`}
            aria-current={isNext ? 'step' : undefined}
            className={cn(
              'rounded-card border p-3.5 transition-colors',
              finished ? 'border-border bg-bg-tertiary/60 opacity-60'
                : running ? 'border-sky-400/40 bg-sky-400/10'
                : isNext ? 'border-accent/40 bg-accent/5'
                : 'border-border bg-bg-secondary',
            )}
          >
            <div className="flex items-start gap-2.5">
              <span className={cn(
                'mt-0.5 w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-xs font-bold',
                finished ? 'bg-emerald-500/20 text-emerald-300'
                  : running ? 'bg-sky-400 text-black'
                  : 'bg-accent text-black',
              )}>
                {finished ? <Check className="w-4 h-4" aria-hidden /> : running ? <Play className="w-3.5 h-3.5 fill-current" aria-hidden /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn('text-sm font-semibold text-ink truncate', finished && 'line-through opacity-80')}>
                  {stop.customer?.name || stop.title}
                </p>
                {/* WHERE. The single most important line on a worker's screen. */}
                {stop.property?.address && (
                  <p className="text-xs text-ink-muted truncate">{stop.property.address}</p>
                )}
                <p className="mt-0.5 text-[11px] text-ink-faint flex items-center gap-1.5 flex-wrap">
                  {stop.service_type && <span className="text-ink-muted">{stop.service_type}</span>}
                  {timeLabel(stop.start_time) && <span>· {timeLabel(stop.start_time)}</span>}
                  {stop.duration_minutes ? <span>· {stop.duration_minutes} min</span> : null}
                  {running && stop.started_at && (
                    <span className="font-semibold text-sky-300 inline-flex items-center gap-1">
                      · <Clock className="w-3 h-3" aria-hidden /> {elapsedMin(stop.started_at)}m on site
                    </span>
                  )}
                  {finished && stop.actual_minutes != null && <span className="text-emerald-400">· {stop.actual_minutes}m</span>}
                </p>

                {/* WHAT THE WORK IS — the access note, on the card face. */}
                {stop.notes?.trim() && (
                  <div className="mt-2 flex items-start gap-1.5 rounded-md border border-border bg-bg-tertiary/60 px-2 py-1.5 text-xs text-ink-muted">
                    <StickyNote className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400/80" aria-hidden />
                    <span className="whitespace-pre-wrap break-words">{stop.notes.trim()}</span>
                  </div>
                )}

                {/* …and what it LOOKS like. Reference photos/video the office
                    attached to this visit, collapsed until tapped — see
                    CrewStopMedia for why the URLs are signed at that moment and
                    not at load. Renders nothing when nothing is attached. */}
                <CrewStopMedia
                  jobId={stop.id}
                  photos={mediaCounts[stop.id]?.photos ?? 0}
                  videos={mediaCounts[stop.id]?.videos ?? 0}
                />

                {/* …and what is being SAID about it. Deliberately beside the work
                    instructions and not merged with them: the note above is the
                    standing fact ("gate code 1942", edited in place, true
                    whoever wrote it), and this is what people said and when.
                    Collapsing the two would bury the gate code under twenty
                    replies. See lib/crewMessages for the full distinction. */}
                <CrewStopConversation jobId={stop.id} unread={unreadByJob[stop.id] ?? 0} />

                <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
                  <a
                    href={directionsUrl({ lat: stop.property?.lat ?? null, lng: stop.property?.lng ?? null, address: stop.property?.address }, null)}
                    target="_blank" rel="noopener noreferrer"
                    className="tap-target h-10 px-3 rounded-lg border border-border text-xs font-medium text-ink-muted flex items-center justify-center gap-1.5 hover:text-ink hover:border-border-strong transition-colors"
                  >
                    <Navigation className="w-3.5 h-3.5" aria-hidden /> Directions
                  </a>
                  {stop.customer?.phone && (
                    <a
                      href={`tel:${stop.customer.phone}`}
                      className="tap-target h-10 px-3 rounded-lg border border-border text-xs font-medium text-ink-muted flex items-center justify-center gap-1.5 hover:text-ink hover:border-border-strong transition-colors"
                    >
                      <Phone className="w-3.5 h-3.5" aria-hidden /> Call
                    </a>
                  )}
                  {/* Say what happened. Available at EVERY stage, not gated
                      behind finishing: the leaking sprinkler head is found while
                      working, not remembered at the end of a form. Finishing
                      stays one tap and this never interrupts it. */}
                  <button
                    type="button"
                    onClick={() => setRecordingId(stop.id)}
                    className="tap-target h-10 px-3 rounded-lg border border-border text-xs font-medium text-ink-muted flex items-center justify-center gap-1.5 hover:text-ink hover:border-border-strong transition-colors"
                  >
                    <NotebookPen className="w-3.5 h-3.5" aria-hidden />
                    {stop.completion_summary || stop.completion_issue ? 'Edit note' : 'Add note'}
                  </button>
                  {/* ⭐ A WAY OUT OF THE DAY THAT ISN'T "FINISH". On the clock,
                      a worker gets both: Done for today (records the time,
                      leaves the job open) and Finish (which hands off to
                      billing). Without the first, the only single tap available
                      to somebody coming back tomorrow was the one that tells
                      the office the work is complete. */}
                  {onClock && (
                    <Button
                      size="sm" variant="secondary" className="tap-target h-10"
                      disabled={acting !== null}
                      onClick={() => act(stop, 'stop')}
                    >
                      <PauseCircle className="w-4 h-4" aria-hidden /> Done for today
                    </Button>
                  )}
                  {!finished && (
                    <Button
                      size="sm"
                      variant={onClock ? 'primary' : 'secondary'}
                      className="tap-target h-10"
                      loading={acting === stop.id}
                      disabled={acting !== null && acting !== stop.id}
                      onClick={() => act(stop, onClock ? 'complete' : 'start')}
                    >
                      {onClock
                        ? <><CheckCircle2 className="w-4 h-4" aria-hidden /> Finish</>
                        : running
                          ? <><Play className="w-4 h-4" aria-hidden /> Resume</>
                          : <><Play className="w-4 h-4" aria-hidden /> Start</>}
                    </Button>
                  )}
                </div>

                {/* What has already been recorded, on the card face — so a
                    worker can see it without opening anything, and the two
                    audiences stay visibly apart (eye = the customer reads it,
                    lock = only the office does). */}
                {stop.completion_summary?.trim() && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-muted">
                    <Eye className="w-3.5 h-3.5 shrink-0 mt-0.5 text-accent-text" aria-hidden />
                    <span className="whitespace-pre-wrap break-words">{stop.completion_summary.trim()}</span>
                  </p>
                )}
                {stop.completion_issue?.trim() && (
                  <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-300/90">
                    <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
                    <span className="whitespace-pre-wrap break-words">{stop.completion_issue.trim()}</span>
                  </p>
                )}

                {/* Photograph the work — 'before' until it starts, 'after' once
                    on the clock or done. Uploads go through /api/crew/photos,
                    which re-verifies this visit belongs to this worker's crew. */}
                <CrewStopPhotos
                  jobId={stop.id}
                  status={stop.status}
                  onOutstandingChange={n => reportPhotosOutstanding(stop.id, n)}
                />
              </div>
            </div>
          </section>
        )
      })}

      {/* What the office CANCELLED today — the server's own record, from the
          same payload as the work (no client memory of "what was seen" to
          drift). A stop a worker watched all morning must move HERE when it's
          pulled, not silently vanish between refetches. Deliberately compact:
          one struck-through line each, no buttons, no notes, no photos — this
          is a "don't go", not a job card — and it never persists beyond the
          day it happened on. */}
      {cancelled.length > 0 && (
        <section aria-label="Cancelled today" className="rounded-card border border-border bg-bg-tertiary/40 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Cancelled today — don’t go
          </p>
          <ul className="mt-1.5 space-y-1">
            {cancelled.map(stop => (
              <li key={stop.id} id={`crew-stop-${stop.id}`} className="text-xs text-ink-faint line-through truncate">
                {stop.customer?.name || stop.title}
                {stop.property?.address ? ` — ${stop.property.address}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* THE next action, in the thumb zone. Restates the same button the card
          shows and calls the same writer — reach, not a second way to do it. */}
      {next && (
        <StickyActionBar fixed>
          <div className="mx-auto flex max-w-lg items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                {next.status === 'in_progress'
                  ? (next.started_at ? 'On the clock' : 'Started earlier')
                  : 'Next stop'}
              </p>
              <p className="text-sm font-semibold text-ink truncate">{next.customer?.name || next.title}</p>
              {next.property?.address && <p className="text-[11px] text-ink-muted truncate">{next.property.address}</p>}
            </div>
            {next.status === 'in_progress' && next.started_at && (
              <Button
                size="lg" variant="secondary" className="shrink-0 tap-target"
                disabled={acting !== null}
                onClick={() => act(next, 'stop')}
              >
                <PauseCircle className="w-4 h-4" aria-hidden /> Stop
              </Button>
            )}
            <Button
              size="lg"
              className="shrink-0 tap-target"
              loading={acting === next.id}
              disabled={acting !== null && acting !== next.id}
              onClick={() => act(next, next.status === 'in_progress'
                ? (next.started_at ? 'complete' : 'start')
                : 'start')}
            >
              {next.status === 'in_progress'
                ? (next.started_at
                  ? <><CheckCircle2 className="w-4 h-4" aria-hidden /> Finish</>
                  : <><Play className="w-4 h-4" aria-hidden /> Resume</>)
                : <><Play className="w-4 h-4" aria-hidden /> Start</>}
            </Button>
          </div>
        </StickyActionBar>
      )}

      {/* The record editor. Reads the stop straight out of the day currently on
          screen, so it can never save over a fresher note; writes through the
          typed crew RPC, which re-checks that this visit is still this crew's.
          A failed save keeps the words in the boxes and says so. */}
      {(() => {
        const stop = active.find(s => s.id === recordingId)
        if (!stop) return null
        return (
          <CompletionSheet
            open
            onClose={() => setRecordingId(null)}
            job={stop}
            photosOutstanding={photosOutstanding[stop.id] ?? 0}
            // ⭐ Three answers, not two: a note the phone is holding reports
            // `pending` so the sheet's confirmation can say so, instead of
            // "Saved" over words the office cannot read yet.
            onSave={async record => {
              const res = await runCompletionRecord(supabase, {
                jobId: stop.id, title: stop.customer?.name || stop.title, record,
              })
              return res.state === 'failed'
                ? { ok: false, error: res.message }
                : { ok: true, pending: res.state === 'pending' }
            }}
            // Durable across a killed tab, not just a failed request. Keyed by
            // worker AND visit, so a shared phone never shows one worker the
            // words another typed.
            draftStore={{
              load: () => {
                if (!cacheUid) return null
                const s = readDraft(cacheUid, stop.id, 'completion_summary')
                const i = readDraft(cacheUid, stop.id, 'completion_issue')
                if (!s && !i) return null
                return { summary: s?.text ?? '', issue: i?.text ?? '' }
              },
              save: record => {
                if (!cacheUid) return
                saveDraft(cacheUid, stop.id, 'completion_summary', record.completion_summary || '')
                saveDraft(cacheUid, stop.id, 'completion_issue', record.completion_issue || '')
              },
              clear: () => {
                if (!cacheUid) return
                clearDraft(cacheUid, stop.id, 'completion_summary')
                clearDraft(cacheUid, stop.id, 'completion_issue')
              },
            }}
            onSaved={() => { void load() }}
          />
        )
      })()}
    </div>
  )
}

function Notice({ tone, icon: Icon, title, children }: {
  tone: 'amber' | 'neutral'; icon: typeof Check; title: string; children: React.ReactNode
}) {
  return (
    <div className={cn('rounded-card border p-4',
      tone === 'amber' ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-border bg-bg-secondary')}>
      <p className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Icon className={cn('w-4 h-4 shrink-0', tone === 'amber' ? 'text-amber-300' : 'text-ink-muted')} aria-hidden />
        {title}
      </p>
      <div className="mt-1 text-xs text-ink-muted">{children}</div>
    </div>
  )
}
