'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import {
  PurchaseOrder, PurchaseOrderItem, ReceiptMovement, PoStatus, PO_STATUSES,
  PO_STATUS_LABELS, PO_STATUS_TONES,
  loadPurchaseOrders, savePurchaseOrder, savePoItem, deletePoItem, receivePoItems,
  poDisplayStatus, receivedQty, outstandingQty, lineState, poTotal, vendorHistory,
} from '@/lib/purchasing'
import { Part } from '@/lib/parts'
import { Supplier, loadSuppliers } from '@/lib/suppliers'
import { toneSoft } from '@/lib/tone'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { StatTile } from '@/components/ui/StatTile'
import { FilterPill } from '@/components/ui/FilterPill'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Banner } from '@/components/ui/Banner'
import { Modal } from '@/components/ui/Modal'
import { ScanInput } from '@/components/inventory/ScanInput'
import { ClipboardList, Plus, PackageCheck, Trash2, Truck, CircleDollarSign } from 'lucide-react'

// ── Purchase orders + receiving ──────────────────────────────────────────────
// What you ordered, and what actually turned up.
//
// Receiving is the ONLY thing here that moves stock, and it moves it the same
// way everything else does: by writing a part_movements(kind='restock') row.
// Nothing on this page writes qty_on_hand — the DB trigger recomputes it from
// the ledger, so a receipt and the shelf can't disagree.
//
// "Received" is DERIVED (lib/purchasing.receivedQty sums the linked movements),
// never stored — so partial receiving needs no special case, and reverting a
// receipt can't leave a line claiming goods that aren't on the shelf.

type Filter = 'open' | 'all' | PoStatus

