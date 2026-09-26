import type { SupabaseClient } from '@supabase/supabase-js'
import { governCheck } from './governor'
import type { ReachCustomer } from './reach'

// Dormant server integration. No route, scheduler, migration, secret storage or
// provider is configured by importing this module. Never expose these records
// to the browser; the connection contains a private secret reference.
export type PilotRecord = Record<string, unknown>
export type PilotConnection = {
  id: string; user_id: string; account_scope: string; credential_version: string
  secret_ref: string; from_address: string; receiving_domain: string; state: string
}
export type PilotWorkflow = {
  id: string; user_id: string; connection_id: string; account_scope: string
  credential_version: string; customer_id: string; quote_id: string; state: string
}
export interface PilotStore {
  rpc(name: string, args: PilotRecord): Promise<PilotRecord>
  connection(id: string): Promise<PilotConnection | null>
  workflow(id: string): Promise<PilotWorkflow | null>
  customer(owner: string, id: string): Promise<ReachCustomer | null>
  govern(owner: string, customer: string): Promise<boolean>
}

export function record(value: unknown): PilotRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as PilotRecord : null
}
export function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function createPilotStore(sb: SupabaseClient): PilotStore {
  const read = async (table: string, fields: string, id: string, owner?: string) => {
    let query = sb.from(table).select(fields).eq('id', id)
    if (owner) query = query.eq('user_id', owner)
    const result = await query.maybeSingle()
    if (result.error) throw new Error('pilot_store_unavailable')
    return result.data
  }
  return {
    async rpc(name, args) {
      if (!/^pilot_email_[a-z_]+$/.test(name)) throw new Error('pilot_invalid_operation')
      const result = await sb.rpc(name, args)
      const data = record(result.data)
      if (result.error || !data || typeof data.code !== 'string') throw new Error('pilot_store_unavailable')
      return data
    },
    async connection(id) {
      return await read('pilot_email_connections', 'id,user_id,account_scope,credential_version,secret_ref,from_address,receiving_domain,state', id) as PilotConnection | null
    },
    async workflow(id) {
      return await read('pilot_quote_followup_workflows', 'id,user_id,connection_id,account_scope,credential_version,customer_id,quote_id,state', id) as PilotWorkflow | null
    },
    async customer(owner, id) {
      return await read('customers', 'phone,email,sms_opt_in,email_opt_in,message_prefs,preferred_channel', id, owner) as ReachCustomer | null
    },
    async govern(owner, customer) {
      // Keep the shared policy as an early check. Its service-message count
      // failures allow sending; the authoritative pilot SQL start is stricter
      // and refuses unknown reads while reserving capacity under an owner lock.
      return (await governCheck(sb, { userId: owner, customerId: customer, template: 'estimate_followup' })).allowed
    },
  }
}
