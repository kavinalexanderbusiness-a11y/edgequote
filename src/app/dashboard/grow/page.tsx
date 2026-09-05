'use client'

import Link from 'next/link'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { SuggestionsCenter } from '@/components/grow/SuggestionsCenter'
import { CustomerHealthPanel } from '@/components/grow/CustomerHealthPanel'
import { WinLossPanel } from '@/components/grow/WinLossPanel'
import { useModules } from '@/hooks/useModules'
import { modulesForNavigation } from '@/lib/modules'
import {
  BarChart3, Gauge, HeartPulse, Map as MapIcon, Target, ShieldCheck, CalendarCheck,
  ArrowRight, TrendingUp, CloudRain, Ruler, FileText, ChevronDown, type LucideIcon,
} from 'lucide-react'

// ── Grow ─────────────────────────────────────────────────────────────────────
// One question: "what should I do to get more work?"
//
// This page used to answer it with 18 blocks under a 9-pill rail — an action
// feed, three feature cards, two analytics panels, and twelve equal-weight tool
// cards in five groups. Everything the app can do about growth was on one
// screen at the same size, so nothing was the next step. Three of those cards
// (Marketing Studio, Before/After, Automations) pointed at destinations already
// sitting in the rail directly above them, and a third of the rest were not
// about growth at all — Weather, Data Quality, Reports, Measurement Accuracy.
//
// Now: the action feed, then THREE plain-language goals, then everything else
// behind disclosure. Nothing was deleted — Grow is still the only door to these
// routes (they are not in the sidebar registry), so every link is still on this
// page and `verify:navigation`'s no-dead-ends rule still holds. They just stop
// competing with the answer.

interface Tool { label: string; href: string; icon: LucideIcon; blurb: string }

// THE three things an owner can actually do about growth, in the order they pay
// off: find new work, keep the customers already won, and charge properly for
// both. Deliberately not five — "Stay on top of it" was a drawer, not a goal.
const GOALS: { title: string; sub: string; tools: Tool[] }[] = [
  {
    title: 'Get more customers',
    sub: 'Find work near the routes you already drive',
    tools: [
      { label: 'Neighbours to door-knock', href: '/dashboard/neighbors', icon: Target, blurb: 'Prospects right next to your best customers.' },
      { label: 'Where to grow next', href: '/dashboard/saturation', icon: MapIcon, blurb: 'Which areas your routes already own, and which are thin.' },
    ],
  },
  {
    title: 'Keep the customers you have',
    sub: 'Cheaper than finding new ones',
    tools: [
      { label: 'Win back lapsed customers', href: '/dashboard/reactivation', icon: HeartPulse, blurb: 'Who has gone quiet, and what they used to be worth.' },
      { label: 'Who to call next', href: '/dashboard/revenue-intelligence', icon: TrendingUp, blurb: 'Every customer ranked for renewal, upsell and referral.' },
    ],
  },
  {
    title: 'Charge what the work is worth',
    sub: 'Money you are already owed by your own price list',
    tools: [
      { label: 'Fix unpriced & underpriced jobs', href: '/dashboard/pricing-recovery', icon: Gauge, blurb: 'One-tap repairs on jobs earning less than they should.' },
      { label: 'What actually makes money', href: '/dashboard/profitability', icon: BarChart3, blurb: 'Which routes and neighbourhoods are worth the drive.' },
    ],
  },
]

// Everything that is genuinely useful but is NOT "what do I do next": reports to
// read, and tools that belong to running the business rather than growing it.
// One line each, behind a summary, so they cost a tap instead of a screen.
const LOOK: Tool[] = [
  { label: 'How the business is doing', href: '/dashboard/intelligence', icon: BarChart3, blurb: 'Revenue, profit, customers, capacity and forecasts on one page.' },
  { label: 'Last week & this week', href: '/dashboard/review', icon: CalendarCheck, blurb: 'What happened, and the moves worth making next.' },
  { label: 'Reports & exports', href: '/dashboard/reports', icon: FileText, blurb: 'Revenue and GST for any quarter — what your bookkeeper asks for.' },
]

