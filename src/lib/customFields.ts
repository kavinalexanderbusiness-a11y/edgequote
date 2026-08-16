// ── Custom fields: the definition/value engine ───────────────────────────────
//
// A service business needs to record things EdgeHQ ships no column for — a gate
// code on a service location, a permit number on a visit, a referral partner on
// a customer. This module is the ONE place that knows what a custom field is,
// what its answers may look like, and how an answer becomes a database row.
//
// ⭐⭐ THIS MODULE DOES NOT ENFORCE ANYTHING. The database does.
// Every rule below has a constraint behind it in
// supabase/migrations/*_custom_fields_v1.sql: the type↔column CHECK, the
// composite foreign keys that carry user_id, the archived-definition trigger,
// the dropdown-option trigger. What this module provides is the SAME rule
// stated early, so an owner reads "that isn't a date" in the form instead of a
// constraint name in a toast. If the two ever disagree the database wins — and
// `verify:custom-fields` fails the build, because it parses the migration and
// checks the lists here against the CHECK constraints there rather than trusting
// that somebody kept them in step.
//
// ⭐ WHY THERE IS NO `visibility` HERE. See src/lib/noteScope.ts: audience in this
// product is a property of the column, enforced by the explicit projection that
// selects it, never by a flag on generic data. Custom fields are created at
// runtime and cannot split into columns, so V1 does not take the risk — these
// values reach the owner's own authenticated screens and nothing else.
// `get_portal_data` and the crew path do not know these tables exist.
//
// The seam for later is additive and lives OUTSIDE this file: a grant column on
// the definition, plus one predicate in whichever canonical projection already
// answers for that audience. Do not grow a second permissions engine in here.

import type { CustomFieldDefinition, CustomFieldValue } from '@/types'

// ── What a field can be attached to ──────────────────────────────────────────
// Three entities, because these are the three durable records the product
// already treats as CRM objects. Assets are not here — Session 72 does not
// exist, and an entity nothing can reference is a broken row waiting to happen.
export const CUSTOM_FIELD_ENTITIES = ['customer', 'property', 'job'] as const
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number]

/**
 * The foreign-key column each entity attaches through. `custom_field_values` has
 * one nullable column per entity rather than a generic `record_id`, so that a
 * value about a deleted customer is removed by the database rather than left as
 * an orphan pointing at nothing.
 */
export const ENTITY_COLUMN: Record<CustomFieldEntity, 'customer_id' | 'property_id' | 'job_id'> = {
  customer: 'customer_id',
  property: 'property_id',
  job: 'job_id',
}

/**
 * ⚠️ `job` is the entity key because the table is `jobs` — but a `jobs` ROW IS A
 * VISIT (one scheduled occurrence), so the owner-facing word is "visit". See
 * src/lib/vocabulary.ts and verify:vocabulary. A recurring series' visits each
 * carry their own answer; there is no series-level custom field in V1.
 */
export const ENTITY_LABEL: Record<CustomFieldEntity, string> = {
  customer: 'Customer',
  property: 'Service location',
  job: 'Visit',
}

export const ENTITY_HELP: Record<CustomFieldEntity, string> = {
  customer: 'Recorded once per customer — referral partner, customer type, account code.',
  property: 'Recorded per service location — gate code, parking, building type.',
  job: 'Recorded per scheduled visit — permit number, PO number, project code.',
}

// ── What a field can hold ────────────────────────────────────────────────────
// Seven types, and no more. Each maps to exactly ONE typed column, which is what
// makes "a date in a number field" unrepresentable rather than merely rejected.
//
// ⛔ What is deliberately absent, and must stay absent: formulas, scripts, lookups
// into other tables, rich text, nested objects, and a free JSON type. Every one
// of those turns a small honest attribute store into a database-inside-a-database
// that this product then has to migrate, index and explain forever.
export const CUSTOM_FIELD_TYPES = [
  'text', 'textarea', 'number', 'boolean', 'date', 'select', 'currency',
] as const
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]

/** The typed column each type stores into. One column, always the same one. */
export const TYPE_COLUMN: Record<CustomFieldType, keyof CustomFieldValueColumns> = {
  text: 'value_text',
  textarea: 'value_text',
  select: 'value_text',
  number: 'value_number',
  currency: 'value_number',
  boolean: 'value_boolean',
  date: 'value_date',
}

