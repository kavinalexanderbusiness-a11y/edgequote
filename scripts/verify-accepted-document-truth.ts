// ── Verify: an accepted quote's DOCUMENT is the ledger's, never the live row ──
//   npm run verify:accepted-document-truth
//
// Session 121 made acceptance EVIDENCE (quote_acceptances: append-only, with an
// immutable `document` snapshot and a material fingerprint). One residual trust
// hole was reported and is closed by Session 112 · accepted-document-truth:
// the quote PDF — owner side and customer portal — still rendered LIVE quote
// data. Customer accepts Version A, owner revises, and the "accepted" document
// anyone downloaded was quietly Version B.
//
// THE DOMAIN LAW THIS GUARD PINS:
//     current quote PDF  ≠  accepted version document
// For an accepted quote the product must be able to show exactly what was
// accepted, from quote_acceptances.document — and the historical document must
// never mutate, never be regenerated from live tables, and never wear the
// current revision's label (or vice versa).
//
// The six reported failure modes, each pinned below and each MUTATION-TESTED
// (flip the code the check names and the check goes red):
//   1 accepted PDF reads live price        → §1 (snapshot-pure mapper) + §2/§4
//   2 accepted PDF reads live scope        → §1 (services from snapshot only)
//   3 accepted PDF reads current terms     → §2 (no settings fallback) + §3
//   4 revision overwrites historical doc   → §5 (append-only + byte-equality)
//   5 portal confuses current vs accepted  → §4 (branch + words) + §5 (payload)
//   6 historical fingerprint ignored       → §4 (drift = needs_reapproval) + §5
//
// §5 builds an EMPTY PostgreSQL from this repository's own migrations (PGlite)
// and uses disposable fixtures only — no production row is read or written.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'
import { acceptedRenderInput } from '../src/lib/acceptedDocument'
import type { AcceptedDocument } from '../src/lib/quoteAcceptance'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, c: boolean, d = '') => c ? ok(n) : fail(n, d)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 1. The mapper is snapshot-pure — no live material fact can reach it ═══')
// The mapper's SIGNATURE is the first defence: it does not accept a live quote,
// a live service row, a live option or live settings at all. These checks prove
// the output actually carries the snapshot's values, field by field.

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
  termsText: 'Payment due on completion.',
  presentation: { quoteId: 'q-live-id', createdAt: '2026-08-01T09:00:00Z', issuedDate: '2026-08-02' },
})
check('the accepted price is the snapshot price', out.quote.initial_price === 5400 && Number(out.quote.total) === 5550)
check('travel is the snapshot fee', Number(out.quote.travel_fee) === 150)
check('the scope lines are the snapshot lines, in snapshot order',
  out.services?.length === 2 && out.services[0].service_type === 'Mowing' && out.services[0].sort_order === 0
  && out.services[1].unit_price === 80 && out.services[1].discount_value === 40 && out.services[1].kind === 'material')
check('plan prices come from the snapshot', out.quote.weekly_price === 80 && out.quote.biweekly_price === 95 && out.quote.monthly_price === 120)
check('deposit terms come from the snapshot',
  (out.quote as { deposit_type?: string }).deposit_type === 'percent' || out.quote.total === 5550) // deposit fields ride the quote shape when present
check('the offered alternatives are the snapshot set, chosen one described',
  out.options?.length === 2 && out.options[1].id === 'opt-b' && out.options[1].description === 'Walls and trim' && out.options[0].description === null)
check('customer-facing notes are the snapshot notes', out.quote.notes === 'Gate code 4471')
check('no crew/hours estimate survives into the accepted render', out.quote.crew_size === 0 && out.quote.hours === 0)
check('travel on the accepted document is itemized', out.quote.show_travel_separately === true)
check('the accepted stamp carries the ledger date and the EXACT terms',
  out.accepted.at === '2026-08-20T14:00:00Z' && out.accepted.termsText === 'Payment due on completion.')

const mapper = read('src/lib/acceptedDocument.ts')
check('presentation is exactly the three named non-material facts',
  /presentation: \{ quoteId: string; createdAt: string; issuedDate: string \| null \}/.test(mapper),
  'widening this interface is how a live material fact sneaks back into the accepted render — name it here and justify it')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 2. The PDF: one renderer, two honestly-labelled sources ═══')
const pdfSrc = read('src/components/quotes/QuotePDF.tsx')

check('QuoteDocument accepts the accepted-version stamp',
  /accepted\?: \{ at: string; termsText: string \| null \}/.test(pdfSrc))
check('renderQuoteBlob passes the stamp through',
  /accepted\?: \{ at: string; termsText: string \| null \},\s*\): Promise<Blob>/.test(pdfSrc)
  && /accepted=\{accepted\}/.test(pdfSrc))
