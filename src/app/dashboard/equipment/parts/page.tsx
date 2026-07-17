'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import {
  Part, PartCategory, PART_CATEGORIES, partCategoryLabel, stockStatus, partValue,
  inventorySummary, restockPart, adjustPart,
} from '@/lib/parts'
import { toneSoft, toneText } from '@/lib/tone'
import { formatCurrency, cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { StatTile } from '@/components/ui/StatTile'
import { FilterPill } from '@/components/ui/FilterPill'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Banner } from '@/components/ui/Banner'
import { Modal } from '@/components/ui/Modal'
import { PartDialog } from '@/components/equipment/PartDialog'
import { Package, Plus, AlertTriangle, CircleDollarSign, PackageOpen, Pencil, Trash2, Boxes } from 'lucide-react'

// ── Parts inventory ──────────────────────────────────────────────────────────
// The shelf behind the fleet: what's in stock, what's short, what it's worth.
// Stock is NEVER typed — every count comes from the movement ledger via the DB
// trigger, so a service that consumes a blade and a revert that returns it both
// land here automatically. Judgements (low/out, value, rollup) come from THE
// parts engine; this page only renders them.
type Filter = 'all' | 'reorder' | PartCategory

export default function PartsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [parts, setParts] = useState<Part[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [uid, setUid] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [editing, setEditing] = useState<Part | null | 'new'>(null)
  const [stockFor, setStockFor] = useState<Part | null>(null)

  async function load() {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      setUid(user.id)
      const { data, error } = await supabase.from('parts').select('*').eq('user_id', user.id).order('name')
      if (error) {
        setLoadError(error.message.includes('does not exist')
          ? 'Parts inventory isn’t set up yet — run supabase/RUN-2026-07-15-parts.sql, then reload.'
          : 'Could not load your parts: ' + error.message)
        return
      }
      setLoadError(null)
      setParts((data as Part[]) || [])
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your parts.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // Stock moves from the service log too — realtime keeps this shelf honest.
  useRealtimeRefresh('parts', uid ? `user_id=eq.${uid}` : null, load)

  const summary = useMemo(() => inventorySummary(parts), [parts])
  const visible = useMemo(() => parts.filter(p => {
    if (filter === 'all') return true
    if (filter === 'reorder') { const s = stockStatus(p).state; return s === 'low' || s === 'out' }
    return p.category === filter
  }), [parts, filter])

  // Only offer category chips the owner actually stocks — no dead filters.
  const usedCategories = useMemo(
    () => PART_CATEGORIES.filter(c => parts.some(p => p.category === c.value)),
    [parts],
  )

  async function remove(p: Part) {
    const ok = await confirmDialog({
      title: `Remove ${p.name}?`,
      message: 'Its whole stock history goes with it. Past services that used it keep their cost — only the shelf record disappears.',
      confirmLabel: 'Remove permanently', destructive: true,
    })
    if (!ok) return
    const { error } = await supabase.from('parts').delete().eq('id', p.id)
    if (error) { toast.error('Could not remove it: ' + error.message); return }
    setParts(prev => prev.filter(x => x.id !== p.id))
    toast.success(`${p.name} removed.`)
  }

  if (loading) return <PageContainer><SkeletonRows count={5} /></PageContainer>

  return (
    <PageContainer>
      <PageHeader
        crumb={{ label: 'Equipment', href: '/dashboard/equipment' }}
        title="Parts inventory"
        description="The shelf behind the fleet — what's in stock, what's short, and what it's worth. Logging a service can take parts straight off it."
        action={<Button onClick={() => setEditing('new')}><Plus className="w-4 h-4" /> Add part</Button>}
      />

      {loadError && (
        <Banner tone="danger" icon={AlertTriangle}
          action={<button type="button" onClick={() => { setLoading(true); load() }} className="shrink-0 underline font-semibold">Retry</button>}>
          {loadError}
        </Banner>
      )}

      {!loadError && parts.length === 0 && (
        <EmptyState
          icon={Package}
          title="No parts yet"
          description="Add the blades, oil and filters you keep on hand. Once they're here, logging a service can take them off the shelf automatically."
          action={{ label: 'Add your first part', onClick: () => setEditing('new') }}
        />
      )}

      {parts.length > 0 && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <StatTile icon={Boxes} label="Parts tracked" value={String(summary.partCount)}
              sub={`${usedCategories.length} categor${usedCategories.length === 1 ? 'y' : 'ies'}`} />
            <StatTile icon={PackageOpen} label="Needs reorder" value={String(summary.needingReorder)}
              tone={summary.needingReorder ? 'warn' : 'success'} tonedSurface={summary.needingReorder > 0}
              sub={summary.outCount ? `${summary.outCount} out of stock` : summary.needingReorder ? 'Low stock' : 'Shelf is healthy'}
              onClick={() => setFilter(summary.needingReorder ? 'reorder' : 'all')} />
            <StatTile icon={CircleDollarSign} label="Shelf value" value={formatCurrency(summary.shelfValue)}
              sub="Stock on hand × unit cost" />
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <FilterPill active={filter === 'all'} onClick={() => setFilter('all')}>All ({parts.length})</FilterPill>
            <FilterPill active={filter === 'reorder'} onClick={() => setFilter('reorder')}>Needs reorder ({summary.needingReorder})</FilterPill>
            {usedCategories.map(c => (
              <FilterPill key={c.value} active={filter === c.value} onClick={() => setFilter(c.value)}>{c.label}</FilterPill>
            ))}
          </div>

          {visible.length === 0 ? (
            <InlineEmpty>No parts match this filter.</InlineEmpty>
          ) : (
            <div className="space-y-2">
              {visible.map(p => (
                <PartRow key={p.id} part={p}
                  onEdit={() => setEditing(p)} onStock={() => setStockFor(p)} onRemove={() => remove(p)} />
              ))}
            </div>
          )}
        </>
      )}

      {editing && uid && (
        <PartDialog open userId={uid} part={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }} />
      )}
      {stockFor && uid && (
        <StockDialog part={stockFor} userId={uid}
          onClose={() => setStockFor(null)}
          onChanged={() => { setStockFor(null); load() }} />
      )}
    </PageContainer>
  )
}

