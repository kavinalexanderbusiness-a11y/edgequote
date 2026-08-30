// ── Verify: an accepted quote's DOCUMENT is the ledger's, never the live row ──
//   npm run verify:accepted-document-truth
//
// Session 121 made acceptance EVIDENCE (quote_acceptances: append-only, with an
// immutable `document` snapshot, a material fingerprint, and an evidence KIND).
// Session 112 closes the reported residual: the quote PDF — owner side and
// customer portal — still rendered LIVE quote data, and the review added a
// second law: THE THREE EVIDENCE KINDS ARE NOT INTERCHANGEABLE. A customer row
// proves the customer acted; an owner_on_behalf row proves the business
// RECORDED that they did; a legacy_unrecorded row proves only that the old
// system had the quote marked accepted — and no label anywhere may claim more.
//
// THE LAWS THIS GUARD PINS:
//     current quote PDF  ≠  accepted version document
//     evidence kind      =  the document's label, at every surface
//     the migration      =  current effective get_portal_data + marked
//                           projection, and NOTHING else
//
// The reported failure modes, each pinned below and each MUTATION-TESTED by
// scripts/s112-mutations.mjs (which itself refuses a mutation that changed no
// bytes):
//   live price / live scope / current terms → §1, §2, §4
//   revision overwrites history             → §6 (append-only + byte-equality)
//   portal confuses current vs accepted     → §4, §6
//   fingerprint ignored                     → §4, §6
//   legacy labelled "customer accepted"     → §1a, §2, §4
//   on-behalf labelled portal acceptance    → §1a, §4
//   renderer ignores evidence kind          → §1, §2
//   stale body / unrelated functions /
//   lost privacy or publication predicates  → §5 (migration scope + byte-delta)
//
// §6 builds an EMPTY PostgreSQL from this repository's own migrations (PGlite)
// and uses disposable fixtures only — no production row is read or written.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'
import { acceptedRenderInput } from '../src/lib/acceptedDocument'
import {
  acceptedDocumentLabel, acceptedRowSentence, priorVersionHeading,
  acceptedArtifactLabel, acceptedFileSuffix, type AcceptedDocument,
} from '../src/lib/quoteAcceptance'
import { extractPortalFn, latestBaseline, MARK_START, MARK_END } from './schema/generate-portal-accepted-version'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, c: boolean, d = '') => c ? ok(n) : fail(n, d)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 1. The mapper is snapshot-pure — no live material fact can reach it ═══')

const SNAP: AcceptedDocument = {
  quote_number: 'Q-7001', customer_name: 'Dana Reyes', address: '12 Elm St',
  service_type: 'Lawn care', notes: 'Gate code 4471',
  initial_price: 5400, travel_fee: 150, total: 5550, valid_until: '2027-01-15',
  deposit_type: 'percent', deposit_value: 25,
  plan_prices: { weekly: 80, biweekly: 95, monthly: 120 },
  option: { id: 'opt-b', name: 'Standard', description: 'Walls and trim', price: 5400 },
  options_offered: [{ id: 'opt-a', name: 'Budget', price: 4200 }, { id: 'opt-b', name: 'Standard', price: 5400 }],
  addons: [{ id: 'ad-1', name: 'Edging', price: 90 }],
  services: [
    { service_type: 'Mowing', quantity: 1, unit: null, unit_price: 5000, discount_type: null, discount_value: null, notes: 'front + back', kind: 'service' },
    { service_type: 'Mulch', quantity: 5, unit: 'yd3', unit_price: 80, discount_type: 'amount', discount_value: 40, notes: null, kind: 'material' },
  ],
}
const out = acceptedRenderInput({
  document: SNAP, acceptedAt: '2026-08-20T14:00:00Z', selectedOptionId: 'opt-b',
  termsText: 'Payment due on completion.', kind: 'customer',
  presentation: { quoteId: 'q-live-id', createdAt: '2026-08-01T09:00:00Z', issuedDate: '2026-08-02' },
})
check('the accepted price is the snapshot price', out.quote.initial_price === 5400 && Number(out.quote.total) === 5550)
check('travel is the snapshot fee', Number(out.quote.travel_fee) === 150)
check('the scope lines are the snapshot lines, in snapshot order',
  out.services?.length === 2 && out.services[0].service_type === 'Mowing' && out.services[0].sort_order === 0
  && out.services[1].unit_price === 80 && out.services[1].discount_value === 40 && out.services[1].kind === 'material')
