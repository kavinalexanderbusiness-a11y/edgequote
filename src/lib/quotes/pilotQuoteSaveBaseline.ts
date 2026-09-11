import type { QuoteFormValues } from '@/types'
import { quoteSaveJsonCopy, validatePilotQuoteSaveDraftValues, PILOT_QUOTE_SAVE_REQUEST_BYTES } from './pilotQuoteSaveValues'

// Browser-safe owner-only projection. No private snapshot, settings, SQL tuple,
// acceptance document or Node/server module is reachable from this module.
export type PilotQuoteSaveBaseline = {
  version: 1; code: 'baseline'; complete: true
  ownerId: string; quoteId: string; editorRevision: string
  quoteNumber: string; quoteUpdatedAt: string
  selectedOption: { id: string; name: string } | null
  acceptance: { hasRecord: boolean; current: boolean }
  values: QuoteFormValues
}
type Row = Record<string, unknown>
const row = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Row, keys: string[]) => keys.length === Object.keys(v).length && keys.every(k => Object.hasOwn(v, k))
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v)
const text = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0')
const revision = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)

/** Structural baseline parsing only. A loaded record can need editing before
 * it satisfies submission business gates; do not silently replace its values. */
export function parsePilotQuoteSaveBaseline(input: unknown, binding: { ownerId: string; quoteId: string }): PilotQuoteSaveBaseline | null {
  try {
    if (!uuid(binding.ownerId) || !uuid(binding.quoteId)) return null
    const b = quoteSaveJsonCopy(input, PILOT_QUOTE_SAVE_REQUEST_BYTES, 'invalid_snapshot', 'request_too_large')
    if (!row(b) || !exact(b, ['version','code','complete','ownerId','quoteId','editorRevision','quoteNumber','quoteUpdatedAt','selectedOption','acceptance','values'])
      || b.version !== 1 || b.code !== 'baseline' || b.complete !== true || b.ownerId !== binding.ownerId || b.quoteId !== binding.quoteId
      || !revision(b.editorRevision) || !text(b.quoteNumber) || !text(b.quoteUpdatedAt) || b.quoteUpdatedAt.length > 80
      || !/(?:Z|[+-]\d\d:\d\d)$/.test(b.quoteUpdatedAt) || !Number.isFinite(Date.parse(b.quoteUpdatedAt))) return null
    if (!row(b.acceptance) || !exact(b.acceptance, ['hasRecord','current']) || typeof b.acceptance.hasRecord !== 'boolean'
      || typeof b.acceptance.current !== 'boolean' || (b.acceptance.current && !b.acceptance.hasRecord)) return null
    const values = validatePilotQuoteSaveDraftValues(b.values)
    if (!values || JSON.stringify(values) !== JSON.stringify(b.values)) return null
    if (values.value_grade !== null || values.nearby_count !== null
      || !['customer_phone','customer_email','acquisition_source'].every(k => Object.hasOwn(values, k) && (values as unknown as Row)[k] === '')) return null
    const optionIds = values.options.map(o => o.id)
    if (optionIds.some(id => !uuid(id)) || new Set(optionIds).size !== optionIds.length || values.has_options !== (values.options.length > 0)) return null
    if (b.selectedOption !== null && (!row(b.selectedOption) || !exact(b.selectedOption, ['id','name']) || !uuid(b.selectedOption.id)
      || !text(b.selectedOption.name) || !values.options.some(o => o.id === (b.selectedOption as Row).id && o.name === (b.selectedOption as Row).name))) return null
    // Reserve the actual maximum generation length when checking that these
    // values fit a future complete wire intent; never truncate large documents.
    quoteSaveJsonCopy({ version: 1, quoteId: b.quoteId, expectedEditorRevision: b.editorRevision,
      clientOperationId: '00000000-0000-4000-8000-000000000000', editorGeneration: 'g'.repeat(128), values },
    PILOT_QUOTE_SAVE_REQUEST_BYTES, 'invalid_intent', 'request_too_large')
    return b as unknown as PilotQuoteSaveBaseline
  } catch { return null }
}
