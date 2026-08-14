import type { SupabaseClient } from '@supabase/supabase-js'

// ── Tenant capabilities — what the PLATFORM permits a business to use ─────────
// The deployment has ONE Stripe account, ONE Twilio number and ONE Resend
// sending identity, and all three belong to the founding business. Every gate
// that asks "does the deployment have this key?" (stripeEnabled, commsEnabled)
// answers the wrong question for a second tenant: a private-beta business's Pay
// button would settle money into another business's Stripe balance, and its
// messages would go out from another business's number.
//
// So availability is TWO layers, both required:
//   1. the deployment has the credential          — stripeEnabled()/commsEnabled()
//   2. THIS tenant may use the shared credential  — tenantCapabilities(sb, userId)
//
// Layer 2 is read from `platform_capabilities`, a platform-managed table with no
// write path from any signed-in role (SELECT-own is its only policy — see
// supabase/archive/run/RUN-2026-08-13-platform-capabilities.sql). A business cannot grant
// itself a capability, and the customer portal cannot reach around it: every
// server door re-derives the answer from the tenant it resolved, never from the
// client. A missing row means NO capabilities — each future tenant starts
// restricted by construction, and a failed read is treated the same way (a
// capability we cannot verify is a capability the caller does not have; for
// money and messaging, refusing is the safe wrong answer).
//
// NOT in scope here: things a business composes for itself (enabled_modules) or
// that are theirs alone (offline payment recording, quotes, the portal). This
// gates only what is SHARED across the deployment.

export interface TenantCapabilities {
  /** Stripe checkout / save card / AutoPay — money settles into the deployment's one Stripe account. */
  onlinePayments: boolean
  /** Inbound SMS on the shared Twilio number may resolve to this tenant's customers. */
  inboundSms: boolean
  /** Outbound SMS from the shared Twilio number. */
  outboundSms: boolean
  /** Outbound email from the shared Resend identity. */
  outboundEmail: boolean
}

export const NO_CAPABILITIES: TenantCapabilities = Object.freeze({
  onlinePayments: false, inboundSms: false, outboundSms: false, outboundEmail: false,
})

// The ONE honest sentence per refused capability — shared by every door and
// surface so a disabled capability reads as intentional, never as broken.
export const CAPABILITY_MESSAGE = {
  payments: "Online payments aren't enabled for this business.",
  sms: "Text messaging isn't enabled for this business.",
  email: "Email sending isn't enabled for this business.",
} as const

// THE tenant capability read. `sb` may be a service-role client (webhooks,
// crons, portal doors — pass the OWNER's user_id you resolved server-side) or a
// signed-in session client (the RLS SELECT-own policy answers for the caller's
// own tenant; any other user_id correctly reads as no row → no capabilities —
// which is also why a crew session, whose uid has no row, can never exercise a
// tenant capability of its own).
export async function tenantCapabilities(
  sb: SupabaseClient, userId: string | null | undefined,
): Promise<TenantCapabilities> {
  if (!userId) return NO_CAPABILITIES
  const { data, error } = await sb.from('platform_capabilities')
    .select('online_payments, inbound_sms, outbound_sms, outbound_email')
    .eq('user_id', userId).maybeSingle()
  if (error || !data) return NO_CAPABILITIES
  const d = data as { online_payments: boolean; inbound_sms: boolean; outbound_sms: boolean; outbound_email: boolean }
  return {
    onlinePayments: !!d.online_payments,
    inboundSms: !!d.inbound_sms,
    outboundSms: !!d.outbound_sms,
    outboundEmail: !!d.outbound_email,
  }
}
