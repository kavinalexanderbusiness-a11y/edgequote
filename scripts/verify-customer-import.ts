// ── Customer CSV import — the contract, executable (npm run verify:customer-import) ──
//
// A migration tool is trusted exactly once: the day a business moves its whole
// book in. Every assertion here is a way that day can go wrong.
//
// The engine (src/lib/customerImport.ts) is pure on purpose, so this harness
// runs the REAL functions on real CSV text — not a re-description of them. The
// write path is exercised against a fake supabase client that can be told to
// fail, because "what happens when row 214 fails" is the question the owner
// most needs answered honestly and the one no manual test reaches.

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseCsv, suggestMapping, planImport, summarize, willWrite, readRow,
  unimportedRows, mappingNamesSomeone, executeImportPlan, IMPORT_LIMITS, EMPTY_MAPPING,
  type ColumnMapping, type PlannedRow, type ImportRowValues,
} from '../src/lib/customerImport'
import type { Customer } from '../src/types'
import type { AddressCarrier } from '../src/lib/customers'

let pass = 0
let fail = 0
function H(title: string) { console.log(`\n═══ ${title} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}
function ok(name: string, cond: boolean) { check(name, cond, true) }

const SRC = join(__dirname, '..', 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

type Book = Customer & AddressCarrier
const cust = (o: Partial<Book> & { id: string; name: string }): Book => ({
  email: null, phone: null, address: null, city: null, province: null, postal_code: null,
  notes: null, tags: [], acquisition_source: null, referred_by_customer_id: null,
  preferred_days: null, avoid_days: null, pref_time_start: null, pref_time_end: null,
  sms_opt_in: false, email_opt_in: false, created_at: '', updated_at: '', properties: null,
  ...o,
} as Book)

/** A row's values with everything defaulted — the write-path fixtures below
 *  only care about a field or two each, and a literal per fixture rots the
 *  moment ImportRowValues grows. */
const vals = (o: Partial<ImportRowValues> & { name: string }): ImportRowValues => ({
  email: null, phone: null, address: null, city: null, province: null,
  postal_code: null, notes: null, source: null, sms_opt_in: false, email_opt_in: false,
  ...o,
})

/** Parse + map + plan in one call, the way the page does it. */
function plan(csv: string, existing: Book[] = [], override?: Partial<ColumnMapping>): PlannedRow[] {
  const parsed = parseCsv(csv)
  if (parsed.error) return []
  const mapping = { ...suggestMapping(parsed.headers), ...override }
  return planImport({ parsed, mapping, existing })
}

// ═══════════════════════════════════════════════════════════════════════════
H('1. VALID IMPORT — a plain spreadsheet lands as customers')
{
  const rows = plan('Name,Email,Phone,Street,City,Postal Code\nJane Doe,jane@example.com,403-555-0100,84 17 St NW,Calgary,T2M 0M1')
  check('one row, classified new', rows.map(r => r.status), ['new'])
  check('name read', rows[0].values.name, 'Jane Doe')
  check('email lowercased', rows[0].values.email, 'jane@example.com')
  check('phone kept as written', rows[0].values.phone, '403-555-0100')
  check('street on the row', rows[0].values.address, '84 17 St NW')
  check('postal read from "Postal Code"', rows[0].values.postal_code, 'T2M 0M1')
  ok('a new row is included by default', rows[0].include)
  check('summary counts it once', summarize(rows).toCreate, 1)
}

// ═══════════════════════════════════════════════════════════════════════════
H('2. HEADER MAPPING — real exports, no bespoke integration')
{
  // First + Last with no full-name column (Jobber / Housecall Pro shape).
  const p = parseCsv('First Name,Last Name,Mobile Phone,Email Address,Address Line 1,State,ZIP\nSam,Reed,4035550111,SAM@Example.com,12 Elm Ave,AB,T1X 1X1')
  const m = suggestMapping(p.headers)
  check('First Name → first_name', m.first_name, 0)
  check('Last Name → last_name', m.last_name, 1)
  check('no full-name column is invented', m.name, null)
  check('Mobile Phone → phone', m.phone, 2)
  // ⭐ "Email Address" contains the word "address"; it must never win the street
  // column, or every import silently files an email as a service location.
  check('Email Address → email, NOT address', m.email, 3)
  check('Address Line 1 → address', m.address, 4)
  check('State → province', m.province, 5)
  check('ZIP → postal_code', m.postal_code, 6)
  const rows = planImport({ parsed: p, mapping: m, existing: [] })
  check('first + last become one name', rows[0].values.name, 'Sam Reed')
  check('email normalized', rows[0].values.email, 'sam@example.com')
}
{
  const m = suggestMapping(['Customer Name', 'Primary Phone', 'Service Address', 'Town', 'Province/State', 'Notes'])
  check('Customer Name → name', m.name, 0)
  check('Primary Phone → phone', m.phone, 1)
  check('Service Address → address', m.address, 2)
  check('Town → city', m.city, 3)
  check('Province/State → province', m.province, 4)
  check('Notes → notes', m.notes, 5)
}
{
  // Both a full name AND a first/last pair present: the full name takes the
  // name slot and the pair keeps its own, so nothing is dropped or doubled.
  const m = suggestMapping(['Name', 'First Name', 'Last Name'])
  check('Name → name', m.name, 0)
  check('First Name keeps its own slot', m.first_name, 1)
  check('Last Name keeps its own slot', m.last_name, 2)
}
{
  // ⭐ With no street column present at all, "Email Address" is the only thing
  // ADDRESS could grab — and grabbing it would file an email as a service
  // location. The earlier case passed only because a real street column
  // outbid it, so this is the one that actually pins the rule.
  const m = suggestMapping(['Name', 'Email Address'])
  check('Email Address → email', m.email, 1)
  check('and address stays unmapped rather than taking it', m.address, null)
  const m2 = suggestMapping(['Name', 'Website Address'])
  check('a website column is not a service address either', m2.address, null)
}
check('unrecognised headers map to nothing rather than guessing',
  suggestMapping(['col_a', 'col_b']), EMPTY_MAPPING)
ok('a sheet with no name column is refused a preview', !mappingNamesSomeone(suggestMapping(['Phone', 'Email'])))

// ═══════════════════════════════════════════════════════════════════════════
H('3. PHONE-ONLY and EMAIL-ONLY rows')
{
  const rows = plan('Name,Phone\nPhone Only,403-555-0199')
  check('phone-only imports', rows.map(r => r.status), ['new'])
  check('no email invented', rows[0].values.email, null)
}
{
  const rows = plan('Name,Email\nEmail Only,e@example.com')
  check('email-only imports', rows.map(r => r.status), ['new'])
  check('no phone invented', rows[0].values.phone, null)
}
{
  const rows = plan('Name\nName Only')
  check('name-only is importable', rows.map(r => r.status), ['new'])
  check('no address row will be created for it', summarize(rows).withAddress, 0)
}

// ═══════════════════════════════════════════════════════════════════════════
H('4. DUPLICATE — phone formatting must not fork a person')
{
  const book = [cust({ id: 'c1', name: 'Dana Ray', phone: '+1 (403) 555-0100' })]
  const rows = plan('Name,Phone\nDana Ray,4035550100', book)
  check('differently-formatted same number → existing, not new', rows[0].status, 'existing')
  check('matched by phone', rows[0].matchedBy, 'phone')
  check('points at the customer already here', rows[0].matchId, 'c1')
  ok('and is NOT written', !willWrite(rows[0]))
  // The include flag is OFF for an existing row, which would mask a broken
  // status check. Force it on: the STATUS alone must keep a known duplicate out.
  ok('and stays out even if the include flag were flipped on',
    !willWrite({ ...rows[0], include: true }))
}
{
  // The last-ten rule, the app half of resolve_intake_customer (BK-1).
  const book = [cust({ id: 'c1', name: 'Dana Ray', phone: '4035550100' })]
  check('a "1-403…" variant is the same person',
    plan('Name,Phone\nDana Ray,1-403-555-0100', book)[0].status, 'existing')
  check('a genuinely different number is a new person',
    plan('Name,Phone\nOther Person,4035550101', book)[0].status, 'new')
}

// ═══════════════════════════════════════════════════════════════════════════
H('5. DUPLICATE — email, case-insensitively')
{
  const book = [cust({ id: 'c2', name: 'Sam Reed', email: 'sam@example.com' })]
  const rows = plan('Name,Email\nSamuel Reed,SAM@EXAMPLE.COM', book)
  check('different name, same email → existing', rows[0].status, 'existing')
  check('matched by email', rows[0].matchedBy, 'email')
}

// ═══════════════════════════════════════════════════════════════════════════
H('6. DUPLICATE — address, read through the Customer V2 resolver')
{
  // ⭐ This customer has NO legacy customers.address — their address of record is
  // the primary property. Matching the raw column would call them new and
  // re-import the entire post-V2 book on the second upload.
  const book = [cust({
    id: 'c3', name: 'Ada Park', address: null,
    properties: [{ address: '84 17 St NW', city: 'Calgary', is_primary: true }],
  })]
  const rows = plan('Name,Street\nA. Park,84 17 Street Northwest', book)
  check('property address matches, token-normalized (St NW == Street Northwest)', rows[0].status, 'existing')
  check('matched by address', rows[0].matchedBy, 'address')
}

// ═══════════════════════════════════════════════════════════════════════════
H('7. AMBIGUOUS — two identifiers pointing at two people')
{
  const book = [
    cust({ id: 'cA', name: 'Alex A', phone: '4035550100' }),
    cust({ id: 'cB', name: 'Bree B', email: 'bree@example.com' }),
  ]
  const rows = plan('Name,Phone,Email\nSomeone,4035550100,bree@example.com', book)
  check('conflicting identity → needs review, never a silent merge', rows[0].status, 'review')
  ok('and is OFF by default, so a careless import writes nothing', !rows[0].include)
  ok('the reason names both people', rows[0].reason.includes('Alex A') && rows[0].reason.includes('Bree B'))
  check('it is not counted as something that will be added', summarize(rows).toCreate, 0)
}
{
  // A name-only collision is ambiguous too — two people really do share a name.
  const book = [cust({ id: 'cN', name: 'John Smith' })]
  const rows = plan('Name,Phone\nJohn Smith,4035559999', book)
  check('same name, no confirming identifier → review', rows[0].status, 'review')
  check('reason states there is no confirmation', rows[0].matchedBy, 'name')
  ok('off by default', !rows[0].include)
}
{
  // ...and once the owner opts in, it is written as a NEW customer, not merged.
  const book = [cust({ id: 'cN', name: 'John Smith' })]
  const rows = plan('Name\nJohn Smith', book).map(r => ({ ...r, include: true }))
  ok('an opted-in review row becomes a write', willWrite(rows[0]))
  check('and it is counted', summarize(rows).toCreate, 1)
}

// ═══════════════════════════════════════════════════════════════════════════
H('8. BAD ROWS — refused with a reason, never silently dropped')
{
  const rows = plan('Name,Email,Phone\n,nobody@example.com,4035550001\nReal Person,ok@example.com,4035550002')
  check('the nameless row is kept and marked invalid', rows.map(r => r.status), ['invalid', 'new'])
  ok('it states why', rows[0].reason.toLowerCase().includes('no name'))
  ok('it is never written', !willWrite(rows[0]))
  check('the good row still imports', summarize(rows).toCreate, 1)
}
{
  const rows = plan('Name,Email\nJunk Email,not-an-email')
  check('a junk email is dropped, not stored', rows[0].values.email, null)
  check('the row still imports', rows[0].status, 'new')
  ok('and the owner is told', rows[0].warnings.some(w => w.includes('doesn’t look like an address') || w.includes("doesn't look like an address")))
}
{
  const rows = plan('Name,Phone\nShort Phone,12')
  ok('a too-short phone is flagged', rows[0].warnings.some(w => w.includes('too short')))
  check('but kept as the source had it', rows[0].values.phone, '12')
}
{
  const rows = plan('Name,Phone\nNo Digits,n/a')
  check('a phone with no digits at all is dropped', rows[0].values.phone, null)
}

// ═══════════════════════════════════════════════════════════════════════════
H('9. IDEMPOTENCE — the same file twice')
{
  const csv = 'Name,Email,Phone,Street\nJane Doe,jane@example.com,403-555-0100,84 17 St NW\nSam Reed,sam@example.com,403-555-0111,12 Elm Ave'
  const first = plan(csv, [])
  check('run 1 creates both', summarize(first).toCreate, 2)

  // The book as it stands after run 1, in the shape the page loads it.
  const afterRun1: Book[] = first.filter(willWrite).map((r, i) => cust({
    id: `new${i}`, name: r.values.name, email: r.values.email, phone: r.values.phone,
    address: null,
    properties: r.values.address ? [{ address: r.values.address, city: r.values.city, is_primary: true }] : null,
  }))
  const second = plan(csv, afterRun1)
  check('run 2 writes NOTHING', summarize(second).toCreate, 0)
  check('and says both are already here', second.map(r => r.status), ['existing', 'existing'])
}
{
  // Same people, but the second file formats everything differently — the case
  // that separates real matching from string equality.
  const book = [cust({ id: 'c1', name: 'Jane Doe', email: 'jane@example.com', phone: '4035550100' })]
  const rows = plan('Customer Name,Email Address,Primary Phone\nJANE DOE,Jane@Example.COM,+1 (403) 555-0100', book)
  check('reformatted re-upload still writes nothing', summarize(rows).toCreate, 0)
}

// ═══════════════════════════════════════════════════════════════════════════
H('10. DUPLICATES INSIDE ONE FILE')
{
  const rows = plan('Name,Phone\nDana Ray,403-555-0100\nDana Ray,(403) 555-0100\nOther,4035550200')
  check('the second spelling folds into the first', rows.map(r => r.status), ['new', 'existing', 'new'])
  check('it names the row it duplicates', rows[1].duplicateOfLine, 2)
  check('only two customers are created', summarize(rows).toCreate, 2)
}

// ═══════════════════════════════════════════════════════════════════════════
H('11. ZERO-ROW and HEADER-ONLY files')
{
  check('an empty file is refused with a sentence', parseCsv('').error, 'That file has no rows in it.')
  check('whitespace only is refused too', parseCsv('\n\n  \n').error, 'That file has no rows in it.')
  const headerOnly = parseCsv('Name,Email,Phone')
  check('a header-only file is refused, and says so',
    headerOnly.error, 'That file has a header row but no customers under it.')
  check('its headers were still read (so the message is not a parse failure)', headerOnly.headers.length, 3)
  check('planning a refused file yields no rows', plan('Name,Email,Phone').length, 0)
}

// ═══════════════════════════════════════════════════════════════════════════
H('12. HOSTILE AND OVERSIZED INPUT')
{
  // Formula injection travels in a NAME and detonates in the error export.
  const rows = plan('Name,Notes\n=cmd|\' /C calc\'!A0,+1+1')
  check('a formula-shaped name is stored verbatim (it is only text here)', rows[0].values.name, '=cmd|\' /C calc\'!A0')
  const csvOut = unimportedRows(rows.map(r => ({ ...r, include: false })))
  ok('and it reaches the export as data', csvOut[0].name.startsWith('='))
  // The neutralizing happens in lib/csv's toCsv — pinned here so the importer
  // can never be re-wired to a hand-rolled serializer that skips it.
  const page = read('app/dashboard/customers/import/page.tsx')
  ok('the error export goes through lib/csv (which neutralizes = + - @)',
    page.includes("from '@/lib/csv'") && page.includes('exportRowsToCsv'))
}
{
  // Built from escapes, not pasted: a harness carrying the very bytes it
  // rejects is one careless editor save away from testing nothing.
  const NUL = '\u0000', UNIT_SEP = '\u001F', LINE_SEP = '\u2028', RTL_OVERRIDE = '\u202E'
  const nasty = `Name,Notes\n"Bad${NUL}${UNIT_SEP} Name","line${LINE_SEP}break${RTL_OVERRIDE}evil"`
  const rows = plan(nasty)
  check('control characters are stripped from the name', rows[0].values.name, 'Bad Name')
  ok('the note keeps its text', rows[0].values.notes!.includes('evil'))
  ok('the bidi override is gone', !rows[0].values.notes!.includes(RTL_OVERRIDE))
  ok('the line separator is gone', !rows[0].values.notes!.includes(LINE_SEP))
  ok('the NUL byte never reaches a value', !JSON.stringify(rows[0].values).includes(NUL))
}
{
  const long = 'x'.repeat(9000)
  const rows = plan(`Name,Notes\n${long},${long}`)
  check('an oversized name is capped', rows[0].values.name.length, IMPORT_LIMITS.name)
  check('an oversized note is capped', rows[0].values.notes!.length, IMPORT_LIMITS.notes)
  ok('and the shortening is disclosed', rows[0].warnings.some(w => w.includes('shortened')))
}
{
  const many = ['Name', ...Array.from({ length: IMPORT_LIMITS.maxRows + 25 }, (_, i) => `Person ${i}`)].join('\n')
  const p = parseCsv(many)
  check('the row ceiling holds', p.rows.length, IMPORT_LIMITS.maxRows)
  check('and the overflow is REPORTED, not swallowed', p.truncated.rows, 25)
}
{
  const wide = parseCsv(Array.from({ length: IMPORT_LIMITS.maxColumns + 5 }, (_, i) => `c${i}`).join(',') + '\nx')
  check('the column ceiling holds', wide.headers.length, IMPORT_LIMITS.maxColumns)
  check('and is reported', wide.truncated.columns, 5)
}
{
  const p = parseCsv('x'.repeat(IMPORT_LIMITS.maxBytes + 10))
  ok('an oversized paste is cut and flagged', p.truncated.bytes === true)
}

// ═══════════════════════════════════════════════════════════════════════════
H('13. PARSING — quotes, commas, newlines, BOM, ragged rows')
{
  const p = parseCsv('﻿Name,Notes\r\n"Doe, Jane","He said ""hi""\nnext line"\r\nBob,plain\r\n')
  check('BOM does not corrupt the first header', p.headers[0], 'Name')
  check('a quoted comma stays inside the field', p.rows[0][0], 'Doe, Jane')
  check('a doubled quote unescapes and the embedded newline folds to a space',
    p.rows[0][1], 'He said "hi" next line')
  check('CRLF rows split correctly', p.rows[1], ['Bob', 'plain'])
  check('a trailing newline is not a customer', p.rows.length, 2)
}
{
  const p = parseCsv('Name,Email,Phone\nOnly Name\nA,b@example.com,1,EXTRA')
  check('a short row is padded, not dropped', p.rows[0], ['Only Name', '', ''])
  check('an over-long row is clipped to the header width', p.rows[1].length, 3)
}
{
  // Line numbers must survive quoted newlines, or "row 214" points at the wrong row.
  const p = parseCsv('Name\n"multi\nline"\nAfter')
  check('the row after an embedded newline reports its real source line', p.lines[1], 4)
}

// ═══════════════════════════════════════════════════════════════════════════
H('14. TENANCY — the file can never choose the business')
{
  const src = read('lib/customerImport.ts')
  const fields = src.slice(src.indexOf('export type ImportField ='), src.indexOf('export const IMPORT_FIELDS'))
  ok('user_id is not a mappable field', !fields.includes('user_id'))
  ok('id is not a mappable field', !/\bid\b/.test(fields.replace(/first_name|last_name|postal_code/g, '')))
  const payload = src.slice(src.indexOf('const payload = (r: PlannedRow'), src.indexOf('const landed'))
  ok('every customer row is stamped with the session user_id', payload.includes('user_id: userId'))
  ok('the id is minted, never taken from the row', src.includes('crypto.randomUUID()'))
  // The real guarantee is in the database, not here — pinned so a future
  // migration cannot quietly drop it.
  const schema = readFileSync(join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8')
  ok('customer_imports carries RLS', schema.includes('alter table public.customer_imports enable row level security'))
  ok('its insert policy is own-row only', schema.includes('"customer_imports: insert own" on public.customer_imports\n  for insert with check (auth.uid() = user_id)'))
  ok('anon holds no grant on the import audit', schema.includes('revoke all on public.customer_imports from anon'))
  ok('the audit has NO update policy (append-only)', !schema.includes('"customer_imports: update'))
  ok('the audit has NO delete policy (append-only)', !schema.includes('"customer_imports: delete'))
}

// ═══════════════════════════════════════════════════════════════════════════
H('15. NO SECOND MATCHING ENGINE')
{
  const src = read('lib/customerImport.ts')
  ok('identity comes from findCustomerMatch', src.includes('findCustomerMatch'))
  ok('the V2 address resolver is what matching sees', src.includes('displayAddress(c).address'))
  // A local re-implementation of the identity rule is the failure this codebase
  // keeps paying for. These names may only ever be IMPORTED here.
  for (const fn of ['phoneMatches', 'normalizeEmail', 'normalizePhone', 'displayAddress']) {
    ok(`${fn} is imported, not redefined`, !new RegExp(`function ${fn}\\s*\\(`).test(src))
  }
  ok('no hand-rolled digit-stripping beside normalizePhone', !src.includes("replace(/\\D/g, '')"))
}

// ═══════════════════════════════════════════════════════════════════════════
async function partialFailureChecks() {
H('16. PARTIAL FAILURE — the count is what came back')
//
// A fake supabase whose customers.insert fails for a named row. The chunk
// insert fails whole (as Postgres does), and the retry must pin the blame on
// exactly that row while every other row still lands.
{
  interface Ins { table: string; rows: Record<string, unknown>[] }
  const made: Ins[] = []
  const fake = (failFor: (r: Record<string, unknown>) => boolean, opts?: { propsFail?: boolean; runFail?: boolean }) => ({
    from(table: string) {
      return {
        insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
          const rows = Array.isArray(payload) ? payload : [payload]
          const bad = table === 'customers' && rows.some(failFor)
          const propBad = table === 'properties' && !!opts?.propsFail
          const runBad = table === 'customer_imports' && !!opts?.runFail
          const result = bad || propBad || runBad
            ? { data: null, error: { message: bad ? 'value too long for type character varying' : 'insert failed' } }
            : { data: rows.map((r, i) => ({ id: (r.id as string) || `srv${i}` })), error: null }
          if (!result.error) made.push({ table, rows })
          return {
            select: () => Object.assign(Promise.resolve(result), {
              single: () => Promise.resolve(result.error ? result : { data: { id: 'run1' }, error: null }),
            }),
          }
        },
      }
    },
  })

  const rows: PlannedRow[] = ['Good One', 'BOOM', 'Good Two'].map((name, i) => ({
    line: i + 2,
    values: vals({ name, address: i === 0 ? '84 17 St NW' : null }),
    status: 'new', reason: 'New customer.', warnings: [], matchId: null, matchName: null,
    matchedBy: null, duplicateOfLine: null, include: true,
  }))

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const out = await executeImportPlan(fake(r => r.name === 'BOOM') as any, {
    userId: 'u1', initiatedBy: 'owner@example.com', sourceName: 'book.csv', rows,
  })
  check('the two good rows are created', out.created, 2)
  check('the bad row is reported, by line', out.failed.map(f => f.line), [3])
  check('with the database\'s own words', out.failed[0].error, 'value too long for type character varying')
  check('attempted still reflects the whole batch', out.attempted, 3)
  ok('the created count never exceeds what came back', out.created <= out.attempted)
  check('the address of a surviving row is still written', out.propertiesCreated, 1)
  check('the run is recorded', out.runId, 'run1')

  const leftovers = unimportedRows(rows, out)
  check('the failed row is downloadable', leftovers.map(l => l.line), [3])
  ok('with what happened to it', leftovers[0].outcome.includes('Failed to save'))
}
{
  // An import whose customers all land but whose ADDRESSES fail: the customers
  // are real and must be reported as real; the addresses must not be claimed.
  const fake = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
          const rows = Array.isArray(payload) ? payload : [payload]
          const bad = table === 'properties'
          const result = bad
            ? { data: null, error: { message: 'null value in column "address"' } }
            : { data: rows.map((r, i) => ({ id: (r.id as string) || `srv${i}` })), error: null }
          return {
            select: () => Object.assign(Promise.resolve(result), {
              single: () => Promise.resolve({ data: { id: 'run2' }, error: null }),
            }),
          }
        },
      }
    },
  }
  const rows: PlannedRow[] = [{
    line: 2,
    values: vals({ name: 'Has Address', address: '84 17 St NW', city: 'Calgary', province: 'AB' }),
    status: 'new', reason: 'New customer.', warnings: [], matchId: null, matchName: null,
    matchedBy: null, duplicateOfLine: null, include: true,
  }]
  const out = await executeImportPlan(fake as any, { userId: 'u1', initiatedBy: 'o@e.com', sourceName: null, rows })
  check('the customer is counted as created', out.created, 1)
  check('the address is NOT counted', out.propertiesCreated, 0)
  check('and the address failure is named', out.propertyFailures.map(f => f.line), [2])
}
{
  // Provenance failing must not turn a real import into a reported failure —
  // nor be claimed as written.
  const fake = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
          const rows = Array.isArray(payload) ? payload : [payload]
          const bad = table === 'customer_imports'
          const result = bad
            ? { data: null, error: { message: 'relation does not exist' } }
            : { data: rows.map((r, i) => ({ id: (r.id as string) || `srv${i}` })), error: null }
          return {
            select: () => Object.assign(Promise.resolve(result), { single: () => Promise.resolve(result) }),
          }
        },
      }
    },
  }
  const rows: PlannedRow[] = [{
    line: 2,
    values: vals({ name: 'Someone' }),
    status: 'new', reason: 'New customer.', warnings: [], matchId: null, matchName: null,
    matchedBy: null, duplicateOfLine: null, include: true,
  }]
  const out = await executeImportPlan(fake as any, { userId: 'u1', initiatedBy: 'o@e.com', sourceName: null, rows })
  check('the import still succeeded', out.created, 1)
  check('but the audit row is not claimed', out.runId, null)
  ok('and the gap is stated', !!out.runError)
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

}

// ═══════════════════════════════════════════════════════════════════════════
H('17. ONLY APPROVED ROWS ARE WRITTEN')
{
  const rows = plan('Name,Phone\nA,4035550001\nB,4035550002')
  const off = rows.map(r => ({ ...r, include: false }))
  check('nothing included → nothing to create', summarize(off).toCreate, 0)
  ok('willWrite is the single predicate', off.every(r => !willWrite(r)))
  const src = read('lib/customerImport.ts')
  const exec = src.slice(src.indexOf('export async function executeImportPlan'))
  ok('the write loop filters on willWrite, not on status', exec.includes('rows.filter(willWrite)'))
  ok('the count comes from what landed, not what was sent', exec.includes('out.created = landed.length'))
  ok('every insert asks the database what it actually stored', !exec.includes('.insert(') || exec.includes(".select('id')"))
}

// ═══════════════════════════════════════════════════════════════════════════
H('18. READ FAILURE IS NOT AN EMPTY BOOK')
{
  const page = read('app/dashboard/customers/import/page.tsx')
  ok('the book load is a discriminated state, not a bare array', page.includes("status: 'error'") && page.includes("status: 'ready'"))
  ok('a failed load blocks import rather than importing against nothing',
    page.includes("book.status === 'ready'"))
  ok('and explains why', page.toLowerCase().includes('duplicate your whole book'))
  ok('archived customers are matched against too', page.includes('archived') || page.includes('Archived'))
  // An empty TEXTAREA is a blank slate and should say nothing; an empty FILE is
  // an answer the owner is owed — they picked something and it had nothing in
  // it. Verified in the browser: uploading a 0-byte file shows "has no rows in
  // it", while an empty textarea stays quiet.
  ok('choosing a file always parses, so an empty one is reported rather than ignored',
    page.includes('fromFile = false') && page.includes('!text.trim() && !fromFile') && page.includes('f.name, true'))
}

// ═══════════════════════════════════════════════════════════════════════════
H('19. SCOPE — V1 imports customers and one address, nothing else')
{
  const src = read('lib/customerImport.ts')
  // Customer V2: the customer row is the RELATIONSHIP. An address on it would
  // resurrect the duplicate address model that displayAddress exists to end.
  const payload = src.slice(src.indexOf('const payload = (r: PlannedRow'), src.indexOf('const landed'))
  check('the customer payload carries no address fields',
    ['address', 'city', 'province', 'postal_code'].filter(f => payload.includes(f)), [])
  ok('the property insert is the only writer of an address',
    src.includes("from('properties').insert"))
}
{
  const src = read('lib/customerImport.ts')
  for (const t of ['invoices', 'payments', 'jobs', 'quotes', 'messages', 'stripe']) {
    ok(`no ${t} write path`, !src.includes(`from('${t}')`))
  }
  const tables = [...src.matchAll(/from\('([a-z_]+)'\)/g)].map(m => m[1])
  check('exactly three tables are written',
    [...new Set(tables)].sort(), ['customer_imports', 'customers', 'properties'])
  // Consent is carried, never invented: false unless a mapped column says
  // otherwise, and the page gates any true one behind an acknowledgement.
  ok('opt-ins come from the row, not from a literal',
    src.includes('sms: l.row.values.sms_opt_in') && src.includes('email: l.row.values.email_opt_in'))
  ok('every landed row is offered to the consent audit', src.includes('recordImportConsent'))
}

// ═══════════════════════════════════════════════════════════════════════════
H('19b. SOURCE and CONSENT — the columns main already imported')
{
  const rows = plan('Name,Phone,Source,SMS Opt In,Email Opt In\nSourced Person,4035550301,Facebook,yes,true')
  check('a source column is read', rows[0].values.source, 'Facebook')
  ok('an SMS opt-in is carried', rows[0].values.sms_opt_in)
  ok('an email opt-in is carried', rows[0].values.email_opt_in)
  check('and both are counted for the acknowledgement', [summarize(rows).smsOptIns, summarize(rows).emailOptIns], [1, 1])
}
{
  const m = suggestMapping(['Name', 'Lead Source', 'How did you hear'])
  check('Lead Source → source', m.source, 1)
}
{
  // Anything that is not an explicit yes is NOT consent — including blank,
  // "no", and a column nobody mapped.
  const rows = plan('Name,Phone,SMS Opt In\nA,4035550401,no\nB,4035550402,\nC,4035550403,maybe')
  check('no / blank / maybe are all refused', rows.map(r => r.values.sms_opt_in), [false, false, false])
  check('so nothing needs acknowledging', summarize(rows).smsOptIns, 0)
}
{
  // An opt-in on a row that will NOT be written must not demand consent for
  // someone nobody is creating.
  const book = [cust({ id: 'cX', name: 'Known', phone: '4035550500' })]
  const rows = plan('Name,Phone,SMS Opt In\nKnown,4035550500,yes', book)
  check('the row is a known duplicate', rows[0].status, 'existing')
  check('and its opt-in is not counted', summarize(rows).smsOptIns, 0)
}
{
  const src = read('lib/customerImport.ts')
  // attribution owns what a source string may be. Reused, not re-implemented,
  // so the importer and the public booking door cannot disagree.
  ok('the source string goes through attribution\u2019s own sanitizer',
    src.includes("from '@/lib/attribution'") && src.includes('sanitizeSourceInput(at(m.source))'))
  ok('a per-file default only fills rows with no source of their own',
    src.includes('r.values.source ?? fallbackSource'))
  const page = read('app/dashboard/customers/import/page.tsx')
  ok('the SMS acknowledgement gates the import button',
    page.includes('smsBlocked') && page.includes('SMS_CONSENT_WARNING'))
  ok('the default-source control offers the canonical list',
    page.includes('ACQUISITION_SOURCES'))
}

// ═══════════════════════════════════════════════════════════════════════════
H('20. readRow — mapping an unmapped column reads nothing')
{
  const m: ColumnMapping = { ...EMPTY_MAPPING, name: 0 }
  const { values } = readRow(['Solo', 'ignored@example.com', '4035550100'], m)
  check('name read', values.name, 'Solo')
  check('unmapped email stays null', values.email, null)
  check('unmapped phone stays null', values.phone, null)
  check('unmapped address stays null', values.address, null)
}

partialFailureChecks()
  .then(() => {
    console.log(`\n${fail === 0 ? '✅' : '❌'} customer-import: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
  })
  .catch(e => {
    console.error('\n❌ customer-import: the harness threw before finishing:', e)
    process.exit(1)
  })
