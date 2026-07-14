'use client'

import Link from 'next/link'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { SuggestionsCenter } from '@/components/grow/SuggestionsCenter'
import { CustomerHealthPanel } from '@/components/grow/CustomerHealthPanel'
import { WinLossPanel } from '@/components/grow/WinLossPanel'
import {
  BarChart3, Gauge, HeartPulse, Map as MapIcon, Target, ShieldCheck, CalendarCheck, ArrowRight, TrendingUp, CloudRain, Images, Sparkles,
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
    title: 'Show off your work',
    tools: [
      { label: 'Before / After Studio', href: '/dashboard/grow/before-after', icon: Images, blurb: 'Turn job photos into branded before/after posts — AI picks the best pair.' },
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
      { label: 'Move Jobs', href: '/dashboard/weather', icon: CloudRain, blurb: 'Spot rain-threatened work and reschedule it — jobs, hours & revenue at stake.' },
      { label: 'Data Quality', href: '/dashboard/data-quality', icon: ShieldCheck, blurb: 'Missing customers, prices and locations to clean up.' },
    ],
  },
]

// A featured destination card — the three intelligence surfaces. `group` +
// card-lift give it the hover language of the whole Grow experience: the card
// floats, the arrow leans in.
function FeatureCard({ href, icon: Icon, title, blurb }: { href: string; icon: typeof BarChart3; title: string; blurb: string }) {
  return (
    <Link href={href} className="group block h-full">
      <Card className="p-5 h-full border-accent/25 hero-aurora card-lift hover:border-accent/50">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
            <Icon className="w-5 h-5 text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold tracking-tight text-ink flex items-center gap-1.5">
              {title} <ArrowRight className="w-3.5 h-3.5 text-accent transition-transform group-hover:translate-x-0.5" />
            </p>
            <p className="text-xs text-ink-muted mt-0.5">{blurb}</p>
          </div>
        </div>
      </Card>
    </Link>
  )
}

export default function GrowPage() {
  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="Grow" description="Your AI advisor for pricing, growth and retention — built on your own numbers." />

      {/* Suggestions Center — the action feed comes FIRST: "what should I do next?"
          leads the page; the navigation cards below are reference, not action. */}
      <SuggestionsCenter />

      {/* Intelligence — the owner's command center: report (BI) + act (Revenue Intel). */}
      <div className="grid sm:grid-cols-2 gap-4 animate-rise stagger-2">
        <FeatureCard href="/dashboard/intelligence" icon={BarChart3} title="Business Intelligence"
          blurb="Revenue, profit, customers, sales, capacity & forecasts — how the business is performing." />
        <FeatureCard href="/dashboard/revenue-intelligence" icon={TrendingUp} title="Revenue Intelligence"
          blurb="Every customer scored for renewal, upsell, cross-sell, referral — ranked by $ impact." />
      </div>

      {/* Customer Automation — reviews, referrals, follow-ups & campaigns. */}
      <div className="animate-rise stagger-3">
        <FeatureCard href="/dashboard/grow/crm" icon={Sparkles} title="Customer Automation"
          blurb="Review pipeline, referral tracking, follow-up radar, and birthday/anniversary/win-back/marketing campaigns." />
      </div>

      {/* Intelligence: who's slipping / who's valuable, and why quotes are lost. */}
      <CustomerHealthPanel />
      <WinLossPanel />

      {GROUPS.map(group => (
        <div key={group.title} className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint px-1">{group.title}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {group.tools.map(({ label, href, icon: Icon, blurb }) => (
              <Link key={href} href={href} className="group block h-full">
                <Card className="p-5 card-lift hover:border-accent/40 h-full">
                  <div className="flex items-start gap-3.5">
                    <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                      <Icon className="w-4 h-4 text-accent" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold tracking-tight text-ink flex items-center gap-1.5">
                        {label} <ArrowRight className="w-3.5 h-3.5 text-ink-faint transition-transform group-hover:translate-x-0.5" />
                      </p>
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
