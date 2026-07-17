import type { SupabaseClient } from '@supabase/supabase-js'
import type { Vendor, VendorFormValues } from '@/types'

// ── Vendors — who the money went to ──────────────────────────────────────────
// A vendor is a reporting dimension, not an address book entry: "what did we
// spend at Home Depot this year" is only answerable if every Home Depot receipt
// points at ONE row. The DB enforces that with a case-insensitive partial unique
// index; this module's job is to never fight it, and to translate its 23505 into
// a sentence.
//
// `findOrCreateVendor` exists because the alternative — a free-text vendor field —
// produces "Home Depot", "home depot" and "HomeDepot " as three suppliers, and the
// owner only finds out when the report looks wrong months later.

export function vendorFromForm(v: VendorFormValues) {
  return {
    name: v.name.trim(),
    contact_name: v.contact_name.trim() || null,
    phone: v.phone.trim() || null,
    email: v.email.trim() || null,
    website: v.website.trim() || null,
    account_number: v.account_number.trim() || null,
    notes: v.notes.trim() || null,
  }
}

export async function listVendors(sb: SupabaseClient, userId: string): Promise<Vendor[]> {
  const { data } = await sb
    .from('vendors')
    .select('*')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('name', { ascending: true })
  return (data as Vendor[]) || []
}

export async function createVendor(
  sb: SupabaseClient,
  p: { userId: string; values: VendorFormValues },
): Promise<{ vendor?: Vendor; error?: string }> {
  const row = vendorFromForm(p.values)
  if (!row.name) return { error: 'Give the vendor a name.' }
  const { data, error } = await sb.from('vendors').insert({ user_id: p.userId, ...row }).select().single()
  if (error) return { error: duplicateVendorError(error, row.name) }
  return { vendor: data as Vendor }
}

export async function updateVendor(
  sb: SupabaseClient,
  id: string,
  values: VendorFormValues,
): Promise<{ error?: string }> {
  const row = vendorFromForm(values)
  if (!row.name) return { error: 'Give the vendor a name.' }
  const { error } = await sb.from('vendors').update(row).eq('id', id)
  if (error) return { error: duplicateVendorError(error, row.name) }
  return {}
}

/**
 * Archive, never delete. Expenses reference vendors ON DELETE SET NULL — deleting
 * a vendor would keep the money and lose who it went to, permanently, which is
 * exactly the fact a receipt exists to record.
 */
export async function archiveVendor(sb: SupabaseClient, id: string): Promise<{ error?: string }> {
  const { error } = await sb.from('vendors').update({ archived_at: new Date().toISOString() }).eq('id', id)
  return error ? { error: error.message } : {}
}

export async function restoreVendor(sb: SupabaseClient, id: string): Promise<{ error?: string }> {
  const { error } = await sb.from('vendors').update({ archived_at: null }).eq('id', id)
  if (error) return { error: duplicateVendorError(error, 'that name') }
  return {}
}

/**
 * The vendor with this name, or a new one — matched the way the DB matches, so
 * this function and the unique index can never disagree about what a duplicate is.
 *
 * The archived case is the subtle one: the unique index only covers ACTIVE rows,
 * so an archived "Home Depot" does not block a new one. Silently creating the
 * second row would split that supplier's history in two. We UNARCHIVE instead —
 * spending at a vendor again is the plainest possible statement that they're
 * still a vendor.
 */
export async function findOrCreateVendor(
  sb: SupabaseClient,
  p: { userId: string; name: string },
): Promise<{ vendor?: Vendor; error?: string }> {
  const name = p.name.trim()
  if (!name) return { error: 'Give the vendor a name.' }

  // ilike with escaped wildcards = exact match, case-insensitively. Mirrors
  // lower(trim(name)) in the index without a second normalisation rule.
  const { data: hit } = await sb
    .from('vendors')
    .select('*')
    .eq('user_id', p.userId)
    .ilike('name', escapeLike(name))
    .limit(1)
    .maybeSingle()

  if (hit) {
    const v = hit as Vendor
    if (v.archived_at) {
      const { error } = await sb.from('vendors').update({ archived_at: null }).eq('id', v.id)
      if (error) return { error: error.message }
      return { vendor: { ...v, archived_at: null } }
    }
    return { vendor: v }
  }
  return createVendor(sb, { userId: p.userId, values: blankVendor(name) })
}

/** How many expenses reference a vendor — shown before archiving. */
export async function vendorUsage(sb: SupabaseClient, id: string): Promise<number> {
  const { count } = await sb
    .from('expenses')
    .select('id', { count: 'exact', head: true })
    .eq('vendor_id', id)
    .is('archived_at', null)
  return count ?? 0
}

export function blankVendor(name = ''): VendorFormValues {
  return { name, contact_name: '', phone: '', email: '', website: '', account_number: '', notes: '' }
}

export function vendorToForm(v: Vendor): VendorFormValues {
  return {
    name: v.name,
    contact_name: v.contact_name || '',
    phone: v.phone || '',
    email: v.email || '',
    website: v.website || '',
    account_number: v.account_number || '',
    notes: v.notes || '',
  }
}

// A vendor legitimately named "50% Off Supply Co" contains a LIKE wildcard; without
// escaping, that name would match rows it isn't.
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, m => `\\${m}`)
}

function duplicateVendorError(error: { code?: string; message: string }, name: string): string {
  if (error.code === '23505') return `You already have a vendor called "${name}".`
  return error.message
}
