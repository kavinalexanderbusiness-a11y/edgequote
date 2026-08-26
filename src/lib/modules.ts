import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard, CalendarDays, Users, Home, FileText, Receipt, Wallet, MessageSquare, Wrench, Bot, Sprout, Radio, Plug,
  Calculator, HardHat, Target, Inbox, History, TrendingUp, FileSignature,
} from 'lucide-react'

// ── Feature-module registry ───────────────────────────────────────────────────
// THE declarative catalogue of EdgeQuote's feature modules — the platform seam
// for per-business composition and the foundation the marketplace stands on.
// Navigation (sidebar + command palette) renders FROM this registry; a
// business's `business_settings.enabled_modules` (jsonb string[]) decides which
// modules are installed. NULL means "all modules" — every existing business
// keeps exactly what it has today, and future modules arrive auto-installed.
//
// Marketplace model (owner-approved): modules are FIRST-PARTY CODE composed by
// config — there are no runtime plugins. A marketplace listing is a registry
// entry; installing is enabling; per-module state (installed version, install
// date) lives in `business_settings.module_meta`. The `sku` field is the
// licensing hook: absent = free; when paid modules exist, `isEntitled()` is
// the ONE place entitlement gets checked.
//
// "Uninstall" is deliberately gentle: it hides the module from navigation.
// Data, pages and deep links stay intact — reversible, safe, honest.

// ── Categories ────────────────────────────────────────────────────────────────
// These drive the Marketplace, the Modules manager AND (since this change) the
// sidebar, which used to render the registry as one flat list of fifteen. A flat
// fifteen reads as a pile of features; the same fifteen under four headings
// reads as a business: run the day, look after customers, get paid, grow.
//
// `admin` exists so setup-and-plumbing stops competing with daily work for the
// same visual weight. It is LAST in the order for the same reason.
export type ModuleCategory = 'operations' | 'money' | 'customers' | 'growth' | 'admin'
export const MODULE_CATEGORIES: Record<ModuleCategory, string> = {
  operations: 'Operations',
  money: 'Money',
  customers: 'Customers',
  growth: 'Growth',
  admin: 'Setup',
}
export const CATEGORY_ORDER: ModuleCategory[] = ['operations', 'customers', 'money', 'growth', 'admin']

export interface FeatureModule {
  /** Stable id — stored in enabled_modules / module_meta; never rename. */
  key: string
  label: string
  href: string
  icon: LucideIcon
  /** Required modules: always installed, can never be removed. */
  core?: boolean
  /** One-liner for the Modules surface / marketplace listing. */
  description: string
  category: ModuleCategory
  /** Bump when the module meaningfully changes — drives the "Updated" badge. */
  version: number
  /** One line shown to businesses whose installed version is older. */
  whatsNew?: string
  /** Module keys this one needs. Install pulls them in; they can't be removed while this is installed. */
  requires?: string[]
  /** Marketplace surfacing. */
  featured?: boolean
  /** Declared data/action surface — the module's permission manifest (informational, like an app-store listing). */
  permissions: string[]
  /** Future licensing hook — entitlement key. Absent = free forever. */
  sku?: string
  /** ISO date of the module's last meaningful change — drives "Recently updated". */
  updatedAt: string
  /** Marketplace screenshots (public URLs). Empty/absent → the listing renders a styled placeholder. */
  screenshots?: string[]
  /** The words an OWNER would type that are not in the label. ⌘K and the
   *  Marketplace search both read these, so "jobs" finds Schedule and "payroll"
   *  finds Workforce. Only needed where their word differs from ours —
   *  typing "jobs" previously matched NOTHING, which is most of the reason
   *  "where do my jobs live?" had no answer. */
  keywords?: string
}

