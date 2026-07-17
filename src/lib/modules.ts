import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard, CalendarDays, Users, Home, FileText, Receipt, Wallet, MessageSquare, Wrench, Bot, Sprout, Radio, Plug,
  Calculator,
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

export type ModuleCategory = 'operations' | 'money' | 'customers' | 'growth'
export const MODULE_CATEGORIES: Record<ModuleCategory, string> = {
  operations: 'Operations',
  money: 'Money',
  customers: 'Customers',
  growth: 'Growth',
}
export const CATEGORY_ORDER: ModuleCategory[] = ['operations', 'customers', 'money', 'growth']

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
}

export const FEATURE_MODULES: FeatureModule[] = [
  { key: 'dashboard',  label: 'Dashboard',  href: '/dashboard',            icon: LayoutDashboard, core: true,
    category: 'operations', version: 1, updatedAt: '2026-07-15',
    description: 'The morning command center — money, priorities, and the day ahead.',
    permissions: ['customers:read', 'jobs:read', 'invoices:read'] },
  { key: 'schedule',   label: 'Schedule',   href: '/dashboard/schedule',   icon: CalendarDays,
    category: 'operations', version: 1, updatedAt: '2026-07-09',
    description: 'Visits, routes, capacity and the day plan.',
    permissions: ['jobs:read', 'jobs:write', 'customers:read', 'messages:send'] },
  { key: 'dispatch',   label: 'Dispatch',   href: '/dashboard/dispatch',   icon: Radio,
    category: 'operations', version: 1, updatedAt: '2026-07-15', requires: ['schedule'],
    description: 'Crews, technicians and the day\'s routes on one board.',
    permissions: ['jobs:read', 'jobs:write', 'crews:read', 'crews:write', 'equipment:read', 'equipment:write'] },
  { key: 'customers',  label: 'Customers',  href: '/dashboard/customers',  icon: Users,
    category: 'customers', version: 1, updatedAt: '2026-07-15',
    description: 'Every customer, their history, and the conversation.',
    permissions: ['customers:read', 'customers:write', 'messages:send'] },
  { key: 'properties', label: 'Properties', href: '/dashboard/properties', icon: Home,
    category: 'operations', version: 1, updatedAt: '2026-07-08', requires: ['customers'],
    description: 'Sites and service locations, with measurements and notes.',
    permissions: ['properties:read', 'properties:write', 'customers:read'] },
  { key: 'quotes',     label: 'Quotes',     href: '/dashboard/quotes',     icon: FileText,
    category: 'money', version: 1, updatedAt: '2026-07-13', requires: ['customers'],
    description: 'Quote work, send it, and track it to a decision.',
    permissions: ['quotes:read', 'quotes:write', 'customers:read', 'messages:send'] },
  { key: 'invoices',   label: 'Invoices',   href: '/dashboard/invoices',   icon: Receipt,
    category: 'money', version: 1, updatedAt: '2026-07-15', requires: ['customers'],
    description: 'Invoicing, receipts and what you\'re owed.',
    permissions: ['invoices:read', 'invoices:write', 'customers:read', 'messages:send'] },
  { key: 'payments',   label: 'Payments',   href: '/dashboard/payments',   icon: Wallet,
    category: 'money', version: 1, updatedAt: '2026-07-15', requires: ['invoices'],
    description: 'The money ledger — every payment, refund and dispute.',
    permissions: ['payments:read', 'payments:write', 'invoices:read'] },
  // The money-OUT half. `requires: payments` is a real dependency, not shelf-order:
  // the P&L reads the payments ledger for its top line, so Accounting without
  // Payments would report cost with no revenue to weigh it against.
  { key: 'accounting', label: 'Accounting', href: '/dashboard/accounting', icon: Calculator,
    category: 'money', version: 1, updatedAt: '2026-07-16', requires: ['payments'],
    description: 'Expenses, vendors and what\'s actually left after the work.',
    permissions: ['expenses:read', 'expenses:write', 'payments:read'] },
  { key: 'messages',   label: 'Messages',   href: '/dashboard/messages',   icon: MessageSquare,
    category: 'customers', version: 1, updatedAt: '2026-07-09', requires: ['customers'],
    description: 'Two-way SMS and email with every customer, in one inbox.',
    permissions: ['messages:read', 'messages:send', 'customers:read'] },
  { key: 'equipment',  label: 'Equipment',  href: '/dashboard/equipment',  icon: Wrench,
    category: 'operations', version: 1, updatedAt: '2026-07-15',
    description: 'The gear that does the work — tracking and upkeep.',
    permissions: ['equipment:read', 'equipment:write'] },
  { key: 'automation', label: 'Automation', href: '/dashboard/automation', icon: Bot,
    category: 'growth', version: 1, updatedAt: '2026-07-15', featured: true, requires: ['messages'],
    description: 'Rules that watch the business and act (or ask) on your behalf.',
    permissions: ['automations:read', 'automations:write', 'messages:send', 'customers:read'] },
  { key: 'grow',       label: 'Grow',       href: '/dashboard/grow',       icon: Sprout,
    category: 'growth', version: 1, updatedAt: '2026-07-14', featured: true,
    description: 'Analytics, marketing and the tools that win more work.',
    permissions: ['customers:read', 'jobs:read', 'quotes:read', 'marketing:write'] },
  { key: 'integrations', label: 'Integrations', href: '/dashboard/integrations', icon: Plug,
    category: 'operations', version: 1, updatedAt: '2026-07-16',
    description: 'REST API, signed webhooks, Zapier and Make — connect EdgeQuote to everything else.',
    permissions: ['customers:read', 'quotes:read', 'jobs:read', 'invoices:read', 'payments:read', 'customers:write', 'webhooks:send'] },
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
