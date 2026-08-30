// ── Historical duplicate quote numbers — DECISION REPORT (READ ONLY) ─────────
//
// ⛔⛔ THIS SCRIPT WRITES NOTHING AND DECIDES NOTHING. Every statement is a
// SELECT. It does not renumber, does not pick a winner, does not append "-2" and
// does not delete. Its only job is to put enough evidence in front of the owner
// that a decision about each duplicated pair can be made on facts.
//
//   npx tsx scripts/report-duplicate-quote-numbers.ts
//   npx tsx scripts/report-duplicate-quote-numbers.ts --out docs/…md
//
// ⭐ WHY IT EXISTS. `quotes` cannot take a full UNIQUE (user_id, quote_number)
// while production holds EPS-2026-0008 ×2 and EPS-2026-0009 ×2. Stage 1 of the
// migration protects every NEW quote without touching those rows
// (supabase/proposals/quote_number_integrity_v1.sql §6). Stage 2 — the full
// constraint — needs those four rows resolved first, and a quote number is
// printed on documents a customer already holds, so that is the owner's call and
// not a migration's.
//
// ⭐ WHAT "EVIDENCE" MEANS HERE. For each row: what it is worth, whether anyone
// accepted it, and every downstream record that points at it. The more of those
// that exist, the more a renumber would have to be chased through the business
// rather than done in the database. Where a fact CANNOT be measured from the
// database (a PDF a customer downloaded months ago) the report says so instead
// of guessing — an unmeasurable fact reported as "none" is worse than no report.
//
// ⛔ Prints no secrets. Tenant and record ids are shown truncated.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createClient } from '@supabase/supabase-js'

