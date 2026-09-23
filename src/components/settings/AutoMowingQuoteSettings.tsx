'use client'

import { useEffect, useMemo, useState } from 'react'
import { Calculator } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'

type PricingVersion = { id: string; created_at: string; note: string | null; engine_version: string }
type RuleRow = Record<string, unknown>

export function AutoMowingQuoteSettings() {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [versions, setVersions] = useState<PricingVersion[]>([])
  const [enabled, setEnabled] = useState(false)
  const [weekly, setWeekly] = useState(false)
  const [biweekly, setBiweekly] = useState(false)
  const [oneTime, setOneTime] = useState(false)
  const [maxAge, setMaxAge] = useState('20')
  const [maxDistance, setMaxDistance] = useState('')
  const [nearby, setNearby] = useState('')
  const [minimumCharge, setMinimumCharge] = useState('')
  const [margin, setMargin] = useState('')
  const [materials, setMaterials] = useState('')
  const [equipment, setEquipment] = useState('')
  const [disposal, setDisposal] = useState('')
  const [contingency, setContingency] = useState('')
  const [pricingId, setPricingId] = useState('')
  const [bands, setBands] = useState('')
  const [depositType, setDepositType] = useState<'none' | 'percent' | 'fixed'>('none')
  const [depositValue, setDepositValue] = useState('')
  const [validDays, setValidDays] = useState('14')
  const [costConfirmed, setCostConfirmed] = useState(false)

  useEffect(() => {
    let alive = true
    async function load() {
      const [rule, pricing] = await Promise.all([
        supabase.from('auto_mowing_quote_rule_versions').select('*').eq('is_active', true).maybeSingle(),
        supabase.from('pricing_config_versions').select('id,created_at,note,engine_version')
          .eq('source', 'recorded').order('created_at', { ascending: false }).limit(50),
      ])
      if (!alive) return
      if (rule.error || pricing.error) {
        toast.error('Could not load automatic mowing quote settings.')
        setLoading(false); return
      }
      setVersions((pricing.data || []) as PricingVersion[])
      const r = rule.data as RuleRow | null
      if (r) {
        const cadences = Array.isArray(r.permitted_cadences) ? r.permitted_cadences.map(String) : []
        setEnabled(r.enabled === true); setWeekly(cadences.includes('weekly'))
        setBiweekly(cadences.includes('biweekly')); setOneTime(cadences.includes('one_time'))
        setMaxAge(String(r.maximum_measurement_age_minutes ?? ''))
        setMaxDistance(String(r.maximum_base_distance_km ?? '')); setNearby(String(r.minimum_nearby_jobs ?? ''))
        setMinimumCharge(String(r.minimum_charge ?? '')); setMargin(String(r.minimum_margin_percent ?? ''))
        setMaterials(String(r.materials_cost_per_visit ?? '')); setEquipment(String(r.equipment_cost_per_visit ?? ''))
        setDisposal(String(r.delivery_disposal_cost_per_visit ?? '')); setContingency(String(r.contingency_percent ?? ''))
        setPricingId(String(r.pricing_config_version_id ?? '')); setCostConfirmed(r.full_cost_basis_confirmed === true)
        setDepositType((r.deposit_type || 'none') as 'none' | 'percent' | 'fixed')
        setDepositValue(r.deposit_value == null ? '' : String(r.deposit_value)); setValidDays(String(r.quote_valid_days ?? ''))
        const parsedBands = Array.isArray(r.duration_crew_bands) ? r.duration_crew_bands as Array<Record<string, unknown>> : []
        setBands(parsedBands.map(b => `${b.maximum_sqft == null ? 'any' : b.maximum_sqft}, ${b.minutes}, ${b.crew_size}`).join('\n'))
      }
      setLoading(false)
    }
    load()
    return () => { alive = false }
  }, [supabase])

  function parsedBands() {
    const lines = bands.split('\n').map(line => line.trim()).filter(Boolean)
    return lines.map((line, index) => {
      const [maximum, minutes, crew] = line.split(',').map(part => part.trim())
      const maximumSqft = maximum.toLowerCase() === 'any' ? null : Number(maximum)
      if ((!Number.isFinite(maximumSqft) && maximumSqft !== null) || (maximumSqft != null && maximumSqft <= 0)
        || !(Number(minutes) > 0) || !Number.isInteger(Number(crew)) || Number(crew) < 1) throw new Error(`Invalid duration band on line ${index + 1}.`)
      return { maximum_sqft: maximumSqft, minutes: Number(minutes), crew_size: Number(crew) }
    })
  }

  async function save() {
    if (saving) return
    try {
      const durationBands = parsedBands()
      const cadences = [...(weekly ? ['weekly'] : []), ...(biweekly ? ['biweekly'] : []), ...(oneTime ? ['one_time'] : [])]
      if (!cadences.length || !durationBands.length || durationBands.at(-1)?.maximum_sqft !== null || !pricingId || !costConfirmed) {
        throw new Error('Choose a cadence and pricing version, add a final “any” duration band, and confirm the full cost basis.')
      }
      setSaving(true)
      const { data, error } = await supabase.rpc('save_auto_mowing_quote_rules', { p_rules: {
        enabled, permitted_cadences: cadences,
        accepted_measurement_confidences: ['medium'],
        accepted_measurement_sources: ['calgary_open_data_land_cover'],
        maximum_measurement_age_minutes: Number(maxAge), route_mode: 'distance_and_density',
        approved_neighborhoods: [], maximum_base_distance_km: Number(maxDistance),
        minimum_nearby_jobs: Number(nearby), minimum_charge: Number(minimumCharge),
        minimum_margin_percent: Number(margin), full_cost_basis_confirmed: costConfirmed,
        materials_cost_per_visit: Number(materials), equipment_cost_per_visit: Number(equipment),
        delivery_disposal_cost_per_visit: Number(disposal), contingency_percent: Number(contingency),
        pricing_config_version_id: pricingId, duration_crew_bands: durationBands,
        deposit_type: depositType, deposit_value: depositType === 'none' ? null : Number(depositValue),
        quote_valid_days: Number(validDays),
      } })
      const state = data && typeof data === 'object' && !Array.isArray(data) ? String((data as RuleRow).state || '') : ''
      if (error || state !== 'saved') throw new Error(error?.message || 'Nothing changed.')
      toast.success(enabled ? 'Automatic mowing quote rules saved as a new version.' : 'Automatic mowing quotes are off; the disabled ruleset was versioned.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save automatic mowing quote rules.')
    } finally { setSaving(false) }
  }

  if (loading) return null
  return (
    <Card>
      <CardHeader><div><h2 className="text-sm font-semibold text-ink flex items-center gap-2"><Calculator className="w-4 h-4 text-accent-text" /> Automatic mowing quotes</h2>
        <p className="text-xs text-ink-faint mt-0.5">Issue an exact written quote only when the signed City measurement, active route, saved price card and full cost floor all pass.</p></div></CardHeader>
      <CardBody className="space-y-5">
        <label className="flex items-start gap-3 rounded-xl border border-border bg-bg-secondary p-4 cursor-pointer"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--accent)]" /><span><span className="block text-sm font-semibold text-ink">Enable automatic mowing prices</span><span className="block text-xs text-ink-muted mt-0.5">Saving creates an immutable rule version and expires still-open automatic quotes from the prior version.</span></span></label>
        <div><p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Permitted cadence</p><div className="flex flex-wrap gap-4 text-sm text-ink">{([['Weekly', weekly, setWeekly], ['Bi-weekly', biweekly, setBiweekly], ['One-time', oneTime, setOneTime]] as const).map(([label, checked, setter]) => <label key={label} className="flex items-center gap-2"><input type="checkbox" checked={checked} onChange={e => setter(e.target.checked)} /> {label}</label>)}</div></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Measurement max age (minutes)" type="number" min="1" max="10080" value={maxAge} onChange={e => setMaxAge(e.target.value)} hint="Signed City parcel + 2015 manicured-land-cover source; medium confidence." />
          <Input label="Maximum base distance (km)" type="number" min="0.1" step="0.1" value={maxDistance} onChange={e => setMaxDistance(e.target.value)} />
          <Input label="Minimum nearby active mowing stops" type="number" min="0" step="1" value={nearby} onChange={e => setNearby(e.target.value)} hint="Unique future scheduled or in-progress mowing properties within 2 km." />
          <Input label="Minimum customer charge ($)" type="number" min="0.01" step="0.01" value={minimumCharge} onChange={e => setMinimumCharge(e.target.value)} />
          <Input label="Minimum margin (%)" type="number" min="0" max="99" step="0.1" value={margin} onChange={e => setMargin(e.target.value)} />
          <Input label="Materials per visit ($)" type="number" min="0" step="0.01" value={materials} onChange={e => setMaterials(e.target.value)} />
          <Input label="Additional equipment per visit ($)" type="number" min="0" step="0.01" value={equipment} onChange={e => setEquipment(e.target.value)} hint="Only equipment outside the loaded crew rate." />
          <Input label="Delivery/disposal per visit ($)" type="number" min="0" step="0.01" value={disposal} onChange={e => setDisposal(e.target.value)} />
          <Input label="Contingency (%)" type="number" min="0" max="100" step="0.1" value={contingency} onChange={e => setContingency(e.target.value)} />
          <Input label="Quote valid (days)" type="number" min="1" max="90" step="1" value={validDays} onChange={e => setValidDays(e.target.value)} />
        </div>
        <label className="flex flex-col gap-1.5 text-xs font-semibold text-ink-muted uppercase tracking-wide">Recorded pricing version<select value={pricingId} onChange={e => setPricingId(e.target.value)} className="rounded-xl px-3.5 py-3 bg-bg-tertiary border border-border text-ink text-sm normal-case"><option value="">Select an immutable saved version</option>{versions.map(v => <option key={v.id} value={v.id}>{v.note || v.engine_version} · {new Date(v.created_at).toLocaleDateString('en-CA')}</option>)}</select></label>
        <label className="flex flex-col gap-1.5 text-xs font-semibold text-ink-muted uppercase tracking-wide">Duration and crew bands<textarea value={bands} onChange={e => setBands(e.target.value)} rows={4} placeholder={'3000, 35, 1\n6000, 55, 2\nany, 75, 2'} className="rounded-xl px-3.5 py-3 bg-bg-tertiary border border-border text-ink text-sm font-mono normal-case" /><span className="text-xs text-ink-faint normal-case font-normal">One line per band: maximum sqft, minutes, crew size. End with “any”.</span></label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><label className="flex flex-col gap-1.5 text-xs font-semibold text-ink-muted uppercase tracking-wide">Deposit rule<select value={depositType} onChange={e => setDepositType(e.target.value as typeof depositType)} className="rounded-xl px-3.5 py-3 bg-bg-tertiary border border-border text-ink text-sm normal-case"><option value="none">No deposit</option><option value="percent">Percent of accepted price</option><option value="fixed">Fixed amount</option></select></label>{depositType !== 'none' && <Input label={depositType === 'percent' ? 'Deposit (%)' : 'Deposit ($)'} type="number" min="0.01" step="0.01" value={depositValue} onChange={e => setDepositValue(e.target.value)} />}</div>
        <label className="flex items-start gap-3 rounded-xl border border-border p-4"><input type="checkbox" checked={costConfirmed} onChange={e => setCostConfirmed(e.target.checked)} className="mt-0.5 h-4 w-4" /><span className="text-xs text-ink-muted">I confirm the selected pricing version’s loaded crew rate includes labour, payroll burden, routine fuel/vehicle, routine equipment and allocated overhead. The per-visit fields above cover every remaining known cost.</span></label>
        <Button type="button" onClick={save} loading={saving} disabled={saving}>Save new rule version</Button>
      </CardBody>
    </Card>
  )
}