export default function PurchaseOrdersPage() {
  const supabase = useMemo(() => createClient(), [])
  const [pos, setPos] = useState<PurchaseOrder[]>([])
  const [items, setItems] = useState<PurchaseOrderItem[]>([])
  const [movements, setMovements] = useState<ReceiptMovement[]>([])
  const [parts, setParts] = useState<Part[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [uid, setUid] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('open')
  const [editing, setEditing] = useState<PurchaseOrder | 'new' | null>(null)
  const [receiving, setReceiving] = useState<PurchaseOrder | null>(null)

  async function load() {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setLoading(false); return }
    setUid(user.id)
    const [po, sup, pRes] = await Promise.all([
      loadPurchaseOrders(supabase),
      loadSuppliers(supabase, { includeArchived: true }),
      supabase.from('parts').select('*').eq('user_id', user.id),
    ])
    if (po.error || pRes.error) {
      setLoadError('Could not load purchase orders: ' + (po.error || pRes.error?.message))
      setLoading(false); return
    }
    setLoadError(null)
    setPos(po.pos); setItems(po.items); setMovements(po.movements)
    setSuppliers(sup); setParts((pRes.data as Part[]) || [])
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useRealtimeRefresh('purchase_orders', uid ? `user_id=eq.${uid}` : null, load)
  useRealtimeRefresh('part_movements', uid ? `user_id=eq.${uid}` : null, load)

  const partsById = useMemo(() => new Map(parts.map(p => [p.id, p])), [parts])
  const supById = useMemo(() => new Map(suppliers.map(s => [s.id, s])), [suppliers])
  const itemsFor = (poId: string) => items.filter(i => i.purchase_order_id === poId)

  const visible = useMemo(() => pos.filter(p => {
    const st = poDisplayStatus(p, items, movements)
    if (filter === 'all') return true
    if (filter === 'open') return st !== 'received' && st !== 'cancelled'
    return p.status === filter
  }), [pos, items, movements, filter])

  // Awaiting delivery = ordered, something still owed. The number that says
  // "chase someone" — derived from the ledger, like everything else here.
  const awaiting = useMemo(() => pos.filter(p => {
    const st = poDisplayStatus(p, items, movements)
    return st === 'ordered' || st === 'partial'
  }).length, [pos, items, movements])

  const onOrderValue = useMemo(() => pos
    .filter(p => { const st = poDisplayStatus(p, items, movements); return st === 'ordered' || st === 'partial' })
    .reduce((s, p) => s + poTotal(itemsFor(p.id), partsById), 0), [pos, items, movements, partsById]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PageContainer width="wide">
      <PageHeader
        crumb={{ label: 'Equipment', href: '/dashboard/equipment' }}
        title="Purchase orders"
        description="What you ordered, and what actually turned up. Receiving adds to stock through the movement ledger."
        action={<Button onClick={() => setEditing('new')}><Plus className="w-4 h-4" /> New order</Button>}
      />

      {loadError && <Banner tone="danger">{loadError}</Banner>}

      {loading ? <SkeletonRows count={4} /> : (
        <>
          {pos.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <StatTile icon={ClipboardList} label="Orders" value={String(pos.length)} sub="All time" />
              <StatTile icon={Truck} label="Awaiting" value={String(awaiting)}
                tone={awaiting > 0 ? 'info' : undefined} sub={awaiting > 0 ? 'Not fully in' : 'All received'} />
              <StatTile icon={CircleDollarSign} label="On order" value={formatCurrency(onOrderValue)} sub="Not yet received" />
            </div>
          )}

          {pos.length > 0 && (
            <div className="flex items-center gap-1.5 flex-nowrap overflow-x-auto no-scrollbar pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
              <FilterPill active={filter === 'open'} onClick={() => setFilter('open')}>Open</FilterPill>
              {PO_STATUSES.map(s => (
                <FilterPill key={s.value} active={filter === s.value} onClick={() => setFilter(s.value)}>{s.label}</FilterPill>
              ))}
              <FilterPill active={filter === 'all'} onClick={() => setFilter('all')}>All</FilterPill>
            </div>
          )}

          {pos.length === 0 ? (
            <EmptyState icon={ClipboardList} title="No purchase orders yet"
              description="Raise an order against a supplier. When it arrives, receiving it adds the parts to stock through the same ledger the rest of inventory uses."
              action={{ label: 'Create your first order', onClick: () => setEditing('new') }} />
          ) : visible.length === 0 ? (
            <Card><InlineEmpty icon={ClipboardList}>No orders match this filter.</InlineEmpty></Card>
          ) : (
            <div className="space-y-3">
              {visible.map(po => {
                const mine = itemsFor(po.id)
                const st = poDisplayStatus(po, items, movements)
                const sup = po.supplier_id ? supById.get(po.supplier_id) : null
                const total = poTotal(mine, partsById)
                const canReceive = st === 'ordered' || st === 'partial'
                return (
                  <Card key={po.id} className="card-lift">
                    <CardBody>
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-semibold tracking-tight text-ink">
                              {po.po_number?.trim() || 'Purchase order'}
                            </p>
                            <span className={cn('text-[10px] font-semibold uppercase tracking-[0.14em] rounded px-1.5 py-0.5 border', toneSoft[PO_STATUS_TONES[st]])}>
                              {PO_STATUS_LABELS[st]}
                            </span>
                          </div>
                          <p className="text-xs text-ink-muted mt-0.5 tabular-nums">
                            {sup?.name ?? 'No supplier'}
                            {po.ordered_at && <> · ordered {formatDate(po.ordered_at)}</>}
                            {po.expected_at && <> · due {formatDate(po.expected_at)}</>}
                            {total > 0 && <> · {formatCurrency(total)}</>}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {canReceive && (
                            <Button size="sm" onClick={() => setReceiving(po)}>
                              <PackageCheck className="w-3.5 h-3.5" aria-hidden /> Receive
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => setEditing(po)}>Edit</Button>
                        </div>
                      </div>

                      {mine.length > 0 && (
                        <div className="mt-3 space-y-1.5">
                          {mine.map(it => {
                            const part = partsById.get(it.part_id)
                            const got = receivedQty(it.id, movements)
                            const ls = lineState(it, movements)
                            return (
                              <div key={it.id} className="flex items-center justify-between gap-2 text-xs">
                                <span className="min-w-0 truncate text-ink">{part?.name ?? 'Part'}</span>
                                <span className={cn('shrink-0 tabular-nums',
                                  ls === 'received' ? 'text-emerald-400' : ls === 'over' ? 'text-amber-400'
                                  : ls === 'partial' ? 'text-amber-400' : 'text-ink-muted')}>
                                  {got} / {it.qty_ordered}{part && part.unit !== 'each' ? ` ${part.unit}` : ''} received
                                  {ls === 'over' && ' — over'}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </CardBody>
                  </Card>
                )
              })}
            </div>
          )}
        </>
      )}

      {editing && uid && (
        <PoDialog userId={uid} po={editing === 'new' ? null : editing}
          items={editing === 'new' ? [] : itemsFor(editing.id)}
          parts={parts} suppliers={suppliers} movements={movements}
          onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load() }} />
      )}
      {receiving && uid && (
        <ReceiveDialog userId={uid} po={receiving} items={itemsFor(receiving.id)}
          parts={partsById} movements={movements}
          onClose={() => setReceiving(null)} onDone={async () => { setReceiving(null); await load() }} />
      )}
    </PageContainer>
  )
}

// ── Receiving ────────────────────────────────────────────────────────────────
// Defaults to what's still outstanding, so the common case ("it all came") is
// one tap — but every figure stays editable, because partial deliveries and
// over-shipments are the reason this dialog exists.
function ReceiveDialog({ userId, po, items, parts, movements, onClose, onDone }: {
  userId: string; po: PurchaseOrder; items: PurchaseOrderItem[]; parts: Map<string, Part>
  movements: ReceiptMovement[]; onClose: () => void; onDone: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map(i => [i.id, String(outstandingQty(i, movements) || '')])))
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [scanHint, setScanHint] = useState<string | null>(null)

  const anything = items.some(i => Number(qty[i.id]) > 0)

  // Scan-to-receive: scanning a box counts one unit onto the line it belongs to.
  // This is why receiving is worth scanning at all — you're holding the box, not
  // the keyboard. It only fills the FORM; nothing moves until Receive is pressed,
  // so a misfire is fixed by editing a number, not by reversing a stock movement.
  const scanParts = useMemo(
    () => items.map(i => parts.get(i.part_id)).filter(Boolean) as Part[], [items, parts])

  function onScan(part: Part) {
    const line = items.find(i => i.part_id === part.id)
    if (!line) { setScanHint(`${part.name} isn't on this order.`); return }
    setQty(q => {
      const next = (Number(q[line.id]) || 0) + 1
      return { ...q, [line.id]: String(next) }
    })
    setScanHint(`${part.name} +1`)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const { error, received } = await receivePoItems(supabase, {
      userId,
      receipts: items.map(i => ({ item: i, qty: Number(qty[i.id]) || 0 })),
      notes: notes.trim() || `Received against ${po.po_number?.trim() || 'purchase order'}`,
    })
    setSaving(false)
    if (error) { toast.error(error); return }
    // Say what actually moved — the stock figure is the trigger's, not ours.
    toast.success(`Received ${received} line${received !== 1 ? 's' : ''}. Stock updated.`)
    onDone()
  }

  return (
    <Modal open onClose={onClose} title="Receive delivery">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-ink-muted">
          Enter what actually arrived. Receiving writes a stock movement per line — it never edits the count directly.
        </p>

        {/* Scanning only fills the form — nothing moves until Receive. */}
        {scanParts.length > 0 && (
          <div className="rounded-xl border border-border p-3">
            <ScanInput parts={scanParts} onPick={onScan} placeholder="Scan each box to count it in" />
            {scanHint && <p className="mt-1.5 text-xs text-ink-muted">{scanHint}</p>}
          </div>
        )}

        <div className="space-y-2.5">
          {items.map(i => {
            const part = parts.get(i.part_id)
            const out = outstandingQty(i, movements)
            const got = receivedQty(i.id, movements)
            return (
              <div key={i.id} className="flex items-end gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink truncate">{part?.name ?? 'Part'}</p>
                  <p className="text-[11px] text-ink-faint tabular-nums">
                    {got} of {i.qty_ordered} in · {out > 0 ? `${out} outstanding` : 'complete'}
                  </p>
                </div>
                <Input label="Receiving" type="number" step="any" min="0" className="w-28"
                  value={qty[i.id] ?? ''} onChange={e => setQty(q => ({ ...q, [i.id]: e.target.value }))} />
              </div>
            )
          })}
          {items.length === 0 && <InlineEmpty>This order has no lines yet.</InlineEmpty>}
        </div>
        <Textarea label="Note (optional)" rows={2} value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="Packing slip #, who took delivery…" />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving} disabled={!anything}>
            <PackageCheck className="w-4 h-4" aria-hidden /> Receive
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// ── Create / edit a PO ───────────────────────────────────────────────────────
function PoDialog({ userId, po, items, parts, suppliers, movements, onClose, onSaved }: {
  userId: string; po: PurchaseOrder | null; items: PurchaseOrderItem[]; parts: Part[]
  suppliers: Supplier[]; movements: ReceiptMovement[]; onClose: () => void; onSaved: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [supplierId, setSupplierId] = useState(po?.supplier_id ?? '')
  const [poNumber, setPoNumber] = useState(po?.po_number ?? '')
  const [status, setStatus] = useState<PoStatus>(po?.status ?? 'draft')
  const [orderedAt, setOrderedAt] = useState(po?.ordered_at ?? '')
  const [expectedAt, setExpectedAt] = useState(po?.expected_at ?? '')
  const [notes, setNotes] = useState(po?.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [addPart, setAddPart] = useState('')
  const [addQty, setAddQty] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const { error, po: saved } = await savePurchaseOrder(supabase, {
      userId, id: po?.id ?? null,
      values: {
        supplier_id: supplierId || null, po_number: poNumber.trim() || null, status,
        ordered_at: orderedAt || null, expected_at: expectedAt || null, notes: notes.trim() || null,
      },
    })
    setSaving(false)
    if (error) { toast.error(error); return }
    // A new PO needs a line before it can be received — add it in the same breath.
    if (!po && saved && addPart && Number(addQty) > 0) {
      const r = await savePoItem(supabase, { userId, poId: saved.id, partId: addPart, qty: Number(addQty) })
      if (r.error) { toast.error(r.error); return }
    }
    toast.success(po ? 'Order updated.' : 'Order created.')
    onSaved()
  }

  async function onAddLine() {
    if (!po || !addPart || !(Number(addQty) > 0)) return
    const { error } = await savePoItem(supabase, { userId, poId: po.id, partId: addPart, qty: Number(addQty) })
    if (error) { toast.error(error); return }
    setAddPart(''); setAddQty('')
    onSaved()
  }

  async function onRemoveLine(itemId: string) {
    const { error } = await deletePoItem(supabase, itemId)
    if (error) { toast.error(error); return }
    // The CASCADE already returned any received stock — say so, don't imply the
    // owner must go fix the count by hand.
    toast.success('Line removed. Any stock received against it has been returned.')
    onSaved()
  }

  const partOpts = parts.map(p => ({ value: p.id, label: p.name }))

  return (
    <Modal open onClose={onClose} title={po ? 'Edit purchase order' : 'New purchase order'}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select label="Supplier" value={supplierId} onChange={e => setSupplierId(e.target.value)}
            options={[{ value: '', label: '— None —' }, ...suppliers.map(s => ({ value: s.id, label: s.name }))]} />
          <Input label="Order number" value={poNumber} onChange={e => setPoNumber(e.target.value)}
            hint="Your reference, or theirs." />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Select label="Status" value={status} onChange={e => setStatus(e.target.value as PoStatus)}
            options={PO_STATUSES.map(s => ({ value: s.value, label: s.label }))}
            hint="Received is set by receiving, not here." />
          <Input label="Ordered" type="date" value={orderedAt} onChange={e => setOrderedAt(e.target.value)} />
          <Input label="Expected" type="date" value={expectedAt} onChange={e => setExpectedAt(e.target.value)} />
        </div>

        {po && (
          <div className="rounded-xl border border-border p-3 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Lines</p>
            {items.map(i => {
              const part = parts.find(p => p.id === i.part_id)
              const got = receivedQty(i.id, movements)
              return (
                <div key={i.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate text-ink">{part?.name ?? 'Part'}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-ink-muted tabular-nums">{got} / {i.qty_ordered}</span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => onRemoveLine(i.id)}
                      aria-label={`Remove ${part?.name ?? 'line'}`}
                      title={got > 0 ? 'Removing returns the received stock' : 'Remove line'}>
                      <Trash2 className="w-3.5 h-3.5" aria-hidden />
                    </Button>
                  </span>
                </div>
              )
            })}
            {items.length === 0 && <p className="text-xs text-ink-faint">No lines yet.</p>}
            <div className="flex items-end gap-2 pt-1">
              <Select label="Add part" value={addPart} onChange={e => setAddPart(e.target.value)}
                options={[{ value: '', label: '— Pick a part —' }, ...partOpts]} className="flex-1" />
              <Input label="Qty" type="number" step="any" min="0" className="w-24"
                value={addQty} onChange={e => setAddQty(e.target.value)} />
              <Button type="button" variant="secondary" onClick={onAddLine} disabled={!addPart || !(Number(addQty) > 0)}>Add</Button>
            </div>
          </div>
        )}

        {!po && (
          <div className="flex items-end gap-2">
            <Select label="First line (optional)" value={addPart} onChange={e => setAddPart(e.target.value)}
              options={[{ value: '', label: '— Pick a part —' }, ...partOpts]} className="flex-1" />
            <Input label="Qty" type="number" step="any" min="0" className="w-24"
              value={addQty} onChange={e => setAddQty(e.target.value)} />
          </div>
        )}

        <Textarea label="Notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
          <Button type="submit" loading={saving}>{po ? 'Save order' : 'Create order'}</Button>
        </div>
      </form>
    </Modal>
  )
}
