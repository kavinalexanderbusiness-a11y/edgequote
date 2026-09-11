import { isCurrentLease, type CacheLease } from '@/lib/clientCache'

/** Generic, browser-only durable draft binding. No quote schema or wire encoder. */
export interface AutosaveBaseline { recordId: string; originalRevision: string }
export interface AutosaveDraftBinding extends AutosaveBaseline { owner: string; generation: string }
export interface AutosaveSubmissionDraft<T> extends AutosaveDraftBinding {
  version: 2; value: T; serialization: string; savedAt: number
}
export type AutosaveDraftStore = Pick<Storage, 'getItem' | 'setItem'>
export type AutosaveDraftRead<T> =
  | { state: 'absent'; storedBytes: null }
  | { state: 'valid'; draft: AutosaveSubmissionDraft<T>; storedBytes: string }
  | { state: 'protected' }
  | { state: 'unavailable' }
export const AUTOSAVE_VALUE_BYTES = 200_000
export const AUTOSAVE_ENVELOPE_BYTES = 600_000
const opaque = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
const ownerId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && !v.includes('\0')
export const validAutosaveDraftBinding = (v: AutosaveDraftBinding): boolean => !!v && ownerId(v.owner)
  && opaque(v.recordId) && opaque(v.originalRevision) && opaque(v.generation)
const matches = (a: AutosaveDraftBinding, b: AutosaveDraftBinding) => a.owner === b.owner && a.recordId === b.recordId
  && a.originalRevision === b.originalRevision && a.generation === b.generation
export const autosaveSubmissionStorageKey = (owner: string, editorKey: string): string => `eq:autosave:owner:${encodeURIComponent(owner)}:${editorKey}`

