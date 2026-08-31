// READ-ONLY report on live quotes whose configured deposit contradicts the
// tenant's CURRENT terms_text.  npx tsx scripts/terms-conflict-live-report.ts
//
// ⛔ SELECTs only. No insert/update/delete, no writing RPC, no message.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { detectTermsTimingConflict } from '../src/lib/payments/termsTimingConflict'
import type { GateQuote } from '../src/lib/payments/depositGate'

async function main() {
  const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
  const { data: auth, error } = await sb.auth.signInWithPassword({ email: env.PORTAL_RPC_OWNER_EMAIL!, password: env.PORTAL_RPC_OWNER_PASSWORD! })
  if (error) { console.error('sign-in failed:', error.message); process.exit(2) }
  const uid = auth.user!.id

  const { data: bs } = await sb.from('business_settings').select('terms_text').eq('user_id', uid).maybeSingle()
  const terms = (bs as { terms_text: string | null } | null)?.terms_text ?? null

  const { data: quotes } = await sb.from('quotes')
    .select('id, quote_number, status, total, accepted_price, deposit_type, deposit_value, sent_at, customer_id, customer_name')
    .eq('user_id', uid)
  const rows = (quotes || []) as (GateQuote & {
    id: string; quote_number: string; sent_at: string | null
    customer_id: string | null; customer_name: string | null })[]

  const hits = rows.filter(q => detectTermsTimingConflict(q, terms))
  console.log('CURRENT TERMS:\n' + terms + '\n')
  console.log('AFFECTED: ' + hits.length + ' of ' + rows.length + '\n')

  for (const q of hits) {
    const c = detectTermsTimingConflict(q, terms)!
    const [acc, jobs, invs, tok] = await Promise.all([
      sb.from('quote_acceptances').select('id, seq, kind, source, accepted_at, accepted_amount, terms_acknowledged').eq('quote_id', q.id).order('seq'),
      sb.from('jobs').select('id, scheduled_date, status').eq('quote_id', q.id),
      sb.from('invoices').select('invoice_number, status, amount, amount_paid').eq('quote_id', q.id),
      sb.from('customer_portal_tokens').select('token, revoked').eq('customer_id', q.customer_id!).eq('user_id', uid).maybeSingle(),
    ])
    // portal_accept_quote requires status='sent' + a live token. Nothing else.
    const liveToken = !!tok.data && !(tok.data as { revoked: boolean }).revoked
    const canAcceptNow = q.status === 'sent' && liveToken
    console.log('── ' + q.quote_number + ' (' + q.id + ')')
    console.log('   status           : ' + q.status)
    console.log('   customer         : ' + (q.customer_name ?? '—'))
    console.log('   total            : $' + q.total)
    console.log('   deposit rule     : ' + q.deposit_type + ' ' + q.deposit_value + (q.deposit_type === 'percent' ? '%' : ''))
    console.log('   sent_at          : ' + (q.sent_at ?? 'never'))
    console.log('   acceptance rows  : ' + ((acc.data?.length ?? 0) === 0 ? 'NONE'
      : acc.data!.map(a => `seq${a.seq} ${a.kind}/${a.source} @${a.accepted_at} $${a.accepted_amount} ack=${a.terms_acknowledged}`).join(' | ')))
    console.log('   scheduled        : ' + ((jobs.data?.length ?? 0) === 0 ? 'no'
      : jobs.data!.map(j => `${j.scheduled_date} (${j.status})`).join(', ')))
    console.log('   invoice          : ' + ((invs.data?.length ?? 0) === 0 ? 'none'
      : invs.data!.map(i => `${i.invoice_number} ${i.status} $${i.amount} paid $${i.amount_paid}`).join(', ')))
    console.log('   PORTAL CAN ACCEPT: ' + (canAcceptNow ? '⛔ YES — reachable right now' : 'no (status ' + q.status + ')'))
    console.log('   conflicting line : "' + c.sentence + '"')
  }
}
void main()