function PartRow({ part, onEdit, onStock, onRemove }: {
  part: Part; onEdit: () => void; onStock: () => void; onRemove: () => void
}) {
  const st = stockStatus(part)
  const unit = part.unit === 'each' ? '' : ` ${part.unit}`
  return (
    <Card>
      <CardBody className="flex items-center gap-3 py-3">
        <div className={cn('w-9 h-9 rounded-lg border flex items-center justify-center shrink-0', toneSoft[st.tone])}>
          <Package className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-ink truncate">{part.name}</p>
            <span className="text-[10px] uppercase tracking-wide text-ink-muted border border-border rounded px-1.5 py-0.5">
              {partCategoryLabel(part.category)}
            </span>
          </div>
          {/* The verdict in words — never a bare number or a bare colour. */}
          <p className={cn('text-xs mt-0.5', toneText[st.tone])}>{st.reason}</p>
          <p className="text-[11px] text-ink-faint mt-0.5 truncate">
            {[part.sku && `#${part.sku}`, part.unit_cost != null && `${formatCurrency(part.unit_cost)}/${part.unit}`,
              part.unit_cost != null && `${formatCurrency(partValue(part))} on shelf`, part.supplier].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <p className="text-lg font-bold text-ink tabular-nums hidden sm:block mr-1">{part.qty_on_hand}{unit}</p>
          <Button size="sm" variant="secondary" onClick={onStock}>Restock</Button>
          <button type="button" onClick={onEdit} aria-label={`Edit ${part.name}`}
            className="w-8 h-8 flex items-center justify-center text-ink-faint hover:text-ink rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <Pencil className="w-4 h-4" />
          </button>
          <button type="button" onClick={onRemove} aria-label={`Remove ${part.name}`}
            className="w-8 h-8 flex items-center justify-center text-ink-faint hover:text-red-400 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </CardBody>
    </Card>
  )
}

// Restock or correct a count. Both write a MOVEMENT — the trigger recomputes the
// shelf — so there is exactly one way stock ever changes.
function StockDialog({ part, userId, onClose, onChanged }: {
  part: Part; userId: string; onClose: () => void; onChanged: () => void
}) {
  const supabase = useState(() => createClient())[0]
  const [mode, setMode] = useState<'restock' | 'count'>('restock')
  const [qty, setQty] = useState('')
  const [cost, setCost] = useState(part.unit_cost != null ? String(part.unit_cost) : '')
  const [busy, setBusy] = useState(false)
  const unit = part.unit === 'each' ? '' : ` ${part.unit}`

  async function submit() {
    const n = Number(qty)
    if (!qty.trim() || !Number.isFinite(n) || n < 0) { toast.error('Enter a number.'); return }
    setBusy(true)
    const res = mode === 'restock'
      ? await restockPart(supabase, { userId, partId: part.id, qty: n, unitCost: Number(cost) || null })
      : await adjustPart(supabase, { userId, part, counted: n })
    setBusy(false)
    if (res.error) { toast.error('Could not update stock: ' + res.error); return }
    toast.success(mode === 'restock'
      ? `+${n}${unit} ${part.name} — ${Number(part.qty_on_hand) + n}${unit} on hand.`
      : `${part.name} counted at ${n}${unit}.`)
    onChanged()
  }

  return (
    <Modal open onClose={() => !busy && onClose()} icon={Package} size="sm" onSubmit={submit}
      title={part.name}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={submit} loading={busy}>{mode === 'restock' ? 'Add stock' : 'Save count'}</Button></>}>
      <div className="space-y-4">
        <div className="flex items-center gap-1.5">
          <FilterPill active={mode === 'restock'} onClick={() => setMode('restock')}>Received stock</FilterPill>
          <FilterPill active={mode === 'count'} onClick={() => setMode('count')}>Correct the count</FilterPill>
        </div>
        <p className="text-xs text-ink-muted">
          {mode === 'restock'
            ? `Adds to the ${part.qty_on_hand}${unit} already on hand.`
            : `Sets the shelf to what you actually counted — the difference is logged as a correction.`}
        </p>
        <Input autoFocus type="number" min="0" step="any" inputMode="decimal"
          label={mode === 'restock' ? `How many received${unit ? ` (${part.unit})` : ''}` : `Counted${unit ? ` (${part.unit})` : ''}`}
          value={qty} onChange={e => setQty(e.target.value)} placeholder="0" />
        {mode === 'restock' && (
          <Input type="number" min="0" step="0.01" inputMode="decimal" label="Cost per unit"
            value={cost} onChange={e => setCost(e.target.value)} placeholder="0.00"
            hint="Recorded against this delivery." />
        )}
      </div>
    </Modal>
  )
}