check('plan prices come from the snapshot', out.quote.weekly_price === 80 && out.quote.biweekly_price === 95 && out.quote.monthly_price === 120)
check('the offered alternatives are the snapshot set, chosen one described',
  out.options?.length === 2 && out.options[1].id === 'opt-b' && out.options[1].description === 'Walls and trim' && out.options[0].description === null)
check('customer-facing notes are the snapshot notes', out.quote.notes === 'Gate code 4471')
check('no crew/hours estimate survives into the accepted render', out.quote.crew_size === 0 && out.quote.hours === 0)
check('travel on the accepted document is itemized', out.quote.show_travel_separately === true)
check('the accepted stamp carries the ledger date, the EXACT terms, and the KIND',
  out.accepted.at === '2026-08-20T14:00:00Z' && out.accepted.termsText === 'Payment due on completion.'
  && out.accepted.kind === 'customer')

// The legacy weld: whatever a caller passes, a legacy render claims no terms.
const legacyOut = acceptedRenderInput({
  document: SNAP, acceptedAt: '2026-08-20T14:00:00Z', selectedOptionId: null,
  termsText: 'A text nobody acknowledged', kind: 'legacy_unrecorded',
  presentation: { quoteId: 'q', createdAt: '2026-08-01T09:00:00Z', issuedDate: null },
})
check('a legacy render claims NO terms, whatever the caller passes',
  legacyOut.accepted.termsText === null && legacyOut.accepted.kind === 'legacy_unrecorded',
  'the database welds legacy rows to no-terms-claim; the mapper must weld it again')

const mapper = read('src/lib/acceptedDocument.ts')
check('presentation is exactly the three named non-material facts',
  /presentation: \{ quoteId: string; createdAt: string; issuedDate: string \| null \}/.test(mapper),
  'widening this interface is how a live material fact sneaks back into the accepted render')

// ── 1a. THE WORDS, per evidence kind — the one place they live ───────────────
console.log('\n═══ 1a. Three kinds of evidence, three different sentences ═══')
const L = {
  customer: acceptedDocumentLabel('customer', 'D'),
  behalf: acceptedDocumentLabel('owner_on_behalf', 'D'),
  legacy: acceptedDocumentLabel('legacy_unrecorded', 'D'),
}
check('a CUSTOMER acceptance may say "accepted"',
  L.customer.title.startsWith('ACCEPTED VERSION') && /version accepted on D/.test(L.customer.body))
check('an ON-BEHALF record says RECORDED, and where the decision came from',
  /RECORDED/.test(L.behalf.title) && /recorded by the business on the customer’s behalf/.test(L.behalf.body)
  && !/version accepted on/.test(L.behalf.body),
  'implying portal/electronic acceptance the customer never performed')
check('a LEGACY record is a HISTORICAL RECORD that claims no captured evidence',
  /HISTORICAL RECORD/.test(L.legacy.title) && /was not captured/.test(L.legacy.body)
  && !/version accepted on/.test(L.legacy.body) && !/ACCEPTED VERSION/.test(L.legacy.title),
  'a backfill must never read as stronger evidence than S121 recorded')
check('the portal row sentences keep the same distinctions',
  /that accepted version/.test(acceptedRowSentence('customer', 'D'))
  && /recorded against/.test(acceptedRowSentence('owner_on_behalf', 'D'))
  && /before detailed records/.test(acceptedRowSentence('legacy_unrecorded', 'D'))
  && !/accepted version/.test(acceptedRowSentence('legacy_unrecorded', 'D')))
check('the prior-version headings do too',
  priorVersionHeading('customer') === 'Your previously accepted version'
  && priorVersionHeading('owner_on_behalf') === 'The previously recorded version'
  && priorVersionHeading('legacy_unrecorded') === 'The version previously on record')
check('the owner door label downgrades a legacy record',
  acceptedArtifactLabel('customer') === 'Accepted version'
  && acceptedArtifactLabel('legacy_unrecorded') === 'Historical record')
check('a legacy snapshot does not download as "-accepted"',
  acceptedFileSuffix('customer') === 'accepted' && acceptedFileSuffix('legacy_unrecorded') === 'record')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 2. The PDF: one renderer, kind-labelled sources ═══')
