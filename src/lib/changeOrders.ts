import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeServiceKey } from '@/lib/jobPricing'
import { serviceCategory } from '@/lib/legacySeasonInference'

// ── Change orders: new scope, agreed after the original approval ─────────────
//
// ⭐⭐ A CHANGE ORDER IS AN AUTHORIZATION, NOT A SECOND MONEY PATH.
// `job_line_items` is already THE way extra priced scope reaches an invoice —
// lib/invoicing.buildInvoiceLineItems reads it for both the completed-job
// auto-draft and the draft re-price. So this module owns the ASKING and the
// ANSWERING; the database mints the line item on approval, and only on approval
// (trg_change_order_apply_approval + a partial unique index on change_order_id).
//
// Everything the mutation tests care about therefore holds BY CONSTRUCTION
// rather than by remembering a filter:
//   • a pending or declined change has no money row, so it cannot be invoiced
//     and cannot enter the authorized value;
//   • a second approval cannot mint a second line (unique index);
//   • the accepted quote is never written — nothing here touches `quotes`.
//
// The original approval stays exactly as the customer agreed it: quotes.total,
// quotes.accepted_price and the job's own price are read, never rewritten.

export const CHANGE_ORDER_STATUSES = ['draft', 'pending', 'approved', 'declined', 'cancelled'] as const
export type ChangeOrderStatus = typeof CHANGE_ORDER_STATUSES[number]

/** How a decision was recorded. Never inferred — see the column comment. */
export type ChangeOrderDecidedVia = 'portal' | 'owner'

export interface ChangeOrder {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  job_id: string
  customer_id: string
  quote_id: string | null
  co_number: string
  description: string
  amount: number
  service_key: string | null
  service_category: string | null
  status: ChangeOrderStatus
  decided_via: ChangeOrderDecidedVia | null
  decline_reason: string | null
  sent_at: string | null
  approved_at: string | null
  declined_at: string | null
  cancelled_at: string | null
}

/** What the owner sees on a status pill. Customer-facing wording lives in the portal. */
export const CHANGE_ORDER_LABELS: Record<ChangeOrderStatus, string> = {
  draft: 'Not sent',
  pending: 'Awaiting approval',
  approved: 'Approved',
  declined: 'Declined',
  cancelled: 'Withdrawn',
}

export const CHANGE_ORDER_TONES: Record<ChangeOrderStatus, string> = {
  draft: 'border-border text-ink-muted bg-bg-tertiary',
  pending: 'border-amber-500/40 text-amber-300 bg-amber-500/10',
  approved: 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10',
  declined: 'border-red-500/40 text-red-300 bg-red-500/10',
  cancelled: 'border-border text-ink-faint bg-bg-tertiary',
}

/** THE legal lifecycle, mirrored from change_order_guard_transition(). The DB is
 *  the enforcer; this exists so a button can be disabled instead of failing. */
const TRANSITIONS: Record<ChangeOrderStatus, ChangeOrderStatus[]> = {
  draft: ['pending', 'cancelled'],
  pending: ['approved', 'declined', 'cancelled'],
  approved: [],
  declined: [],
  cancelled: [],
}

