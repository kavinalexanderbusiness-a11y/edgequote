// ── Verify: quote options cannot be made to add up, and cannot be chosen for you ──
//   npm run verify:quote-options
//
// STATUS: the feature is COMPLETE — the builder writes options, the portal
// compares and selects them, the PDF prints them as alternatives, the owner can
// record a choice made by phone, and the approval contract is one function with
// two doors. The previous version of this file asserted that the builder did NOT
// write options; that was a forcing function, it did its job, and it is gone.
//
// WHAT THE FEATURE IS FOR
// "Budget $3,900 / Standard $5,400 / Premium $7,100" — three versions of ONE job,
// of which the customer picks one. `quote_services` rows could never model that:
// they are ADDITIVE scope and sum into the quote total, so three alternatives
// expressed as lines would quote $16,400 for a $5,400 job.
//
// ⭐ WHY THE MODEL IS SAFE. `quotes.total` is a STORED GENERATED column
// (initial_price + travel_fee), so there is exactly ONE money path out of a
// quote, and every downstream system reads it: the send gate, the invoice
// conversion (`amount: quote.total`), job costing, pipeline reporting, and the
// deposit engine — which lives on the INVOICE and therefore only ever sees a
// figure that already came from `total`. Options drive `initial_price`. There is
// no arrangement of this data in which the alternatives add up, because nothing
// adds them.
//
// ⚠️ THE LIVE HALF WRITES. Sections 5–7 sign in as the owner, create ONE fixture
// quote (number ZZ-VERIFY-OPTIONS), attack it, and delete it in a finally. A
// leftover from a killed run is swept at the start of the next one. Everything it
// creates is deleted; nothing existing is touched, read-modified or relied upon —
// this guard asserts on data it made, never on the state of the real book.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  MAX_QUOTE_OPTIONS, MIN_QUOTE_OPTIONS, activeOption, hasOptions, headlineOptionPrice,
  optionSetProblem, optionValueBasis, optionsConflictWithLines, recommendedOption,
  sortedOptions, duplicateOption, optionRowsFor,
} from '../src/lib/quoteOptions'
// The downstream engine, imported rather than described: if the job's value ever
// stops resolving through this, section 2b stops being true.
import { jobVisitValue } from '../src/lib/visitValue'

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split(/\r?\n/) : []) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
}

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const GHOST = '00000000-0000-0000-0000-0000000000ff'
const FIXTURE_NUMBER = 'ZZ-VERIFY-OPTIONS'

// ── 1. The pricing rule, which is the whole feature ──────────────────────────
console.log('\n═══ An option IS the price — it is never a component of one ═══')
const OPTS = [
  { id: 'a', name: 'Budget', price: 3900, sort_order: 0, is_recommended: false },
  { id: 'b', name: 'Standard', price: 5400, sort_order: 1, is_recommended: true },
  { id: 'c', name: 'Premium', price: 7100, sort_order: 2, is_recommended: false },
]
const SUM = 3900 + 5400 + 7100

check('the headline is the RECOMMENDED option, not the sum', headlineOptionPrice(OPTS) === 5400,
  `got ${headlineOptionPrice(OPTS)} — ${SUM} would mean the alternatives were added together`)
check('no helper ever returns the sum of the options',
  ![headlineOptionPrice(OPTS), activeOption(OPTS, 'a')?.price, activeOption(OPTS, null)?.price].includes(SUM))
check('with no recommendation the headline is the FIRST option, in the owner’s order',
  headlineOptionPrice([{ name: 'B', price: 200, sort_order: 1 }, { name: 'A', price: 100, sort_order: 0 }]) === 100)
check('the selected option wins over the recommended one', activeOption(OPTS, 'a')?.name === 'Budget')
check('before any selection the recommended one is active', activeOption(OPTS, null)?.name === 'Standard')
// A selection that resolves to nothing means the caller mixed up two quotes.
// Falling back to the recommended option would present someone else's choice as
// this customer's, which is worse than answering "I don't know".
check('an unresolvable selection returns null, never a fallback', activeOption(OPTS, 'ghost') === null)
check('no options → no headline, no active option',
  headlineOptionPrice([]) === null && activeOption([], null) === null && !hasOptions([]) && !hasOptions(null))
check('the owner’s order is preserved, never re-sorted by price',
  sortedOptions(OPTS).map(o => o.name).join('|') === 'Budget|Standard|Premium')
check('recommendedOption finds the badge', recommendedOption(OPTS)?.name === 'Standard')

