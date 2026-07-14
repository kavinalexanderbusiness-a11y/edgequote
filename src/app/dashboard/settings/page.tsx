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
import { CommunicationsTest } from '@/components/settings/CommunicationsTest'
import { MessageTemplateEditor } from '@/components/settings/MessageTemplateEditor'
import { MessagingUsage } from '@/components/settings/MessagingUsage'
import { AutomationToggles } from '@/components/settings/AutomationToggles'
import { PushNotificationSettings } from '@/components/settings/PushNotificationSettings'
import { WebsiteIntegration } from '@/components/settings/WebsiteIntegration'
import { Tabs, type TabItem } from '@/components/ui/Tabs'
import { useForm, Controller } from 'react-hook-form'
import { cn } from '@/lib/utils'
import { ThemePref, getThemePref, applyThemePref } from '@/lib/theme'
import { ServiceSeasons, ServiceSeason, DEFAULT_SEASONS, settingsToSeasons, seasonLabel } from '@/lib/seasons'
import { Upload, Plus, Trash2, Check, Sun, Moon, Monitor, Snowflake, CalendarRange, CreditCard, Building2, DollarSign, MessageSquare, Bell, Link as LinkIcon, Zap } from 'lucide-react'

const SETTINGS_TABS: TabItem[] = [
  { key: 'business', label: 'Business', icon: Building2 },
  { key: 'pricing', label: 'Pricing & Fees', icon: DollarSign },
  { key: 'scheduling', label: 'Scheduling', icon: CalendarRange },
  { key: 'messaging', label: 'Messaging', icon: MessageSquare },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'booking', label: 'Booking', icon: LinkIcon },
]
type SettingsTab = (typeof SETTINGS_TABS)[number]['key']

// Mon→Sun display, mapped to date-fns getDay indices (Sun=0…Sat=6).
const WEEKDAYS = [
  { i: 1, l: 'Monday' }, { i: 2, l: 'Tuesday' }, { i: 3, l: 'Wednesday' }, { i: 4, l: 'Thursday' },
  { i: 5, l: 'Friday' }, { i: 6, l: 'Saturday' }, { i: 0, l: 'Sunday' },
]
const DEFAULT_WORK_DAYS = [5, 6, 0] // Fri/Sat/Sun

