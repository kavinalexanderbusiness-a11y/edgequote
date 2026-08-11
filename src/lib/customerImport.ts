// ── Customer CSV import ──────────────────────────────────────────────────────
// Moving a business's customer book into EdgeQuote from whatever it used before:
// a spreadsheet, Jobber, Housecall Pro, another CRM. No vendor integration — a
// CSV and a column-mapping step, because that is the one export every one of
// them can produce.
//
// Everything decidable WITHOUT the database lives here and is PURE, so the
// preview the owner approves and the plan that actually runs are the SAME
// object. A preview computed by one code path and a write performed by another
// is how "300 imported" gets printed over 214 rows.
//
// ⭐ Identity is NOT decided in this file. `findCustomerMatch` (lib/customers)
// is THE answer to "is this the same person?", shared with the SQL intake seam
// (resolve_intake_customer, BK-1). This module CONSUMES it. A second matcher
// here would be the exact fork BK-1 closed, wearing an importer's hat.

import type { createClient } from '@/lib/supabase/client'
import type { Customer } from '@/types'
import {
  findCustomerMatch, displayAddress, normalizePhone, normalizeEmail,
  phoneMatches as phoneSame,
  type MatchReason, type AddressCarrier,
} from '@/lib/customers'
import { recordImportConsent } from '@/lib/consent'
import { sanitizeSourceInput } from '@/lib/attribution'

type Supa = ReturnType<typeof createClient>

// ── Bounds ───────────────────────────────────────────────────────────────────
// A CSV is untrusted input that arrives by file picker, so every dimension it
// could grow in has a ceiling. These are enforced during PARSE — nothing
// unbounded ever reaches a row object, a React list, or a network payload.
export const IMPORT_LIMITS = {
  maxBytes: 5 * 1024 * 1024,   // 5 MB — a 5,000-row contact export is ~500 KB
  maxRows: 5000,               // data rows, excluding the header
  maxColumns: 64,
  maxCell: 5000,               // characters kept per raw cell before field caps
  // Per-field caps, applied after mapping. Postgres would take far more; these
  // exist so one pathological cell can't become a customer name that breaks
  // every list, export and SMS that later renders it.
  name: 200, email: 254, phone: 40,
  address: 300, city: 120, province: 60, postal_code: 20, notes: 2000,
} as const

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Strip anything that isn't safe to carry into a text column.
 *
 * C0/C1 control characters (and the Unicode line/paragraph separators) become
 * spaces: they are invisible, they survive round-trips, and they let a crafted
 * cell forge line breaks in anything that later renders the value as text. A
 * newline inside a quoted CSV field is legitimate CSV, but a customer name or a
 * note is a single line by the time it is stored — so it folds to a space here
 * rather than being rejected.
 *
 * Zero-width and bidi-override characters go too: they are pure display
 * trickery (a name that renders as someone else's) with no legitimate use in a
 * contact record.
 */
// C0 controls, DEL and the C1 block, plus the Unicode line/paragraph separators.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

function sanitizeCell(raw: string): string {
  return raw
    .replace(CONTROL_CHARS, ' ')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface ParsedCsv {
  headers: string[]
  /** Data rows, each already sanitized and padded to `headers.length`. */
  rows: string[][]
  /** 1-based source line each row came from, for owner-facing "row 214" talk. */
  lines: number[]
  /** Set when a ceiling in IMPORT_LIMITS clipped the input — never silent. */
  truncated: { rows?: number; columns?: number; bytes?: boolean }
  error?: string
}

/**
 * RFC-4180 CSV → a header row plus sanitized data rows.
 *
 * Handles quoted fields, embedded commas, `""` escapes, embedded newlines, both
 * line endings, and a UTF-8 BOM. Rows that are entirely empty are dropped (a
 * trailing newline is not a customer); everything else is kept and classified
 * later, because a row the owner can SEE rejected is worth more than a row that
 * quietly never existed.
 */
export function parseCsv(text: string): ParsedCsv {
  const truncated: ParsedCsv['truncated'] = {}
  let body = text
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1)
  if (body.length > IMPORT_LIMITS.maxBytes) {
    body = body.slice(0, IMPORT_LIMITS.maxBytes)
    truncated.bytes = true
  }

  const grid: string[][] = []
  const lineOf: number[] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let line = 1
  let rowStartLine = 1

  const pushField = () => {
    row.push(field.length > IMPORT_LIMITS.maxCell ? field.slice(0, IMPORT_LIMITS.maxCell) : field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    if (row.some(c => c.trim() !== '')) { grid.push(row); lineOf.push(rowStartLine) }
    row = []
    rowStartLine = line
  }

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else {
        if (ch === '\n') line++
        field += ch
      }
      continue
    }
    if (ch === '"') { inQuotes = true; continue }
    if (ch === ',') { pushField(); continue }
    if (ch === '\n') { line++; pushRow(); continue }
    if (ch === '\r') continue
    field += ch
  }
  if (field !== '' || row.length) pushRow()

  if (grid.length === 0) return { headers: [], rows: [], lines: [], truncated, error: 'That file has no rows in it.' }

  let headers = grid[0].map(sanitizeCell)
  if (headers.length > IMPORT_LIMITS.maxColumns) {
    truncated.columns = headers.length - IMPORT_LIMITS.maxColumns
    headers = headers.slice(0, IMPORT_LIMITS.maxColumns)
  }

  let data = grid.slice(1)
  if (data.length > IMPORT_LIMITS.maxRows) {
    truncated.rows = data.length - IMPORT_LIMITS.maxRows
    data = data.slice(0, IMPORT_LIMITS.maxRows)
  }

  const rows = data.map(r => {
    const out: string[] = []
    for (let i = 0; i < headers.length; i++) out.push(sanitizeCell(r[i] ?? ''))
    return out
  })

  if (rows.length === 0) {
    return { headers, rows, lines: [], truncated, error: 'That file has a header row but no customers under it.' }
  }
  return { headers, rows, lines: lineOf.slice(1, data.length + 1), truncated }
}

