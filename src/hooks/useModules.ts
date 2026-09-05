'use client'

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  FEATURE_MODULES, visibleModules, installedKeys, normalizeEnabled,
  installSet, uninstallSet, uninstallBlockers, stampMeta, readMeta,
  dependencyClosure, moduleByKey, type ModuleMetaMap,
} from '@/lib/modules'

// ── ONE loader for per-business module composition ────────────────────────────
// Reads business_settings.enabled_modules + module_meta and exposes the
// registry filtered by them, plus the install/uninstall workflow. Consumers:
// the sidebar, bottom nav and command palette (navigation — mounted on EVERY
// dashboard page) and the marketplace/settings surfaces (management).
//
// Shared store, same shape as useBusinessData: all consumers read ONE
// module-level snapshot, concurrent mounts dedupe to a single network
// round-trip, and a revisit paints from the last snapshot instantly while a
// background revalidate keeps it honest. Before this, every consumer ran its
// own getSession + business_settings query on every mount — three identical
// round-trips per page load just to draw navigation. The hook's return shape
// is unchanged, so it stays a drop-in for all callers.
//
// The pre-load state is null — "all modules", the same as a NULL column — so
// nothing flickers and nothing is hidden by accident.
//
// Storage semantics (see lib/modules):
//   enabled_modules null = every module, INCLUDING future releases (default)
//   enabled_modules [..] = exactly these non-core keys (core always shows)
//   module_meta          = { key: { v: installedVersion, at: ISO } } — the
//                          update system's memory of what each business has.

interface ModulesSnapshot {
  enabled: unknown
  meta: ModuleMetaMap
  /** The read that produced this snapshot failed, so `enabled` is the fail-open
   *  default rather than this business's actual composition. Navigation is happy
   *  with that — showing everything is the safe guess. A WRITE is not: install /
   *  uninstall both compute the next set FROM the current one, so saving on top
   *  of a guess would quietly re-install every module the owner had turned off. */
  unknown?: boolean
}

let store: ModulesSnapshot | null = null
/** Whose composition `store` describes. `null` = the signed-out fail-open default. */
let storeOwner: string | null = null
/** Who the session says we are, and whether that has been established at all. */
let currentOwner: string | null = null
let ownerKnown = false
// Advances on every owner CHANGE. persist has no in-flight slot to identify
// itself by, so it carries this instead: A -> B -> A moves it twice, which an
// owner comparison alone cannot see.
let ownerEpoch = 0
let inFlight: Promise<void> | null = null
/** The owner `inFlight` was started for — two accounts must never share one load. */
let inFlightOwner: string | null = null
const listeners = new Set<() => void>()

function emit() { for (const l of Array.from(listeners)) l() }
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } }

// ⛔⛔ IDENTITY MUST BE TRUSTWORTHY *AT RENDER TIME*. getSnapshot is synchronous —
// useSyncExternalStore calls it during render — while every way of asking Supabase
// who is signed in is async. So an owner tag on the snapshot alone cannot fix the
// first render after an account switch: the tag says "A" but nothing yet says the
// session is now B. `currentOwner` is therefore kept up to date by an auth
// subscription (below) so the comparison can happen synchronously.
//
// Until identity is established, and whenever it does not match, this serves
// `null` — which is the hook's existing pre-load state: navigation shows every
// module. Fail OPEN for reading is the documented behaviour and is preserved;
// fail CLOSED for writing is enforced in `persist`.
/**
 * THE rule, in one place so the reader and the writer cannot drift apart, and so
 * it can be exercised offline without a renderer. Signed out is `null === null`,
 * which matches and still serves the fail-open default.
 */
export function mayServeOwner(ownerKnown: boolean, snapshotOwner: string | null, sessionOwner: string | null): boolean {
  return ownerKnown && snapshotOwner === sessionOwner
}

function getSnapshot(): ModulesSnapshot | null {
  return mayServeOwner(ownerKnown, storeOwner, currentOwner) ? store : null
}
function getServerSnapshot() { return null }

let authWatch: { unsubscribe: () => void } | null = null
/** One app-lifetime subscription. Supabase emits the current session immediately
 *  on subscribe (INITIAL_SESSION, a local read), so identity is established
 *  without a network round-trip. */
