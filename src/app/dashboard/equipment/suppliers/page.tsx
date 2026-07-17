'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import {
  Supplier, SupplierFormValues, PartWithSupplier,
  loadSuppliers, saveSupplier, archiveSupplier, partsForSupplier, isLegacySupplier, sortSuppliers,
} from '@/lib/suppliers'
import { partValue } from '@/lib/parts'
import { loadPurchaseOrders, vendorHistory, type PurchaseOrder, type PurchaseOrderItem, type ReceiptMovement } from '@/lib/purchasing'
import { formatCurrency, cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { StatTile } from '@/components/ui/StatTile'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Banner } from '@/components/ui/Banner'
import { Modal } from '@/components/ui/Modal'
import { Truck, Plus, Pencil, Archive, ArchiveRestore, Phone, Mail, Globe, Package, Link2, ClipboardList } from 'lucide-react'

// ── Suppliers ────────────────────────────────────────────────────────────────
// Who you buy from. A supplier is a COUNTERPARTY, not an inventory system: this
// page owns no stock, no counts and no location. Stock stays derived from
// part_movements by the DB trigger — nothing here writes qty_on_hand.
//
// Shelf value per vendor reuses THE parts engine (partValue), so a vendor's
// number can never disagree with the parts page it came from.
//
// Purchase history (orders + spend) comes from lib/purchasing.vendorHistory,
// which values what actually ARRIVED — it reads the receipt movements, not what
// was ordered. An ordered-but-undelivered PO is not money spent.

const EMPTY: SupplierFormValues = {
  name: '', contact_name: '', phone: '', email: '', website: '', account_number: '', address: '', notes: '',
}

export default function SuppliersPage() {
  const supabase = useMemo(() => createClient(), [])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [parts, setParts] = useState<PartWithSupplier[]>([])
  // Purchase history — spend is only claimable now that receipts exist.
  const [pos, setPos] = useState<PurchaseOrder[]>([])
  const [poItems, setPoItems] = useState<PurchaseOrderItem[]>([])
  const [receipts, setReceipts] = useState<ReceiptMovement[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [uid, setUid] = useState<string | null>(null)
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  async function load() {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setLoading(false); return }
    setUid(user.id)
    const [rows, pRes, po] = await Promise.all([
      loadSuppliers(supabase, { includeArchived: true }),
      supabase.from('parts').select('*').eq('user_id', user.id),
      loadPurchaseOrders(supabase),
    ])
    // Never render a vendor list that silently lost its parts: an error here
    // would otherwise show every supplier as "0 parts".
    if (pRes.error) { setLoadError('Could not load parts: ' + pRes.error.message); setLoading(false); return }
    setLoadError(null)
    setSuppliers(rows)
    setParts((pRes.data as PartWithSupplier[]) || [])
    setPos(po.pos); setPoItems(po.items); setReceipts(po.movements)
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useRealtimeRefresh('suppliers', uid ? `user_id=eq.${uid}` : null, load)

  const visible = useMemo(
    () => sortSuppliers(suppliers).filter(s => showArchived || !s.archived_at),
    [suppliers, showArchived],
  )
  const archivedCount = suppliers.filter(s => s.archived_at).length
  // The nudge that makes linking worth doing: parts still on the legacy text.
  const unlinked = useMemo(() => parts.filter(isLegacySupplier), [parts])

  async function onArchive(s: Supplier) {
    const next = !s.archived_at
    const { error } = await archiveSupplier(supabase, s.id, next)
    if (error) { toast.error(error); return }
    await load()
    toast.success(next ? `${s.name} archived.` : `${s.name} restored.`)
  }

  return (
    <PageContainer width="wide">
      <PageHeader
        crumb={{ label: 'Equipment', href: '/dashboard/equipment' }}
        title="Suppliers"
        description="Who you buy from — contacts, account numbers, and what you get from each."
        action={<Button onClick={() => setEditing('new')}><Plus className="w-4 h-4" /> Add supplier</Button>}
      />

      {loadError && <Banner tone="danger">{loadError}</Banner>}

      {loading ? (
        <SkeletonRows count={4} />
      ) : (
        <>
          {suppliers.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <StatTile icon={Truck} label="Suppliers" value={String(suppliers.filter(s => !s.archived_at).length)} sub="Active" />
              <StatTile icon={Package} label="Parts linked" value={String(parts.filter(p => p.supplier_id).length)} sub={`of ${parts.length}`} />
              {/* Not an error state — just the work left to do, and only shown
                  when there IS some. */}
              <StatTile icon={Link2} label="Unlinked" value={String(unlinked.length)}
                tone={unlinked.length > 0 ? 'warn' : undefined}
                sub={unlinked.length > 0 ? 'Typed name only' : 'All linked'} />
            </div>
          )}

          {suppliers.length === 0 ? (
            <EmptyState icon={Truck} title="No suppliers yet"
              description="Add the dealers and shops you buy parts from. You'll be able to attach them to parts, and to purchase orders."
              action={{ label: 'Add your first supplier', onClick: () => setEditing('new') }} />
          ) : (
            <div className="space-y-3">
              {visible.map(s => {
                const theirParts = partsForSupplier(s.id, parts)
                const shelf = theirParts.reduce((sum, p) => sum + partValue(p), 0)
                const hist = vendorHistory(s.id, pos, poItems, receipts)
                return (
                  <Card key={s.id} className={cn('card-lift', s.archived_at && 'opacity-60')}>
                    <CardBody className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold tracking-tight text-ink">{s.name}</p>
                          {s.archived_at && (
                            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint border border-border rounded px-1.5 py-0.5">Archived</span>
                          )}
                          {s.account_number && (
                            <span className="text-[10px] text-ink-faint tabular-nums">Acct {s.account_number}</span>
                          )}
                        </div>
                        {s.contact_name && <p className="text-xs text-ink-muted mt-0.5">{s.contact_name}</p>}
                        <div className="flex items-center gap-x-4 gap-y-1 mt-1.5 flex-wrap text-xs">
                          {s.phone && (
                            <a href={`tel:${s.phone}`} aria-label={`Call ${s.name}`}
                              className="flex items-center gap-1 text-accent-text hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                              <Phone className="w-3 h-3" aria-hidden />{s.phone}
                            </a>
                          )}
                          {s.email && (
                            <a href={`mailto:${s.email}`} aria-label={`Email ${s.name}`}
                              className="flex items-center gap-1 text-ink-muted hover:text-ink rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                              <Mail className="w-3 h-3" aria-hidden />{s.email}
                            </a>
                          )}
                          {s.website && (
                            <a href={s.website.startsWith('http') ? s.website : `https://${s.website}`} target="_blank" rel="noopener noreferrer"
                              aria-label={`Website for ${s.name}`}
                              className="flex items-center gap-1 text-ink-muted hover:text-ink rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                              <Globe className="w-3 h-3" aria-hidden />Website
                            </a>
                          )}
                        </div>
                        {/* Vendor history, as far as it can honestly go today:
                            what you buy from them + what that shelf is worth.
                            Spend arrives with purchase orders. */}
                        {/* Purchase history: orders + money against goods that
                            ACTUALLY arrived — vendorHistory reads the receipt
                            movements, not what was ordered. */}
                        {hist.orders > 0 && (
                          <p className="text-xs text-ink-muted mt-1.5 tabular-nums flex items-center gap-1">
                            <ClipboardList className="w-3 h-3 text-ink-faint" aria-hidden />
                            {hist.orders} order{hist.orders !== 1 ? 's' : ''}
                            {hist.spend > 0 && <> · {formatCurrency(hist.spend)} received</>}
                          </p>
                        )}
                        <p className="text-xs text-ink-muted mt-2 tabular-nums">
                          {theirParts.length > 0 ? (
                            <>
                              <Link href="/dashboard/equipment/parts" className="text-accent-text hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                                {theirParts.length} part{theirParts.length !== 1 ? 's' : ''}
                              </Link>
                              {shelf > 0 && <> · {formatCurrency(shelf)} on the shelf</>}
                            </>
                          ) : (
                            <span className="text-ink-faint">No parts linked yet</span>
                          )}
                        </p>
                        {s.notes && <p className="text-xs text-ink-faint mt-1.5 line-clamp-2">{s.notes}</p>}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>
                          <Pencil className="w-3.5 h-3.5" aria-hidden />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => onArchive(s)}
                          aria-label={s.archived_at ? `Restore ${s.name}` : `Archive ${s.name}`}
                          title={s.archived_at ? 'Restore' : 'Archive — parts keep their link'}>
                          {s.archived_at ? <ArchiveRestore className="w-3.5 h-3.5" aria-hidden /> : <Archive className="w-3.5 h-3.5" aria-hidden />}
                        </Button>
                      </div>
                    </CardBody>
                  </Card>
                )
              })}
              {visible.length === 0 && <Card><InlineEmpty icon={Truck}>Every supplier is archived.</InlineEmpty></Card>}
              {archivedCount > 0 && (
                <button onClick={() => setShowArchived(v => !v)}
                  className="text-xs font-medium text-ink-muted hover:text-ink rounded px-1.5 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  {showArchived ? 'Hide' : 'Show'} {archivedCount} archived
                </button>
              )}
            </div>
          )}
        </>
      )}

      {editing && uid && (
        <SupplierDialog
          userId={uid}
          supplier={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load() }}
        />
      )}
    </PageContainer>
  )
}

