import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard, CalendarDays, Users, Home, FileText, Receipt, Wallet, MessageSquare,
  Wrench, Bot, Sprout, Radio, Plug, Calculator, HardHat, Target, Inbox, History,
  TrendingUp, BrainCircuit,
} from 'lucide-react'

export type ModuleCategory = 'operations' | 'money' | 'customers' | 'growth' | 'admin'
export const MODULE_CATEGORIES: Record<ModuleCategory, string> = {
  operations: 'Operations', money: 'Money', customers: 'Customers', growth: 'Growth', admin: 'Setup',
}
export const CATEGORY_ORDER: ModuleCategory[] = ['operations', 'customers', 'money', 'growth', 'admin']

export interface FeatureModule {
  key: string
  label: string
  href: string
  icon: LucideIcon
  core?: boolean
  description: string
  category: ModuleCategory
  version: number
  whatsNew?: string
  requires?: string[]
  featured?: boolean
  permissions: string[]
  sku?: string
  updatedAt: string
  screenshots?: string[]
  keywords?: string
}

// THE feature catalogue. Navigation, command search and Settings → Features all
// render from this one registry. Operator is core because it is the read-only
// attention surface for the whole business; its declared permissions contain no
// write/send capability in Phase 1.
export const FEATURE_MODULES: FeatureModule[] = [
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, core: true, category: 'operations', version: 1, updatedAt: '2026-07-15', description: 'The morning command center — money, priorities, and the day ahead.', permissions: ['customers:read','jobs:read','invoices:read'] },
  { key: 'inbox', label: 'Inbox', href: '/dashboard/inbox', icon: Inbox, core: true, category: 'operations', version: 1, updatedAt: '2026-08-15', description: 'What needs you, and what happened — one calm list.', permissions: ['customers:read','jobs:read','invoices:read','messages:read'], keywords: 'needs attention notifications updates action items todo' },
  { key: 'operator', label: 'Operator', href: '/dashboard/operator', icon: BrainCircuit, core: true, category: 'operations', version: 1, updatedAt: '2026-08-31', featured: true, description: 'Ask what needs attention and get evidence-backed, read-only recommendations.', permissions: ['customers:read','messages:read','quotes:read','jobs:read','invoices:read','payments:read','expenses:read','crews:read','automations:read'], keywords: 'assistant ai operator brief priorities attention ask edgequote recommendations read only' },
  { key: 'schedule', label: 'Schedule', href: '/dashboard/schedule', icon: CalendarDays, category: 'operations', version: 1, updatedAt: '2026-07-09', description: 'Visits, routes, capacity and the day plan.', permissions: ['jobs:read','jobs:write','customers:read','messages:send'], keywords: 'jobs visits calendar day plan route booked work' },
  { key: 'dispatch', label: 'Dispatch', href: '/dashboard/dispatch', icon: Radio, category: 'operations', version: 1, updatedAt: '2026-07-15', requires: ['schedule'], description: "Crews, technicians and the day's routes on one board.", permissions: ['jobs:read','jobs:write','crews:read','crews:write','equipment:read','equipment:write'], keywords: 'crews stops route board today' },
  { key: 'workforce', label: 'Workforce', href: '/dashboard/workforce', icon: HardHat, category: 'operations', version: 1, updatedAt: '2026-07-16', requires: ['dispatch'], description: 'Your people: hours, pay, time off and what the crew costs.', whatsNew: 'Payroll, timesheets and time off now have a home of their own.', permissions: ['crews:read','crews:write','payroll:read','payroll:write'], keywords: 'payroll employees staff team timesheet hours wages time off' },
  { key: 'activity', label: 'Activity', href: '/dashboard/activity', icon: History, category: 'admin', version: 1, updatedAt: '2026-08-15', description: 'Who changed what, when — and what it was before.', whatsNew: 'Every meaningful change is now recorded, with the person who made it.', permissions: ['activity:read'], keywords: 'audit trail history who changed log accountability record' },
  { key: 'customers', label: 'Customers', href: '/dashboard/customers', icon: Users, category: 'customers', version: 1, updatedAt: '2026-07-15', description: 'Every customer, their history, and the conversation.', permissions: ['customers:read','customers:write','messages:send'], keywords: 'clients people contacts' },
  { key: 'pipeline', label: 'Pipeline', href: '/dashboard/pipeline', icon: Target, category: 'customers', version: 1, updatedAt: '2026-08-13', featured: true, requires: ['customers','quotes'], description: 'Every lead and quote in flight, each with the one thing to do next.', permissions: ['customers:read','quotes:read','invoices:read','jobs:read','messages:read'], keywords: 'sales deals leads opportunities funnel stages next action follow up won lost' },
  { key: 'properties', label: 'Properties', href: '/dashboard/properties', icon: Home, category: 'customers', version: 1, updatedAt: '2026-07-08', requires: ['customers'], description: 'Sites and service locations, with measurements and notes.', permissions: ['properties:read','properties:write','customers:read'], keywords: 'sites addresses locations measurements' },
  { key: 'quotes', label: 'Quotes', href: '/dashboard/quotes', icon: FileText, category: 'money', version: 1, updatedAt: '2026-07-13', requires: ['customers'], description: 'Quote work, send it, and track it to a decision.', permissions: ['quotes:read','quotes:write','customers:read','messages:send'], keywords: 'estimates proposals pricing' },
  { key: 'invoices', label: 'Invoices', href: '/dashboard/invoices', icon: Receipt, category: 'money', version: 1, updatedAt: '2026-07-15', requires: ['customers'], description: "Invoicing, receipts and what you're owed.", permissions: ['invoices:read','invoices:write','customers:read','messages:send'], keywords: 'billing bills receivables owed' },
  { key: 'payments', label: 'Payments', href: '/dashboard/payments', icon: Wallet, category: 'money', version: 1, updatedAt: '2026-07-15', requires: ['invoices'], description: 'The money ledger — every payment, refund and dispute.', permissions: ['payments:read','payments:write','invoices:read'], keywords: 'money received refunds deposits' },
  { key: 'accounting', label: 'Accounting', href: '/dashboard/accounting', icon: Calculator, category: 'money', version: 1, updatedAt: '2026-07-16', requires: ['payments'], description: "Expenses, vendors and what's actually left after the work.", permissions: ['expenses:read','expenses:write','payments:read'], keywords: 'expenses vendors profit p&l' },
  { key: 'messages', label: 'Messages', href: '/dashboard/messages', icon: MessageSquare, category: 'customers', version: 1, updatedAt: '2026-07-09', requires: ['customers'], description: 'Two-way SMS and email with every customer, in one inbox.', permissions: ['messages:read','messages:send','customers:read'], keywords: 'inbox sms email texts leads conversations' },
  { key: 'equipment', label: 'Equipment', href: '/dashboard/equipment', icon: Wrench, category: 'operations', version: 1, updatedAt: '2026-07-15', description: 'The gear that does the work — tracking and upkeep.', permissions: ['equipment:read','equipment:write'], keywords: 'mower trailer truck fleet maintenance service hours parts vehicle' },
  { key: 'sales', label: 'Sales', href: '/dashboard/sales', icon: TrendingUp, category: 'growth', version: 1, updatedAt: '2026-08-16', requires: ['quotes'], description: 'What you quoted, won, invoiced and actually collected — and which sources produced it.', whatsNew: 'Quoted, won, authorized, invoiced and collected are now five separate figures you can trace back to the quotes behind them.', permissions: ['quotes:read','invoices:read','payments:read','customers:read'], keywords: 'sales analytics revenue quoted won lost collected conversion win rate lead source attribution funnel forecast reporting' },
  { key: 'grow', label: 'Grow', href: '/dashboard/grow', icon: Sprout, category: 'growth', version: 1, updatedAt: '2026-07-14', featured: true, description: 'Analytics, marketing and the tools that win more work.', permissions: ['customers:read','jobs:read','quotes:read','marketing:write'], keywords: 'marketing analytics reports intelligence reviews referrals' },
  { key: 'automation', label: 'Automation', href: '/dashboard/automation', icon: Bot, category: 'admin', version: 1, updatedAt: '2026-08-09', requires: ['messages'], description: 'Watches for customers due to re-book and flags them for you. It never messages anyone on its own.', permissions: ['automations:read','automations:write','messages:send','customers:read'], keywords: 'rules reminders follow up watch churn re-book suggestions' },
  { key: 'integrations', label: 'Integrations', href: '/dashboard/integrations', icon: Plug, category: 'admin', version: 1, updatedAt: '2026-08-09', description: 'Connect other apps to EdgeQuote — plus a developer API, if yours needs one.', permissions: ['customers:read','quotes:read','jobs:read','invoices:read','payments:read','customers:write','webhooks:send'], keywords: 'api webhooks zapier make connect apps developer accounts' },
]