function safeJson(value: unknown, cap: number): { value: unknown; serialization: string } | null {
  try {
    const stack = [value], seen = new Set<object>()
    while (stack.length) {
      const v = stack.pop()
      if (v === null || typeof v === 'boolean' || (typeof v === 'string' && !v.includes('\0')) || (typeof v === 'number' && Number.isFinite(v))) continue
      if (!v || typeof v !== 'object') return null
      const prototype = Object.getPrototypeOf(v)
      if (Array.isArray(v) ? prototype !== Array.prototype && prototype !== null
        : prototype !== Object.prototype && prototype !== null) return null
      // Shared references are ordinary JSON values. JSON.stringify below
      // rejects actual cycles without rejecting harmless in-memory aliasing.
      if (seen.has(v)) continue
      seen.add(v)
      if (Object.getOwnPropertySymbols(v).length) return null
      const keys = Object.keys(v)
      if (Array.isArray(v) && (keys.length !== v.length || keys.some((k, i) => k !== String(i)))) return null
      for (const key of Object.getOwnPropertyNames(v)) {
        if (Array.isArray(v) && key === 'length') continue
        const d = Object.getOwnPropertyDescriptor(v, key)
        if (['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key) || !d || !d.enumerable || !Object.hasOwn(d, 'value')) return null
        stack.push(d.value)
      }
    }
    const serialization = JSON.stringify(value)
    if (new TextEncoder().encode(serialization).length > cap) return null
    return { value: JSON.parse(serialization), serialization }
  } catch { return null }
}

/** The injected structural validator may approve, but may not normalize values. */
export function validateAutosaveSubmissionValue<T>(value: unknown, validate: (v: unknown) => T | null): { value: T; serialization: string } | null {
  const safe = safeJson(value, AUTOSAVE_VALUE_BYTES)
  if (!safe) return null
  try {
    const checked = safeJson(validate(safe.value), AUTOSAVE_VALUE_BYTES)
    return checked && checked.value !== null && checked.serialization === safe.serialization
      ? { value: checked.value as T, serialization: safe.serialization } : null
  } catch { return null }
}

export function parseAutosaveSubmissionDraft<T>(raw: string | null, binding: AutosaveDraftBinding,
  validate: (v: unknown) => T | null): AutosaveSubmissionDraft<T> | null {
  if (!validAutosaveDraftBinding(binding) || typeof raw !== 'string' || new TextEncoder().encode(raw).length > AUTOSAVE_ENVELOPE_BYTES) return null
  try {
    const v = JSON.parse(raw)
    const keys = ['version', 'recordId', 'originalRevision', 'owner', 'generation', 'value', 'serialization', 'savedAt']
    if (!v || Array.isArray(v) || Object.keys(v).length !== keys.length || !keys.every(k => Object.hasOwn(v, k))
      || v.version !== 2 || !matches(v, binding) || !Number.isFinite(v.savedAt) || v.savedAt < 0) return null
    const checked = validateAutosaveSubmissionValue(v.value, validate)
    return checked && checked.serialization === v.serialization ? v as AutosaveSubmissionDraft<T> : null
  } catch { return null }
}

export function buildAutosaveSubmissionDraft<T>(value: unknown, binding: AutosaveDraftBinding,
  validate: (v: unknown) => T | null, savedAt = Date.now()): { draft: AutosaveSubmissionDraft<T>; storedBytes: string } | null {
  if (!validAutosaveDraftBinding(binding) || !Number.isFinite(savedAt) || savedAt < 0) return null
  const checked = validateAutosaveSubmissionValue(value, validate)
  if (!checked) return null
  const draft: AutosaveSubmissionDraft<T> = { version: 2, recordId: binding.recordId, originalRevision: binding.originalRevision,
    owner: binding.owner, generation: binding.generation, value: checked.value, serialization: checked.serialization, savedAt }
  const storedBytes = JSON.stringify(draft)
  return new TextEncoder().encode(storedBytes).length <= AUTOSAVE_ENVELOPE_BYTES ? { draft, storedBytes } : null
}

export function readAutosaveSubmissionDraft<T>(store: Pick<Storage, 'getItem'>, key: string, binding: AutosaveDraftBinding,
  validate: (v: unknown) => T | null): AutosaveDraftRead<T> {
  try {
    const raw = store.getItem(key)
    if (raw === null) return { state: 'absent', storedBytes: null }
    const draft = parseAutosaveSubmissionDraft(raw, binding, validate)
    return draft ? { state: 'valid', draft, storedBytes: raw } : { state: 'protected' }
  } catch { return { state: 'unavailable' } }
}

export interface AutosaveAdoptionRecord { readonly key: string; readonly storedBytes: string; readonly binding: Readonly<AutosaveDraftBinding> }
export interface AutosaveSubmissionAdoption {
  readonly lease: Readonly<CacheLease>
  readonly source: AutosaveAdoptionRecord
  readonly destination: AutosaveAdoptionRecord
  readonly serialization: string
}
const adoptions = new WeakMap<AutosaveSubmissionAdoption, { consumer: object | null; refused: boolean }>()
const ownKey = (key: string, owner: string) => key.startsWith(autosaveSubmissionStorageKey(owner, ''))

/** Call only after the wrapper's confirmed fresh-form checkpoint and baseline
 * check. It writes a fresh destination and NEVER changes/removes the source.
 * Failure after writing can leave a protected destination copy, not data loss. */
export function createAutosaveSubmissionAdoption<T>(store: AutosaveDraftStore, args: {
  lease: CacheLease; source: AutosaveAdoptionRecord; destination: { key: string; binding: AutosaveDraftBinding }
}, validate: (v: unknown) => T | null): AutosaveSubmissionAdoption | null {
  const { lease, source, destination } = args
  try {
    if (!isCurrentLease(lease) || !validAutosaveDraftBinding(source.binding) || !validAutosaveDraftBinding(destination.binding)
      || source.binding.owner !== lease.owner || destination.binding.owner !== lease.owner
      || source.binding.recordId !== destination.binding.recordId || source.binding.originalRevision !== destination.binding.originalRevision
      || source.binding.generation === destination.binding.generation || source.key === destination.key
      || !ownKey(source.key, lease.owner) || !ownKey(destination.key, lease.owner)
      || store.getItem(source.key) !== source.storedBytes || store.getItem(destination.key) !== null) return null
    const prior = parseAutosaveSubmissionDraft(source.storedBytes, source.binding, validate)
    const next = prior && buildAutosaveSubmissionDraft(prior.value, destination.binding, validate)
    if (!next || !isCurrentLease(lease) || store.getItem(source.key) !== source.storedBytes || store.getItem(destination.key) !== null) return null
    store.setItem(destination.key, next.storedBytes)
    if (!isCurrentLease(lease) || store.getItem(source.key) !== source.storedBytes || store.getItem(destination.key) !== next.storedBytes) return null
    const token: AutosaveSubmissionAdoption = Object.freeze({ lease: Object.freeze({ ...lease }),
      source: Object.freeze({ ...source, binding: Object.freeze({ ...source.binding }) }),
      destination: Object.freeze({ ...destination, binding: Object.freeze({ ...destination.binding }), storedBytes: next.storedBytes }),
      serialization: next.draft.serialization })
    adoptions.set(token, { consumer: null, refused: false })
    return token
  } catch { return null }
}

/** No reset or storage mutation. The same hook can replay its accepted token;
 * a second hook cannot borrow it. Active owner setup checks remain the hook's. */
export function acceptAutosaveSubmissionAdoption<T>(token: AutosaveSubmissionAdoption, consumer: object,
  store: Pick<Storage, 'getItem'>, key: string, binding: AutosaveDraftBinding, serialization: string,
  validate: (v: unknown) => T | null): boolean {
  const state = adoptions.get(token)
  if (!state || state.refused || (state.consumer && state.consumer !== consumer)) return false
  if (!isCurrentLease(token.lease) || key !== token.destination.key || !matches(binding, token.destination.binding)) { state.refused = true; return false }
  if (state.consumer === consumer) return true // StrictMode replay never reapplies old values.
  try {
    if (serialization !== token.serialization || store.getItem(token.source.key) !== token.source.storedBytes
      || store.getItem(key) !== token.destination.storedBytes
      || !parseAutosaveSubmissionDraft(token.source.storedBytes, token.source.binding, validate)
      || !parseAutosaveSubmissionDraft(token.destination.storedBytes, binding, validate)) { state.refused = true; return false }
    state.consumer = consumer
    return true
  } catch { state.refused = true; return false }
}