export const TYPE_COPY: Record<CustomFieldType, { label: string; help: string }> = {
  text:     { label: 'Short text',  help: 'One line — a code, a name, a reference.' },
  textarea: { label: 'Long text',   help: 'A few lines — instructions or a description.' },
  number:   { label: 'Number',      help: 'A quantity. Sorts and sums as a number.' },
  currency: { label: 'Money',       help: 'An amount. Shown in your currency format.' },
  boolean:  { label: 'Yes / no',    help: 'A checkbox. Either it applies or it does not.' },
  date:     { label: 'Date',        help: 'A calendar date — expiry, permit issued, renewal.' },
  select:   { label: 'Dropdown',    help: 'One choice from a list you control.' },
}

// ── The row shape ────────────────────────────────────────────────────────────
export interface CustomFieldValueColumns {
  value_text: string | null
  value_number: number | null
  value_boolean: boolean | null
  value_date: string | null
}

const EMPTY_COLUMNS: CustomFieldValueColumns = {
  value_text: null, value_number: null, value_boolean: null, value_date: null,
}

/** One option on a dropdown. `value` is stored; `label` is what the owner reads. */
export interface CustomFieldOption {
  value: string
  label: string
}

// ── Limits, stated rather than discovered ────────────────────────────────────
export const MAX_LABEL = 60
export const MAX_KEY = 48
export const MAX_TEXT = 200
export const MAX_TEXTAREA = 4000
export const MAX_OPTIONS = 40
/** Beyond this a "number" is not a quantity anyone is tracking, it is a typo. */
export const MAX_NUMBER = 1e12

// ── Keys and option slugs ────────────────────────────────────────────────────
// A field's key is its identity in an export header and in a re-import. It is
// derived from the label ONCE and then immutable (the database enforces that),
// which is what lets an owner rename "PO #" to "Purchase order" without orphaning
// a single historical answer.

/** `"Permit #"` → `"permit"`. Empty when the label has no usable characters. */
export function slugify(input: string, max = MAX_KEY): string {
  const s = (input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/g, '')
  // The database requires a leading letter: a key that can start with a digit is
  // a key that cannot be a column header everywhere it needs to be one.
  return /^[a-z]/.test(s) ? s : (s ? `f_${s}`.slice(0, max).replace(/_+$/g, '') : '')
}

/** Mirrors `custom_field_definitions_field_key_check`. */
export function isValidKey(key: string): boolean {
  return /^[a-z][a-z0-9_]{0,47}$/.test(key)
}

/**
 * A key that does not collide with the ones already defined for that entity.
 * Collisions are resolved by suffix rather than by refusing, because an owner
 * naming a second field "Notes" has made no mistake worth a dialog.
 */
export function uniqueKey(label: string, taken: readonly string[]): string {
  const base = slugify(label) || 'field'
  if (!taken.includes(base)) return base
  for (let n = 2; n < 200; n++) {
    const candidate = `${base.slice(0, MAX_KEY - 3)}_${n}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${base.slice(0, MAX_KEY - 6)}_${Date.now() % 100000}`
}

// ── Reading a definition ─────────────────────────────────────────────────────

/** Options as a typed array, whatever shape the jsonb arrived in. */
export function parseOptions(def: Pick<CustomFieldDefinition, 'options'>): CustomFieldOption[] {
  const raw = def.options
  if (!Array.isArray(raw)) return []
  const out: CustomFieldOption[] = []
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue
    const value = String((o as Record<string, unknown>).value ?? '')
    const label = String((o as Record<string, unknown>).label ?? '')
    if (value) out.push({ value, label: label || value })
  }
  return out
}

export const isArchived = (def: Pick<CustomFieldDefinition, 'archived_at'>) => def.archived_at != null

/** Active fields for one entity, in the order the owner arranged them. */
export function activeFields(
  defs: readonly CustomFieldDefinition[],
  entity: CustomFieldEntity,
): CustomFieldDefinition[] {
  return defs
    .filter(d => d.entity === entity && !isArchived(d))
    .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label))
}

// ── Validating a definition ──────────────────────────────────────────────────

export type Validation = { ok: true } | { ok: false; message: string }

export interface DefinitionDraft {
  entity: CustomFieldEntity
  label: string
  field_type: CustomFieldType
  options: CustomFieldOption[]
  help_text?: string | null
}

/**
 * Everything the form can know before the database is asked. Mirrors the CHECK
 * constraints; it does not replace them.
 */
