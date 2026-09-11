import type { SupabaseClient } from '@supabase/supabase-js'
import { boundedQuoteSaveRead, PilotQuoteSaveHttpRefusal, pilotQuoteSaveUnavailable } from './pilotQuoteSaveHttp'

/** Existing identity-only capability remains separate for dormant acceptance. */
export interface PilotQuoteIdentityAuth {
  getUser(): Promise<{ data: { user: { id: string } | null }; error?: unknown }>
}
export interface PilotQuoteSaveAuth extends PilotQuoteIdentityAuth {
  readOwnerRole(expectedOwner: string, signal: AbortSignal): Promise<{ data: unknown; error?: unknown }>
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v)
const row = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Use the request's canonical authenticated client, never the service client.
 * The RPC compares auth.uid() with expectedOwner in the SAME statement that
 * reads current_app_role(). A client/account change cannot lend another user's
 * owner role to the previously verified UUID, including an A→B→A change.
 * This read is not the write fence: native Save rechecks under its row lock. */
export function createPilotQuoteSaveAuth(client: SupabaseClient): PilotQuoteSaveAuth {
  return {
    getUser: () => client.auth.getUser(),
    async readOwnerRole(expectedOwner, signal) {
      if (!uuid(expectedOwner) || signal.aborted) throw pilotQuoteSaveUnavailable()
      const result = await client.rpc('pilot_quote_save_owner_role', { p_expected_owner: expectedOwner }).abortSignal(signal)
      return { data: result.data, error: result.error }
    },
  }
}

/** Mandatory, fail-closed owner gate shared by baseline and Save. Role read
 * failures remain distinct from a confirmed denial; neither touches the store. */
export async function requirePilotQuoteSaveOwner(auth: PilotQuoteSaveAuth, signal: AbortSignal, ms: number): Promise<string> {
  const session = await boundedQuoteSaveRead(() => auth.getUser(), signal, ms)
  if (session.error || !session.data?.user || !uuid(session.data.user.id)) throw new PilotQuoteSaveHttpRefusal('unauthenticated', 401)
  const owner = session.data.user.id
  const result = await boundedQuoteSaveRead(child => auth.readOwnerRole(owner, child), signal, ms)
  if (!result || result.error || !row(result.data)) throw pilotQuoteSaveUnavailable()
  const value = result.data, keys = Object.keys(value)
  if (keys.length === 1 && value.code === 'forbidden') throw new PilotQuoteSaveHttpRefusal('forbidden', 403)
  if (keys.length !== 2 || !keys.includes('owner_id') || !keys.includes('role') || value.owner_id !== owner) throw pilotQuoteSaveUnavailable()
  if (value.role === 'none' || value.role === 'crew') throw new PilotQuoteSaveHttpRefusal('forbidden', 403)
  if (value.role !== 'owner') throw pilotQuoteSaveUnavailable()
  return owner
}
