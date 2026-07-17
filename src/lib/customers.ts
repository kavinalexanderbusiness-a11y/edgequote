// ── Customer + property integrity engine ─────────────────────────────────────
// The ONE place "find-or-create the customer & property behind a quote/job"
// lives, so the quote save flow and the data-recovery tool can never diverge.
// Mirrors the customer+property insert shape used by the Customers page
// (src/app/dashboard/customers/page.tsx) — never a second creation path.

import type { createClient } from '@/lib/supabase/client'
import type { Customer } from '@/types'

type Supa = ReturnType<typeof createClient>

export type MatchReason = 'phone' | 'email' | 'address' | 'name'

// Digits only — so "(403) 555-0100" and "403-555-0100" are the same number.
export function normalizePhone(p?: string | null): string {
  return (p || '').replace(/\D/g, '')
}
export function normalizeEmail(e?: string | null): string {
  return (e || '').trim().toLowerCase()
}

// The fewest digits worth treating as "they're typing a phone number". Below this
// a stray "40" in a name search would drag in every 403 number in the book.
const PHONE_SEARCH_MIN_DIGITS = 3

/**
 * Digits to match against customers.phone_digits, or '' when the query isn't
 * phone-shaped enough to bother.
 *
 * THE rule for turning something a person typed into a phone lookup. A number is
 * read off a handset, a sticky note or a missed-call list, so it arrives in every
 * shape there is — "(403) 681-9016", "403-681-9016", "4036819016", or just the
 * last four. Matching that against however the number happens to be stored is
 * what the generated column exists for (RUN-2026-07-16-phone-search.sql); this
 * is the caller's half of the same rule.
 *
 * Letters disqualify the query outright: "Rose 403" is a name search that happens
 * to contain digits, and stripping to "403" would answer a question nobody asked.
 */
export function phoneSearchDigits(query: string): string {
  const q = (query || '').trim()
  if (!q || /[a-z@]/i.test(q)) return ''
  const digits = normalizePhone(q)
  return digits.length >= PHONE_SEARCH_MIN_DIGITS ? digits : ''
}
// Canonical forms so "SW" == "Southwest" and "Crescent" == "Cres" — without
// this, the same address written two ways looks like two places and we'd create
// duplicate properties (real case: "Canso Crescent SW" vs "Canso Crescent Southwest").
const ADDR_TOKEN: Record<string, string> = {
  northwest: 'nw', northeast: 'ne', southwest: 'sw', southeast: 'se',
  north: 'n', south: 's', east: 'e', west: 'w',
  street: 'st', avenue: 'ave', av: 'ave', road: 'rd', crescent: 'cres', cr: 'cres',
  place: 'pl', drive: 'dr', boulevard: 'blvd', court: 'ct', lane: 'ln', trail: 'tr',
  close: 'cl', gate: 'gt', green: 'grn', gardens: 'gdns', heights: 'hts', hill: 'hl',
  hills: 'hls', manor: 'mnr', parade: 'pde', park: 'pk', square: 'sq', terrace: 'ter',
  point: 'pt', circle: 'cir', grove: 'grv', landing: 'lndg', common: 'cmn', cove: 'cv',
  bay: 'bay', way: 'way', view: 'vw', rise: 'rise', row: 'row', mews: 'mews',
}

