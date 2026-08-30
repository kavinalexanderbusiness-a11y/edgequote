// ── Backfill the terms payment classification ────────────────────────────────
//   npx tsx scripts/backfill-terms-claim.ts          (REPORT ONLY — the default)
//   npx tsx scripts/backfill-terms-claim.ts --apply  (writes the three columns)
//
// Runs at S106 landing time, AFTER the schema is applied and BEFORE the
// acceptance gate is trusted. Until a tenant is classified, the gate reads
// `unclassified` and fails closed for quotes under terms — so this is not
// optional decoration, it is the step that makes the feature usable.
//
// ⭐ Uses the CANONICAL TypeScript classifier. ⛔ It does not classify prose in
// SQL and never will: a second rule set would drift from the first and the drift
// would be invisible.
//
// ⛔ Never writes terms_text. The owner's words are read, classified, and left
// exactly as they are.
//
// Reports before it writes, and REPORT-ONLY is the default: a silent backfill of
// a guessed claim is how a gate this strict becomes a mystery outage.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import {
  classifyTermsPaymentClaim, termsClaimPatch, termsFingerprint,
  TERMS_CLASSIFIER_VERSION, termsClaimSentence,
} from '../src/lib/payments/termsTimingConflict'

type Row = {
  user_id: string
  terms_text: string | null
  terms_payment_claim: string | null
  terms_payment_claim_fingerprint: string | null
  terms_payment_claim_version: number | null
}

async function main() {
  const apply = process.argv.includes('--apply')
  const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { console.error('need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY'); process.exit(2) }
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const { data, error } = await sb.from('business_settings')
    .select('user_id, terms_text, terms_payment_claim, terms_payment_claim_fingerprint, terms_payment_claim_version')
  if (error) { console.error('read failed:', error.message); process.exit(2) }
  const rows = (data || []) as Row[]

  console.log(`\nclassifier version ${TERMS_CLASSIFIER_VERSION} · ${rows.length} tenant(s)\n`)
  let changed = 0
  for (const r of rows) {
    const claim = classifyTermsPaymentClaim(r.terms_text)
    const fp = termsFingerprint(r.terms_text)
    const current = r.terms_payment_claim
    const fresh = current === claim
      && r.terms_payment_claim_fingerprint === fp
      && r.terms_payment_claim_version === TERMS_CLASSIFIER_VERSION
    const sentence = termsClaimSentence(r.terms_text, claim)
    console.log(`tenant ${r.user_id}`)
    console.log(`  terms        : ${r.terms_text === null ? 'NULL' : r.terms_text.trim().length + ' chars'}`)
    console.log(`  fingerprint  : ${fp}`)
    console.log(`  claim        : ${claim}${fresh ? '  (already current)' : '  ← would write'}`)
    console.log(`  version      : ${TERMS_CLASSIFIER_VERSION}`)
    if (sentence) console.log(`  evidence     : "${sentence}"`)
    if (!fresh) changed++
  }

  if (!apply) {
    console.log(`\nREPORT ONLY — ${changed} tenant(s) would be written. Re-run with --apply to write.`)
    return
  }
  for (const r of rows) {
    const patch = termsClaimPatch(r.terms_text)
    // ⛔ The three classification columns ONLY. terms_text is never in this
    // update — the backfill cannot alter what it classified.
    const { error: uErr } = await sb.from('business_settings').update(patch).eq('user_id', r.user_id)
    if (uErr) { console.error(`  ✗ ${r.user_id}: ${uErr.message}`); process.exitCode = 1 }
  }
  console.log(`\napplied to ${rows.length} tenant(s).`)
}
void main()
