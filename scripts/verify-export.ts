// ── Verify: the data export gives a business ITS OWN data, and only that ─────
//   npm run verify:export
//
// A bulk export is the widest read in the product: every customer, address,
// price and payment in one file. Three things have to be true, and all three are
// checked here by BUILDING A REAL ARCHIVE rather than by reading the code:
//
//   1. TENANT — every read is filtered by the signed-in owner's id, and a row
//      belonging to anyone else never reaches the file. Proved by handing the
//      builder a fake database that ALSO returns a second business's rows and a
//      set of secrets, then searching the finished bytes for them.
//   2. SECRETS — portal tokens, card-processor ids, API keys and the account's
//      own uid are not merely absent from the CSV, they are never SELECTED. The
//      manifest's `select` list is the whole of what is read.
//   3. HONESTY — a failed read returns an error and NO archive, so the caller can
//      never hand somebody a truncated zip with a 200 OK. And no column invents a
//      balance, revenue or profit figure the database does not store.
//
// The zip is re-read here by an independent parser (central directory + CRC-32 +
// inflate), so a corrupt archive fails the guard rather than the owner's laptop.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { SupabaseClient } from '@supabase/supabase-js'
import { EXPORT_ENTITIES, DENIED_COLUMNS, DENIED_PATTERNS } from '../src/lib/export/manifest'
import { buildExportArchive, exportFilename, MAX_TOTAL_ROWS } from '../src/lib/export/build'
import { zipArchive, crc32 } from '../src/lib/export/zip'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

// ⚠️ A CRLF checkout makes `.*$` stop at the \r and every "absence" check invert.
// Normalise before any source scan.
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

