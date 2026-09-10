'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isActiveAutosaveOwner, useAutosaveOwner } from '@/hooks/useAutosaveOwner'
import { isCurrentLease } from '@/lib/clientCache'

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
interface SubmissionDraft<T> extends OwnedDraft<T> { generation: string; serialization: string }
export interface AutosaveSubmission<T> {
  readonly owner: string; readonly ownerGeneration: number; readonly key: string; readonly generation: string
  readonly serialization: string; readonly storedBytes: string; readonly value: T; readonly editRevision: number
}
export interface AutosaveSubmissionOptions<T> {
  generation: string
  hasPending: () => boolean
  validateValue: (value: unknown) => T | null
}

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
  /** Dormant opt-in submission recovery. The caller must use a per-instance
   * owned key. All existing callers retain their ordinary autosave contract. */
  submission?: AutosaveSubmissionOptions<T>
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
  stageSubmission: (value: T) => AutosaveSubmission<T> | null
  clearSubmissionIfCurrent: (stage: AutosaveSubmission<T>, currentValue: T) => boolean
  flushCurrent: (currentValue?: T) => boolean
}

function toMs(v: string | number | null | undefined): number {
  if (v == null) return 0
  if (typeof v === 'number') return v
  const t = Date.parse(v)
  return Number.isNaN(t) ? 0 : t
}

