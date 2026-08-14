import type { SupabaseClient } from '@supabase/supabase-js'
import type { createClient } from '@/lib/supabase/client'
import { depositFromPercent, depositPercentOf } from '@/lib/payments/deposit'
import { isCashRow } from '@/lib/payments/ledger'

// ── THE scheduling-deposit gate ──────────────────────────────────────────────
//
// "Approved" and "secured" are different facts. A quote can require a deposit
// before its booking is confirmed on the schedule; this module is the ONE place
// that says whether that requirement is satisfied. Every surface — the portal's
// pay step, the owner's quote panel, the schedule door's guard, the dashboard's
// ready-to-schedule queue — asks here, so they can never disagree about whether
// the money has arrived.
//
// The five states this feature exists to keep apart, and where each lives:
//   APPROVED          quotes.status = 'accepted' (the existing lifecycle)
//   DEPOSIT REQUIRED  requiredDeposit() > 0 and the gate is not satisfied
//   DEPOSIT RECEIVED  the gate IS satisfied — by the LEDGER, nothing else
//   PREFERRED DATE    quotes.preferred_* — a REQUEST, never an appointment
//   SCHEDULED         a real jobs row exists (the existing scheduling flow)
//
// Everything here is DERIVED. There is deliberately no quotes.deposit_paid
// column: a stored boolean goes stale the moment a refund lands, and a gate that
// trusts it would keep a cancelled booking "secured". Readiness is recomputed
// from canonical rows on every read:
//
//   required  = the quote's rule × what the customer CONSENTED to
//               (accepted_price — for an options quote that is the SELECTED
//               option + travel, snapshotted by quote_apply_option_choice; the
//               Budget/Premium alternatives can never reach this figure)
//   collected = Σ signed CASH rows (ledger isCashRow) carrying this quote_id —
//               a card payment, an e-transfer the owner recorded, and a Stripe
//               refund (negative row) all land in one sum, so "deposit received"
//               means the same thing whatever the method, and un-means itself
//               when the money goes back.
//
// ⛔ No second deposit-calculation engine: the percent maths is
// lib/payments/deposit.ts's depositFromPercent, rounded to cents exactly once.
// ⛔ Nothing here writes money. Collection goes through the existing doors
// (ledger.recordDeposit for manual, the Stripe webhook for card).

const round2 = (n: number) => Math.round(n * 100) / 100

/** The quote fields the gate reads. Structural, so a `Quote` satisfies it. */
export interface GateQuote {
  status: string
  total?: number | string | null
  accepted_price?: number | string | null
  deposit_type?: string | null
  deposit_value?: number | string | null
  deposit_override_at?: string | null
}

/** The ledger fields the gate reads — a `Payment` or a portal payment row. */
export interface GateLedgerRow {
  amount: number | string
  kind?: string | null
  provider?: string | null
  status?: string | null
}

export type SchedulingGateStatus =
  | 'none'       // no deposit required — the quote behaves exactly as before
  | 'awaiting'   // required, nothing received yet
  | 'partial'    // some received, not enough — still NOT satisfied
  | 'satisfied'  // the ledger holds the full ask (or more)

export interface SchedulingGate {
  /** The figure the rule is taken OF — accepted_price once consented, else total. */
  basis: number
  /** Dollars required up front. 0 when no rule. */
  required: number
  /** Signed cash received toward this booking (refunds net out). */
  collected: number
  /** Still needed. 0 once satisfied — never negative on overpayment. */
  outstanding: number
  /** required as a % of basis, for display — null when no rule or no basis. */
  percent: number | null
  status: SchedulingGateStatus
  /** Owner explicitly scheduled without the deposit (the audit stamp). */
  overridden: boolean
}

/**
 * What the deposit is calculated FROM: the price the customer agreed to.
 * `accepted_price` is the consent snapshot (selected option + travel for an
 * options quote; total-at-approval for a plain one) and never moves when the
 * quote is later edited. Before acceptance it falls back to the live total so
 * the owner's builder can PREVIEW the ask — the portal never charges off a
 * preview, because the pay door requires an accepted quote.
 */
export function depositBasis(q: GateQuote): number {
  const accepted = round2(Number(q.accepted_price) || 0)
  if (accepted > 0) return accepted
  const total = round2(Number(q.total) || 0)
  return total > 0 ? total : 0
}

/**
 * The required deposit in dollars — THE one figure, derived on every read.
 *
 * percent → depositFromPercent (the invoice engine's cents-once rounding).
 * fixed   → the stated dollars, clamped to the basis when one exists: an owner
 *           who typed $500 against a job that priced at $300 is asking for the
 *           whole job up front, not for money the quote never contained.
 */
export function requiredDeposit(q: GateQuote): number {
  const v = Number(q.deposit_value)
  if (!q.deposit_type || !Number.isFinite(v) || v <= 0) return 0
  const basis = depositBasis(q)
  if (q.deposit_type === 'percent') {
    if (v > 100) return 0 // the DB refuses this; a forged object gets no ask
    return depositFromPercent(basis, v)
  }
  if (q.deposit_type === 'fixed') {
    const fixed = round2(v)
    return basis > 0 ? Math.min(fixed, basis) : fixed
  }
  return 0
}

/**
 * Signed cash received toward this booking. The caller passes rows already
 * scoped to the quote (payments.quote_id = quote — the owner loads them with
 * loadQuoteDepositRows; the portal filters its own payload). isCashRow is the
 * ledger's ONE definition of "cash arrived": the held-as-credit leg and any
 * credit-application rows are excluded, refunds subtract themselves.
 */
export function collectedTowardQuote(rows: GateLedgerRow[] | null | undefined): number {
  if (!rows?.length) return 0
  return round2(rows.filter(isCashRow).reduce((s, r) => s + (Number(r.amount) || 0), 0))
}

