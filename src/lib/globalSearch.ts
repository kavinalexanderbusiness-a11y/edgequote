// ── Global search — the client half of THE record locator ────────────────────
//
// public.search_records (SECURITY DEFINER, scoped by auth.uid()) finds and ranks;
// this file turns its rows into something a person can act on: a record type, an
// identity, one line of useful context, and the route that opens it.
//
// It is pure and exported so `verify:global-search` runs the exact production
// logic. A search that quietly stops matching invoice numbers, or starts sending
// invoice results to an unfiltered list, is a wrong-VALUE bug tsc cannot see — the
// owner experiences it as "I found it and then lost it again".
//
// MONEY IS NOT COMPUTED HERE. Invoice rows carry the raw canonical columns and go
// through invoiceBalance/displayInvoiceStatus in lib/payments/ledger — THE engine
// the invoice list, the portal, the PDF and the Stripe charge already share. A
// balance re-derived for a search result would be a second money path, and the one
// place it disagreed would be the place the owner trusted least. Quote totals come
// from quotes.total, a GENERATED column, and are shown as stored.

import { invoiceBalance, displayInvoiceStatus } from '@/lib/payments/ledger'
import type { FeeSettings } from '@/lib/invoiceTotals'
import type { Invoice } from '@/types'

/**
 * Shortest query the locator will run. Below this every record in the book matches
 * and the answer is noise, so the UI says "keep typing" instead of asking the
 * database to prove it. Must stay in step with the same floor inside
 * search_records — verify:global-search asserts both.
 */
export const MIN_QUERY_LENGTH = 2

/** How many records one search returns. The RPC clamps its own ceiling at 25. */
export const SEARCH_LIMIT = 8

export type RecordKind = 'customer' | 'property' | 'quote' | 'invoice' | 'job'

/** One row exactly as search_records emits it. */
export interface SearchRow {
  kind: RecordKind
  id: string
  label: string | null
  sub: string | null
  rank: number
  customer_id: string | null
  created_at: string
  extra: {
    ref?: string | null
    status?: string | null
    total?: number | string | null
    amount?: number | string | null
    amount_paid?: number | string | null
    discount_type?: string | null
    discount_value?: number | string | null
    due_date?: string | null
    viewed_at?: string | null
    scheduled_date?: string | null
  } | null
}

/** A row made presentable: what it is, which one it is, why you care, where it opens. */
export interface SearchRecord {
  kind: RecordKind
  id: string
  /** The record's own identity — a name, an address, a number. Never a snippet. */
  label: string
  /** Secondary context. Empty when the record genuinely has none to offer. */
  sub: string
  /** The focused route that opens this exact record. */
  href: string
  rank: number
}

// ── Deep links ───────────────────────────────────────────────────────────────
// THE routing table. Every kind lands on the record itself, never on a list the
// owner then has to search a second time. Kept in one exported function so
// verify:global-search can assert each destination is focused rather than generic.
//
//   customer → /dashboard/customers/[id]                    (its own page)
//   property → /dashboard/properties/[id]                   (its own page; works
//              even when the property has no customer, which the old palette's
//              "jump to the customer" fallback did not)
//   quote    → /dashboard/quotes/[id]                       (its own page)
//   invoice  → /dashboard/invoices?invoice=INV-0069         (the focus seam the
//              invoices page already reads and banners; there is deliberately no
//              /invoices/[id] route)
//   job      → /dashboard/schedule?job=[id]                 (the visit-focus seam;
//              ?customer= is a CREATE door and would open a blank new-visit form)
export function hrefForRecord(r: Pick<SearchRecord, 'kind' | 'id'> & { ref?: string | null }): string {
  switch (r.kind) {
    case 'customer': return `/dashboard/customers/${r.id}`
    case 'property': return `/dashboard/properties/${r.id}`
    case 'quote':    return `/dashboard/quotes/${r.id}`
    case 'invoice':
      // The list focuses by NUMBER, not id. A numberless invoice (a draft that
      // never got one) has nothing to focus on, so it opens the list rather than
      // a link that would silently focus nothing.
      return r.ref ? `/dashboard/invoices?invoice=${encodeURIComponent(r.ref)}` : '/dashboard/invoices'
    case 'job':      return `/dashboard/schedule?job=${r.id}`
  }
}