export function validateDefinition(draft: DefinitionDraft): Validation {
  const label = (draft.label || '').trim()
  if (!label) return { ok: false, message: 'Give the field a name.' }
  if (label.length > MAX_LABEL) return { ok: false, message: `Keep the name under ${MAX_LABEL} characters.` }
  if (!CUSTOM_FIELD_ENTITIES.includes(draft.entity)) return { ok: false, message: 'Pick what this field is about.' }
  if (!CUSTOM_FIELD_TYPES.includes(draft.field_type)) return { ok: false, message: 'Pick a field type.' }
  if (!slugify(label)) return { ok: false, message: 'The name needs at least one letter or number.' }

  if (draft.field_type === 'select') {
    const opts = draft.options.filter(o => o.label.trim())
    if (opts.length < 1) return { ok: false, message: 'A dropdown needs at least one choice.' }
    if (opts.length > MAX_OPTIONS) return { ok: false, message: `A dropdown can hold up to ${MAX_OPTIONS} choices.` }
    const seen = new Set<string>()
    for (const o of opts) {
      const v = o.value || slugify(o.label)
      if (!v) return { ok: false, message: `"${o.label}" needs at least one letter or number.` }
      if (seen.has(v)) return { ok: false, message: `Two choices are both called "${o.label}".` }
      seen.add(v)
    }
  } else if (draft.options.length) {
    return { ok: false, message: 'Only a dropdown can have choices.' }
  }
  return { ok: true }
}

/**
 * Option slugs are assigned ONCE and then carried, because the slug is what every
 * stored answer holds. Re-slugging on every save would mean renaming "Front gate"
 * to "Front gate (north)" silently detached every row that had chosen it.
 */
export function reconcileOptions(
  next: readonly CustomFieldOption[],
  previous: readonly CustomFieldOption[],
): CustomFieldOption[] {
  const taken = new Set<string>()
  const keepById = new Map(previous.map(o => [o.value, o]))
  const out: CustomFieldOption[] = []
  for (const o of next) {
    const label = o.label.trim()
    if (!label) continue
    let value = o.value && keepById.has(o.value) ? o.value : slugify(o.label || label, 40)
    if (!value) continue
    if (taken.has(value)) {
      let n = 2
      while (taken.has(`${value}_${n}`)) n++
      value = `${value}_${n}`
    }
    taken.add(value)
    out.push({ value, label })
  }
  return out
}

// ── Turning an owner's input into a row ──────────────────────────────────────

export type EncodeResult =
  /** The field was cleared — the caller DELETES the value row rather than storing a blank. */
  | { ok: true; clear: true }
  | { ok: true; clear: false; columns: CustomFieldValueColumns }
  | { ok: false; message: string }

/** A real calendar date, not merely a well-shaped string. 2026-02-31 is not a date. */
export function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1) return false
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return d <= dim
}

/**
 * ⭐ THE ONE PLACE a raw input becomes typed columns. Every write path calls this
 * — the detail screens, and the server route that re-runs it on values it did not
 * see typed. Nothing else assembles a `value_*` column.
 */
export function encodeValue(
  def: Pick<CustomFieldDefinition, 'field_type' | 'label' | 'options'>,
  raw: unknown,
): EncodeResult {
  const type = def.field_type as CustomFieldType
  if (!CUSTOM_FIELD_TYPES.includes(type)) return { ok: false, message: 'That field has an unknown type.' }

  // One representation of "no answer": the row is absent. A blank string, a null
  // and a missing key all mean the same thing and all clear the value.
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return { ok: true, clear: true }

  const columns = { ...EMPTY_COLUMNS }

  switch (type) {
    case 'text':
    case 'textarea': {
      const v = String(raw).trim()
      const max = type === 'text' ? MAX_TEXT : MAX_TEXTAREA
      if (v.length > max) return { ok: false, message: `${def.label} is limited to ${max} characters.` }
      columns.value_text = v
      break
    }
    case 'select': {
      const v = String(raw).trim()
      const options = parseOptions(def)
      if (!options.some(o => o.value === v)) {
        return { ok: false, message: `"${v}" is not one of the choices for ${def.label}.` }
      }
      columns.value_text = v
      break
    }
    case 'number':
    case 'currency': {
      if (typeof raw === 'boolean') return { ok: false, message: `${def.label} needs a number.` }
      const s = String(raw).trim().replace(/[$,\s]/g, '')
      // Reject anything that is not plainly a number. Number('') is 0 and
      // Number('12abc') is NaN, but Number('  12  ') is 12 — so the shape is
      // checked before the parse rather than after it.
      if (!/^-?\d*\.?\d+$/.test(s)) return { ok: false, message: `${def.label} needs a number.` }
      const n = Number(s)
      if (!Number.isFinite(n)) return { ok: false, message: `${def.label} needs a number.` }
      if (Math.abs(n) > MAX_NUMBER) return { ok: false, message: `${def.label} is larger than this field can hold.` }
      columns.value_number = n
      break
    }
    case 'boolean': {
      if (typeof raw === 'boolean') { columns.value_boolean = raw; break }
      const s = String(raw).trim().toLowerCase()
      if (['true', 'yes', 'y', '1'].includes(s)) { columns.value_boolean = true; break }
      if (['false', 'no', 'n', '0'].includes(s)) { columns.value_boolean = false; break }
      return { ok: false, message: `${def.label} is a yes/no field.` }
    }
    case 'date': {
      const s = String(raw).trim()
      if (!isCalendarDate(s)) return { ok: false, message: `${def.label} needs a date like 2026-03-01.` }
      columns.value_date = s
      break
    }
  }
  return { ok: true, clear: false, columns }
}

