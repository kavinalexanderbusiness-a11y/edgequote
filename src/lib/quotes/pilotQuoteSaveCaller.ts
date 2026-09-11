'use client'

import { cacheLease, isCurrentLease, type CacheLease } from '@/lib/clientCache'
import type { UseAutosaveResult, AutosaveSubmission, AutosaveSubmissionOptions } from '@/hooks/useAutosave'
import type { QuoteFormValues } from '@/types'
import { validatePilotQuoteSaveDraftValues, validatePilotQuoteSaveSubmission, type PilotQuoteSaveIntent } from './pilotQuoteSaveValues'
import { AUTOSAVE_ENVELOPE_BYTES, parseAutosaveSubmissionDraft, type AutosaveSubmissionAdoption, type AutosaveSubmissionDraft } from '@/lib/autosaveSubmission'
import { copyPilotQuoteSaveJson as safeCopy, parsePilotQuoteSaveReceipt, type PendingQuoteSave, type PilotQuoteSaveCommittedReceipt } from './pilotQuoteSaveReceipt'
export { parsePilotQuoteSaveReceipt, type PendingQuoteSave, type PilotQuoteSaveCommittedReceipt } from './pilotQuoteSaveReceipt'

// Dormant browser controller: no endpoint, SDK, automatic replay or server-state
// inference. A reviewed editor supplies transport and schema validators.
type Row = Record<string, unknown>
type Store = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>
type Autosave = UseAutosaveResult<QuoteFormValues>
export type PilotQuoteSaveOutcome =
  | { code: 'blocked'; reason: 'inactive' | 'pending_recovery' | 'recovery_unavailable' | 'invalid_values' }
  | { code: 'unknown'; pending: PendingQuoteSave }
  | { code: 'committed'; pending: PendingQuoteSave; receipt: PilotQuoteSaveCommittedReceipt; stage: AutosaveSubmission<QuoteFormValues> }
export type PilotQuoteSaveReconciliation = { code: 'matching_saved_values' | 'conflict' | 'unknown' }
export type PilotQuoteSaveRecovery = {
  key: string; storedBytes: string
  pending: PendingQuoteSave
  /** A stored direct acknowledgement, never reconstructed from current rows. */
  committed: PilotQuoteSaveCommittedReceipt | null
}
export type PilotQuoteDraftRecovery = {
  key: string; storedBytes: string; draft: AutosaveSubmissionDraft<QuoteFormValues>
}
export type PilotQuoteRecoveryInventory =
  | { code: 'ready'; pending: PilotQuoteSaveRecovery[]; drafts: PilotQuoteDraftRecovery[]; protectedRecords: number }
  | { code: 'unavailable' | 'inactive' }
export type PilotQuoteSaveCallerOptions = {
  quoteId: string; expectedEditorRevision: string
  /** Always fresh per working copy, including an explicit draft continuation. */
  editorGeneration?: string
  adoption?: AutosaveSubmissionAdoption
  validateValues(value: unknown): QuoteFormValues | null
  write(intent: PilotQuoteSaveIntent): Promise<unknown>
  readReconciliation(pending: Readonly<PendingQuoteSave>): Promise<unknown>
  onRecoveryRequested(recovery: PilotQuoteSaveRecovery[]): void
  onCommitted?(receipt: PilotQuoteSaveCommittedReceipt, clearedExactDraft: boolean): void
  storage?: () => Store
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v)
const revision = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)
const row = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Row, keys: string[]) => keys.length === Object.keys(v).length && keys.every(k => Object.hasOwn(v, k))
const pendingKeys = ['version','owner','quoteId','clientOperationId','editorGeneration','originalEditorRevision','submittedValues','submittedSerialization','stagedAt','state']
export class PilotQuoteSaveCaller {
  readonly quoteId: string
  readonly editorGeneration: string
  readonly autosaveKey: string
  readonly submission: AutosaveSubmissionOptions<QuoteFormValues>
  private readonly lease: CacheLease | null
  private readonly prefix: string
  private readonly originalEditorRevision: string
  private busy = false
  private completed = false
  private disposed = false
  private readonly issued = new WeakSet<object>()
  private readonly finalized = new WeakSet<object>()