function SupplierDialog({ userId, supplier, onClose, onSaved }: {
  userId: string; supplier: Supplier | null; onClose: () => void; onSaved: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [v, setV] = useState<SupplierFormValues>(supplier ? {
    name: supplier.name, contact_name: supplier.contact_name, phone: supplier.phone, email: supplier.email,
    website: supplier.website, account_number: supplier.account_number, address: supplier.address, notes: supplier.notes,
  } : EMPTY)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<SupplierFormValues>) => setV(p => ({ ...p, ...patch }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const { error } = await saveSupplier(supabase, { userId, id: supplier?.id ?? null, values: v })
    setSaving(false)
    if (error) { toast.error(error); return }
    toast.success(supplier ? 'Supplier updated.' : 'Supplier added.')
    onSaved()
  }

  return (
    <Modal open onClose={onClose} title={supplier ? 'Edit supplier' : 'Add supplier'}>
      <form onSubmit={submit} className="space-y-4">
        <Input label="Name" autoFocus required value={v.name ?? ''} onChange={e => set({ name: e.target.value })} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Contact name" value={v.contact_name ?? ''} onChange={e => set({ contact_name: e.target.value })} />
          <Input label="Account number" value={v.account_number ?? ''} onChange={e => set({ account_number: e.target.value })}
            hint="Your account with them — handy when ordering." />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Phone" type="tel" value={v.phone ?? ''} onChange={e => set({ phone: e.target.value })} />
          <Input label="Email" type="email" value={v.email ?? ''} onChange={e => set({ email: e.target.value })} />
        </div>
        <Input label="Website" value={v.website ?? ''} onChange={e => set({ website: e.target.value })} />
        <Input label="Address" value={v.address ?? ''} onChange={e => set({ address: e.target.value })} />
        <Textarea label="Notes" rows={3} value={v.notes ?? ''} onChange={e => set({ notes: e.target.value })} />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>{supplier ? 'Save supplier' : 'Add supplier'}</Button>
        </div>
      </form>
    </Modal>
  )
}