// ── MUTATION TEST ────────────────────────────────────────────────────────────
// A guard that would pass against a BROKEN implementation is decoration. Here is
// the exact break this feature exists to prevent — a headline that sums — run
// against the assertions above. If they don't reject it, they are not protecting
// anything.
{
  const brokenHeadline = (o: typeof OPTS) => o.reduce((n, x) => n + Number(x.price), 0)
  check('MUTATION — a summing headline would be caught',
    brokenHeadline(OPTS) === SUM && headlineOptionPrice(OPTS) !== brokenHeadline(OPTS),
    'the real helper agrees with a summing one; the check above proves nothing')
  // …and the second break: falling back to the recommended option when the
  // selection doesn't resolve, which silently presents someone else's choice.
  const brokenActive = (o: typeof OPTS, id: string | null) =>
    o.find(x => x.id === id) ?? o.find(x => x.is_recommended) ?? o[0]
  check('MUTATION — a fallback on an unresolvable selection would be caught',
    brokenActive(OPTS, 'ghost')?.name === 'Standard' && activeOption(OPTS, 'ghost') === null,
    'the real helper falls back too — an unresolvable id must answer null')
}

console.log('\n═══ A set that cannot be chosen from cannot be saved ═══')
check('one option is not a choice', optionSetProblem([OPTS[0]]) === 'too_few')
check(`${MIN_QUOTE_OPTIONS} is the floor`, optionSetProblem(OPTS.slice(0, 2)) === null)
check(`${MAX_QUOTE_OPTIONS} is the ceiling`,
  optionSetProblem([...OPTS, { name: 'D', price: 1 }]) === null
  && optionSetProblem([...OPTS, { name: 'D', price: 1 }, { name: 'E', price: 1 }]) === 'too_many')
check('an unnamed option is refused', optionSetProblem([{ name: ' ', price: 1 }, { name: 'B', price: 2 }]) === 'unnamed')
check('two options with one name are refused',
  optionSetProblem([{ name: 'Same', price: 1 }, { name: ' same ', price: 2 }]) === 'duplicate_name')
check('two recommendations are refused',
  optionSetProblem([{ name: 'A', price: 1, is_recommended: true }, { name: 'B', price: 2, is_recommended: true }]) === 'many_recommended')
// "Included" and "no charge" are real tiers. It is the QUOTE having no price
// that is blocked, and sendBlockedReason already owns that gate.
check('a $0 tier is allowed', optionSetProblem([{ name: 'Included', price: 0 }, { name: 'B', price: 2 }]) === null)
check('a negative price is refused', optionSetProblem([{ name: 'A', price: -1 }, { name: 'B', price: 2 }]) === 'no_price')
check('alternatives and additive lines are declared incompatible in ONE place',
  optionsConflictWithLines(true, 1) && !optionsConflictWithLines(true, 0) && !optionsConflictWithLines(false, 3))

check('duplicating never copies the Recommended badge', duplicateOption(OPTS[1], OPTS).is_recommended === false)
check('duplicating never collides with an existing name',
  !OPTS.map(o => o.name).includes(duplicateOption(OPTS[1], OPTS).name))
check('stored order is renumbered from screen position',
  optionRowsFor([{ name: 'x', price: 1 }, { name: 'y', price: 2 }], 'q', 'u').map(r => r.sort_order).join() === '0,1')
check('rows never invent tenancy', optionRowsFor([{ name: 'x', price: 1 }], 'q1', 'u1')[0].user_id === 'u1')

// ── 2. Reporting semantics: proposed vs chosen ───────────────────────────────
// The owner's product decision: before a choice the quote is worth its
// RECOMMENDED option; after, its SELECTED one. Never zero, never the sum. What
// changes is not the FIGURE (that is always quotes.total) but what it MEANS, and
// that distinction has to be derivable from state that already exists.
console.log('\n═══ Reporting can tell a proposed figure from a chosen one ═══')
check('an ordinary quote has no basis to report — the question doesn’t arise',
  optionValueBasis([], null) === null && optionValueBasis(null, null) === null)
check('offered but unchosen reports as PROPOSED', optionValueBasis(OPTS, null) === 'proposed')
check('chosen reports as SELECTED', optionValueBasis(OPTS, 'b') === 'selected')
check('the proposed figure is the recommended option — never 0, never the sum',
  headlineOptionPrice(OPTS) === 5400 && headlineOptionPrice(OPTS) !== 0 && headlineOptionPrice(OPTS) !== SUM)
check('the basis is derived from the selection, not from a second stored column',
  read('src/lib/quoteOptions.ts').includes('return isSelected(selectedId) ? \'selected\' : \'proposed\''))

