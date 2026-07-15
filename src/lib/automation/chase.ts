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
//   • REFUND THE ATTEMPT WHEN THE PROVIDER — NOT THE MESSAGE — FAILED. Claiming
//     first means the attempt is spent before we know whether anything went out,
//     and sendSms/sendEmail report an outage by RETURNING { sent:false }, not by
//     throwing. So a Twilio outage silently burned attempts: two failed runs
//     retired a quote forever having never sent one message. Now a retryable
//     failure (see lib/comms/send: network/timeout/429/5xx) hands the attempt back
//     via spec.refund, and the item is due again next run.
//     A NON-retryable failure keeps the attempt spent, deliberately: a permanently
//     bad number is a fact about the customer, and refunding it would chase a typo
//     forever.
//     Only the ATTEMPT BUDGET is refunded — never the anchor
//     (last_followed_up_at / last_reminded_at). The anchor moved on purpose: it is
//     the backoff that stops a broken provider from being hammered on every run.
//     Refunding it would turn an outage into a retry storm.
//   • ONE BAD ITEM MUST NOT ABORT THE BATCH — otherwise the rest of the owner's
//     book goes unchased until tomorrow, from one malformed row. A throw is also
//     refunded: a render that dies (e.g. ensurePortalToken failing) has definitely
//     sent nothing, so the attempt was never really taken.
//   • 'error', NOT 'failed', on the log row. A throw means we don't know whether a
//     provider got the message, so it must stay retryable. 'failed' is reserved for
//     a provider telling us delivery failed (lib/comms/delivery SENT_STATES) and
//     suppresses future attempts. NOTE: that distinction lives in notification_log
//     for the delivery webhooks — no chaser reads it back, so it is not what
//     protects the attempt budget. spec.refund is.
//   • The tally means something: `chased` counts CLAIMS, `sent`/`skipped` count
//     what dispatch actually did, and `failed` counts attempts handed back — so a
//     provider outage reads as `failed`, not as a quiet pile of `skipped`.
//
// A third chaser gets all of that by construction instead of by remembering. What
// stays with each chaser is only what's genuinely its own: the query, its stop
// conditions, its policy, its CAS statements, and its message.

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
  /** Give the claimed ATTEMPT back when the provider failed in a way that could
   *  succeed later, or when nothing was even attempted. Mirror `claim`'s CAS and
   *  guard on the value the claim WROTE (seen + 1), so a concurrent run that has
   *  since re-claimed the row can't be clobbered — losing the guard is better than
   *  handing back an attempt someone else is spending.
   *  Do NOT restore the anchor here: the backoff it provides is what keeps a
   *  retry loop from becoming a hammer. Optional — a chaser with no budget to
   *  refund simply omits it. */
  refund?(item: T): Promise<void>
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

  // Best-effort by construction. A refund runs on the failure path — including
  // inside the catch below — so letting it throw would abort the batch from the
  // exact position that exists to stop one bad row doing that. Worst case if it
  // fails: one attempt stays spent, which is merely the old behaviour.
  const refund = async (item: T): Promise<void> => {
    try { await spec.refund?.(item) } catch { /* an un-refunded attempt is not worth the batch */ }
  }

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

      // Nothing went out AND at least one channel failed in a way that could work
      // later (provider down / timed out / rate-limited) → the attempt bought us
      // nothing, so hand it back.
      const sentAny = res.sentChannels.length > 0
      const retryableFail = !sentAny && res.attempts.some(a => !a.sent && a.status === 'error' && a.retryable)

      if (sentAny) tally.sent++
      else if (retryableFail) { await refund(item); tally.failed++ }
      // A genuine skip: opted out, no contact on file, or a hard provider rejection.
      // The attempt is CORRECTLY spent — there is nothing here a retry would fix.
      else tally.skipped++
    } catch (e) {
      // Thrown before or during dispatch (a render that dies, a client blowing up).
      // Nothing was sent, so the attempt was never really taken — refund it, or one
      // bad portal token would retire the quote with zero messages.
      tally.failed++
      await refund(item)
      await logSend(sb, {
        userId: item.user_id, customerId: item.customer_id, channel: 'sms',
        template: spec.template, status: 'error',
        detail: e instanceof Error ? e.message.slice(0, 200) : spec.errorLabel,
      })
    }
  }

  return tally
}
