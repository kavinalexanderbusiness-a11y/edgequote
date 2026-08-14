// ── Verify: a note cannot change audience by accident ────────────────────────
//   npm run verify:scoped-notes
//
// WHY THIS SCRIPT EXISTS
// EdgeQuote carries three kinds of writing — INTERNAL, CREW, CUSTOMER — and the
// only thing keeping them apart is which server-side projection selects which
// column. That is a strong boundary and an INVISIBLE one: every way of breaking
// it typechecks, lints, builds, and looks like an improvement in review.
//
//   • add `internal_notes` to get_portal_data's quote column list  ← one word
//   • render {quote.internal_notes} in QuotePDF beside {quote.notes}
//   • put `notes` back into the jobs projection (this ALREADY HAPPENED: 49 of 78
//     completed visits rendered their gate codes in the customer's portal)
//   • make the crew-media bucket public so a plain URL renders (this ALREADY
//     HAPPENED to job-photos, and is why crew media needed its own bucket)
//   • drop a step from /api/crew/media's authorization so any signed-in employee
//     can read any visit's instructions
//
// So the audience map in src/lib/noteScope.ts is asserted as DATA, and every
// promise it makes is then checked against the real SQL and the real components.
//
// ⚠️ THIS FILE READS SQL AND TSX AS TEXT, so it strips comments first. A comment
// saying "internal_notes must never appear here" contains the string
// `internal_notes`, and a naive grep would report the WARNING as the BREACH —
// the cure read as the disease. The stripper is CRLF-safe on purpose: `.` does
// not match `\r`, so a `.*$` pattern strips NOTHING on a CRLF checkout and every
// absence check silently inverts.

import { portalDataSql, baselineFile } from './lib/schema-source'
import {
  SCOPED_NOTE_FIELDS, AUDIENCE_READERS, AUDIENCE_COPY,
  fieldsHiddenFromCustomers, fieldsVisibleToCrew,
} from '../src/lib/noteScope'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const has = (p: string) => existsSync(join(ROOT, p))

/** Strip `--` line comments and block comments. `[^\n\r]` rather than `.*$`:
 *  on a CRLF checkout `.` does not match `\r`, so `.*$` strips nothing and an
 *  absence check quietly starts passing for the wrong reason. */
const stripSql = (s: string) => s.replace(/--[^\n\r]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
// Same idea for TS/TSX: line comments, block comments, and the JSX-braced form
// of a block comment. (Written as line comments on purpose — spelling a block
// comment's terminator inside a block comment ends it early, which is its own
// small lesson in reading source as text.)
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n\r]*/g, '')

// ── 0. The stripper actually strips ──────────────────────────────────────────
// Asserted FIRST, because every absence check below is worthless if this is a
// no-op — and a no-op stripper makes them all PASS. This is the exact failure
// mode a CRLF checkout produces.
console.log('\n═══ The comment stripper (every absence check depends on it) ═══')
check('strips a -- comment on an LF line',
  !stripSql('select a\n-- internal_notes\nfrom t').includes('internal_notes'))
check('strips a -- comment on a CRLF line',
  !stripSql('select a\r\n-- internal_notes\r\nfrom t').includes('internal_notes'),
  'a `.*$` pattern would leave the text behind on CRLF and invert every check below')
check('strips a // comment on a CRLF line',
  !stripTs('const a = 1\r\n// internal_notes\r\n').includes('internal_notes'))
check('strips a JSX block comment',
  !stripTs('<div>{/* internal_notes never here */}</div>').includes('internal_notes'))
check('keeps real code',
  stripSql('select internal_notes -- a comment\nfrom t').includes('internal_notes'),
  'over-stripping would make these checks vacuous in the other direction')

// ── 1. The map is internally consistent ──────────────────────────────────────
console.log('\n═══ The audience map ═══')

check('every audience admits the owner',
  (Object.keys(AUDIENCE_READERS) as (keyof typeof AUDIENCE_READERS)[])
    .every(a => AUDIENCE_READERS[a].includes('owner')))