/** Human label for the type badge. The kind is never hidden from the owner. */
export const KIND_LABEL: Record<RecordKind, string> = {
  customer: 'Customer',
  property: 'Property',
  quote: 'Quote',
  invoice: 'Invoice',
  job: 'Visit',
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Money context for an invoice row, in the words the rest of the app uses.
 *
 * Reads THE canonical engine, so a settled invoice whose stored status never caught
 * up with the ledger says "Paid" here exactly as it does on the invoice list — the
 * display overlay that exists because a stored status can outlive its payments.
 * Returns null rather than guessing when the row is missing the columns the engine
 * needs, because a wrong number on a money surface is worse than no number.
 */
export function invoiceMoneyContext(
  extra: NonNullable<SearchRow['extra']>,
  settings: FeeSettings | null | undefined,
  todayISO: string,
  formatCurrency: (n: number) => string,
): string | null {
  if (extra.amount == null) return null
  const inv = {
    amount: num(extra.amount),
    amount_paid: num(extra.amount_paid),
    discount_type: (extra.discount_type ?? null) as Invoice['discount_type'],
    discount_value: extra.discount_value == null ? null : num(extra.discount_value),
    status: (extra.status ?? 'unpaid') as Invoice['status'],
    due_date: extra.due_date ?? null,
    viewed_at: extra.viewed_at ?? null,
  }
  const { balance } = invoiceBalance(inv, settings)
  const display = displayInvoiceStatus(inv, settings, todayISO)

  if (display === 'cancelled') return 'Cancelled'
  // A cancelled invoice keeps its full balance in the columns, which is why the
  // status is read FIRST — quoting a balance owing on a cancelled invoice would
  // send the owner to collect money nobody owes.
  if (balance <= 0.01) return 'Paid'
  const owing = `${formatCurrency(balance)} balance`
  return display === 'overdue' ? `${owing} · Overdue` : owing
}

/**
 * Rows → records. `settings` is the business's fee/GST settings, needed by the
 * canonical balance engine; when it hasn't loaded yet the invoice simply shows no
 * money line rather than a figure computed from an incomplete input.
 */
export function toSearchRecords(
  rows: SearchRow[],
  opts: {
    settings: FeeSettings | null | undefined
    todayISO: string
    formatCurrency: (n: number) => string
    /** Withhold money context until the settings the engine needs have loaded. */
    settingsLoaded: boolean
  },
): SearchRecord[] {
  return rows.map(row => {
    const extra = row.extra ?? {}
    const parts: string[] = []

    // MONEY LEADS on a document, and the rest of the context follows it.
    //
    // Measured, not assumed: with the customer first, a 390px row rendered
    // "Sarah Brown · General Landscaping · $3,295.00 balan…" — the qualifier was
    // the thing CSS truncated, leaving a bare figure that reads exactly like the
    // invoice TOTAL. On a money surface an unlabelled number is worse than no
    // number. Leading with it means truncation eats the service type instead, and
    // "$3,295.00 balance" survives at every width.
    if (row.kind === 'invoice' && opts.settingsLoaded) {
      const money = invoiceMoneyContext(extra, opts.settings, opts.todayISO, opts.formatCurrency)
      if (money) parts.push(money)
    } else if (row.kind === 'quote' && extra.total != null) {
      // quotes.total is GENERATED — one number, shown as stored.
      parts.push(opts.formatCurrency(num(extra.total)))
    }

    if (row.sub) parts.push(row.sub)

    if (row.kind === 'job' && extra.status) parts.push(String(extra.status).replace(/_/g, ' '))

    return {
      kind: row.kind,
      id: row.id,
      label: row.label || KIND_LABEL[row.kind],
      sub: parts.join(' · '),
      href: hrefForRecord({ kind: row.kind, id: row.id, ref: extra.ref }),
      rank: row.rank,
    }
  })
}

/**
 * Is this query worth sending? Trimmed length only — the RPC applies the identical
 * floor, so this is the UI's way of saying "keep typing" without a round trip, not
 * a second source of truth.
 */
export function isSearchable(query: string): boolean {
  return query.trim().length >= MIN_QUERY_LENGTH
}