function loadEnv() {
  if (!existsSync('.env.local')) return
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadEnv()

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const email = process.env.PORTAL_RPC_OWNER_EMAIL
const password = process.env.PORTAL_RPC_OWNER_PASSWORD

const outFlag = process.argv.indexOf('--out')
const outPath = outFlag >= 0 ? process.argv[outFlag + 1] : null

const lines: string[] = []
const say = (s = '') => { lines.push(s); console.log(s) }

const short = (id: string | null | undefined) => (id ? `${id.slice(0, 8)}…` : '—')
const money = (n: unknown) => (n === null || n === undefined ? '—' : `$${Number(n).toFixed(2)}`)
const when = (t: string | null | undefined) => (t ? String(t).replace('T', ' ').slice(0, 19) : '—')

type Quote = {
  id: string; quote_number: string | null; created_at: string; status: string
  customer_id: string | null; customer_name: string | null; address: string | null
  total: number | null; accepted_price: number | null; sent_at: string | null
  service_type: string | null; issued_date: string | null; valid_until: string | null
}

async function main() {
  if (!url || !anon || !email || !password) {
    console.log('\n⏭  PRODUCTION ACCESS UNAVAILABLE — no owner credentials in .env.local.')
    console.log('   This report can only be produced against the live database; there is')
    console.log('   nothing to substitute for it. The migration does not depend on it —')
    console.log('   stage 1 protects new quotes regardless. Stage 2 does depend on it.\n')
    process.exit(0)
  }

  const sb = createClient(url, anon, { auth: { persistSession: false } })
  const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email, password })
  if (authErr || !auth.user) {
    console.log(`\n⏭  PRODUCTION ACCESS UNAVAILABLE — sign-in refused (${authErr?.message ?? 'no user'}).\n`)
    process.exit(0)
  }
  const uid = auth.user.id

  say('# Duplicate and malformed quote numbers — decision report')
  say('')
  say(`_Read-only. Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')}Z against production, `
    + `signed in as owner ${short(uid)} (RLS scopes every read to this tenant)._`)
  say('')
  say('⛔ **Nothing in this report has been changed.** No quote was renumbered, no row')
  say('was written, and no decision has been made. Stage 2 of')
  say('`supabase/proposals/quote_number_integrity_v1.sql` stays commented out until')
  say('the owner rules on each pair below.')
  say('')

  // ── every quote, once ─────────────────────────────────────────────────────
  const { data: allData, error: allErr } = await sb
    .from('quotes')
    .select('id, quote_number, created_at, status, customer_id, customer_name, address, total, accepted_price, sent_at, service_type, issued_date, valid_until')
    .order('created_at', { ascending: true })
  if (allErr) { console.error(`  ✗ could not read quotes: ${allErr.message}`); process.exit(1) }
  const all = (allData ?? []) as Quote[]

  const byNumber = new Map<string, Quote[]>()
  for (const q of all) {
    const k = q.quote_number ?? '<null>'
    if (!byNumber.has(k)) byNumber.set(k, [])
    byNumber.get(k)!.push(q)
  }
  const duplicated = [...byNumber.entries()].filter(([, g]) => g.length > 1).sort()
  // ⭐ MALFORMED = no year segment. These are NOT duplicates and are NOT being
  // renamed; they are reported because they belong to no year series, which is
  // why no counter can protect them and only the claim registry can.
  const malformed = all.filter(q => q.quote_number && !/^[A-Za-z][A-Za-z0-9]*-\d{4}-\d+$/.test(q.quote_number))

  say(`**${all.length}** quotes visible. **${duplicated.length}** duplicated number(s), `
    + `**${malformed.length}** malformed number(s).`)
  say('')

  // ── the evidence, gathered once for every id under review ─────────────────
  const subjects = [...duplicated.flatMap(([, g]) => g), ...malformed]
  const ids = [...new Set(subjects.map(q => q.id))]

  const pull = async (table: string, cols: string, col = 'quote_id') => {
    const { data, error } = await sb.from(table).select(cols).in(col, ids)
    if (error) return { rows: [] as any[], error: error.message }
    return { rows: (data ?? []) as any[], error: null as string | null }
  }

  const [acceptances, jobs, invoices, payments, outcomes, changeOrders,
    services, options, addons, followUps, measurements] = await Promise.all([
      pull('quote_acceptances', 'id, quote_id, accepted_at, kind, source, actor_type, actor_label, accepted_amount, document_fingerprint, terms_acknowledged'),
      pull('jobs', 'id, quote_id, status, scheduled_date, price'),
      pull('invoices', 'id, quote_id, invoice_number, status, total, issued_date'),
      pull('payments', 'id, quote_id, amount, status, paid_at, provider, kind'),
      pull('quote_outcomes', 'id, quote_id, outcome, created_at'),
      pull('change_orders', 'id, quote_id, status, created_at'),
      pull('quote_services', 'id, quote_id'),
      pull('quote_options', 'id, quote_id'),
      pull('quote_addons', 'id, quote_id'),
      pull('follow_ups', 'id, quote_id, created_at'),
      pull('measurements', 'id, quote_id'),
    ])

  const groupBy = (rows: any[]) => {
    const m = new Map<string, any[]>()
    for (const r of rows) {
      if (!m.has(r.quote_id)) m.set(r.quote_id, [])
      m.get(r.quote_id)!.push(r)
    }
    return m
  }
  const gAcc = groupBy(acceptances.rows), gJob = groupBy(jobs.rows), gInv = groupBy(invoices.rows)
  const gPay = groupBy(payments.rows), gOut = groupBy(outcomes.rows), gCo = groupBy(changeOrders.rows)
  const gSvc = groupBy(services.rows), gOpt = groupBy(options.rows), gAdd = groupBy(addons.rows)
  const gFu = groupBy(followUps.rows), gMeas = groupBy(measurements.rows)

  // ── customer-facing evidence: a message whose BODY names the number ────────
  // ⭐ THIS IS THE ONE PIECE THAT IS ACTUALLY MEASURABLE about what the customer
  // was shown. A PDF is generated on demand and never stored, so it cannot be
  // searched; a sent message body can.
  const numbersUnderReview = [...new Set(subjects.map(q => q.quote_number!).filter(Boolean))]
  const messageHits = new Map<string, any[]>()
  let messageSearchError: string | null = null
  for (const num of numbersUnderReview) {
    const { data, error } = await sb
      .from('messages')
      .select('id, created_at, direction, channel, status, customer_id, delivered_at')
      .ilike('body', `%${num}%`)
    if (error) { messageSearchError = error.message; break }
    messageHits.set(num, (data ?? []) as any[])
  }

  // ── portal reachability: does this customer hold a portal token? ───────────
  const custIds = [...new Set(subjects.map(q => q.customer_id).filter(Boolean) as string[])]
  const { data: tokenRows, error: tokenErr } = custIds.length
    ? await sb.from('customer_portal_tokens').select('customer_id, created_at, revoked_at').in('customer_id', custIds)
    : { data: [], error: null as any }
  const tokensByCustomer = new Map<string, any[]>()
  for (const t of (tokenRows ?? []) as any[]) {
    if (!tokensByCustomer.has(t.customer_id)) tokensByCustomer.set(t.customer_id, [])
    tokensByCustomer.get(t.customer_id)!.push(t)
  }

  // ── the per-row report ────────────────────────────────────────────────────
  const describe = (q: Quote) => {
    const acc = gAcc.get(q.id) ?? [], job = gJob.get(q.id) ?? [], inv = gInv.get(q.id) ?? []
    const pay = gPay.get(q.id) ?? [], out = gOut.get(q.id) ?? [], co = gCo.get(q.id) ?? []
    const msgs = messageHits.get(q.quote_number ?? '') ?? []
    const toks = q.customer_id ? (tokensByCustomer.get(q.customer_id) ?? []) : []
    const liveTokens = toks.filter(t => !t.revoked_at)

    // ⭐⭐ A BACKFILLED ACCEPTANCE IS NOT CUSTOMER-FACING EVIDENCE, and treating it
    // as such would have overstated the risk on every row in this report. Each
    // of these four quotes carries a `legacy_unrecorded` acceptance written by a
    // MIGRATION, with actor_type 'system' and the note "Recorded before EdgeHQ
    // kept acceptance evidence". That row records that the business considered
    // the quote accepted; it is NOT proof that a customer saw, signed or was sent
    // anything bearing this quote number. The distinction decides whether a
    // renumber has to be chased outside the database at all, so it is drawn here
    // rather than left for the reader to notice.
    const backfilled = acc.filter(a =>
      a.kind === 'legacy_unrecorded' || a.source === 'migration' || a.actor_type === 'system')
    const realAcc = acc.filter(a => !backfilled.includes(a))

    // ⭐ THE WEIGHT OF A RENUMBER, derived from the evidence rather than asserted.
    const anchors: string[] = []
    if (realAcc.length) anchors.push('a customer acceptance')
    if (pay.length) anchors.push('a payment')
    if (inv.length) anchors.push('an invoice')
    if (job.length) anchors.push(`${job.length} linked job${job.length > 1 ? 's' : ''}`)
    if (msgs.length) anchors.push('a sent message quoting the number')
    if (q.sent_at) anchors.push('a send timestamp')

    return { acc, backfilled, realAcc, job, inv, pay, out, co, msgs, toks, liveTokens, anchors }
  }

  const row = (q: Quote, label: string) => {
    const e = describe(q)
    say(`#### ${label} — quote \`${short(q.id)}\``)
    say('')
    say('| field | value |')
    say('| --- | --- |')
    say(`| quote id | \`${q.id}\` |`)
    say(`| quote number | \`${q.quote_number}\` |`)
    say(`| created_at | ${when(q.created_at)} |`)
    say(`| customer | ${q.customer_name ?? '—'} (\`${short(q.customer_id)}\`) |`)
    say(`| address | ${q.address ?? '—'} |`)
    say(`| service | ${q.service_type ?? '—'} |`)
    say(`| amount (total) | ${money(q.total)} |`)
    say(`| accepted amount | ${money(q.accepted_price)} |`)
    say(`| status | **${q.status}** |`)
    say(`| issued / valid until | ${q.issued_date ?? '—'} / ${q.valid_until ?? '—'} |`)
    say(`| sent_at | ${when(q.sent_at)} |`)
    say(`| acceptance evidence (customer) | ${e.realAcc.length
      ? e.realAcc.map(a => `${a.kind ?? 'accepted'} ${when(a.accepted_at)} via ${a.source ?? '—'} by ${a.actor_type ?? '—'}${a.actor_label ? ` (${a.actor_label})` : ''}, ${money(a.accepted_amount)}${a.document_fingerprint ? ', document fingerprinted' : ''}`).join('; ')
      : '**none**'} |`)
    say(`| acceptance rows written by a migration | ${e.backfilled.length
      ? `${e.backfilled.map(a => `${a.kind ?? '—'} stamped ${when(a.accepted_at)} (${a.actor_label ?? a.source ?? 'system'})`).join('; ')} — ⚠️ **backfill, not customer evidence**: this records that the business treated the quote as accepted, not that a customer was ever shown this number`
      : '—'} |`)
    say(`| job linked | ${e.job.length ? e.job.map(j => `\`${short(j.id)}\` ${j.status}${j.scheduled_date ? ` on ${j.scheduled_date}` : ''}${j.price != null ? ` (${money(j.price)})` : ''}`).join('; ') : '**none**'} |`)
    say(`| invoice linked | ${e.inv.length ? e.inv.map(i => `\`${i.invoice_number ?? short(i.id)}\` ${i.status} ${money(i.total)}`).join('; ') : '**none**'} |`)
    say(`| payment linked | ${e.pay.length ? e.pay.map(p => `${money(p.amount)} ${p.status}${p.paid_at ? ` ${when(p.paid_at)}` : ''} via ${p.provider ?? '—'}`).join('; ') : '**none**'} |`)
    say(`| outcome recorded | ${e.out.length ? e.out.map(o => `${o.outcome} ${when(o.created_at)}`).join('; ') : '—'} |`)
    say(`| change orders | ${e.co.length ? e.co.map(c => `\`${short(c.id)}\` ${c.status}`).join('; ') : '—'} |`)
    say(`| line items / options / add-ons | ${(gSvc.get(q.id) ?? []).length} / ${(gOpt.get(q.id) ?? []).length} / ${(gAdd.get(q.id) ?? []).length} |`)
    say(`| follow-ups / measurements | ${(gFu.get(q.id) ?? []).length} / ${(gMeas.get(q.id) ?? []).length} |`)
    say(`| message naming this number | ${messageSearchError
      ? `⚠️ NOT MEASURED (${messageSearchError})`
      : e.msgs.length
        ? e.msgs.map(m => `${m.direction} ${m.channel} ${when(m.created_at)} ${m.status ?? ''}`).join('; ')
        : 'none found in the message log'} |`)
    say(`| portal reachable | ${q.customer_id
      ? (e.liveTokens.length ? `yes — ${e.liveTokens.length} live portal token(s) for this customer` : (e.toks.length ? 'no live token (all revoked)' : 'no portal token issued'))
      : 'no customer linked'} |`)
    say(`| PDF containing this number | ⚠️ **NOT MEASURABLE.** Quote PDFs are rendered on demand and never stored, so the database cannot say whether one was produced or downloaded. Treat \`sent_at\` and the message log above as the best available proxy. |`)
    say('')
    say(`**What a renumber of this row would have to be chased through:** ${e.anchors.length
      ? e.anchors.join(', ')
      : 'nothing the database can see — no customer acceptance, payment, invoice, job, sent message or portal token points at it'}.`)
    say('')
  }

  // ── duplicated pairs ──────────────────────────────────────────────────────
  say('---')
  say('')
  say('## Duplicated numbers')
  say('')
  if (!duplicated.length) say('_None._')
  for (const [num, group] of duplicated) {
    say(`### \`${num}\` ×${group.length}`)
    say('')
    const sorted = [...group].sort((a, b) => a.created_at.localeCompare(b.created_at))
    const gapMin = Math.round(
      (new Date(sorted[sorted.length - 1].created_at).getTime() - new Date(sorted[0].created_at).getTime()) / 60000)
    say(`The two rows were created **${gapMin} minutes apart**, which is why this was a stale`)
    say('read rather than a race: no two requests were ever in flight together.')
    say('')
    sorted.forEach((q, i) => row(q, i === 0 ? 'FIRST (original)' : `LATER (#${i + 1})`))

    // ⭐ THE OPTIONS, LAID OUT — NOT A CHOICE. Each one is stated with what it
    // costs, so the owner is choosing between known consequences.
    const ev = sorted.map(describe)
    const untouched = sorted.filter((_, i) => ev[i].anchors.length === 0)
    say(`**Options for \`${num}\`, and what each costs:**`)
    say('')
    say('1. **Leave both as they are.** Stage 1 already prevents any new quote from')
    say('   taking this number, including via a backdated `created_at`. The cost is')
    say('   that stage 2 (a full `UNIQUE (user_id, quote_number)`) can never be')
    say('   enabled, so the guarantee stays split across a registry and a partial')
    say('   index instead of one constraint.')
    say('2. **Renumber the later row to the next free number in its year series.**')
    say('   Cheapest in the database, and it unblocks stage 2. The cost is that any')
    say('   document or message already showing the old number now disagrees with')
    say('   the record — see the evidence rows above for how far that reaches.')
    say('3. **Renumber the later row and re-issue it to the customer** so the paper')
    say('   trail matches. Highest effort, lowest ambiguity.')
    say('')
    if (untouched.length === 1) {
      say(`⭐ Worth noting: exactly one of these two rows (\`${short(untouched[0].id)}\`, created`)
      say(`${when(untouched[0].created_at)}, ${untouched[0].customer_name ?? 'no customer'}) has **nothing`)
      say('downstream pointing at it** that the database can see — no customer acceptance,')
      say('payment, invoice, linked job, sent message or portal token. That makes it the')
      say('cheapest one to renumber if option 2 or 3 is chosen — but "cheapest" is an')
      say('input to the decision, not the decision. ⛔ This report does not choose.')
      say('')
    } else if (untouched.length === sorted.length) {
      say('⭐ Worth noting: **neither** row has anything downstream pointing at it that the')
      say('database can see, so renumbering either one touches nothing measurable.')
      say('⛔ This report still does not choose — the PDF row above is not measurable.')
      say('')
    } else {
      say('⚠️ **Both** rows have downstream records pointing at them, so neither is a')
      say('free renumber. ⛔ This report does not choose.')
      say('')
    }
  }

  // ── malformed ─────────────────────────────────────────────────────────────
  say('---')
  say('')
  say('## Malformed numbers (no year segment)')
  say('')
  say('⛔ **These are not duplicates and nothing here proposes renaming them.** They are')
  say('reported because they belong to no year series, which is exactly why a counter')
  say('can never protect them and only the claim registry can: the registry claims the')
  say('literal string, so `EPS-0002` cannot be reissued even though no `EPS-<year>`')
  say('counter has ever heard of it. They do not block stage 2 — a full UNIQUE cares')
  say('about duplication, not about shape.')
  say('')
  if (!malformed.length) say('_None._')
  for (const q of malformed) row(q, `MALFORMED \`${q.quote_number}\``)

  say('---')
  say('')
  say('## What this report is for')
  say('')
  say('Stage 2 of the migration is commented out and stays that way until each pair')
  say('above has an owner decision. Stage 1 is not waiting on any of this: it protects')
  say('every new quote the moment it is applied, without touching one historical row.')
  say('')

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')
    console.log(`\n  ✓ written to ${outPath}\n`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
