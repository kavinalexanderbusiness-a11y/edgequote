// ── THE Quick Add: one + button, and it knows where you are ──────────────────
//
// There was already a "+" in the mobile bottom bar. It opened four LINKS —
// New quote · Invoice · Collect payment · Customers — of which two were not
// creations at all but navigation wearing a create icon, and none of the four
// carried a shred of context. Standing on a customer's profile and tapping +
// → New quote landed on a blank builder that asked who the customer was.
//
// This module is the whole decision, as data. Rules it keeps:
//
//  ⭐ EVERY ACTION CREATES SOMETHING. "Go to the invoice list" is navigation and
//    belongs in the nav; a create sheet that also navigates teaches nobody what
//    the button means.
//
//  ⭐ ONE DOOR PER THING, PREFILLED — never a second door for the same thing.
//    "Quote" is one action whose href gains ?customer=/?property= when the
//    surface knows them. That is the prefill contract verify:create-doors
//    already pins for every other quote door (BARE_QUOTE_DOORS); this file is
//    how the mobile + finally joins it instead of being excused from it.
//
//  ⭐ AN ACTION THAT CANNOT WORK IS NOT OFFERED. Recording a cost needs a saved,
//    completed visit; logging work time needs one that has been started. On a
//    scheduled visit neither door exists yet, so neither is listed — a disabled
//    row that explains itself in a toast is a worse answer than an honest list.
//
//  ⛔ NO INVENTED ROUTES. Every href here is a door that already exists and
//    already reads that param: /dashboard/quotes/new?customer=&property=,
//    /dashboard/schedule?customer=&property=, /dashboard/customers?new=1,
//    /dashboard/schedule?job=<id> (+ ?panel=, added with this module).
//
// Pure — no React, no Supabase, no lucide — so scripts/verify-field-mode.ts can
// pin the context rules directly rather than scraping a component.

import type { JobStatus } from '@/types'

/** What the surface underneath the + knows about. */
export type QuickAddContext =
  | { kind: 'none' }
  | { kind: 'customer'; customerId: string; customerName: string; propertyId?: string | null }
  | {
      kind: 'job'
      jobId: string
      status: JobStatus
      /** Whether the clock is running — a job can be in_progress and stopped. */
      customerId?: string | null
      customerName?: string | null
      propertyId?: string | null
    }
  | { kind: 'quote'; quoteId: string; customerId?: string | null; customerName?: string | null; propertyId?: string | null }

/** Icon names, resolved to components by the sheet. Keeps this file React-free. */
export type QuickAddIcon = 'quote' | 'visit' | 'customer' | 'time' | 'cost'

export interface QuickAddAction {
  key: string
  label: string
  /** The second line. Names the CONTEXT when there is one — that is the whole point. */
  sub: string
  href: string
  icon: QuickAddIcon
  /** Registry key that must be visible for this action to be offered. */
  moduleKey: string
  /** True when this action was prefilled from the surface underneath. */
  contextual: boolean
}

/** `?a=1&b=2` from defined, non-empty values only — an empty param is a lie. */
function qs(params: Record<string, string | null | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

/** The customer a context implies, if any. A job and a quote both have one. */
function contextCustomer(ctx: QuickAddContext): { id: string | null; name: string | null; propertyId: string | null } {
  switch (ctx.kind) {
    case 'customer': return { id: ctx.customerId, name: ctx.customerName, propertyId: ctx.propertyId ?? null }
    case 'job':      return { id: ctx.customerId ?? null, name: ctx.customerName ?? null, propertyId: ctx.propertyId ?? null }
    case 'quote':    return { id: ctx.customerId ?? null, name: ctx.customerName ?? null, propertyId: ctx.propertyId ?? null }
    default:         return { id: null, name: null, propertyId: null }
  }
}

/**
 * The ordered create actions for a surface.
 *
 * `enabled` is the set of visible module keys (hooks/useModules) — the same
 * gate the sidebar and the bottom-nav tabs ride, so turning a module off
 * removes its create door too and the surfaces cannot disagree.
 *
 * Order is deliberate: anything the current record makes possible comes first
 * (that is why the sheet was opened here rather than anywhere else), then the
 * three doors that are always true.
 */
export function quickAddActions(ctx: QuickAddContext, enabled: ReadonlySet<string>): QuickAddAction[] {
  const cust = contextCustomer(ctx)
  const forWho = cust.name ? `for ${cust.name}` : null
  const out: QuickAddAction[] = []

  // ── Visit-scoped doors — only what this visit can actually accept ──────────
  if (ctx.kind === 'job') {
    // Time is bankable from the moment the visit is underway; the panel that
    // records it (WorkSessionsPanel) mounts on in_progress and completed only.
    if (ctx.status === 'in_progress' || ctx.status === 'completed') {
      out.push({
        key: 'work-time', label: 'Work time', sub: 'Log hours on this visit',
        href: `/dashboard/schedule${qs({ job: ctx.jobId, panel: 'time' })}`,
        icon: 'time', moduleKey: 'schedule', contextual: true,
      })
    }
    // ⛔ Cost is a FINISHED-visit door. JobCostPanel mounts on completed only —
    // Session 31 put it there on purpose, and offering it earlier would open a
    // form that isn't on the screen it lands on.
    if (ctx.status === 'completed' && enabled.has('accounting')) {
      out.push({
        key: 'job-cost', label: 'Cost', sub: 'Materials, fuel or a subcontractor',
        href: `/dashboard/schedule${qs({ job: ctx.jobId, panel: 'cost' })}`,
        icon: 'cost', moduleKey: 'accounting', contextual: true,
      })
    }
  }

  // ── The three doors that are always true, prefilled when we know who ───────
  if (enabled.has('quotes')) {
    out.push({
      key: 'quote', label: 'Quote', sub: forWho ?? 'Price a job',
      href: `/dashboard/quotes/new${qs({ customer: cust.id, property: cust.propertyId })}`,
      icon: 'quote', moduleKey: 'quotes', contextual: !!cust.id,
    })
  }
  if (enabled.has('schedule')) {
    out.push({
      key: 'visit', label: 'Visit', sub: forWho ? `Book work ${forWho}` : 'Book work in',
      href: `/dashboard/schedule${qs({ customer: cust.id, property: cust.propertyId })}`,
      icon: 'visit', moduleKey: 'schedule', contextual: !!cust.id,
    })
  }
  if (enabled.has('customers')) {
    out.push({
      key: 'customer', label: 'Customer', sub: 'Add someone new',
      href: '/dashboard/customers?new=1',
      icon: 'customer', moduleKey: 'customers', contextual: false,
    })
  }

  return out
}

/**
 * Which panel a job door should land on. Returned as a plain string so the
 * schedule page and the guard agree on the vocabulary without importing React.
 * Anything else is ignored — an unknown panel must open the form normally
 * rather than fail.
 */
export type JobPanel = 'time' | 'cost'
export function readJobPanel(param: string | null | undefined): JobPanel | null {
  return param === 'time' || param === 'cost' ? param : null
}

/** The DOM id a job panel anchors on, shared by the panel and the scroller. */
export function jobPanelAnchorId(panel: JobPanel): string {
  return panel === 'time' ? 'job-work-sessions' : 'job-cost'
}
