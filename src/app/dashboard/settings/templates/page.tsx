'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useBusinessData } from '@/hooks/useBusinessData'
import type { ServiceTemplate, ServiceTemplateFormValues } from '@/types'
import { SERVICE_CATEGORIES, PRICING_DISPLAY_TYPES, PRICING_DISPLAY_TYPE_LABELS } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { useForm } from 'react-hook-form'
import { formatServicePrice, priceInputLabel, priceInputStep, costBasisLabel } from '@/lib/servicePricing'
import { totalUnitCost, marginPct, markupPct, unitProfit, marginTone, formatPct } from '@/lib/margin'
import { toneText } from '@/lib/tone'
import { formatCurrency, cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { Plus, Edit2, Trash2, X, Star } from 'lucide-react'
import { scrollBehavior } from '@/lib/motion'

// Sentinel for the "Other…" option. Never persisted: onSubmit swaps it for the
// typed name, so the DB only ever sees a real category.
const NEW_CATEGORY = '__new_category'

// ── Cost fields: blank is NOT zero ────────────────────────────────────────────
// The cost inputs are held as strings precisely so "" (never entered) stays
// distinguishable from "0" (really costs nothing). `Number('')` is 0, so parsing
// these with Number() anywhere would tell every owner who has never entered a
// cost that their services are 100% margin. Blank → null → the UI shows nothing.
function parseCost(v: string | null | undefined): number | null {
  const s = (v ?? '').trim()
  if (!s) return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100) / 100
}

// null → '' so an unknown cost renders as an empty box, not a literal "null".
const costToField = (n: number | null | undefined): string => (n == null ? '' : String(n))

