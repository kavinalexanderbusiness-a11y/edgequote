import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard, CalendarDays, Users, Home, FileText, Receipt, Wallet, MessageSquare, Wrench, Bot, Sprout, Radio,
} from 'lucide-react'

// ── Feature-module registry ───────────────────────────────────────────────────
// THE declarative catalogue of EdgeQuote's feature modules — the platform seam
// for per-business composition. Navigation renders FROM this registry; a
// business's `business_settings.enabled_modules` (jsonb string[]) decides which
// modules appear. NULL means "all modules" — every existing business keeps
// exactly what it has today, so the seam costs nothing until it's used.
//
// Why a registry instead of a hardcoded nav: a field-service platform serves
// trades with different shapes (an indoor trade may never measure a property;
// a solo operator may not need Equipment). Composition happens by CONFIG over
// one codebase — never by industry picker and never by forked builds. This is
// also the anchor for what comes later: a settings screen toggles entries, a
// future marketplace lists them, custom modules append to them. Adding a
// module = one entry here + its routes; nothing else to wire.
//
// Enforcement is at the navigation level (a disabled module is hidden, not
// 404'd) — data stays intact and deep links keep working, which is the
// backwards-compatible reading of "disabled".

export interface FeatureModule {
  /** Stable id — stored in business_settings.enabled_modules; never rename. */
  key: string
  label: string
  href: string
  icon: LucideIcon
  /** Core modules are always visible and cannot be disabled. */
  core?: boolean
  /** One-liner for the future module-management / marketplace surface. */
  description: string
}

export const FEATURE_MODULES: FeatureModule[] = [
  { key: 'dashboard',  label: 'Dashboard',  href: '/dashboard',            icon: LayoutDashboard, core: true,
    description: 'The morning command center — money, priorities, and the day ahead.' },
  { key: 'schedule',   label: 'Schedule',   href: '/dashboard/schedule',   icon: CalendarDays,
    description: 'Visits, routes, capacity and the day plan.' },
  { key: 'dispatch',   label: 'Dispatch',   href: '/dashboard/dispatch',   icon: Radio,
    description: 'Crews, technicians and the day\'s routes on one board.' },
  { key: 'customers',  label: 'Customers',  href: '/dashboard/customers',  icon: Users,
    description: 'Every customer, their history, and the conversation.' },
  { key: 'properties', label: 'Properties', href: '/dashboard/properties', icon: Home,
    description: 'Sites and service locations, with measurements and notes.' },
  { key: 'quotes',     label: 'Quotes',     href: '/dashboard/quotes',     icon: FileText,
    description: 'Quote work, send it, and track it to a decision.' },
  { key: 'invoices',   label: 'Invoices',   href: '/dashboard/invoices',   icon: Receipt,
    description: 'Invoicing, receipts and what you\'re owed.' },
  { key: 'payments',   label: 'Payments',   href: '/dashboard/payments',   icon: Wallet,
    description: 'The money ledger — every payment, refund and dispute.' },
  { key: 'messages',   label: 'Messages',   href: '/dashboard/messages',   icon: MessageSquare,
    description: 'Two-way SMS and email with every customer, in one inbox.' },
  { key: 'equipment',  label: 'Equipment',  href: '/dashboard/equipment',  icon: Wrench,
    description: 'The gear that does the work — tracking and upkeep.' },
  { key: 'automation', label: 'Automation', href: '/dashboard/automation', icon: Bot,
    description: 'Rules that watch the business and act (or ask) on your behalf.' },
  { key: 'grow',       label: 'Grow',       href: '/dashboard/grow',       icon: Sprout,
    description: 'Analytics, marketing and the tools that win more work.' },
]

// The modules a business actually sees. `enabled` comes straight from
// business_settings.enabled_modules: not-an-array (null/undefined/garbage) =
// everything, the safe default for every business that has never touched it.
export function visibleModules(enabled: unknown): FeatureModule[] {
  if (!Array.isArray(enabled)) return FEATURE_MODULES
  const keys = new Set(enabled.filter((k): k is string => typeof k === 'string'))
  return FEATURE_MODULES.filter(m => m.core || keys.has(m.key))
}
