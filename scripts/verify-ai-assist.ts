// ── Verify: the AI assist engine's facts, tokens and guardrails ──────────────
//   npm run verify:ai-assist
//
// WHY THIS SCRIPT EXISTS
// Same reason as verify-ai-context: a bad prompt does not throw. Every defect
// below shipped green through tsc AND next build, because each one is a string
// that is merely wrong — a token that expands into the middle of a sentence, a
// rule that contradicts the rule above it, a fact fetched and then dropped one
// line before the prompt. The only way to catch these is to render the real
// input and read it.
//
// It calls the REAL buildAssistInput and the REAL renderBody (no copies, no
// mocks of our own code — only the Supabase client is faked, and it returns rows
// shaped like production). No API key, no network, no cost, deterministic.

import { buildAssistInput } from '../src/lib/ai/assist'
import { renderBody, DEFAULT_TEMPLATES, type MsgVars } from '../src/lib/comms/templates'
import type { SupabaseClient } from '@supabase/supabase-js'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => cond ? ok(name) : fail(name, detail)

// ── A fake Supabase that returns production-shaped rows ───────────────────────
// Every builder method chains; the terminal calls resolve. `then` makes the
// builder awaitable for the calls that end on .order()/.eq() with no .limit().
type Rows = Record<string, Record<string, unknown>[]>
function fakeSb(rows: Rows): SupabaseClient {
  const make = (table: string) => {
    const data = rows[table] ?? []
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'lte', 'gt', 'gte', 'in', 'not', 'order', 'is']) b[m] = () => b
    b.limit = () => Promise.resolve({ data })
    b.maybeSingle = () => Promise.resolve({ data: data[0] ?? null })
    b.single = () => Promise.resolve({ data: data[0] ?? null })
    b.then = (res: (v: { data: unknown }) => unknown) => res({ data })
    return b
  }
  return { from: (t: string) => make(t) } as unknown as SupabaseClient
}

const PLUMBER_TEMPLATES = [
  { name: 'Drain Cleaning', category: 'Plumbing', default_description: 'Clear the blockage' },
  { name: 'Water Heater Install', category: 'Plumbing', default_description: null },
]
// The real pollution businessContext exists to defend against — free text typed
// in the field: a customer's name, and a non-service.
const POLLUTED_JOBS = [
  { service_type: 'Robert mowing' }, { service_type: 'Call' }, { service_type: 'Drain Cleaning' },
]

const CUSTOMER = {
  name: 'Dana Whitfield', address: '12 Elm St', city: 'Calgary',
  notes: 'Gate code 4417. Dog in the yard.', tags: ['vip'], created_at: '2024-03-02',
  sms_opt_in: true, email_opt_in: true, last_contacted_at: '2026-07-01',
  review_rating: null, reviewed_at: null, review_source: null,
  review_requested_at: null, review_declined_at: null,
}
const base: Rows = {
  business_settings: [{ company_name: 'Acme Plumbing', message_templates: null }],
  service_templates: PLUMBER_TEMPLATES,
  jobs: POLLUTED_JOBS,
  customers: [CUSTOMER],
  quotes: [], invoices: [], messages: [],
  properties: [{ address: '12 Elm St', neighborhood: 'Bridgeland', lawn_sqft: null, notes: 'Gate code 4417. Park on the street.' }],
}
const sb = (over: Rows = {}) => fakeSb({ ...base, ...over })
const U = 'user-1'
// firstName/businessName are required on MsgVars; the rest is what's under test.
const vars = (v: Partial<MsgVars> = {}): MsgVars => ({ firstName: 'Dana', businessName: 'Acme', ...v })

