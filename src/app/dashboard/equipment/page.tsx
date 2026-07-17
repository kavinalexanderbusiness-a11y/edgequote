'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { listEquipmentDocs } from '@/lib/equipmentDocs'
import { type Part } from '@/lib/parts'
import {
  Equipment, EquipmentService, EquipmentStatus, STATUS_LABELS, STATUS_TONE,
  categoryMeta, serviceStatus, serviceKindLabel, costOfOwnership, fleetSummary, warrantyStatus, bookValue, type EquipmentDoc,
} from '@/lib/equipment'
import { toneSoft, toneText } from '@/lib/tone'
import { formatCurrency, formatDate, localTodayISO, cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { FilterPill } from '@/components/ui/FilterPill'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Banner } from '@/components/ui/Banner'
import { EquipmentDialog } from '@/components/equipment/EquipmentDialog'
import { EquipmentDocs } from '@/components/equipment/EquipmentDocs'
import { ServiceLogDialog } from '@/components/equipment/ServiceLogDialog'
import { Wrench, Plus, AlertTriangle, CircleDollarSign, Gauge, Pencil, Trash2, History, Clock, ShieldCheck, Package, Truck, ClipboardList, Boxes } from 'lucide-react'

// ── Equipment ────────────────────────────────────────────────────────────────
// The fleet: what you own, what it's costing, and what needs servicing before it
// strands a crew. Every judgement (due / due soon, cost per hour, the rollup) is
// read from THE equipment engine (lib/equipment) — this page only renders it.
type Filter = 'all' | EquipmentStatus | 'needs_service'