// ── Column mapping ───────────────────────────────────────────────────────────

/** The EdgeQuote fields a V1 import can fill. Deliberately small — see the
 *  session scope: customers, contact, one service address, optional notes. */
export type ImportField =
  | 'name' | 'first_name' | 'last_name'
  | 'email' | 'phone'
  | 'address' | 'city' | 'province' | 'postal_code' | 'notes'
  | 'source' | 'sms_opt_in' | 'email_opt_in'

export const IMPORT_FIELDS: { field: ImportField; label: string; hint?: string }[] = [
  { field: 'name', label: 'Full name', hint: 'Or map First + Last name instead' },
  { field: 'first_name', label: 'First name' },
  { field: 'last_name', label: 'Last name' },
  { field: 'email', label: 'Email' },
  { field: 'phone', label: 'Phone' },
  { field: 'address', label: 'Street address' },
  { field: 'city', label: 'City' },
  { field: 'province', label: 'Province / State' },
  { field: 'postal_code', label: 'Postal / ZIP' },
  { field: 'notes', label: 'Notes' },
  { field: 'source', label: 'How they found you', hint: 'Left blank stays "Not recorded"' },
  { field: 'sms_opt_in', label: 'SMS consent', hint: 'Only if the column records real consent' },
  { field: 'email_opt_in', label: 'Email consent' },
]

/** Column index per field; null = not mapped. The owner confirms this before
 *  anything is previewed, so a wrong guess costs a dropdown, never a record. */
export type ColumnMapping = Record<ImportField, number | null>

export const EMPTY_MAPPING: ColumnMapping = {
  name: null, first_name: null, last_name: null, email: null, phone: null,
  address: null, city: null, province: null, postal_code: null, notes: null,
  source: null, sms_opt_in: null, email_opt_in: null,
}

const headerTokens = (h: string) =>
  h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)