/** The whole gate picture — the ONE reader every surface uses. */
export function schedulingGate(q: GateQuote, rows: GateLedgerRow[] | null | undefined): SchedulingGate {
  const basis = depositBasis(q)
  const required = requiredDeposit(q)
  const collected = collectedTowardQuote(rows)
  const overridden = !!q.deposit_override_at
  if (required <= 0) {
    return { basis, required: 0, collected, outstanding: 0, percent: null, status: 'none', overridden }
  }
  const outstanding = Math.max(0, round2(required - collected))
  // A cent of tolerance, same as the invoice deposit engine: float noise must
  // never leave a customer 99.99% paid. Overpayment satisfies — the extra is the
  // credit ledger's story, not a reason to keep the booking insecure.
  const satisfied = outstanding <= 0.005
  return {
    basis,
    required,
    collected,
    outstanding: satisfied ? 0 : outstanding,
    percent: q.deposit_type === 'percent' ? Number(q.deposit_value) : depositPercentOf(basis, required),
    status: satisfied ? 'satisfied' : collected > 0.005 ? 'partial' : 'awaiting',
    overridden,
  }
}

/**
 * Does this gate stand between an accepted quote and the schedule? True only
 * while the quote is at 'accepted' with money still owed — a draft/sent quote
 * hasn't been consented to, and once scheduled the decision (paid or overridden)
 * has been made. The schedule doors ask THIS, so none of them re-derive it.
 */
export function gateBlocksScheduling(q: GateQuote, gate: SchedulingGate): boolean {
  return q.status === 'accepted' && gate.required > 0 && gate.status !== 'satisfied'
}

/**
 * Validate the owner's rule input (builder UI). Mirrors validateDeposit's voice;
 * no invoice exists yet, so the only caps are the rule's own.
 */
export function validateDepositRule(
  kind: 'percent' | 'fixed', value: number,
): { ok: true } | { ok: false; error: string } {
  const no = (error: string) => ({ ok: false as const, error })
  if (!Number.isFinite(value)) return no('Enter a deposit amount.')
  if (kind === 'percent') {
    if (value <= 0) return no('Enter a percentage above 0.')
    if (value > 100) return no('A deposit can’t be more than 100% of the job.')
  } else if (value <= 0) {
    return no('Enter a deposit amount above $0.')
  }
  return { ok: true }
}

/**
 * The ONE form→columns mapping for the rule, shared by the create and edit
 * pages so their writes can't drift. '' (the toggle off) → both columns null —
 * the database's own "no deposit required" shape (the CHECK constraint refuses
 * a half-set pair). Invalid input is an error, never silently dropped: an
 * owner's rule that quietly failed to save is a booking they believed gated.
 */
export function depositRuleFromForm(
  type: string | null | undefined, value: number | string | null | undefined,
): { ok: true; patch: { deposit_type: 'percent' | 'fixed' | null; deposit_value: number | null } }
  | { ok: false; error: string } {
  if (!type) return { ok: true, patch: { deposit_type: null, deposit_value: null } }
  if (type !== 'percent' && type !== 'fixed') return { ok: false, error: 'Choose a deposit type.' }
  const v = Number(value)
  const check = validateDepositRule(type, v)
  if (!check.ok) return check
  return { ok: true, patch: { deposit_type: type, deposit_value: round2(v) } }
}

// ── Reads / writes (thin, beside the rules so they can't drift) ──────────────

type Supa = ReturnType<typeof createClient>

/** The quote's deposit ledger rows — owner-side (RLS scopes to the owner). */
export async function loadQuoteDepositRows(
  sb: SupabaseClient, quoteId: string,
): Promise<{ rows: GateLedgerRow[]; error: string | null }> {
  const { data, error } = await sb.from('payments')
    .select('amount, kind, provider, status')
    .eq('quote_id', quoteId)
  // A failed read must NOT report "no deposit" — that answer un-secures a booking
  // the customer may have paid for. Surface it and let the caller refuse to guess.
  if (error) return { rows: [], error: error.message }
  return { rows: (data as GateLedgerRow[]) || [], error: null }
}

/**
 * Stamp the owner's explicit "schedule without the required deposit" decision.
 * First stamp wins (the record of when the call was made); the deposit stays
 * owed — this changes nothing about the money.
 */
export async function stampDepositOverride(sb: Supa, quoteId: string): Promise<{ error?: string }> {
  const { error } = await sb.from('quotes')
    .update({ deposit_override_at: new Date().toISOString() })
    .eq('id', quoteId)
    .is('deposit_override_at', null)
  return error ? { error: error.message } : {}
}

// ── Preference display (the customer's request, in the owner's surfaces) ─────

export interface SchedulingPreference {
  preferred_date?: string | null
  preferred_date_2?: string | null
  preferred_timing?: string | null
  preferred_note?: string | null
}

export function hasSchedulingPreference(q: SchedulingPreference): boolean {
  return !!(q.preferred_date || q.preferred_timing || q.preferred_note)
}

/** "1st: Aug 18 · 2nd: Aug 20 · afternoon preferred" — one line for queues. */
export function schedulingPreferenceLine(
  q: SchedulingPreference,
  fmtDate: (iso: string) => string,
): string | null {
  const bits = [
    q.preferred_date ? `1st: ${fmtDate(q.preferred_date)}` : null,
    q.preferred_date_2 ? `2nd: ${fmtDate(q.preferred_date_2)}` : null,
    q.preferred_timing === 'morning' ? 'morning preferred'
      : q.preferred_timing === 'afternoon' ? 'afternoon preferred' : null,
  ].filter(Boolean)
  return bits.length ? bits.join(' · ') : null
}
