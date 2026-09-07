'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  cacheLease, getCacheGeneration, isCurrentLease, subscribeCacheOwner, type CacheLease,
} from '@/lib/clientCache'

export interface AutosaveOwner {
  readonly lease: CacheLease
  readonly editorKey: string
  readonly storageKey: string
  active: boolean
}

const noSubscription = () => () => {}
const noGeneration = () => 0

/** A mounted form cannot acquire a different account's identity. A new page may
 *  bind again; a stale callback from the old page must remain invalid forever. */
export function isActiveAutosaveOwner(binding: AutosaveOwner | null, key: string): binding is AutosaveOwner {
  return !!binding && binding.active && binding.editorKey === key && isCurrentLease(binding.lease)
}

export function useAutosaveOwner(guarded: boolean, key: string): AutosaveOwner | null {
  // The primitive generation is stable between transitions. cacheLease() itself
  // returns a new object, so it cannot be a useSyncExternalStore snapshot.
  useSyncExternalStore(
    guarded ? subscribeCacheOwner : noSubscription,
    guarded ? getCacheGeneration : noGeneration,
    noGeneration,
  )
  const originatingOwner = useRef<string | null | undefined>(undefined)
  const [binding, setBinding] = useState<AutosaveOwner | null>(null)

  useEffect(() => {
    if (!guarded) return
    const lease = cacheLease()
    if (originatingOwner.current === undefined) originatingOwner.current = lease?.owner ?? null
    // Unknown ownership stays dormant. In particular, a later B must never
    // acquire form values that were already present before B was verified.
    const next = lease && lease.owner === originatingOwner.current ? {
      lease,
      editorKey: key,
      storageKey: `eq:autosave:owner:${encodeURIComponent(lease.owner)}:${key}`,
      active: true,
    } : null
    setBinding(next)
    // StrictMode may replay this setup for the SAME originating owner. Each
    // setup gets its own token; old timers/handlers cannot borrow the new lease.
    return () => { if (next) next.active = false }
  }, [guarded, key])

  return binding
}
