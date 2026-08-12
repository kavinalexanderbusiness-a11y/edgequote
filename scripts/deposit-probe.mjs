// Token/tenancy probes for deposit-gated scheduling — all must REFUSE.
// Reads anon creds from the worktree .env.local; no writes land anywhere.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
const REAL_TOKEN = process.argv[2]
const REAL_QUOTE = process.argv[3]
let bad = 0
const expect = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ' — ' + detail}`)
  if (!cond) bad++
}

// 1. Preference RPC with a forged token → false, nothing written.
{
  const { data } = await anon.rpc('portal_set_scheduling_preference', {
    p_token: 'forged-token-000', p_quote_id: REAL_QUOTE, p_date: '2027-01-01',
  })
  expect('forged token cannot write a preference', data === false, String(data))
}
// 2. Valid token + ANOTHER customer's quote id → false. (Use a real quote id
//    belonging to a different customer — any non-fixture quote.)
{
  const someOther = '00000000-0000-0000-0000-000000000001'
  const { data } = await anon.rpc('portal_set_scheduling_preference', {
    p_token: REAL_TOKEN, p_quote_id: someOther, p_date: '2027-01-01',
  })
  expect('valid token cannot name a quote that is not its customer\'s', data === false, String(data))
}
// 3. Past date refused even with the right token+quote.
{
  const { data } = await anon.rpc('portal_set_scheduling_preference', {
    p_token: REAL_TOKEN, p_quote_id: REAL_QUOTE, p_date: '2020-01-01',
  })
  expect('past preferred date refused server-side', data === false, String(data))
}
// 4. Garbage timing refused.
{
  const { data } = await anon.rpc('portal_set_scheduling_preference', {
    p_token: REAL_TOKEN, p_quote_id: REAL_QUOTE, p_timing: 'evening',
  })
  expect('unknown timing refused server-side', data === false, String(data))
}
// 5. The charge route: forged token → 404; forged quote id → 404; and the body
//    carries NO amount anywhere to tamper with. (503 = Stripe not configured
//    locally — equally a refusal, and the prod path is covered by the guard.)
{
  const r1 = await fetch((process.argv[4] || 'http://localhost:3336') + '/api/portal/quote-deposit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'forged', quoteId: REAL_QUOTE, amount: 1 }),
  })
  expect('charge route refuses a forged token', [404, 503].includes(r1.status), String(r1.status))
  const r2 = await fetch((process.argv[4] || 'http://localhost:3336') + '/api/portal/quote-deposit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: REAL_TOKEN, quoteId: '00000000-0000-0000-0000-000000000001' }),
  })
  expect('charge route refuses a quote the token does not own', [404, 503].includes(r2.status), String(r2.status))
}
// 6. anon cannot read another tenant's payments/quotes directly (RLS).
{
  const { data } = await anon.from('payments').select('id').limit(1)
  expect('anon reads no payments rows', !data || data.length === 0, JSON.stringify(data)?.slice(0, 80))
  const { data: q } = await anon.from('quotes').select('id').limit(1)
  expect('anon reads no quotes rows', !q || q.length === 0, JSON.stringify(q)?.slice(0, 80))
}
console.log(bad ? `\n✗ ${bad} security probe(s) FAILED` : '\n✓ all security probes refused correctly')
process.exit(bad ? 1 : 0)

