'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Equipment, EquipmentService, ServiceKind, SERVICE_KINDS, serviceKindLabel, serviceStatus, warrantyStatus } from '@/lib/equipment'
import { formatCurrency, formatDate, localTodayISO, cn } from '@/lib/utils'
import { toneSoft, toneText } from '@/lib/tone'
import { toast } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { Banner } from '@/components/ui/Banner'
import { type Part, stockStatus, pickedValue, suggestedCategories, consumeParts } from '@/lib/parts'
import { Wrench, Trash2, Clock, ShieldCheck, Package, AlertTriangle } from 'lucide-react'

// Log a service and read the machine's history. Logging is the ONLY way
// "last serviced" moves — a DB trigger recomputes it from these rows, so the
// due-date always matches the history shown here.
export function ServiceLogDialog({ open, userId, equipment, services, parts = [], onClose, onChanged }: {
  open: boolean
  userId: string
  equipment: Equipment
  services: EquipmentService[]
  /** The shelf. Empty (or no parts migration) → the parts section simply hides. */
  parts?: Part[]
  onClose: () => void
  onChanged: () => void
}) {
  const supabase = useState(() => createClient())[0]
  const today = localTodayISO()
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [v, setV] = useState({
    service_date: today,
    kind: 'oil' as ServiceKind,
    // Default to the machine's current hours — the common case is "serviced it now".
    hours: equipment.hours ? String(equipment.hours) : '',
    cost: '',
    notes: '',
  })
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV(s => ({ ...s, [k]: val }))
  const numOrNull = (s: string) => { const n = Number(s); return s.trim() && Number.isFinite(n) ? n : null }
  // ── Parts consumed by this service (optional) ──
  // Picks are qty-by-part-id. On save each becomes a signed 'use' movement tied
  // to the new service row, so reverting the service returns them to the shelf.
  const [picks, setPicks] = useState<Record<string, string>>({})
  const picked = parts
    .map(p => ({ part: p, qty: Number(picks[p.id]) || 0 }))
    .filter(p => p.qty > 0)
  const partsValue = pickedValue(picked)
  // Offer what this kind of service actually reaches for, then everything else.
  const suggested = suggestedCategories(v.kind)
  const relevant = suggested.length ? parts.filter(p => suggested.includes(p.category)) : parts
  const short = picked.filter(p => p.qty > (Number(p.part.qty_on_hand) || 0))

  const svc = serviceStatus(equipment, today)
  const wty = warrantyStatus(equipment, today)
  // The money moment: a repair on a covered machine should be billed to the
  // warranty, not to you. Shown the instant "Repair" is picked, before the cost.
  const coveredRepair = (wty.state === 'covered' || wty.state === 'expiring') && (v.kind === 'repair' || v.kind === 'tune_up')

  async function logIt() {
    if (!v.service_date) { toast.error('Pick the date the work was done.'); return }
    setSaving(true)
    const loggedHours = numOrNull(v.hours)
    // Insert and READ BACK the row: the parts we consume must point at this exact
    // service, so an ON DELETE CASCADE can return them if it's ever reverted.
    const { data: created, error } = await supabase.from('equipment_service').insert({
      user_id: userId,
      equipment_id: equipment.id,
      service_date: v.service_date,
      kind: v.kind,
      hours: loggedHours,
      // The cost field SHOWS the parts value when the owner hasn't typed one —
      // save what they were shown, not an empty string.
      cost: v.cost.trim() ? numOrNull(v.cost) : (partsValue > 0 ? partsValue : null),
      notes: v.notes.trim() || null,
    }).select().single()
    if (error || !created) { setSaving(false); toast.error('Could not log the service: ' + (error?.message ?? 'please try again.')); return }

    // Take the picked parts off the shelf. The service itself is already saved,
    // so a stock failure is reported without losing the maintenance record.
    if (picked.length) {
      const res = await consumeParts(supabase, { userId, serviceId: (created as EquipmentService).id, picks: picked })
      if (res.error) {
        setSaving(false)
        toast.error(`Service logged, but stock didn't update: ${res.error}`)
        setPicks({}); onChanged(); return
      }
    }

    // If they serviced it at more hours than the machine records, move the meter
    // forward too — otherwise the next due-date would be computed from a stale
    // reading. (The trigger owns last_service_*; `hours` is the live meter.)
    if (loggedHours != null && loggedHours > Number(equipment.hours || 0)) {
      await supabase.from('equipment').update({ hours: loggedHours }).eq('id', equipment.id)
    }
    setSaving(false)
    toast.success(`${serviceKindLabel(v.kind)} logged for ${equipment.name}.`)
    setV(s => ({ ...s, cost: '', notes: '' }))
    onChanged()
  }

  async function removeEntry(s: EquipmentService) {
    const ok = await confirmDialog({
      title: 'Delete this service entry?',
      message: `${serviceKindLabel(s.kind)} on ${formatDate(s.service_date)}. The machine's "last serviced" date recalculates from what's left.`,
      confirmLabel: 'Delete entry', destructive: true,
    })
    if (!ok) return
    setBusyId(s.id)
    const { error } = await supabase.from('equipment_service').delete().eq('id', s.id)
    setBusyId(null)
    if (error) { toast.error('Could not delete it: ' + error.message); return }
    toast.success('Service entry deleted.')
    onChanged()
  }

  const totalCost = services.reduce((sum, s) => sum + (Number(s.cost) || 0), 0)

  return (
    <Modal open={open} onClose={() => !saving && onClose()} icon={Wrench} size="lg"
      onSubmit={logIt}
      title={`Service — ${equipment.name}`}
      footer={<><Button variant="ghost" onClick={onClose} disabled={saving}>Done</Button><Button onClick={logIt} loading={saving}>Log service</Button></>}>
      <div className="space-y-4">
        {/* Why it's due — the same verdict the list shows, from the one engine. */}
        {equipment.status !== 'retired' && (
          <div className={cn('flex items-center gap-2 text-xs rounded-lg px-3 py-2 border', toneSoft[svc.tone])}>
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span className={toneText[svc.tone]}>{svc.reason}</span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Date" type="date" autoFocus value={v.service_date} onChange={e => set('service_date', e.target.value)} />
          <Select label="What was done" value={v.kind} onChange={e => set('kind', e.target.value as ServiceKind)}
            options={SERVICE_KINDS.map(k => ({ value: k.value, label: k.label }))} />
        </div>

        {/* Don't pay for covered work. */}
        {coveredRepair && (
          <Banner tone="success" icon={ShieldCheck}>
            <span className="font-semibold">This machine is still under warranty.</span>{' '}
            {wty.reason}. Check with {equipment.warranty_provider || 'your dealer'} before you pay for this{v.kind === 'repair' ? ' repair' : ' work'}.
          </Banner>
        )}
        {/* Parts off the shelf (optional). Hidden entirely when nothing is stocked. */}
        {parts.length > 0 && (
          <div className="rounded-xl border border-border bg-surface/40 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><Package className="w-4 h-4 text-accent-text" /> Parts used</p>
                <p className="text-xs text-ink-muted mt-0.5">Taken off the shelf when you log this. Revert the entry later and they come back.</p>
              </div>
              {partsValue > 0 && <p className="text-sm font-bold text-ink tabular-nums shrink-0">{formatCurrency(partsValue)}</p>}
            </div>

            <div className="max-h-40 overflow-y-auto space-y-1">
              {relevant.map(p => {
                const st = stockStatus(p)
                const unit = p.unit === 'each' ? '' : ` ${p.unit}`
                return (
                  <div key={p.id} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate text-ink">{p.name}</span>
                    <span className={cn('shrink-0 tabular-nums', toneText[st.tone])}>{p.qty_on_hand}{unit}</span>
                    <input type="number" min="0" step="any" inputMode="decimal" placeholder="0"
                      aria-label={`Quantity of ${p.name} used`}
                      value={picks[p.id] ?? ''} onChange={e => setPicks(s => ({ ...s, [p.id]: e.target.value }))}
                      className="w-16 h-8 shrink-0 bg-bg-tertiary border border-border-strong rounded-lg px-2 text-xs text-ink tabular-nums outline-none focus:border-accent" />
                  </div>
                )
              })}
              {relevant.length === 0 && <InlineEmpty className="py-2">Nothing stocked for this kind of service.</InlineEmpty>}
            </div>

            {/* Honest, non-blocking: the ledger may legitimately go negative if
                stock was used before it was recorded — say so rather than refuse. */}
            {short.length > 0 && (
              <p className="text-[11px] text-amber-400 flex items-start gap-1.5 leading-snug">
                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                You're using more {short[0].part.name} than the shelf shows. We'll log it — the count will read short until you restock or correct it.
              </p>
            )}
            {partsValue > 0 && !v.cost.trim() && (
              <p className="text-[11px] text-ink-faint">Cost below is prefilled with the parts value — add labour or a shop bill on top.</p>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Engine hours at service" type="number" min="0" step="0.1" inputMode="decimal"
            value={v.hours} onChange={e => set('hours', e.target.value)}
            hint="Resets the hour countdown. Higher than the meter? We'll move the meter up." />
          <Input label="Cost" type="number" min="0" step="0.01" inputMode="decimal"
            value={v.cost || (partsValue > 0 ? String(partsValue) : '')}
            onChange={e => set('cost', e.target.value)} placeholder="0.00"
            hint="The one figure behind maintenance YTD and cost/hour." />
        </div>
        <Textarea label="Notes" value={v.notes} onChange={e => set('notes', e.target.value)}
          placeholder="Parts used, shop, what to watch next time…" />

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">History</p>
            {services.length > 0 && (
              <p className="text-[10px] text-ink-faint">{services.length} service{services.length !== 1 ? 's' : ''} · {formatCurrency(totalCost)} total</p>
            )}
          </div>
          {services.length === 0 ? (
            <InlineEmpty className="py-3">Nothing logged yet — the first entry starts this machine's history.</InlineEmpty>
          ) : (
            <div className="max-h-56 overflow-y-auto rounded-lg border border-border divide-y divide-border">
              {services.map(s => (
                <div key={s.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                  <Wrench className="w-3 h-3 text-ink-faint shrink-0" />
                  <span className="text-ink font-medium">{serviceKindLabel(s.kind)}</span>
                  {s.hours != null && <span className="text-ink-faint">at {s.hours} h</span>}
                  {s.cost != null && <span className="text-ink-muted tabular-nums">{formatCurrency(s.cost)}</span>}
                  {s.notes && <span className="text-ink-faint truncate hidden sm:inline">· {s.notes}</span>}
                  <span className="text-ink-faint ml-auto shrink-0">{formatDate(s.service_date)}</span>
                  <button type="button" onClick={() => removeEntry(s)} disabled={busyId === s.id}
                    aria-label={`Delete ${serviceKindLabel(s.kind)} entry`}
                    className="shrink-0 text-ink-faint hover:text-red-400 rounded disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
