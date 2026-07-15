import type { SupabaseClient } from '@supabase/supabase-js'
import { dispatchToCustomer, type DispatchCustomer } from '@/lib/comms/dispatch'
import { logDispatch, logSend } from '@/lib/comms/log'

// ── runChaseCron — THE chase loop ────────────────────────────────────────────
// The quote chaser and the invoice chaser were the same loop written twice. What
// they actually share isn't much code — it's the parts that are easy to get subtly
// wrong, and dangerous when you do:
//
//   • CLAIM BEFORE SENDING. The compare-and-swap has to happen before dispatch, or
//     two overlapping cron runs both send. Order is the safety property.
//   • 'error', NOT 'failed'. A throw means we don't know whether a provider got the
//     message, so it must stay retryable. 'failed' is reserved for a provider
//     telling us delivery failed (lib/comms/delivery SENT_STATES) and suppresses
//     future attempts. Getting this backwards silently stops chasing real money.
//   • ONE BAD ITEM MUST NOT ABORT THE BATCH — otherwise the rest of the owner's
//     book goes unchased until tomorrow, from one malformed row.
//   • The tally means something: `chased` counts CLAIMS (attempts consumed),
//     `sent`/`skipped` count what dispatch actually did.
//
// A third chaser gets all of that by construction instead of by remembering. What
// stays with each chaser is only what's genuinely its own: the query, its stop
// conditions, its policy, its CAS statement, and its message.

export interface ChaseTally { chased: number; sent: number; skipped: number; failed: number }

/** The rendered message + whatever the chaser wants on the thread bubble's meta. */
export interface ChaseMessage {
  smsText: string
  emailSubject: string
  emailHtml: string
  emailText: string
  meta?: Record<string, unknown>
}

/** The shape both chasers' rows already have. The joined `customers` row carries
 *  everything dispatch needs EXCEPT the id, which lives on the parent as
 *  `customer_id` — so the runner recombines them exactly as the routes did. */
export interface ChaseItem {
  id: string
  user_id: string
  customer_id: string | null
  customers: Omit<DispatchCustomer, 'id'> | null
}

export interface ChaseSpec<T extends ChaseItem, Ctx> {
  items: T[]
  /** notification_log.template + the dispatch template key. */
  template: string
  /** Fallback detail when a thrown error has no message. */
  errorLabel: string
  /** The chaser's own priority — chase the stalest money first, so a partial run
   *  still does the most valuable work. */
  sort?(a: T, b: T): number
  /** Per-owner settings. Called once per owner and cached by the runner. */
  loadContext(userId: string): Promise<Ctx>
  /** Has the owner switched THIS chaser on? */
  enabled(ctx: Ctx): boolean
  /** Domain stop conditions checked before anything is loaded (e.g. already
   *  invoiced, expired). Cheap and absolute. */
  skip?(item: T): boolean
  /** The ONE engine that decides due-ness for this domain. */
  due(item: T, ctx: Ctx): boolean
  /** Compare-and-swap. True only if THIS run won the claim. */
  claim(item: T): Promise<boolean>
  render(item: T, ctx: Ctx): Promise<ChaseMessage>
}

export async function runChaseCron<T extends ChaseItem, Ctx>(
  sb: SupabaseClient,
  spec: ChaseSpec<T, Ctx>,
): Promise<ChaseTally> {
  const tally: ChaseTally = { chased: 0, sent: 0, skipped: 0, failed: 0 }
  const cache: Record<string, Ctx> = {}
  const context = async (userId: string): Promise<Ctx> =>
    (cache[userId] ??= await spec.loadContext(userId))

  const ordered = spec.sort ? [...spec.items].sort(spec.sort) : spec.items

  for (const item of ordered) {
    if (spec.skip?.(item)) continue
    const ctx = await context(item.user_id)
    if (!spec.enabled(ctx)) continue
    if (!spec.due(item, ctx)) continue

    // Claim FIRST. The loser of a race gets nothing back and moves on, so the same
    // item can never be chased twice. Moving the anchor here is also what spaces
    // the next chase.
    if (!(await spec.claim(item))) continue
    tally.chased++

    try {
      const msg = await spec.render(item, ctx)
      const res = await dispatchToCustomer(sb, {
        userId: item.user_id,
        customer: { id: item.customer_id!, ...item.customers! },
        channels: ['sms', 'email'],
        smsText: msg.smsText,
        emailSubject: msg.emailSubject,
        emailHtml: msg.emailHtml,
        emailText: msg.emailText,
        template: spec.template,
        meta: msg.meta,
      })
      await logDispatch(sb, res, { userId: item.user_id, customerId: item.customer_id, template: spec.template })
      if (res.sentChannels.length) tally.sent++; else tally.skipped++
    } catch (e) {
      tally.failed++
      await logSend(sb, {
        userId: item.user_id, customerId: item.customer_id, channel: 'sms',
        template: spec.template, status: 'error',
        detail: e instanceof Error ? e.message.slice(0, 200) : spec.errorLabel,
      })
    }
  }

  return tally
}