// Aliases seen in real exports from spreadsheets, Jobber and Housecall Pro.
// Multi-word entries matter: "email address" must resolve to EMAIL, and it only
// beats ADDRESS because it is listed here as an exact phrase (exact scores above
// token-subset). Order within a list is irrelevant; scoring decides.
const ALIASES: Record<ImportField, string[]> = {
  name: ['name', 'customer name', 'client name', 'customer', 'client', 'full name',
    'display name', 'contact name', 'company', 'company name', 'business name',
    'account name', 'customer full name'],
  first_name: ['first name', 'first', 'firstname', 'given name', 'fname', 'contact first name'],
  last_name: ['last name', 'last', 'lastname', 'surname', 'family name', 'lname', 'contact last name'],
  email: ['email', 'email address', 'e mail', 'emails', 'primary email', 'customer email',
    'contact email', 'main email', 'email 1'],
  phone: ['phone', 'phone number', 'mobile', 'mobile phone', 'mobile number', 'cell',
    'cell phone', 'telephone', 'tel', 'primary phone', 'main phone', 'home phone',
    'work phone', 'contact number', 'phone 1', 'customer phone'],
  address: ['address', 'street', 'street address', 'address 1', 'address line 1',
    'service address', 'property address', 'billing address', 'street 1', 'street line 1',
    'mailing address', 'address line'],
  city: ['city', 'town', 'municipality', 'suburb', 'locality'],
  province: ['province', 'state', 'province state', 'state province', 'region', 'prov',
    'state region', 'county'],
  postal_code: ['postal code', 'postal', 'zip', 'zip code', 'postcode', 'post code',
    'zip postal', 'postal zip', 'postalcode', 'zipcode'],
  notes: ['notes', 'note', 'comments', 'comment', 'description', 'details', 'memo',
    'internal notes', 'customer notes', 'remarks'],
  source: ['source', 'acquisition source', 'lead source', 'referral source',
    'how did you hear', 'how they found you', 'origin', 'channel'],
  sms_opt_in: ['sms opt in', 'sms consent', 'text consent', 'sms', 'text opt in',
    'sms subscribed', 'accepts texts'],
  email_opt_in: ['email opt in', 'email consent', 'email subscribed',
    'accepts email', 'marketing opt in', 'newsletter'],
}

// A header naming another channel is never an address, however much of the word
// "address" it contains. "Email Address" and "Website Address" are the cases;
// without this, a token-subset match hands ADDRESS the customer's email column.
const NOT_ADDRESS = new Set(['email', 'e', 'mail', 'web', 'website', 'url', 'ip'])

/** 3 = the header IS this field · 2 = every alias word appears in it · 0 = no. */
function scoreHeader(field: ImportField, header: string): number {
  const toks = headerTokens(header)
  if (toks.length === 0) return 0
  const flat = toks.join(' ')
  const aliases = ALIASES[field]
  if (aliases.includes(flat)) return 3
  if (field === 'address' && toks.some(t => NOT_ADDRESS.has(t))) return 0
  for (const a of aliases) {
    const at = a.split(' ')
    if (at.every(t => toks.includes(t))) return 2
  }
  return 0
}

/**
 * Best-guess mapping for a set of headers — a SUGGESTION the owner confirms.
 *
 * Assignment is global and greedy by score, so the strongest pairing wins the
 * column even when a weaker field also wanted it: with `First Name` and `Name`
 * both present, `Name`→name scores 3 and takes it, leaving `First Name`→
 * first_name (also 3) undisturbed. One column per field, one field per column.
 */
export function suggestMapping(headers: string[]): ColumnMapping {
  const out: ColumnMapping = { ...EMPTY_MAPPING }
  const pairs: { field: ImportField; col: number; score: number }[] = []
  for (const { field } of IMPORT_FIELDS) {
    headers.forEach((h, col) => {
      const score = scoreHeader(field, h)
      if (score > 0) pairs.push({ field, col, score })
    })
  }
  // Highest score first; ties resolve left-to-right so the earlier column wins,
  // which is what a person reading the sheet would assume.
  pairs.sort((a, b) => b.score - a.score || a.col - b.col)
  const takenCol = new Set<number>()
  for (const p of pairs) {
    if (out[p.field] !== null || takenCol.has(p.col)) continue
    out[p.field] = p.col
    takenCol.add(p.col)
  }
  // A sheet with First+Last and no separate full-name column builds the name
  // from the pair; leaving `name` mapped to one of them would drop the other.
  if (out.name !== null && (out.name === out.first_name || out.name === out.last_name)) out.name = null
  return out
}

