import type { SupabaseClient } from '@supabase/supabase-js'

// THE single get-or-create for the one-conversation-per-customer model (UNIQUE
// (user_id, customer_id)). Fast path is a SELECT; a brand-new thread inserts-or-
// does-nothing on the unique constraint and re-selects if a concurrent writer won
// the race — so a message can never be dropped on the floor. Every channel (SMS
// reply, templated send, payment receipt) routes through here, so conversation
// creation lives in exactly ONE place. Works with any client (owner session or
// service role) since it only touches the owner's own rows.
export async function getOrCreateConversation(
  sb: SupabaseClient, userId: string, customerId: string,
): Promise<string | null> {
  const { data: existing } = await sb.from('conversations').select('id').eq('user_id', userId).eq('customer_id', customerId).maybeSingle()
  if (existing) return (existing as { id: string }).id
  const { data: created } = await sb.from('conversations')
    .upsert({ user_id: userId, customer_id: customerId, last_message_at: new Date().toISOString() }, { onConflict: 'user_id,customer_id', ignoreDuplicates: true })
    .select('id').maybeSingle()
  if (created) return (created as { id: string }).id
  const { data: ex } = await sb.from('conversations').select('id').eq('user_id', userId).eq('customer_id', customerId).maybeSingle()
  return (ex as { id: string } | null)?.id ?? null
}
