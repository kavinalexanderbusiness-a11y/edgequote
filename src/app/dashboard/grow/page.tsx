'use client'

import Link from 'next/link'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { SuggestionsCenter } from '@/components/grow/SuggestionsCenter'
import { CustomerHealthPanel } from '@/components/grow/CustomerHealthPanel'
import { WinLossPanel } from '@/components/grow/WinLossPanel'
import {
  BarChart3, Gauge, HeartPulse, Map as MapIcon, Target, ShieldCheck, CalendarCheck, ArrowRight, TrendingUp,
} from 'lucide-react'

// ── Grow hub ──────────────────────────────────────────────────────────────────
// One home for everything that grows the business, so the sidebar stays short.
// Grouped by INTENT (make money / get customers / keep customers / stay on top),
// each card a one-line "what it does" + a direct link. The Suggestions Center
// (action feed) will land at the top of this page.

interface Tool { label: string; href: string; icon: typeof BarChart3; blurb: string }

const GROUPS: { title: string; tools: Tool[] }[] = [
  {
    title: 'Make more money',
    tools: [
      { label: 'Pricing Recovery', href: '/dashboard/pricing-recovery', icon: Gauge, blurb: 'Unpriced & underpriced jobs worth fixing — one-tap repairs.' },
      { label: 'Profitability', href: '/dashboard/profitability', icon: BarChart3, blurb: 'Which routes and neighborhoods actually make money.' },
    ],
  },
  {
    title: 'Get more customers',
    tools: [
      { label: 'Saturation Map', href: '/dashboard/saturation', icon: MapIcon, blurb: 'Where your routes are strong and where to grow next.' },
      { label: 'Neighbor Leads', href: '/dashboard/neighbors', icon: Target, blurb: 'Door-knock prospects right next to your best customers.' },
    ],
  },
  {
    title: 'Keep customers',
    tools: [
      { label: 'Reactivation', href: '/dashboard/reactivation', icon: HeartPulse, blurb: 'Lapsed and at-risk customers worth winning back.' },
    ],
  },
  {
    title: 'Stay on top of it',
    tools: [
      { label: 'Weekly Review', href: '/dashboard/review', icon: CalendarCheck, blurb: 'Last week’s results and this week’s moves at a glance.' },
      { label: 'Labor Intelligence', href: '/dashboard/labor-intelligence', icon: Gauge, blurb: 'How accurate your time estimates are — and where they’re learning.' },
      { label: 'Data Quality', href: '/dashboard/data-quality', icon: ShieldCheck, blurb: 'Missing customers, prices and locations to clean up.' },
    ],
  },
]

export default function GrowPage() {
  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="Grow" description="Everything that grows Edge Property Services, in one place." />

      {/* Intelligence — the owner's command center: report (BI) + act (Revenue Intel). */}
      <div className="grid sm:grid-cols-2 gap-3">
        <Link href="/dashboard/intelligence">
          <Card className="p-4 h-full border-accent/30 bg-gradient-to-br from-accent/[0.08] to-transparent hover:border-accent/50 transition-colors">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
                <BarChart3 className="w-5 h-5 text-accent" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-ink flex items-center gap-1.5">Business Intelligence <ArrowRight className="w-3.5 h-3.5 text-accent" /></p>
                <p className="text-xs text-ink-muted mt-0.5">Revenue, profit, customers, sales, capacity & forecasts — how the business is performing.</p>
              </div>
            </div>
          </Card>
        </Link>
        <Link href="/dashboard/revenue-intelligence">
          <Card className="p-4 h-full border-accent/30 bg-gradient-to-br from-accent/[0.08] to-transparent hover:border-accent/50 transition-colors">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
                <TrendingUp className="w-5 h-5 text-accent" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-ink flex items-center gap-1.5">Revenue Intelligence <ArrowRight className="w-3.5 h-3.5 text-accent" /></p>
                <p className="text-xs text-ink-muted mt-0.5">Every customer scored for renewal, upsell, cross-sell, referral — ranked by $ impact.</p>
              </div>
            </div>
          </Card>
        </Link>
      </div>

      {/* Suggestions Center — the action feed comes first. */}
      <SuggestionsCenter />

      {/* Intelligence: who's slipping / who's valuable, and why quotes are lost. */}
      <CustomerHealthPanel />
      <WinLossPanel />

      {GROUPS.map(group => (
        <div key={group.title} className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint px-1">{group.title}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.tools.map(({ label, href, icon: Icon, blurb }) => (
              <Link key={href} href={href}>
                <Card className="p-4 hover:border-accent/40 transition-colors h-full">
                  <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                      <Icon className="w-4 h-4 text-accent" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink flex items-center gap-1.5">{label} <ArrowRight className="w-3.5 h-3.5 text-ink-faint" /></p>
                      <p className="text-xs text-ink-muted mt-0.5">{blurb}</p>
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