export const FEATURE_MODULES: FeatureModule[] = [
  { key: 'dashboard',  label: 'Dashboard',  href: '/dashboard',            icon: LayoutDashboard, core: true,
    category: 'operations', version: 1, updatedAt: '2026-07-15',
    description: 'The morning command center — money, priorities, and the day ahead.',
    permissions: ['customers:read', 'jobs:read', 'invoices:read'] },
  // Directly under Dashboard: the same subject at full depth. The dashboard
  // previews the top of this queue; the Inbox IS the queue — everything that
  // needs the owner, then the week's news. Core for the same reason the
  // dashboard is: a front door for attention is not an optional feature.
  { key: 'inbox',      label: 'Inbox',      href: '/dashboard/inbox',      icon: Inbox, core: true,
    category: 'operations', version: 1, updatedAt: '2026-08-15',
    description: 'What needs you, and what happened — one calm list.',
    permissions: ['customers:read', 'jobs:read', 'invoices:read', 'messages:read'],
    keywords: 'needs attention notifications updates action items todo' },
  { key: 'schedule',   label: 'Schedule',   href: '/dashboard/schedule',   icon: CalendarDays,
    category: 'operations', version: 1, updatedAt: '2026-07-09',
    description: 'Visits, routes, capacity and the day plan.',
    permissions: ['jobs:read', 'jobs:write', 'customers:read', 'messages:send'],
    keywords: 'jobs visits calendar day plan route booked work' },
  { key: 'dispatch',   label: 'Dispatch',   href: '/dashboard/dispatch',   icon: Radio,
    category: 'operations', version: 1, updatedAt: '2026-07-15', requires: ['schedule'],
    description: 'Crews, technicians and the day\'s routes on one board.',
    permissions: ['jobs:read', 'jobs:write', 'crews:read', 'crews:write', 'equipment:read', 'equipment:write'],
    keywords: 'crews stops route board today' },
  // Payroll lived three-to-five clicks deep inside Dispatch and appeared in NO
  // navigation and NO command palette — typing "payroll" into ⌘K returned nothing.
  // The thing that pays people has to be findable on payday. Registering it here
  // (rather than special-casing the sidebar) is what makes the sidebar, ⌘K and the
  // Modules manager all agree — they every one read this registry.
  { key: 'workforce',  label: 'Workforce',  href: '/dashboard/workforce',  icon: HardHat,
    category: 'operations', version: 1, updatedAt: '2026-07-16', requires: ['dispatch'],
    description: 'Your people: hours, pay, time off and what the crew costs.',
    whatsNew: 'Payroll, timesheets and time off now have a home of their own.',
    permissions: ['crews:read', 'crews:write', 'payroll:read', 'payroll:write'],
    keywords: 'payroll employees staff team timesheet hours wages time off' },
  // Registered here rather than special-cased into the sidebar, for the same
  // reason payroll was: the registry is what makes the sidebar, ⌘K and the Modules
  // manager agree. An owner looking for "who changed this" types "audit" or "who
  // changed" — both are keywords, because neither is in the label.
  { key: 'activity',   label: 'Activity',   href: '/dashboard/activity',   icon: History,
    category: 'admin', version: 1, updatedAt: '2026-08-15',
    description: 'Who changed what, when — and what it was before.',
    whatsNew: 'Every meaningful change is now recorded, with the person who made it.',
    permissions: ['activity:read'],
    keywords: 'audit trail history who changed log accountability record' },
  { key: 'customers',  label: 'Customers',  href: '/dashboard/customers',  icon: Users,
    category: 'customers', version: 1, updatedAt: '2026-07-15',
    description: 'Every customer, their history, and the conversation.',
    permissions: ['customers:read', 'customers:write', 'messages:send'],
    keywords: 'clients people contacts' },
  // Sits directly under Customers because it is the same subject seen from the
  // other end: not "who do I serve" but "who is mid-decision, and what do I owe
  // them next". It requires `quotes` for a real reason rather than shelf-order —
  // four of the six rungs are derived from a quote's status, so without that
  // module the board could only ever show leads.
  { key: 'pipeline',   label: 'Pipeline',   href: '/dashboard/pipeline',   icon: Target,
    category: 'customers', version: 1, updatedAt: '2026-08-13', featured: true, requires: ['customers', 'quotes'],
    description: 'Every lead and quote in flight, each with the one thing to do next.',
    permissions: ['customers:read', 'quotes:read', 'invoices:read', 'jobs:read', 'messages:read'],
    keywords: 'sales deals leads opportunities funnel stages next action follow up won lost' },
  { key: 'properties', label: 'Properties', href: '/dashboard/properties', icon: Home,
    category: 'customers', version: 1, updatedAt: '2026-07-08', requires: ['customers'],
    description: 'Sites and service locations, with measurements and notes.',
    permissions: ['properties:read', 'properties:write', 'customers:read'],
    keywords: 'sites addresses locations measurements' },
  { key: 'quotes',     label: 'Quotes',     href: '/dashboard/quotes',     icon: FileText,
    category: 'money', version: 1, updatedAt: '2026-07-13', requires: ['customers'],
    description: 'Quote work, send it, and track it to a decision.',
    permissions: ['quotes:read', 'quotes:write', 'customers:read', 'messages:send'],
    keywords: 'estimates proposals pricing' },
  { key: 'contracts',  label: 'Contracts',  href: '/dashboard/contracts',  icon: FileSignature,
    category: 'customers', version: 1, updatedAt: '2026-08-26', requires: ['customers'],
    description: 'Service agreements and contracts, signed and tracked to their term.',
    permissions: ['contracts:read', 'contracts:write', 'customers:read', 'documents:read', 'documents:write'],
    keywords: 'agreements service agreement maintenance terms signature sign renewal' },
  { key: 'invoices',   label: 'Invoices',   href: '/dashboard/invoices',   icon: Receipt,
    category: 'money', version: 1, updatedAt: '2026-07-15', requires: ['customers'],
    description: 'Invoicing, receipts and what you\'re owed.',
    permissions: ['invoices:read', 'invoices:write', 'customers:read', 'messages:send'],
    keywords: 'billing bills receivables owed' },
  { key: 'payments',   label: 'Payments',   href: '/dashboard/payments',   icon: Wallet,
    category: 'money', version: 1, updatedAt: '2026-07-15', requires: ['invoices'],
    description: 'The money ledger — every payment, refund and dispute.',
    permissions: ['payments:read', 'payments:write', 'invoices:read'],
    keywords: 'money received refunds deposits' },
  // The money-OUT half. `requires: payments` is a real dependency, not shelf-order:
  // the P&L reads the payments ledger for its top line, so Accounting without
  // Payments would report cost with no revenue to weigh it against.
  { key: 'accounting', label: 'Accounting', href: '/dashboard/accounting', icon: Calculator,
    category: 'money', version: 1, updatedAt: '2026-07-16', requires: ['payments'],
    description: 'Expenses, vendors and what\'s actually left after the work.',
    permissions: ['expenses:read', 'expenses:write', 'payments:read'],
    keywords: 'expenses vendors profit p&l' },
  { key: 'messages',   label: 'Messages',   href: '/dashboard/messages',   icon: MessageSquare,
    category: 'customers', version: 1, updatedAt: '2026-07-09', requires: ['customers'],
    description: 'Two-way SMS and email with every customer, in one inbox.',
    permissions: ['messages:read', 'messages:send', 'customers:read'],
    keywords: 'inbox sms email texts leads conversations' },
  { key: 'equipment',  label: 'Equipment',  href: '/dashboard/equipment',  icon: Wrench,
    category: 'operations', version: 1, updatedAt: '2026-07-15',
    description: 'The gear that does the work — tracking and upkeep.',
    permissions: ['equipment:read', 'equipment:write'],
    // ⌘K searched label + keywords, and this entry had none — so "mower",
    // "maintenance", "service" and "parts" all found nothing, and only the
    // literal word "equipment" reached it. The owner's words, not ours.
    keywords: 'mower trailer truck fleet maintenance service hours parts vehicle' },
  // Sits beside Grow because it answers the same question at a different
  // altitude: not "what should I try next" but "what did selling actually
  // produce". `requires: quotes` is a real dependency — every figure on the page
  // is anchored to a quote, so without that module the report has no cohort to
  // describe. It reads invoices and payments too, but degrades honestly without
  // them (invoiced and collected simply stay at zero, which is the truth).
  { key: 'sales',      label: 'Sales',      href: '/dashboard/sales',      icon: TrendingUp,
    category: 'growth', version: 1, updatedAt: '2026-08-16', requires: ['quotes'],
    description: 'What you quoted, won, invoiced and actually collected — and which sources produced it.',
    whatsNew: 'Quoted, won, authorized, invoiced and collected are now five separate figures you can trace back to the quotes behind them.',
    permissions: ['quotes:read', 'invoices:read', 'payments:read', 'customers:read'],
    keywords: 'sales analytics revenue quoted won lost collected conversion win rate lead source attribution funnel forecast reporting' },
  { key: 'grow',       label: 'Grow',       href: '/dashboard/grow',       icon: Sprout,
    category: 'growth', version: 1, updatedAt: '2026-07-14', featured: true,
    description: 'Analytics, marketing and the tools that win more work.',
    permissions: ['customers:read', 'jobs:read', 'quotes:read', 'marketing:write'],
    keywords: 'marketing analytics reports intelligence reviews referrals' },
  // ⚠️ Category and copy both corrected 2026-08-09, and for the same reason.
  //
  // This sat in `growth`, beside Grow — top-level billing, level with the things
  // an owner opens every morning — and its pitch said the rules "act (or ask) on
  // your behalf". Neither half was true. The engine has never written a row in
  // production (automation_signals / automation_runs / automation_sweeps were all
  // empty when this was checked), and it CANNOT act: every registered rule is
  // `mode: 'suggest'` and the dispatcher map is deliberately empty, which is the
  // engine's whole safety design. A card promising action the code refuses to
  // take is the plainest kind of overclaim.
  //
  // So it belongs in Setup — something you look in on, not something you run the
  // day from — and it now describes what it actually does: watch, and flag.
  { key: 'automation', label: 'Automation', href: '/dashboard/automation', icon: Bot,
    category: 'admin', version: 1, updatedAt: '2026-08-09', requires: ['messages'],
    description: 'Watches for customers due to re-book and flags them for you. It never messages anyone on its own.',
    permissions: ['automations:read', 'automations:write', 'messages:send', 'customers:read'],
    keywords: 'rules reminders follow up watch churn re-book suggestions' },
  // Same overclaim, milder: this led with "REST API, signed webhooks, Zapier and
  // Make", which is the answer to a question almost no owner is asking. The page
  // still holds all of it — the pitch just stops opening with it.
  { key: 'integrations', label: 'Integrations', href: '/dashboard/integrations', icon: Plug,
    category: 'admin', version: 1, updatedAt: '2026-08-09',
    description: 'Connect other apps to EdgeQuote — plus a developer API, if yours needs one.',
    permissions: ['customers:read', 'quotes:read', 'jobs:read', 'invoices:read', 'payments:read', 'customers:write', 'webhooks:send'],
    keywords: 'api webhooks zapier make connect apps developer accounts' },
]