export function canTransition(from: ChangeOrderStatus, to: ChangeOrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

/** A decided change order is history — nothing about it can move again. */
export function isSettled(status: ChangeOrderStatus): boolean {
  return TRANSITIONS[status].length === 0
}

// ── The authorized value ─────────────────────────────────────────────────────
//
// ⭐ ONE definition of "what is this job worth now", used by the owner's job card
// and the customer's portal alike. The three figures are kept SEPARATE on
// purpose: collapsing them is precisely the thing this feature exists to stop.
//
//   original         what was agreed when the work was approved (never rewritten)
//   approvedChanges  changes the customer has actually said yes to
//   authorized       original + approvedChanges  ← what the customer has agreed to
//   extras           priced add-ons the OWNER put on the visit without asking
//                    (the pre-existing add-on flow — shown, never silently folded
//                    into "authorized", because nobody approved them)
//   billable         authorized + extras — what an invoice for this visit will total
//   pending          asked for, not yet answered. ⛔ NEVER part of authorized.
export interface AuthorizedValue {
  original: number
  approvedChanges: number
  authorized: number
  extras: number
  billable: number
  pending: number
  declined: number
  pendingCount: number
  approvedCount: number
  hasChanges: boolean
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100
const sum = (rows: { amount: number | string }[]) => round2(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0))

export function authorizedValue(opts: {
  /** The visit's originally agreed value — lib/visitValue.jobVisitValue's answer. */
  originalValue: number
  changeOrders: Pick<ChangeOrder, 'status' | 'amount'>[] | null | undefined
  /**
   * The visit's job_line_items. Callers may pass ALL of them: rows minted by an
   * approval carry `change_order_id` and are filtered out here, so the approved
   * money is counted once — from the change orders — however this is called.
   * The portal has no line items and passes nothing.
   */
  lineItems?: { amount: number | string; change_order_id?: string | null }[] | null
}): AuthorizedValue {
  const cos = opts.changeOrders || []
  const approved = cos.filter(c => c.status === 'approved')
  const pending = cos.filter(c => c.status === 'pending')
  const declined = cos.filter(c => c.status === 'declined')

  const original = round2(opts.originalValue)
  const approvedChanges = sum(approved)
  // ⭐ The filter that makes double-counting impossible: an approved change's money
  // is counted from the change order, so its line item must not be counted again.
  const extras = sum((opts.lineItems || []).filter(l => !l.change_order_id))
  const authorized = round2(original + approvedChanges)

  return {
    original,
    approvedChanges,
    authorized,
    extras,
    billable: round2(authorized + extras),
    pending: sum(pending),
    declined: sum(declined),
    pendingCount: pending.length,
    approvedCount: approved.length,
    hasChanges: approved.length + pending.length + declined.length > 0,
  }
}

/** Only these ever reach a customer's eyes — a draft is the owner's unfinished
 *  ask. Mirrors get_portal_data's `status <> 'draft'` privacy predicate. */
export function isCustomerVisible(status: ChangeOrderStatus): boolean {
  return status !== 'draft'
}

// ── Doors ────────────────────────────────────────────────────────────────────
// Every one of these THROWS on failure. supabase-js resolves on a failed write,
// so a door that returns void after an unchecked call reports success it has no
// evidence for — the exact defect that once let an add-on be sold and never
// billed (see lib/jobPricing.addLineItems).

export interface CreateChangeOrderInput {
  userId: string
  jobId: string
  customerId: string
  quoteId?: string | null
  description: string
  amount: number
  /** The visit's service type — only used to derive the BI category. */
  serviceType?: string | null
  /** Send it for approval immediately, or leave it as the owner's draft. */
  send: boolean
}

export async function createChangeOrder(
  supabase: SupabaseClient, input: CreateChangeOrderInput,
): Promise<ChangeOrder> {
  const description = input.description.trim()
  const amount = Number(input.amount)
  if (!description) throw new Error('A change needs a description of the work.')
  if (!(amount > 0)) throw new Error('A change needs a price above $0.')

  // service_key / service_category are computed HERE, by the one implementation of
  // each, and copied verbatim onto the line item by the approval trigger — so BI
  // keeps grouping change orders exactly as it groups every other add-on, and no
  // second normaliser is written in SQL.
  const row: Record<string, unknown> = {
    user_id: input.userId,
    job_id: input.jobId,
    customer_id: input.customerId,
    quote_id: input.quoteId ?? null,
    description,
    amount,
    service_key: normalizeServiceKey(description),
    service_category: serviceCategory(input.serviceType ?? description),
    status: 'draft',
  }
  const { data, error } = await supabase.from('change_orders').insert(row).select('*').single()
  if (error || !data) throw new Error(error?.message || 'The change could not be saved.')
  const created = data as ChangeOrder
  return input.send ? await sendChangeOrder(supabase, created.id) : created
}

/** Draft → awaiting the customer. The DB stamps sent_at; nothing here invents one. */
export async function sendChangeOrder(supabase: SupabaseClient, id: string): Promise<ChangeOrder> {
  return await setStatus(supabase, id, 'pending', {})
}

/** Withdraw it. Legal from draft or pending only — the DB refuses the rest. */
export async function cancelChangeOrder(supabase: SupabaseClient, id: string): Promise<ChangeOrder> {
  return await setStatus(supabase, id, 'cancelled', {})
}

/**
 * The owner records a decision the customer gave them some other way — on the
 * phone, at the door, by text.
 *
 * ⭐ `decided_via: 'owner'` is written, never 'portal'. The two are not the same
 * fact and the product must never blur them: one is the customer's own tap, the
 * other is the business's word for it. Callers are expected to confirm first.
 */
export async function recordOwnerDecision(
  supabase: SupabaseClient, id: string, decision: 'approve' | 'decline', reason?: string | null,
): Promise<ChangeOrder> {
  return await setStatus(
    supabase, id, decision === 'approve' ? 'approved' : 'declined',
    { decided_via: 'owner', decline_reason: decision === 'decline' ? (reason?.trim() || null) : null },
  )
}

// The single writer. `.eq('status', from)` is a compare-and-set: two taps, or a
// tap racing the customer's own approval in the portal, and exactly one wins —
// the loser updates 0 rows and is told the truth rather than reporting a change
// it did not make.
async function setStatus(
  supabase: SupabaseClient, id: string, to: ChangeOrderStatus, extra: Record<string, unknown>,
): Promise<ChangeOrder> {
  const { data: current, error: readErr } = await supabase
    .from('change_orders').select('*').eq('id', id).maybeSingle()
  if (readErr) throw new Error(readErr.message)
  if (!current) throw new Error('That change order no longer exists.')
  const from = (current as ChangeOrder).status
  if (!canTransition(from, to)) {
    throw new Error(`A change order that is ${CHANGE_ORDER_LABELS[from].toLowerCase()} cannot become ${CHANGE_ORDER_LABELS[to].toLowerCase()}.`)
  }
  const { data, error } = await supabase
    .from('change_orders').update({ status: to, ...extra })
    .eq('id', id).eq('status', from)
    .select('*').maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('That change order was answered somewhere else — reload to see where it stands.')
  return data as ChangeOrder
}

/**
 * Every change order this business has, grouped by visit, oldest first within a
 * visit. ONE request: change orders are a small table by nature (an exceptional
 * event, not a per-visit row), so the schedule board does not chunk by job id the
 * way add-ons must. The newest 1000 are kept if a book ever exceeds PostgREST's
 * page — the recent ones being the ones anybody can still act on.
 */
export async function listChangeOrders(
  supabase: SupabaseClient, userId: string,
): Promise<Record<string, ChangeOrder[]>> {
  const { data, error } = await supabase
    .from('change_orders').select('*').eq('user_id', userId)
    .order('created_at', { ascending: false }).limit(1000)
  if (error) throw new Error(error.message)
  const out: Record<string, ChangeOrder[]> = {}
  for (const co of ((data as ChangeOrder[]) || []).slice().reverse()) (out[co.job_id] ||= []).push(co)
  return out
}

/** Every change order on these visits, oldest first within a visit. */
export async function listChangeOrdersByJob(
  supabase: SupabaseClient, userId: string, jobIds: string[],
): Promise<Record<string, ChangeOrder[]>> {
  const ids = [...new Set(jobIds.filter(Boolean))]
  const out: Record<string, ChangeOrder[]> = {}
  if (!ids.length) return out
  // Chunked for the same reason listLineItemsByJob is: a season of visits is
  // thousands of uuids, and one `in(...)` that long is an HTTP 414 whose failure
  // would silently read as "this job has no changes".
  const CHUNK = 200
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))
  const results = await Promise.all(chunks.map(chunk =>
    supabase.from('change_orders').select('*').eq('user_id', userId).in('job_id', chunk)
      .order('created_at', { ascending: true }),
  ))
  for (const r of results) {
    if (r.error) throw new Error(r.error.message)
    for (const co of (r.data as ChangeOrder[]) || []) (out[co.job_id] ||= []).push(co)
  }
  return out
}