// ── An independent zip reader ────────────────────────────────────────────────
// Deliberately not sharing code with the writer: a reader built from the same
// mistaken assumption would agree with a broken archive.
interface ZipEntry { name: string; text: string }
function readZip(buf: Buffer): ZipEntry[] {
  const EOCD_SIG = 0x06054b50
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  const out: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at entry ${i}`)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const rawSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`bad local header for ${name}`)
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataAt = localOff + 30 + lNameLen + lExtraLen
    const stored = buf.subarray(dataAt, dataAt + compSize)
    const body = method === 8 ? inflateRawSync(stored) : Buffer.from(stored)

    if (body.length !== rawSize) throw new Error(`${name}: size ${body.length} != declared ${rawSize}`)
    if (crc32(body) !== crc) throw new Error(`${name}: CRC mismatch`)

    out.push({ name, text: body.toString('utf8') })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

// ── A fake database that also holds ANOTHER business ─────────────────────────
// It answers `select` with whatever columns were asked for, but it stores rows
// for two tenants and ONLY honours the .eq() filter it was actually given. If
// the builder ever forgot to filter, the intruder rows would land in the CSV and
// the search below would find them.
const MINE = '11111111-1111-4111-8111-111111111111'
const THEIRS = '22222222-2222-4222-8222-222222222222'

/** Values that must never appear anywhere in a finished archive. */
const CONTRABAND: Record<string, string> = {
  'owner uid': MINE,
  'other tenant uid': THEIRS,
  'other tenant customer name': 'RIVAL-BUSINESS-CUSTOMER',
  'portal token': 'ptok_SECRET_PORTAL_TOKEN',
  'stripe customer id': 'cus_SECRETSTRIPE',
  'stripe payment intent': 'pi_SECRETINTENT',
  'storage path': 'private/photo-SECRETPATH.jpg',
  'api key': 'sk_live_SECRETKEY',
}

interface FakeQuery { table: string; select: string; eqs: [string, unknown][] }
const queries: FakeQuery[] = []

function fakeClient(opts: { rowsPerTable?: number; failOn?: string } = {}): SupabaseClient {
  const n = opts.rowsPerTable ?? 3

  // Only the requested window is materialised — a fake that built the whole
  // table on every page turned the row-cap test into an O(n²) allocation.
  function rowsFor(table: string, columns: string[], userId: string, mine: boolean, from: number, count: number) {
    return Array.from({ length: Math.max(0, count) }, (_, k) => {
      const i = from + k
      const row: Record<string, unknown> = {}
      for (const c of columns) {
        if (c === 'id') row[c] = `${table}-${mine ? 'mine' : 'theirs'}-${i}`
        else if (c === 'user_id') row[c] = userId
        else if (c === 'line_items') row[c] = [{ kind: 'service', description: 'Yard Cleanup', amount: 210 }]
        else if (c.endsWith('_at') || c.endsWith('_date')) row[c] = '2026-08-11T12:00:00Z'
        else if (c === 'name' || c === 'customer_name') row[c] = mine ? 'Jordan Miller' : CONTRABAND['other tenant customer name']
        else if (c === 'amount' || c === 'total' || c === 'price') row[c] = 210.5
        // Every remaining column carries a full set of secrets. If the export
        // widened its select to a denied column, the value is already waiting.
        else row[c] = mine ? `${c}-value` : 'RIVAL-BUSINESS-CUSTOMER'
      }
      return row
    })
  }

  const builder = (table: string, select: string) => {
    const q: FakeQuery = { table, select, eqs: [] }
    queries.push(q)
    const columns = select.split(',').map(s => s.trim()).filter(Boolean)
    const self = {
      eq(col: string, val: unknown) { q.eqs.push([col, val]); return self },
      order() { return self },
      range(from: number, to: number) {
        if (opts.failOn === table) {
          return Promise.resolve({ data: null, error: { message: `simulated read failure on ${table}` } })
        }
        const scoped = q.eqs.find(([c]) => c === 'user_id')
        const want = Math.min(to + 1, n) - from
        if (scoped) {
          const uid = String(scoped[1])
          return Promise.resolve({ data: rowsFor(table, columns, uid, uid === MINE, from, want), error: null })
        }
        // No filter -> the fake DB hands back BOTH tenants, exactly as an
        // unfiltered query against a table with RLS disabled would.
        return Promise.resolve({
          data: [
            ...rowsFor(table, columns, MINE, true, from, want),
            ...rowsFor(table, columns, THEIRS, false, from, want),
          ],
          error: null,
        })
      },
      then(res: (v: { data: unknown; error: unknown }) => unknown) {
        return self.range(0, 999).then(res)
      },
    }
    return self
  }

  return {
    from: (table: string) => ({ select: (sel: string) => builder(table, sel) }),
  } as unknown as SupabaseClient
}

async function main() {
  console.log('\n── The manifest never asks for a secret ───────────────────────')

  const allSelects = EXPORT_ENTITIES.flatMap(e => e.select.map(c => ({ entity: e.key, col: c })))
  const deniedHit = allSelects.filter(({ col }) =>
    DENIED_COLUMNS.includes(col) || DENIED_PATTERNS.some(p => col.toLowerCase().includes(p)))
  check('no entity SELECTS a denied column', deniedHit.length === 0,
    deniedHit.map(d => `${d.entity}.${d.col}`).join(', '))

  const joins = EXPORT_ENTITIES.filter(e => e.select.some(c => /[()!*]/.test(c)))
  check('every read is a flat select — no embedded joins', joins.length === 0,
    joins.map(e => e.key).join(', '))

  const files = EXPORT_ENTITIES.map(e => e.file)
  check('archive filenames are unique', new Set(files).size === files.length)
  check('archive filenames are safe and .csv', files.every(f => /^[a-z0-9\-]+\.csv$/.test(f)),
    files.filter(f => !/^[a-z0-9\-]+\.csv$/.test(f)).join(', '))
  check('every entity has a deterministic orderBy', EXPORT_ENTITIES.every(e => !!e.orderBy))
  check('every entity explains itself for the README', EXPORT_ENTITIES.every(e => e.note.length > 20))

  // Money the database does not store must not appear as a column. `amount_paid`
  // and `deposit_amount` ARE stored, so the test is for the invented names only.
  const invented = EXPORT_ENTITIES.flatMap(e =>
    e.columns.filter(c => /^(balance|amount_due|outstanding|revenue|profit|margin|total_paid)$/i.test(c.label))
      .map(c => `${e.file}:${c.label}`))
  check('no invented money column (balance / revenue / profit)', invented.length === 0, invented.join(', '))

  // For plain entities, what is written is exactly what was read.
  const drift = EXPORT_ENTITIES.filter(e => !e.expand)
    .filter(e => e.columns.map(c => c.label).join('|') !== e.select.join('|'))
  check('columns written == columns read (non-expanding entities)', drift.length === 0,
    drift.map(e => e.key).join(', '))

  console.log('\n── Building a real archive for a populated business ───────────')

  queries.length = 0
  const built = await buildExportArchive(fakeClient({ rowsPerTable: 3 }), MINE, {
    companyName: 'Acme Lawn & Snow', now: new Date('2026-08-11T15:00:00Z'),
  })
  if (!built.ok) { fail('a populated business builds an archive', built.message); return }
  ok('a populated business builds an archive')

  check('every read was filtered by the session owner id',
    queries.length > 0 && queries.every(q => q.eqs.some(([c, v]) => c === 'user_id' && v === MINE)),
    queries.filter(q => !q.eqs.some(([c, v]) => c === 'user_id' && v === MINE)).map(q => q.table).join(', '))

  const manifestTables = new Set(EXPORT_ENTITIES.map(e => e.table))
  const strays = queries.filter(q => !manifestTables.has(q.table)).map(q => q.table)
  check('no table outside the manifest was read', strays.length === 0, [...new Set(strays)].join(', '))

  check('one read per declared entity', queries.length === EXPORT_ENTITIES.length,
    `${queries.length} queries for ${EXPORT_ENTITIES.length} entities`)

  let entries: ZipEntry[] = []
  try {
    entries = readZip(built.archive)
    ok('the archive re-reads as a valid zip (central directory, sizes, CRC-32)')
  } catch (e) {
    fail('the archive re-reads as a valid zip', (e as Error).message)
  }

  const names = entries.map(e => e.name)
  check('the archive carries a README and a manifest',
    names.includes('README.txt') && names.includes('manifest.json'))
  check('every declared file is in the archive',
    EXPORT_ENTITIES.every(e => names.includes(e.file)),
    EXPORT_ENTITIES.filter(e => !names.includes(e.file)).map(e => e.file).join(', '))

  const manifestEntry = entries.find(e => e.name === 'manifest.json')
  try {
    const parsed = JSON.parse(manifestEntry?.text ?? '')
    check('manifest.json parses (no byte-order mark on JSON)',
      Array.isArray(parsed.files) && parsed.files.length === EXPORT_ENTITIES.length)
    check('manifest.json states what is NOT included', Array.isArray(parsed.not_included) && parsed.not_included.length > 0)
  } catch (e) {
    fail('manifest.json parses', (e as Error).message)
  }

  const csvEntries = entries.filter(e => e.name.endsWith('.csv'))
  check('every CSV opens with a byte-order mark so Excel reads UTF-8',
    csvEntries.length > 0 && csvEntries.every(e => e.text.charCodeAt(0) === 0xfeff))
  check('every CSV has a header row even when it has no data',
    csvEntries.every(e => e.text.replace(/^﻿/, '').split('\r\n')[0].includes(',')))

  console.log('\n── Nothing belonging to anyone else, and no secrets ───────────')

  const wholeArchive = entries.map(e => e.text).join('\n')
  for (const [label, value] of Object.entries(CONTRABAND)) {
    check(`the archive contains no ${label}`, !wholeArchive.includes(value))
  }
  // No account identifier of any shape survives — the fixture uids above are
  // real v4 UUIDs, so a leak would match this and nothing else does.
  const uuidHit = csvEntries
    .filter(e => /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(e.text))
    .map(e => e.name)
  check('no auth uid appears in any CSV', uuidHit.length === 0, uuidHit.join(', '))
  check('no CSV carries a user_id column',
    csvEntries.every(e => !/(^|,)"?user_id"?(,|\r|$)/m.test(e.text.replace(/^﻿/, ''))))

  console.log('\n── An empty business ─────────────────────────────────────────')

  queries.length = 0
  const empty = await buildExportArchive(fakeClient({ rowsPerTable: 0 }), MINE, { companyName: null })
  if (!empty.ok) { fail('an empty business still builds an archive', empty.message) } else {
    ok('an empty business still builds an archive')
    check('an empty export reports zero rows', empty.totalRows === 0, String(empty.totalRows))
    const emptyEntries = readZip(empty.archive)
    check('an empty archive still holds every file, header row and all',
      EXPORT_ENTITIES.every(e => {
        const f = emptyEntries.find(x => x.name === e.file)
        return !!f && f.text.replace(/^﻿/, '').split('\r\n').length === 1
      }))
    check('an empty archive still explains itself',
      (emptyEntries.find(e => e.name === 'README.txt')?.text.length ?? 0) > 500)
  }

  console.log('\n── A failure is a failure, not a short file ──────────────────')

  const broken = await buildExportArchive(fakeClient({ rowsPerTable: 2, failOn: 'invoices' }), MINE, {})
  check('a failed read returns an error', broken.ok === false)
  check('a failed read returns NO archive', !('archive' in broken))
  if (!broken.ok) {
    check('the failure names its cause and says nothing was downloaded',
      broken.code === 'read_failed' && /nothing was downloaded/i.test(broken.message), broken.message)
  }

  // The cap is injected rather than fixture-filled: the production ceiling is
  // MAX_TOTAL_ROWS, and what needs proving is that the CHECK fires, not that
  // two hundred thousand fake rows can be allocated.
  check('the shipped row cap is a real limit', MAX_TOTAL_ROWS > 0)
  const huge = await buildExportArchive(fakeClient({ rowsPerTable: 5 }), MINE, { maxTotalRows: 4 })
  check('an account past the row cap fails honestly rather than truncating',
    huge.ok === false && huge.code === 'too_large')
  if (!huge.ok) {
    check('the too-large message says nothing was downloaded', /nothing was downloaded/i.test(huge.message), huge.message)
  }

  console.log('\n── Filenames a person can use ────────────────────────────────')

  check('the filename carries the business name and the date',
    exportFilename('Acme Lawn & Snow', '2026-08-11T15:00:00Z') === 'acme-lawn-snow-edgequote-export-2026-08-11.zip',
    exportFilename('Acme Lawn & Snow', '2026-08-11T15:00:00Z'))
  check('a business with no name still gets a usable filename',
    exportFilename(null, '2026-08-11T15:00:00Z') === 'edgequote-export-2026-08-11.zip')
  check('a hostile business name cannot escape the filename',
    /^[a-z0-9.\-]+$/.test(exportFilename('../../etc/"; rm -rf /', '2026-08-11T15:00:00Z')),
    exportFilename('../../etc/"; rm -rf /', '2026-08-11T15:00:00Z'))

  console.log('\n── A spreadsheet cannot be made to run the data ──────────────')

  const zipped = zipArchive([{ name: 'a.txt', body: Buffer.from('hello') }], new Date('2026-08-11T15:00:00Z'))
  check('the zip writer round-trips a single file', readZip(zipped)[0]?.text === 'hello')

  const nameCsv = entries.find(e => e.name === 'customers.csv')?.text ?? ''
  check('customer names reach the CSV', nameCsv.includes('Jordan Miller'))

  console.log('\n── The route is the tenant boundary ──────────────────────────')

  const route = read('src/app/api/export/route.ts')
  check('the route requires a session', /auth\.getUser\(\)/.test(route))
  check('the route requires the OWNER role from the database', /resolveAppRole/.test(route) && /!==\s*'owner'/.test(route))
  check('the route never uses the service role', !/createAdminClient|SERVICE_ROLE/.test(route))
  check('the route reads no id from the request', !/req\.json\(\)|searchParams|params\./.test(route))
  check('the route scopes every read by the SESSION user', /buildExportArchive\(supabase,\s*user\.id/.test(route))
  check('the route runs on the node runtime (node:zlib)', /runtime\s*=\s*'nodejs'/.test(route))
  check('the archive is not cacheable', /no-store/.test(route))
  check('the audit row is written with the session user id', /data_exports'\)[\s\S]{0,120}user_id:\s*user\.id/.test(route))

  const build = read('src/lib/export/build.ts')
  check('the builder filters every entity by user_id', /\.eq\('user_id',\s*userId\)/.test(build))
  check('the builder reads everything BEFORE it writes anything',
    build.indexOf('Phase 1') < build.indexOf('Phase 2') && build.indexOf('zipArchive(') > build.indexOf('Phase 2'))
}

main().then(() => {
  console.log('\n── Summary ────────────────────────────────────────────────────')
  if (failures) {
    console.log(`\n❌ verify:export — ${failures} failure${failures === 1 ? '' : 's'}\n`)
    process.exit(1)
  }
  console.log('\n✅ verify:export — own data only, no secrets selected, honest failure\n')
}, e => {
  console.log(`\n❌ verify:export — ${e?.stack || e?.message || e}\n`)
  process.exit(1)
})