const HOUSEKEEPING: Tool[] = [
  { label: 'Weather risk', href: '/dashboard/weather', icon: CloudRain, blurb: 'Rain-threatened work worth moving.' },
  { label: 'Data to clean up', href: '/dashboard/data-quality', icon: ShieldCheck, blurb: 'Missing prices, addresses and contact details.' },
  { label: 'Measurement accuracy', href: '/dashboard/measurements', icon: Ruler, blurb: 'How close auto-measure runs to what you accept.' },
]

// One row. Not a card: a card says "consider me", a row says "here it is".
function ToolRow({ label, href, icon: Icon, blurb }: Tool) {
  return (
    <Link href={href}
      className="group flex items-start gap-3 rounded-xl border border-border bg-bg-secondary px-3.5 py-3 transition-colors hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
      <span className="w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
        <Icon aria-hidden className="w-4 h-4 text-accent-text" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold tracking-tight text-ink flex items-center gap-1.5">
          {label}
          <ArrowRight aria-hidden className="w-3.5 h-3.5 text-ink-faint transition-transform group-hover:translate-x-0.5" />
        </span>
        <span className="block text-xs text-ink-muted mt-0.5">{blurb}</span>
      </span>
    </Link>
  )
}

// Native <details>: keyboard and screen-reader behaviour for free, no state, and
// it degrades to plain visible content if CSS never arrives.
function Drawer({ title, hint, tools }: { title: string; hint: string; tools: Tool[] }) {
  return (
    <details className="group rounded-card border border-border bg-bg-secondary/60">
      <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer list-none min-h-[48px] rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        <ChevronDown aria-hidden className="w-4 h-4 text-ink-faint transition-transform group-open:rotate-180 shrink-0" />
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink">{title}</span>
          <span className="block text-xs text-ink-muted">{hint}</span>
        </span>
      </summary>
      <div className="px-4 pb-4 pt-1 grid gap-2 sm:grid-cols-2">
        {tools.map(t => <ToolRow key={t.href} {...t} />)}
      </div>
    </details>
  )
}

export default function GrowPage() {
  const { visible } = useModules()
  const reportingTools: Tool[] = modulesForNavigation(visible, 'grow').map(m => ({
    label: m.label, href: m.href, icon: m.icon, blurb: m.description,
  }))
  return (
    <PageContainer>
      {/* Plain words. The old subtitle ("Your AI advisor for pricing, growth and
          retention — built on your own numbers") described the software; this
          describes the job. */}
      <PageHeader title="Grow" description="What to do next to win more work — and keep the customers you already have." />

      {/* The answer to the page's question comes first and stays first. */}
      <SuggestionsCenter />

      {GOALS.map((g, i) => (
        <section key={g.title} className={`space-y-2 animate-rise stagger-${Math.min(i + 2, 6)}`}>
          <div className="px-1">
            <h2 className="text-sm font-bold tracking-tight text-ink">{g.title}</h2>
            <p className="text-xs text-ink-muted">{g.sub}</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {g.tools.map(t => <ToolRow key={t.href} {...t} />)}
          </div>
        </section>
      ))}

      {/* Who is slipping, and why quotes are lost. Real answers rather than
          navigation, so they sit below the goals but above the drawers — and
          each now says plainly when it could not load, instead of rendering a
          failed read as an all-clear. */}
      <CustomerHealthPanel />
      <WinLossPanel />

      <Drawer title="See what's working" hint="Reports and results, when you want to read rather than act" tools={[...reportingTools, ...LOOK]} />
      <Drawer title="Other tools" hint="Housekeeping that keeps the numbers above honest" tools={HOUSEKEEPING} />
    </PageContainer>
  )
}