const byKey = new Map(FEATURE_MODULES.map(m => [m.key, m]))
export const moduleByKey = (key: string): FeatureModule | undefined => byKey.get(key)

// Marketplace "Recently updated" rail — newest change first, stable on ties.
export function recentlyUpdated(limit = 4): FeatureModule[] {
  return [...FEATURE_MODULES].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)
}

// Marketplace search — matches name, pitch, category label and declared data
// surface, so "invoice" finds Payments and "sms" finds Messages.
export function searchModules(query: string): FeatureModule[] {
  const q = query.trim().toLowerCase()
  if (!q) return FEATURE_MODULES
  return FEATURE_MODULES.filter(m =>
    m.label.toLowerCase().includes(q) ||
    m.description.toLowerCase().includes(q) ||
    MODULE_CATEGORIES[m.category].toLowerCase().includes(q) ||
    (m.keywords ?? '').toLowerCase().includes(q) ||
    m.permissions.some(p => p.includes(q)))
}
const NON_CORE_KEYS = FEATURE_MODULES.filter(m => !m.core).map(m => m.key)

// ── Composition (what a business sees) ────────────────────────────────────────

// The modules a business actually sees. `enabled` comes straight from
// business_settings.enabled_modules: not-an-array (null/undefined/garbage) =
// everything, the safe default for every business that has never touched it.
export function visibleModules(enabled: unknown): FeatureModule[] {
  if (!Array.isArray(enabled)) return FEATURE_MODULES
  const keys = new Set(enabled.filter((k): k is string => typeof k === 'string'))
  return FEATURE_MODULES.filter(m => m.core || keys.has(m.key))
}

