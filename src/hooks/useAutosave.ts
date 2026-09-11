'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isActiveAutosaveOwner, useAutosaveOwner } from '@/hooks/useAutosaveOwner'
import { isCurrentLease } from '@/lib/clientCache'
import {
  acceptAutosaveSubmissionAdoption, buildAutosaveSubmissionDraft, readAutosaveSubmissionDraft,
  validateAutosaveSubmissionValue, validAutosaveDraftBinding,
  type AutosaveBaseline, type AutosaveDraftBinding, type AutosaveSubmissionAdoption,
} from '@/lib/autosaveSubmission'

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
export interface AutosaveSubmission<T> {
  readonly owner: string; readonly ownerGeneration: number; readonly key: string; readonly generation: string
  readonly recordId: string; readonly originalRevision: string
  readonly serialization: string; readonly storedBytes: string; readonly value: T; readonly editRevision: number
}
export interface AutosaveSubmissionOptions<T> {
  generation: string
  baseline: AutosaveBaseline
  adoption?: AutosaveSubmissionAdoption
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
  flushCurrent: (currentValue?: T, options?: { force?: boolean }) => boolean
  /** A bound editor must gate editing and Save until ready. Refused never means empty. */
  submissionState: 'pending' | 'ready' | 'refused'
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
  const wasTransactional = useRef(transactional).current
  const submissionIdentity = `${key}:${submission?.generation}:${submission?.baseline?.recordId}:${submission?.baseline?.originalRevision}`
  const initialSubmissionIdentity = useRef(submissionIdentity).current
  const stableSubmission = transactional === wasTransactional && (!wasTransactional || submissionIdentity === initialSubmissionIdentity)
  const [submissionState, setSubmissionState] = useState<'pending' | 'ready' | 'refused'>(transactional ? 'pending' : 'ready')
  const gate = useRef<'pending' | 'ready' | 'refused'>(transactional ? 'pending' : 'ready')
  const adoptionConsumer = useRef({})
  const observedBytes = useRef<string | null | undefined>(undefined)
  const offeredAtSerialization = useRef<string | null>(null)
  const writeEpoch = useRef(0)
  const editRevision = useRef(0)
  const lastValue = useRef<string | null>(null)
  const staged = useRef<AutosaveSubmission<T> | null>(null)
  const draftIdentity = useRef<string | null>(null)
  const latest = useRef({ binding, key, target, value, serialized: '', submission, enabled, canReplaceDraft, isEmpty })