const pdfSrc = read('src/components/quotes/QuotePDF.tsx')

check('QuoteDocument accepts the accepted-version stamp WITH its kind',
  /accepted\?: \{ at: string; termsText: string \| null; kind: AcceptanceKind \}/.test(pdfSrc))
check('renderQuoteBlob passes the stamp through',
  /accepted\?: \{ at: string; termsText: string \| null; kind: AcceptanceKind \},\s*\): Promise<Blob>/.test(pdfSrc)
  && /accepted=\{accepted\}/.test(pdfSrc))
check('the band renders THE engine\'s per-kind words, not its own',
  /acceptedDocumentLabel\(accepted\.kind, dateStr\(accepted\.at\)\)/.test(pdfSrc)
  && /\{label\.title\}/.test(pdfSrc) && /\{label\.body\}/.test(pdfSrc),
  'a hand-written band is how "ACCEPTED VERSION" gets stamped over a legacy backfill again')
check('terms on an accepted render come from the acceptance, with NO settings fallback',
  /const termsText = accepted \? accepted\.termsText : settings\?\.terms_text/.test(pdfSrc),
  'accepted?.termsText ?? settings would let an edited Settings text rewrite what was agreed')
check('the crew/hours estimate is suppressed on both accepted render paths',
  /s\.sort_order === 0 && !accepted \?/.test(pdfSrc)
  && /\{accepted \? '—' : `\$\{quote\.crew_size\} crew · \$\{quote\.hours\} hrs`\}/.test(pdfSrc))

const reads = [...new Set([...pdfSrc.matchAll(/quote\.([a-z_]+)/g)].map(m => m[1]))].sort()
const COVERED = [
  'address', 'biweekly_price', 'customer_name', 'initial_price', 'monthly_price',
  'notes', 'quote_number', 'selected_option_id', 'service_type', 'show_travel_separately',
  'status', 'total', 'travel_fee', 'valid_until', 'weekly_price',
  'created_at', 'issued_date',      // presentational, deliberately live
  'crew_size', 'hours',             // suppressed on accepted renders (above)
].sort()
check('every quote field the PDF reads is covered by the mapper or declared',
  reads.every(r => COVERED.includes(r)),
  `uncovered: ${reads.filter(r => !COVERED.includes(r)).join(', ')}`)

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 3. The owner surface: two artifacts, kind-labelled ═══')
const ownerSrc = read('src/app/dashboard/quotes/[id]/page.tsx').replace(/\r\n/g, '\n')

