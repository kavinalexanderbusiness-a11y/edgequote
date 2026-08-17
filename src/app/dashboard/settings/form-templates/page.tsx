'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  listFormTemplates, listTemplateFields, createFormTemplate, updateFormTemplate,
  setFormTemplateArchived, deleteFormTemplate, duplicateFormTemplate,
  insertTemplateField, updateTemplateField, deleteTemplateField,
  FIELD_TYPE_COPY, PASSIVE_FIELD_TYPES,
  type FormTemplate, type FormTemplateField, type JobFormFieldType,
} from '@/lib/jobForms'
import {
  Plus, Copy, Archive, ArchiveRestore, Trash2, ChevronUp, ChevronDown, X,
  ClipboardCheck, GripVertical,
} from 'lucide-react'

// ── Job checklists: the template library ─────────────────────────────────────
// The owner builds a reusable checklist/form here — "Furnace Service
// Checklist", "Move-out Clean" — and points services (or a recurring series,
// or one visit) at it. Editing a template changes FUTURE visits only: every
// attached form carries a frozen snapshot, so history keeps rendering exactly
// as it was filled.
//
// Deliberately NOT a page designer: eleven field types, label + help +
// required + choices + unit, up/down ordering. No conditional logic, no
// scripting — a checklist a worker can finish on a phone in a driveway.
//
// Archive, don't delete: a template that has ever been attached to a visit is
// UNDELETABLE by database constraint (history must keep rendering). Archiving
// removes it from every picker while old forms live on.

const FIELD_TYPES: JobFormFieldType[] = [
  'section', 'instruction', 'checkbox', 'short_text', 'long_text',
  'number', 'yes_no', 'dropdown', 'date', 'time', 'photo',
]

export default function FormTemplatesPage() {
  const supabase = createClient()
  const [templates, setTemplates] = useState<FormTemplate[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [fields, setFields] = useState<FormTemplateField[] | null>(null)
  const [busy, setBusy] = useState(false)
  const editorRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      setTemplates(await listFormTemplates(supabase, { includeArchived: true }))
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Couldn’t load checklists.')
    }
  }, [supabase])
  useEffect(() => { void load() }, [load])

  const openTemplate = useCallback(async (id: string | null) => {
    setOpenId(id)
    setFields(null)
    if (!id) return
    try {
      setFields(await listTemplateFields(supabase, id))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Couldn’t load the fields.')
    }
  }, [supabase])

  async function onCreate() {
    setBusy(true)
    try {
      const t = await createFormTemplate(supabase, 'New checklist')
      await load()
      await openTemplate(t.id)
      editorRef.current?.scrollIntoView({ block: 'start' })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Couldn’t create it.')
    } finally { setBusy(false) }
  }

  const open = templates?.find(t => t.id === openId) ?? null
  const active = (templates ?? []).filter(t => !t.archived_at)
  const archived = (templates ?? []).filter(t => t.archived_at)

  if (loadError && !templates) return (
    <PageContainer width="narrow">
      <PageHeader crumb={{ label: 'Settings', href: '/dashboard/settings' }} title="Job Checklists" />
      <Banner tone="danger" action={<Button size="sm" variant="secondary" onClick={() => load()}>Retry</Button>}>
        Could not load your checklists — they are still there, this page just couldn’t reach them. ({loadError})
      </Banner>
    </PageContainer>
  )

  if (!templates) return (
    <PageContainer width="narrow">
      <PageHeader crumb={{ label: 'Settings', href: '/dashboard/settings' }} title="Job Checklists"
        description="Standard checklists and forms your visits carry — filled by the crew, checked before completion." />
      <Card><div className="p-2"><SkeletonRows count={4} /></div></Card>
    </PageContainer>
  )

  return (
    <PageContainer width="narrow">
      <PageHeader
        crumb={{ label: 'Settings', href: '/dashboard/settings' }}
        title="Job Checklists"
        description="Standard checklists and forms your visits carry — filled by the crew, checked before completion. Point a service at one in Service Templates, or attach one to any visit."
        action={<Button onClick={onCreate} loading={busy}><Plus className="w-4 h-4" /> New checklist</Button>}
      />

      {open && (
        <div ref={editorRef}>
          <TemplateEditor
            template={open}
            fields={fields}
            onClose={() => openTemplate(null)}
            onChanged={async () => { await load(); if (openId) setFields(await listTemplateFields(supabase, openId)) }}
          />
        </div>
      )}

      {active.length === 0 && archived.length === 0 ? (
        <Card><InlineEmpty>
          No checklists yet. Build one — “Kitchen complete”, “Filter changed”, “After photo” — and every visit that carries it will ask for exactly that.
        </InlineEmpty></Card>
      ) : (
        <Card>
          <div className="divide-y divide-border">
            {active.map(t => (
              <TemplateRow key={t.id} t={t} isOpen={openId === t.id}
                onOpen={() => openTemplate(openId === t.id ? null : t.id)} onChanged={load} />
            ))}
          </div>
        </Card>
      )}

      {archived.length > 0 && (
        <div>
          <h3 className="text-[10px] font-semibold text-ink-faint uppercase tracking-[0.14em] mb-2 px-1">Archived</h3>
          <Card>
            <div className="divide-y divide-border">
              {archived.map(t => (
                <TemplateRow key={t.id} t={t} isOpen={openId === t.id}
                  onOpen={() => openTemplate(openId === t.id ? null : t.id)} onChanged={load} />
              ))}
            </div>
          </Card>
        </div>
      )}
    </PageContainer>
  )
}

