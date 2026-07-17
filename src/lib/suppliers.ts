import type { SupabaseClient } from '@supabase/supabase-js'
import type { Part } from '@/lib/parts'

// ── THE suppliers engine ─────────────────────────────────────────────────────
// Who you buy from. Deliberately narrow: a supplier is a COUNTERPARTY, not an
// inventory system. It owns no stock, no counts and no location — stock stays
// derived from part_movements by the recompute_part_stock trigger, exactly as
// before. Nothing in this file may ever write qty_on_hand.
//
// Backwards compatibility is the design:
//   `parts.supplier` (text) still exists and is NOT backfilled into rows.
//   Backfilling would invent vendors the owner never created and silently merge
//   "Home Depot" with "home depot". Instead a part resolves its vendor through
//   ONE function — supplierLabel — so the entity and the legacy text can never
//   disagree on screen.

export interface Supplier {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  name: string
  contact_name: string | null
  phone: string | null
  email: string | null
  website: string | null
  account_number: string | null
  address: string | null
  notes: string | null
  /** Archived, never deleted — parts (and later POs) reference it. */
  archived_at: string | null
}

export type SupplierFormValues = Omit<Supplier, 'id' | 'created_at' | 'updated_at' | 'user_id' | 'archived_at'>

/** A part carrying the new link alongside the legacy text. */
export type PartWithSupplier = Part & { supplier_id?: string | null }

/**
 * THE vendor display resolver. The linked supplier wins; the legacy free-text
 * name is the fallback; null means genuinely unknown.
 *
 * Every surface must call this rather than reading either field directly —
 * otherwise a part linked to "Prairie Turf" but still carrying the old text
 * "prairie turf equip" would show one name in the list and another in the
 * dialog, and the owner would have no way to tell which is real.
 */
export function supplierLabel(
  part: Pick<PartWithSupplier, 'supplier' | 'supplier_id'>,
  byId: Map<string, Supplier> | Record<string, Supplier>,
): string | null {
  if (part.supplier_id) {
    const s = byId instanceof Map ? byId.get(part.supplier_id) : byId[part.supplier_id]
    if (s) return s.name
    // Linked to a vendor we can't see (deleted → FK SET NULL races, or a filtered
    // read). Fall through to the legacy text rather than render nothing.
  }
  const legacy = part.supplier?.trim()
  return legacy ? legacy : null
}

/** True when the part still relies on the legacy text — the nudge to link it. */
export function isLegacySupplier(part: Pick<PartWithSupplier, 'supplier' | 'supplier_id'>): boolean {
  return !part.supplier_id && !!part.supplier?.trim()
}

export function indexSuppliers(rows: Supplier[]): Map<string, Supplier> {
  return new Map(rows.map(s => [s.id, s]))
}

/** Sort for pickers/lists: active first, then by name. Pure. */
export function sortSuppliers(rows: Supplier[]): Supplier[] {
  return [...rows].sort((a, b) =>
    Number(!!a.archived_at) - Number(!!b.archived_at) || a.name.localeCompare(b.name))
}

// ── Vendor history ───────────────────────────────────────────────────────────
// Composed from rows the caller already holds — no queries, no new maths. Spend
// is NOT here: money spent with a vendor comes from purchase orders (milestone
// 2) and, until those exist, claiming a spend figure would be inventing one.

export interface VendorParts {
  parts: PartWithSupplier[]
  /** Shelf value of what you buy from them, using the SAME partValue engine. */
  count: number
}

/** Which parts you buy from this vendor. */
export function partsForSupplier(supplierId: string, parts: PartWithSupplier[]): PartWithSupplier[] {
  return parts.filter(p => p.supplier_id === supplierId)
}

// ── Loaders / writers ────────────────────────────────────────────────────────

export async function loadSuppliers(sb: SupabaseClient, opts?: { includeArchived?: boolean }): Promise<Supplier[]> {
  const { data: { session } } = await sb.auth.getSession()
  const user = session?.user
  if (!user) return []
  let q = sb.from('suppliers').select('*').eq('user_id', user.id)
  if (!opts?.includeArchived) q = q.is('archived_at', null)
  const { data } = await q.order('name')
  return (data as Supplier[]) || []
}

export async function saveSupplier(
  sb: SupabaseClient,
  opts: { userId: string; id?: string | null; values: SupplierFormValues },
): Promise<{ error?: string; supplier?: Supplier }> {
  const name = opts.values.name?.trim()
  if (!name) return { error: 'Give the supplier a name.' }
  const row = {
    ...opts.values,
    name,
    contact_name: opts.values.contact_name?.trim() || null,
    phone: opts.values.phone?.trim() || null,
    email: opts.values.email?.trim() || null,
    website: opts.values.website?.trim() || null,
    account_number: opts.values.account_number?.trim() || null,
    address: opts.values.address?.trim() || null,
    notes: opts.values.notes?.trim() || null,
    updated_at: new Date().toISOString(),
  }
  const q = opts.id
    ? sb.from('suppliers').update(row).eq('id', opts.id).select('*').single()
    : sb.from('suppliers').insert({ ...row, user_id: opts.userId }).select('*').single()
  const { data, error } = await q
  return error ? { error: error.message } : { supplier: data as Supplier }
}

/**
 * Archive, don't delete. Parts point at this vendor; deleting would null those
 * links (FK is SET NULL) and quietly strip the vendor off every part that used
 * it. Archiving hides it from pickers and keeps the history readable.
 */
export async function archiveSupplier(sb: SupabaseClient, id: string, archived = true): Promise<{ error?: string }> {
  const { error } = await sb.from('suppliers')
    .update({ archived_at: archived ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    .eq('id', id)
  return error ? { error: error.message } : {}
}

/** Link a part to a vendor. Touches no stock — supplier_id is metadata. */
export async function setPartSupplier(sb: SupabaseClient, partId: string, supplierId: string | null): Promise<{ error?: string }> {
  const { error } = await sb.from('parts')
    .update({ supplier_id: supplierId, updated_at: new Date().toISOString() })
    .eq('id', partId)
  return error ? { error: error.message } : {}
}