export default function EquipmentPage() {
  const supabase = useMemo(() => createClient(), [])
  const [equipment, setEquipment] = useState<Equipment[]>([])
  const [services, setServices] = useState<EquipmentService[]>([])
  const [docs, setDocs] = useState<EquipmentDoc[]>([])
  const [parts, setParts] = useState<Part[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [uid, setUid] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [editing, setEditing] = useState<Equipment | null | 'new'>(null)
  const [logFor, setLogFor] = useState<Equipment | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const today = localTodayISO()

  async function load() {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      setUid(user.id)
      const [eRes, sRes] = await Promise.all([
        supabase.from('equipment').select('*').eq('user_id', user.id).order('created_at', { ascending: false }),
        supabase.from('equipment_service').select('*').eq('user_id', user.id).order('service_date', { ascending: false }),
      ])
      if (eRes.error) {
        setLoadError(eRes.error.message.includes('does not exist')
          ? 'Equipment isn’t set up yet — run supabase/RUN-2026-07-15-equipment.sql, then reload.'
          : 'Could not load your equipment: ' + eRes.error.message)
        return
      }
      setLoadError(null)
      setEquipment((eRes.data as Equipment[]) || [])
      setServices((sRes.data as EquipmentService[]) || [])
      // Paperwork is optional — a tree without the docs migration still works.
      setDocs(await listEquipmentDocs(supabase, user.id).catch(() => []))
      // The shelf, so a service can consume it. Absent migration → simply no parts.
      const pRes = await supabase.from('parts').select('*').eq('user_id', user.id).order('name')
      setParts((pRes.data as Part[]) || [])
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your equipment.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useRealtimeRefresh('equipment', uid ? `user_id=eq.${uid}` : null, load)

  // ONE rollup, from the engine — the tiles can never drift from the list.
  const summary = useMemo(() => fleetSummary(equipment, services, today), [equipment, services, today])

  const visible = useMemo(() => equipment.filter(e => {
    if (filter === 'all') return true
    if (filter === 'needs_service') {
      const s = serviceStatus(e, today).state
      return e.status !== 'retired' && (s === 'due' || s === 'due_soon')
    }
    return e.status === filter
  }), [equipment, filter, today])

  async function remove(eq: Equipment) {
    const ok = await confirmDialog({
      title: `Remove ${eq.name}?`,
      message: 'Its whole service history goes with it. If the machine is just off the road, set it to Retired instead — that keeps the record.',
      confirmLabel: 'Remove permanently', destructive: true,
    })
    if (!ok) return
    const { error } = await supabase.from('equipment').delete().eq('id', eq.id)
    if (error) { toast.error('Could not remove it: ' + error.message); return }
    setEquipment(prev => prev.filter(e => e.id !== eq.id))
    toast.success(`${eq.name} removed.`)
  }

  async function setStatus(eq: Equipment, status: EquipmentStatus) {
    const prev = eq.status
    setEquipment(list => list.map(e => e.id === eq.id ? { ...e, status } : e))
    const { error } = await supabase.from('equipment').update({ status }).eq('id', eq.id)
    if (error) {
      setEquipment(list => list.map(e => e.id === eq.id ? { ...e, status: prev } : e))
      toast.error('Could not update: ' + error.message); return
    }
    toast.undo(`${eq.name} → ${STATUS_LABELS[status]}`, async () => {
      await supabase.from('equipment').update({ status: prev }).eq('id', eq.id)
      setEquipment(list => list.map(e => e.id === eq.id ? { ...e, status: prev } : e))
    })
  }

  if (loading) return <PageContainer><SkeletonRows count={5} /></PageContainer>

  return (
    <PageContainer>
      <PageHeader
        title="Equipment"
        description="Your fleet, what it costs to run, and what's due for service before it strands a crew."
        action={
          <div className="flex items-center gap-2 flex-wrap">
            {/* The shelf as a whole: value, what to reorder, what it costs. */}
            <Link href="/dashboard/equipment/inventory">
              <Button variant="secondary"><Boxes className="w-4 h-4" /> Inventory</Button>
            </Link>
            <Link href="/dashboard/equipment/parts">
              <Button variant="secondary"><Package className="w-4 h-4" /> Parts</Button>
            </Link>
            {/* The shelf's two other halves: who you buy from, and what's on
                order. Reachable from the fleet, not buried behind a URL. */}
            <Link href="/dashboard/equipment/suppliers">
              <Button variant="secondary"><Truck className="w-4 h-4" /> Suppliers</Button>
            </Link>
            <Link href="/dashboard/equipment/purchase-orders">
              <Button variant="secondary"><ClipboardList className="w-4 h-4" /> Orders</Button>
            </Link>
            <Button onClick={() => setEditing('new')}><Plus className="w-4 h-4" /> Add equipment</Button>
          </div>
        }
      />

      {loadError && (
        <Banner tone="danger" icon={AlertTriangle}
          action={<button type="button" onClick={() => { setLoading(true); load() }} className="shrink-0 underline font-semibold">Retry</button>}>
          {loadError}
        </Banner>
      )}

      {!loadError && equipment.length === 0 && (
        <EmptyState
          icon={Wrench}
          title="No equipment yet"
          description="Add your mowers, trimmers and trucks to track service intervals, downtime and what each machine really costs per hour."
          action={{ label: 'Add your first machine', onClick: () => setEditing('new') }}
        />
      )}

      {equipment.length > 0 && (
        <>
          {/* Fleet at a glance — every figure from the engine's rollup. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile icon={Gauge} label="In service" value={String(summary.activeCount)}
              sub={summary.repairCount ? `${summary.repairCount} in the shop` : 'All machines available'} />
            <StatTile icon={Wrench} label="Needs service" value={String(summary.needingService)}
              tone={summary.needingService ? 'warn' : 'success'} tonedSurface={summary.needingService > 0}
              sub={summary.needingService ? 'Due or due soon' : 'Nothing due'}
              onClick={() => setFilter(summary.needingService ? 'needs_service' : 'all')} />
            <StatTile icon={CircleDollarSign} label="Fleet value" value={formatCurrency(summary.fleetValue)}
              sub={summary.fleetPurchase > summary.fleetValue
                ? `Book value · ${formatCurrency(summary.fleetPurchase)} paid`
                : 'Purchase price, excl. retired'} />
            {summary.warrantyExpiring > 0 ? (
              <StatTile icon={ShieldCheck} label="Warranty ending" value={String(summary.warrantyExpiring)}
                tone="warn" tonedSurface sub="Within 30 days — book covered work" />
            ) : (
              <StatTile icon={History} label="Maintenance YTD" value={formatCurrency(summary.maintenanceYtd)}
                sub="Logged service costs this year" />
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            {([
              ['all', `All (${equipment.length})`],
              ['needs_service', `Needs service (${summary.needingService})`],
              ['active', STATUS_LABELS.active],
              ['repair', STATUS_LABELS.repair],
              ['retired', STATUS_LABELS.retired],
            ] as [Filter, string][]).map(([k, label]) => (
              <FilterPill key={k} active={filter === k} onClick={() => setFilter(k)}>{label}</FilterPill>
            ))}
          </div>

          {visible.length === 0 ? (
            <InlineEmpty>No machines match this filter.</InlineEmpty>
          ) : (
            <div className="space-y-3">
              {visible.map(eq => (
                <EquipmentRow
                  key={eq.id} eq={eq} uid={uid}
                  services={summary.servicesByEquipment.get(eq.id) ?? []}
                  docs={docs.filter(d => d.equipment_id === eq.id)}
                  onDocsChanged={load}
                  today={today}
                  open={openId === eq.id}
                  onToggle={() => setOpenId(openId === eq.id ? null : eq.id)}
                  onEdit={() => setEditing(eq)}
                  onLog={() => setLogFor(eq)}
                  onRemove={() => remove(eq)}
                  onStatus={s => setStatus(eq, s)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {editing && uid && (
        <EquipmentDialog
          open userId={uid}
          equipment={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={eq => {
            setEquipment(prev => prev.some(e => e.id === eq.id) ? prev.map(e => e.id === eq.id ? eq : e) : [eq, ...prev])
            setEditing(null)
          }}
        />
      )}
      {logFor && uid && (
        <ServiceLogDialog
          open userId={uid} equipment={logFor}
          services={summary.servicesByEquipment.get(logFor.id) ?? []}
          parts={parts}
          onClose={() => setLogFor(null)}
          // The DB trigger derives last_service_* from the log — refetch rather
          // than guess, so the machine's due-date is always the database's answer.
          onChanged={() => { load(); }}
        />
      )}
    </PageContainer>
  )
}

function EquipmentRow({ eq, uid, services, docs, onDocsChanged, today, open, onToggle, onEdit, onLog, onRemove, onStatus }: {
  eq: Equipment; uid: string | null; services: EquipmentService[]
  docs: EquipmentDoc[]; onDocsChanged: () => void
  today: string; open: boolean
  onToggle: () => void; onEdit: () => void; onLog: () => void; onRemove: () => void
  onStatus: (s: EquipmentStatus) => void
}) {
  const meta = categoryMeta(eq.category)
  const svc = serviceStatus(eq, today)
  const wty = warrantyStatus(eq, today)
  const book = bookValue(eq, today)
  const cost = costOfOwnership(eq, services)
  const retired = eq.status === 'retired'

  return (
    <Card className={cn(retired && 'opacity-70')}>
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <button type="button" onClick={onToggle}
            className="flex items-start gap-3 min-w-0 flex-1 text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <div className="w-9 h-9 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
              <meta.icon className="w-4 h-4 text-accent-text" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold text-ink truncate">{eq.name}</p>
                <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border', toneSoft[STATUS_TONE[eq.status]])}>
                  {STATUS_LABELS[eq.status]}
                </span>
                {!retired && wty.state !== 'none' && wty.state !== 'expired' && (
                  <span title={wty.reason}
                    className={cn('text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border inline-flex items-center gap-1', toneSoft[wty.tone])}>
                    <ShieldCheck className="w-3 h-3" /> {wty.state === 'covered' ? 'Under warranty' : 'Warranty ending'}
                  </span>
                )}
              </div>
              <p className="text-xs text-ink-muted mt-0.5 truncate">
                {[meta.label, [eq.make, eq.model].filter(Boolean).join(' '), eq.hours > 0 ? `${eq.hours} h` : null].filter(Boolean).join(' · ')}
              </p>
            </div>
          </button>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button size="sm" variant="secondary" onClick={onLog}><Wrench className="w-3.5 h-3.5" /> Log service</Button>
          </div>
        </div>

        {/* Service verdict — always says WHY, never a bare colour. */}
        {!retired && (
          <div className={cn('flex items-center gap-2 text-xs rounded-lg px-3 py-2 border', toneSoft[svc.tone])}>
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span className={toneText[svc.tone]}>{svc.reason}</span>
            {eq.last_service_at && (
              <span className="text-ink-faint ml-auto shrink-0">Last serviced {formatDate(eq.last_service_at)}</span>
            )}
          </div>
        )}

        {open && (
          <div className="space-y-3 pt-1">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Detail label="Worth today" value={eq.purchase_price ? formatCurrency(book.value) : '—'}
                sub={book.depreciating
                  ? `${formatCurrency(eq.purchase_price || 0)} paid · −${formatCurrency(book.annual || 0)}/yr`
                  : eq.purchase_date ? `Paid ${formatDate(eq.purchase_date)}` : 'Add a useful life to depreciate'} />
              <Detail label="Maintenance" value={formatCurrency(cost.maintenance)} sub={`${services.length} service${services.length !== 1 ? 's' : ''}`} />
              <Detail label="Total cost" value={formatCurrency(cost.total)} sub="Purchase + service" />
              <Detail label="Cost / hour" value={cost.perHour != null ? formatCurrency(cost.perHour) : '—'}
                sub={cost.perHour == null ? 'Add engine hours' : `over ${eq.hours} h`} />
            </div>

            {/* Warranty in words — including when it has lapsed, so a repair
                bill is never questioned twice. */}
            {wty.state !== 'none' && (
              <p className={cn('text-[11px] flex items-center gap-1.5', toneText[wty.tone])}>
                <ShieldCheck className="w-3 h-3 shrink-0" /> {wty.reason}
              </p>
            )}
            {eq.serial_number && <p className="text-[11px] text-ink-faint">Serial {eq.serial_number}</p>}
            {eq.notes && <p className="text-xs text-ink-muted whitespace-pre-wrap">{eq.notes}</p>}

            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5">Service history</p>
              {services.length === 0 ? (
                <InlineEmpty className="py-2">No service logged yet.</InlineEmpty>
              ) : (
                <div className="space-y-1">
                  {services.slice(0, 5).map(s => (
                    <div key={s.id} className="flex items-center gap-2 text-xs py-1 border-b border-border/50 last:border-0">
                      <Wrench className="w-3 h-3 text-ink-faint shrink-0" />
                      <span className="text-ink font-medium">{serviceKindLabel(s.kind)}</span>
                      {s.hours != null && <span className="text-ink-faint">at {s.hours} h</span>}
                      {s.cost != null && <span className="text-ink-muted tabular-nums">{formatCurrency(s.cost)}</span>}
                      <span className="text-ink-faint ml-auto shrink-0">{formatDate(s.service_date)}</span>
                    </div>
                  ))}
                  {services.length > 5 && <p className="text-[11px] text-ink-faint pt-1">+{services.length - 5} more — open Log service to see them all.</p>}
                </div>
              )}
            </div>

            {/* The paperwork behind the record — receipt, warranty certificate, manual. */}
            {uid && <EquipmentDocs userId={uid} equipmentId={eq.id} docs={docs} onChanged={onDocsChanged} />}

            <div className="flex items-center gap-1.5 flex-wrap pt-1">
              <Button size="sm" variant="secondary" onClick={onEdit}><Pencil className="w-3.5 h-3.5" /> Edit</Button>
              {eq.status !== 'active' && <Button size="sm" variant="ghost" onClick={() => onStatus('active')}>Back in service</Button>}
              {eq.status !== 'repair' && !retired && <Button size="sm" variant="ghost" onClick={() => onStatus('repair')}>Send to shop</Button>}
              {!retired && <Button size="sm" variant="ghost" onClick={() => onStatus('retired')}>Retire</Button>}
              <Button size="sm" variant="ghost" onClick={onRemove} className="ml-auto text-ink-faint hover:text-red-400">
                <Trash2 className="w-3.5 h-3.5" /> Remove
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function Detail({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-tertiary/40 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="text-sm font-bold text-ink tabular-nums mt-0.5">{value}</p>
      {sub && <p className="text-[10px] text-ink-faint">{sub}</p>}
    </div>
  )
}
