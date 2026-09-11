'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { BusinessSettings, Customer, QuoteFormValues, ServiceTemplate, TravelFeeTier } from '@/types'
import { cacheLease, getCacheGeneration, isCurrentLease, subscribeCacheOwner, type CacheLease } from '@/lib/clientCache'
import { createAutosaveSubmissionAdoption, type AutosaveSubmissionAdoption } from '@/lib/autosaveSubmission'
import { copyPilotQuoteSaveJson } from '@/lib/quotes/pilotQuoteSaveReceipt'
import { parsePilotQuoteSaveBaseline, type PilotQuoteSaveBaseline } from '@/lib/quotes/pilotQuoteSaveBaseline'
import { validatePilotQuoteSaveDraftValues, type PilotQuoteSaveIntent } from '@/lib/quotes/pilotQuoteSaveValues'
import { PilotQuoteSaveCaller, type PendingQuoteSave, type PilotQuoteDraftRecovery, type PilotQuoteRecoveryInventory, type PilotQuoteSaveRecovery } from '@/lib/quotes/pilotQuoteSaveCaller'
import { QuoteBuilder, type PilotQuoteEditorHandle } from './QuoteBuilder'
import { confirm } from '@/lib/confirm'
import type { PilotQuoteAuxiliaryReady } from '@/lib/quotes/pilotQuoteAuxiliaryLoader'

/** The owner wrapper supplies the verified loader result. The original typed
 * context remains an isolated fixture seam until the activation/legacy-door
 * gate; it is not a substitute for the owner wrapper in a production route. */
export type PilotQuoteAuxiliaryContext =
  | { code: 'loading' | 'unavailable'; ownerId: string }
  | PilotQuoteAuxiliaryReady
  | { code: 'ready'; complete: true; ownerId: string; source?: never; customers: Customer[]; templates: ServiceTemplate[];
      tiers: TravelFeeTier[]; settings: BusinessSettings | null }
export type PilotQuoteSaveEditorShellProps = {
  quoteId: string
  context: PilotQuoteAuxiliaryContext
  loadBaseline(quoteId: string, signal: AbortSignal): Promise<unknown>
  write(intent: PilotQuoteSaveIntent): Promise<unknown>
  readReconciliation(pending: Readonly<PendingQuoteSave>): Promise<unknown>
  onClose?(): void
}
type ReadyContext = Extract<PilotQuoteAuxiliaryContext, { code: 'ready' }>
type Instance = { lease: CacheLease; baseline: PilotQuoteSaveBaseline; values: QuoteFormValues; caller: PilotQuoteSaveCaller; context: ReadyContext }
type LoadResult = { code: 'ready'; baseline: PilotQuoteSaveBaseline } | { code: 'unavailable' | 'not_found' | 'unauthenticated' }
const row = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const nullableNumber = (v: unknown) => v === null || finite(v)
const nullableString = (v: unknown) => v === null || typeof v === 'string'
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v)

/** Defence at the component boundary. The owner wrapper additionally revokes
 * reads/actions synchronously on auth changes, including between renders. */
function readyContext(input: PilotQuoteAuxiliaryContext, owner: string | undefined, generation: number | undefined, quoteId: string): ReadyContext | null {
  const v = copyPilotQuoteSaveJson(input, 2_000_000)
  if (!v || v.code !== 'ready' || v.complete !== true || v.ownerId !== owner) return null
  if (Object.hasOwn(v, 'source')) {
    const source: unknown = v.source
    if (!row(source) || Object.keys(source).length !== 4 || source.kind !== 'verified-owner-auxiliary'
      || source.quoteId !== quoteId || source.ownerId !== owner || source.leaseGeneration !== generation
      || !v.source || v.settings === null || !Array.isArray(v.units) || !Array.isArray(v.plans)) return null
  }
  const owned = (items: unknown, check: (r: Record<string, unknown>) => boolean) => Array.isArray(items) && items.length <= 10_000
    && new Set(items.map(x => row(x) ? x.id : null)).size === items.length
    && items.every(x => row(x) && uuid(x.id) && x.user_id === owner && check(x))
  if (!owned(v.customers, c => typeof c.name === 'string' && ['address','city','province','phone','email'].every(k => nullableString(c[k]))
      && (!Object.hasOwn(c, 'properties') || (Array.isArray(c.properties)
        && new Set(c.properties.map(p => row(p) ? p.id : null)).size === c.properties.length
        && c.properties.every(p => row(p) && uuid(p.id) && p.user_id === owner && p.customer_id === c.id
          && ['address','city','province'].every(k => nullableString(p[k])) && typeof p.is_primary === 'boolean'))))
    || !owned(v.templates, t => typeof t.name === 'string' && typeof t.category === 'string' && finite(t.default_rate)
      && typeof t.is_active === 'boolean' && typeof t.is_favorite === 'boolean' && finite(t.sort_order)
      && nullableString(t.default_description) && ['starting_from','hourly','per_sqft','per_linear_ft','starting_from_materials','hourly_materials'].includes(String(t.pricing_display_type)))
    || !owned(v.tiers, t => finite(t.min_km) && nullableNumber(t.max_km) && nullableNumber(t.fee)
      && typeof t.is_custom === 'boolean' && finite(t.sort_order))) return null
  if (v.settings !== null) {
    const s: unknown = v.settings
    if (!row(s) || s.user_id !== owner || !uuid(s.id) || !finite(s.default_rate) || !nullableString(s.base_address)
      || !['daily_capacity_hours','gst_percent','crew_cost_per_hour','pricing_base_charge','pricing_mow_rate',
        'pricing_recommended_mult','pricing_premium_mult','pricing_travel_rate'].every(k => nullableNumber(s[k]))) return null
  }
  return v
}