  const draftBinding = (owner: string, options: AutosaveSubmissionOptions<T> | undefined): AutosaveDraftBinding => ({
    owner, generation: options?.generation ?? '', recordId: options?.baseline?.recordId ?? '', originalRevision: options?.baseline?.originalRevision ?? '',
  })
  const refuse = () => { gate.current = 'refused'; setSubmissionState('refused') }
  const ready = () => {
    const state = latest.current
    return wasTransactional && !!state.submission && gate.current === 'ready'
      && `${state.key}:${state.submission.generation}:${state.submission.baseline?.recordId}:${state.submission.baseline?.originalRevision}` === initialSubmissionIdentity
  }
  // Every write/removal checks the bound envelope and the exact bytes last
  // observed by THIS hook. Unknown, foreign, unbound or changed slots stay intact.
  const canWriteBound = (unmount = false): boolean => {
    const state = latest.current
    if (!state.submission || !state.binding || !ready() || !(unmount
      ? state.binding?.editorKey === state.key && isCurrentLease(state.binding.lease)
      : isActiveAutosaveOwner(state.binding, state.key))) return false
    try {
      const found = readAutosaveSubmissionDraft(window.localStorage, state.target!, draftBinding(state.binding.lease.owner, state.submission), state.submission.validateValue)
      if (found.state === 'unavailable') return false
      if (found.state === 'protected' || found.storedBytes !== observedBytes.current) { refuse(); return false }
      return true
    } catch { return false }
  }
  const writeBound = (currentValue: T, unmount = false): { serialization: string; storedBytes: string; value: T } | null => {
    const state = latest.current
    if (!canWriteBound(unmount) || !state.binding || !state.submission) return null
    const result = buildAutosaveSubmissionDraft(currentValue, draftBinding(state.binding.lease.owner, state.submission), state.submission.validateValue)
    if (!result) return null
    try {
      if (!canWriteBound(unmount)) return null
      window.localStorage.setItem(state.target!, result.storedBytes)
      const actual = window.localStorage.getItem(state.target!)
      if (actual !== result.storedBytes) {
        if (actual !== observedBytes.current) refuse()
        return null
      }
      if (!(unmount ? isCurrentLease(state.binding.lease) : isActiveAutosaveOwner(state.binding, state.key))) return null
      observedBytes.current = result.storedBytes
      return { serialization: result.draft.serialization, storedBytes: result.storedBytes, value: result.draft.value }
    } catch { return null }
  }

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
    if (wasTransactional && !stableSubmission) { refuse(); return }
    if (transactional) {
      if (gate.current === 'refused') return
      try {
      pendingDraft.current = false; draftIdentity.current = null; setDraft(null); setSavedAt(null)
      const expected = draftBinding(binding!.lease.owner, submission)
      if (!validAutosaveDraftBinding(expected)) { refuse(); return }
      const found = readAutosaveSubmissionDraft(window.localStorage, target!, expected, submission!.validateValue)
      if (found.state === 'protected' || found.state === 'unavailable') { pendingDraft.current = true; refuse(); return }
      // Replaying an accepted setup cannot acquire different storage bytes.
      // The same hook's own writes update observedBytes at their readback.
      if (gate.current === 'ready' && found.storedBytes !== observedBytes.current) { pendingDraft.current = true; refuse(); return }
      if (submission!.adoption && !acceptAutosaveSubmissionAdoption(submission!.adoption, adoptionConsumer.current,
        window.localStorage, target!, expected, latest.current.serialized, submission!.validateValue)) { pendingDraft.current = true; refuse(); return }
      observedBytes.current = found.storedBytes
      gate.current = 'ready'; setSubmissionState('ready')
      if (found.state === 'valid' && !submission!.adoption) {
        pendingDraft.current = true; draftIdentity.current = submissionIdentity
        offeredAtSerialization.current = latest.current.serialized
        setDraft(found.draft.value); setSavedAt(found.draft.savedAt)
      }
      // Original revision, not timestamp order, governs bound pilot recovery.
      // No stale/legacy/corrupt draft is ever automatically deleted here.
      } catch { pendingDraft.current = true; refuse() }
      return
    }
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
  }, [key, guarded, binding, transactional, submissionIdentity, stableSubmission])

  const serialized = (() => { try { return JSON.stringify(value) } catch { return '' } })()
  if (transactional && serialized !== lastValue.current) { lastValue.current = serialized; editRevision.current++ }
  latest.current = { binding, key, target, value, serialized, submission, enabled, canReplaceDraft, isEmpty }

  // Debounced write while editing. Skips the pristine/empty form, and the first render
  // (the baseline) so merely opening a form never creates a draft.
  useEffect(() => {
    if (typeof window === 'undefined' || !enabled) return
    if (guarded && !isActiveAutosaveOwner(binding, key)) return
    if (wasTransactional && (!transactional || !ready())) return
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
        if (transactional) {
          if (!writeBound(value)) { setStatus('idle'); return }
        } else {
          const stored: StoredDraft<T> | OwnedDraft<T> = guarded
          ? { owner: binding!.lease.owner, value, savedAt: now }
          : { value, savedAt: now }
          window.localStorage.setItem(target!, JSON.stringify(stored))
        }
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
  }, [serialized, enabled, canReplaceDraft, guarded, binding, accessible, transactional, submissionState, stableSubmission])

  const flushCurrent = useCallback((currentValue?: T, options?: { force?: boolean }): boolean => {
    const state = latest.current
    if (!state.submission || !guarded || !state.enabled || !isActiveAutosaveOwner(state.binding, state.key) || !ready()) return false
    cancelTimers()
    try {
      const checked = validateAutosaveSubmissionValue(currentValue ?? state.value, state.submission.validateValue)
      if (!checked) return false
      const bytes = checked.serialization
      // A newer edit may return to the pre-Save baseline while the submitted
      // version is committing. Explicit completion/exit flushes must persist it.
      if (!canWriteBound()) return false
      if (bytes === mountSerialized.current && !staged.current && !options?.force) return true
      if (pendingDraft.current && !state.canReplaceDraft) return false
      return writeBound(checked.value) !== null
    } catch { return false }
    // Refs intentionally supply the latest value and lease at an exit boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guarded, stableSubmission])

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
        const checked = validateAutosaveSubmissionValue(state.value, state.submission.validateValue)
        const bytes = checked?.serialization
        if (checked && (bytes !== mountSerialized.current || staged.current) && (!pendingDraft.current || state.canReplaceDraft)) {
          writeBound(checked.value, true)
        }
      } catch { /* no durability claim if storage becomes unavailable */ }
    }
    // Existing cleanup stays one mount lifecycle; latest holds opt-in state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stageSubmission = useCallback((submitted: T): AutosaveSubmission<T> | null => {
    const state = latest.current
    if (!state.submission || !guarded || !state.enabled || !isActiveAutosaveOwner(state.binding, state.key) || !ready()) return null
    cancelTimers()
    try {
      const checked = validateAutosaveSubmissionValue(submitted, state.submission.validateValue)
      if (!checked) return null
      const bytes = checked.serialization
      if (bytes !== state.serialized) return null
      if (pendingDraft.current && !state.canReplaceDraft) return null
      const written = writeBound(checked.value)
      if (!written) return null
      const token: AutosaveSubmission<T> = { owner: state.binding.lease.owner, ownerGeneration: state.binding.lease.gen,
        key: state.key, generation: state.submission.generation, serialization: bytes, storedBytes: written.storedBytes,
        recordId: state.submission.baseline.recordId, originalRevision: state.submission.baseline.originalRevision,
        value: checked.value, editRevision: editRevision.current }
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
      || state.key !== token.key || state.submission.generation !== token.generation || editRevision.current !== token.editRevision
      || state.submission.baseline.recordId !== token.recordId || state.submission.baseline.originalRevision !== token.originalRevision || !ready()) return false
    try {
      const checked = validateAutosaveSubmissionValue(currentValue, state.submission.validateValue)
      if (!checked || checked.serialization !== token.serialization || state.serialized !== token.serialization
        || window.localStorage.getItem(state.target!) !== token.storedBytes || !canWriteBound()) return false
      cancelTimers()
      window.localStorage.removeItem(state.target!)
      if (window.localStorage.getItem(state.target!) !== null) return false
      observedBytes.current = null
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
    if (wasTransactional && (!transactional || !canWriteBound())) return
    if (guarded) {
      if (timer.current) clearTimeout(timer.current)
      if (statusTimer.current) clearTimeout(statusTimer.current)
    }
    if (transactional) { writeEpoch.current++; staged.current = null; mountSerialized.current = latest.current.serialized }
    pendingDraft.current = false
    if (typeof window !== 'undefined') { try {
      window.localStorage.removeItem(target!)
      if (transactional) {
        if (window.localStorage.getItem(target!) !== null) { refuse(); return }
        observedBytes.current = null
      }
    } catch { if (transactional) { refuse(); return } } }
    setDraft(null); setSavedAt(null); setStatus('idle')
    // Bound checks use latest refs; the originating mode is immutable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, guarded, binding, target, transactional])

  const restore = useCallback((): T | null => {
    if (guarded && !isActiveAutosaveOwner(binding, key)) return null
    if (wasTransactional && (!transactional || !ready() || draftIdentity.current !== submissionIdentity
      || offeredAtSerialization.current !== latest.current.serialized || !canWriteBound())) return null
    const v = draft
    if (transactional) cancelTimers()
    pendingDraft.current = false
    setDraft(null)
    // Keep the stored copy until the next save cycle — the form now holds it anyway.
    return v
    // Bound checks use latest refs; no captured form value grants restore authority.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, guarded, binding, key, transactional, submissionIdentity])

  const discard = useCallback(() => { clear() }, [clear])

  const visibleDraft = accessible && (!wasTransactional || (stableSubmission && ready() && draftIdentity.current === submissionIdentity))
  return { status: accessible ? status : 'idle', savedAt: visibleDraft ? savedAt : null,
    draft: visibleDraft ? draft : null, restore, discard, clear, stageSubmission, clearSubmissionIfCurrent, flushCurrent,
    submissionState: !wasTransactional && !transactional ? 'ready' : !stableSubmission ? 'refused' : !accessible ? 'pending' : submissionState }
}