// ── 2b. Downstream, and the cadence columns beside them ──────────────────────
// The job, the invoice and the deposit needed no code change, and this is the
// section that has to keep proving it rather than asserting it. All three read
// the ONE money path; the only thing options changed is which single number
// `initial_price` holds.
console.log('\n═══ Scope alternatives and schedule prices cannot flatten together ═══')
{
  // A quote offering three scopes AND three cadences — the shape most likely to
  // be added up by accident. Standard is chosen, so initial_price is 5400.
  const mixed = {
    initial_price: 5400, total: 5550, travel_fee: 150,
    weekly_price: 55, biweekly_price: 75, monthly_price: 260,
  }
  const OPTION_SUM = 3900 + 5400 + 7100
  const CADENCE_SUM = 55 + 75 + 260
  // Every figure this must NEVER produce, named once. ⚠️ Typed as number[] on
  // purpose: `x === 5400 && x !== 16400` narrows x to the literal 5400 and
  // `next build` rejects the second comparison as unintentional — a failure
  // `tsc -p tsconfig.json` does not reproduce, because the app's tsconfig does
  // not cover scripts/. The suite runs under the build's rules, so write for them.
  const FORBIDDEN: number[] = [OPTION_SUM, CADENCE_SUM, OPTION_SUM + CADENCE_SUM, 5400 + 55, 0]
  // A ONE-OFF visit off this quote is worth the chosen SCOPE.
  const oneOff: number = jobVisitValue(null, mixed, null)
  check('a one-off visit is worth the CHOSEN OPTION, not any sum',
    oneOff === 5400 && !FORBIDDEN.includes(oneOff), `got ${oneOff}`)
  // A WEEKLY visit off the same quote is worth the weekly CADENCE price. Two
  // different questions, two different answers, from one engine.
  const weekly: number = jobVisitValue(null, mixed, 'weekly')
  check('a weekly visit is worth the WEEKLY RATE, not the chosen option',
    weekly === 55 && !FORBIDDEN.includes(weekly), `got ${weekly}`)
  check('neither answer is ever a combination of the two',
    ![oneOff, weekly].some(v => FORBIDDEN.includes(v)))
  // The job's OWN price still wins where one was set — options changed nothing
  // about that precedence.
  check('a job’s own price still overrides the quote, exactly as before',
    jobVisitValue(700, mixed, null) === 700)
  // The deposit engine lives on the INVOICE and only ever sees a figure that
  // already came from quotes.total, so it cannot see an option at all.
  check('the deposit engine reads the INVOICE, never a quote option',
    !/quote_options|selected_option/.test(read('src/lib/payments/deposit.ts')),
    'a deposit derived from anything but the invoice balance would be a second money path')
  check('the visit-value engine knows nothing about options either',
    !/quote_options|selected_option/.test(read('src/lib/visitValue.ts')),
    'it reads initial_price — which IS the chosen option — so it needed no change and must not gain one')
}

// ── 3. Every surface exists, and none of them can sum ────────────────────────
// This section replaces the old forcing function. It no longer asks whether the
// surfaces exist yet; it asks whether each one still does the one thing that
// makes it safe.
console.log('\n═══ The surfaces exist, and each keeps its own promise ═══')
const BUILDER = read('src/components/quotes/QuoteBuilder.tsx')
const EDITOR = read('src/components/quotes/QuoteOptionsEditor.tsx')
const NEW_QUOTE = read('src/app/dashboard/quotes/new/page.tsx')
const QUOTE_DETAIL = read('src/app/dashboard/quotes/[id]/page.tsx')
const PDF = read('src/components/quotes/QuotePDF.tsx')
const PORTAL_MODEL = read('src/app/portal/[token]/model.ts')
const BILLING = read('src/app/portal/[token]/components/BillingTab.tsx')
const PORTAL_CLIENT = read('src/app/portal/[token]/PortalClient.tsx')
const HOME = read('src/app/portal/[token]/components/HomeTab.tsx')

check('BUILDER — the options editor is wired in behind a switch',
  /QuoteOptionsEditor/.test(BUILDER) && /has_options/.test(BUILDER))
