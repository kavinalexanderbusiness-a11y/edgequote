'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Toggle } from '@/components/ui/Toggle'
import { Banner } from '@/components/ui/Banner'
import { toast } from '@/lib/toast'
import { formatCurrency } from '@/lib/utils'
import {
  ENTITY_COLUMN, UPSERT_CONFLICT, displayValue, encodeValue, explainWriteError,
  fieldsForRecord, parseOptions, rawValue, valueWritePayload,
  type CustomFieldEntity,
} from '@/lib/customFields'
import type { CustomFieldDefinition, CustomFieldValue } from '@/types'
import { Pencil, SlidersHorizontal } from 'lucide-react'

// ── The Details section on a record ──────────────────────────────────────────
// One compact block on the customer, service location and visit screens showing
// what the owner chose to record about this kind of thing.
//
// ⭐ ONE SECTION, NOT ONE CARD PER FIELD. Custom fields are attributes, and a
// screen that grows a heading and a card for each of them stops being a customer
// record and becomes a form. So: a definition list while reading, and ONE edit
// surface for the whole block. That also means one save, one failure to report,
// and one thing to make work at 375px.
//
// ⭐ IT RENDERS NOTHING WHEN THERE IS NOTHING. A business that defines no custom
// fields must not pay for the feature with an empty box on every screen.
//
// ⚠️ INTERNAL. These values are owner-only — see src/lib/noteScope.ts and the
// migration header. This component is used only inside /dashboard.

interface Props {
  entity: CustomFieldEntity
  recordId: string
  /** Renders as a plain block rather than inside its own card shell. */
  bare?: boolean
  className?: string
}

