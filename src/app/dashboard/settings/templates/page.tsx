'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useBusinessData } from '@/hooks/useBusinessData'
import type { ServiceTemplate, ServiceTemplateFormValues } from '@/types'
import { SERVICE_CATEGORIES } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageSkeleton } from '@/components/ui/Skeleton'
import { useForm } from 'react-hook-form'
import { formatCurrency } from '@/lib/utils'
import { Plus, Edit2, Trash2, X } from 'lucide-react'

export default function ServiceTemplatesPage() {
  const { templates, loading, refresh } = useBusinessData()
  const supabase = createClient()

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<ServiceTemplate | null>(null)

  const { register, handleSubmit, reset, watch, setValue, formState: { isSubmitting } } =
    useForm<ServiceTemplateFormValues>({
      defaultValues: { name: '', category: 'Lawn Care', default_rate: 50, default_description: '', notes: '', is_active: true },
    })

  const isActive = watch('is_active')

  function openNew() {
    reset({ name: '', category: 'Lawn Care', default_rate: 50, default_description: '', notes: '', is_active: true })
    setEditing(null)
    setShowForm(true)
  }

  function openEdit(t: ServiceTemplate) {
    reset({
      name: t.name, category: t.category, default_rate: t.default_rate,
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
    if (!confirm(`Delete "${t.name}"? This won't affect existing quotes.`)) return
    await supabase.from('service_templates').delete().eq('id', t.id)
    refresh()
  }

  const grouped = templates.reduce<Record<string, ServiceTemplate[]>>((acc, t) => {
    (acc[t.category] ||= []).push(t)
    return acc
  }, {})

  const categoryOptions = SERVICE_CATEGORIES.map(c => ({ value: c, label: c }))

  if (loading) return <PageSkeleton rows={5} className="max-w-3xl" />

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Service Templates"
        description="Add, edit, or remove services. The quote builder pulls from this list."
        action={<Button onClick={openNew}><Plus className="w-4 h-4" /> Add Service</Button>}
      />

      {showForm && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">{editing ? 'Edit Service' : 'New Service'}</h2>
            <Button variant="ghost" size="sm" onClick={() => { setShowForm(false); setEditing(null) }} aria-label="Close">
              <X className="w-4 h-4" />
            </Button>
          </CardHeader>
          <CardBody>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <Input label="Service Name" required {...register('name', { required: true })} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Select label="Category" options={categoryOptions} {...register('category')} />
                <Input label="Default Rate ($/man-hour)" type="number" step="5" min="50" required {...register('default_rate', { required: true })} />
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
      )}

      {Object.keys(grouped).length === 0 ? (
        <EmptyState icon={Plus} title="No services yet" description="Add your first one to power the quote builder."
          action={{ label: 'Add Service', onClick: openNew }} />
      ) : (
        SERVICE_CATEGORIES.filter(c => grouped[c]?.length).map(category => (
          <div key={category}>
            <h3 className="text-xs font-semibold text-ink-faint uppercase tracking-wide mb-2 px-1">{category}</h3>
            <Card>
              <div className="divide-y divide-border">
                {grouped[category].map(t => (
                  <div key={t.id} className="flex items-center gap-4 px-5 py-3.5">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium ${t.is_active ? 'text-ink' : 'text-ink-faint line-through'}`}>{t.name}</span>
                        {!t.is_active && <span className="text-[10px] uppercase tracking-wide text-ink-faint bg-ink-faint/10 px-2 py-0.5 rounded-full">Inactive</span>}
                      </div>
                      {t.default_description && <p className="text-xs text-ink-muted truncate mt-0.5">{t.default_description}</p>}
                    </div>
                    <span className="text-sm font-semibold text-accent shrink-0">{formatCurrency(t.default_rate)}<span className="text-ink-faint font-normal">/hr</span></span>
                    <Toggle checked={t.is_active} onChange={() => toggleActive(t)} />
                    <Button variant="ghost" size="sm" onClick={() => openEdit(t)}><Edit2 className="w-4 h-4" /></Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(t)} className="hover:text-red-400"><Trash2 className="w-4 h-4" /></Button>
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