check('BUILDER — a normal quote still renders the single price field',
  /register\('initial_price'/.test(BUILDER),
  'the plain path must be untouched — every existing quote uses it')
check('BUILDER — options and additive lines cannot be offered together',
  /optionsConflictWithLines/.test(BUILDER) && /\{!optionsOn && \(/.test(BUILDER),
  'the database refuses a quote holding both; the form must say so first')
check('BUILDER — the headline comes from the ONE engine, not a local reduce',
  /headlineOptionPrice\(watchedOptions\)/.test(BUILDER) && !/options[\s\S]{0,40}\.reduce\(/.test(BUILDER))
check('EDITOR — exactly one Recommended, enforced by the control’s own shape',
  /type="radio"/.test(EDITOR),
  'a checkbox would let the owner tick two and learn about it from a failed save')
// ⚠️ CODE ONLY. The first cut of this check read the whole file and failed on the
// editor's own comment explaining that it has no subtotal — a guard grepping its
// subject matter reporting the CURE as the DISEASE, which is exactly how the
// public-edge guard went red on its own fix. Comments describe; code does.
const stripComments = (s: string) =>
  s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
check('EDITOR — no subtotal across the options',
  !/reduce\(/.test(stripComments(EDITOR)) && !/subtotal/i.test(stripComments(EDITOR)),
  'a column that added the alternatives would be the one lie this feature exists to prevent')

check('CREATE — the builder persists real quote_options rows',
  /from\('quote_options'\)\s*\.insert/.test(NEW_QUOTE.replace(/\s+/g, ' ')) || /from\('quote_options'\)/.test(NEW_QUOTE))
check('CREATE — initial_price is ONE option’s price',
  /initial_price: optionsOn \? optionHeadline/.test(NEW_QUOTE))
check('CREATE — a failed option write is reported, never swallowed',
  /optErr/.test(NEW_QUOTE) && /options could not be written/.test(NEW_QUOTE))
check('EDIT — an approved option set is never silently rewritten',
  /optionsSettled/.test(QUOTE_DETAIL) && /if \(!optionsSettled\)/.test(QUOTE_DETAIL))
check('EDIT — a failed option rewrite is reported, never swallowed',
  /options were lost mid-save/.test(QUOTE_DETAIL))

check('PDF — the document knows about alternatives',
  /options\?: QuoteOption\[\]/.test(PDF) && /isOptionsQuote/.test(PDF))
check('PDF — the line-item table is REPLACED, not joined',
  /\{isOptionsQuote \? \(/.test(PDF),
  'printing both tables is how a reader constructs a total that does not exist')
check('PDF — no subtotal row spans the alternatives',
  /!isOptionsQuote && \(\(lines && lines\.length > 1\)/.test(PDF))
check('PDF — the grand total NAMES the single option it totals',
  /If you choose \$\{leading\.name\}|`If you choose/.test(PDF) && /Approved — \$\{chosen\.name\}|`Approved — /.test(PDF))
check('PDF — the customer’s own copy carries the options too',
  /renderQuoteBlob\([\s\S]{0,200}options\)/.test(read('src/lib/portalPdf.ts')))

check('PORTAL MODEL — options ride the DocItem, separate from lines and plans',
  /options\?: \{ id: string; name: string/.test(PORTAL_MODEL) && /selectedOptionId/.test(PORTAL_MODEL))
check('PORTAL MODEL — each option carries its OWN customer-facing figure',
  /amount: Number\(o\.price\) \+ \(Number\(qq\.travel_fee\) \|\| 0\)/.test(PORTAL_MODEL))
check('PORTAL — the comparison is one column at every width',
  /space-y-2/.test(BILLING) && !/(sm|md|lg):grid-cols-3/.test(BILLING),
  'three desktop pricing cards squeezed to 375px clip the scope text that IS the comparison')
check('PORTAL — nothing is pre-selected, not even Recommended',
  /useState<string \| null>\(null\)/.test(BILLING) && /approveReady/.test(BILLING),
  'a pre-ticked option turns "I chose" into "I tapped"')
check('PORTAL — Approve is refused until an option is named',
  /disabled=\{!approveReady\}/.test(BILLING))
check('PORTAL — the button quotes the CHOSEN option, not the quote total',
  /Approve \$\{pickedOpt\.name\} — \$\{formatCurrency\(pickedOpt\.amount\)\}/.test(BILLING))
check('PORTAL — the selection is passed to the canonical RPC',
  /p_option_id: chosenOpt\.id/.test(PORTAL_CLIENT))
check('PORTAL — a stale option id is refused rather than approved as something else',
  /isn’t on this quote any more/.test(PORTAL_CLIENT))
check('PORTAL — the confirm dialog names the option and the other options’ fate',
  /Approve \$\{chosenOpt\.name\}/.test(PORTAL_CLIENT) && /won’t be charged/.test(PORTAL_CLIENT))
check('PORTAL HOME — the one-tap Approve shortcut stands down on an options quote',
  /!\(oneQuoteDoc\.options\?\.length\)/.test(HOME),
  'there is nowhere on that card to compare three scopes; approving from it would be a choice nobody made')

check('OWNER — accept-on-behalf goes through the canonical contract',
  /owner_select_quote_option/.test(QUOTE_DETAIL),
  'a direct table update would be a SECOND implementation of the money rule')
check('OWNER — "Won" cannot record an approval with no option named',
  /options\.length > 0/.test(QUOTE_DETAIL) && /pick the one the customer chose/.test(QUOTE_DETAIL))
check('OWNER — a falsy RPC result is never reported as success',
  /if \(error \|\| !applied\)/.test(QUOTE_DETAIL))

// ── 4. The schema is what enforces it, not the app ───────────────────────────
console.log('\n═══ The database refuses what no screen should have to remember ═══')
const SQL = read('supabase/RUN-2026-08-11-quote-options.sql')
const SQL_CODE = SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
const SEL_SQL = read('supabase/RUN-2026-08-11b-quote-options-selection.sql')
const SEL_CODE = SEL_SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

check('the selection is a COMPOSITE foreign key',
  /foreign key \(selected_option_id, id\)[\s\S]{0,120}?references public\.quote_options \(id, quote_id\)/.test(SQL_CODE),
  'a single-column FK would let a quote point at ANOTHER quote’s option and leave the check to whoever remembered it')
check('an approved option can never be deleted', /on delete restrict/.test(SQL_CODE),
  'the alternatives stay on the record to prove what was offered')
check('at most one option may be Recommended',
  /unique index[\s\S]{0,120}?quote_options \(quote_id\) where is_recommended/.test(SQL_CODE))
check('alternatives and additive lines cannot coexist',
  /v_options > 0 and v_lines > 0/.test(SQL_CODE),
  'one of them ADDS UP and the other REPLACES — a quote carrying both makes "is this on top of my option?" unanswerable')
check('the option cap is enforced in the database', new RegExp(`v_options > ${MAX_QUOTE_OPTIONS}`).test(SQL_CODE))
check('both tables carry the shape trigger',
  /on public\.quote_options/.test(SQL_CODE) && /on public\.quote_services/.test(SQL_CODE),
  'without the mirror the rule holds only when options happen to be written last')
check('RLS is on with owner-scoped policies',
  /enable row level security/.test(SQL_CODE) && (SQL_CODE.match(/auth\.uid\(\) = user_id/g) || []).length === 4)

check('there is exactly ONE writer of the choice',
  (SEL_CODE.match(/set status = 'accepted',\s*\n\s*selected_option_id/g) || []).length === 1,
  'two functions each knowing the money rule is how the owner’s screen and the customer’s screen start disagreeing')
check('both doors delegate to it rather than restating it',
  (SEL_CODE.match(/return public\.quote_apply_option_choice\(p_quote_id, p_option_id\);/g) || []).length === 2)
check('the core refuses to re-decide a settled quote',
  /q\.status in \('draft', 'sent'\)/.test(SEL_CODE) && /where id = p_quote_id and status in \('draft', 'sent'\)/.test(SEL_CODE))
check('the option is resolved THROUGH the quote',
  /and o\.quote_id = p_quote_id/.test(SEL_CODE))
check('the unauthorised core is revoked from every role by NAME',
  /revoke all on function public\.quote_apply_option_choice\(uuid, uuid\)\s*\n?\s*from public, anon, authenticated, service_role;/.test(SEL_CODE),
  '⚠️ `revoke ... from public` alone leaves the grants ALTER DEFAULT PRIVILEGES hands to anon/authenticated/service_role at create time — '
  + 'the first apply of this migration left the one function that authorises nothing callable over the wire by anon')
check('the owner door proves auth.uid() explicitly',
  /if auth\.uid\(\) is null then return false; end if;/.test(SEL_CODE),
  'a guard whose safety depends on a NULL comparison behaving is the shape that failed open in the measurement RPC')

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const email = process.env.PORTAL_RPC_OWNER_EMAIL
  const password = process.env.PORTAL_RPC_OWNER_PASSWORD

  console.log('\n═══ The deployed database, attacked for real ═══')
  if (!url || !anonKey || url.includes('placeholder')) {
    console.log('  … SKIPPED — no live Supabase credentials (CI runs with placeholders)')
    return
  }

  const anon: SupabaseClient = createClient(url, anonKey)

  // ── 5. Reachability: the core must not be callable by anyone ───────────────
  // This needs no login and no fixture, and it is the single most important live
  // assertion in the file: quote_apply_option_choice authorises NOTHING. If
  // PostgREST can reach it, any anonymous request that can guess two uuids can
  // accept any quote in any tenant at any price.
  const coreAsAnon = await anon.rpc('quote_apply_option_choice', { p_quote_id: GHOST, p_option_id: GHOST })
  check('an anonymous caller cannot reach the unauthorised core',
    coreAsAnon.error !== null && /permission denied|not find the function|does not exist/i.test(coreAsAnon.error?.message ?? ''),
    `got ${coreAsAnon.error ? coreAsAnon.error.message : `data=${JSON.stringify(coreAsAnon.data)}`} — the core carries no authorisation of its own`)
  const ownerDoorAsAnon = await anon.rpc('owner_select_quote_option', { p_quote_id: GHOST, p_option_id: GHOST })
  check('an anonymous caller cannot use the OWNER door',
    ownerDoorAsAnon.data === false || ownerDoorAsAnon.error !== null,
    `returned ${JSON.stringify(ownerDoorAsAnon.data)}`)
  const forgedToken = await anon.rpc('portal_accept_quote', {
    p_token: 'forged-token-not-a-real-customer', p_quote_id: GHOST, p_option_id: GHOST,
  })
  check('a forged portal token cannot name an option',
    forgedToken.error === null && forgedToken.data === false,
    `returned ${JSON.stringify(forgedToken.data)}`)

  if (!email || !password) {
    console.log('  … SKIPPED the end-to-end run — needs PORTAL_RPC_OWNER_EMAIL / _PASSWORD')
    return
  }
  const owner: SupabaseClient = createClient(url, anonKey)
  const { data: auth, error: authErr } = await owner.auth.signInWithPassword({ email, password })
  if (authErr || !auth?.user) {
    console.log(`  … SKIPPED the end-to-end run — owner sign-in failed (${authErr?.message})`)
    return
  }
  const uid = auth.user.id

  // Sweep any fixture a killed run left behind, before making a new one.
  await owner.from('quotes').delete().eq('user_id', uid).eq('quote_number', FIXTURE_NUMBER)

  let quoteId: string | null = null
  let otherQuoteId: string | null = null
  try {
    // ── 6. A real options quote, built the way the builder builds one ────────
    // A customer WITH a portal token, so the customer door can be exercised end
    // to end. Deleted in the finally below; total lifetime is a second or two.
    const { data: tok } = await owner.from('customer_portal_tokens')
      .select('token, customer_id').eq('revoked', false).limit(1).maybeSingle()
    const token = (tok as { token: string; customer_id: string } | null)?.token ?? null
    const customerId = (tok as { token: string; customer_id: string } | null)?.customer_id ?? null

    const rows = optionRowsFor(
      [
        { name: 'Budget', price: 3900, is_recommended: false },
        { name: 'Standard', price: 5400, is_recommended: true },
        { name: 'Premium', price: 7100, is_recommended: false },
      ],
      'pending', uid,
    )
    const { data: q, error: qErr } = await owner.from('quotes').insert({
      quote_number: FIXTURE_NUMBER, customer_id: customerId,
      customer_name: 'Automated guard fixture — safe to delete',
      address: '1 Verification Way', service_type: 'Guard fixture',
      // The builder's rule: ONE option's price, the recommended one.
      initial_price: headlineOptionPrice(rows), travel_fee: 150,
      hours: 4, crew_size: 2, rate: 60, status: 'sent', user_id: uid, follow_up_count: 0,
    }).select('id, total').single()
    if (qErr || !q) { fail('the guard could not create its fixture quote', qErr?.message); return }
    quoteId = (q as { id: string }).id

    const { data: opts, error: oErr } = await owner.from('quote_options')
      .insert(rows.map(r => ({ ...r, quote_id: quoteId! }))).select('id, name, price')
    if (oErr || !opts) { fail('the guard could not create its fixture options', oErr?.message); return }
    const byName = Object.fromEntries((opts as { id: string; name: string }[]).map(o => [o.name, o.id]))

    const readTotal = async (qid: string) => {
      const { data } = await owner.from('quotes')
        .select('total, initial_price, accepted_price, status, selected_option_id').eq('id', qid).single()
      return data as { total: number; initial_price: number; accepted_price: number | null; status: string; selected_option_id: string | null }
    }

    let state = await readTotal(quoteId)
    check('a saved options quote is worth ONE option + travel, never the sum',
      Number(state.total) === 5550,
      `total=${state.total}; 16400 (+travel) would mean the alternatives were added`)
    check('…and it is a real, sendable price — never 0 because nobody has chosen',
      Number(state.total) > 0 && state.selected_option_id === null)

    // The DB's own shape rules, attacked through the app's own client.
    const bothKinds = await owner.from('quote_services').insert({
      user_id: uid, quote_id: quoteId, sort_order: 0, service_type: 'Sneaky add-on',
      quantity: 1, unit: 'each', unit_price: 500,
    })
    check('an ADDITIVE line cannot be added to a quote that offers alternatives',
      bothKinds.error !== null,
      'one kind of row adds up and the other replaces — a quote carrying both is unanswerable')
    const fifth = await owner.from('quote_options').insert({
      quote_id: quoteId, user_id: uid, name: 'Fifth', price: 1, sort_order: 4, is_recommended: false,
    })
    // 3 existing + 1 = 4, which is the cap; add two to exceed it.
    const sixth = fifth.error ? null : await owner.from('quote_options').insert({
      quote_id: quoteId, user_id: uid, name: 'Sixth', price: 1, sort_order: 5, is_recommended: false,
    })
    check(`more than ${MAX_QUOTE_OPTIONS} options is refused by the database`,
      sixth !== null && sixth.error !== null,
      'comparison is the point, and it stops working past four columns on a phone')
    if (sixth === null || sixth.error) await owner.from('quote_options').delete().eq('quote_id', quoteId).eq('name', 'Fifth')
    const twoBadges = await owner.from('quote_options')
      .update({ is_recommended: true }).eq('id', byName['Premium'])
    check('a SECOND Recommended badge is refused by the database', twoBadges.error !== null)

    // A second quote, so "another quote's option" is a real id and not a ghost.
    const { data: q2 } = await owner.from('quotes').insert({
      quote_number: FIXTURE_NUMBER, customer_name: 'Automated guard fixture — safe to delete',
      address: '2 Verification Way', service_type: 'Guard fixture B',
      initial_price: 999, travel_fee: 0, hours: 1, crew_size: 1, rate: 60,
      status: 'sent', user_id: uid,
    }).select('id').single()
    otherQuoteId = (q2 as { id: string } | null)?.id ?? null
    let foreignOptionId: string | null = null
    if (otherQuoteId) {
      const { data: fo } = await owner.from('quote_options').insert({
        quote_id: otherQuoteId, user_id: uid, name: 'Foreign', price: 99999, sort_order: 0, is_recommended: true,
      }).select('id').single()
      foreignOptionId = (fo as { id: string } | null)?.id ?? null
    }

    // ── 7. The approval contract, attacked ───────────────────────────────────
    if (foreignOptionId) {
      const cross = await owner.rpc('owner_select_quote_option', { p_quote_id: quoteId, p_option_id: foreignOptionId })
      state = await readTotal(quoteId)
      check('OWNER — another quote’s option cannot be named against this quote',
        cross.data === false && state.status === 'sent' && state.selected_option_id === null,
        `returned ${JSON.stringify(cross.data)} / status ${state.status}`)
      if (token) {
        const crossPortal = await anon.rpc('portal_accept_quote', {
          p_token: token, p_quote_id: quoteId, p_option_id: foreignOptionId,
        })
        state = await readTotal(quoteId)
        check('CUSTOMER — another quote’s option cannot be named against this quote',
          crossPortal.data === false && state.selected_option_id === null,
          `returned ${JSON.stringify(crossPortal.data)}`)
      }
    }
    const ghostOpt = await owner.rpc('owner_select_quote_option', { p_quote_id: quoteId, p_option_id: GHOST })
    check('OWNER — a ghost option id is refused', ghostOpt.data === false)
    const ghostQuote = await owner.rpc('owner_select_quote_option', { p_quote_id: GHOST, p_option_id: byName['Standard'] })
    check('OWNER — a quote that is not theirs (or does not exist) is refused', ghostQuote.data === false)

    if (token) {
      const noChoice = await anon.rpc('portal_accept_quote', { p_token: token, p_quote_id: quoteId })
      state = await readTotal(quoteId)
      check('CUSTOMER — an options quote cannot be approved without naming one',
        noChoice.data === false && state.status === 'sent',
        '"approved" against three different prices records nothing anyone could act on')
    }

    // THE positive case, through the customer's own door when a token exists.
    const chose = token
      ? await anon.rpc('portal_accept_quote', { p_token: token, p_quote_id: quoteId, p_option_id: byName['Standard'] })
      : await owner.rpc('owner_select_quote_option', { p_quote_id: quoteId, p_option_id: byName['Standard'] })
    state = await readTotal(quoteId)
    check(`${token ? 'CUSTOMER' : 'OWNER'} — choosing Standard is recorded`,
      chose.data === true && state.status === 'accepted' && state.selected_option_id === byName['Standard'],
      `returned ${JSON.stringify(chose.data)} / status ${state.status}`)
    check('…the quote is now worth the SELECTED option, not the recommended one by luck',
      Number(state.initial_price) === 5400 && Number(state.total) === 5550)
    check('…and accepted_price snapshots option + travel, not the pre-choice total',
      Number(state.accepted_price) === 5550,
      `got ${state.accepted_price} — reading the GENERATED total in the same UPDATE snapshots the OLD row`)

    // ── The unselected options are inert ─────────────────────────────────────
    const before = Number(state.total)
    await owner.from('quote_options').update({ price: 99999 }).eq('id', byName['Premium'])
    const afterEdit = await readTotal(quoteId)
    check('an UNSELECTED option cannot move the quote total after the choice',
      Number(afterEdit.total) === before,
      `total went ${before} → ${afterEdit.total}; the alternatives are history, not inputs`)

    const delChosen = await owner.from('quote_options').delete().eq('id', byName['Standard'])
    check('the CHOSEN option can never be deleted', delChosen.error !== null,
      'the approved alternative must stay on the record underneath the approval')
    const delOther = await owner.from('quote_options').delete().eq('id', byName['Budget'])
    check('an UNSELECTED option is still free to delete', delOther.error === null)

    // ── Re-deciding, and the double-tap ──────────────────────────────────────
    const redecide = await owner.rpc('owner_select_quote_option', { p_quote_id: quoteId, p_option_id: byName['Premium'] })
    const afterRedecide = await readTotal(quoteId)
    check('an approved choice cannot be swapped underneath the customer',
      redecide.data === false
      && afterRedecide.selected_option_id === byName['Standard']
      && Number(afterRedecide.total) === 5550,
      `returned ${JSON.stringify(redecide.data)} / selected now ${afterRedecide.selected_option_id}`)
    check('a refused approval reports FALSE — it never looks like a success',
      redecide.data === false && redecide.error === null)

    // ── Survives a reload ────────────────────────────────────────────────────
    const fresh = createClient(url, anonKey)
    await fresh.auth.signInWithPassword({ email, password })
    // ⚠️ Two queries, not a PostgREST embed. There are now TWO foreign keys
    // between these tables — quote_options.quote_id → quotes, and
    // quotes.selected_option_id → quote_options — so `quotes(…, quote_options(…))`
    // is ambiguous and errors out. Worth knowing before writing that embed
    // anywhere in the app: the composite FK made the relationship two-way.
    const { data: reloaded } = await fresh.from('quotes')
      .select('selected_option_id, total').eq('id', quoteId).single()
    const { data: reloadedOpts } = await fresh.from('quote_options')
      .select('id, name, price, sort_order, is_recommended').eq('quote_id', quoteId).order('sort_order')
    const r = reloaded as { selected_option_id: string | null; total: number } | null
    check('the choice survives a reload on a brand-new session',
      r?.selected_option_id === byName['Standard'] && Number(r?.total) === 5550,
      `selected=${r?.selected_option_id} total=${r?.total}`)
    check('…and the customer-facing display would read that persisted truth',
      activeOption(
        (reloadedOpts ?? []) as unknown as { id: string; name: string; price: number }[],
        r?.selected_option_id,
      )?.name === 'Standard',
      'the same activeOption() the portal and the PDF call, over the row the database actually holds')
    await fresh.auth.signOut().catch(() => {})

    // ── Downstream: the invoice reads the ONE money path ─────────────────────
    check('the invoice conversion would bill the selected option only',
      /amount: (Number\()?quote\.total/.test(QUOTE_DETAIL) && Number(afterRedecide.total) === 5550,
      'invoice amount comes from quotes.total, which is GENERATED over the one option initial_price holds')
  } finally {
    // Always, even on a thrown assertion. Deleting the quote cascades to its
    // options — the ON DELETE RESTRICT protects the option row from being
    // orphaned under a live approval, not the parent from being removed.
    for (const qid of [quoteId, otherQuoteId]) {
      if (qid) await owner.from('quotes').delete().eq('id', qid)
    }
    const { count } = await owner.from('quotes')
      .select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('quote_number', FIXTURE_NUMBER)
    check('the guard cleaned up after itself', (count ?? 0) === 0,
      `${count} fixture quote(s) named ${FIXTURE_NUMBER} remain — delete them by hand`)
    await owner.auth.signOut().catch(() => {})
  }
}

main()
  .catch(e => { fail('the guard itself could not run', String(e?.message ?? e)) })
  .finally(() => {
    console.log('\n── Summary ────────────────────────────────────────────────────')
    console.log(failures === 0
      ? '\n✅ verify:quote-options — an option is the price, never a part of one; and only its owner or its customer can choose it\n'
      : `\n❌ verify:quote-options — ${failures} contract${failures === 1 ? '' : 's'} broken\n`)
    process.exit(failures === 0 ? 0 : 1)
  })