const run = async () => {
  console.log('\n── Tier 0: {{amount}} is a value, not a sentence fragment ──────')

  // The defect: `amount` interpolated to " for $180" (words included), so it only
  // fit ONE sentence shape. Anywhere else it read "your balance is  for $180."
  const balance = renderBody('Your balance is {{amount}}.', vars({ amount: '$180' }), 'x')
  check('{{amount}} inserts only the value',
    balance.sms === 'Your balance is $180.',
    `got: ${JSON.stringify(balance.sms)}`)
  check('{{amount}} never injects the word "for"',
    !/ for \$180/.test(balance.sms),
    `the fragment is back: ${JSON.stringify(balance.sms)}`)

  // The two built-in templates depended on the fragment; they now carry the
  // connective themselves. These are the money messages — they must read right.
  const inv = renderBody(DEFAULT_TEMPLATES.invoice, vars({ amount: '$180' }), 'x')
  check('invoice template still reads correctly',
    inv.sms.includes('Your invoice from Acme for $180 is ready.'),
    `got: ${JSON.stringify(inv.sms.split('\n').find(l => l.includes('invoice from')))}`)
  const rcpt = renderBody(DEFAULT_TEMPLATES.receipt, vars({ amount: '$180' }), 'x')
  check('receipt template still reads correctly',
    rcpt.sms.includes("we've received your payment of $180."),
    `got: ${JSON.stringify(rcpt.sms.split('\n').find(l => l.includes('received')))}`)

  console.log('\n── Tier 0: tokens are only offered when they will resolve ──────')

  // {{date}} with no dateLabel interpolates to the literal "soon" → "see you on
  // soon". The fix is upstream: never offer the model a token with no value.
  const noVars = await buildAssistInput(sb(), U, {
    task: 'draft_message', customerId: 'c1', template: 'confirm', channels: ['sms'],
  })
  check('{{date}} is NOT offered when no date was supplied',
    !noVars.system.includes('{{date}}'),
    'the model was offered a token that interpolates to the literal "soon"')
  check('{{amount}} is NOT offered when no amount was supplied',
    !noVars.system.includes('{{amount}}'),
    'the model was offered a token that interpolates to nothing')

  const withVars = await buildAssistInput(sb(), U, {
    task: 'draft_message', customerId: 'c1', template: 'invoice', channels: ['sms'],
    vars: { amount: '$180', dateLabel: 'Tuesday' },
  })
  check('{{amount}} IS offered when an amount exists', withVars.system.includes('{{amount}}'), '')
  check('{{date}} IS offered when a date exists', withVars.system.includes('{{date}}'), '')
  check('always-available tokens are always offered',
    withVars.system.includes('{{first_name}}') && withVars.system.includes('{{portal_link}}'), '')

  // "see you on soon" is what a fabricated fallback produces. Prove the fallback
  // still exists for TEMPLATES (deliberate: a built-in confirm degrades to it)
  // while the model can no longer reach it.
  check('the literal "soon" fallback is still there for templates',
    renderBody('See you on {{date}}.', vars(), 'x').sms === 'See you on soon.',
    'template graceful-degradation changed unintentionally')

  console.log('\n── Tier 0: the portal-link marker survives a rewrite ───────────')

  const rw = await buildAssistInput(sb(), U, {
    task: 'draft_message', customerId: 'c1', template: 'invoice', channels: ['email'],
    currentText: 'Your invoice is ready. [Customer Portal Link]',
  })
  check('GUARDRAILS orders the portal marker preserved verbatim',
    rw.system.includes('[Customer Portal Link]') && /PRESERVE VERBATIM/.test(rw.system),
    'the preserve rule is missing — a rewrite can drop the pay link')
  check('GUARDRAILS no longer bans "bracketed placeholders of any kind"',
    !/NEVER output bracketed placeholders of any kind/.test(rw.system),
    'the contradiction is back: one rule bans [X], the next requires [Customer Portal Link]')
  check('GUARDRAILS still forbids INVENTING placeholders',
    /NEVER INVENT a placeholder/.test(rw.system),
    'the invented-placeholder ban was lost')

  console.log('\n── Tier 0: an unrated review is never treated as 5 stars ───────')

  const unrated = await buildAssistInput(sb(), U, { task: 'review_response', customerId: 'c1', source: 'Google' })
  check('unknown rating does NOT select the positive shape',
    !/thank them genuinely and SPECIFICALLY/.test(unrated.system),
    'an unrated review still drafts an effusive 5-star thank-you')
  check('unknown rating states the sentiment is unknown',
    /sentiment is UNKNOWN/.test(unrated.system) && /not recorded/.test(unrated.prompt),
    'the prompt does not tell the model the rating is missing')
  check('rating 0 is treated as unknown, not as 1 star',
    !/A critical review/.test((await buildAssistInput(sb(), U, { task: 'review_response', customerId: 'c1', rating: 0 })).system),
    '0 fell through to the critical branch')
  const five = await buildAssistInput(sb(), U, { task: 'review_response', customerId: 'c1', rating: 5 })
  check('a real 5-star review still gets the positive shape',
    /thank them genuinely and SPECIFICALLY/.test(five.system), 'the positive branch regressed')
  const one = await buildAssistInput(sb(), U, { task: 'review_response', customerId: 'c1', rating: 1 })
  check('a real 1-star review still gets the critical shape',
    /A critical review/.test(one.system), 'the critical branch regressed')

  console.log('\n── Tier 1: quote_scope gets the facts it always had ────────────')

  const scope = await buildAssistInput(sb(), U, {
    task: 'quote_scope', customerId: 'c1',
    services: [
      { name: 'Drain Cleaning', notes: 'snake the main stack from the basement cleanout' },
      { name: 'Leak Repair', notes: 'under-sink shutoff is seized, replace it' },
    ],
  })
  // The builder collected these, sent them over the wire, and read only s.name.
  check('quote_scope receives the owner\'s per-line-item notes',
    scope.prompt.includes('snake the main stack from the basement cleanout') &&
    scope.prompt.includes('under-sink shutoff is seized'),
    `line-item notes still dropped:\n${scope.prompt}`)
  check('quote_scope still lists the line items in order',
    scope.prompt.indexOf('Drain Cleaning') < scope.prompt.indexOf('Leak Repair'), '')

  console.log('\n── Tier 1: quote_scope knows the customer — safely ─────────────')

  const repeat = await buildAssistInput(sb({
    jobs: [
      { title: 'x', service_type: 'Drain Cleaning', scheduled_date: '2026-04-11', status: 'completed', price: 240, notes: null },
      { title: 'x', service_type: 'Leak Repair', scheduled_date: '2026-01-08', status: 'completed', price: 180, notes: null },
    ],
    invoices: [{ invoice_number: '1042', status: 'sent', amount: 500, amount_paid: 0, due_date: '2026-01-01', created_at: '2025-12-01' }],
  }), U, { task: 'quote_scope', customerId: 'c1', services: [{ name: 'Drain Cleaning' }] })
  check('quote_scope can reference real visit history',
    /existing customer: 2 completed visits/.test(repeat.prompt) && repeat.prompt.includes('2026-04-11'),
    `history missing:\n${repeat.prompt}`)

  // The output prints on the customer's quote PDF, so the private dossier must
  // NOT be in this prompt — no owner notes, no money, no invoice numbers.
  check('quote_scope does NOT receive the owner\'s private customer notes',
    !repeat.prompt.includes('Dog in the yard'),
    'private notes leaked into a customer-facing document\'s prompt')
  check('quote_scope does NOT receive money or invoice numbers',
    !repeat.prompt.includes('#1042') && !/collected all-time/.test(repeat.prompt),
    'the money dossier leaked into a customer-facing document\'s prompt')
  check('quote_scope is still forbidden from stating a price',
    /NEVER state or estimate any price/.test(repeat.system), 'the price ban regressed')

  console.log('\n── Tier 1: property notes are used when Vision has no data ─────')

  // getPropertyContext reads property_intelligence, which is empty in production;
  // the properties row the owner typed themselves was always there.
  const withProp = await buildAssistInput(sb({ property_intelligence: [] }), U, {
    task: 'quote_scope', customerId: 'c1', services: [{ name: 'Drain Cleaning' }],
  })
  check('quote_scope falls back to the property the owner described',
    withProp.prompt.includes('Park on the street'),
    `property notes still missing when Vision has no row:\n${withProp.prompt}`)
  check('property notes carry a do-not-leak-the-gate-code rule',
    /never repeat a gate code/i.test(withProp.prompt),
    'private site notes reach a customer-facing document with no rule attached')
  const noProp = await buildAssistInput(sb({ properties: [] }), U, {
    task: 'quote_scope', customerId: 'c1', services: [{ name: 'Drain Cleaning' }],
  })
  check('no property on file → no property line invented',
    !/site notes/.test(noProp.prompt), 'a property line appeared from nowhere')

  console.log('\n── Tier 1: the money messages have a stated goal ───────────────')

  const q = await buildAssistInput(sb(), U, { task: 'draft_message', customerId: 'c1', template: 'quote', channels: ['email'] })
  check('the quote message has its own intent (not "infer it")',
    /send the customer their quote/.test(q.prompt) && !/infer the intent from their draft/.test(q.prompt),
    'quote still falls through to the custom/infer intent')
  const i = await buildAssistInput(sb(), U, { task: 'draft_message', customerId: 'c1', template: 'invoice', channels: ['email'] })
  check('the invoice message has its own intent (not "infer it")',
    /send the customer their invoice/.test(i.prompt) && !/infer the intent from their draft/.test(i.prompt),
    'invoice still falls through to the custom/infer intent')
  check('the quote intent still bans restating the price',
    /never restate or estimate the price/.test(q.prompt), '')
  check('custom still infers (unchanged)',
    /infer the intent from their draft/.test((await buildAssistInput(sb(), U, { task: 'draft_message', customerId: 'c1', template: 'custom', channels: ['sms'] })).prompt), '')

  console.log('\n── Tier 1: an email is written as an email ─────────────────────')

  const smsOnly = await buildAssistInput(sb(), U, { task: 'draft_message', customerId: 'c1', template: 'confirm', channels: ['sms'] })
  const emailOnly = await buildAssistInput(sb(), U, { task: 'draft_message', customerId: 'c1', template: 'confirm', channels: ['email'] })
  const both = await buildAssistInput(sb(), U, { task: 'draft_message', customerId: 'c1', template: 'confirm', channels: ['sms', 'email'] })
  check('SMS-only asks for a TEXT MESSAGE', /Format: a TEXT MESSAGE/.test(smsOnly.system), '')
  check('email-only asks for an EMAIL body', /Format: an EMAIL body/.test(emailOnly.system), 'email-only still gets the text-shaped rules')
  check('email-only is NOT squeezed under 500 characters',
    !/under 500 characters/.test(emailOnly.system),
    'an email is still being written to SMS length limits')
  check('email-only differs from the both-channels shape',
    emailOnly.system !== both.system, 'email and both resolve to the same prompt')
  check('both-channels still writes for the text',
    /under 500 characters/.test(both.system), 'the combined shape regressed')

  console.log('\n── Tier 1: the trade comes from the owner\'s own catalog ────────')

  check('the service catalog is the stated authority',
    /their own service list, treat it as the authority/.test(smsOnly.system) &&
    smsOnly.system.includes('Drain Cleaning'),
    `the curated catalog is not in the prompt:\n${smsOnly.system}`)
  // The whole point of businessContext: jobs.service_type is polluted free text.
  check('polluted job history is NOT presented as a service the business sells',
    !/sells:[^.]*Robert mowing/.test(smsOnly.system) && !/sells:[^.]*Call\b/.test(smsOnly.system),
    `a customer's name is being sold as a service:\n${smsOnly.system}`)
  check('a plumber\'s prompt contains no lawn language',
    !/\blawn\b|\bmow(ing)?\b|\bgrass\b/i.test(smsOnly.system.replace(/Robert mowing/g, '')),
    'lawn language leaked into a plumber\'s message prompt')

  // No templates yet (a brand-new account) must not get a WORSE prompt: it falls
  // back to reading the trade from context, exactly as before.
  const unknown = await buildAssistInput(fakeSb({ ...base, service_templates: [], jobs: [] }), U, {
    task: 'draft_message', customerId: 'c1', template: 'confirm', channels: ['sms'],
  })
  check('a business with no catalog asserts no trade at all',
    /Never assume a trade/.test(unknown.system) && !/service list, treat it as the authority/.test(unknown.system),
    'an unreadable business had a trade invented for it')

  console.log('\n── Unchanged invariants ───────────────────────────────────────')
  check('customer_summary still acts on signal #1', /act on signal #1/.test((await buildAssistInput(sb(), U, { task: 'customer_summary', customerId: 'c1' })).system), '')
  check('job_notes still demands verbatim codes/digits', /VERBATIM/.test((await buildAssistInput(sb(), U, { task: 'job_notes', draft: 'gate 4417 leaky tap' })).system), '')
  check('job_notes still refuses an empty draft',
    await buildAssistInput(sb(), U, { task: 'job_notes', draft: '' }).then(() => false).catch(() => true),
    'an empty draft no longer throws')

  console.log(failures === 0
    ? '\n✓ AI assist facts, tokens and guardrails verified.\n'
    : `\n✗ ${failures} check(s) failed.\n`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch(e => { console.error(e); process.exit(1) })
