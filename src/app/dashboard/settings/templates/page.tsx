'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useBusinessData } from '@/hooks/useBusinessData'
import type { ServiceTemplate, ServiceTemplateFormValues } from '@/types'
import { SERVICE_CATEGORIES, PRICING_DISPLAY_TYPES, PRICING_DISPLAY_TYPE_LABELS } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { useForm } from 'react-hook-form'
import { formatServicePrice, priceInputLabel, priceInputStep } from '@/lib/servicePricing'
import { toast } from '@/lib/toast'
import { Plus, Edit2, Trash2, X } from 'lucide-react'

export default function ServiceTemplatesPage() {
  const { templates, loading, refresh } = useBusinessData()
  const supabase = createClient()

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<ServiceTemplate | null>(null)
  const formRef = useRef<HTMLDivElement>(null)

  const { register, handleSubmit, reset, watch, setValue, formState: { isSubmitting } } =
    useForm<ServiceTemplateFormValues>({
      defaultValues: { name: '', category: 'Lawn Care', pricing_display_type: 'starting_from', default_rate: 65, default_description: '', notes: '', is_active: true },
    })

  const isActive = watch('is_active')
  const pdType = watch('pricing_display_type')
  const priceVal = watch('default_rate')

  // The editor is an inline panel rendered at the TOP of the page. Without this,
  // clicking a row's Edit (or Add) while scrolled down the list opens the form
  // above the fold — so it looks like "nothing happened". Bring it into view
  // whenever it opens, and when switching which service is being edited.
  useEffect(() => {
    if (showForm) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [showForm, editing])

  function openNew() {
    reset({ name: '', category: 'Lawn Care', pricing_display_type: 'starting_from', default_rate: 65, default_description: '', notes: '', is_active: true })
    setEditing(null)
    setShowForm(true)
  }

  function openEdit(t: ServiceTemplate) {
    reset({
      name: t.name, category: t.category, default_rate: t.default_rate,
      pricing_display_type: t.pricing_display_type || 'starting_from',
      default_description: t.default_description || '', notes: t.notes || '', is_active: t.is_active,
    })
    setEditing(t)
    setShowForm(true)
  }

  async function onSubmit(values: ServiceTemplateFormValues) {
    const { data: { user } } = await supabase.auth.getUser()
    const payload = { ...values, default_rate: Number(values.default_rate) }
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

  const categoryOptions = SERVICE_CATEGORIES.map(c => ({ value: c, label: c }))
  const pricingTypeOptions = PRICING_DISPLAY_TYPES.map(t => ({ value: t, label: PRICING_DISPLAY_TYPE_LABELS[t] }))

  if (loading) return <div className="text-center py-16 text-sm text-ink-muted">Loading templates...</div>

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Service Templates"
        description="Add, edit, or remove services. The quote builder pulls from this list."
        action={<Button onClick={openNew}><Plus className="w-4 h-4" /> Add Service</Button>}
      />

      {showForm && (
        <div ref={formRef}>
        <Card>
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">{editing ? 'Edit Service' : 'New Service'}</h2>
            <button onClick={() => { setShowForm(false); setEditing(null) }} className="text-ink-faint hover:text-ink">
              <X className="w-4 h-4" />
            </button>
          </CardHeader>
          <CardBody>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <Input label="Service Name" {...register('name', { required: true })} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Select label="Category" options={categoryOptions} {...register('category')} />
                <Select label="Pricing Display Type" options={pricingTypeOptions} {...register('pricing_display_type')} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
                <Input label={priceInputLabel(pdType)} type="number" step={priceInputStep(pdType)} min="0" {...register('default_rate', { required: true })} />
                <div className="sm:pt-7">
                  <p className="text-xs text-ink-muted">Shows as <span className="font-semibold text-accent">{formatServicePrice({ pricing_display_type: pdType, default_rate: Number(priceVal) || 0 })}</span></p>
                </div>
              </div>
              <Textarea label="Default Description" {...register('default_description')} />
              <Textarea label="Internal Notes" {...register('notes')} />
              <div className="flex items-center justify-between pt-1">
                <Toggle checked={isActive} onChange={v => setValue('is_active', v)} label={isActive ? 'Active' : 'Inactive'} />
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" onClick={() => { setShowForm(false); setEditing(null) }}>Cancel</Button>
                  <Button type="submit" loading={isSubmitting}>{editing ? 'Save' : 'Add Service'}</Button>
                </div>
              </div>
            </form>
          </CardBody>
        </Card>
        </div>
      )}

      {Object.keys(grouped).length === 0 ? (
        <Card className="py-14 text-center text-sm text-ink-muted">No services yet. Add your first one.</Card>
      ) : (
        SERVICE_CATEGORIES.filter(c => grouped[c]?.length).map(category => (
          <div key={category}>
            <h3 className="text-xs font-semibold text-ink-faint uppercase tracking-wide mb-2 px-1">{category}</h3>
            <Card>
              <div className="divide-y divide-border">
                {grouped[category].map(t => (
                  // The whole row opens the editor (the pencil was the only way in);
                  // the inline controls stop the click from bubbling.
                  <div key={t.id} onClick={() => openEdit(t)}
                    className="flex items-center gap-4 px-5 py-3.5 cursor-pointer hover:bg-surface/40 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium ${t.is_active ? 'text-ink' : 'text-ink-faint line-through'}`}>{t.name}</span>
                        {!t.is_active && <span className="text-[10px] uppercase tracking-wide text-ink-faint bg-ink-faint/10 px-2 py-0.5 rounded-full">Inactive</span>}
                      </div>
                      {t.default_description && <p className="text-xs text-ink-muted truncate mt-0.5">{t.default_description}</p>}
                    </div>
                    <span className="text-sm font-semibold text-accent shrink-0">{formatServicePrice(t)}</span>
                    <span onClick={e => e.stopPropagation()}><Toggle checked={t.is_active} onChange={() => toggleActive(t)} /></span>
                    <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); openEdit(t) }}><Edit2 className="w-4 h-4" /></Button>
                    <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); remove(t) }} className="hover:text-red-400"><Trash2 className="w-4 h-4" /></Button>
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