function verifiedContext(context: ReadyContext): context is PilotQuoteAuxiliaryReady {
  return context.source?.kind === 'verified-owner-auxiliary'
}

/** Missing canonical links refuse actions; they never turn a saved document
 * into a manual customer or an unrelated current catalogue selection. */
function contextContainsValues(context: ReadyContext, values: QuoteFormValues, originalCustomerId = values.customer_id): boolean {
  if (!verifiedContext(context)) return true
  if (uuid(values.customer_id) && !context.customers.some(customer => customer.id === values.customer_id
    && (customer.archived_at === null || customer.id === originalCustomerId))) return false
  const templateIds = [values.service_template_id, ...values.services.map(service => service.service_template_id)].filter(Boolean)
  return templateIds.every(id => context.templates.some(template => template.id === id))
}

// Bounded even when the injected read ignores cancellation. Late results cannot
// install a baseline or refresh an existing caller's original revision.
async function readBaseline(props: PilotQuoteSaveEditorShellProps, lease: CacheLease, signal: AbortSignal): Promise<LoadResult> {
  const child = new AbortController()
  let reject: () => void = () => {}
  const aborted = new Promise<never>((_, fail) => { reject = () => fail(new Error('unavailable')) })
  const stop = () => { child.abort(); reject() }
  const timer = setTimeout(stop, 15_000)
  signal.addEventListener('abort', stop, { once: true })
  try {
    if (signal.aborted || !isCurrentLease(lease)) return { code: 'unavailable' }
    const raw = await Promise.race([Promise.resolve().then(() => props.loadBaseline(props.quoteId, child.signal)), aborted])
    if (signal.aborted || !isCurrentLease(lease)) return { code: 'unavailable' }
    const baseline = parsePilotQuoteSaveBaseline(raw, { ownerId: lease.owner, quoteId: props.quoteId })
    if (baseline) return { code: 'ready', baseline }
    if (row(raw) && Object.keys(raw).length === 1 && (raw.code === 'not_found' || raw.code === 'unauthenticated')) return { code: raw.code }
    return { code: 'unavailable' }
  } catch { return { code: 'unavailable' } }
  finally { clearTimeout(timer); signal.removeEventListener('abort', stop); child.abort() }
}

