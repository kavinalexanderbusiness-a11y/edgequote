'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Modal } from '@/components/ui/Modal'
import { Banner } from '@/components/ui/Banner'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/confirm'
import {
  CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES, ENTITY_HELP, ENTITY_LABEL, MAX_OPTIONS, TYPE_COPY,
  explainWriteError, isArchived, parseOptions, reconcileOptions, uniqueKey, validateDefinition,
  type CustomFieldEntity, type CustomFieldOption, type CustomFieldType,
} from '@/lib/customFields'
import type { CustomFieldDefinition } from '@/types'
import { Plus, Pencil, Archive, ArchiveRestore, Trash2, ChevronUp, ChevronDown, ListPlus, X, Lock } from 'lucide-react'

// ── Settings › Custom fields ─────────────────────────────────────────────────
// Where an owner adds the handful of things their trade records that EdgeHQ ships
// no column for — a gate code, a permit number, a referral partner.
//
// ⭐ IT IS A LIST, NOT A BUILDER. Name it, say what it is about, pick a type. There
// is no formula editor, no conditional logic, no lookup into another table and no
// layout designer, because each of those is the step where an attribute store
// stops being a CRM feature and becomes a database product with its own manual.
//
// ⭐ ARCHIVE IS THE PRIMARY RETIREMENT, DELETE IS THE EXCEPTION. A field that has
// collected answers cannot be deleted at all — the database refuses it (ON DELETE
// RESTRICT), so the promise "your records stay readable" is kept by the schema
// rather than by this screen remembering to ask. Delete stays available for the
// field created by mistake a minute ago, which has nothing to lose.

interface Draft {
  id: string | null
  entity: CustomFieldEntity
  label: string
  field_type: CustomFieldType
  options: CustomFieldOption[]
  help_text: string
}

const blankDraft = (entity: CustomFieldEntity): Draft => ({
  id: null, entity, label: '', field_type: 'text', options: [], help_text: '',
})