export default function SettingsPage() {
  const { settings, tiers, loading, refresh } = useBusinessData()
  const supabase = createClient()

  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [saved, setSaved] = useState(false)
  const [localTiers, setLocalTiers] = useState<Partial<TravelFeeTier>[]>([])
  const [workDays, setWorkDays] = useState<number[]>(DEFAULT_WORK_DAYS)
  const toggleDay = (i: number) => setWorkDays(prev => prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i])
  const [workStart, setWorkStart] = useState('08:00')
  const [capacityHours, setCapacityHours] = useState('8')
  const [themePref, setThemePref] = useState<ThemePref>('dark')
  const [logoScale, setLogoScale] = useState(100)
  const [seasons, setSeasons] = useState<ServiceSeasons>(DEFAULT_SEASONS)
  const [tab, setTab] = useState<SettingsTab>('business')

  useEffect(() => { setThemePref(getThemePref()) }, [])
  function pickTheme(p: ThemePref) { setThemePref(p); applyThemePref(p) }

  async function persistLogoScale(v: number) {
    setLogoScale(v)
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('business_settings').update({ logo_scale: v }).eq('user_id', user!.id)
    // Sidebar/login read this cache so the logo scales everywhere immediately.
    try { window.localStorage.setItem('eq-logo', JSON.stringify({ url: logoUrl, scale: v })) } catch { /* ignore */ }
  }

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
        crew_cost_per_hour: settings.crew_cost_per_hour ?? 40,
        target_rev_per_hour: settings.target_rev_per_hour ?? 60,
        pricing_base_charge: settings.pricing_base_charge ?? 28,
        pricing_mow_rate: settings.pricing_mow_rate ?? 15,
        pricing_recommended_mult: settings.pricing_recommended_mult ?? 1.0,
        pricing_premium_mult: settings.pricing_premium_mult ?? 1.2,
        pricing_travel_rate: settings.pricing_travel_rate ?? 1.5,
        terms_text: settings.terms_text || '',
        payment_fee_strategy: settings.payment_fee_strategy ?? 'global_price_increase',
        fee_recovery_percent: settings.fee_recovery_percent ?? 3,
        etransfer_discount_percent: settings.etransfer_discount_percent ?? 0,
        etransfer_email: settings.etransfer_email || '',
        gst_percent: settings.gst_percent ?? 0,
        autopay_charge_mode: settings.autopay_charge_mode ?? 'auto',
        autopay_variance_pct: settings.autopay_variance_pct ?? 40,
      })
      setLogoUrl(settings.logo_url)
      setWorkDays(settings.preferred_work_days?.length ? settings.preferred_work_days : DEFAULT_WORK_DAYS)
      setWorkStart(settings.work_start_time || '08:00')
      setCapacityHours(String(settings.daily_capacity_hours ?? 8))
      setLogoScale(settings.logo_scale && settings.logo_scale >= 50 ? settings.logo_scale : 100)
      setSeasons(settingsToSeasons(settings.service_seasons))
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
      try { window.localStorage.setItem('eq-logo', JSON.stringify({ url, scale: logoScale })) } catch { /* ignore */ }
    }
    setUploading(false)
  }

  async function onSubmit(values: BusinessSettingsFormValues) {
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('business_settings')
      .update({
        ...values,
        default_rate: Number(values.default_rate),
        crew_cost_per_hour: Number(values.crew_cost_per_hour) > 0 ? Number(values.crew_cost_per_hour) : 40,
        target_rev_per_hour: Number(values.target_rev_per_hour) > 0 ? Number(values.target_rev_per_hour) : 60,
        pricing_base_charge: Number(values.pricing_base_charge),
        pricing_mow_rate: Number(values.pricing_mow_rate),
        pricing_recommended_mult: Number(values.pricing_recommended_mult),
        pricing_premium_mult: Number(values.pricing_premium_mult),
        pricing_travel_rate: Number(values.pricing_travel_rate),
        payment_fee_strategy: values.payment_fee_strategy || 'global_price_increase',
        fee_recovery_percent: Number(values.fee_recovery_percent) >= 0 ? Number(values.fee_recovery_percent) : 3,
        etransfer_discount_percent: Number(values.etransfer_discount_percent) >= 0 ? Number(values.etransfer_discount_percent) : 0,
        etransfer_email: values.etransfer_email?.trim() || null,
        gst_percent: Number(values.gst_percent) >= 0 ? Number(values.gst_percent) : 0,
        autopay_charge_mode: values.autopay_charge_mode === 'manual_review' ? 'manual_review' : 'auto',
        autopay_variance_pct: Number(values.autopay_variance_pct) >= 0 ? Number(values.autopay_variance_pct) : 40,
        preferred_work_days: workDays,
        work_start_time: /^\d{1,2}:\d{2}$/.test(workStart) ? workStart : '08:00',
        daily_capacity_hours: Number(capacityHours) > 0 ? Number(capacityHours) : 8,
        service_seasons: seasons,
        base_lat: null, base_lng: null,
      })
      .eq('user_id', user!.id)
    // The sticky footer promises "save everything" — so it must also persist any
    // edited travel-fee tier rows (they previously needed their own per-row save).
    await Promise.all(localTiers.filter(t => t.id).map(t =>
      supabase.from('travel_fee_tiers')
        .update({ min_km: t.min_km, max_km: t.max_km, fee: t.fee, is_custom: t.fee === null })
        .eq('id', t.id),
    ))
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

  // Tabs that contain react-hook-form fields. The <form> stays mounted across
  // these so values are never lost on tab switch; the Save footer shows on any
  // of them and submits every field regardless of which is active.
  const formTabs: SettingsTab[] = ['business', 'pricing', 'scheduling']
  const showSave = formTabs.includes(tab)

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Business Settings" description="Company info, branding, pricing, and travel fees" />

      <div className="sticky top-0 z-10 -mx-1 px-1 py-2 bg-bg/90 backdrop-blur">
        <Tabs tabs={SETTINGS_TABS} active={tab} onChange={(k) => setTab(k as SettingsTab)} />
      </div>

      {/* BUSINESS */}
      <div className={cn('space-y-6', tab !== 'business' && 'hidden')}>
      <Card>
        <CardHeader><h2 className="text-sm font-semibold text-ink">Branding</h2></CardHeader>
        <CardBody className="space-y-5">
          <div className="flex items-center gap-5 flex-wrap">
            <div className="w-32 h-32 rounded-xl border border-border-strong bg-black flex items-center justify-center overflow-hidden shrink-0">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt="Logo" className="object-contain transition-all"
                  style={{ width: `${Math.min(logoScale, 200)}%`, height: `${Math.min(logoScale, 200)}%`, maxWidth: 'none' }} />
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
                Upload your company logo. Used in the sidebar, on the login screen and on PDF quotes &amp; invoices.
              </p>
            </div>
          </div>

          {logoUrl && (
            <div className="space-y-2.5">
              <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Logo size <span className="text-ink-faint normal-case font-normal">— live preview above</span></p>
              <div className="flex items-center gap-2 flex-wrap">
                {([['Small', 75], ['Medium', 100], ['Large', 150]] as const).map(([label, v]) => (
                  <button key={label} type="button" onClick={() => persistLogoScale(v)}
                    className={cn('px-3.5 py-2 rounded-lg text-xs font-medium border transition-colors',
                      logoScale === v ? 'bg-accent text-black border-accent' : 'bg-surface border-border-strong text-ink-muted hover:text-ink')}>
                    {label}
                  </button>
                ))}
                <div className="flex items-center gap-2 flex-1 min-w-[180px]">
                  <input type="range" min={50} max={200} step={5} value={logoScale}
                    onChange={e => setLogoScale(Number(e.target.value))}
                    onPointerUp={e => persistLogoScale(Number((e.target as HTMLInputElement).value))}
                    className="flex-1 accent-[rgb(var(--c-accent))]" />
                  <span className="text-xs font-semibold text-ink w-11 text-right">{logoScale}%</span>
                </div>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <h2 className="text-sm font-semibold text-ink">Appearance</h2>
            <p className="text-xs text-ink-faint mt-0.5">Applies across the whole app and is remembered on this device.</p>
          </div>
        </CardHeader>
        <CardBody>
          <div className="grid grid-cols-3 gap-2 max-w-md">
            {([
              { p: 'light' as ThemePref, label: 'Light', Icon: Sun },
              { p: 'dark' as ThemePref, label: 'Dark', Icon: Moon },
              { p: 'system' as ThemePref, label: 'System', Icon: Monitor },
            ]).map(({ p, label, Icon }) => (
              <button key={p} type="button" onClick={() => pickTheme(p)}
                className={cn('h-16 rounded-xl border text-sm font-medium flex flex-col items-center justify-center gap-1.5 transition-colors',
                  themePref === p ? 'border-accent bg-accent/10 text-ink' : 'border-border-strong bg-surface text-ink-muted hover:text-ink')}>
                <Icon className={cn('w-4 h-4', themePref === p && 'text-accent')} />
                {label}
              </button>
            ))}
          </div>
        </CardBody>
      </Card>
      </div>
      {/* END BUSINESS non-form cards */}

      {/* The form stays mounted across the Business / Pricing / Scheduling tabs
          so react-hook-form never loses values when switching tabs. Each card
          group is shown/hidden by tab; the Save footer submits every field. */}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card className={cn(tab !== 'business' && 'hidden')}>
          <CardHeader><h2 className="text-sm font-semibold text-ink">Company Information</h2></CardHeader>
          <CardBody className="space-y-4">
            <Input label="Company Name" {...register('company_name')} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Owner Name" {...register('owner_name')} />
              <Input label="Phone" {...register('phone')} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
            <Input
              label="Crew Cost Per Hour ($/hr)"
              type="number" step="5" min="0"
              hint="What one crew-hour actually costs you (wages + overhead). Used everywhere profit is shown — the measure verdict, profitability, and suggestions. Most solo/2-person lawn crews land around $40/hr."
              {...register('crew_cost_per_hour')}
            />
            <Input
              label="Target Revenue Per Hour ($/hr)"
              type="number" step="5" min="0"
              hint="Your minimum acceptable revenue per crew-hour (on-site + drive). The Suggestions Center flags customers, routes and areas below this — and recommends raising the price or tightening the route before ever suggesting a drop. A common floor is $60–$80/hr."
              {...register('target_rev_per_hour')}
            />
            <Textarea label="PDF Terms & Conditions" rows={5} {...register('terms_text')} />
          </CardBody>
        </Card>

        <Card className={cn(tab !== 'pricing' && 'hidden')}>
          <CardHeader>
            <div>
              <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><CreditCard className="w-4 h-4 text-accent" /> Payment &amp; Fees</h2>
              <p className="text-xs text-ink-faint mt-0.5">How card-processing cost is recovered. The default bakes a small increase into NEW quotes — never a card surcharge (compliant in Alberta; no separate fee line is shown to customers).</p>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Fee recovery strategy</label>
              <select {...register('payment_fee_strategy')}
                className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all">
                <option value="global_price_increase">Global price increase (recommended)</option>
                <option value="absorb">Absorb the fee (no change)</option>
                <option value="etransfer_discount" disabled>E-transfer discount (coming soon)</option>
              </select>
              <p className="text-xs text-ink-faint">“Global price increase” adds the % below to every NEW quote so card fees are covered. Existing quotes are never changed.</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Fee recovery %" type="number" step="0.5" min="0" max="10"
                hint="Baked into new quote prices. ~3% covers Stripe's ~2.9% + 30¢."
                {...register('fee_recovery_percent')} />
              <Input label="GST % (if registered)" type="number" step="0.5" min="0" max="15"
                hint="Alberta GST is 5%. Leave 0 if you're not GST-registered — no GST line will be shown."
                {...register('gst_percent')} />
            </div>
            <Input label="E-transfer email" type="email" placeholder="pay@yourbusiness.com"
              hint="The email registered with your bank for Interac e-transfers (often your business email). Shown to customers in the portal's Ways to pay."
              {...register('etransfer_email')} />

            {/* ── Recurring AutoPay ── */}
            <div className="pt-4 mt-2 border-t border-border">
              <h3 className="text-sm font-semibold text-ink flex items-center gap-2"><Zap className="w-4 h-4 text-accent" /> Recurring AutoPay</h3>
              <p className="text-xs text-ink-faint mt-0.5 mb-3">For customers with a saved card and AutoPay enabled. A customer can override the timing on their profile.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">When to charge</label>
                  <select {...register('autopay_charge_mode')}
                    className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all">
                    <option value="auto">Charge automatically on completion</option>
                    <option value="manual_review">Hold for my review, then charge</option>
                  </select>
                  <p className="text-xs text-ink-faint">“Automatically” charges the saved card the moment a recurring visit is completed.</p>
                </div>
                <Input label="Review threshold %" type="number" step="5" min="0" max="200"
                  hint="Hold (don't auto-charge) any recurring invoice that differs from the customer's usual amount by more than this %."
                  {...register('autopay_variance_pct')} />
              </div>
            </div>
          </CardBody>
        </Card>

        <Card className={cn(tab !== 'scheduling' && 'hidden')}>
          <CardHeader>
            <div>
              <h2 className="text-sm font-semibold text-ink">Work Schedule</h2>
              <p className="text-xs text-ink-faint mt-0.5">Drives the weekly scheduler, per-stop arrival times and the day-load signal.</p>
            </div>
          </CardHeader>
          <CardBody className="space-y-5">
            <div>
              <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Preferred work days</p>
              <div className="flex flex-wrap gap-2">
                {WEEKDAYS.map(w => {
                  const on = workDays.includes(w.i)
                  return (
                    <button key={w.i} type="button" onClick={() => toggleDay(w.i)}
                      className={cn(
                        'px-3.5 py-2 rounded-xl text-sm font-medium border transition-colors flex items-center gap-1.5',
                        on ? 'bg-accent text-black border-accent' : 'bg-surface border-border-strong text-ink-muted hover:text-ink'
                      )}>
                      <span className={cn('w-3.5 h-3.5 rounded border flex items-center justify-center', on ? 'border-black/40 bg-black/10' : 'border-border-strong')}>
                        {on && <Check className="w-3 h-3" />}
                      </span>
                      {w.l}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Work day start time</label>
                <input type="time" value={workStart} onChange={e => setWorkStart(e.target.value)}
                  className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all" />
                <p className="text-xs text-ink-faint">Arrival times for each stop and the estimated finish are computed from this.</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Daily capacity (hours)</label>
                <input type="number" min="1" max="16" step="0.5" value={capacityHours} onChange={e => setCapacityHours(e.target.value)}
                  className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all" />
                <p className="text-xs text-ink-faint">Days past this show as overloaded; days with an hour+ spare show room for more jobs.</p>
              </div>
            </div>
          </CardBody>
        </Card>

        <Card className={cn(tab !== 'scheduling' && 'hidden')}>
          <CardHeader>
            <div>
              <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><CalendarRange className="w-4 h-4 text-accent" /> Service Seasons</h2>
              <p className="text-xs text-ink-faint mt-0.5">Recurring lawn &amp; snow services default to ending at season end. Off-season customers won&apos;t show as lapsed in Reactivation.</p>
            </div>
          </CardHeader>
          <CardBody className="space-y-5">
            <SeasonEditor
              icon={<Sun className="w-4 h-4 text-amber-400" />}
              title="Lawn Season"
              hint="Weekly/Bi-Weekly Mowing, Monthly Lawn Care, Fertilization"
              season={seasons.lawn}
              onChange={s => setSeasons(prev => ({ ...prev, lawn: s }))}
            />
            <SeasonEditor
              icon={<Snowflake className="w-4 h-4 text-sky-400" />}
              title="Snow Season"
              hint="Snow Removal, Snow Blowing, Snow Clearing (can wrap the new year)"
              season={seasons.snow}
              onChange={s => setSeasons(prev => ({ ...prev, snow: s }))}
            />
            <button type="button" onClick={() => setSeasons(DEFAULT_SEASONS)}
              className="text-xs text-accent hover:underline">Reset to Calgary defaults (Apr 15 → Oct 31 · Nov 1 → Mar 31)</button>
          </CardBody>
        </Card>

        <Card className={cn(tab !== 'pricing' && 'hidden')}>
          <CardHeader>
            <div>
              <h2 className="text-sm font-semibold text-ink">Lawn Pricing</h2>
              <p className="text-xs text-ink-faint mt-0.5">Drives suggested measurement prices. Recommended = base price × multiplier.</p>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Base / minimum charge ($)" type="number" step="1" min="0"
                hint="The show-up minimum for any lawn."
                {...register('pricing_base_charge')} />
              <Input label="Mowing rate ($ / 1,000 sq ft)" type="number" step="1" min="0"
                hint="Added on top of the base, per 1,000 sq ft."
                {...register('pricing_mow_rate')} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Recommended multiplier" type="number" step="0.05" min="0"
                hint="1.0 = the realistic everyday quote (not inflated)."
                {...register('pricing_recommended_mult')} />
              <Input label="Premium multiplier" type="number" step="0.05" min="0"
                hint="The upsell tier, e.g. 1.2."
                {...register('pricing_premium_mult')} />
            </div>
            <Input label="Travel rate ($ / km)" type="number" step="0.25" min="0"
              hint="Driving distance from base × this rate (route-density discounts apply automatically)."
              {...register('pricing_travel_rate')} />
            <p className="text-xs text-ink-faint">
              Defaults are tuned for Calgary mow+trim+edge: ~$40 small, ~$50–60 medium, ~$70–80 large lawns.
            </p>
          </CardBody>
        </Card>

        {/* Persistent Save footer — visible on any form-bearing tab, submits
            every field (Company Info, Payment & Fees, Work Schedule, Service
            Seasons, Lawn Pricing) regardless of which tab is active. */}
        {showSave && (
          <div className="sticky bottom-0 z-10 -mx-1 px-1">
            <div className="rounded-card border border-border bg-surface/95 backdrop-blur px-6 py-4 flex items-center justify-end gap-3">
              <span className="text-xs text-ink-faint mr-auto">Saves all business, pricing &amp; scheduling settings.</span>
              <Button type="submit" loading={isSubmitting}>
                {saved ? <><Check className="w-4 h-4" /> Saved</> : 'Save Settings'}
              </Button>
            </div>
          </div>
        )}
      </form>

      {/* PRICING — standalone (not part of the react-hook-form) */}
      <Card className={cn(tab !== 'pricing' && 'hidden')}>
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

      {/* MESSAGING */}
      <div className={cn('space-y-6', tab !== 'messaging' && 'hidden')}>
        <AutomationToggles />
        <MessagingUsage />
        <MessageTemplateEditor />
        <CommunicationsTest />
      </div>

      {/* NOTIFICATIONS */}
      <div className={cn('space-y-6', tab !== 'notifications' && 'hidden')}>
        <PushNotificationSettings />
      </div>

      {/* BOOKING */}
      <div className={cn('space-y-6', tab !== 'booking' && 'hidden')}>
        <WebsiteIntegration />
      </div>
    </div>
  )
}

const MONTH_OPTS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  .map((m, i) => ({ value: i + 1, label: m }))

function SeasonEditor({ icon, title, hint, season, onChange }: {
  icon: React.ReactNode; title: string; hint: string; season: ServiceSeason; onChange: (s: ServiceSeason) => void
}) {
  const set = (patch: Partial<ServiceSeason>) => onChange({ ...season, ...patch })
  const dayField = (val: number, key: 'startDay' | 'endDay') => (
    <input type="number" min={1} max={31} value={val}
      onChange={e => set({ [key]: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })}
      className="w-16 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-2 text-sm text-ink outline-none focus:border-accent" />
  )
  const monthField = (val: number, key: 'startMonth' | 'endMonth') => (
    <select value={val} onChange={e => set({ [key]: Number(e.target.value) })}
      className="bg-bg-tertiary border border-border-strong rounded-lg px-2 py-2 text-sm text-ink outline-none focus:border-accent">
      {MONTH_OPTS.map(o => <option key={o.value} value={o.value} className="bg-bg-secondary">{o.label}</option>)}
    </select>
  )
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-sm font-semibold text-ink">{title}</span>
        <span className="ml-auto text-xs font-medium text-accent">{seasonLabel(season)}</span>
      </div>
      <p className="text-[11px] text-ink-faint mb-2">{hint}</p>
      <div className="flex items-center gap-2 flex-wrap text-xs text-ink-muted">
        <span>Starts</span>{monthField(season.startMonth, 'startMonth')}{dayField(season.startDay, 'startDay')}
        <span className="mx-1">→</span>
        <span>Ends</span>{monthField(season.endMonth, 'endMonth')}{dayField(season.endDay, 'endDay')}
      </div>
    </div>
  )
}