check('internal admits ONLY the owner',
  JSON.stringify(AUDIENCE_READERS.internal) === JSON.stringify(['owner']),
  'widening `internal` here would silently widen every field declared internal')
check('crew does NOT admit the customer',
  !AUDIENCE_READERS.crew.includes('customer'),
  'crew instructions and reference media are not customer-facing at any point, including after completion')
check('customer admits the customer',
  AUDIENCE_READERS.customer.includes('customer'))

check('every registry entry names a real audience',
  SCOPED_NOTE_FIELDS.every(f => f.audience in AUDIENCE_READERS))
check('every registry entry says what enforces it',
  SCOPED_NOTE_FIELDS.every(f => f.enforcedBy.trim().length > 20),
  'an audience claim with no named enforcement is a comment, not a boundary')
check('no (table, column) is declared twice',
  new Set(SCOPED_NOTE_FIELDS.map(f => `${f.table}.${f.column}`)).size === SCOPED_NOTE_FIELDS.length,
  'two entries for one column means two answers to "who reads this"')

// The three owner-facing sentences must actually differ — the whole point is
// that an owner can tell the fields apart at a glance.
const helps = Object.values(AUDIENCE_COPY).map(c => c.help)
check('each audience has its own words', new Set(helps).size === helps.length)
check('the internal promise says it stays in', /only your team/i.test(AUDIENCE_COPY.internal.help))
check('the customer promise names the PDF and the portal',
  /pdf/i.test(AUDIENCE_COPY.customer.help) && /portal/i.test(AUDIENCE_COPY.customer.help))

const hidden = fieldsHiddenFromCustomers()
check('the hidden set is non-empty and excludes every customer field',
  hidden.length > 0 && hidden.every(f => f.audience !== 'customer'))
check('crew media caption is crew-audience, never customer',
  fieldsVisibleToCrew().some(f => f.table === 'crew_media') &&
  !hidden.every(f => f.table !== 'crew_media'))

// ── 2. The portal RPC does not select anything hidden ────────────────────────
// This is THE customer door. Its projection is an explicit column list, which is
// what makes the audience boundary enforceable at all.
console.log('\n═══ get_portal_data (the customer door) ═══')