export function CustomFieldsSection({ entity, recordId, bare, className }: Props) {
  const supabase = createClient()
  const [defs, setDefs] = useState<CustomFieldDefinition[] | null>(null)
  const [values, setValues] = useState<CustomFieldValue[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string | boolean | number | null>>({})

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { setError('Could not confirm who you are.'); return }
    const column = ENTITY_COLUMN[entity]
    const [dRes, vRes] = await Promise.all([
      supabase.from('custom_field_definitions').select('*').eq('user_id', uid).eq('entity', entity),
      supabase.from('custom_field_values').select('*').eq('user_id', uid).eq(column, recordId),
    ])
    // ⭐ A FAILED READ IS NOT AN EMPTY RECORD. Rendering "no details" because the
    // network blinked is the failure mode this product has shipped before — an
    // owner reads absence as fact and acts on it.
    if (dRes.error || vRes.error) { setError((dRes.error || vRes.error)!.message); return }
    setDefs((dRes.data as CustomFieldDefinition[]) || [])
    setValues((vRes.data as CustomFieldValue[]) || [])
    setError(null)
  }, [supabase, entity, recordId])

  useEffect(() => { load() }, [load])

  const rows = useMemo(
    () => defs ? fieldsForRecord(defs, entity, values) : [],
    [defs, entity, values],
  )

  function beginEdit() {
    const next: Record<string, string | boolean | number | null> = {}
    for (const r of rows) {
      if (r.readOnly) continue
      next[r.definition.id] = rawValue(r.definition, r.value)
    }
    setDrafts(next)
    setEditing(true)
  }

  async function save() {
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { toast.error('Could not confirm who you are.'); return }

    // Encode EVERYTHING before writing ANYTHING. A block that half-saves and then
    // reports an error leaves the owner unable to tell which half landed.
    const writes: ReturnType<typeof valueWritePayload>[] = []
    const clears: string[] = []
    for (const r of rows) {
      if (r.readOnly) continue
      const encoded = encodeValue(r.definition, drafts[r.definition.id])
      if (!encoded.ok) { toast.error(encoded.message); return }
      if (encoded.clear) {
        if (r.value) clears.push(r.value.id)
      } else {
        writes.push(valueWritePayload(r.definition, uid, recordId, encoded.columns))
      }
    }

    setSaving(true)
    if (clears.length) {
      const { error: delErr } = await supabase.from('custom_field_values').delete().in('id', clears)
      if (delErr) { setSaving(false); toast.error(explainWriteError(delErr.message)); return }
    }
    if (writes.length) {
      const { error: upErr } = await supabase
        .from('custom_field_values')
        .upsert(writes, { onConflict: UPSERT_CONFLICT })
      if (upErr) { setSaving(false); toast.error(explainWriteError(upErr.message)); return }
    }
    setSaving(false)
    setEditing(false)
    toast.success('Details saved')
    load()
  }

  if (error) {
    return (
      <Banner tone="danger" className={className}>
        Could not load details: {error}
      </Banner>
    )
  }
  // Nothing defined for this entity, and nothing archived still holding an answer.
  if (!defs || !rows.length) return null

  const body = editing ? (
    <div className="space-y-4">
      {rows.filter(r => !r.readOnly).map(({ definition: def }) => {
        const v = drafts[def.id]
        const common = { label: def.label, hint: def.help_text || undefined }
        if (def.field_type === 'boolean') {
          return (
            <div key={def.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink">{def.label}</div>
                {def.help_text && <p className="text-xs text-ink-muted mt-0.5">{def.help_text}</p>}
              </div>
              <Toggle
                checked={v === true}
                onChange={c => setDrafts(d => ({ ...d, [def.id]: c }))}
                ariaLabel={def.label}
              />
            </div>
          )
        }
        if (def.field_type === 'select') {
          return (
            <Select
              key={def.id} {...common}
              value={typeof v === 'string' ? v : ''}
              onChange={e => setDrafts(d => ({ ...d, [def.id]: e.target.value }))}
              options={parseOptions(def).map(o => ({ value: o.value, label: o.label }))}
              placeholder="—"
            />
          )
        }
        if (def.field_type === 'textarea') {
          return (
            <Textarea
              key={def.id} {...common} rows={3}
              value={typeof v === 'string' ? v : ''}
              onChange={e => setDrafts(d => ({ ...d, [def.id]: e.target.value }))}
            />
          )
        }
        return (
          <Input
            key={def.id} {...common}
            // A number field gets a numeric keypad on a phone; a date field gets
            // the platform date picker, which is also what makes the value arrive
            // already shaped as YYYY-MM-DD.
            type={def.field_type === 'date' ? 'date' : def.field_type === 'number' || def.field_type === 'currency' ? 'number' : 'text'}
            inputMode={def.field_type === 'currency' ? 'decimal' : undefined}
            step={def.field_type === 'currency' ? '0.01' : undefined}
            value={v == null ? '' : String(v)}
            onChange={e => setDrafts(d => ({ ...d, [def.id]: e.target.value }))}
          />
        )
      })}
      <div className="flex gap-2 justify-end pt-1">
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
        <Button size="sm" onClick={save} loading={saving}>Save details</Button>
      </div>
    </div>
  ) : (
    // Two columns from `sm` up, one below it. A label/value pair is the densest
    // honest layout for an attribute, and it stays readable in a 375px column.
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
      {rows.map(({ definition: def, value, readOnly }) => {
        const shown = displayValue(def, value, formatCurrency)
        return (
          <div key={def.id} className="min-w-0">
            <dt className="text-xs font-semibold text-ink-muted uppercase tracking-wide flex items-center gap-1.5">
              <span className="truncate">{def.label}</span>
              {readOnly && (
                <span className="text-[10px] font-medium normal-case tracking-normal text-ink-faint shrink-0">
                  archived
                </span>
              )}
            </dt>
            <dd className="text-sm text-ink mt-0.5 break-words">
              {shown ? (
                <>
                  {shown.text}
                  {/* The option was removed from the field after this was recorded.
                      The record still says what it always said. */}
                  {shown.retired && (
                    <span className="ml-1.5 text-xs text-ink-faint">(no longer offered)</span>
                  )}
                </>
              ) : (
                <span className="text-ink-faint">—</span>
              )}
            </dd>
          </div>
        )
      })}
    </dl>
  )

  const header = (
    <div className="flex items-center justify-between gap-3 mb-3">
      <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
        <SlidersHorizontal className="w-4 h-4 text-ink-faint" />
        Details
      </h3>
      {!editing && rows.some(r => !r.readOnly) && (
        <Button variant="ghost" size="sm" onClick={beginEdit}>
          <Pencil className="w-3.5 h-3.5" /> Edit
        </Button>
      )}
    </div>
  )

  if (bare) return <div className={className}>{header}{body}</div>
  return (
    <div className={`rounded-card border border-border bg-surface p-4 ${className || ''}`}>
      {header}{body}
    </div>
  )
}
