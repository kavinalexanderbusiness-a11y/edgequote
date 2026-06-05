'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useBusinessData } from '@/hooks/useBusinessData'
import type { BusinessSettingsFormValues, TravelFeeTier } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { AddressAutocomplete } from '@/components/ui/AddressAutocomplete'
import { useForm, Controller } from 'react-hook-form'
import { Upload, Plus, Trash2, Check } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'

export default function SettingsPage() {
  const { settings, tiers, loading, refresh } = useBusinessData()
  const supabase = createClient()

  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [saved, setSaved] = useState(false)
  const [localTiers, setLocalTiers] = useState<Partial<TravelFeeTier>[]>([])

  const { register, handleSubmit, reset, control, formState: { isSubmitting } } =
    useForm<BusinessSettingsFormValues>()

  useEffect(() => {
    if (settings) {
      reset({
        company_name: settings.company_name || '',
        owner_name: settings.owner_name || '',
        phone: settings.phone || '',
        email_primary: settings.email_primary || '',
        email_secondary: settings.email_secondary || '',
        website: settings.website || '',
        base_address: settings.base_address || '',
        default_rate: settings.default_rate || 50,
        terms_text: settings.terms_text || '',
      })
      setLogoUrl(settings.logo_url)
    }
  }, [settings, reset])

  useEffect(() => { if (tiers.length) setLocalTiers(tiers) }, [tiers])

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    const { data: { user } } = await supabase.auth.getUser()
    const ext = file.name.split('.').pop()
    const path = `${user!.id}/logo.${ext}`

    const { error: upErr } = await supabase.storage
      .from('branding')
      .upload(path, file, { upsert: true })

    if (!upErr) {
      const { data } = supabase.storage.from('branding').getPublicUrl(path)
      const url = `${data.publicUrl}?t=${Date.now()}`
      setLogoUrl(url)
      await supabase.from('business_settings')
        .update({ logo_url: url })
        .eq('user_id', user!.id)
    }
    setUploading(false)
  }

  async function onSubmit(values: BusinessSettingsFormValues) {
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('business_settings')
      .update({ ...values, default_rate: Number(values.default_rate), base_lat: null, base_lng: null })
      .eq('user_id', user!.id)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    refresh()
  }

  function updateTier(idx: number, field: keyof TravelFeeTier, value: string) {
    setLocalTiers(prev => prev.map((t, i) =>
      i === idx ? { ...t, [field]: value === '' ? null : Number(value) } : t
    ))
  }

  async function addTier() {
    const { data: { user } } = await supabase.auth.getUser()
    const nextOrder = (localTiers.length || 0) + 1
    const { data } = await supabase.from('travel_fee_tiers')
      .insert({ min_km: 0, max_km: null, fee: 0, is_custom: false, sort_order: nextOrder, user_id: user!.id })
      .select().single()
    if (data) setLocalTiers(prev => [...prev, data])
  }

  async function saveTier(idx: number) {
    const t = localTiers[idx]
    if (!t.id) return
    await supabase.from('travel_fee_tiers')
      .update({ min_km: t.min_km, max_km: t.max_km, fee: t.fee, is_custom: t.fee === null })
      .eq('id', t.id)
    refresh()
  }

  async function deleteTier(idx: number) {
    const t = localTiers[idx]
    if (t.id) await supabase.from('travel_fee_tiers').delete().eq('id', t.id)
    setLocalTiers(prev => prev.filter((_, i) => i !== idx))
  }

  if (loading) return <div className="text-center py-16 text-sm text-ink-muted">Loading settings...</div>

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Business Settings" description="Company info, branding, pricing, and travel fees" />

      <Card>
        <CardHeader><h2 className="text-sm font-semibold text-ink">Branding</h2></CardHeader>
        <CardBody className="space-y-4">
          <div className="flex items-center gap-5">
            <div className="w-32 h-32 rounded-xl border border-border-strong bg-black flex items-center justify-center overflow-hidden shrink-0">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt="Logo" className="w-full h-full object-contain" />
              ) : (
                <span className="text-xs text-ink-faint text-center px-2">No logo uploaded</span>
              )}
            </div>
            <div>
              <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-surface border border-border-strong text-sm text-ink cursor-pointer hover:bg-surface-raised transition-colors">
                <Upload className="w-4 h-4" />
                {uploading ? 'Uploading...' : 'Upload Logo'}
                <input type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} disabled={uploading} />
              </label>
              <p className="text-xs text-ink-faint mt-2 max-w-xs">
                Upload your official Edge Property Services logo. Used on PDF quotes and throughout the app.
              </p>
            </div>
          </div>
        </CardBody>
      </Card>

      <form onSubmit={handleSubmit(onSubmit)}>
        <Card>
          <CardHeader><h2 className="text-sm font-semibold text-ink">Company Information</h2></CardHeader>
          <CardBody className="space-y-4">
            <Input label="Company Name" {...register('company_name')} />
            <div className="grid grid-cols-2 gap-4">
              <Input label="Owner Name" {...register('owner_name')} />
              <Input label="Phone" {...register('phone')} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Input label="Primary Email" type="email" {...register('email_primary')} />
              <Input label="Business Email" type="email" {...register('email_secondary')} />
            </div>
            <Input label="Website" {...register('website')} />
            <Controller name="base_address" control={control}
              render={({ field }) => (
                <AddressAutocomplete
                  label="Base Location (address)"
                  value={field.value || ''}
                  onChange={field.onChange}
                  onSelect={(p) => field.onChange(p.formatted)}
                  hint="Your starting point for travel fees and route planning."
                />
              )} />
            <Input label="Default Labour Rate ($/man-hour)" type="number" step="5" min="50" {...register('default_rate')} />
            <Textarea label="PDF Terms & Conditions" rows={5} {...register('terms_text')} />
          </CardBody>
          <div className="px-6 py-4 border-t border-border flex justify-end">
            <Button type="submit" loading={isSubmitting}>
              {saved ? <><Check className="w-4 h-4" /> Saved</> : 'Save Settings'}
            </Button>
          </div>
        </Card>
      </form>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-ink">Travel Fee Tiers</h2>
            <p className="text-xs text-ink-faint mt-0.5">Fully configurable. Leave fee blank for &quot;custom quote&quot;.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={addTier}><Plus className="w-3.5 h-3.5" /> Add Tier</Button>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="grid grid-cols-[1fr_1fr_1fr_auto_auto] gap-3 text-xs font-semibold text-ink-faint uppercase tracking-wide px-1">
            <span>Min km</span><span>Max km</span><span>Fee ($)</span><span /><span />
          </div>
          {localTiers.map((t, i) => (
            <div key={t.id || i} className="grid grid-cols-[1fr_1fr_1fr_auto_auto] gap-3 items-center">
              <input type="number" value={t.min_km ?? ''} onChange={e => updateTier(i, 'min_km', e.target.value)}
                className="bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
              <input type="number" value={t.max_km ?? ''} placeholder="inf" onChange={e => updateTier(i, 'max_km', e.target.value)}
                className="bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
              <input type="number" value={t.fee ?? ''} placeholder="custom" onChange={e => updateTier(i, 'fee', e.target.value)}
                className="bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
              <Button variant="ghost" size="sm" onClick={() => saveTier(i)} title="Save"><Check className="w-4 h-4" /></Button>
              <Button variant="ghost" size="sm" onClick={() => deleteTier(i)} className="hover:text-red-400" title="Delete"><Trash2 className="w-4 h-4" /></Button>
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  )
}