// 2026-08-14: the canonical file is retired; the one definition now lives in the
// generated baseline, so this asserts against the body production actually runs.
const PORTAL_SQL = baselineFile()
check('the portal RPC has a definition in the apply path', PORTAL_SQL !== '')
if (PORTAL_SQL) {
  const portal = stripSql(portalDataSql())

  // ⚠️ THE CHECK HAS TO BE PROJECTION-AWARE, NOT A BARE GREP. `notes` is the
  // column name on customers, quotes, invoices, properties and jobs — three of
  // which are customer-facing ON PURPOSE. Searching the whole file for the word
  // reports quotes.notes (correctly printed) as a breach of customers.notes.
  // So: pull the column list of every `select … from public.<table>` and ask
  // whether the hidden column is in THAT list.
  //
  // Located by searching BACKWARD from `from public.<table>` for the nearest
  // preceding `select`. A forward lazy match (`select ([\s\S]*?) from public.x`)
  // looks equivalent and is not: it anchors on the EARLIEST `select` that can
  // reach the target, so the jobs projection came back carrying the entire
  // quotes projection — and `notes` from a quote was reported as a leak of a
  // visit's gate code. Nearest-preceding is the innermost select, which is the
  // one that actually owns the column list.
  const columnListsFor = (table: string): string[] => {
    const out: string[] = []
    const re = new RegExp(String.raw`\bfrom\s+public\.${table}\b`, 'gi')
    for (const m of portal.matchAll(re)) {
      const end = m.index ?? 0
      const start = portal.lastIndexOf('select', end)
      if (start >= 0) out.push(portal.slice(start + 'select'.length, end))
    }
    return out
  }

  // ⭐ WHOLE-FILE WHERE THE NAME IS UNIQUE, SLICE ONLY WHERE IT IS NOT.
  // Mutation testing found the slice alone was too weak: adding `qt.internal_notes`
  // to the quotes projection went UNCAUGHT, because the nearest `select` before
  // `from public.quotes` is the NESTED quote_services select, not the outer
  // column list the alias belongs to. Nested projections defeat any
  // slice heuristic.
  //
  // But most hidden columns have names no customer-facing field shares —
  // `internal_notes`, `completion_issue` — and for those the strongest possible
  // check is also the simplest: the string must not appear in the file AT ALL,
  // qualified, nested or otherwise. Only `notes` is genuinely ambiguous (hidden
  // on customers and jobs, deliberately PRESENT on quotes, invoices and
  // properties), and that is the one case that needs the slice.
  //
  // Which is which is derived from the registry, not hand-listed, so a new
  // internal field is protected by the strong check the moment it is declared.
  const customerFacingColumns = new Set(
    SCOPED_NOTE_FIELDS.filter(f => f.audience === 'customer').map(f => f.column))

  for (const f of hidden) {
    if (f.wholeTable) {
      // No projection reads any column of it — so assert the TABLE NAME never
      // appears. This is the strongest check available and it is immune to the
      // nested-projection problem below; it is only usable because these tables
      // have no customer-facing column at all. Driven by the registry flag, not
      // by a hand-kept list of table names, so a new whole-table audience is
      // protected the moment it is declared.
      check(`portal payload omits ${f.table} entirely`,
        !new RegExp(`\\b${f.table}\\b`).test(portal),
        `${f.table} is not customer-facing at any point, including after completion`)
      continue
    }
    if (!customerFacingColumns.has(f.column)) {
      check(`portal payload omits ${f.table}.${f.column} (whole file)`,
        !new RegExp(`\\b${f.column}\\b`).test(portal),
        `${f.column} appears anywhere in the portal RPC — ${f.purpose}`)
      continue
    }
    const lists = columnListsFor(f.table)
    check(`portal payload omits ${f.table}.${f.column}`,
      lists.length > 0 && lists.every(l => !new RegExp(`\\b${f.column}\\b`).test(l)),
      lists.length === 0
        ? `no "select … from public.${f.table}" found — the projection moved, so this guard is no longer watching anything`
        : `${f.column} is selected from public.${f.table} — ${f.purpose}`)
  }

  // MECHANISM CONTROL on the exact slice the jobs.notes check reads. Proves
  // columnListsFor returns the real, innermost jobs column list — so "notes is
  // absent from it" is a finding about the projection and not about an empty
  // string. Without this, deleting the file would make every check above pass.
  check('the jobs projection is found and DOES select completion_summary (mechanism control)',
    columnListsFor('jobs').some(l => /\bcompletion_summary\b/.test(l)),
    'if this fails, columnListsFor is not reading the jobs projection and its omission check proves nothing')
  // Positive control: the customer-facing fields ARE there. Without this, a
  // typo'd file path or an over-eager stripper makes every check above pass
  // while proving nothing.
  check('portal payload DOES carry quotes.notes (positive control)',
    /\bnotes\b/.test(portal), 'the customer-facing quote note must still reach the portal')
  check('portal payload DOES carry completion_summary (positive control)',
    /\bcompletion_summary\b/.test(portal))
}

// ── 3. No PDF renders an internal field ──────────────────────────────────────
// A PDF is the one artefact that leaves the building as a file. Once emailed it
// cannot be recalled, so this is checked over the component source directly.
console.log('\n═══ The documents customers receive ═══')