export function useAutosave<T>({
  key, value, enabled = true, debounceMs = 800, baselineUpdatedAt = null, isEmpty, canReplaceDraft = true, ownership, submission,
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
  const transactional = guarded && !!submission
  const writeEpoch = useRef(0)
  const editRevision = useRef(0)
  const lastValue = useRef<string | null>(null)
  const staged = useRef<AutosaveSubmission<T> | null>(null)
  const draftIdentity = useRef<string | null>(null)
  const latest = useRef({ binding, key, target, value, serialized: '', submission, enabled, canReplaceDraft, isEmpty })

  const cancelTimers = () => {
    writeEpoch.current++
    if (timer.current) clearTimeout(timer.current)
    if (statusTimer.current) clearTimeout(statusTimer.current)
    timer.current = null; statusTimer.current = null
  }

  // On mount (per key): surface a restorable draft if one survived AND it's newer than
  // whatever is on the server. A stale draft (older than the record) is dropped silently.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (guarded && !isActiveAutosaveOwner(binding, key)) return
    if (transactional) { pendingDraft.current = false; draftIdentity.current = null; setDraft(null); setSavedAt(null) }
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
        if (transactional) {
          const owned = parsed as SubmissionDraft<T>
          const checked = submission!.validateValue(owned.value)
          if (!checked || owned.generation !== submission!.generation || typeof owned.serialization !== 'string'
            || JSON.stringify(checked) !== owned.serialization || !Number.isFinite(owned.savedAt)
            || !Object.keys(owned).every(k => ['owner','value','savedAt','generation','serialization'].includes(k))) {
            pendingDraft.current = true
            return
          }
        }
        if (parsed && typeof parsed.savedAt === 'number') {
          let protect = false
          if (transactional) { try { protect = submission!.hasPending() } catch { protect = true } }
          if (baselineMs && parsed.savedAt <= baselineMs && !protect) {
            window.localStorage.removeItem(target!)   // server is newer — never offer
          } else if (!isEmpty || !isEmpty(parsed.value)) {
            pendingDraft.current = true
            if (transactional) draftIdentity.current = `${key}:${submission!.generation}`
            setDraft(parsed.value)
            setSavedAt(parsed.savedAt)
          }
        }
      }
    } catch { /* corrupt/unavailable storage — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, guarded, binding, transactional])

  const serialized = (() => { try { return JSON.stringify(value) } catch { return '' } })()
  if (transactional && serialized !== lastValue.current) { lastValue.current = serialized; editRevision.current++ }
  latest.current = { binding, key, target, value, serialized, submission, enabled, canReplaceDraft, isEmpty }

  // Debounced write while editing. Skips the pristine/empty form, and the first render
  // (the baseline) so merely opening a form never creates a draft.
  useEffect(() => {
    if (typeof window === 'undefined' || !enabled) return
    if (guarded && !isActiveAutosaveOwner(binding, key)) return
    if (mountSerialized.current === null) { mountSerialized.current = serialized; return }
    if (serialized === mountSerialized.current && (!transactional || !staged.current)) return
    // Automatic fills are not permission to discard an owner's recoverable work.
    if (pendingDraft.current && !canReplaceDraft) return
    pendingDraft.current = false
    // The user is actively editing → their input is now the newest data. Stop offering
    // an older restore prompt so restoring can't clobber what they just typed.
    if (draft !== null) setDraft(null)
    if (isEmpty && isEmpty(value)) return

    setStatus('saving')
    if (timer.current) clearTimeout(timer.current)
    const epoch = writeEpoch.current
    timer.current = setTimeout(() => {
      if (guarded && !isActiveAutosaveOwner(binding, key)) return
      if (transactional && epoch !== writeEpoch.current) return
      try {
        const now = Date.now()
        const checked = transactional ? submission!.validateValue(value) : value
        if (transactional && !checked) { setStatus('idle'); return }
        const stored: StoredDraft<T> | OwnedDraft<T> | SubmissionDraft<T> = transactional
          ? { owner: binding!.lease.owner, value: checked!, savedAt: now, generation: submission!.generation, serialization: serialized }
          : guarded
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
  }, [serialized, enabled, canReplaceDraft, guarded, binding, accessible, transactional])

  const flushCurrent = useCallback((currentValue?: T): boolean => {
    const state = latest.current
    if (!state.submission || !guarded || !state.enabled || !isActiveAutosaveOwner(state.binding, state.key)) return false
    cancelTimers()
    try {
      const checked = state.submission.validateValue(currentValue ?? state.value)
      if (!checked) return false
      const bytes = JSON.stringify(checked)
      // A newer edit may return to the pre-Save baseline while the submitted
      // version is committing. Explicit completion/exit flushes must persist it.
      if (bytes === mountSerialized.current && !staged.current) return true
      if (pendingDraft.current && !state.canReplaceDraft) return false
      const stored = JSON.stringify({ owner: state.binding.lease.owner, value: checked, savedAt: Date.now(), generation: state.submission.generation, serialization: bytes })
      window.localStorage.setItem(state.target!, stored)
      return window.localStorage.getItem(state.target!) === stored
    } catch { return false }
    // Refs intentionally supply the latest value and lease at an exit boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guarded])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    if (statusTimer.current) clearTimeout(statusTimer.current)
    const state = latest.current
    if (state.submission && guarded && state.enabled && state.binding?.editorKey === state.key && isCurrentLease(state.binding.lease)) {
      // useAutosaveOwner's earlier cleanup can already mark active=false here.
      // Only this unmount path uses the still-current captured lease directly.
      // Ordinary stale callbacks continue to require the active binding.
      writeEpoch.current++
      try {
        const checked = state.submission.validateValue(state.value)
        const bytes = checked && JSON.stringify(checked)
        if (checked && (bytes !== mountSerialized.current || staged.current) && (!pendingDraft.current || state.canReplaceDraft)) {
          window.localStorage.setItem(state.target!, JSON.stringify({ owner: state.binding.lease.owner, value: checked,
            savedAt: Date.now(), generation: state.submission.generation, serialization: bytes }))
        }
      } catch { /* no durability claim if storage becomes unavailable */ }
    }
    // Existing cleanup stays one mount lifecycle; latest holds opt-in state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stageSubmission = useCallback((submitted: T): AutosaveSubmission<T> | null => {
    const state = latest.current
    if (!state.submission || !guarded || !state.enabled || !isActiveAutosaveOwner(state.binding, state.key)) return null
    cancelTimers()
    try {
      const checked = state.submission.validateValue(submitted)
      if (!checked) return null
      const bytes = JSON.stringify(checked)
      if (bytes !== state.serialized) return null
      const stored = JSON.stringify({ owner: state.binding.lease.owner, value: checked, savedAt: Date.now(), generation: state.submission.generation, serialization: bytes })
      window.localStorage.setItem(state.target!, stored)
      if (window.localStorage.getItem(state.target!) !== stored || !isActiveAutosaveOwner(state.binding, state.key)) return null
      const token: AutosaveSubmission<T> = { owner: state.binding.lease.owner, ownerGeneration: state.binding.lease.gen,
        key: state.key, generation: state.submission.generation, serialization: bytes, storedBytes: stored,
        value: checked, editRevision: editRevision.current }
      staged.current = token
      pendingDraft.current = false
      return token
    } catch { return null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guarded])

  const clearSubmissionIfCurrent = useCallback((token: AutosaveSubmission<T>, currentValue: T): boolean => {
    const state = latest.current
    if (!state.submission || !guarded || staged.current !== token || !isActiveAutosaveOwner(state.binding, state.key)
      || state.binding.lease.owner !== token.owner || state.binding.lease.gen !== token.ownerGeneration
      || state.key !== token.key || state.submission.generation !== token.generation || editRevision.current !== token.editRevision) return false
    try {
      const checked = state.submission.validateValue(currentValue)
      if (!checked || JSON.stringify(checked) !== token.serialization || state.serialized !== token.serialization
        || window.localStorage.getItem(state.target!) !== token.storedBytes) return false
      cancelTimers()
      window.localStorage.removeItem(state.target!)
      if (window.localStorage.getItem(state.target!) !== null) return false
      // A completion rerender/unmount cannot schedule the just-cleared value.
      mountSerialized.current = token.serialization
      staged.current = null; pendingDraft.current = false
      setDraft(null); setSavedAt(null); setStatus('idle')
      return true
    } catch { return false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guarded])

  const clear = useCallback(() => {
    if (guarded && !isActiveAutosaveOwner(binding, key)) return
    if (guarded) {
      if (timer.current) clearTimeout(timer.current)
      if (statusTimer.current) clearTimeout(statusTimer.current)
    }
    if (transactional) { writeEpoch.current++; staged.current = null; mountSerialized.current = latest.current.serialized }
    pendingDraft.current = false
    if (typeof window !== 'undefined') { try { window.localStorage.removeItem(target!) } catch { /* ignore */ } }
    setDraft(null); setSavedAt(null); setStatus('idle')
  }, [key, guarded, binding, target, transactional])

  const restore = useCallback((): T | null => {
    if (guarded && !isActiveAutosaveOwner(binding, key)) return null
    if (transactional && draftIdentity.current !== `${key}:${submission!.generation}`) return null
    const v = draft
    pendingDraft.current = false
    setDraft(null)
    // Keep the stored copy until the next save cycle — the form now holds it anyway.
    return v
  }, [draft, guarded, binding, key, transactional, submission])

  const discard = useCallback(() => { clear() }, [clear])

  const visibleDraft = accessible && (!transactional || draftIdentity.current === `${key}:${submission!.generation}`)
  return { status: accessible ? status : 'idle', savedAt: visibleDraft ? savedAt : null,
    draft: visibleDraft ? draft : null, restore, discard, clear, stageSubmission, clearSubmissionIfCurrent, flushCurrent }
}