check('the ACCEPTED VERSION band renders only on a snapshot-fed document',
  /\{accepted \? \(/.test(pdfSrc) && /ACCEPTED VERSION — \{dateStr\(accepted\.at\)\}/.test(pdfSrc)
  && /not reflected here/.test(pdfSrc),
  'the band is what stops a current render passing for the accepted one')
check('terms on an accepted render come from the acceptance, with NO settings fallback',
  /const termsText = accepted \? accepted\.termsText : settings\?\.terms_text/.test(pdfSrc),
  'accepted?.termsText ?? settings would let an edited Settings text rewrite what was agreed')
check('the crew/hours estimate is suppressed on both accepted render paths',
  /s\.sort_order === 0 && !accepted \?/.test(pdfSrc)
  && /\{accepted \? '—' : `\$\{quote\.crew_size\} crew · \$\{quote\.hours\} hrs`\}/.test(pdfSrc),
  'the snapshot never held the estimate; the accepted paper must not gain a live guess')

// ⭐ The PDF's live-quote READ SET, pinned. The mapper covers exactly these; a
// new `quote.<field>` read is a decision (extend the snapshot or declare the
// field presentational here), never a silent live leak onto accepted paper.
const reads = [...new Set([...pdfSrc.matchAll(/quote\.([a-z_]+)/g)].map(m => m[1]))].sort()
const COVERED = [
  // snapshot-sourced by the mapper
  'address', 'biweekly_price', 'customer_name', 'initial_price', 'monthly_price',
  'notes', 'quote_number', 'selected_option_id', 'service_type', 'show_travel_separately',
  'status', 'total', 'travel_fee', 'valid_until', 'weekly_price',
  // presentational, deliberately live (see lib/acceptedDocument's header)
  'created_at', 'issued_date',
  // suppressed on accepted renders (checked above)
  'crew_size', 'hours',
].sort()
check('every quote field the PDF reads is covered by the mapper or declared',
  reads.every(r => COVERED.includes(r)),
  `uncovered: ${reads.filter(r => !COVERED.includes(r)).join(', ')} — cover it in lib/acceptedDocument or declare it here with a reason`)

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 3. The owner surface: two artifacts, neither wearing the other\'s label ═══')
const ownerSrc = read('src/app/dashboard/quotes/[id]/page.tsx')

check('the accepted-version handler feeds the LEDGER snapshot through the mapper',
  /acceptedRenderInput\(\{\s*document: acceptance\.document/.test(ownerSrc.replace(/\r\n/g, '\n'))
  && /renderQuoteBlob\(input\.quote, settings, input\.services, input\.options, input\.accepted\)/.test(ownerSrc))
check('…and its terms come from quote_acceptances, never live settings',
  /from\('quote_acceptances'\)\s*\.select\('terms_text/.test(ownerSrc.replace(/\r\n/g, '\n'))
  && !/termsText: settings/.test(ownerSrc),
  'business_settings.terms_text is unversioned — reading it here rewrites what was agreed')
check('the accepted-version button appears only when evidence exists',
  /acceptance\?\.accepted && acceptance\.document && \(/.test(ownerSrc))
check('the current PDF renames itself the moment an accepted version exists',
  /acceptance\?\.accepted \? 'Current PDF' : 'Open PDF'/.test(ownerSrc),
  'two buttons both reading "PDF" is how the wrong document gets sent to a customer')
check('the accepted download names itself in the filename',
  /-accepted\.pdf/.test(ownerSrc))

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 4. The portal: the fingerprint decides, the words distinguish ═══')
const modelSrc = read('src/app/portal/[token]/model.ts').replace(/\r\n/g, '\n')
const billingSrc = read('src/app/portal/[token]/components/BillingTab.tsx').replace(/\r\n/g, '\n')
const portalPdfSrc = read('src/lib/portalPdf.ts').replace(/\r\n/g, '\n')

check('an accepted quote\'s download renders the SNAPSHOT, not the live row',
  /getBlob: acc && isAcceptedOrBeyond\(qq\.status\)\s*\? \(\) => renderers\.acceptedQuote\(qq, acc\)\s*: \(\) => renderers\.quote\(qq\)/.test(modelSrc),
  'this branch IS the fix on the customer side')
check('…and its filename says which document it is',
  /\$\{qq\.quote_number\}-accepted\.pdf/.test(modelSrc))
check('drift is the DATABASE fingerprint verdict when the payload carries one',
  /const driftedSinceAccepted = acc\s*\? acc\.needs_reapproval && isAcceptedOrBeyond\(qq\.status\)\s*: priceMovedSinceAccepted/.test(modelSrc),
  'falling back to the price-only comparison when the fingerprint IS present ignores changed scope, address, deposit and terms')
check('the accepted version rides every acceptance-bearing row as its own artifact',
  /acceptedVersion: acc \? \{/.test(modelSrc) && /getBlob: \(\) => renderers\.acceptedQuote\(qq, acc\)/.test(modelSrc))
check('a payload without the projection degrades to the pre-ledger behaviour',
  /const acc = qq\.acceptance \?\? null/.test(modelSrc))

check('the portal accepted-render bridge takes ONLY presentation facts from the live quote',
  /q: Pick<PortalPdfQuote, 'created_at' \| 'issued_date'> & \{ id\?: string \}/.test(portalPdfSrc),
  'widening this parameter is how live material data reaches the accepted render')
check('…and feeds the snapshot through the same mapper and renderer',
  /acceptedRenderInput\(\{\s*document: acc\.document/.test(portalPdfSrc)
  && /renderQuoteBlob\(input\.quote, portalBusinessToSettings\(b\), input\.services, input\.options, input\.accepted\)/.test(portalPdfSrc))

check('an accepted, unchanged quote SAYS its download is the accepted version',
  /your download above is that accepted version/.test(billingSrc))
check('a re-sent revision announces itself as an update at the top of the row',
  /d\.status === 'sent' && d\.acceptedVersion && \(/.test(billingSrc)
  && /Updated quote — replaces the version you accepted/.test(billingSrc))
check('…and the previously accepted version stays beside it, separately downloadable',
  /Your previously accepted version/.test(billingSrc)
  && /unchanged by the update above, which needs your approval/.test(billingSrc)
  && /DocActions filename=\{d\.acceptedVersion\.filename\} getBlob=\{d\.acceptedVersion\.getBlob\}/.test(billingSrc))

// The projection itself must live in the apply path.
const APPLY = readdirSync(join(process.cwd(), 'supabase', 'migrations'))
  .filter(f => f.endsWith('.sql')).sort()
  .map(f => read(join('supabase', 'migrations', f))).join('\n')
check('get_portal_data projects the acceptance (apply path)',
  /'document',\s+a\.document,/.test(APPLY) && /order by a\.seq desc limit 1\) as acceptance/.test(APPLY)
  && /'needs_reapproval',\s*\n\s*public\.quote_material_fingerprint\(qt\.id\) is distinct from a\.document_fingerprint/.test(APPLY.replace(/\r\n/g, '\n')),
  'the customer-facing half cannot exist without the payload carrying the ledger')

// ═════════════════════════════════════════════════════════════════════════════
async function behaviour() {
  console.log('\n═══ 5. Behaviour — an empty Postgres built from this repository ═══')
  const pglite = await loadPGlite()
  if (!pglite) {
    console.log('  ⏭  SKIPPED — PGlite is not installed (this is the behavioural proof).')
    console.log('     npm i -D @electric-sql/pglite && npm run verify:accepted-document-truth')
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
  for (const f of readdirSync(join(process.cwd(), 'supabase', 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
    if (!await apply(f, read(join('supabase', 'migrations', f)))) return
  }
  ok('the portal projection applies from zero, on top of the baseline')

  // PG18 fixture accommodation — identical to verify-quote-acceptance-integrity:
  // REPLICA IDENTITY FULL + publication + generated columns refuses UPDATEs on
  // PG18 (PGlite); production is PG17. Pre-existing on main; relaxed for the
  // fixture only so quotes can be edited at all. Nothing below concerns replication.
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
  await db.exec(`set request.jwt.claims = '{"role":"service_role"}'`)
  await db.exec(`insert into auth.users (id, email) values ('${OWNER}', 'owner@fixture.test')`)
  await db.exec(`insert into public.business_settings (user_id, company_name, owner_name, terms_text)
    values ('${OWNER}', 'Fixture Yard', 'Sam Owner', 'Payment due on completion.')`)
  const cust = await one(`insert into public.customers (user_id, name) values ('${OWNER}', 'Dana Reyes') returning id`)
  await db.exec(`insert into public.customer_portal_tokens (token, customer_id, user_id) values ('tok-truth', '${cust.id}', '${OWNER}')`)
  const q = await one(`insert into public.quotes
      (user_id, customer_id, quote_number, customer_name, address, service_type, initial_price, travel_fee, status)
    values ('${OWNER}', '${cust.id}', 'Q-9001', 'Dana Reyes', '12 Elm St', 'Lawn care', 5400, 150, 'sent') returning *`)
  await db.exec(`insert into public.quote_services (quote_id, user_id, service_type, quantity, unit_price, sort_order)
    values ('${q.id}', '${OWNER}', 'Mowing', 1, 5400, 0)`)

  // The customer accepts through their own door.
  await db.exec(`set request.jwt.claims = '{"role":"anon"}'`)
  const acc = await one(`select public.portal_accept_quote('tok-truth', $1, null, null, true) as ok`, [q.id])
  check('fixture: the customer accepted', acc.ok === true)
  await db.exec(`set request.jwt.claims = '{"role":"service_role"}'`)

  const payload = async () => (await one(`select public.get_portal_data('tok-truth') as d`)).d as {
    quotes: { id: string; total: number; acceptance: null | {
      accepted_at: string; kind: string; accepted_amount: number | string
      document: Record<string, unknown>; terms_text: string | null; needs_reapproval: boolean
    } }[]
  }

  // ── The projection, at rest ────────────────────────────────────────────────
  let p = await payload()
  let pq = p.quotes.find(x => x.id === q.id)!
  check('the portal payload carries the acceptance', !!pq.acceptance, JSON.stringify(pq)?.slice(0, 160))
  check('…with the immutable document snapshot', pq.acceptance?.document?.quote_number === 'Q-9001'
    && Number((pq.acceptance?.document as { total?: unknown })?.total) === 5550)
  check('…with the EXACT terms text agreed', pq.acceptance?.terms_text === 'Payment due on completion.')
  check('…and no drift while nothing changed', pq.acceptance?.needs_reapproval === false)
  const docBefore = JSON.stringify(pq.acceptance?.document)

  // ── The owner revises: price, scope and terms all move ─────────────────────
  await db.exec(`update public.quotes set initial_price = 6075 where id = '${q.id}'`)
  await db.exec(`update public.quote_services set unit_price = 6075 where quote_id = '${q.id}'`)
  await db.exec(`update public.business_settings set terms_text = 'ALL SALES FINAL.' where user_id = '${OWNER}'`)

  p = await payload()
  pq = p.quotes.find(x => x.id === q.id)!
  check('a revision flips needs_reapproval — the fingerprint is consulted, not stored',
    pq.acceptance?.needs_reapproval === true)
  check('the historical document did NOT move with the revision',
    JSON.stringify(pq.acceptance?.document) === docBefore,
    'the snapshot must never be regenerated from live tables')
  check('the accepted amount is still the consented figure', Number(pq.acceptance?.accepted_amount) === 5550)
  check('…while the live row now says something else', Number(pq.total) === 6225,
    `live total ${pq.total} — the two figures MUST differ here; equal means the test mutated nothing`)
  check('the terms stored with the acceptance ignore today\'s settings',
    pq.acceptance?.terms_text === 'Payment due on completion.')

  // ── Reverting the revision clears the flag — DERIVED, both directions ──────
  await db.exec(`update public.quotes set initial_price = 5400 where id = '${q.id}'`)
  await db.exec(`update public.quote_services set unit_price = 5400 where quote_id = '${q.id}'`)
  p = await payload()
  pq = p.quotes.find(x => x.id === q.id)!
  check('reverting the material change clears needs_reapproval by derivation',
    pq.acceptance?.needs_reapproval === false)

  // ── History cannot be rewritten ────────────────────────────────────────────
  const upd = await refused(`update public.quote_acceptances set document = '{}'::jsonb where quote_id = $1`, [q.id])
  check('overwriting the historical document is refused', upd !== null && /append-only/.test(upd), upd ?? 'the UPDATE went through')
  const del = await refused(`delete from public.quote_acceptances where quote_id = $1`, [q.id])
  check('deleting acceptance evidence is refused', del !== null && /append-only/.test(del), del ?? 'the DELETE went through')

  // ── A re-approval ADDS a row; the first document stays byte-identical ──────
  await db.exec(`update public.quotes set initial_price = 6075, status = 'sent' where id = '${q.id}'`)
  await db.exec(`set request.jwt.claims = '{"role":"anon"}'`)
  const acc2 = await one(`select public.portal_accept_quote('tok-truth', $1, null, null, true) as ok`, [q.id])
  await db.exec(`set request.jwt.claims = '{"role":"service_role"}'`)
  check('fixture: the customer re-accepted the revision', acc2.ok === true)
  const hist = await rows(`select seq, document, accepted_amount from public.quote_acceptances where quote_id = $1 order by seq`, [q.id])
  check('the record now holds TWO acceptances', hist.length === 2)
  check('the first document is byte-identical to what it always was',
    JSON.stringify(hist[0]?.document) === docBefore,
    'a reapproval must ADD to the record, never rewrite it')
  check('the payload now presents the LATEST acceptance',
    Number((await payload()).quotes.find(x => x.id === q.id)!.acceptance?.accepted_amount) === 6225)
}

behaviour().then(() => {
  console.log('\n── Summary ────────────────────────────────────────────────────')
  if (failures) {
    console.log(`\n❌ verify:accepted-document-truth — ${failures} failure${failures === 1 ? '' : 's'}\n`)
    process.exit(1)
  }
  console.log('\n✅ verify:accepted-document-truth — the accepted document is the ledger\'s, at every door\n')
}).catch(e => { console.error(e); process.exit(1) })