export function CustomFields() {
  const supabase = createClient()
  const [defs, setDefs] = useState<CustomFieldDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [showArchived, setShowArchived] = useState(false)

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { setError('Could not confirm who you are.'); setLoading(false); return }
    const { data, error: readErr } = await supabase
      .from('custom_field_definitions')
      .select('*')
      .eq('user_id', uid)
      .order('entity').order('sort_order').order('label')
    // A failed read must never render an EMPTY list as fact — an owner would
    // conclude their fields were gone and start recreating them.
    if (readErr) { setError(readErr.message); setLoading(false); return }
    setDefs((data as CustomFieldDefinition[]) || [])
    setError(null)
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const grouped = useMemo(() => CUSTOM_FIELD_ENTITIES.map(entity => ({
    entity,
    active: defs.filter(d => d.entity === entity && !isArchived(d))
      .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label)),
    archived: defs.filter(d => d.entity === entity && isArchived(d))
      .sort((a, b) => a.label.localeCompare(b.label)),
  })), [defs])

  const archivedCount = defs.filter(isArchived).length

  async function save() {
    if (!draft) return
    const check = validateDefinition({
      entity: draft.entity, label: draft.label, field_type: draft.field_type,
      options: draft.options, help_text: draft.help_text,
    })
    if (!check.ok) { toast.error(check.message); return }

    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { toast.error('Could not confirm who you are.'); return }

    setSaving(true)
    const existing = draft.id ? defs.find(d => d.id === draft.id) : undefined
    const options = draft.field_type === 'select'
      ? reconcileOptions(draft.options, existing ? parseOptions(existing) : [])
      : []
    const label = draft.label.trim()
    const help_text = draft.help_text.trim() || null

    if (existing) {
      // field_key, entity and field_type are absent from this update ON PURPOSE:
      // the first two are immutable, and the third is only offered while the field
      // is new (see the editor below).
      const { error: upErr } = await supabase
        .from('custom_field_definitions')
        .update({ label, help_text, options })
        .eq('id', existing.id)
      setSaving(false)
      if (upErr) { toast.error(explainWriteError(upErr.message)); return }
      toast.success(`Saved “${label}”`)
    } else {
      const siblings = defs.filter(d => d.entity === draft.entity)
      const { error: insErr } = await supabase.from('custom_field_definitions').insert({
        user_id: uid,
        entity: draft.entity,
        field_key: uniqueKey(label, siblings.map(d => d.field_key)),
        label,
        field_type: draft.field_type,
        options,
        help_text,
        sort_order: siblings.length ? Math.max(...siblings.map(d => d.sort_order)) + 1 : 0,
      })
      setSaving(false)
      if (insErr) { toast.error(explainWriteError(insErr.message)); return }
      toast.success(`Added “${label}”`)
    }
    setDraft(null)
    load()
  }

  async function setArchived(def: CustomFieldDefinition, archived: boolean) {
    const { error: upErr } = await supabase
      .from('custom_field_definitions')
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq('id', def.id)
    if (upErr) { toast.error(explainWriteError(upErr.message)); return }
    toast.success(archived ? `Archived “${def.label}”` : `Restored “${def.label}”`)
    load()
  }

  async function remove(def: CustomFieldDefinition) {
    const ok = await confirm({
      title: `Delete “${def.label}”?`,
      message: 'Only possible while the field has never been filled in. If any record uses it, archive it instead — archiving keeps every answer readable.',
      confirmLabel: 'Delete field',
      destructive: true,
      icon: Trash2,
    })
    if (!ok) return
    const { error: delErr } = await supabase.from('custom_field_definitions').delete().eq('id', def.id)
    // The database refuses this when answers exist. Say so in the owner's words
    // rather than echoing a constraint name.
    if (delErr) { toast.error(explainWriteError(delErr.message)); return }
    toast.success(`Deleted “${def.label}”`)
    load()
  }

  /** Reorder within one entity. Writes only the two rows that actually swapped. */
  async function move(def: CustomFieldDefinition, dir: -1 | 1) {
    const row = grouped.find(g => g.entity === def.entity)
    if (!row) return
    const i = row.active.findIndex(d => d.id === def.id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= row.active.length) return
    const other = row.active[j]
    // Positions are rewritten from the list's own order, so a group that was
    // saved with duplicate or sparse sort_order values self-heals on first move.
    const next = [...row.active]
    next[i] = other; next[j] = def
    const writes = next.map((d, idx) => ({ id: d.id, sort_order: idx }))
      .filter(w => defs.find(d => d.id === w.id)?.sort_order !== w.sort_order)
    setDefs(prev => prev.map(d => {
      const w = writes.find(x => x.id === d.id)
      return w ? { ...d, sort_order: w.sort_order } : d
    }))
    const results = await Promise.all(writes.map(w =>
      supabase.from('custom_field_definitions').update({ sort_order: w.sort_order }).eq('id', w.id)))
    const failed = results.find(r => r.error)
    if (failed?.error) { toast.error(failed.error.message); load() }
  }

  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">Custom fields</h2>
          <p className="text-xs text-ink-muted mt-0.5">
            Record the things your trade tracks that EdgeHQ has no box for.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setDraft(blankDraft('customer'))} className="shrink-0">
          <Plus className="w-4 h-4" /> Add field
        </Button>
      </CardHeader>
      <CardBody className="space-y-5">
        {/* The audience promise, made once and in plain words. It is the first
            question an owner asks about a box that will hold a gate code. */}
        <Banner tone="neutral" icon={Lock}>
          Custom fields are for your office. They are not shown to customers in the portal,
          and they are not sent to workers in the field.
        </Banner>

        {error && <Banner tone="danger">Could not load your custom fields: {error}</Banner>}
        {loading && <SkeletonRows count={3} />}

        {!loading && !error && !defs.length && (
          <InlineEmpty icon={ListPlus}>
            No custom fields yet. Add one for a gate code, a permit number, or however you
            label your customers.
          </InlineEmpty>
        )}

        {!loading && !error && grouped.map(group => (
          (group.active.length || (showArchived && group.archived.length)) ? (
            <section key={group.entity} className="space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold text-ink">{ENTITY_LABEL[group.entity]}</h3>
                <button
                  type="button"
                  onClick={() => setDraft(blankDraft(group.entity))}
                  className="text-xs font-medium text-accent hover:underline shrink-0"
                >
                  Add to {ENTITY_LABEL[group.entity].toLowerCase()}
                </button>
              </div>
              <p className="text-xs text-ink-muted">{ENTITY_HELP[group.entity]}</p>

              <ul className="divide-y divide-border rounded-xl border border-border overflow-hidden">
                {group.active.map((def, i) => (
                  <li key={def.id} className="flex items-start gap-2 p-3 bg-surface">
                    {/* Reorder lives on the row and stays tappable at 375px —
                        a drag handle is the one control a thumb cannot use. */}
                    <div className="flex flex-col shrink-0 -my-0.5">
                      <button
                        type="button" onClick={() => move(def, -1)} disabled={i === 0}
                        aria-label={`Move ${def.label} up`}
                        className="p-1 rounded text-ink-faint hover:text-ink disabled:opacity-25 disabled:hover:text-ink-faint"
                      ><ChevronUp className="w-4 h-4" /></button>
                      <button
                        type="button" onClick={() => move(def, 1)} disabled={i === group.active.length - 1}
                        aria-label={`Move ${def.label} down`}
                        className="p-1 rounded text-ink-faint hover:text-ink disabled:opacity-25 disabled:hover:text-ink-faint"
                      ><ChevronDown className="w-4 h-4" /></button>
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="font-medium text-ink break-words">{def.label}</span>
                        <span className="text-xs text-ink-muted">{TYPE_COPY[def.field_type as CustomFieldType]?.label}</span>
                      </div>
                      {def.help_text && <p className="text-xs text-ink-muted mt-0.5 break-words">{def.help_text}</p>}
                      {def.field_type === 'select' && (
                        <p className="text-xs text-ink-faint mt-1 break-words">
                          {parseOptions(def).map(o => o.label).join(' · ') || 'No choices yet'}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button" onClick={() => setDraft({
                          id: def.id, entity: def.entity as CustomFieldEntity, label: def.label,
                          field_type: def.field_type as CustomFieldType, options: parseOptions(def),
                          help_text: def.help_text || '',
                        })}
                        aria-label={`Edit ${def.label}`}
                        className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-raised"
                      ><Pencil className="w-4 h-4" /></button>
                      <button
                        type="button" onClick={() => setArchived(def, true)}
                        aria-label={`Archive ${def.label}`}
                        className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-raised"
                      ><Archive className="w-4 h-4" /></button>
                      <button
                        type="button" onClick={() => remove(def)}
                        aria-label={`Delete ${def.label}`}
                        className="p-2 rounded-lg text-ink-muted hover:text-danger hover:bg-surface-raised"
                      ><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </li>
                ))}

                {showArchived && group.archived.map(def => (
                  <li key={def.id} className="flex items-center gap-2 p-3 bg-surface">
                    <div className="min-w-0 flex-1">
                      <span className="text-ink-muted line-through break-words">{def.label}</span>
                      <p className="text-xs text-ink-faint mt-0.5">
                        Archived — existing answers stay on the records that have them.
                      </p>
                    </div>
                    <button
                      type="button" onClick={() => setArchived(def, false)}
                      aria-label={`Restore ${def.label}`}
                      className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-raised shrink-0"
                    ><ArchiveRestore className="w-4 h-4" /></button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null
        ))}

        {!loading && !error && archivedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowArchived(v => !v)}
            className="text-xs font-medium text-ink-muted hover:text-ink"
          >
            {showArchived ? 'Hide' : 'Show'} {archivedCount} archived field{archivedCount === 1 ? '' : 's'}
          </button>
        )}
      </CardBody>

      <FieldEditor
        draft={draft}
        saving={saving}
        onChange={setDraft}
        onClose={() => setDraft(null)}
        onSave={save}
      />
    </Card>
  )
}