const labels: Record<string, string> = {
  customer_name: 'Customer', customer_phone: 'Phone', customer_email: 'Email', acquisition_source: 'Source', address: 'Address',
  service_type: 'Service', initial_price: 'First visit', weekly_price: 'Weekly', biweekly_price: 'Every two weeks', monthly_price: 'Monthly',
  hours: 'Hours', crew_size: 'Crew', rate: 'Hourly rate', travel_fee: 'Travel fee', distance_km: 'Distance',
  notes: 'Customer notes', internal_notes: 'Private notes', measured_sqft: 'Measured area', suggested_price: 'Suggested price',
  overgrowth_multiplier: 'Condition multiplier', custom_travel_required: 'Custom travel', show_travel_separately: 'Show travel separately',
  status: 'Status', value_grade: 'Recommendation grade', nearby_count: 'Nearby jobs', deposit_type: 'Deposit type', deposit_value: 'Deposit',
}
function VersionValues({ values }: { values: QuoteFormValues }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(values, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = 'quote-recovery-copy.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  return <div className="space-y-3 text-sm">
    <dl className="grid grid-cols-[minmax(7rem,1fr)_2fr] gap-x-4 gap-y-2">
      {Object.entries(labels).map(([key, label]) => <div key={key} className="contents">
        <dt className="text-ink-muted">{label}</dt><dd className="whitespace-pre-wrap break-words">{
          values[key as keyof QuoteFormValues] === null ? 'Not recorded'
            : values[key as keyof QuoteFormValues] === '' ? 'Blank'
            : String(values[key as keyof QuoteFormValues])}</dd>
      </div>)}
    </dl>
    <p>{values.services.length} additional lines · {values.options.length} options{values.has_options ? ' enabled' : ' disabled'}</p>
    {values.services.map((s, i) => <p key={i}>{s.service_type || 'Unnamed line'}: {s.quantity} {s.unit} × {s.unit_price}; {s.est_minutes} min; {s.discount_type || 'no discount'} {s.discount_value}. {s.notes}</p>)}
    {values.options.map((o, i) => <p key={i}>{o.name || 'Unnamed option'}: {o.price}{o.is_recommended ? ' · Recommended' : ''}. {o.description}</p>)}
    <p>{values.measurement_snapshot ? `Measurement: ${values.measurement_snapshot.value} ${values.measurement_snapshot.unit}` : 'No saved measurement snapshot'}</p>
    <button type="button" className="underline" onClick={download}>Download full copy</button>
  </div>
}

/** Dormant real-component integration. No production route, SDK client, retry,
 * rebase, automatic recovery reset, or main-branch activation is created here. */
export function PilotQuoteSaveEditorShell(props: PilotQuoteSaveEditorShellProps) {
  const generation = useSyncExternalStore(subscribeCacheOwner, getCacheGeneration, () => 0)
  const lease = cacheLease()
  const [instance, setInstance] = useState<Instance | null>(null)
  const context = useMemo(() => {
    const ready = readyContext(props.context, lease?.owner, lease?.gen, props.quoteId)
    return ready && (!instance || contextContainsValues(ready, instance.baseline.values)) ? ready : null
  }, [props.context, props.quoteId, lease?.owner, lease?.gen, instance])
  const contextReady = context !== null
  const currentProps = useRef(props); currentProps.current = props
  const currentContext = useRef(context); currentContext.current = context
  const editor = useRef<PilotQuoteEditorHandle>(null)
  const active = useRef<Instance | null>(null)
  const [state, setState] = useState('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [review, setReview] = useState<PilotQuoteRecoveryInventory | null>(null)
  const [latest, setLatest] = useState<LoadResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [editorState, setEditorState] = useState<'pending' | 'ready' | 'refused'>('pending')
  const operation = useRef(0)
  const reading = useRef<AbortController | null>(null)
  const alive = useRef(false)
  const requestReview = useRef<() => void>(() => {})

  const install = (baseline: PilotQuoteSaveBaseline, bound: CacheLease, adoption?: AutosaveSubmissionAdoption, values = baseline.values) => {
    if (!alive.current || !isCurrentLease(bound) || currentProps.current.quoteId !== baseline.quoteId || !currentContext.current) return
    if (!contextContainsValues(currentContext.current, values, baseline.values.customer_id)) {
      setState('context_unavailable'); return
    }
    let next: Instance
    const caller = new PilotQuoteSaveCaller({ quoteId: baseline.quoteId, expectedEditorRevision: baseline.editorRevision,
      editorGeneration: adoption?.destination.binding.generation, adoption, validateValues: validatePilotQuoteSaveDraftValues,
      write: input => {
        if (active.current !== next || !currentContext.current || !isCurrentLease(bound)
          || !contextContainsValues(currentContext.current, input.values, baseline.values.customer_id)
          || currentProps.current.quoteId !== baseline.quoteId) return Promise.reject(new Error('Editor context unavailable'))
        return currentProps.current.write(input)
      }, readReconciliation: p => currentProps.current.readReconciliation(p),
      onRecoveryRequested: () => {
        if (active.current === next && caller.active()) requestReview.current()
      },
      onCommitted: (_receipt, cleared) => {
        if (active.current !== next || !caller.active()) return
        setSaved(true)
        setMessage(cleared ? 'Your submitted quote was saved.' : 'Your submitted quote was saved. Your newer edits are kept here for review.')
        // Even an exact clear does not authorize replacing typing that happens
        // during a subsequent read. The working editor remains mounted.
      },
    })
    next = { lease: bound, baseline, values, caller, context: currentContext.current }
    active.current?.caller.dispose()
    active.current = next; setInstance(next); setState('editing'); setSaved(false); setMessage(null); setEditorState('pending')
  }
  const installRef = useRef(install); installRef.current = install

  useEffect(() => {
    alive.current = true
    const retained = active.current
    if (retained && isCurrentLease(retained.lease) && retained.baseline.quoteId === currentProps.current.quoteId) {
      // A same-owner catalogue refresh may suspend actions, but cannot unmount
      // current RHF values or silently install a newer saved baseline.
      return () => { alive.current = false }
    }
    const bound = cacheLease(), id = ++operation.current, controller = new AbortController()
    reading.current?.abort(); reading.current = controller
    active.current = null; setInstance(null); setReview(null); setLatest(null); setSaved(false); setBusy(false); setMessage(null)
    if (!bound) setState('unauthenticated')
    else if (!currentContext.current) setState('context_unavailable')
    else {
      setState('loading')
      void readBaseline(currentProps.current, bound, controller.signal).then(result => {
        if (!alive.current || id !== operation.current || controller.signal.aborted || !isCurrentLease(bound)) return
        if (result.code === 'ready') installRef.current(result.baseline, bound)
        else setState(result.code)
      })
    }
    return () => {
      alive.current = false; controller.abort()
      // CacheOwner replay can invalidate the lease. Do not dispose a controller
      // shared by a still-live StrictMode setup; all callbacks have lease fences.
    }
  }, [props.quoteId, generation, contextReady])

  const boundValid = (expected: Instance, id?: number) => alive.current && active.current === expected && expected.caller.active()
    && isCurrentLease(expected.lease) && currentProps.current.quoteId === expected.baseline.quoteId
    && (id === undefined || operation.current === id)
  const valid = (expected: Instance, id?: number) => boundValid(expected, id) && !!currentContext.current
  const showReview = () => {
    const current = active.current
    if (!current || !valid(current)) return
    const checkpoint = editor.current?.capture()
    if (!checkpoint || !editor.current?.protect(checkpoint.serialization)) {
      setMessage('We could not make a fresh recovery copy of this editor. Previously stored copies are shown below; keep this editor open.')
    }
    setReview(current.caller.reviewRecovery()); setLatest(null)
  }
  requestReview.current = showReview
  const refreshReview = async () => {
    const current = active.current
    if (!current || !valid(current) || busy) return
    const id = ++operation.current, controller = new AbortController()
    reading.current?.abort(); reading.current = controller; setBusy(true)
    const result = await readBaseline(currentProps.current, current.lease, controller.signal)
    if (!valid(current, id)) { if (boundValid(current, id)) setBusy(false); return }
    const checkpoint = editor.current?.capture()
    if (!checkpoint || !editor.current?.protect(checkpoint.serialization)) setMessage('The saved quote was read, but current edits could not be copied into recovery. Keep this editor open.')
    setLatest(result); setReview(current.caller.reviewRecovery()); setBusy(false)
  }
  const replace = async (source?: PilotQuoteDraftRecovery) => {
    const current = active.current, checkpoint = editor.current?.capture()
    if (!current || !checkpoint || !valid(current) || busy) return
    if (source && (!current.caller.matchesDraft(source) || source.draft.generation === current.caller.editorGeneration)) return
    const inventory = current.caller.reviewRecovery()
    if (inventory.code !== 'ready') { setMessage('Local recovery is unavailable. Keep this editor open.'); return }
    if (source && inventory.pending.some(p => p.pending.editorGeneration === source.draft.generation)) {
      setMessage('This copy belongs to an earlier Save. Review it without retrying or applying it automatically.'); return
    }
    const id = ++operation.current, controller = new AbortController()
    reading.current?.abort(); reading.current = controller; setBusy(true)
    const result = await readBaseline(currentProps.current, current.lease, controller.signal)
    if (!valid(current, id)) { if (boundValid(current, id)) setBusy(false); return }
    setLatest(result)
    if (result.code !== 'ready') { setBusy(false); setMessage('We could not load the saved quote. Your editor is unchanged.'); return }
    if (source && source.draft.originalRevision !== result.baseline.editorRevision) {
      setBusy(false); setMessage('The saved quote has changed. This draft is available for review; it cannot be applied to a different version.'); return
    }
    const freshInventory = current.caller.reviewRecovery()
    if (freshInventory.code !== 'ready' || (source && freshInventory.pending.some(p => p.pending.editorGeneration === source.draft.generation))) {
      setBusy(false); setMessage('Recovery changed while the saved version loaded. Review the local copies again before switching.'); return
    }
    const now = editor.current?.capture()
    if (!now || now.serialization !== checkpoint.serialization || (source && !current.caller.matchesDraft(source))) {
      setBusy(false); setReview(current.caller.reviewRecovery()); setMessage('Your edits or the selected copy changed. Review them again before switching.'); return
    }
    if (!editor.current?.protect(checkpoint.serialization) || !valid(current, id)) {
      setBusy(false); setMessage('We could not protect your current edits. Keep this editor open.'); return
    }
    let adoption: AutosaveSubmissionAdoption | undefined
    if (source) {
      const editorGeneration = crypto.randomUUID()
      const destination = { key: `eq:autosave:owner:${encodeURIComponent(current.lease.owner)}:quote:${current.baseline.quoteId}:pilot:${editorGeneration}`,
        binding: { owner: current.lease.owner, recordId: current.baseline.quoteId, originalRevision: result.baseline.editorRevision, generation: editorGeneration } }
      const token = createAutosaveSubmissionAdoption(window.localStorage, { lease: current.lease,
        source: { key: source.key, storedBytes: source.storedBytes, binding: { owner: source.draft.owner,
          recordId: source.draft.recordId, originalRevision: source.draft.originalRevision, generation: source.draft.generation } }, destination }, validatePilotQuoteSaveDraftValues)
      if (!token) { setBusy(false); setMessage('We could not verify the new working copy. Existing copies are preserved.'); return }
      adoption = token
    }
    install(result.baseline, current.lease, adoption, source?.draft.value ?? result.baseline.values)
    setBusy(false); setReview(null); setLatest(null)
  }
  const removeDraft = async (entry: PilotQuoteDraftRecovery) => {
    const current = active.current, checkpoint = editor.current?.capture()
    if (!current || !checkpoint || !valid(current) || busy || entry.draft.generation === current.caller.editorGeneration) return
    if (!await confirm({ title: 'Remove this local copy?', message: 'Only this selected browser recovery copy will be removed. The saved quote and your current editor stay as they are.', confirmLabel: 'Remove local copy', destructive: true })) return
    if (!valid(current) || editor.current?.capture()?.serialization !== checkpoint.serialization || !current.caller.discardDraft(entry)) {
      setMessage('The selected copy or your editor changed. Nothing else was removed.'); return
    }
    setReview(current.caller.reviewRecovery())
  }
  const removePending = async (selection: PilotQuoteSaveRecovery) => {
    const current = active.current, checkpoint = editor.current?.capture()
    if (!current || !checkpoint || !valid(current) || busy) return
    if (!await confirm({ title: 'Remove this local Save record?', message: 'This does not undo or retry the Save. Its server outcome may still be unknown. Your current draft remains.', confirmLabel: 'Remove local record', destructive: true })) return
    if (!valid(current) || editor.current?.capture()?.serialization !== checkpoint.serialization || !current.caller.discardRecovery(selection)) {
      setMessage('The selected record or your editor changed. Recovery is preserved.'); return
    }
    setReview(current.caller.reviewRecovery())
  }
  const close = () => {
    const current = active.current
    if (!current || !valid(current)) return
    current.caller.dispose(); active.current = null; reading.current?.abort(); operation.current++
    setInstance(null); setState('closed'); currentProps.current.onClose?.()
  }

  const visible = instance && boundValid(instance)
  if (!visible) return <div role="status" className="rounded-xl border border-border p-4 text-sm">{
    state === 'not_found' ? 'This quote is unavailable for your account.'
      : state === 'unauthenticated' || !lease ? 'Sign in to load your quote.'
      : state === 'context_unavailable' || !contextReady ? 'Customer, service or business settings could not be verified. Your quote has not been opened for editing.'
      : state === 'closed' ? 'Editor closed. Saved local copies are kept in this browser.'
      : state === 'unavailable' ? 'We could not load your saved quote. Editing is unavailable until the saved version can be verified.'
      : 'Loading your saved quote…'}</div>

  const usable = contextReady && editorState === 'ready'
  const shownContext = context ?? instance.context
  const ownerContext = verifiedContext(shownContext) ? shownContext : undefined
  const pickerCustomers = ownerContext ? ownerContext.customers
    .filter(customer => customer.archived_at === null || customer.id === instance.baseline.values.customer_id)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) : shownContext.customers
  return <section className="space-y-4" aria-label="Quote editor">
    <div className="flex flex-wrap items-center gap-3">
      <h2 className="font-semibold">{instance.baseline.quoteNumber}</h2>
      <button type="button" disabled={busy || !contextReady} className="text-sm underline" onClick={showReview}>Review saved and local copies</button>
      <button type="button" disabled={busy || !usable} className="text-sm underline" onClick={() => void replace()}>Open saved version</button>
      {saved && <span className="text-sm text-emerald-400">Submitted version saved</span>}
    </div>
    {message && <p role="status" className="rounded-xl border border-border p-3 text-sm">{message}</p>}
    {!contextReady && <p role="status" className="rounded-xl border border-border p-3 text-sm">Business context is being verified. Your current editor is kept here, with changes paused.</p>}
    {editorState === 'refused' && <p role="status" className="text-sm">Recovery is read-only because this working copy could not be verified. Existing copies remain available for inspection and download.</p>}
    {review && <section aria-label="Recovery review" className="space-y-4 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-3"><h3 className="font-semibold">Saved quote and local copies</h3>
        <button type="button" disabled={busy || !contextReady} className="text-sm underline" onClick={() => void refreshReview()}>Refresh saved version</button>
        <button type="button" className="text-sm underline" onClick={() => setReview(null)}>Close review</button></div>
      <p className="text-sm text-ink-muted">Refreshing reads the saved quote. It does not replace your current edits or retry an earlier Save.</p>
      {latest?.code === 'ready' ? <details><summary>Latest saved version</summary><VersionValues values={latest.baseline.values} /></details>
        : <p role="status" className="text-sm">{latest ? 'The latest saved version could not be verified.' : 'Refresh to compare the latest saved version.'}</p>}
      {review.code !== 'ready' ? <p role="status">Local copies could not be verified. Keep this editor open.</p> : <>
        {review.protectedRecords > 0 && <p role="status">Some older or unreadable local records are protected. They cannot be verified, applied or removed here.</p>}
        {review.pending.map(selection => { const { pending, committed } = selection; return <article key={pending.clientOperationId} className="space-y-2 border-t border-border pt-3">
          <p className="font-medium">{committed ? 'Direct Save acknowledgement recorded' : 'Earlier Save — outcome not confirmed'}</p>
          <details><summary>Submitted copy</summary><VersionValues values={pending.submittedValues} /></details>
          <button type="button" disabled={busy || !usable} className="text-sm underline" onClick={() => void removePending(selection)}>Remove local Save record</button>
        </article> })}
        {review.drafts.map(entry => {
          const current = entry.draft.generation === instance.caller.editorGeneration
          const pending = review.pending.some(p => p.pending.editorGeneration === entry.draft.generation)
          const canContinue = !current && !pending && latest?.code === 'ready' && entry.draft.originalRevision === latest.baseline.editorRevision
          return <article key={entry.key} className="space-y-2 border-t border-border pt-3">
            <p className="font-medium">{current ? 'Last stored copy for this editor' : 'Local draft'} · {new Date(entry.draft.savedAt).toLocaleString()}</p>
            <details><summary>Review draft</summary><VersionValues values={entry.draft.value} /></details>
            {pending && <p className="text-sm">This draft belongs to an earlier Save. It is available for review without retrying.</p>}
            {!current && <div className="flex gap-4">
              <button type="button" disabled={busy || !usable || !canContinue} className="text-sm underline disabled:opacity-50" onClick={() => void replace(entry)}>Continue this draft</button>
              <button type="button" disabled={busy || !usable} className="text-sm underline" onClick={() => void removeDraft(entry)}>Remove local copy</button>
            </div>}
          </article>
        })}
        {review.drafts.length === 0 && review.pending.length === 0 && review.protectedRecords === 0 && <p>No other local copies were found.</p>}
      </>}
    </section>}
    <fieldset disabled={!contextReady} className="m-0 min-w-0 border-0 p-0">
    <QuoteBuilder key={instance.caller.autosaveKey} customers={pickerCustomers} templates={shownContext.templates} tiers={shownContext.tiers}
      pilotAuxiliary={ownerContext}
      settings={shownContext.settings} defaultValues={instance.values} isEdit pilotSave={instance.caller} pilotEditorRef={editor} onPilotEditorState={setEditorState}
      autosaveBaselineUpdatedAt={instance.baseline.quoteUpdatedAt} optionsLockedName={instance.baseline.selectedOption?.name ?? null}
      onCancel={close} onSubmit={async () => false} />
    </fieldset>
  </section>
}
