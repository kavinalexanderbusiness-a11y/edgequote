// READ-ONLY live measurement for the terms-vs-timing gate.
//   npx tsx scripts/terms-conflict-measure.ts
//
// A BLOCKING gate must be measured against REAL rows before it is believed. A
// pattern set that looks precise on a hand-written corpus can still fire on the
// one sentence the owner actually wrote — and this gate stops sends.
//
// No insert, update, delete, or writing RPC. Two selects.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { detectTermsTimingConflict } from '../src/lib/payments/termsTimingConflict'
import type { GateQuote } from '../src/lib/payments/depositGate'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL || env.BACKFILL_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD || env.BACKFILL_OWNER_PASSWORD
if (!URL_ || !ANON || !EMAIL || !PASSWORD) { console.error('missing creds in .env.local'); process.exit(2) }

async function main() {
const sb = createClient(URL_, ANON, { auth: { persistSession: false } })
const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
if (authErr) { console.error('sign-in failed:', authErr.message); process.exit(2) }
const uid = auth.user!.id

const { data: bs, error: bsErr } = await sb.from('business_settings').select('terms_text').eq('user_id', uid).maybeSingle()
if (bsErr) { console.error('business_settings read failed:', bsErr.message); process.exit(2) }
const terms = (bs as { terms_text: string | null } | null)?.terms_text ?? null

const { data: quotes, error: qErr } = await sb.from('quotes')
  .select('id, quote_number, status, total, accepted_price, deposit_type, deposit_value').eq('user_id', uid)
if (qErr) { console.error('quotes read failed:', qErr.message); process.exit(2) }
const rows = (quotes || []) as (GateQuote & { id: string; quote_number: string })[]

console.log('\n== Live measurement ==')
console.log('terms_text:', terms === null ? 'NULL (no terms set)' : terms.length + ' chars')
if (terms) console.log('---\n' + terms + '\n---')
console.log('quotes: ' + rows.length + ' total, ' + rows.filter(q => q.deposit_type).length + ' carrying a deposit rule')

let blocked = 0
for (const q of rows) {
  const c = detectTermsTimingConflict(q, terms)
  if (c) { blocked++; console.log('  BLOCKED ' + q.id + ' ' + q.quote_number + ' [' + (q.deposit_type ?? 'no rule') + '] -> "' + c.sentence + '"') }
}
console.log('\n' + blocked + ' of ' + rows.length + ' real quotes would be blocked from sending.')
console.log(blocked === 0
  ? 'OK No live quote is affected - the gate is inert against today\u2019s data.'
  : 'WARN Live quotes are affected - review the list above before landing.')
}
void main()