function ensureAuthWatch() {
  if (authWatch) return
  const { data } = createClient().auth.onAuthStateChange((_event, session) => {
    const uid = session?.user?.id ?? null
    const changed = !ownerKnown || uid !== currentOwner
    currentOwner = uid
    ownerKnown = true
    if (changed) ownerEpoch++
    if (!changed) { emit(); return }
    // A switch orphans anything started for the previous account.
    inFlight = null
    inFlightOwner = null
    emit()
    if (uid) void loadModules()
  })
  authWatch = data.subscription
}

// Stale-while-revalidate: every mount calls this, but concurrent callers share
// one round-trip and an existing snapshot keeps serving until fresh data lands.
function loadModules(): Promise<void> {
  // Dedupe PER OWNER: concurrent mounts for one account still share a round-trip,
  // but a load started for A is never handed to B.
  if (inFlight && inFlightOwner === currentOwner) return inFlight
  const startedFor = currentOwner
  // A holder, so the body can compare against its own promise when it settles.
  const self: { p?: Promise<void> } = {}
  self.p = (async () => {
    try {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id ?? null
      if (!ownerKnown || uid !== currentOwner) ownerEpoch++
      currentOwner = uid
      ownerKnown = true
      if (!uid) {
        // Signed out: the fail-open default, owned by nobody — so it matches the
        // session and still serves, exactly as before.
        store = { enabled: null, meta: {} }
        storeOwner = null
        emit()
        return
      }
      const { data, error } = await supabase.from('business_settings').select('enabled_modules, module_meta').eq('user_id', uid).maybeSingle()
      // ⛔ REJECT A LATE COMPLETION. The session can change while this waits; a
      // read issued as A must never land in B's store.
      if (uid !== currentOwner) return
      // ⛔⛔ AND THE OWNER CHECK IS NOT ENOUGH ON ITS OWN. A → B → A inside one
      // page session orphans this read at the switch (`inFlight = null`) without
      // cancelling it, and returning to A starts a second one. When this one
      // finally answers, `uid === currentOwner === A`, so the line above passes
      // and an older read overwrites the newer result. Both are A's own data, so
      // it is staleness rather than a leak — but the owner is shown a
      // composition from before a change they just made.
      //
      // The request's own identity settles it: this load may commit only while it
      // is still THE in-flight one. Same test the `finally` below already uses.
      // Placed before the error branch so a late failure cannot commit either.
      if (inFlight !== self.p) return
      if (error) {
        // Keep serving OUR last good snapshot if we have one; otherwise fail OPEN
        // (every module visible) but remember that we are guessing.
        store = storeOwner === uid && store ? store : { enabled: null, meta: {}, unknown: true }
        storeOwner = uid
        emit()
        return
      }
      const d = data as { enabled_modules: unknown; module_meta: unknown } | null
      store = { enabled: d?.enabled_modules ?? null, meta: readMeta(d?.module_meta) }
      storeOwner = uid
      emit()
    } finally {
      if (inFlight === self.p) { inFlight = null; inFlightOwner = null }
    }
  })()
  inFlight = self.p
  inFlightOwner = startedFor
  return self.p
}

