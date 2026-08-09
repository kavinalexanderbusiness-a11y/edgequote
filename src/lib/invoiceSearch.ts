// ── Invoice search ───────────────────────────────────────────────────────────
// THE matching engine behind the invoice list's search box. Pure and exported so
// `verify:invoice-search` runs the exact production logic — a search that quietly
// stops matching invoice numbers is a wrong-VALUE bug tsc cannot see, and the owner
// experiences it as "my invoice isn't there".
//
// WHY CLIENT-SIDE. The invoice page already loads EVERY invoice through pageAll —
// deliberately, because the Outstanding/Collected totals must count the whole book,
// not the newest page (an unbounded select silently stops at 1000 rows, which is the
// bug pageAll exists to prevent). The rows are therefore already in memory, so
// filtering them costs one pass and adds no query, no pagination and no second
// source of truth. Moving search to the server would mean either a second query path
// whose results could disagree with those totals, or pagination that breaks them.
//
// The cost that does matter is doing it PER KEYSTROKE, so the searchable text is
// built once per data change (buildInvoiceSearchIndex) and each keystroke is a
// substring scan over prepared strings.
//
// WHAT IS SEARCHED — the identifiers an owner actually remembers, and nothing else:
//   invoice number · customer name (denormalised + joined) · customer email · phone ·
//   service address · service type.
// Deliberately NOT searched: notes, internal_notes and line_items. They are free
// text and jsonb of unbounded size; scanning them would make every keystroke
// proportional to the largest note in the book, and `internal_notes` is the owner's
// private commentary — surfacing an invoice because of what was written ABOUT it
// privately is a surprise, not a feature.

/** The subset of an invoice this engine reads. Nothing financial is touched. */
export interface SearchableInvoice {
  invoice_number?: string | null
  customer_name?: string | null
  address?: string | null
  service_type?: string | null
  customers?: { name?: string | null; email?: string | null; phone?: string | null } | null
}

/** Lowercase, strip everything that is not a letter or digit. */
const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Digits only, with leading zeros dropped, so `INV-0052` also answers to `52`. */
function bareNumber(s: string): string {
  const digits = s.replace(/\D+/g, '')
  if (!digits) return ''
  const trimmed = digits.replace(/^0+/, '')
  return trimmed || '0'
}

export interface InvoiceSearchEntry<T> {
  item: T
  /** Everything readable, lowercased — matches plain words like a name or street. */
  text: string
  /**
   * Punctuation-free identifiers — invoice number, phone, email — so the formatting
   * an owner types never has to match the formatting we stored. `INV-0052`,
   * `inv 0052`, `INV0052` and `52` all reach the same invoice, and `(403) 555-0142`
   * finds a phone saved as `403-555-0142`.
   */
  ident: string
}

function entryFor<T extends SearchableInvoice>(item: T): InvoiceSearchEntry<T> {
  const c = item.customers ?? null
  const number = item.invoice_number ?? ''
  const phone = c?.phone ?? ''
  const email = c?.email ?? ''
  const text = [number, item.customer_name, c?.name, email, phone, item.address, item.service_type]
    .filter(Boolean).join(' ').toLowerCase()
  const ident = [alnum(number), bareNumber(number), alnum(phone), alnum(email)]
    .filter(Boolean).join(' ')
  return { item, text, ident }
}

/** Build once per data change; reuse across keystrokes. */
export function buildInvoiceSearchIndex<T extends SearchableInvoice>(items: T[]): InvoiceSearchEntry<T>[] {
  return items.map(entryFor)
}

/**
 * Split a raw query into tokens. Every token must match (AND), so `smith mowing`
 * narrows to Smith's mowing invoices instead of returning every Smith and every
 * mowing job. Empty/whitespace queries produce no tokens, which means "no filter".
 */
export function queryTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/** Does one prepared entry satisfy every token? */
export function entryMatches(entry: Pick<InvoiceSearchEntry<unknown>, 'text' | 'ident'>, tokens: string[]): boolean {
  for (const token of tokens) {
    if (entry.text.includes(token)) continue
    const t = alnum(token)
    if (t && entry.ident.includes(t)) continue
    return false
  }
  return true
}

/**
 * Convenience for callers that don't hold an index (and for the verify suite):
 * build + filter in one call. An empty query returns the list unchanged — search
 * that is not being used must never remove a row.
 */
export function searchInvoices<T extends SearchableInvoice>(items: T[], query: string): T[] {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return items
  return buildInvoiceSearchIndex(items).filter(e => entryMatches(e, tokens)).map(e => e.item)
}