// ── Reading a row back ───────────────────────────────────────────────────────

/** The stored answer, in the shape a form control wants. */
export function rawValue(
  def: Pick<CustomFieldDefinition, 'field_type'>,
  value: CustomFieldValue | undefined,
): string | boolean | number | null {
  if (!value) return null
  switch (def.field_type as CustomFieldType) {
    case 'boolean': return value.value_boolean
    case 'number':
    case 'currency': return value.value_number
    case 'date': return value.value_date
    default: return value.value_text
  }
}

/**
 * ⭐ A REMOVED DROPDOWN CHOICE STILL READS. If the stored slug is no longer offered,
 * the answer is shown as it was recorded and marked retired — never blanked, and
 * never silently swapped for a neighbouring option. The owner changed the field
 * yesterday; the record is still what it was.
 */
export function displayValue(
  def: Pick<CustomFieldDefinition, 'field_type' | 'options'>,
  value: CustomFieldValue | undefined,
  formatMoney: (n: number) => string = n => String(n),
): { text: string; retired: boolean } | null {
  if (!value) return null
  switch (def.field_type as CustomFieldType) {
    case 'boolean':
      return value.value_boolean == null ? null : { text: value.value_boolean ? 'Yes' : 'No', retired: false }
    case 'number':
      return value.value_number == null ? null : { text: String(value.value_number), retired: false }
    case 'currency':
      return value.value_number == null ? null : { text: formatMoney(value.value_number), retired: false }
    case 'date':
      return value.value_date ? { text: value.value_date, retired: false } : null
    case 'select': {
      if (!value.value_text) return null
      const hit = parseOptions(def).find(o => o.value === value.value_text)
      return hit ? { text: hit.label, retired: false } : { text: value.value_text, retired: true }
    }
    default:
      return value.value_text ? { text: value.value_text, retired: false } : null
  }
}

/** Values for one record, keyed by definition id — what a detail screen renders from. */
export function valuesByDefinition(values: readonly CustomFieldValue[]): Map<string, CustomFieldValue> {
  return new Map(values.map(v => [v.definition_id, v]))
}

/**
 * The fields a detail screen shows: every ACTIVE field for the entity, plus any
 * ARCHIVED field that still holds an answer for THIS record. An archived field
 * with history does not vanish from the record it describes — it is shown, read
 * only, so the record stays readable after the owner retires the field.
 */
export function fieldsForRecord(
  defs: readonly CustomFieldDefinition[],
  entity: CustomFieldEntity,
  values: readonly CustomFieldValue[],
): { definition: CustomFieldDefinition; value: CustomFieldValue | undefined; readOnly: boolean }[] {
  const byDef = valuesByDefinition(values)
  const active = activeFields(defs, entity)
  const activeIds = new Set(active.map(d => d.id))
  const retained = defs
    .filter(d => d.entity === entity && isArchived(d) && !activeIds.has(d.id) && byDef.has(d.id))
    .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label))
  return [
    ...active.map(d => ({ definition: d, value: byDef.get(d.id), readOnly: false })),
    ...retained.map(d => ({ definition: d, value: byDef.get(d.id), readOnly: true })),
  ]
}

/**
 * ⭐ SEARCH, and why only these. A custom field earns a place in global search when
 * an owner would plausibly type its whole value into a search box to find one
 * record — a PO number, a permit number, a project code. That is short text, and
 * it is matched EXACTLY (case- and space-insensitively), served by one index.
 *
 * ⛔ Long text, numbers, money, dates, booleans and dropdowns are excluded on
 * purpose. "Every record whose any attribute contains any substring" is the query
 * that turns an attribute store into a search engine nobody costed, and a date or
 * a yes/no matches thousands of records at once, which is not a search result.
 */