// The installed NON-CORE keys implied by a stored value (core is always in).
export function installedKeys(enabled: unknown): string[] {
  if (!Array.isArray(enabled)) return [...NON_CORE_KEYS]
  const valid = new Set(NON_CORE_KEYS)
  return enabled.filter((k): k is string => typeof k === 'string' && valid.has(k))
}

// What to STORE for a given set of installed non-core keys. The full set
// normalizes to NULL — "all modules, including future ones" — so a business
// that reinstalls everything is never frozen out of next release's module.
export function normalizeEnabled(keys: string[]): string[] | null {
  const set = new Set(keys)
  return NON_CORE_KEYS.every(k => set.has(k)) ? null : NON_CORE_KEYS.filter(k => set.has(k))
}

// ── Dependencies ──────────────────────────────────────────────────────────────

// Transitive dependency closure of a module (excluding itself, excluding core —
// core is always installed so it's never actionable as a dependency).
export function dependencyClosure(key: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([key])
  const walk = (k: string) => {
    for (const dep of byKey.get(k)?.requires ?? []) {
      if (seen.has(dep)) continue
      seen.add(dep)
      if (!byKey.get(dep)?.core) out.push(dep)
      walk(dep)
    }
  }
  walk(key)
  return out
}

// Installing a module installs its dependencies too — one atomic set.
export function installSet(installed: string[], key: string): string[] {
  const next = new Set(installed)
  next.add(key)
  for (const dep of dependencyClosure(key)) next.add(dep)
  return NON_CORE_KEYS.filter(k => next.has(k))
}

