'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { Part, PartMovement, stockStatus, inventorySummary } from '@/lib/parts'
import {
  loadPurchaseOrders, vendorHistory,
  type PurchaseOrder, type PurchaseOrderItem, type ReceiptMovement,
} from '@/lib/purchasing'
import { Supplier, loadSuppliers } from '@/lib/suppliers'
import {
  valuation, reorderList, reorderBySupplier, runningOutSoon, purchaseStats,
  topPartsBySpend, vendorStats, usageForecast, costDrift, type ReorderLine,
} from '@/lib/inventory/analytics'
import { toneSoft } from '@/lib/tone'
import { formatCurrency, cn } from '@/lib/utils'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Banner } from '@/components/ui/Banner'
import { Tabs, type TabItem } from '@/components/ui/Tabs'
import { ScanInput } from '@/components/inventory/ScanInput'
import {
  Boxes, CircleDollarSign, TriangleAlert, TrendingDown, ClipboardList,
  Truck, ScanLine, ArrowRight, Package,
} from 'lucide-react'

// ── Inventory dashboard ──────────────────────────────────────────────────────
// Valuation, what to reorder, what's running out, and what you've been buying.
//
// IT COMPUTES NOTHING ITSELF. Every figure is delegated: inventorySummary() for
// the rollup, stockStatus() for low/out, partValue() for shelf value, and
// lib/inventory/analytics for the derived questions (all pure, all reading the
// same movement ledger). Nothing on this page writes — stock is only ever
// sum(part_movements.qty), recomputed by the trigger.
//
// ⚠️ Forecasts render ONLY where the history earns them. A part with no usage
// shows no projection, not "0 days left" — see analytics.usageForecast.

const TABS: TabItem[] = [
  { key: 'overview', label: 'Overview', icon: Boxes },
  { key: 'reorder', label: 'Reorder', icon: TriangleAlert },
  { key: 'value', label: 'Valuation', icon: CircleDollarSign },
  { key: 'buying', label: 'Buying', icon: ClipboardList },
]
type Tab = (typeof TABS)[number]['key']

