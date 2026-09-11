'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { cacheLease, getCacheGeneration, isCurrentLease, subscribeCacheOwner, type CacheLease } from '@/lib/clientCache'
import { loadPilotQuoteAuxiliary, type PilotQuoteAuxiliaryResult } from '@/lib/quotes/pilotQuoteAuxiliaryLoader'
import { PilotQuoteSaveEditorShell, type PilotQuoteAuxiliaryContext, type PilotQuoteSaveEditorShellProps } from './PilotQuoteSaveEditorShell'

type Ready = Extract<PilotQuoteAuxiliaryResult, { code: 'ready' }>
type Load = {
  client: SupabaseClient; quoteId: string; attempt: number; authRevision: number; refresh: number
  lease: CacheLease | null; alive: boolean; serial: number; controller: AbortController | null
  ready: Ready | null; status: PilotQuoteAuxiliaryResult['code'] | 'loading'
}

/** Memory-only owner lifetime. Auth events revoke publication synchronously,
 * before React renders the unavailable state or a queued Save can run. */
export function usePilotQuoteAuxiliary(client: SupabaseClient, quoteId: string, attempt = 0) {
  const generation = useSyncExternalStore(subscribeCacheOwner, getCacheGeneration, () => 0)
  // The server and first hydration pass observe generation zero. CacheOwner
  // may already have adopted in browser render; use only the observed snapshot.
  const candidateLease = cacheLease()
  const lease = generation > 0 && candidateLease?.gen === generation ? candidateLease : null
  const [authRevision, setAuthRevision] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [, render] = useState(0)
  const active = useRef<Load | null>(null)
  // A known sign-out or different SDK account hides prior private form values.
  // Keep the subtree mounted so even an undurable draft survives; only a newly
  // verified complete owner load may reveal it again.
  const concealed = useRef(false)
  const previous = active.current
  if (!previous || previous.client !== client || previous.quoteId !== quoteId || previous.attempt !== attempt
    || previous.authRevision !== authRevision || previous.refresh !== refresh
    || previous.lease?.owner !== lease?.owner || previous.lease?.gen !== lease?.gen) {
    if (previous) { previous.ready = null; previous.alive = false; previous.controller?.abort() }
    active.current = { client, quoteId, attempt, authRevision, refresh, lease, alive: false, serial: 0,
      controller: null, ready: null, status: lease ? 'loading' : 'unauthenticated' }
  }
  const load = active.current!

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      // Subscription bootstrap is not a new session. Fresh getUser still runs
      // for each load; treating INITIAL_SESSION as a change would loop forever.
      if (event === 'INITIAL_SESSION' || active.current?.client !== client) return
      const current = active.current
      if (event === 'SIGNED_OUT' || (session?.user && session.user.id !== current.lease?.owner)) concealed.current = true
      current.ready = null; current.status = 'stale'; current.controller?.abort()
      setAuthRevision(value => value + 1)
    })
    return () => subscription.unsubscribe()
  }, [client])

  useEffect(() => {
    if (active.current !== load) return
    load.alive = true
    const serial = ++load.serial
    const controller = new AbortController()
    load.controller = controller; load.ready = null
    const bound = load.lease
    load.status = bound ? 'loading' : 'unauthenticated'
    if (bound && isCurrentLease(bound)) {
      void loadPilotQuoteAuxiliary(client, { quoteId, lease: bound }, controller.signal).then(result => {
        if (active.current !== load || !load.alive || load.serial !== serial || controller.signal.aborted || !isCurrentLease(bound)) return
        load.status = result.code
        load.ready = result.code === 'ready' ? result : null
        if (load.ready) concealed.current = false
        else if (result.code === 'unauthenticated' || result.code === 'stale' || result.code === 'forbidden') concealed.current = true
        render(value => value + 1)
      }, () => {
        if (active.current !== load || !load.alive || load.serial !== serial || controller.signal.aborted || !isCurrentLease(bound)) return
        load.ready = null; load.status = 'unavailable'; render(value => value + 1)
      })
    }
    return () => {
      controller.abort(); load.ready = null; load.alive = false
    }
  }, [client, quoteId, attempt, authRevision, refresh, generation, load])

  const current = useCallback((): Ready | null => {
    const value = active.current
    if (!value || value.client !== client || value.quoteId !== quoteId || value.attempt !== attempt
      || !value.alive || value.controller?.signal.aborted || !isCurrentLease(value.lease)) return null
    const ready = value.ready
    return ready && ready.source.quoteId === quoteId && ready.source.ownerId === value.lease!.owner
      && ready.source.leaseGeneration === value.lease!.gen ? ready : null
  }, [client, quoteId, attempt])
  const ready = current()
  const context: PilotQuoteAuxiliaryContext = ready ?? {
    code: load.status === 'loading' ? 'loading' : 'unavailable', ownerId: lease?.owner ?? '',
  }
  const reload = useCallback(() => {
    const value = active.current
    if (value) { value.ready = null; value.status = 'loading'; value.controller?.abort() }
    setRefresh(value => value + 1)
  }, [])
  return { context, current, reload, concealed: concealed.current, status: ready ? 'ready' as const : load.status }
}

export type PilotQuoteSaveOwnerEditorProps = Omit<PilotQuoteSaveEditorShellProps, 'context'> & {
  client?: SupabaseClient
  loadAttempt?: number
}

/** Dormant composition: real owner-authenticated auxiliary reads feeding the
 * existing revision-bound editor. No production page imports this component. */
export function PilotQuoteSaveOwnerEditor(props: PilotQuoteSaveOwnerEditorProps) {
  const defaultClient = useMemo(() => props.client ?? createClient(), [props.client])
  const auxiliary = usePilotQuoteAuxiliary(defaultClient, props.quoteId, props.loadAttempt)
  const propsRef = useRef(props); propsRef.current = props
  const guarded = async <T,>(action: () => Promise<T>): Promise<T> => {
    const ready = auxiliary.current()
    if (!ready) throw new Error('Quote data unavailable')
    const result = await action()
    if (auxiliary.current() !== ready) throw new Error('Quote data changed')
    return result
  }
  return <div className="space-y-3">
    <div hidden={auxiliary.concealed} aria-hidden={auxiliary.concealed || undefined}
      ref={node => { if (node) node.inert = auxiliary.concealed }}>
    <PilotQuoteSaveEditorShell quoteId={props.quoteId} context={auxiliary.context}
      loadBaseline={(quoteId, signal) => guarded(() => {
        if (quoteId !== propsRef.current.quoteId) return Promise.reject(new Error('Quote changed'))
        return propsRef.current.loadBaseline(quoteId, signal)
      })}
      write={intent => guarded(() => propsRef.current.write(intent))}
      readReconciliation={pending => guarded(() => propsRef.current.readReconciliation(pending))}
      onClose={() => { if (auxiliary.current()) propsRef.current.onClose?.() }} />
    </div>
    {auxiliary.status !== 'ready' && <p role="status" className="text-sm text-ink-muted">
      {auxiliary.status === 'loading' ? 'Checking your customer and pricing data…'
        : auxiliary.status === 'unauthenticated' ? 'Sign in to verify your quote data. Your existing draft stays in this browser.'
          : auxiliary.status === 'forbidden' ? 'This editor requires a verified business owner.'
            : 'Your customer or pricing data could not be verified. Editing is paused; your current draft is kept.'}
    </p>}
    <button type="button" className="text-sm underline" onClick={auxiliary.reload} disabled={auxiliary.status === 'loading'}>
      Refresh customer and pricing data
    </button>
  </div>
}