const PDFS = ['src/components/quotes/QuotePDF.tsx', 'src/components/quotes/InvoicePDF.tsx']
for (const p of PDFS) {
  check(`${p} exists`, has(p))
  if (!has(p)) continue
  const src = stripTs(read(p))
  check(`${p} never renders internal_notes`,
    !/internal_notes/.test(src),
    'an internal note printed on a customer document cannot be recalled')
  check(`${p} never renders completion_issue`, !/completion_issue/.test(src))
  // Whole-table audiences, from the registry rather than hand-listed — so a new
  // one is kept off the customer's documents the moment it is declared. The
  // hyphenated form catches the storage bucket name beside the table name.
  for (const f of hidden.filter(h => h.wholeTable)) {
    const hyphen = f.table.replace(/_/g, '-')
    check(`${p} never renders ${f.table}`,
      !new RegExp(`${f.table}|${hyphen}`).test(src),
      `${f.purpose}`)
  }
}
// Positive control on the same files.
if (has(PDFS[0])) {
  check('QuotePDF DOES render the customer note (positive control)',
    /quote\.notes/.test(stripTs(read(PDFS[0]))))
}

// ── 4. The crew door proves assignment before it signs ───────────────────────
console.log('\n═══ /api/crew/media ═══')

const MEDIA_ROUTE = 'src/app/api/crew/media/route.ts'
check(`${MEDIA_ROUTE} exists`, has(MEDIA_ROUTE))
if (has(MEDIA_ROUTE)) {
  const src = stripTs(read(MEDIA_ROUTE))
  check('runs on node (the service role must never run at the edge)',
    /runtime\s*=\s*['"]nodejs['"]/.test(src))
  check('1 — requires a session', /auth\.getUser\(\)/.test(src) && /401/.test(src))
  check('2 — asks the DATABASE for the role', /resolveAppRole/.test(src) && /!==\s*['"]crew['"]/.test(src))
  check('3 — re-checks the roster switches',
    /is_active/.test(src) && /archived_at/.test(src) && /auth_user_id/.test(src),
    'without these a worker deactivated mid-shift keeps reading with an unexpired JWT')
  check('4 — scopes the visit to this employer AND this crew',
    /\.eq\(\s*['"]user_id['"]/.test(src) && /\.eq\(\s*['"]crew_id['"]/.test(src),
    'employer alone lets any employee read any crew\'s visit; crew alone crosses the tenant boundary')
  check('the catalogue read is scoped by BOTH job and owner',
    /\.eq\(\s*['"]job_id['"][^)]*\)\s*\.eq\(\s*['"]user_id['"]/.test(src.replace(/\s+/g, ' ')),
    'a widened job lookup must still not be able to cross a tenant boundary here')
  check('no service key ⇒ the door stays SHUT (never a weaker check)',
    /if\s*\(\s*!admin\s*\)/.test(src) && /503/.test(src))
  check('the client cannot name a file — only a visit',
    !/searchParams\.get\(\s*['"](mediaId|id|path|storage_path)['"]\s*\)/.test(src),
    'accepting a media id or path would let a copied id from another business be pasted in')
  check('storage_path is never echoed to the client',
    !/storage_path:\s*m\.storage_path/.test(src),
    'a path is the one string that still means something after the signature expires')
  check('URLs are signed, not public', /createSignedUrls?\(/.test(src) && !/getPublicUrl/.test(src))
  const secs = src.match(/SIGNED_URL_SECONDS\s*=\s*(\d+)/)
  check('the signature is short-lived (≤ 15 min)',
    !!secs && Number(secs[1]) > 0 && Number(secs[1]) <= 900,
    `a copied link must die quickly; found ${secs?.[1] ?? 'no'} seconds`)
}

// ── 5. The bucket is private, and stays private ──────────────────────────────
// job-photos is public:true — a working choice for photos of finished work and a
// disqualifying one for a video of a customer's side gate. This asserts crew
// media did not quietly get filed there, and that its own bucket is declared
// private in the migration that creates it.
console.log('\n═══ Storage privacy ═══')

const MIGRATION = 'supabase/archive/run/RUN-2026-08-11-scoped-notes-crew-media.sql'
check(`${MIGRATION} exists`, has(MIGRATION))
if (has(MIGRATION)) {
  const sql = stripSql(read(MIGRATION))
  // The literal VALUES tuple, not a `[\s\S]*?` walk from `insert into`. Mutation
  // testing caught that: flipping the tuple to `true` left the lazy matcher free
  // to skip ahead and find the `false` in the ON CONFLICT clause below, so the
  // bucket could be made public with the check still green.
  check('the crew-media bucket is created private',
    /'crew-media',\s*'crew-media',\s*false\b/i.test(sql),
    'public:true would make the URL itself the permission — the whole reason this is not job-photos')
  check('re-running RE-ASSERTS private (a later flip cannot survive a replay)',
    /on\s+conflict[\s\S]*?set[\s\S]*?public\s*=\s*false/i.test(sql),
    'without this, `do update` could leave a bucket someone had flipped to public')
  check('a size ceiling is set on the bucket itself',
    /file_size_limit/.test(sql) && /\b52428800\b/.test(sql),
    'a JS-only limit is skipped by a crafted request')
  check('the MIME allowlist is on the bucket', /allowed_mime_types/.test(sql))
  check('storage policies scope by the first path segment',
    /storage\.foldername\(name\)\)\[1\]\s*=\s*\(auth\.uid\(\)\)::text/.test(sql),
    'the first segment IS the tenant boundary')
  check('crew_media has RLS enabled', /alter\s+table\s+public\.crew_media\s+enable\s+row\s+level\s+security/i.test(sql))
  check('crew_media carries a NOT NULL tenant column',
    /user_id\s+uuid\s+not\s+null/i.test(sql),
    'ownership is never inferred from a filename')
  check('crew_media rows die with their visit',
    /job_id\s+uuid\s+not\s+null\s+references\s+public\.jobs\(id\)\s+on\s+delete\s+cascade/i.test(sql))
  check('⛔ no per-row visibility switch on crew_media',
    !/\bvisibility\b|\bis_public\b|\bcustomer_visible\b/i.test(sql),
    'a per-row audience flag is a control whose only use is to leak')
}

const MEDIA_LIB = 'src/lib/crewMedia.ts'
if (has(MEDIA_LIB)) {
  const src = stripTs(read(MEDIA_LIB))
  check('crew media never resolves a public URL',
    !/getPublicUrl/.test(src),
    'a public URL would make the link itself the permission')
  check('crew media uses its own bucket, not job-photos',
    /'crew-media'/.test(src) && !/job-photos/.test(src))
  check('a failed catalogue write removes the stored object',
    /storage[\s\S]{0,200}\.remove\(\[path\]\)/.test(src),
    'an orphaned private object is a privacy leak, not clutter')
}

// ── 6. Crew reference media is not proof of work ─────────────────────────────
// Two surfaces, opposite directions, and merging them is the tempting mistake:
// "the crew already has media on the visit, show it to the customer too".
console.log('\n═══ Crew media ≠ proof of work ═══')

const PORTAL_MODEL = 'src/app/portal/[token]/model.ts'
if (has(PORTAL_MODEL)) {
  check('the portal model has no concept of crew media',
    !/crew_media|crewMedia|crew-media/.test(stripTs(read(PORTAL_MODEL))))
}
const CREW_MEDIA_UI = 'src/components/crew/CrewStopMedia.tsx'
if (has(CREW_MEDIA_UI)) {
  const src = stripTs(read(CREW_MEDIA_UI))
  check('the field player asks the crew door, not storage directly',
    /\/api\/crew\/media/.test(src) && !/from\(\s*['"]crew-media['"]\s*\)/.test(src),
    'a crew session holds no storage grants — going direct would fail, or worse, be made to work by widening a policy')
  check('video is width-bounded (a 4K clip must not blow out a 375px card)',
    /max-w-full/.test(src) && /w-full/.test(src))
  check('video plays inline (so "back to the job" stays one tap)', /playsInline/.test(src))
  check('a decode failure is reported, not left as a black box', /onError/.test(src))
}

// ── 7. The owner is told, on every scoped field ──────────────────────────────
// The defect this session set out to close was not a leak — it was a LIE. The
// quote's customer-facing note was labelled "Notes" and its placeholder invited
// "access instructions, gate codes…". Nobody had taken the invitation yet.
console.log('\n═══ The owner is never left guessing ═══')

// ⚠️ CHECKED PER FIELD, NOT PER FILE. Mutation testing caught the weaker
// version: replacing the quote's customer-note label with a bare "Notes" left
// the file still matching /AUDIENCE_COPY\.\w+\.label/ — because the INTERNAL
// field two blocks down still used it. A form-wide check cannot tell you which
// field stopped saying who reads it, which is the only thing worth knowing.
// So each field is named, with the exact audience it must claim.
const LABELLED_FIELDS: { file: string; what: string; audience: string }[] = [
  { file: 'src/components/quotes/QuoteBuilder.tsx',   what: "the quote's customer note", audience: 'customer' },
  { file: 'src/components/quotes/QuoteBuilder.tsx',   what: "the quote's internal note", audience: 'internal' },
  { file: 'src/components/schedule/JobForm.tsx',      what: "the visit's crew note",     audience: 'crew' },
  { file: 'src/components/customers/CustomerForm.tsx', what: "the customer's note",      audience: 'internal' },
]
for (const { file, what, audience } of LABELLED_FIELDS) {
  if (!has(file)) { fail(`${file} exists`, 'missing'); continue }
  const src = read(file).replace(/\s+/g, ' ')   // NOT comment-stripped: asserting on rendered JSX props
  check(`${what} claims the ${audience} audience, from one source`,
    new RegExp(`label=\\{AUDIENCE_COPY\\.${audience}\\.label\\} hint=\\{AUDIENCE_COPY\\.${audience}\\.help\\}`).test(src),
    `a hand-written label drifts, and a missing one leaves the owner guessing which of three audiences this field has`)
}

for (const p of ['src/components/quotes/QuoteBuilder.tsx', 'src/components/schedule/JobForm.tsx',
                 'src/components/customers/CustomerForm.tsx']) {
  if (!has(p)) continue
  check(`${p.split('/').pop()} does not invite gate codes into a printing field`,
    !/placeholder="[^"]*gate codes[^"]*"[\s\S]{0,200}register\('notes'\)/.test(read(p)),
    'this exact placeholder sat on the field that prints on the customer PDF')
}

const QB = 'src/components/quotes/QuoteBuilder.tsx'
if (has(QB)) {
  const src = read(QB)
  check('the quote builder writes a separate internal field',
    /register\('internal_notes'\)/.test(src))
  check('the quote customer note no longer says "gate codes"',
    !/Job-specific details, access instructions, gate codes/.test(src),
    'the placeholder that invited operational secrets onto a customer document')
}

// ── 8. Every write path keeps the halves apart ───────────────────────────────
// Duplicate a quote, convert it to an invoice: both carry two notes, and the
// pairing must not cross. `internal_notes: q.notes` typechecks perfectly.
console.log('\n═══ Conversions keep each half on its own side ═══')

const CONVERTERS = ['src/app/dashboard/quotes/[id]/page.tsx', 'src/components/quotes/QuoteList.tsx']
for (const p of CONVERTERS) {
  if (!has(p)) continue
  const src = stripTs(read(p)).replace(/\s+/g, ' ')
  check(`${p.split('/').pop()} never assigns an internal note to a printing field`,
    !/[^_]notes:\s*(quote|q)\.internal_notes/.test(src),
    'this would put the owner\'s price floor on the customer\'s invoice')
  check(`${p.split('/').pop()} never assigns a customer note to the internal field`,
    !/internal_notes:\s*(quote|q)\.notes\b/.test(src),
    'losing the private note is the milder half of the same swap')
  check(`${p.split('/').pop()} carries internal_notes across at all`,
    /internal_notes:\s*(quote|q)\.internal_notes/.test(src),
    'dropping it silently loses the owner\'s note on every duplicate/convert')
}

console.log(failures === 0
  ? '\n✅ Scoped notes: every audience boundary is where it says it is.\n'
  : `\n❌ ${failures} scoped-note check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