// ⚠️ V1 DOES NOT WIRE THIS INTO GLOBAL SEARCH, and the omission is deliberate.
// `search_records` is a large SECURITY DEFINER projection, and this repository's
// hardest-won rule is that replacing one from a repo copy that may be behind
// production is how a live projection gets rolled backward (2026-08-14). With no
// database access this session there is no way to read the live definition first,
// so the function is left alone. What IS in place is everything that makes the
// addition cheap and safe later: the index (custom_field_values_text_lookup), the
// normaliser below, and this list. Adding it is one union branch in that function,
// filtered to these types — not a redesign.
export const SEARCHABLE_TYPES: readonly CustomFieldType[] = ['text']

export const isSearchable = (def: Pick<CustomFieldDefinition, 'field_type'>) =>
  SEARCHABLE_TYPES.includes(def.field_type as CustomFieldType)

/** Normalised the same way the database index is, so the two agree. */
export const searchKey = (s: string) => s.trim().toLowerCase()

// ── Assembling a write ───────────────────────────────────────────────────────
// ⭐ WHY THERE IS NO /api/custom-fields ROUTE. Every rule this feature has is a
// database constraint (see the migration header), and an authenticated owner can
// always reach PostgREST directly — so a route that re-validated would not be a
// gate, it would be a suggestion sitting beside the real one. Adding it would
// mean two answers to "is this write legal", which is the shape this codebase has
// been bitten by before. The database is the door; this function only makes sure
// the knock is well-formed.
//
// ⭐ NOTHING HERE IS TAKEN FROM A FORM. `userId` comes from the SESSION.
// `entity` and `field_type` are copied off the DEFINITION ROW that was read back
// from the database, never from an input or a URL. Even if all three were forged,
// the composite foreign key has no matching parent row and the insert fails —
// this function is what keeps the honest path honest, not what makes it safe.

export interface ValueWritePayload extends CustomFieldValueColumns {
  user_id: string
  definition_id: string
  entity: string
  field_type: string
  customer_id: string | null
  property_id: string | null
  job_id: string | null
}

export function valueWritePayload(
  def: Pick<CustomFieldDefinition, 'id' | 'entity' | 'field_type'>,
  userId: string,
  recordId: string,
  columns: CustomFieldValueColumns,
): ValueWritePayload {
  const entity = def.entity as CustomFieldEntity
  return {
    user_id: userId,
    definition_id: def.id,
    entity: def.entity,
    field_type: def.field_type,
    customer_id: entity === 'customer' ? recordId : null,
    property_id: entity === 'property' ? recordId : null,
    job_id: entity === 'job' ? recordId : null,
    ...columns,
  }
}

/**
 * The `onConflict` target for an upsert. One target for all three entities,
 * because the constraint behind it is `unique nulls not distinct` over all four
 * columns — see custom_field_values_one_answer in the migration. It must name
 * the constraint's columns exactly, or PostgREST cannot infer it and the upsert
 * degrades into an insert that fails on the second save.
 */
export const UPSERT_CONFLICT = 'definition_id,customer_id,property_id,job_id'

/**
 * Turn a database error into something an owner can act on. The constraints are
 * doing the work, so their names are the vocabulary of failure — but a
 * constraint name in a toast is not an answer to anybody.
 */
export function explainWriteError(message: string): string {
  const m = message || ''
  if (/custom_field_values_type_check/.test(m)) return 'That value does not match the field’s type.'
  if (/custom_field_values_definition_fkey/.test(m)) return 'That field no longer exists.'
  if (/custom_field_values_(customer|property|job)_fkey/.test(m)) return 'That record could not be found.'
  if (/is archived and no longer accepts values/.test(m)) return 'That field has been archived, so new answers cannot be saved to it.'
  if (/is not one of the choices/.test(m)) return 'That choice is no longer offered by this field.'
  if (/custom_field_values_text_not_blank/.test(m)) return 'That value is too long to store.'
  if (/custom_field_definitions_owner_key_unique/.test(m)) return 'You already have a field with that name on this record type.'
  if (/violates foreign key constraint/.test(m) && /custom_field_values/.test(m)) return 'This field still holds answers, so it cannot be deleted. Archive it instead.'
  if (/cannot change once created|cannot be moved to a different kind/.test(m)) return m.replace(/^.*?ERROR:\s*/, '')
  if (/already holds answers, so its type cannot change/.test(m)) return 'This field already holds answers, so its type cannot change. Archive it and create a new one.'
  return m
}