const byKey = new Map(FEATURE_MODULES.map(m => [m.key, m]))
export const moduleByKey = (key: string): FeatureModule | undefined => byKey.get(key)
export function recentlyUpdated(limit = 4): FeatureModule[] { return [...FEATURE_MODULES].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0,limit) }
export function searchModules(query: string): FeatureModule[] {
  const q = query.trim().toLowerCase(); if (!q) return FEATURE_MODULES
  return FEATURE_MODULES.filter(m => m.label.toLowerCase().includes(q) || m.description.toLowerCase().includes(q) || MODULE_CATEGORIES[m.category].toLowerCase().includes(q) || (m.keywords ?? '').toLowerCase().includes(q) || m.permissions.some(p => p.includes(q)))
}
const NON_CORE_KEYS = FEATURE_MODULES.filter(m => !m.core).map(m => m.key)
export function visibleModules(enabled: unknown): FeatureModule[] {
  if (!Array.isArray(enabled)) return FEATURE_MODULES
  const keys = new Set(enabled.filter((k): k is string => typeof k === 'string'))
  return FEATURE_MODULES.filter(m => m.core || keys.has(m.key))
}
export function installedKeys(enabled: unknown): string[] {
  if (!Array.isArray(enabled)) return [...NON_CORE_KEYS]
  const valid = new Set(NON_CORE_KEYS)
  return enabled.filter((k): k is string => typeof k === 'string' && valid.has(k))
}
export function normalizeEnabled(keys: string[]): string[] | null {
  const set = new Set(keys); return NON_CORE_KEYS.every(k => set.has(k)) ? null : NON_CORE_KEYS.filter(k => set.has(k))
}
export function dependencyClosure(key: string): string[] {
  const out: string[] = []; const seen = new Set<string>([key])
  const walk = (k: string) => { for (const dep of byKey.get(k)?.requires ?? []) { if (seen.has(dep)) continue; seen.add(dep); if (!byKey.get(dep)?.core) out.push(dep); walk(dep) } }
  walk(key); return out
}
export function installSet(installed: string[], key: string): string[] { const next = new Set(installed); next.add(key); for (const dep of dependencyClosure(key)) next.add(dep); return NON_CORE_KEYS.filter(k => next.has(k)) }
export function uninstallBlockers(installed: string[], key: string): FeatureModule[] { const set = new Set(installed); return FEATURE_MODULES.filter(m => m.key !== key && (m.core || set.has(m.key)) && dependencyClosure(m.key).includes(key)) }
export function uninstallSet(installed: string[], key: string): string[] { return installed.filter(k => k !== key) }
export interface ModuleMeta { v?: number; at?: string }
export type ModuleMetaMap = Record<string, ModuleMeta>
export function readMeta(raw: unknown): ModuleMetaMap { return !raw || typeof raw !== 'object' || Array.isArray(raw) ? {} : raw as ModuleMetaMap }
export function pendingUpdate(m: FeatureModule, meta: ModuleMetaMap): boolean { const v = meta[m.key]?.v; return typeof v === 'number' && v < m.version }
export function stampMeta(meta: ModuleMetaMap, keys: string[], now = new Date().toISOString()): ModuleMetaMap { const next = { ...meta }; for (const k of keys) { const m = byKey.get(k); if (m) next[k] = { v: m.version, at: now } }; return next }
export function isEntitled(m: FeatureModule, entitlements?: unknown): boolean { if (!m.sku) return true; void entitlements; return true }
