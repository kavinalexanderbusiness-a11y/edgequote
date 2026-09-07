'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isActiveAutosaveOwner, useAutosaveOwner } from '@/hooks/useAutosaveOwner'

// ── Shared autosave engine ───────────────────────────────────────────────────
// ONE hook every long-form editor (quotes, invoices, customers, jobs, notes,
// marketing/AI-Vision drafts, settings…) adopts to never lose work. Debounced
// localStorage drafts that survive refresh / crash / accidental close, restore on
// reopen, clear on successful save, and never clobber data that's newer on the
// server. Pure client-side — no schema, no network.

const PREFIX = 'eq:autosave:'
const storeKey = (key: string) => `${PREFIX}${key}`

export type AutosaveStatus = 'idle' | 'saving' | 'saved'

interface StoredDraft<T> { value: T; savedAt: number }
interface OwnedDraft<T> extends StoredDraft<T> { owner: string }

export interface UseAutosaveOptions<T> {
  /** Stable per-editor key, e.g. `quote:new`, `customer:${id}`, `job:${id}:notes`. */
  key: string
  /** The current (controlled) form value. */
  value: T
  /** Pause saving while false (e.g. before the form is ready). Default true. */
  enabled?: boolean
  /** Idle delay before a draft is written. Default 800ms — saves feel ambient, not janky. */
  debounceMs?: number
  /** The server record's updated_at (ISO or ms). A draft older than this is treated as
   *  stale and never offered — so autosave can't overwrite newer saved data. */
  baselineUpdatedAt?: string | number | null
  /** Treat the value as nothing-to-save (don't persist an empty/pristine form). */
  isEmpty?: (value: T) => boolean
  /** Whether deliberate editing may replace a recovered draft. Default true for
   *  existing callers; forms with passive initialization must signal edit intent. */
  canReplaceDraft?: boolean
  /** Opt in only for forms bound to the verified dashboard owner. An unresolved
   *  owner disables recovery and storage; it never falls back to a legacy key. */
  ownership?: 'verified-owner'
}

export interface UseAutosaveResult<T> {
  status: AutosaveStatus
  savedAt: number | null
  /** A restorable draft found on reopen (newer than the server baseline), else null. */
  draft: T | null
  /** Apply + dismiss the restorable draft. Returns its value so the caller can reset the form. */
  restore: () => T | null
  /** Throw away the stored draft and dismiss the restore prompt. */
  discard: () => void
  /** Clear the draft after a successful save/submit (no prompt). */
  clear: () => void
}

function toMs(v: string | number | null | undefined): number {
  if (v == null) return 0
  if (typeof v === 'number') return v
  const t = Date.parse(v)
  return Number.isNaN(t) ? 0 : t
}

export function useAutosave<T>({
  key, value, enabled = true, debounceMs = 800, baselineUpdatedAt = null, isEmpty, canReplaceDraft = true, ownership,
}: UseAutosaveOptions<T>): UseAutosaveResult<T> {
  const guarded = ownership === 'verified-owner'
  const binding = useAutosaveOwner(guarded, key)
  const accessible = !guarded || isActiveAutosaveOwner(binding, key)
  const target = guarded ? binding?.storageKey : storeKey(key)
  const [status, setStatus] = useState<AutosaveStatus>('idle')
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [draft, setDraft] = useState<T | null>(null)

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountSerialized = useRef<string | null>(null)
  // Storage is read in an effect. Protect it immediately, before setDraft's
  // rerender, so another mount-time effect cannot schedule an older snapshot.
  const pendingDraft = useRef(false)
  const baselineMs = toMs(baselineUpdatedAt)

  // On mount (per key): surface a restorable draft if one survived AND it's newer than
  // whatever is on the server. A stale draft (older than the record) is dropped silently.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (guarded && !isActiveAutosaveOwner(binding, key)) return
    try {
      const raw = window.localStorage.getItem(target!)
      if (raw) {
        const parsed = JSON.parse(raw) as OwnedDraft<T>
        if (guarded && parsed?.owner !== binding!.lease.owner) {
          // Unprovable ownership is never recovery content. Passive fills are
          // also not permission to replace it; only a deliberate new edit is.
          pendingDraft.current = true
          return
        }
        if (parsed && typeof parsed.savedAt === 'number') {
          if (baselineMs && parsed.savedAt <= baselineMs) {
            window.localStorage.removeItem(target!)   // server is newer — never offer
          } else if (!isEmpty || !isEmpty(parsed.value)) {
            pendingDraft.current = true
            setDraft(parsed.value)
            setSavedAt(parsed.savedAt)
          }
        }
      }
    } catch { /* corrupt/unavailable storage — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, guarded, binding])

  const serialized = (() => { try { return JSON.stringify(value) } catch { return '' } })()

  // Debounced write while editing. Skips the pristine/empty form, and the first render
  // (the baseline) so merely opening a form never creates a draft.
  useEffect(() => {
    if (typeof window === 'undefined' || !enabled) return
    if (guarded && !isActiveAutosaveOwner(binding, key)) return
    if (mountSerialized.current === null) { mountSerialized.current = serialized; return }
    if (serialized === mountSerialized.current) return     // unchanged from baseline
    // Automatic fills are not permission to discard an owner's recoverable work.
    if (pendingDraft.current && !canReplaceDraft) return
    pendingDraft.current = false
    // The user is actively editing → their input is now the newest data. Stop offering
    // an older restore prompt so restoring can't clobber what they just typed.
    if (draft !== null) setDraft(null)
    if (isEmpty && isEmpty(value)) return

    setStatus('saving')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (guarded && !isActiveAutosaveOwner(binding, key)) return
      try {
        const now = Date.now()
        const stored: StoredDraft<T> | OwnedDraft<T> = guarded
          ? { owner: binding!.lease.owner, value, savedAt: now }
          : { value, savedAt: now }
        window.localStorage.setItem(target!, JSON.stringify(stored))
        setSavedAt(now)
        setStatus('saved')
        if (statusTimer.current) clearTimeout(statusTimer.current)
        statusTimer.current = setTimeout(() => {
          if (!guarded || isActiveAutosaveOwner(binding, key)) setStatus('idle')
        }, 2500)
      } catch { setStatus('idle') }
    }, debounceMs)
    return () => { if (timer.current) clearTimeout(timer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized, enabled, canReplaceDraft, guarded, binding, accessible])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    if (statusTimer.current) clearTimeout(statusTimer.current)
  }, [])

  const clear = useCallback(() => {
    if (guarded && !isActiveAutosaveOwner(binding, key)) return
    if (guarded) {
      if (timer.current) clearTimeout(timer.current)
      if (statusTimer.current) clearTimeout(statusTimer.current)
    }
    pendingDraft.current = false
    if (typeof window !== 'undefined') { try { window.localStorage.removeItem(target!) } catch { /* ignore */ } }
    setDraft(null); setSavedAt(null); setStatus('idle')
  }, [key, guarded, binding, target])

  const restore = useCallback((): T | null => {
    if (guarded && !isActiveAutosaveOwner(binding, key)) return null
    const v = draft
    pendingDraft.current = false
    setDraft(null)
    // Keep the stored copy until the next save cycle — the form now holds it anyway.
    return v
  }, [draft, guarded, binding, key])

  const discard = useCallback(() => { clear() }, [clear])

  return { status: accessible ? status : 'idle', savedAt: accessible ? savedAt : null,
    draft: accessible ? draft : null, restore, discard, clear }
}