// Lowercase, strip punctuation/"Canada", collapse whitespace, then canonicalize
// each token (direction + street-type abbreviations).
export function normalizeAddressKey(a?: string | null): string {
  const base = (a || '')
    .toLowerCase()
    .replace(/\bcanada\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!base) return ''
  return base.split(' ').map(t => ADDR_TOKEN[t] || t).join(' ')
}
export function normalizeName(n?: string | null): string {
  return (n || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

// Two addresses refer to the same place if one normalized form is a prefix of the
// other — handles "123 Main St" vs "123 Main St, Calgary, AB" without matching
// "123 Main St" to "125 Main St".
export function addressMatches(a?: string | null, b?: string | null): boolean {
  const x = normalizeAddressKey(a), y = normalizeAddressKey(b)
  if (x.length < 5 || y.length < 5) return false
  return x === y || x.startsWith(y) || y.startsWith(x)
}

export interface MatchInput {
  name?: string | null
  phone?: string | null
  email?: string | null
  address?: string | null
}
export interface CustomerMatch { customer: Customer; reason: MatchReason; confident: boolean }

// Find the most likely existing customer. Phone / email / address matches are
// "confident" (safe to auto-link); a name-only match is returned but flagged
// not-confident, so the save flow never silently merges two different people.
export function findCustomerMatch(customers: Customer[], input: MatchInput): CustomerMatch | null {
  const phone = normalizePhone(input.phone)
  if (phone.length >= 7) {
    const c = customers.find(c => { const p = normalizePhone(c.phone); return p.length >= 7 && p === phone })
    if (c) return { customer: c, reason: 'phone', confident: true }
  }
  const email = normalizeEmail(input.email)
  if (email) {
    const c = customers.find(c => normalizeEmail(c.email) === email)
    if (c) return { customer: c, reason: 'email', confident: true }
  }
  if (input.address && normalizeAddressKey(input.address).length >= 5) {
    const c = customers.find(c => addressMatches(c.address, input.address))
    if (c) return { customer: c, reason: 'address', confident: true }
  }
  const name = normalizeName(input.name)
  if (name) {
    const c = customers.find(c => normalizeName(c.name) === name)
    if (c) return { customer: c, reason: 'name', confident: false }
  }
  return null
}

const REAL_ID = (id?: string | null) => !!id && id !== '__manual' && id !== ''

export interface EnsureInput {
  customerId?: string | null
  name: string
  address?: string | null
  phone?: string | null
  email?: string | null
  city?: string | null
  province?: string | null
  postal_code?: string | null
}
export interface EnsureResult {
  customerId: string
  customerName: string
  propertyId: string | null
  createdCustomer: boolean
  createdProperty: boolean
  matchedBy: MatchReason | null
}

// Find-or-create the customer for an address/contact, then find-or-create the
// matching property, and return their ids. Used by the quote save flow and the
// data-recovery tool. `knownCustomers` is the already-loaded customer list (no
// extra round-trip, no duplicate query engine).
export async function ensureCustomerAndProperty(
  supabase: Supa, userId: string, input: EnsureInput, knownCustomers: Customer[],
): Promise<EnsureResult> {
  let customerId: string | null = REAL_ID(input.customerId) ? input.customerId! : null
  let customerName = input.name
  let createdCustomer = false
  let matchedBy: MatchReason | null = null

  if (customerId) {
    const found = knownCustomers.find(c => c.id === customerId)
    if (found) customerName = found.name
  } else {
    const match = findCustomerMatch(knownCustomers, input)
    if (match && match.confident) {
      customerId = match.customer.id
      customerName = match.customer.name
      matchedBy = match.reason
      // Enrich the existing record with any contact info it was missing.
      const patch: Record<string, string> = {}
      if (!match.customer.phone && input.phone) patch.phone = input.phone
      if (!match.customer.email && input.email) patch.email = input.email
      if (Object.keys(patch).length) await supabase.from('customers').update(patch).eq('id', customerId)
    } else {
      const { data, error } = await supabase.from('customers').insert({
        name: input.name,
        email: input.email || null,
        phone: input.phone || null,
        address: input.address || null,
        city: input.city || null,
        province: input.province || 'AB',
        postal_code: input.postal_code || null,
        user_id: userId,
      }).select().single()
      if (error || !data) throw new Error(error?.message || 'Could not create customer')
      customerId = data.id
      customerName = data.name
      createdCustomer = true
    }
  }

  if (!customerId) throw new Error('Could not resolve a customer')
  const { propertyId, createdProperty } = await ensurePropertyForCustomer(supabase, userId, customerId, input)
  return { customerId, customerName, propertyId, createdCustomer, createdProperty, matchedBy }
}

// Find-or-create the property for a customer that matches the given address.
// Creates one if none matches; the customer's first property becomes primary.
export async function ensurePropertyForCustomer(
  supabase: Supa, userId: string, customerId: string,
  input: { address?: string | null; city?: string | null; province?: string | null; postal_code?: string | null },
): Promise<{ propertyId: string | null; createdProperty: boolean }> {
  const { data: props } = await supabase
    .from('properties').select('id, address, is_primary').eq('customer_id', customerId)
  const list = (props as { id: string; address: string; is_primary: boolean }[]) || []

  if (input.address && normalizeAddressKey(input.address).length >= 5) {
    const match = list.find(p => addressMatches(p.address, input.address))
    if (match) return { propertyId: match.id, createdProperty: false }
    const { data, error } = await supabase.from('properties').insert({
      customer_id: customerId,
      user_id: userId,
      address: input.address,
      city: input.city || null,
      province: input.province || 'AB',
      postal_code: input.postal_code || null,
      is_primary: list.length === 0,
    }).select('id').single()
    if (error || !data) return { propertyId: list.find(p => p.is_primary)?.id ?? null, createdProperty: false }
    return { propertyId: data.id, createdProperty: true }
  }

  // No usable address — fall back to the customer's primary property if any.
  return { propertyId: list.find(p => p.is_primary)?.id ?? list[0]?.id ?? null, createdProperty: false }
}