// ── The editor ───────────────────────────────────────────────────────────────
// One dialog, six inputs at most. Type and record-kind are only choosable while
// the field is NEW: both are immutable afterwards (the database enforces it), and
// offering a control that will be refused is worse than not offering it.
function FieldEditor({ draft, saving, onChange, onClose, onSave }: {
  draft: Draft | null
  saving: boolean
  onChange: (d: Draft) => void
  onClose: () => void
  onSave: () => void
}) {
  if (!draft) return null
  const isNew = !draft.id
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch })

  return (
    <Modal
      open
      onClose={onClose}
      onSubmit={onSave}
      title={isNew ? 'Add a custom field' : `Edit “${draft.label}”`}
      size="md"
      footer={
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={onSave} loading={saving}>{isNew ? 'Add field' : 'Save'}</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Input
          label="Field name"
          value={draft.label}
          onChange={e => set({ label: e.target.value })}
          placeholder="Gate code"
          maxLength={60}
          autoFocus
        />

        {isNew ? (
          <>
            <Select
              label="What is it about?"
              value={draft.entity}
              onChange={e => set({ entity: e.target.value as CustomFieldEntity })}
              options={CUSTOM_FIELD_ENTITIES.map(e => ({ value: e, label: ENTITY_LABEL[e] }))}
              hint={ENTITY_HELP[draft.entity]}
            />
            <Select
              label="Type"
              value={draft.field_type}
              onChange={e => set({ field_type: e.target.value as CustomFieldType, options: [] })}
              options={CUSTOM_FIELD_TYPES.map(t => ({ value: t, label: TYPE_COPY[t].label }))}
              hint={TYPE_COPY[draft.field_type].help}
            />
          </>
        ) : (
          <p className="text-xs text-ink-muted">
            {ENTITY_LABEL[draft.entity]} · {TYPE_COPY[draft.field_type].label} — a field’s record type
            and value type are fixed once it exists, so answers already recorded keep their meaning.
          </p>
        )}

        {draft.field_type === 'select' && (
          <OptionEditor
            options={draft.options}
            onChange={options => set({ options })}
          />
        )}

        <Textarea
          label="Hint (optional)"
          value={draft.help_text}
          onChange={e => set({ help_text: e.target.value })}
          placeholder="Shown under the field when someone fills it in."
          rows={2}
          maxLength={200}
        />
      </div>
    </Modal>
  )
}