// The INSTALLED modules that (transitively) require `key` — the reason an
// uninstall gets blocked. Empty array = safe to remove.
export function uninstallBlockers(installed: string[], key: string): FeatureModule[] {
  const set = new Set(installed)
  return FEATURE_MODULES.filter(m =>
    m.key !== key && (m.core || set.has(m.key)) && dependencyClosure(m.key).includes(key))
}

export function uninstallSet(installed: string[], key: string): string[] {
  return installed.filter(k => k !== key)
}

// ── Update system ─────────────────────────────────────────────────────────────

// Per-module install state, stored in business_settings.module_meta:
//   { [key]: { v: installedVersion, at: ISO installed/acknowledged } }
export interface ModuleMeta { v?: number; at?: string }
export type ModuleMetaMap = Record<string, ModuleMeta>

export function readMeta(raw: unknown): ModuleMetaMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as ModuleMetaMap
}

// A module has a pending update when the business installed an older version
// and the registry has since moved on. No meta = adopted before the update
// system existed = treat as current (never nag existing businesses).
export function pendingUpdate(m: FeatureModule, meta: ModuleMetaMap): boolean {
  const v = meta[m.key]?.v
  return typeof v === 'number' && v < m.version
}

export function stampMeta(meta: ModuleMetaMap, keys: string[], now = new Date().toISOString()): ModuleMetaMap {
  const next: ModuleMetaMap = { ...meta }
  for (const k of keys) {
    const m = byKey.get(k)
    if (m) next[k] = { v: m.version, at: now }
  }
  return next
}

// ── Licensing hook (future) ───────────────────────────────────────────────────

// THE entitlement check. Every current module is free (no sku), so this is
// always true today — but every consumer already routes through it, which is
// the whole point: when paid modules exist, entitlements plug in HERE and only
// here. `entitlements` will be the business's license record (shape TBD).
export function isEntitled(m: FeatureModule, entitlements?: unknown): boolean {
  if (!m.sku) return true
  void entitlements // TODO(licensing): consult the business's entitlements for m.sku
  return true
}