// ── What the customer is asked ───────────────────────────────────────────────
// One sentence, built once, so the text message, the portal card and the owner's
// preview cannot describe the same change differently.
export function changeOrderAskLine(co: Pick<ChangeOrder, 'co_number' | 'description' | 'amount'>): string {
  return `${co.co_number}: ${co.description.trim()} — $${round2(co.amount).toFixed(2)}`
}

/**
 * THE request body for asking a customer to approve a change — used by the first
 * send AND by "ask again", so the two can never describe the same change
 * differently. Posted to /api/comms/send: the one pipeline that owns consent,
 * channel opt-in, delivery logging and the portal link.
 *
 * `attempt` is part of the idempotency key on purpose. A REMINDER is a new send,
 * not a retry of the old one, so it must not be deduped away — while a double-tap
 * of the same button, which reuses the same attempt, must be.
 */
export function changeOrderSendRequest(opts: {
  co: Pick<ChangeOrder, 'id' | 'co_number' | 'description' | 'amount' | 'customer_id' | 'job_id'>
  /** The visit's original approved total, for the "this does not change" line. */
  originalTotal: number | null
  /** 0 for the first ask; the count of prior asks for a reminder. */
  attempt: number
  body: (p: { number: string; description: string; amount: string; originalTotal: string | null }) => string
  money: (n: number) => string
}): Record<string, unknown> {
  const { co, originalTotal, attempt, body, money } = opts
  return {
    customerId: co.customer_id,
    jobId: co.job_id,
    template: 'change_order',
    channels: ['sms', 'email'],
    vars: { amount: money(Number(co.amount)) },
    bodyOverride: body({
      number: co.co_number,
      description: co.description.trim(),
      amount: money(Number(co.amount)),
      originalTotal: originalTotal != null && originalTotal > 0 ? money(originalTotal) : null,
    }),
    clientMessageId: `change-order:${co.id}:${attempt}`,
  }
}