check('the accepted-version handler feeds the LEDGER snapshot through the mapper',
  /acceptedRenderInput\(\{\s*document: acceptance\.document/.test(ownerSrc)
  && /renderQuoteBlob\(input\.quote, settings, input\.services, input\.options, input\.accepted\)/.test(ownerSrc))
check('…and its terms come from quote_acceptances, never live settings',
  /from\('quote_acceptances'\)\s*\.select\('terms_text/.test(ownerSrc) && !/termsText: settings/.test(ownerSrc))
check('…and a MISSING kind degrades to the weakest claim, never to "customer"',
  (ownerSrc.match(/acceptance\.kind \?\? 'legacy_unrecorded'/g) ?? []).length >= 2,
  "kind ?? 'customer' would let a null kind overclaim")
check('the door label and filename follow the kind (engine helpers)',
  /acceptedArtifactLabel\(acceptance\.kind \?\? 'legacy_unrecorded'\)/.test(ownerSrc)
  && /acceptedFileSuffix\(acceptance\.kind \?\? 'legacy_unrecorded'\)/.test(ownerSrc))
check('the accepted-version button appears only when evidence exists',
  /acceptance\?\.accepted && acceptance\.document && \(/.test(ownerSrc))
check('the current PDF renames itself the moment an accepted version exists',
  /acceptance\?\.accepted \? 'Current PDF' : 'Open PDF'/.test(ownerSrc))

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 4. The portal: the fingerprint decides, the kind speaks ═══')
const modelSrc = read('src/app/portal/[token]/model.ts').replace(/\r\n/g, '\n')
const billingSrc = read('src/app/portal/[token]/components/BillingTab.tsx').replace(/\r\n/g, '\n')
const portalPdfSrc = read('src/lib/portalPdf.ts').replace(/\r\n/g, '\n')

check('an accepted quote\'s download renders the SNAPSHOT, not the live row',
  /getBlob: acc && isAcceptedOrBeyond\(qq\.status\)\s*\? \(\) => renderers\.acceptedQuote\(qq, acc\)\s*: \(\) => renderers\.quote\(qq\)/.test(modelSrc))
check('…and its filename follows the evidence kind',
  /\$\{qq\.quote_number\}-\$\{acceptedFileSuffix\(acc\.kind\)\}\.pdf/.test(modelSrc))
check('drift is the DATABASE fingerprint verdict when the payload carries one',
  /const driftedSinceAccepted = acc\s*\? acc\.needs_reapproval && isAcceptedOrBeyond\(qq\.status\)\s*: priceMovedSinceAccepted/.test(modelSrc))
check('the accepted version rides the row with its KIND',
  /acceptedVersion: acc \? \{\s*at: acc\.accepted_at,\s*kind: acc\.kind,/.test(modelSrc))
check('the drift note names the evidence in its own strength',
  /acc\?\.kind === 'legacy_unrecorded' \? 'on record'/.test(modelSrc)
  && /acc\?\.kind === 'owner_on_behalf' \? 'we recorded'/.test(modelSrc))
check('a payload without the projection degrades to the pre-ledger behaviour',
  /const acc = qq\.acceptance \?\? null/.test(modelSrc))

check('the portal accepted-render bridge takes ONLY presentation facts from the live quote',
  /q: Pick<PortalPdfQuote, 'created_at' \| 'issued_date'> & \{ id\?: string \}/.test(portalPdfSrc))
check('…and passes the evidence kind through to the mapper',
  /kind: acc\.kind,/.test(portalPdfSrc)
  && /renderQuoteBlob\(input\.quote, portalBusinessToSettings\(b\), input\.services, input\.options, input\.accepted\)/.test(portalPdfSrc))

check('the portal row speaks THE engine\'s per-kind sentence',
  /acceptedRowSentence\(d\.acceptedVersion\.kind, formatDate\(d\.acceptedVersion\.at\)\)/.test(billingSrc),
  'hand-written words here are how "you accepted" gets said over a backfill')
check('the prior-version block heads with the engine\'s per-kind heading',
  /priorVersionHeading\(d\.acceptedVersion\.kind\)/.test(billingSrc))
check('the re-sent banner names the prior evidence in its own strength',
  /the version on record/.test(billingSrc) && /the version recorded \$\{formatDate/.test(billingSrc)
  && /the version you accepted \$\{formatDate/.test(billingSrc))
check('…and the previously accepted version stays beside it, separately downloadable',
  /DocActions filename=\{d\.acceptedVersion\.filename\} getBlob=\{d\.acceptedVersion\.getBlob\}/.test(billingSrc))

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 5. The migration: the current function + the marked projection, nothing else ═══')
// The 20260830090000 incident, made structural: that file sliced the baseline by
// line count, and five unrelated functions — each a stale CREATE OR REPLACE able
// to erase another lane's fix — rode along. And the S113 requirement: the body
// must be the CURRENT effective function, so a baseline moving under this lane
// turns the file stale LOUDLY, never silently.

const MIGDIR = join(process.cwd(), 'supabase', 'migrations')
const migFile = readdirSync(MIGDIR).filter(f => /_portal_accepted_version\.sql$/.test(f)).sort().at(-1)
check('the accepted-version migration exists', !!migFile, 'no *_portal_accepted_version.sql in the apply path')
if (migFile) {
  const mig = readFileSync(join(MIGDIR, migFile), 'utf8')
  const defs = [...mig.matchAll(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TABLE|VIEW|TRIGGER|POLICY|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/gi)]
  check('it contains exactly ONE definition, and it is get_portal_data',
    defs.length === 1 && /public\.get_portal_data/.test(defs[0][3]),
    defs.map(d => d[0]).join(' | ') || 'none')
  check('it drops and alters nothing',
    !/\b(DROP|ALTER)\s+(FUNCTION|TABLE|TRIGGER|POLICY|VIEW)\b/i.test(mig))
  // The five passengers of the original incident, by name — a tombstone check.
  for (const fn of ['guard_business_settings_owner', 'guard_lawn_sqft_writer', 'guard_technician_auth_link', 'handle_updated_at', 'inbox_counts']) {
    check(`it does not define ${fn}`, !new RegExp(`FUNCTION\\s+public\\.${fn}`, 'i').test(mig))
  }

  // ⭐⭐ THE BYTE-DELTA: migration body minus the marked projection must equal the
  // CURRENT baseline's function, byte for byte. This is the S113 landing
  // property made executable — the day main moves get_portal_data (publication
  // gate or anything else), this goes red and the fix is `npx tsx
  // scripts/schema/generate-portal-accepted-version.ts`, never a hand edit.
  const baseline = latestBaseline()
  const baselineFn = extractPortalFn(readFileSync(join(MIGDIR, baseline), 'utf8'))
  const migFn = extractPortalFn(mig)
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const stripped = migFn.replace(new RegExp(`,\\r?\\n\\s*${esc(MARK_START)}[\\s\\S]*?${esc(MARK_END)}`), '')
  check(`stripped of its markers, the migration is byte-identical to ${baseline}'s function`,
    stripped === baselineFn,
    'the baseline moved (S113?) or the file was hand-edited — REGENERATE: npx tsx scripts/schema/generate-portal-accepted-version.ts')
  check('the projection block is present exactly once, marked',
    migFn.split(MARK_START).length === 2 && migFn.split(MARK_END).length === 2
    && /order by a\.seq desc limit 1\) as acceptance/.test(migFn))
  check('needs_reapproval is DERIVED in the projection, never stored',
    /public\.quote_material_fingerprint\(qt\.id\) is distinct from a\.document_fingerprint/.test(migFn))
  check('the projection exposes the evidence kind and no actor internals',
    /'kind',\s+a\.kind,/.test(migFn)
    && !/actor_id|on_behalf_note|actor_label/.test(migFn.slice(migFn.indexOf(MARK_START), migFn.indexOf(MARK_END))))

  // Named privacy predicates, asserted on the MIGRATION body itself.
  const sqlOnly = migFn.split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n')
  check('draft-QUOTE privacy survives',
    /from public\.quotes qt where qt\.customer_id = v_customer and qt\.user_id = v_user and qt\.status <> 'draft'/.test(sqlOnly))
  check('draft-INVOICE privacy survives',
    /from public\.invoices where customer_id = v_customer and user_id = v_user and status <> 'draft'/.test(sqlOnly))
  check('internal job notes and completion issues stay out of the payload',
    !/\binternal_notes\b|\bcompletion_issue\b/.test(sqlOnly))
  check('tenant filters survive on the customer row',
    /from public\.customers where id = v_customer and user_id = v_user/.test(sqlOnly))
  // S113 forward-arm: the day the baseline's services block gains a publication
  // gate, the byte-delta above forces regeneration and THIS check starts
  // asserting the migration carries it too.
  const baselineHasPublication = /is_published/.test(baselineFn)
  check(baselineHasPublication
    ? 'the S113 publication gate survives into the migration'
    : 'publication gate not yet on main (S113 unlanded) — byte-delta stands watch',
    baselineHasPublication ? /is_published/.test(sqlOnly) : true)
}

// ═════════════════════════════════════════════════════════════════════════════
async function behaviour() {
  console.log('\n═══ 6. Behaviour — an empty Postgres built from this repository ═══')
  const pglite = await loadPGlite()
  if (!pglite) {
    console.log('  ⏭  SKIPPED — PGlite is not installed (this is the behavioural proof).')
    return
  }
  const { PGlite, contribs } = pglite
  const db = await PGlite.create({ extensions: contribs })
  const apply = async (label: string, rawSql: string) => {
    const { sql } = substitutePlatformStatements(rawSql)
    const statements = splitStatements(sql)
    let n = 0
    try { for (const s of statements) { await db.exec(s + ';'); n++ }; return true }
    catch (e: unknown) {
      fail(`applied ${label}`, `statement ${n + 1}/${statements.length}: ${String((e as Error).message).slice(0, 240)}`)
      return false
    }
  }
  if (!await apply('platform prelude', read(join('scripts', 'schema', 'platform-prelude.sql')))) return
  for (const f of readdirSync(MIGDIR).filter(f => f.endsWith('.sql')).sort()) {
    if (!await apply(f, read(join('supabase', 'migrations', f)))) return
  }
  ok('the portal projection applies from zero, on top of the baseline')

  // PG18 fixture accommodation — see verify-quote-acceptance-integrity: REPLICA
  // IDENTITY FULL + publication + generated columns refuses UPDATEs on PG18
  // (PGlite); production is PG17. Relaxed for the fixture only.
  const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Record<string, unknown>[]
  const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0] as Record<string, any>
  const blocked = await rows(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relreplident = 'f'
       and exists (select 1 from pg_publication_tables pt where pt.schemaname = 'public' and pt.tablename = c.relname)
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attgenerated <> '' and not a.attisdropped)`)
  for (const t of blocked) await db.exec(`alter table public."${t.relname}" replica identity default`)

  const refused = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    try { await db.query(sql, params); return null } catch (e: unknown) { return String((e as Error).message) }
  }

  const OWNER = '00000000-0000-0000-0000-0000000000d1'
  const svc = () => db.exec(`set request.jwt.claims = '{"role":"service_role"}'`)
  const anon = () => db.exec(`set request.jwt.claims = '{"role":"anon"}'`)
  await svc()
  await db.exec(`insert into auth.users (id, email) values ('${OWNER}', 'owner@fixture.test')`)
  await db.exec(`insert into public.business_settings (user_id, company_name, owner_name, terms_text)
    values ('${OWNER}', 'Fixture Yard', 'Sam Owner', 'Payment due on completion.')`)
  const cust = await one(`insert into public.customers (user_id, name) values ('${OWNER}', 'Dana Reyes') returning id`)
  await db.exec(`insert into public.customer_portal_tokens (token, customer_id, user_id) values ('tok-truth', '${cust.id}', '${OWNER}')`)
  const mkQuote = async (qn: string) => one(`insert into public.quotes
      (user_id, customer_id, quote_number, customer_name, address, service_type, initial_price, travel_fee, status)
    values ('${OWNER}', '${cust.id}', '${qn}', 'Dana Reyes', '12 Elm St', 'Lawn care', 5400, 150, 'sent') returning *`)

  const payload = async () => (await one(`select public.get_portal_data('tok-truth') as d`)).d as {
    quotes: { id: string; total: number; acceptance: null | {
      accepted_at: string; kind: string; accepted_amount: number | string
      document: Record<string, unknown>; terms_text: string | null; needs_reapproval: boolean
    } }[]
  }
  const accOf = async (qid: string) => (await payload()).quotes.find(x => x.id === qid)!

  // ── A · the CUSTOMER accepts through their own door ────────────────────────
  const qA = await mkQuote('Q-9001')
  await anon()
  const a1 = await one(`select public.portal_accept_quote('tok-truth', $1, null, null, true) as ok`, [qA.id])
  await svc()
  check('A: the customer accepted', a1.ok === true)
  let pa = await accOf(qA.id)
  check('A: the payload carries kind=customer with the snapshot and exact terms',
    pa.acceptance?.kind === 'customer' && pa.acceptance?.document?.quote_number === 'Q-9001'
    && pa.acceptance?.terms_text === 'Payment due on completion.' && pa.acceptance?.needs_reapproval === false)
  const docBefore = JSON.stringify(pa.acceptance?.document)

  // ── B · the OWNER records an acceptance on the customer's behalf ───────────
  const qB = await mkQuote('Q-9002')
  await db.exec(`set request.jwt.claims = '{"role":"authenticated","sub":"${OWNER}"}'`)
  await db.exec(`set request.jwt.claim.sub = '${OWNER}'`)
  const b1 = await one(`select public.owner_record_customer_acceptance($1, 'phone', null, null, null) as id`, [qB.id])
  await svc()
  check('B: the owner recorded it', !!b1.id)
  const pb = await accOf(qB.id)
  check('B: the payload carries kind=owner_on_behalf — never dressed as a customer act',
    pb.acceptance?.kind === 'owner_on_behalf' && pb.acceptance?.needs_reapproval === false)
  check('B: no actor internals ride the payload',
    !('actor_id' in (pb.acceptance ?? {})) && !('on_behalf_note' in (pb.acceptance ?? {})) && !('actor_label' in (pb.acceptance ?? {})))

  // ── C · a LEGACY row, exactly as the backfill wrote them ───────────────────
  const qC = await mkQuote('Q-9003')
  await db.exec(`update public.quotes set status = 'accepted' where id = '${qC.id}'`)
  await db.exec(`insert into public.quote_acceptances
      (user_id, quote_id, customer_id, kind, source, actor_type, accepted_amount,
       document, document_fingerprint, terms_required, terms_acknowledged)
    select '${OWNER}', '${qC.id}', '${cust.id}', 'legacy_unrecorded', 'migration', 'system', 5550,
       jsonb_build_object('quote_number','Q-9003','total',5550), public.quote_material_fingerprint('${qC.id}'), false, false`)
  const pc = await accOf(qC.id)
  check('C: the payload carries kind=legacy_unrecorded, standing, terms NULL',
    pc.acceptance?.kind === 'legacy_unrecorded' && pc.acceptance?.needs_reapproval === false
    && pc.acceptance?.terms_text == null)
  await db.exec(`update public.quotes set initial_price = 6000 where id = '${qC.id}'`)
  check('C: a material change flags a legacy record for reapproval exactly like a real one',
    (await accOf(qC.id)).acceptance?.needs_reapproval === true)

  // ── D · revision drifts, evidence holds ────────────────────────────────────
  await db.exec(`update public.quotes set initial_price = 6075 where id = '${qA.id}'`)
  await db.exec(`update public.business_settings set terms_text = 'ALL SALES FINAL.' where user_id = '${OWNER}'`)
  pa = await accOf(qA.id)
  check('D: a revision flips needs_reapproval — derived, not stored', pa.acceptance?.needs_reapproval === true)
  check('D: the historical document did NOT move with the revision', JSON.stringify(pa.acceptance?.document) === docBefore)
  check('D: the accepted amount is still the consented figure', Number(pa.acceptance?.accepted_amount) === 5550)
  check('D: …while the live row now says something else', Number(pa.total) === 6225,
    `live total ${pa.total} — equal would mean the test mutated nothing`)
  check('D: the stored terms ignore today\'s settings', pa.acceptance?.terms_text === 'Payment due on completion.')
  await db.exec(`update public.quotes set initial_price = 5400 where id = '${qA.id}'`)
  check('D: reverting the material change clears needs_reapproval by derivation',
    (await accOf(qA.id)).acceptance?.needs_reapproval === false)

  // ── history cannot be rewritten ────────────────────────────────────────────
  const upd = await refused(`update public.quote_acceptances set document = '{}'::jsonb where quote_id = $1`, [qA.id])
  check('overwriting the historical document is refused', upd !== null && /append-only/.test(upd), upd ?? 'the UPDATE went through')
  const del = await refused(`delete from public.quote_acceptances where quote_id = $1`, [qA.id])
  check('deleting acceptance evidence is refused', del !== null && /append-only/.test(del), del ?? 'the DELETE went through')

  // ── E · re-acceptance ADDS; the first document stays byte-identical ────────
  await db.exec(`update public.quotes set initial_price = 6075, status = 'sent' where id = '${qA.id}'`)
  await anon()
  const a2 = await one(`select public.portal_accept_quote('tok-truth', $1, null, null, true) as ok`, [qA.id])
  await svc()
  check('E: the customer re-accepted the revision', a2.ok === true)
  const hist = await rows(`select seq, document, supersedes_id from public.quote_acceptances where quote_id = $1 order by seq`, [qA.id])
  check('E: the record now holds TWO acceptances, chained by supersedes',
    hist.length === 2 && hist[1].supersedes_id != null)
  check('E: the first document is byte-identical to what it always was',
    JSON.stringify(hist[0]?.document) === docBefore)
  check('E: the payload now presents the LATEST acceptance',
    Number((await accOf(qA.id)).acceptance?.accepted_amount) === 6225)
}

behaviour().then(() => {
  console.log('\n── Summary ────────────────────────────────────────────────────')
  if (failures) {
    console.log(`\n❌ verify:accepted-document-truth — ${failures} failure${failures === 1 ? '' : 's'}\n`)
    process.exit(1)
  }
  console.log('\n✅ verify:accepted-document-truth — the ledger\'s document, in the evidence\'s own words, at every door\n')
}).catch(e => { console.error(e); process.exit(1) })