export default function ServiceTemplatesPage() {
  const { templates, loading, refresh } = useBusinessData()
  const supabase = createClient()

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<ServiceTemplate | null>(null)
  const formRef = useRef<HTMLDivElement>(null)

  const { register, handleSubmit, reset, watch, setValue, formState: { isSubmitting, errors } } =
    useForm<ServiceTemplateFormValues>({
      // category/rate are re-seeded from this business's own catalogue in openNew();
      // 'General' is the neutral member of the starter list, not a trade.
      // Costs default to '' — unknown — never 0.
      defaultValues: { name: '', category: 'General', pricing_display_type: 'starting_from', default_rate: 65, default_description: '', notes: '', is_active: true, unit_cost: '', material_cost: '', is_favorite: false },
    })

  const isActive = watch('is_active')
  const pdType = watch('pricing_display_type')
  const catValue = watch('category')
  const [customCategory, setCustomCategory] = useState('')
  const priceVal = watch('default_rate')
  const isFavorite = watch('is_favorite')

  // Live margin as the owner types — computed by THE shared calculator, never
  // inline arithmetic, so this panel and every future one agree on what a margin
  // is. `cost` is null until at least one side is filled in, and every readout
  // below is gated on that rather than defaulting to zero.
  const cost = totalUnitCost({ unit_cost: parseCost(watch('unit_cost')), material_cost: parseCost(watch('material_cost')) })
  const price = Number(priceVal) || 0
  const margin = marginPct(price, cost)
  const basis = costBasisLabel(pdType)

  // The editor is an inline panel rendered at the TOP of the page. Without this,
  // clicking a row's Edit (or Add) while scrolled down the list opens the form
  // above the fold — so it looks like "nothing happened". Bring it into view
  // whenever it opens, and when switching which service is being edited.
  useEffect(() => {
    if (showForm) formRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })
  }, [showForm, editing])

  function openNew() {
    // Seed the category from what this business ACTUALLY files services under —
    // it used to be hardcoded 'Lawn Care', so every trade's second service landed
    // in a lawn bucket unless they noticed the dropdown. Falls back to the neutral
    // 'General' before they have any services.
    reset({ name: '', category: topCategory, pricing_display_type: 'starting_from', default_rate: 65, default_description: '', notes: '', is_active: true, unit_cost: '', material_cost: '', is_favorite: false })
    setCustomCategory('')
    setEditing(null)
    setShowForm(true)
  }

  function openEdit(t: ServiceTemplate) {
    reset({
      name: t.name, category: t.category, default_rate: t.default_rate,
      pricing_display_type: t.pricing_display_type || 'starting_from',
      default_description: t.default_description || '', notes: t.notes || '', is_active: t.is_active,
      // A stored null stays blank, so opening and re-saving a service that has no
      // cost cannot silently write 0 into it.
      unit_cost: costToField(t.unit_cost), material_cost: costToField(t.material_cost),
      is_favorite: !!t.is_favorite,
    })
    setEditing(t)
    setShowForm(true)
  }

  async function onSubmit(values: ServiceTemplateFormValues) {
    // Resolve the "Other…" sentinel to the typed name. It must never reach the DB —
    // and a blank one must not either, or the service files under a literal
    // '__new_category'.
    let category = values.category
    if (category === NEW_CATEGORY) {
      const typed = customCategory.trim()
      if (!typed) { toast.error('Name the new category, or pick an existing one.'); return }
      category = typed
    }
    const { data: { user } } = await supabase.auth.getUser()
    const payload = {
      ...values, category,
      default_rate: Number(values.default_rate),
      // Blank stays NULL. This is the one write path for cost, and it is the line
      // that keeps "unknown" out of the margin maths.
      unit_cost: parseCost(values.unit_cost),
      material_cost: parseCost(values.material_cost),
    }
    if (editing) {
      await supabase.from('service_templates').update(payload).eq('id', editing.id)
    } else {
      const nextOrder = templates.length + 1
      await supabase.from('service_templates').insert({ ...payload, sort_order: nextOrder, user_id: user!.id })
    }
    setShowForm(false)
    setEditing(null)
    refresh()
  }

  async function toggleActive(t: ServiceTemplate) {
    await supabase.from('service_templates').update({ is_active: !t.is_active }).eq('id', t.id)
    refresh()
  }

  async function toggleFavorite(t: ServiceTemplate) {
    await supabase.from('service_templates').update({ is_favorite: !t.is_favorite }).eq('id', t.id)
    refresh()
  }

  async function remove(t: ServiceTemplate) {
    await supabase.from('service_templates').delete().eq('id', t.id)
    refresh()
    // Reversible: re-insert the exact row (same id) on Undo.
    toast.undo(`Deleted "${t.name}"`, async () => {
      await supabase.from('service_templates').insert(t)
      refresh()
    })
  }

  const grouped = templates.reduce<Record<string, ServiceTemplate[]>>((acc, t) => {
    (acc[t.category] ||= []).push(t)
    return acc
  }, {})

  // service_templates.category is free TEXT; SERVICE_CATEGORIES is a starter list,
  // not the set of legal values. Merge in whatever this business actually uses, so
  // a category that arrived from anywhere else stays selectable instead of
  // silently resetting to a lawn one on the next edit.
  const usedCategories = Array.from(new Set(templates.map(t => (t.category || '').trim()).filter(Boolean)))
  const allCategories = Array.from(new Set<string>([...SERVICE_CATEGORIES, ...usedCategories]))
  // What this business files most of its work under — the seed for a new service.
  const topCategory = Object.entries(grouped).sort((a, b) => b[1].length - a[1].length)[0]?.[0] || 'General'
  // …and an escape from the list entirely. The column is free text; without this
  // the six starter categories were the only reachable values, so a pool company
  // filed everything under "General" forever. Select + Input, both existing
  // primitives — no new control.
  const categoryOptions = [...allCategories.map(c => ({ value: c, label: c })), { value: NEW_CATEGORY, label: 'Other…' }]
  const pricingTypeOptions = PRICING_DISPLAY_TYPES.map(t => ({ value: t, label: PRICING_DISPLAY_TYPE_LABELS[t] }))

  if (loading) return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader
        crumb={{ label: 'Settings', href: '/dashboard/settings' }}
        title="Service Templates"
        description="Add, edit, or remove services. The quote builder pulls from this list."
      />
      <Card><div className="p-2"><SkeletonRows count={5} /></div></Card>
    </div>
  )

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader
        crumb={{ label: 'Settings', href: '/dashboard/settings' }}
        title="Service Templates"
        description="Add, edit, or remove services. The quote builder pulls from this list."
        action={<Button variant={showForm ? 'secondary' : 'primary'} onClick={openNew}><Plus className="w-4 h-4" /> Add service</Button>}
      />

      {showForm && (
        <div ref={formRef}>
        <Card>
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">{editing ? 'Edit Service' : 'New Service'}</h2>
            <Button variant="ghost" size="sm" aria-label="Close editor" onClick={() => { setShowForm(false); setEditing(null) }}>
              <X className="w-4 h-4" />
            </Button>
          </CardHeader>
          <CardBody>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <Input label="Service Name *" autoFocus
                error={errors.name ? 'Service name is required' : undefined}
                {...register('name', { required: true })} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Select label="Category" options={categoryOptions} {...register('category')} />
                  {catValue === NEW_CATEGORY && (
                    <Input label="New category name *" autoFocus value={customCategory}
                      onChange={e => setCustomCategory(e.target.value)}
                      placeholder="e.g. Pool Service"
                      error={showForm && !customCategory.trim() ? 'Name the new category' : undefined} />
                  )}
                </div>
                <Select label="Pricing Display Type" options={pricingTypeOptions} {...register('pricing_display_type')} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
                <Input label={`${priceInputLabel(pdType)} *`} type="number" step={priceInputStep(pdType)} min="0"
                  error={errors.default_rate ? 'A price is required' : undefined}
                  {...register('default_rate', { required: true })} />
                <div className="sm:pt-7">
                  <p className="text-xs text-ink-muted">Shows as <span className="font-semibold text-accent-text">{formatServicePrice({ pricing_display_type: pdType, default_rate: Number(priceVal) || 0 })}</span></p>
                </div>
              </div>
              {/* ── Cost & margin ────────────────────────────────────────────
                  Optional, and deliberately quiet: an owner who doesn't track cost
                  should be able to ignore this entirely and see no margin claimed
                  anywhere. Both fields are labelled with the SAME basis as the
                  price above, so the margin compares like with like. */}
              <div className="rounded-xl border border-border bg-surface/30 p-4 space-y-3">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-xs font-semibold text-ink">
                    Cost to deliver <span className="font-normal text-ink-faint">· optional</span>
                  </h3>
                  <span className="text-[11px] text-ink-faint">Priced {basis}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input label={`Labour cost ${basis}`} type="number" step="1" min="0" placeholder="Not tracked"
                    {...register('unit_cost')} />
                  <Input label={`Material cost ${basis}`} type="number" step="1" min="0" placeholder="Not tracked"
                    {...register('material_cost')} />
                </div>
                {cost == null ? (
                  <p className="text-xs text-ink-muted">
                    Leave blank if you don&apos;t track cost — no margin will be shown or guessed.
                  </p>
                ) : (
                  <p className="text-xs flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className={cn('font-semibold tabular-nums', toneText[marginTone(margin)])}>
                      {formatPct(margin)} margin
                    </span>
                    <span className="text-ink-faint">·</span>
                    <span className="text-ink-muted tabular-nums">{formatPct(markupPct(price, cost))} markup</span>
                    <span className="text-ink-faint">·</span>
                    <span className="text-ink-muted tabular-nums">
                      {formatCurrency(unitProfit(price, cost) ?? 0)} profit {basis}
                    </span>
                    {margin != null && margin < 0 && (
                      <span className="text-red-400">— you&apos;re priced below cost</span>
                    )}
                  </p>
                )}
              </div>

              <Textarea label="Default Description" {...register('default_description')} />
              <Textarea label="Internal Notes" {...register('notes')} />
              <div className="flex items-center justify-between pt-1 gap-3">
                <div className="flex items-center gap-4">
                  <Toggle checked={isActive} onChange={v => setValue('is_active', v)} label={isActive ? 'Active' : 'Inactive'} />
                  {/* Favourites surface this service at the top of the quote
                      builder's picker — the payoff is there, not here. */}
                  <Toggle checked={!!isFavorite} onChange={v => setValue('is_favorite', v)} label="Favourite" />
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" onClick={() => { setShowForm(false); setEditing(null) }}>Cancel</Button>
                  <Button type="submit" loading={isSubmitting}>{editing ? 'Save service' : 'Add service'}</Button>
                </div>
              </div>
            </form>
          </CardBody>
        </Card>
        </div>
      )}

      {Object.keys(grouped).length === 0 ? (
        <Card><InlineEmpty>No services yet. Add your first one.</InlineEmpty></Card>
      ) : (
        // Render from the categories that EXIST, not from the constant. Iterating
        // the constant meant a service filed under anything outside those six was
        // invisible here while still living in the database — free-text column,
        // hardcoded reader.
        allCategories.filter(c => grouped[c]?.length).map(category => (
          <div key={category}>
            <h3 className="text-[10px] font-semibold text-ink-faint uppercase tracking-[0.14em] mb-2 px-1">{category}</h3>
            <Card>
              <div className="divide-y divide-border">
                {grouped[category].map(t => (
                  // The whole row opens the editor (the pencil was the only way in);
                  // the inline controls stop the click from bubbling.
                  <div key={t.id} onClick={() => openEdit(t)}
                    className="flex items-center gap-3 sm:gap-4 px-5 py-3.5 cursor-pointer hover:bg-surface/40 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium ${t.is_active ? 'text-ink' : 'text-ink-faint line-through'}`}>{t.name}</span>
                        {!t.is_active && <span className="text-[10px] uppercase tracking-wide text-ink-faint bg-ink-faint/10 px-2 py-0.5 rounded-full">Inactive</span>}
                      </div>
                      {t.default_description && <p className="text-xs text-ink-muted truncate mt-0.5">{t.default_description}</p>}
                    </div>
                    {/* Margin, only where a cost is known. Services with no cost
                        show nothing at all — the whole catalogue reading "100%"
                        would be worse than silence. */}
                    {(() => {
                      const m = marginPct(t.default_rate, totalUnitCost(t))
                      if (m == null) return null
                      return (
                        <span className={cn('hidden sm:inline text-xs font-semibold tabular-nums shrink-0', toneText[marginTone(m)])}
                          title={`${formatPct(m)} margin · ${formatPct(markupPct(t.default_rate, totalUnitCost(t)))} markup`}>
                          {formatPct(m)}
                        </span>
                      )
                    })()}
                    <span className="text-sm font-semibold text-accent-text shrink-0">{formatServicePrice(t)}</span>
                    <Button variant="ghost" size="sm" aria-pressed={!!t.is_favorite}
                      aria-label={t.is_favorite ? `Remove ${t.name} from favourites` : `Make ${t.name} a favourite`}
                      title={t.is_favorite ? 'Favourite — shown first in the quote builder' : 'Make favourite'}
                      onClick={e => { e.stopPropagation(); toggleFavorite(t) }}
                      className={t.is_favorite ? 'text-amber-400 hover:text-amber-300' : 'text-ink-faint hover:text-ink-muted'}>
                      <Star className={cn('w-4 h-4', t.is_favorite && 'fill-current')} />
                    </Button>
                    <span onClick={e => e.stopPropagation()}><Toggle checked={t.is_active} onChange={() => toggleActive(t)} /></span>
                    <Button variant="ghost" size="sm" aria-label="Edit service" title="Edit" onClick={e => { e.stopPropagation(); openEdit(t) }}><Edit2 className="w-4 h-4" /></Button>
                    <Button variant="ghost" size="sm" aria-label="Delete service" title="Delete" onClick={e => { e.stopPropagation(); remove(t) }} className="text-red-400/70 hover:text-red-400"><Trash2 className="w-4 h-4" /></Button>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        ))
      )}
    </div>
  )
}