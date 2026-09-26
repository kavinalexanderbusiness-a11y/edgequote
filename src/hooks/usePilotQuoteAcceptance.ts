'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { cacheLease, getCacheGeneration, isCurrentLease, subscribeCacheOwner, type CacheLease } from '@/lib/clientCache'
import { acceptBlockedLabel, acceptBlockedReason, ON_BEHALF_REASONS, type OnBehalfReason } from '@/lib/quoteAcceptance'
import { displayQuoteStatus } from '@/lib/quoteStatus'
import { localTodayISO } from '@/lib/utils'
import type { QuoteStatus } from '@/types'
import { buildPilotAcceptanceCommitRequest, parsePilotAcceptanceCommitReply, parsePilotAcceptancePreview,
  parsePilotAcceptancePreviewRequest, pilotAcceptanceRefusalMessage,
  type PilotAcceptanceCommitRequest, type PilotAcceptanceExpected, type PilotAcceptancePreviewRequest,
  type PilotAcceptanceReceipt, type PilotQuoteAcceptanceTransport } from '@/lib/quotes/pilotQuoteAcceptance'

export type PilotAcceptanceScope = { mode: 'portal'; token: string } | { mode: 'owner'; ownerId: string; quoteId: string }
export type PilotAcceptancePhase = 'closed' | 'loading' | 'review' | 'saving' | 'accepted' | 'refused' | 'unknown'
export interface PilotAcceptanceState {
  open: boolean; phase: PilotAcceptancePhase; quoteId: string | null; expected: PilotAcceptanceExpected | null
  receipt: PilotAcceptanceReceipt | null; reason: OnBehalfReason | ''; note: string; termsAck: boolean; message: string | null
}
const blank = (): PilotAcceptanceState => ({ open: false, phase: 'closed', quoteId: null, expected: null,
  receipt: null, reason: '', note: '', termsAck: false, message: null })
const unknownMessage = 'We cannot confirm whether this acceptance was recorded. Do not submit it again yet. This copy is kept here for review.'
const noSubscription = () => () => {}
const zero = () => 0
type Tombstone = { state: PilotAcceptanceState; request: PilotAcceptanceCommitRequest; status: 'pending' | 'unknown' | 'accepted' }
// Deliberately memory-only and outside modal/component generations. There is no
// public reset, storage, log, token export or status-based success path. Returning
// to the same authority cannot bypass an unresolved write by minting a new ID.
const dispatched = new Map<string, Tombstone>()
type Operation = { id: number; scope: string; key: string; lease: CacheLease | null; request: PilotAcceptancePreviewRequest
  transport: PilotQuoteAcceptanceTransport; abort: AbortController; state: PilotAcceptanceState
  ownerId?: string; sentId?: string; onAccepted?: (receipt: PilotAcceptanceReceipt, expected: PilotAcceptanceExpected) => void }

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, parent: AbortSignal): Promise<T> {
  const abort = new AbortController()
  let fail: () => void = () => {}
  const stopped = new Promise<never>((_, reject) => { fail = () => { abort.abort(); reject(new Error('acceptance_unavailable')) } })
  parent.addEventListener('abort', fail, { once: true })
  const timer = setTimeout(fail, 15_000)
  try {
    if (parent.aborted) fail()
    return await Promise.race([Promise.resolve().then(() => {
      if (abort.signal.aborted) throw new Error('acceptance_unavailable')
      return work(abort.signal)
    }), stopped])
  } finally { clearTimeout(timer); parent.removeEventListener('abort', fail) }
}
export function pilotAcceptanceBlock(expected: PilotAcceptanceExpected, mode: PilotAcceptanceScope['mode'], termsAck: boolean): string | null {
  const p = expected.offered.public
  if (displayQuoteStatus({ status: p.status as QuoteStatus, valid_until: p.valid_until }, localTodayISO()) === 'expired')
    return 'This quote has expired. Ask the business to refresh it before accepting.'
  const base = p.offered_option_id === null ? p.initial_price : p.options.find(o => o.id === p.offered_option_id)?.price
  // Exact native pre-choice price gate, not an acceptance amount calculation.
  if (!p.no_charge && (base == null || base <= 0)) return 'Price needed before acceptance. This quote has not been recorded as no charge.'
  if (p.accepted_amount < 0) return 'This quote needs a valid price before acceptance.'
  const block = acceptBlockedReason({ hasOptions: p.options.length > 0, chosenOptionId: p.offered_option_id,
    termsText: p.terms_text, termsAcknowledged: mode === 'owner' || termsAck })
  return block ? acceptBlockedLabel(block) : null
}