/** Is there enough mapped to identify a person at all? */
export function mappingNamesSomeone(m: ColumnMapping): boolean {
  return m.name !== null || m.first_name !== null || m.last_name !== null
}

// ── Row values ───────────────────────────────────────────────────────────────

export interface ImportRowValues {
  name: string
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  province: string | null
  postal_code: string | null
  notes: string | null
  /** Raw text as the old system wrote it, bounded. lib/attribution categorizes it
   *  at READ time — the column keeps what was said, never a normalized guess. */
  source: string | null
  /** Consent as the exported system recorded it. An import NEVER opts anyone in
   *  on its own: these are false unless a mapped column says otherwise, and the
   *  page makes the owner acknowledge the SMS rules before any true one is
   *  written. */
  sms_opt_in: boolean
  email_opt_in: boolean
}

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s)

// Deliberately permissive: one @, something either side, a dot in the domain.
// Its job is to catch "n/a", "none", "jane at example.com" and stray commas —
// not to adjudicate RFC 5322. A real address that this rejects would be a bug;
// a junk value it accepts is merely stored as the source had it.
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/

export function readRow(cells: string[], m: ColumnMapping): { values: ImportRowValues; warnings: string[] } {
  const warnings: string[] = []
  const at = (i: number | null) => (i === null ? '' : (cells[i] ?? '').trim())

  const first = at(m.first_name), last = at(m.last_name)
  const whole = at(m.name)
  const name = cap(whole || [first, last].filter(Boolean).join(' ').trim(), IMPORT_LIMITS.name)

  let email: string | null = at(m.email) || null
  if (email) {
    // Stored lowercase: normalizeEmail is how every match and every send reads
    // it, so storing the shouty version would only ever differ cosmetically.
    const e = normalizeEmail(email)
    if (!EMAIL_RE.test(e) || e.length > IMPORT_LIMITS.email) {
      warnings.push(`Email "${cap(email, 60)}" doesn't look like an address — leaving it blank.`)
      email = null
    } else email = e
  }

  let phone: string | null = at(m.phone) || null
  if (phone) {
    phone = cap(phone, IMPORT_LIMITS.phone)
    const digits = normalizePhone(phone)
    if (digits.length === 0) {
      warnings.push(`Phone "${cap(phone, 40)}" has no digits — leaving it blank.`)
      phone = null
    } else if (digits.length < 7) {
      warnings.push(`Phone "${phone}" is too short to match a person reliably — imported as written.`)
    }
  }

  const address = at(m.address) ? cap(at(m.address), IMPORT_LIMITS.address) : null
  const rawNotes = at(m.notes)
  if (rawNotes.length > IMPORT_LIMITS.notes) warnings.push(`Note was longer than ${IMPORT_LIMITS.notes} characters and was shortened.`)

  return {
    values: {
      name,
      email,
      phone,
      address,
      city: at(m.city) ? cap(at(m.city), IMPORT_LIMITS.city) : null,
      province: at(m.province) ? cap(at(m.province), IMPORT_LIMITS.province) : null,
      postal_code: at(m.postal_code) ? cap(at(m.postal_code), IMPORT_LIMITS.postal_code) : null,
      notes: rawNotes ? cap(rawNotes, IMPORT_LIMITS.notes) : null,
      // sanitizeSourceInput is attribution's own bound on this column — reused
      // rather than re-implemented, so the importer and the public booking door
      // cannot disagree about what a source string may contain.
      source: sanitizeSourceInput(at(m.source)),
      sms_opt_in: truthy(at(m.sms_opt_in)),
      email_opt_in: truthy(at(m.email_opt_in)),
    },
    warnings,
  }
}

/** What an exported spreadsheet means by "yes". Anything else — including blank,
 *  "no", and an unmapped column — is NOT consent. */
