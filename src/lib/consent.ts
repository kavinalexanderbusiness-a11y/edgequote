import type { SupabaseClient } from '@supabase/supabase-js'

// ── Communication consent ────────────────────────────────────────────────────
// One place to apply an SMS/email opt-in change AND write the audit trail, so the
// single-customer toggle, bulk actions, and import all log who/when/old→new the
// same way. Customers are NEVER opted in automatically.

export type ConsentChannel = 'sms' | 'email'
export type ConsentSource = 'single' | 'bulk' | 'portal' | 'import'

// The exact wording shown before enabling SMS for anyone — carriers/Twilio/CASL
// require explicit prior consent.
export const SMS_CONSENT_WARNING =
  'Only enable SMS consent for customers who have explicitly agreed to receive text messages. Improper use may violate carrier, Twilio, or anti-spam regulations.'

export interface ConsentTarget { id: string; sms_opt_in: boolean; email_opt_in: boolean }

// Set ONE channel to ONE value across many customers (covers the single toggle
// and every bulk action). Updates only the rows whose value actually changes,
// and writes one consent_changes row per real change. Returns how many changed.
export async function applyConsent(
  supabase: SupabaseClient,
  opts: {
    targets: ConsentTarget[]
    channel: ConsentChannel
    value: boolean
    userId: string
    changedBy: string
    source: ConsentSource
  },
): Promise<{ changed: number; error?: string }> {
  const { targets, channel, value, userId, changedBy, source } = opts
  const col = channel === 'sms' ? 'sms_opt_in' : 'email_opt_in'
  const changed = targets.filter(t => (channel === 'sms' ? t.sms_opt_in : t.email_opt_in) !== value)
  if (changed.length === 0) return { changed: 0 }

  const ids = changed.map(t => t.id)
  const { error: upErr } = await supabase.from('customers').update({ [col]: value }).in('id', ids)
  if (upErr) return { changed: 0, error: upErr.message }

  // Best-effort audit — never block the consent change on a logging failure.
  const auditRows = changed.map(t => ({
    user_id: userId,
    customer_id: t.id,
    channel,
    old_value: channel === 'sms' ? t.sms_opt_in : t.email_opt_in,
    new_value: value,
    source,
    changed_by: changedBy,
  }))
  await supabase.from('consent_changes').insert(auditRows)
  return { changed: changed.length }
}

// Record consent audit rows for a freshly-imported batch (the rows are inserted
// elsewhere; this only logs the opt-in state they were created with).
export async function recordImportConsent(
  supabase: SupabaseClient,
  opts: { userId: string; changedBy: string; rows: { customerId: string; sms: boolean; email: boolean }[] },
): Promise<void> {
  const audit: Record<string, unknown>[] = []
  for (const r of opts.rows) {
    if (r.sms) audit.push({ user_id: opts.userId, customer_id: r.customerId, channel: 'sms', old_value: false, new_value: true, source: 'import', changed_by: opts.changedBy })
    if (r.email) audit.push({ user_id: opts.userId, customer_id: r.customerId, channel: 'email', old_value: false, new_value: true, source: 'import', changed_by: opts.changedBy })
  }
  if (audit.length) await supabase.from('consent_changes').insert(audit)
}