  constructor(private readonly options: PilotQuoteSaveCallerOptions) {
    if (!uuid(options.quoteId) || !revision(options.expectedEditorRevision)) throw new Error('Invalid quote editor binding')
    this.quoteId = options.quoteId
    this.originalEditorRevision = options.expectedEditorRevision
    this.editorGeneration = options.editorGeneration ?? crypto.randomUUID()
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(this.editorGeneration)) throw new Error('Invalid editor generation')
    this.lease = cacheLease()
    this.autosaveKey = `quote:${this.quoteId}:pilot:${this.editorGeneration}`
    this.prefix = `eq:quote-save:pending:${encodeURIComponent(this.lease?.owner ?? '')}:${this.quoteId}:`
    this.submission = { generation: this.editorGeneration,
      baseline: { recordId: this.quoteId, originalRevision: this.originalEditorRevision },
      adoption: options.adoption,
      hasPending: () => this.hasPending(), validateValue: v => this.values(v) }
  }

  active(): boolean { return !this.disposed && !!this.lease && isCurrentLease(this.lease) }
  /** Call on terminal editor close. StrictMode effect replay must not dispose a shared controller. */
  dispose(): void { this.disposed = true }
  private store(): Store { if (!this.active()) throw new Error('Inactive editor'); return this.options.storage?.() ?? window.localStorage }
  private values(v: unknown): QuoteFormValues | null {
    const safe = validatePilotQuoteSaveDraftValues(v)
    if (!safe) return null
    try {
      const checked = validatePilotQuoteSaveDraftValues(this.options.validateValues(safe))
      return checked && JSON.stringify(checked) === JSON.stringify(safe) ? checked : null
    } catch { return null }
  }
  private key(p: PendingQuoteSave): string { return `${this.prefix}${p.clientOperationId}` }
  private resultKey(p: PendingQuoteSave): string { return this.key(p).replace('eq:quote-save:pending:', 'eq:quote-save:committed:') }
  private receipt(input: unknown, p: PendingQuoteSave): PilotQuoteSaveCommittedReceipt | null {
    return parsePilotQuoteSaveReceipt(input, p)
  }
  private pending(input: string | null, key: string): PendingQuoteSave | null {
    if (!input || new TextEncoder().encode(input).length > AUTOSAVE_ENVELOPE_BYTES) return null
    try {
      const p: unknown = JSON.parse(input)
      if (!row(p) || !exact(p, pendingKeys) || p.version !== 1 || p.owner !== this.lease?.owner || p.quoteId !== this.quoteId
        || !uuid(p.clientOperationId) || `${this.prefix}${p.clientOperationId}` !== key || !revision(p.originalEditorRevision)
        || typeof p.editorGeneration !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(p.editorGeneration)
        || typeof p.stagedAt !== 'number' || !Number.isFinite(p.stagedAt) || !['pending','unknown'].includes(String(p.state))) return null
      const values = this.values(p.submittedValues)
      return values && JSON.stringify(values) === p.submittedSerialization ? p as unknown as PendingQuoteSave : null
    } catch { return null }
  }
  hasPending(): boolean {
    if (!this.active()) return false
    try {
      const store = this.store()
      // Namespace existence protects recovery even if a record is corrupt. Its
      // payload is never displayed, and another operation is never overwritten.
      for (let i = 0; i < store.length; i++) if (store.key(i)?.startsWith(this.prefix)) return true
      return false
    } catch { return true }
  }
  listRecovery(): PilotQuoteSaveRecovery[] {
    if (!this.active()) return []
    try {
      const store = this.store(), result: PilotQuoteSaveRecovery[] = []
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i)
        if (!key?.startsWith(this.prefix)) continue
        const storedBytes = store.getItem(key), p = this.pending(storedBytes, key)
        if (!p || !storedBytes) continue
        let committed = null
        try { committed = this.receipt(JSON.parse(store.getItem(this.resultKey(p)) ?? 'null'), p) } catch { /* absent/unreadable receipt */ }
        result.push({ key, storedBytes, pending: p, committed })
      }
      return this.active() ? result : []
    } catch { return [] }
  }
  /** Explicit owner-only inventory, including drafts left after an acknowledged
   * Save removed its pending record. Unprovable entries stay protected. */
  reviewRecovery(): PilotQuoteRecoveryInventory {
    if (!this.active()) return { code: 'inactive' }
    try {
      const store = this.store(), pending: PilotQuoteSaveRecovery[] = [], drafts: PilotQuoteDraftRecovery[] = []
      const draftPrefix = `eq:autosave:owner:${encodeURIComponent(this.lease!.owner)}:quote:${this.quoteId}:pilot:`
      if (store.length > 10_000) return { code: 'unavailable' }
      let protectedRecords = 0
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i)
        if (!key) continue
        if (key.startsWith(this.prefix)) {
          const storedBytes = store.getItem(key), p = this.pending(storedBytes, key)
          if (!p || !storedBytes) { protectedRecords++; continue }
          let committed = null
          try { committed = this.receipt(JSON.parse(store.getItem(this.resultKey(p)) ?? 'null'), p) } catch { /* no direct receipt */ }
          pending.push({ key, storedBytes, pending: p, committed })
        } else if (key.startsWith(draftPrefix)) {
          const storedBytes = store.getItem(key)
          const generation = key.slice(draftPrefix.length)
          let candidate: unknown = null
          try { candidate = storedBytes && storedBytes.length <= AUTOSAVE_ENVELOPE_BYTES ? JSON.parse(storedBytes) : null } catch { /* protected below */ }
          const originalRevision = row(candidate) ? candidate.originalRevision : null
          const draft = revision(originalRevision) && /^[A-Za-z0-9_-]{1,128}$/.test(generation)
            ? parseAutosaveSubmissionDraft(storedBytes, { owner: this.lease!.owner, generation,
              recordId: this.quoteId, originalRevision }, v => this.values(v)) : null
          if (!draft || !storedBytes) { protectedRecords++; continue }
          drafts.push({ key, storedBytes, draft })
        }
      }
      return this.active() ? { code: 'ready', pending, drafts, protectedRecords } : { code: 'inactive' }
    } catch { return { code: 'unavailable' } }
  }
  matchesDraft(entry: PilotQuoteDraftRecovery): boolean {
    const inventory = this.reviewRecovery()
    return inventory.code === 'ready' && inventory.drafts.some(d => d.key === entry.key && d.storedBytes === entry.storedBytes)
  }
  /** The wrapper confirms one exact local copy. Never remove the active editor. */
  discardDraft(entry: PilotQuoteDraftRecovery): boolean {
    if (!this.active() || this.busy || entry.key.endsWith(`:${this.autosaveKey}`) || !this.matchesDraft(entry)) return false
    try {
      const store = this.store()
      if (store.getItem(entry.key) !== entry.storedBytes) return false
      store.removeItem(entry.key)
      return store.getItem(entry.key) === null
    } catch { return false }
  }
  requestRecovery(): void { if (this.active()) this.options.onRecoveryRequested(this.listRecovery()) }
  async reconcile(pending: PendingQuoteSave): Promise<PilotQuoteSaveReconciliation> {
    if (!this.active()) return { code: 'unknown' }
    try {
      const store = this.store(), actual = this.pending(store.getItem(this.key(pending)), this.key(pending))
      if (!actual || JSON.stringify(actual) !== JSON.stringify(pending)) return { code: 'unknown' }
      const result = await this.options.readReconciliation(safeCopy(actual, AUTOSAVE_ENVELOPE_BYTES)!)
      if (!this.active() || !row(result) || !exact(result, ['code']) || !['matching_saved_values','conflict'].includes(String(result.code))) return { code: 'unknown' }
      // Even matching data is not attributable acknowledgement. No clear,
      // pending removal, write dispatch or changed revision follows this read.
      return result as PilotQuoteSaveReconciliation
    } catch { return { code: 'unknown' } }
  }
  discardRecovery(selection: PilotQuoteSaveRecovery): boolean {
    if (!this.active() || this.busy) return false
    try {
      const p = selection.pending, store = this.store(), key = this.key(p)
      if (selection.key !== key || store.getItem(key) !== selection.storedBytes) return false
      const actual = this.pending(selection.storedBytes, key)
      if (!actual || JSON.stringify(actual) !== JSON.stringify(p)) return false
      store.removeItem(key)
      return store.getItem(key) === null
    } catch { return false }
  }
  async dispatch(values: QuoteFormValues, autosave: Autosave): Promise<PilotQuoteSaveOutcome> {
    if (!this.active() || this.busy || this.completed) return { code: 'blocked', reason: 'inactive' }
    try { this.store().length } catch { return { code: 'blocked', reason: 'recovery_unavailable' } }
    if (this.hasPending()) return { code: 'blocked', reason: 'pending_recovery' }
    const checked = this.values(values)
    if (!checked) return { code: 'blocked', reason: 'invalid_values' }
    const intent: PilotQuoteSaveIntent = { version: 1, quoteId: this.quoteId, expectedEditorRevision: this.originalEditorRevision,
      clientOperationId: crypto.randomUUID(), editorGeneration: this.editorGeneration, values: checked }
    // Canonical semantics run on a copy. Recovery and the wire keep the exact
    // raw form, including legal numeric blanks; no normalization before staging.
    if (!validatePilotQuoteSaveSubmission(intent).ok) return { code: 'blocked', reason: 'invalid_values' }
    this.busy = true
    let p: PendingQuoteSave | null = null
    let dispatched = false
    try {
      const stage = autosave.stageSubmission(checked)
      if (!stage || stage.owner !== this.lease!.owner || stage.ownerGeneration !== this.lease!.gen
        || stage.key !== this.autosaveKey || stage.generation !== this.editorGeneration
        || stage.recordId !== this.quoteId || stage.originalRevision !== this.originalEditorRevision) return { code: 'blocked', reason: 'recovery_unavailable' }
      p = { version: 1, owner: this.lease!.owner, quoteId: this.quoteId, clientOperationId: intent.clientOperationId,
        editorGeneration: this.editorGeneration, originalEditorRevision: this.originalEditorRevision,
        submittedValues: checked, submittedSerialization: JSON.stringify(checked), stagedAt: Date.now(), state: 'pending' }
      if (!safeCopy(p, AUTOSAVE_ENVELOPE_BYTES)) return { code: 'blocked', reason: 'invalid_values' }
      const store = this.store(), bytes = JSON.stringify(p)
      if (store.getItem(this.key(p)) !== null) return { code: 'blocked', reason: 'recovery_unavailable' }
      store.setItem(this.key(p), bytes)
      if (store.getItem(this.key(p)) !== bytes || !this.active()) return { code: 'blocked', reason: 'recovery_unavailable' }
      let raw: unknown
      dispatched = true
      try { raw = await this.options.write(safeCopy(intent, 200_000)!) } catch { raw = null }
      const receipt = this.active() ? this.receipt(raw, p) : null
      if (!receipt) {
        if (this.active()) {
          try { if (store.getItem(this.key(p)) === bytes) store.setItem(this.key(p), JSON.stringify({ ...p, state: 'unknown' })) } catch { /* immutable submitted copy remains */ }
        }
        return { code: 'unknown', pending: { ...p, state: 'unknown' } }
      }
      // Store the direct result durably before any pending removal/draft clear.
      const committedBytes = JSON.stringify(receipt)
      store.setItem(this.resultKey(p), committedBytes)
      if (store.getItem(this.resultKey(p)) !== committedBytes || !this.active()) return { code: 'unknown', pending: p }
      this.completed = true // explicit new baseline/controller required for next Save
      const outcome: PilotQuoteSaveOutcome = { code: 'committed', pending: p, receipt, stage }
      this.issued.add(outcome)
      return outcome
    } catch {
      return p && dispatched ? { code: 'unknown', pending: p } : { code: 'blocked', reason: 'recovery_unavailable' }
    } finally { this.busy = false }
  }
  /** Invoke inside the builder only, after await, using fresh getValues(). */
  complete(outcome: PilotQuoteSaveOutcome, autosave: Autosave, currentValues: QuoteFormValues): boolean {
    if (outcome.code !== 'committed' || !this.issued.has(outcome) || this.finalized.has(outcome) || !this.active()
      || outcome.pending.quoteId !== this.quoteId || outcome.pending.editorGeneration !== this.editorGeneration) return false
    try {
      const store = this.store(), key = this.key(outcome.pending)
      if (store.getItem(this.resultKey(outcome.pending)) !== JSON.stringify(outcome.receipt)) return false
      const current = this.pending(store.getItem(key), key)
      if (!current || JSON.stringify(current) !== JSON.stringify(outcome.pending)) return false
      const cleared = autosave.clearSubmissionIfCurrent(outcome.stage, currentValues)
      // Acknowledgement does not make newer keystrokes durable. Keep recovery
      // and suppress a parent's navigation callback if their flush fails.
      if (!cleared && !autosave.flushCurrent(currentValues)) return false
      store.removeItem(key) // unique operation only; never another editor's key
      this.finalized.add(outcome)
      this.options.onCommitted?.(outcome.receipt, cleared)
      return cleared
    } catch { return false }
  }
}