function truthy(v: string): boolean {
  return ['true', '1', 'yes', 'y', 'x', 't'].includes(v.toLowerCase().trim())
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * `new`      — nobody in the book looks like this person. Will be created.
 * `existing` — a CONFIDENT match (phone, email or address). Will be skipped.
 * `review`   — something matched, but not confidently enough to act on: a
 *              name-only match, or two identifiers pointing at two different
 *              people. Skipped unless the owner opts the row in.
 * `invalid`  — cannot become a customer at all. Never written.
 */
export type RowStatus = 'new' | 'existing' | 'review' | 'invalid'

export interface PlannedRow {
  line: number
  values: ImportRowValues
  status: RowStatus
  /** Owner-facing sentence. Always populated — a status with no stated reason
   *  is a confidence claim with no evidence behind it. */
  reason: string
  warnings: string[]
  matchId: string | null
  matchName: string | null
  matchedBy: MatchReason | null
  /** Set when the twin is another row of THIS file rather than the book. */
  duplicateOfLine: number | null
  /** Whether this row will be written. Owner-toggleable for `review` only. */
  include: boolean
}

/** A row planned as `new` is itself a candidate for the rows below it, so two
 *  spellings of one person inside a single file collapse to one customer. The
 *  `row:` id prefix is how the planner tells "already in the book" from
 *  "earlier in this file". */
const ROW_ID = (line: number) => `row:${line}`

function asCandidate(v: {
  id: string; name: string; email: string | null; phone: string | null; address: string | null
}): Customer {
  // findCustomerMatch reads exactly these five fields. Widening the real
  // Customer type just to describe a synthetic candidate would spread a type
  // that only this matcher's call site needs.
  return v as unknown as Customer
}

export interface PlanInput {
  parsed: ParsedCsv
  mapping: ColumnMapping
  /** The book, with each customer's properties loaded — see `matchBook`. */
  existing: (Customer & AddressCarrier)[]
}

/**
 * Turn parsed rows + a confirmed mapping into the exact list of writes.
 *
 * The address a customer is matched ON is `displayAddress()` — the Customer V2
 * resolver — not the legacy `customers.address` column. A customer created
 * after V2 has that column empty and their address on the primary property, so
 * matching the raw column would call every V2-era customer new and re-import
 * the whole book on the second upload.
 */
export function planImport({ parsed, mapping, existing }: PlanInput): PlannedRow[] {
  const book: Customer[] = existing.map(c =>
    asCandidate({
      id: c.id, name: c.name, email: c.email, phone: c.phone,
      address: displayAddress(c).address || null,
    }))
  const byId = new Map(existing.map(c => [c.id, c]))
  const candidates: Customer[] = [...book]
  const rowLabel = new Map<string, string>()

  const out: PlannedRow[] = []
  parsed.rows.forEach((cells, i) => {
    const line = parsed.lines[i] ?? i + 2
    const { values, warnings } = readRow(cells, mapping)

    if (!values.name) {
      out.push({
        line, values, warnings, status: 'invalid',
        reason: 'No name in this row — EdgeQuote needs a name to create a customer.',
        matchId: null, matchName: null, matchedBy: null, duplicateOfLine: null, include: false,
      })
      return
    }

    const match = findCustomerMatch(candidates, values)

    // Ambiguity: the identifiers disagree about WHO this is. Phone says Dana,
    // email says Sam — merging either way invents a fact, and creating a third
    // record invents a person. The owner decides.
    const conflict = findConflict(candidates, values)
    if (conflict) {
      out.push({
        line, values, warnings, status: 'review',
        reason: `Phone matches ${nameOf(conflict.byPhone, byId, rowLabel)} but email matches ${nameOf(conflict.byEmail, byId, rowLabel)} — two different people. Nothing is written until you choose.`,
        matchId: null, matchName: null, matchedBy: null, duplicateOfLine: null, include: false,
      })
      return
    }

    if (match && match.confident) {
      const isRow = match.customer.id.startsWith('row:')
      const dupLine = isRow ? Number(match.customer.id.slice(4)) : null
      out.push({
        line, values, warnings, status: 'existing',
        reason: isRow
          ? `Same ${match.reason} as row ${dupLine} in this file — importing once.`
          : `Already in EdgeQuote as "${match.customer.name}" (same ${match.reason}) — leaving that record untouched.`,
        matchId: isRow ? null : match.customer.id,
        matchName: match.customer.name,
        matchedBy: match.reason,
        duplicateOfLine: dupLine,
        include: false,
      })
      return
    }

    if (match) {
      // Name-only. Two people genuinely share a name, so this never auto-merges
      // and never auto-creates: it asks. Defaulting to OFF is what makes a
      // second upload of a name-only sheet write nothing.
      const isRow = match.customer.id.startsWith('row:')
      out.push({
        line, values, warnings, status: 'review',
        reason: isRow
          ? `Same name as row ${Number(match.customer.id.slice(4))} in this file, and nothing else to tell them apart.`
          : `"${match.customer.name}" is already in EdgeQuote with the same name, but no phone, email or address confirms it is the same person.`,
        matchId: isRow ? null : match.customer.id,
        matchName: match.customer.name,
        matchedBy: match.reason,
        duplicateOfLine: isRow ? Number(match.customer.id.slice(4)) : null,
        include: false,
      })
      return
    }

    candidates.push(asCandidate({
      id: ROW_ID(line), name: values.name, email: values.email,
      phone: values.phone, address: values.address,
    }))
    rowLabel.set(ROW_ID(line), values.name)
    out.push({
      line, values, warnings, status: 'new',
      reason: 'New customer.',
      matchId: null, matchName: null, matchedBy: null, duplicateOfLine: null, include: true,
    })
  })
  return out
}

function nameOf(id: string, byId: Map<string, Customer>, rowLabel: Map<string, string>): string {
  if (id.startsWith('row:')) return `"${rowLabel.get(id) ?? 'an earlier row'}" (row ${id.slice(4)})`
  return `"${byId.get(id)?.name ?? 'another customer'}"`
}

/** Phone and email each landing on a DIFFERENT record. Uses the same primitives
 *  findCustomerMatch uses (phoneMatches via normalizePhone semantics, and
 *  normalizeEmail), so there is one identity rule asked two questions. */
function findConflict(
  candidates: Customer[], v: ImportRowValues,
): { byPhone: string; byEmail: string } | null {
  if (!v.phone || !v.email) return null
  const email = normalizeEmail(v.email)
  const byPhone = candidates.find(c => phoneSame(c.phone, v.phone))
  const byEmail = candidates.find(c => normalizeEmail(c.email) === email)
  if (!byPhone || !byEmail) return null
  return byPhone.id === byEmail.id ? null : { byPhone: byPhone.id, byEmail: byEmail.id }
}


export interface PlanTotals {
  detected: number
  toCreate: number
  existing: number
  review: number
  invalid: number
  withAddress: number
  warnings: number
  /** Opt-ins among the rows that will actually be written — the number the SMS
   *  acknowledgement is about. Counting rows that are not being imported would
   *  demand consent for people nobody is creating. */
  smsOptIns: number
  emailOptIns: number
}

/** Recomputed whenever the owner toggles a review row — the button's number and
 *  the loop's length come from the same place. */
export function summarize(rows: PlannedRow[]): PlanTotals {
  return {
    detected: rows.length,
    toCreate: rows.filter(willWrite).length,
    existing: rows.filter(r => r.status === 'existing').length,
    review: rows.filter(r => r.status === 'review').length,
    invalid: rows.filter(r => r.status === 'invalid').length,
    withAddress: rows.filter(r => willWrite(r) && !!r.values.address).length,
    warnings: rows.filter(r => r.warnings.length > 0).length,
    smsOptIns: rows.filter(r => willWrite(r) && r.values.sms_opt_in).length,
    emailOptIns: rows.filter(r => willWrite(r) && r.values.email_opt_in).length,
  }
}

/** THE predicate for "this row becomes a customer". Every count, every preview
 *  line and the write loop itself call this one function. */
export function willWrite(r: PlannedRow): boolean {
  return r.include && (r.status === 'new' || r.status === 'review')
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface RowFailure { line: number; name: string; error: string }

export interface ImportOutcome {
  attempted: number
  created: number
  failed: RowFailure[]
  skippedExisting: number
  skippedInvalid: number
  skippedForReview: number
  propertiesCreated: number
  propertyFailures: RowFailure[]
  /** Provenance row id, or null with `runError` — logging can fail without the
   *  import being a lie, but it is never claimed to have happened. */
  runId: string | null
  runError?: string
  consentError?: string
}

const CHUNK = 50

/**
 * Execute an approved plan.
 *
 * Honesty rules this obeys, each of them a bug this codebase has already paid
 * for once:
 *
 *  • **Counted from what came BACK.** Every insert asks for `.select('id')` and
 *    the count is the returned rows, never the rows sent. supabase-js resolves
 *    on failure, so "we sent 300" is not evidence that 300 exist.
 *  • **A failed chunk is retried row by row.** Postgres fails a multi-row insert
 *    whole, so one bad row would otherwise take 49 good ones with it and the
 *    owner would never learn which. The retry pins the blame on a line number.
 *  • **Ids are minted client-side.** RETURNING order is not guaranteed, and the
 *    row→property pairing depends on it; a reorder would attach every address
 *    to the wrong customer.
 *  • **The tenant comes from the session, never the file.** `user_id` is not a
 *    mappable field, and `customers`/`properties` both carry RLS
 *    `with check (auth.uid() = user_id)` — so the DATABASE, not this function,
 *    is what makes a cross-tenant write impossible.
 */
export async function executeImportPlan(
  supabase: Supa,
  opts: {
    userId: string; initiatedBy: string; sourceName?: string | null; rows: PlannedRow[]
    /** Applied ONLY to rows whose CSV carried no source of their own — a row's
     *  own column always wins, and no default means "Not recorded", which is
     *  the truth when nobody knows. */
    defaultSource?: string | null
  },
): Promise<ImportOutcome> {
  const { userId, initiatedBy, rows } = opts
  const fallbackSource = sanitizeSourceInput(opts.defaultSource)
  const targets = rows.filter(willWrite)

  const out: ImportOutcome = {
    attempted: targets.length,
    created: 0,
    failed: [],
    skippedExisting: rows.filter(r => r.status === 'existing').length,
    skippedInvalid: rows.filter(r => r.status === 'invalid').length,
    skippedForReview: rows.filter(r => r.status === 'review' && !r.include).length,
    propertiesCreated: 0,
    propertyFailures: [],
    runId: null,
  }

  // The customer row carries the RELATIONSHIP only. The address goes to the
  // property below and ONLY there (Customer V2; customers.address survives as a
  // legacy column until M4 and nothing new writes it).
  const payload = (r: PlannedRow, id: string) => ({
    id,
    user_id: userId,
    name: r.values.name,
    email: r.values.email,
    phone: r.values.phone,
    notes: r.values.notes,
    acquisition_source: r.values.source ?? fallbackSource,
    sms_opt_in: r.values.sms_opt_in,
    email_opt_in: r.values.email_opt_in,
  })

  const landed: { row: PlannedRow; id: string }[] = []

  for (let i = 0; i < targets.length; i += CHUNK) {
    const slice = targets.slice(i, i + CHUNK)
    const minted = slice.map(r => ({ row: r, id: crypto.randomUUID() }))
    const { data, error } = await supabase.from('customers')
      .insert(minted.map(m => payload(m.row, m.id))).select('id')

    const backIds = new Set(((data as { id: string }[] | null) ?? []).map(d => d.id))
    if (!error && minted.every(m => backIds.has(m.id))) {
      landed.push(...minted)
      continue
    }

    // Something in this chunk did not land. Find out exactly what, one row at a
    // time, so the report names lines instead of a range.
    for (const m of minted) {
      if (backIds.has(m.id)) { landed.push(m); continue }
      const retryId = crypto.randomUUID()
      const { data: one, error: oneErr } = await supabase.from('customers')
        .insert(payload(m.row, retryId)).select('id')
      const ok = !oneErr && ((one as { id: string }[] | null) ?? []).length === 1
      if (ok) landed.push({ row: m.row, id: retryId })
      else out.failed.push({
        line: m.row.line, name: m.row.values.name,
        error: oneErr?.message || error?.message || 'The database did not confirm this row was saved.',
      })
    }
  }
  out.created = landed.length

  // One primary property per created customer that brought a street address.
  // `ensurePropertyForCustomer` is THE find-or-create for addresses, and it is
  // correctly absent here: these customers were created moments ago and
  // provably own zero properties, so there is nothing to find. A row matching
  // an EXISTING customer is skipped entirely in V1 and never reaches this loop,
  // which is what keeps that rule intact rather than bypassed.
  const withAddress = landed.filter(l => !!l.row.values.address)
  for (let i = 0; i < withAddress.length; i += CHUNK) {
    const slice = withAddress.slice(i, i + CHUNK)
    const propRows = slice.map(l => ({
      customer_id: l.id,
      user_id: userId,
      address: l.row.values.address as string,
      city: l.row.values.city,
      province: l.row.values.province,
      postal_code: l.row.values.postal_code,
      is_primary: true,
    }))
    const { data, error } = await supabase.from('properties').insert(propRows).select('id')
    const n = ((data as { id: string }[] | null) ?? []).length
    if (!error && n === slice.length) { out.propertiesCreated += n; continue }
    for (const l of slice) {
      const { data: one, error: oneErr } = await supabase.from('properties').insert({
        customer_id: l.id, user_id: userId, address: l.row.values.address as string,
        city: l.row.values.city, province: l.row.values.province,
        postal_code: l.row.values.postal_code, is_primary: true,
      }).select('id')
      if (!oneErr && ((one as { id: string }[] | null) ?? []).length === 1) out.propertiesCreated++
      else out.propertyFailures.push({
        line: l.row.line, name: l.row.values.name,
        error: oneErr?.message || error?.message || 'The address could not be saved.',
      })
    }
  }

  // Every imported opt-in gets an audit row, paired by the SAME minted ids so
  // the consent trail cannot drift onto the wrong customer. An import never
  // opts anyone in by itself: these values are false unless a mapped column
  // said otherwise, and the page requires the owner to acknowledge the SMS
  // rules before a single true one can be written.
  try {
    await recordImportConsent(supabase, {
      userId, changedBy: initiatedBy,
      rows: landed.map(l => ({
        customerId: l.id, sms: l.row.values.sms_opt_in, email: l.row.values.email_opt_in,
      })),
    })
  } catch (e) {
    out.consentError = e instanceof Error ? e.message : 'Consent audit could not be written.'
  }

  const { data: run, error: runErr } = await supabase.from('customer_imports').insert({
    user_id: userId,
    initiated_by: initiatedBy.slice(0, 200),
    source_name: (opts.sourceName || 'Pasted CSV').slice(0, 200),
    rows_detected: rows.length,
    customers_created: out.created,
    rows_skipped_existing: out.skippedExisting,
    rows_failed: out.failed.length,
    properties_created: out.propertiesCreated,
  }).select('id').single()
  if (runErr || !run) out.runError = runErr?.message || 'The import record could not be written.'
  else out.runId = (run as { id: string }).id

  return out
}

// ── Reporting ────────────────────────────────────────────────────────────────

/** Every row that did NOT become a customer, in the shape of the original file
 *  plus a reason — so the owner can fix it and re-upload just that. Rendered
 *  through lib/csv's `toCsv`, which neutralizes leading `= + - @` so a cell
 *  reading "=cmd|..." cannot execute when the report is opened in Excel. */
export function unimportedRows(rows: PlannedRow[], outcome?: ImportOutcome): {
  line: number; name: string; email: string; phone: string; address: string
  city: string; province: string; postal_code: string; notes: string
  source: string; sms_opt_in: string; email_opt_in: string; outcome: string
}[] {
  const failedByLine = new Map((outcome?.failed ?? []).map(f => [f.line, f.error]))
  return rows
    .filter(r => failedByLine.has(r.line) || !willWrite(r))
    .map(r => ({
      line: r.line,
      name: r.values.name,
      email: r.values.email ?? '',
      phone: r.values.phone ?? '',
      address: r.values.address ?? '',
      city: r.values.city ?? '',
      province: r.values.province ?? '',
      postal_code: r.values.postal_code ?? '',
      notes: r.values.notes ?? '',
      source: r.values.source ?? '',
      // Round-trippable: the fixed row can be re-uploaded and read back the same
      // way, rather than losing its consent on the way out and back.
      sms_opt_in: r.values.sms_opt_in ? 'true' : 'false',
      email_opt_in: r.values.email_opt_in ? 'true' : 'false',
      outcome: failedByLine.has(r.line)
        ? `Failed to save: ${failedByLine.get(r.line)}`
        : [r.reason, ...r.warnings].join(' '),
    }))
}