// ── Dropdown choices ─────────────────────────────────────────────────────────
// ⭐ RENAMING A CHOICE IS SAFE, REMOVING ONE IS HONEST. Each choice keeps the slug
// it was created with (reconcileOptions carries it), so relabelling "Front gate"
// leaves every record that chose it still pointing at the same thing. Removing a
// choice blocks NEW answers of it and leaves the old ones showing what they always
// showed, marked as no longer offered. Nothing is rewritten behind the owner.
function OptionEditor({ options, onChange }: {
  options: CustomFieldOption[]
  onChange: (o: CustomFieldOption[]) => void
}) {
  const setAt = (i: number, label: string) =>
    onChange(options.map((o, idx) => idx === i ? { ...o, label } : o))

  return (
    <div className="space-y-2">
      <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Choices</span>
      {options.map((o, i) => (
        <div key={o.value || i} className="flex items-center gap-2">
          <Input
            value={o.label}
            onChange={e => setAt(i, e.target.value)}
            placeholder={`Choice ${i + 1}`}
            fieldSize="sm"
            className="flex-1"
            aria-label={`Choice ${i + 1}`}
          />
          <button
            type="button"
            onClick={() => onChange(options.filter((_, idx) => idx !== i))}
            aria-label={`Remove choice ${i + 1}`}
            className="p-2 rounded-lg text-ink-faint hover:text-danger shrink-0"
          ><X className="w-4 h-4" /></button>
        </div>
      ))}
      {options.length < MAX_OPTIONS && (
        <Button
          size="sm" variant="ghost"
          onClick={() => onChange([...options, { value: '', label: '' }])}
        >
          <Plus className="w-4 h-4" /> Add choice
        </Button>
      )}
      {options.some(o => !o.label.trim()) && (
        <p className="text-xs text-ink-faint">Empty choices are dropped when you save.</p>
      )}
    </div>
  )
}