export default function InventoryDashboard() {
  const supabase = useMemo(() => createClient(), [])
  const [parts, setParts] = useState<Part[]>([])
  const [movements, setMovements] = useState<PartMovement[]>([])
  const [pos, setPos] = useState<PurchaseOrder[]>([])
  const [poItems, setPoItems] = useState<PurchaseOrderItem[]>([])
  const [receipts, setReceipts] = useState<ReceiptMovement[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [uid, setUid] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [scanned, setScanned] = useState<Part | null>(null)

  async function load() {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setLoading(false); return }
    setUid(user.id)
    const [pRes, mRes, po, sup] = await Promise.all([
      supabase.from('parts').select('*').eq('user_id', user.id),
      supabase.from('part_movements').select('*').eq('user_id', user.id),
      loadPurchaseOrders(supabase),
      loadSuppliers(supabase, { includeArchived: true }),
    ])
    // Never render a dashboard that lost its ledger: every part would read as
    // "no usage", every forecast would go silent, and the page would look calm
    // while being blind.
    const err = pRes.error?.message || mRes.error?.message || po.error
    if (err) { setLoadError('Could not load inventory: ' + err); setLoading(false); return }
    setLoadError(null)
    setParts((pRes.data as Part[]) || [])
    setMovements((mRes.data as PartMovement[]) || [])
    setPos(po.pos); setPoItems(po.items); setReceipts(po.movements)
    setSuppliers(sup)
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useRealtimeRefresh('part_movements', uid ? `user_id=eq.${uid}` : null, load)
  useRealtimeRefresh('parts', uid ? `user_id=eq.${uid}` : null, load)

  const partsById = useMemo(() => new Map(parts.map(p => [p.id, p])), [parts])
  const supById = useMemo(() => new Map(suppliers.map(s => [s.id, s])), [suppliers])
  const summary = useMemo(() => inventorySummary(parts), [parts])
  const val = useMemo(() => valuation(parts), [parts])
  const reorder = useMemo(() => reorderList(parts, movements), [parts, movements])
  const soon = useMemo(() => runningOutSoon(parts, movements, { withinDays: 30 }), [parts, movements])
  const buying = useMemo(() => purchaseStats(pos, poItems, receipts, partsById), [pos, poItems, receipts, partsById])

  return (
    <PageContainer width="wide">
      <PageHeader
        crumb={{ label: 'Equipment', href: '/dashboard/equipment' }}
        title="Inventory"
        description="What's on the shelf, what it's worth, and what to buy before a crew goes without."
        action={
          <div className="flex items-center gap-2">
            <Link href="/dashboard/equipment/parts"><Button variant="secondary"><Package className="w-4 h-4" /> Parts</Button></Link>
            <Link href="/dashboard/equipment/purchase-orders"><Button variant="secondary"><ClipboardList className="w-4 h-4" /> Orders</Button></Link>
          </div>
        }
      />

      {loadError && <Banner tone="danger">{loadError}</Banner>}

      {loading ? <SkeletonRows count={5} /> : parts.length === 0 ? (
        <EmptyState icon={Boxes} title="No parts yet"
          description="Add the parts you keep on the shelf. Once you're logging what you use, this page will show what it's worth, what's running low, and what to reorder."
          action={{ label: 'Add parts', href: '/dashboard/equipment/parts' }} />
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
            <StatTile icon={CircleDollarSign} label="Shelf value" value={formatCurrency(summary.shelfValue)} sub={`${summary.partCount} parts`} />
            <StatTile icon={TriangleAlert} label="To reorder" value={String(summary.needingReorder)}
              tone={summary.needingReorder > 0 ? 'warn' : undefined}
              sub={summary.outCount > 0 ? `${summary.outCount} out` : 'None out'} />
            <StatTile icon={TrendingDown} label="Running out" value={String(soon.length)}
              tone={soon.length > 0 ? 'warn' : undefined} sub="Next 30 days" />
            <StatTile icon={ClipboardList} label="On order" value={formatCurrency(buying.onOrderValue)}
              sub={buying.openOrders > 0 ? `${buying.openOrders} open` : 'Nothing open'} />
          </div>

          <Tabs tabs={TABS} active={tab} onChange={k => setTab(k as Tab)} />

          {tab === 'overview' && (
            <div className="space-y-3">
              <Card>
                <CardBody className="space-y-3">
                  <div className="flex items-center gap-2">
                    <ScanLine className="w-4 h-4 text-ink-faint" aria-hidden />
                    <p className="text-sm font-semibold tracking-tight text-ink">Find a part</p>
                  </div>
                  {/* Scanning reads the SKU you already keep — no new field. */}
                  <ScanInput parts={parts} onPick={setScanned} />
                  {scanned && <ScannedPart part={scanned} movements={movements} receipts={receipts} />}
                </CardBody>
              </Card>

              <Card>
                <CardBody>
                  <p className="text-sm font-semibold tracking-tight text-ink mb-1">Running out soon</p>
                  <p className="text-xs text-ink-muted mb-3">
                    Projected from what you&apos;ve actually used. Parts without enough history aren&apos;t guessed at.
                  </p>
                  {soon.length === 0 ? (
                    <InlineEmpty icon={TrendingDown}>
                      Nothing is forecast to run out in the next 30 days.
                    </InlineEmpty>
                  ) : (
                    <div className="space-y-2">
                      {soon.slice(0, 6).map(({ part, forecast }) => (
                        <div key={part.id} className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm text-ink truncate">{part.name}</p>
                            <p className="text-[11px] text-ink-faint">{forecast.basis}</p>
                          </div>
                          <span className={cn('shrink-0 text-xs font-semibold tabular-nums rounded px-1.5 py-0.5 border',
                            toneSoft[forecast.daysLeft! <= 7 ? 'danger' : 'warn'])}>
                            {forecast.daysLeft}d left
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardBody>
              </Card>
            </div>
          )}

          {tab === 'reorder' && (
            <ReorderCenter lines={reorder} supById={supById} groups={reorderBySupplier(reorder)} />
          )}

          {tab === 'value' && <ValuationTab val={val} receipts={receipts} />}

          {tab === 'buying' && (
            <BuyingTab stats={buying} pos={pos} items={poItems} receipts={receipts}
              partsById={partsById} suppliers={suppliers} />
          )}
        </>
      )}
    </PageContainer>
  )
}

// ── The scanned part ─────────────────────────────────────────────────────────
function ScannedPart({ part, movements, receipts }: {
  part: Part; movements: PartMovement[]; receipts: ReceiptMovement[]
}) {
  const st = stockStatus(part)
  const f = usageForecast(part, movements)
  const drift = costDrift(part, receipts)
  return (
    <div className="rounded-xl border border-border p-3 rise">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{part.name}</p>
          {part.sku && <p className="text-[11px] text-ink-faint tabular-nums">SKU {part.sku}</p>}
        </div>
        <span className={cn('text-[10px] font-semibold uppercase tracking-[0.14em] rounded px-1.5 py-0.5 border', toneSoft[st.tone])}>
          {st.reason}
        </span>
      </div>
      <div className="mt-2 space-y-0.5">
        {/* Say what the forecast stands on, always — including "nothing". */}
        <p className="text-xs text-ink-muted">{f.basis}</p>
        {f.daysLeft !== null && f.confidence === 'good' && (
          <p className="text-xs text-ink">About <span className="font-semibold tabular-nums">{f.daysLeft} days</span> left at that rate.</p>
        )}
        {drift && Math.abs(drift.pct) >= 5 && (
          <p className="text-xs text-ink-muted tabular-nums">
            Paying {formatCurrency(drift.avg)} on average · now {formatCurrency(Number(part.unit_cost) || 0)}
            <span className={drift.delta > 0 ? ' text-amber-400' : ' text-emerald-400'}>
              {' '}({drift.delta > 0 ? '+' : ''}{drift.pct}%)
            </span>
          </p>
        )}
      </div>
      <Link href="/dashboard/equipment/parts" className="text-xs text-accent hover:underline mt-2 inline-flex items-center gap-1">
        Open in Parts <ArrowRight className="w-3 h-3" aria-hidden />
      </Link>
    </div>
  )
}

// ── Reorder center ───────────────────────────────────────────────────────────
// Grouped by vendor, because that's how you actually buy: one order, one trip,
// one conversation. stockStatus() decides who's on this list — the forecast only
// ranks it and sizes the suggestion.
function ReorderCenter({ lines, groups, supById }: {
  lines: ReorderLine[]
  groups: Map<string | null, ReorderLine[]>
  supById: Map<string, Supplier>
}) {
  if (lines.length === 0) {
    return (
      <Card>
        <InlineEmpty icon={TriangleAlert}>
          Nothing needs reordering — every tracked part is above its reorder point.
        </InlineEmpty>
      </Card>
    )
  }
  return (
    <div className="space-y-3">
      {[...groups.entries()].map(([supplierId, group]) => {
        const sup = supplierId ? supById.get(supplierId) : null
        return (
          <Card key={supplierId ?? 'none'} className="card-lift">
            <CardBody>
              <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                <div className="flex items-center gap-2">
                  <Truck className="w-4 h-4 text-ink-faint" aria-hidden />
                  <p className="text-sm font-semibold tracking-tight text-ink">{sup?.name ?? 'No supplier set'}</p>
                  <span className="text-[11px] text-ink-faint tabular-nums">{group.length} part{group.length !== 1 ? 's' : ''}</span>
                </div>
                {/* Raising the PO is milestone 2's job — link, don't rebuild it. */}
                <Link href="/dashboard/equipment/purchase-orders">
                  <Button variant="secondary" size="sm"><ClipboardList className="w-3.5 h-3.5" /> Raise an order</Button>
                </Link>
              </div>
              <div className="space-y-2">
                {group.map(l => (
                  <div key={l.part.id} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm text-ink truncate">{l.part.name}</p>
                      <p className="text-[11px] text-ink-faint">{l.status.reason}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      {/* A suggestion only where usage earns it. Otherwise the
                          owner decides — we don't invent a number to fill space. */}
                      {l.suggestQty != null ? (
                        <>
                          <p className="text-xs font-semibold text-ink tabular-nums">Order ~{l.suggestQty}</p>
                          <p className="text-[10px] text-ink-faint">60 days&apos; cover</p>
                        </>
                      ) : (
                        <p className="text-[11px] text-ink-faint">No usage history yet</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {!sup && (
                <p className="text-[11px] text-ink-faint mt-3">
                  Link these parts to a supplier and they&apos;ll group into one order.
                </p>
              )}
            </CardBody>
          </Card>
        )
      })}
    </div>
  )
}

// ── Valuation ────────────────────────────────────────────────────────────────
function ValuationTab({ val, receipts }: { val: ReturnType<typeof valuation>; receipts: ReceiptMovement[] }) {
  const withValue = val.rows.filter(r => r.value > 0)
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
        <StatTile icon={CircleDollarSign} label="Shelf value" value={formatCurrency(val.total)} sub="At current cost" />
        <StatTile icon={TriangleAlert} label="At risk" value={formatCurrency(val.atRiskValue)}
          tone={val.atRiskValue > 0 ? 'warn' : undefined} sub="Low or out" />
        <StatTile icon={Boxes} label="Untracked" value={formatCurrency(val.untrackedValue)}
          sub="No reorder point" />
      </div>
      <Card>
        <CardBody>
          <p className="text-sm font-semibold tracking-tight text-ink mb-1">Where the money sits</p>
          <p className="text-xs text-ink-muted mb-3">Valued at each part&apos;s current cost — the same figure the parts page shows.</p>
          {withValue.length === 0 ? (
            <InlineEmpty icon={CircleDollarSign}>No part has a unit cost set yet, so there&apos;s nothing to value.</InlineEmpty>
          ) : (
            <div className="space-y-2">
              {withValue.slice(0, 12).map(r => {
                const drift = costDrift(r.part, receipts)
                return (
                  <div key={r.part.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="min-w-0 truncate text-ink">{r.part.name}</span>
                      <span className="shrink-0 tabular-nums text-ink-muted">
                        {formatCurrency(r.value)}
                        {drift && Math.abs(drift.pct) >= 5 && (
                          <span className={drift.delta > 0 ? ' text-amber-400' : ' text-emerald-400'}>
                            {' '}{drift.delta > 0 ? '+' : ''}{drift.pct}%
                          </span>
                        )}
                      </span>
                    </div>
                    {/* CSS bar — the repo draws its own charts; no chart lib. */}
                    <div className="h-1 rounded-full bg-surface-2 overflow-hidden">
                      <div className="h-full bg-accent/60 rounded-full" style={{ width: `${Math.max(2, r.share * 100)}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

// ── Buying ───────────────────────────────────────────────────────────────────
function BuyingTab({ stats, pos, items, receipts, partsById, suppliers }: {
  stats: ReturnType<typeof purchaseStats>
  pos: PurchaseOrder[]; items: PurchaseOrderItem[]; receipts: ReceiptMovement[]
  partsById: Map<string, Part>; suppliers: Supplier[]
}) {
  const top = useMemo(() => topPartsBySpend(items, receipts, partsById, 6), [items, receipts, partsById])
  const vendors = useMemo(() => suppliers
    .map(s => ({ s, h: vendorHistory(s.id, pos, items, receipts), v: vendorStats(s.id, pos, items, receipts) }))
    .filter(r => r.h.orders > 0)
    .sort((a, b) => b.h.spend - a.h.spend), [suppliers, pos, items, receipts])

  if (pos.length === 0) {
    return <Card><InlineEmpty icon={ClipboardList}>No purchase orders yet — raise one and this fills in.</InlineEmpty></Card>
  }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
        <StatTile icon={CircleDollarSign} label="Received" value={formatCurrency(stats.received)} sub="Goods that arrived" />
        <StatTile icon={ClipboardList} label="On order" value={formatCurrency(stats.onOrderValue)} sub="Still outstanding" />
        <StatTile icon={Boxes} label="Orders in" value={String(stats.receivedOrders)} sub={`${stats.openOrders} still open`} />
      </div>

      <Card>
        <CardBody>
          <p className="text-sm font-semibold tracking-tight text-ink mb-1">What you buy most</p>
          <p className="text-xs text-ink-muted mb-3">By money against goods that actually arrived — not what was ordered.</p>
          {top.length === 0 ? (
            <InlineEmpty icon={Package}>Nothing received yet.</InlineEmpty>
          ) : (
            <div className="space-y-1.5">
              {top.map(t => (
                <div key={t.part.id} className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate text-ink">{t.part.name}</span>
                  <span className="shrink-0 tabular-nums text-ink-muted">{t.qty} in · {formatCurrency(t.spend)}</span>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <p className="text-sm font-semibold tracking-tight text-ink mb-1">Vendors</p>
          <p className="text-xs text-ink-muted mb-3">
            Delivery record read from when things actually arrived. Orders with no expected date aren&apos;t counted late.
          </p>
          {vendors.length === 0 ? (
            <InlineEmpty icon={Truck}>No vendor has an order against them yet.</InlineEmpty>
          ) : (
            <div className="space-y-2.5">
              {vendors.map(({ s, h, v }) => (
                <div key={s.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-ink truncate">{s.name}</p>
                    <p className="text-[11px] text-ink-faint tabular-nums">
                      {h.orders} order{h.orders !== 1 ? 's' : ''} · {formatCurrency(h.spend)} received
                      {v.openOrders > 0 && <> · {v.openOrders} open</>}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    {/* null, not 0% — an unmeasurable record is not a bad one. */}
                    {v.onTimeRate != null ? (
                      <p className={cn('text-xs font-semibold tabular-nums',
                        v.onTimeRate >= 0.8 ? 'text-emerald-400' : 'text-amber-400')}>
                        {Math.round(v.onTimeRate * 100)}% on time
                      </p>
                    ) : (
                      <p className="text-[11px] text-ink-faint">No dated deliveries</p>
                    )}
                    {v.avgLeadDays != null && (
                      <p className="text-[10px] text-ink-faint tabular-nums">~{v.avgLeadDays}d lead</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