export function useModules() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const enabled = snap?.enabled ?? null
  const meta = snap?.meta ?? {}
  const loaded = snap !== null

  useEffect(() => {
    // Establish identity before anything is served — see getSnapshot.
    ensureAuthWatch()
    loadModules()
    // Every consumer refreshes the moment any of them saves a new composition —
    // same event idiom as before; with the shared store one reload now feeds
    // every consumer at once.
    const onChanged = () => { loadModules() }
    window.addEventListener('eq:modules-changed', onChanged)
    return () => { window.removeEventListener('eq:modules-changed', onChanged) }
  }, [])

  // One writer for both columns — optimistic through the shared store (every
  // consumer sees the change immediately), reverts and reports on failure.
  const persist = useCallback(async (
    nextEnabled: string[] | null,
    nextMeta: ModuleMetaMap,
  ): Promise<string | null> => {
    const prev = store
    const prevOwner = storeOwner
    // Never save on top of a guess — see ModulesSnapshot.unknown.
    if (prev?.unknown) return 'Couldn’t load which features are on, so nothing was changed. Reload and try again.'
    // ⛔⛔ WRITES FAIL CLOSED ON AN UNKNOWN OR MISMATCHED OWNER. install/uninstall
    // compute the next set FROM the current one, so saving while the snapshot on
    // screen belongs to another account — or to nobody yet — would write that
    // account's composition onto this one. Reading may fail open; this may not.
    const owner = currentOwner
    // Captured with the owner: A -> B -> A moves the epoch twice, so a late answer
    // to THIS save cannot be mistaken for the current one just because the same
    // account is signed in again.
    const epoch = ownerEpoch
    if (owner === null || !mayServeOwner(ownerKnown, storeOwner, owner)) {
      return 'Couldn’t confirm which account is signed in, so nothing was changed. Reload and try again.'
    }
    store = { enabled: nextEnabled, meta: nextMeta }
    storeOwner = owner
    emit()
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid || uid !== owner) { store = prev; storeOwner = prevOwner; emit(); return 'Not signed in.' }
    // UPSERT, not update. A bare .update() on a business that has no
    // business_settings row yet matches ZERO rows and returns NO error — so the
    // optimistic store above would keep the new composition, navigation would
    // visibly change, and the toggle would look saved right up until the next
    // reload put it back. Same trap ensureBookingToken documents, and the same
    // fix: key on unique(user_id).
    //
    // ⚠️ This write is why `verify:settings-save` scanning ModuleManager.tsx was
    // not enough — the Modules tab's save does not live in its component.
    const { error } = await supabase.from('business_settings')
      .upsert({ user_id: uid, enabled_modules: nextEnabled, module_meta: nextMeta }, { onConflict: 'user_id' })
    // ⛔ REJECT A LATE COMPLETION. If the account changed while the upsert was in
    // flight, neither its success nor its failure may touch the store now on
    // screen — the row was written for `owner`, not for whoever is here.
    if (currentOwner !== owner || ownerEpoch !== epoch) return error ? error.message : null
    if (error) { store = prev; storeOwner = prevOwner; emit(); return error.message }
    window.dispatchEvent(new Event('eq:modules-changed'))
    return null
  }, [])

  // Install a module: pulls in its dependency closure atomically and stamps
  // each newly-installed module's version. Returns an error message or null.
  const install = useCallback(async (key: string): Promise<string | null> => {
    const current = installedKeys(enabled)
    const next = installSet(current, key)
    const added = next.filter(k => !current.includes(k))
    return persist(normalizeEnabled(next), stampMeta(meta, added.length ? added : [key]))
  }, [enabled, meta, persist])

  // Uninstall a module: refused while installed modules depend on it — the
  // error names them, so the owner knows exactly what to remove first.
  const uninstall = useCallback(async (key: string): Promise<string | null> => {
    const m = moduleByKey(key)
    if (m?.core) return `${m.label} is a core module and can't be removed.`
    const current = installedKeys(enabled)
    const blockers = uninstallBlockers(current, key)
    if (blockers.length) {
      return `${m?.label ?? key} is needed by ${blockers.map(b => b.label).join(', ')} — remove ${blockers.length === 1 ? 'that module' : 'those modules'} first.`
    }
    return persist(normalizeEnabled(uninstallSet(current, key)), meta)
  }, [enabled, meta, persist])

  // Acknowledge a module update (the "Updated" badge) — stamps current version.
  const acknowledgeUpdate = useCallback(async (key: string): Promise<string | null> => {
    return persist(Array.isArray(enabled) ? installedKeys(enabled) : null, stampMeta(meta, [key]))
  }, [enabled, meta, persist])

  return {
    all: FEATURE_MODULES,
    visible: visibleModules(enabled),
    installed: installedKeys(enabled),
    enabled,
    meta,
    loaded,
    install,
    uninstall,
    acknowledgeUpdate,
    /** Preview helper for UIs: what else an install would bring along. */
    wouldInstall: (key: string) => dependencyClosure(key).filter(k => !installedKeys(enabled).includes(k)),
  }
}