function TemplateRow({ t, isOpen, onOpen, onChanged }: {
  t: FormTemplate; isOpen: boolean; onOpen: () => void; onChanged: () => Promise<void> | void
}) {
  const supabase = createClient()
  const archived = t.archived_at != null
  return (
    <div
      onClick={onOpen}
      className={cn('flex items-center gap-3 px-5 py-3.5 cursor-pointer hover:bg-surface-raised/40 transition-colors', isOpen && 'bg-surface-raised/30')}
    >
      <ClipboardCheck className={cn('w-4 h-4 shrink-0', archived ? 'text-ink-faint' : 'text-accent-text')} aria-hidden />
      <div className="flex-1 min-w-0">
        <span className={cn('text-sm font-medium', archived ? 'text-ink-faint line-through' : 'text-ink')}>{t.name}</span>
        {t.description && <p className="text-xs text-ink-muted truncate mt-0.5">{t.description}</p>}
      </div>
      <Button variant="ghost" size="sm" aria-label={`Duplicate ${t.name}`} title="Duplicate"
        onClick={async e => {
          e.stopPropagation()
          try { await duplicateFormTemplate(supabase, t.id); await onChanged() }
          catch (err) { toast.error(err instanceof Error ? err.message : 'Couldn’t duplicate it.') }
        }}>
        <Copy className="w-4 h-4" />
      </Button>
      <Button variant="ghost" size="sm"
        aria-label={archived ? `Restore ${t.name}` : `Archive ${t.name}`}
        title={archived ? 'Restore' : 'Archive — old visits keep rendering it'}
        onClick={async e => {
          e.stopPropagation()
          const r = await setFormTemplateArchived(supabase, t.id, !archived)
          if (!r.ok) { toast.error(r.error || 'Couldn’t change that.'); return }
          await onChanged()
        }}>
        {archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
      </Button>
      <Button variant="ghost" size="sm" aria-label={`Delete ${t.name}`} title="Delete (only while unused)"
        className="text-red-400/70 hover:text-red-400"
        onClick={async e => {
          e.stopPropagation()
          const r = await deleteFormTemplate(supabase, t.id)
          if (!r.ok) { toast.error(r.error || 'Couldn’t delete it.'); return }
          await onChanged()
        }}>
        <Trash2 className="w-4 h-4" />
      </Button>
    </div>
  )
}

// ── The editor: name, description, and the field list ────────────────────────

function TemplateEditor({ template, fields, onClose, onChanged }: {
  template: FormTemplate
  fields: FormTemplateField[] | null
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const supabase = createClient()
  const [name, setName] = useState(template.name)
  const [description, setDescription] = useState(template.description ?? '')
  const [newType, setNewType] = useState<JobFormFieldType>('checkbox')
  useEffect(() => { setName(template.name); setDescription(template.description ?? '') }, [template])

  async function saveMeta() {
    if (name.trim() === template.name && (description.trim() || null) === template.description) return
    if (!name.trim()) { toast.error('A checklist needs a name.'); setName(template.name); return }
    const r = await updateFormTemplate(supabase, template.id, {
      name: name.trim(), description: description.trim() || null,
    })
    if (!r.ok) { toast.error(r.error || 'Couldn’t save that.'); return }
    await onChanged()
  }

  async function addField() {
    const nextPos = (fields?.length ? Math.max(...fields.map(f => f.position)) : 0) + 1
    try {
      await insertTemplateField(supabase, template.id, {
        position: nextPos,
        field_type: newType,
        label: FIELD_TYPE_COPY[newType],
        help_text: null,
        required: false,
        options: newType === 'dropdown' ? ['Option 1', 'Option 2'] : null,
        unit: null,
        photo_kind: newType === 'photo' ? 'general' : null,
      })
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Couldn’t add the field.')
    }
  }

  async function move(f: FormTemplateField, dir: -1 | 1) {
    if (!fields) return
    const idx = fields.findIndex(x => x.id === f.id)
    const other = fields[idx + dir]
    if (!other) return
    // Swap positions; two small updates, then reload the truth.
    const a = await updateTemplateField(supabase, f.id, { position: other.position })
    const b = await updateTemplateField(supabase, other.id, { position: f.position })
    if (!a.ok || !b.ok) toast.error('Couldn’t reorder — reload and try again.')
    await onChanged()
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Edit checklist</h2>
        <div className="flex items-center gap-2">
          <p className="text-[11px] text-ink-faint hidden sm:block">
            Changes apply to future visits — forms already on a visit keep their snapshot.
          </p>
          <Button variant="ghost" size="sm" aria-label="Close editor" onClick={onClose}><X className="w-4 h-4" /></Button>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-xs font-medium text-ink-muted">Name *</span>
            <input
              value={name} onChange={e => setName(e.target.value)} onBlur={saveMeta} maxLength={120}
              className="mt-1 w-full h-10 rounded-lg border border-border bg-bg-secondary px-3 text-sm text-ink focus:outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-muted">Description</span>
            <input
              value={description} onChange={e => setDescription(e.target.value)} onBlur={saveMeta} maxLength={500}
              placeholder="When does this checklist apply?"
              className="mt-1 w-full h-10 rounded-lg border border-border bg-bg-secondary px-3 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
            />
          </label>
        </div>

        {fields === null ? (
          <SkeletonRows count={3} />
        ) : (
          <div className="space-y-2">
            {fields.length === 0 && (
              <p className="text-xs text-ink-faint">No items yet — add the first one below.</p>
            )}
            {fields.map((f, i) => (
              <FieldEditor key={f.id} f={f}
                first={i === 0} last={i === fields.length - 1}
                onMove={dir => move(f, dir)} onChanged={onChanged} />
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1 border-t border-border">
          <select
            value={newType} onChange={e => setNewType(e.target.value as JobFormFieldType)}
            className="h-9 rounded-lg border border-border bg-bg-secondary px-2.5 text-xs text-ink focus:outline-none focus:border-accent"
          >
            {FIELD_TYPES.map(t => <option key={t} value={t}>{FIELD_TYPE_COPY[t]}</option>)}
          </select>
          <Button size="sm" variant="secondary" onClick={() => void addField()}>
            <Plus className="w-3.5 h-3.5" /> Add item
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

function FieldEditor({ f, first, last, onMove, onChanged }: {
  f: FormTemplateField
  first: boolean; last: boolean
  onMove: (dir: -1 | 1) => void
  onChanged: () => Promise<void>
}) {
  const supabase = createClient()
  const [label, setLabel] = useState(f.label)
  const [help, setHelp] = useState(f.help_text ?? '')
  const [unit, setUnit] = useState(f.unit ?? '')
  const [options, setOptions] = useState((f.options ?? []).join('\n'))
  useEffect(() => {
    setLabel(f.label); setHelp(f.help_text ?? ''); setUnit(f.unit ?? '')
    setOptions((f.options ?? []).join('\n'))
  }, [f])

  const passive = PASSIVE_FIELD_TYPES.includes(f.field_type)

  async function patch(p: Parameters<typeof updateTemplateField>[2]) {
    const r = await updateTemplateField(supabase, f.id, p)
    if (!r.ok) { toast.error(r.error || 'Couldn’t save the field.'); return }
    await onChanged()
  }

  return (
    <div className="rounded-lg border border-border bg-bg-tertiary/40 p-2.5">
      <div className="flex items-start gap-2">
        <GripVertical className="w-4 h-4 mt-2 text-ink-faint shrink-0" aria-hidden />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint bg-ink-faint/10 px-2 py-0.5 rounded-full shrink-0">
              {FIELD_TYPE_COPY[f.field_type]}
            </span>
            <input
              value={label} onChange={e => setLabel(e.target.value)} maxLength={200}
              onBlur={() => { if (label.trim() && label !== f.label) void patch({ label: label.trim() }); else setLabel(f.label) }}
              className="flex-1 min-w-[10rem] h-9 rounded-lg border border-border bg-bg-secondary px-2.5 text-sm text-ink focus:outline-none focus:border-accent"
            />
            {!passive && (
              <label className="flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer shrink-0">
                <input type="checkbox" checked={f.required} onChange={e => void patch({ required: e.target.checked })} className="accent-current" />
                Required
              </label>
            )}
          </div>
          {f.field_type !== 'section' && (
            <input
              value={help} onChange={e => setHelp(e.target.value)} maxLength={500}
              onBlur={() => { if ((help.trim() || null) !== f.help_text) void patch({ help_text: help.trim() || null }) }}
              placeholder="Helper text (optional)"
              className="w-full h-8 rounded-lg border border-border bg-bg-secondary px-2.5 text-xs text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
            />
          )}
          {f.field_type === 'dropdown' && (
            <textarea
              value={options} onChange={e => setOptions(e.target.value)} rows={3}
              onBlur={() => {
                const list = options.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 30)
                if (list.length === 0) { toast.error('A dropdown needs at least one choice.'); setOptions((f.options ?? []).join('\n')); return }
                if (JSON.stringify(list) !== JSON.stringify(f.options ?? [])) void patch({ options: list })
              }}
              placeholder={'One choice per line'}
              className="w-full rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
            />
          )}
          {f.field_type === 'number' && (
            <input
              value={unit} onChange={e => setUnit(e.target.value)} maxLength={20}
              onBlur={() => { if ((unit.trim() || null) !== f.unit) void patch({ unit: unit.trim() || null }) }}
              placeholder="Unit label (°F, psi, sq ft…) — optional"
              className="w-full max-w-[16rem] h-8 rounded-lg border border-border bg-bg-secondary px-2.5 text-xs text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
            />
          )}
          {f.field_type === 'photo' && (
            <select
              value={f.photo_kind ?? 'general'}
              onChange={e => void patch({ photo_kind: e.target.value as FormTemplateField['photo_kind'] })}
              className="h-8 rounded-lg border border-border bg-bg-secondary px-2.5 text-xs text-ink focus:outline-none focus:border-accent"
            >
              <option value="general">Photo</option>
              <option value="before">Before photo</option>
              <option value="after">After photo</option>
            </select>
          )}
        </div>
        <div className="flex flex-col gap-0.5 shrink-0">
          <Button variant="ghost" size="sm" aria-label="Move up" disabled={first} onClick={() => onMove(-1)}><ChevronUp className="w-4 h-4" /></Button>
          <Button variant="ghost" size="sm" aria-label="Move down" disabled={last} onClick={() => onMove(1)}><ChevronDown className="w-4 h-4" /></Button>
          <Button variant="ghost" size="sm" aria-label="Remove item" className="text-red-400/70 hover:text-red-400"
            onClick={async () => {
              const r = await deleteTemplateField(supabase, f.id)
              if (!r.ok) { toast.error(r.error || 'Couldn’t remove it.'); return }
              await onChanged()
            }}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