export function usePilotQuoteAcceptance(transport: PilotQuoteAcceptanceTransport | undefined, scope: PilotAcceptanceScope,
  onAccepted?: (receipt: PilotAcceptanceReceipt, expected: PilotAcceptanceExpected) => void) {
  const enabled = !!transport
  const lifetime = useSyncExternalStore(scope.mode === 'owner' && transport ? subscribeCacheOwner : noSubscription,
    scope.mode === 'owner' && transport ? getCacheGeneration : zero, zero)
  const authority = scope.mode === 'portal' ? `portal:${scope.token}` : `owner:${scope.ownerId}`
  const scopeKey = scope.mode === 'owner' ? `${authority}:${scope.quoteId}` : authority
  const current = useRef({ transport, scope, scopeKey, authority, onAccepted })
  current.current = { transport, scope, scopeKey, authority, onAccepted }
  const mounted = useRef(false), sequence = useRef(0), operation = useRef<Operation | null>(null)
  const [rendered, setRendered] = useState<{ id: number; state: PilotAcceptanceState }>({ id: 0, state: blank() })
  const active = useCallback((op: Operation) => mounted.current && operation.current === op
    && current.current.scopeKey === op.scope && !!current.current.transport && !op.abort.signal.aborted
    && (op.lease === null || isCurrentLease(op.lease)), [])
  const publish = useCallback((op: Operation, state: PilotAcceptanceState) => {
    if (!active(op)) return
    op.state = state; setRendered({ id: op.id, state })
  }, [active])
  const blockedByAnother = useCallback((op: Operation): boolean => {
    if (!dispatched.has(op.key)) return false
    publish(op, { ...op.state, phase: 'refused', message: 'Another confirmation for this quote was submitted. This review was not sent. Close and reopen to review the submitted copy.' })
    return true
  }, [publish])
  const retire = useCallback(() => {
    const op = operation.current
    if (op) {
      const entry = dispatched.get(op.key)
      if (entry?.status === 'pending' && entry.request.clientOperationId === op.sentId) {
        entry.status = 'unknown'; entry.state = { ...entry.state, phase: 'unknown', message: unknownMessage }
      }
      op.abort.abort()
    }
    operation.current = null
  }, [])
  useEffect(() => {
    mounted.current = true; retire(); setRendered({ id: ++sequence.current, state: blank() })
    return () => { mounted.current = false; retire() }
  }, [scopeKey, lifetime, enabled, retire])

  const open = useCallback((quoteId: string, optionId: string | null, intent: 'explicit' | 'resume' = 'explicit') => {
    const c = current.current
    if (!mounted.current || !c.transport || (operation.current && active(operation.current) && operation.current.state.open)) return
    if (c.scope.mode === 'owner' && c.scope.quoteId !== quoteId) return
    const lease = c.scope.mode === 'owner' ? cacheLease() : null
    if (c.scope.mode === 'owner' && (!lease || lease.owner !== c.scope.ownerId || !isCurrentLease(lease))) return
    let request: PilotAcceptancePreviewRequest
    try { request = parsePilotAcceptancePreviewRequest({ version: 1, quoteId, optionId,
      ...(c.scope.mode === 'portal' ? { portalToken: c.scope.token } : {}) }) } catch { return }
    retire()
    const op: Operation = { id: ++sequence.current, scope: c.scopeKey, key: `${c.authority}|${quoteId}`, lease,
      request: freeze(request), transport: c.transport, abort: new AbortController(), state: { ...blank(), open: true, quoteId, phase: 'loading' },
      ...(c.scope.mode === 'owner' ? { ownerId: c.scope.ownerId } : {}), onAccepted: c.onAccepted }
    operation.current = op
    const existing = dispatched.get(op.key)
    if (existing && existing.status !== 'accepted') {
      publish(op, { ...existing.state, open: true, phase: 'unknown', message: unknownMessage })
      return
    }
    if (existing?.status === 'accepted' && intent === 'resume') {
      // Lease/capability recovery is not another customer decision. Restore the
      // exact recorded copy without fetching a replacement or replaying success.
      publish(op, { ...existing.state, open: true })
      return
    }
    // A known direct receipt resolves its operation. An explicit later opening
    // may review a new version; it never resends or substitutes the old one.
    if (existing?.status === 'accepted') dispatched.delete(op.key)
    publish(op, op.state)
    void bounded(signal => op.transport.preview(op.request, signal), op.abort.signal).then(raw => {
      if (!active(op)) return
      const result = parsePilotAcceptancePreview(raw, op.request)
      if (!result || result.code === 'refused') {
        publish(op, { ...op.state, phase: 'refused', message: pilotAcceptanceRefusalMessage(result?.reason ?? 'unavailable') }); return
      }
      const expected = freeze(result.expected)
      const expired = displayQuoteStatus({ status: expected.offered.public.status as QuoteStatus,
        valid_until: expected.offered.public.valid_until }, localTodayISO()) === 'expired'
      publish(op, { ...op.state, expected, phase: expired ? 'refused' : 'review',
        message: expired ? 'This quote has expired. Ask the business to refresh it before accepting.' : null })
    }).catch(() => publish(op, { ...op.state, phase: 'refused', message: pilotAcceptanceRefusalMessage('unavailable') }))
  }, [active, publish, retire])
  const close = useCallback(() => { retire(); setRendered({ id: ++sequence.current, state: blank() }) }, [retire])
  const selectOption = useCallback((id: string | null) => {
    const op = operation.current
    if (!op || !active(op) || !['loading', 'review', 'refused'].includes(op.state.phase) || blockedByAnother(op)) return
    const quoteId = op.request.quoteId
    close(); open(quoteId, id)
  }, [active, blockedByAnother, close, open])
  const edit = useCallback((patch: Partial<Pick<PilotAcceptanceState, 'reason' | 'note' | 'termsAck'>>) => {
    const op = operation.current
    if (!op || !active(op) || op.state.phase !== 'review' || blockedByAnother(op)) return
    publish(op, { ...op.state, ...patch, message: null })
  }, [active, blockedByAnother, publish])
  const setReason = useCallback((reason: OnBehalfReason | '') => {
    if (reason === '' || ON_BEHALF_REASONS.some(r => r.value === reason)) edit({ reason })
  }, [edit])
  const setNote = useCallback((note: string) => edit({ note }), [edit])
  const setTermsAck = useCallback((termsAck: boolean) => edit({ termsAck }), [edit])
  const submit = useCallback(async () => {
    const op = operation.current
    if (!op || !active(op) || op.state.phase !== 'review' || !op.state.expected || blockedByAnother(op)) return
    const expected = op.state.expected, owner = op.ownerId !== undefined
    const block = pilotAcceptanceBlock(expected, owner ? 'owner' : 'portal', op.state.termsAck)
    if (block || (owner && !op.state.reason)) {
      publish(op, { ...op.state, message: block ?? 'Choose how the customer told you they accepted.' }); return
    }
    let request: PilotAcceptanceCommitRequest
    try { request = freeze(buildPilotAcceptanceCommitRequest(op.request, expected, {
      addonIds: [...expected.offered.public.included_addon_ids], reason: owner && op.state.reason ? op.state.reason : null,
      note: owner ? op.state.note : null, termsAck: owner ? true : op.state.termsAck, clientOperationId: crypto.randomUUID(),
    })) } catch {
      publish(op, { ...op.state, message: 'This acceptance is too large or incomplete. Shorten the optional note and review it before submitting.' }); return
    }
    if (!active(op) || dispatched.has(op.key)) return
    const pending: Tombstone = { status: 'pending', request, state: { ...op.state, phase: 'saving', message: null } }
    op.sentId = request.clientOperationId
    dispatched.set(op.key, pending) // synchronous, before any transport invocation
    publish(op, pending.state)
    let raw: unknown
    try { raw = await bounded(signal => op.transport.commit(request, signal), op.abort.signal) } catch { raw = null }
    if (!active(op)) return
    const result = parsePilotAcceptanceCommitReply(raw, request, op.ownerId)
    if (result?.code === 'accepted') {
      const state: PilotAcceptanceState = { ...op.state, phase: 'accepted', receipt: freeze(result.receipt),
        message: owner ? 'This customer acceptance is recorded by you.' : 'Your acceptance is recorded.' }
      pending.status = 'accepted'; pending.state = state
      publish(op, state)
      if (active(op)) try { op.onAccepted?.(result.receipt, expected) } catch {
        publish(op, { ...state, message: 'The acceptance is recorded. The page could not refresh; keep this confirmation for reference.' })
      }
      return
    }
    if (result?.code === 'refused') {
      dispatched.delete(op.key)
      publish(op, { ...op.state, phase: 'refused', message: pilotAcceptanceRefusalMessage(result.reason) }); return
    }
    pending.status = 'unknown'; pending.state = { ...op.state, phase: 'unknown', message: unknownMessage }
    publish(op, pending.state)
    // Current native reconciliation cannot establish historical full-fence
    // attribution. Its response NEVER creates success or clears the tombstone.
    if (active(op)) try { await bounded(signal => op.transport.reconcile(request, signal), op.abort.signal) } catch { /* remains unknown */ }
  }, [active, blockedByAnother, publish])
  const lease = scope.mode === 'owner' ? cacheLease() : null
  const available = !!transport && (scope.mode === 'portal' ? !!scope.token : !!lease && lease.owner === scope.ownerId && isCurrentLease(lease))
  const op = operation.current
  const state = op && op.id === rendered.id && active(op) ? rendered.state : blank()
  return { state, available, lifetime, open, close, selectOption, setReason, setNote, setTermsAck, submit }
}
export type PilotAcceptanceController = ReturnType<typeof usePilotQuoteAcceptance>
