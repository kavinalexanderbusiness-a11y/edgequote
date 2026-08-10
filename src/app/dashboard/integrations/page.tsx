'use client'

// The Integrations workspace — ONE surface over the platform's four doors:
// API keys (REST), outbound webhooks, inbound webhooks, and the existing
// connected-apps framework (social_connections via ConnectionsManager —
// mounted here, not rebuilt). Zapier/Make ride the first three.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Activity, AlertTriangle, ArrowDownToLine, BookOpen, Boxes, KeyRound, LayoutDashboard, Plug, Webhook } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { cn, formatDate } from '@/lib/utils'
import type { IntegrationEventRow } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Tabs, type TabItem } from '@/components/ui/Tabs'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { Banner } from '@/components/ui/Banner'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonTiles } from '@/components/ui/Skeleton'
import { ApiKeysManager } from '@/components/integrations/ApiKeysManager'
import { WebhooksManager } from '@/components/integrations/WebhooksManager'
import { InboundHooksManager } from '@/components/integrations/InboundHooksManager'
import { ConnectionsManager } from '@/components/grow/marketing/ConnectionsManager'

// ── Tab order is the argument this page was getting wrong ────────────────────
// It used to open on an Overview of API keys, webhook endpoints and delivery
// success rates, under a subtitle that began "REST API, signed webhooks". For
// the owner of a service business that is a wall of somebody else's job — and
// it was the FIRST thing the page said, on a screen most of them open once out
// of curiosity. (Checked against production: zero API keys, zero endpoints,
// zero deliveries, zero captured events. The only thing anyone had actually
// connected was an account under "Connected apps", the fifth tab.)
//
// So the real thing leads, and the developer surface — which is complete, and
// stays exactly as capable — follows it. Nothing was removed.
const TABS: TabItem[] = [
  { key: 'apps', label: 'Connected apps', icon: Boxes },
  { key: 'overview', label: 'API activity', icon: LayoutDashboard },
  { key: 'keys', label: 'API keys', icon: KeyRound },
  { key: 'webhooks', label: 'Webhooks', icon: Webhook },
  { key: 'inbound', label: 'Inbound', icon: ArrowDownToLine },
]
type Tab = (typeof TABS)[number]['key']
const DEFAULT_TAB: Tab = 'apps'

interface OverviewStats {
  keys: number
  endpoints: number
  deliveries7d: number
  delivered7d: number
  events: IntegrationEventRow[]
}

export default function IntegrationsPage() {
  const supabase = createClient()
  const [userId, setUserId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>(DEFAULT_TAB)
  const [stats, setStats] = useState<OverviewStats | null>(null)
  /** The counts couldn't be read. Distinct from "the counts are all zero" — one
   *  is a question we failed to ask, the other is an answer. */
  const [statsError, setStatsError] = useState<string | null>(null)

  useEffect(() => {
    const hash = window.location.hash.replace('#', '')
    if (TABS.some((t) => t.key === hash)) setTab(hash as Tab)
    supabase.auth.getSession().then(({ data: { session } }) => setUserId(session?.user?.id ?? null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pickTab = (key: string) => {
    setTab(key as Tab)
    history.replaceState(null, '', '#' + key)
  }

  const loadStats = useCallback(async (uid: string) => {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const [keys, endpoints, deliveries, delivered, events] = await Promise.all([
      supabase.from('api_keys').select('id', { count: 'exact', head: true }).eq('user_id', uid).is('revoked_at', null),
      supabase.from('webhook_endpoints').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('active', true),
      supabase.from('webhook_deliveries').select('id', { count: 'exact', head: true }).eq('user_id', uid).gt('created_at', weekAgo),
      supabase.from('webhook_deliveries').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('status', 'success').gt('created_at', weekAgo),
      supabase.from('integration_events').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(8),
    ])
    // ⚠️ On a failed query PostgREST gives back `count: null` / `data: null` AND
    // an error — and `?? 0` turned every one of those into a confident zero.
    // Four zeros is exactly the shape of "nothing connected yet", so a dropped
    // connection or an RLS change rendered as a tidy empty state inviting the
    // owner to create their first API key. A read we could not perform must not
    // be reported as a fact about their account.
    const failed = keys.error ?? endpoints.error ?? deliveries.error ?? delivered.error ?? events.error
    if (failed) { setStatsError(failed.message); setStats(null); return }
    setStatsError(null)
    setStats({
      keys: keys.count ?? 0,
      endpoints: endpoints.count ?? 0,
      deliveries7d: deliveries.count ?? 0,
      delivered7d: delivered.count ?? 0,
      events: (events.data ?? []) as IntegrationEventRow[],
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (userId && tab === 'overview') loadStats(userId)
  }, [userId, tab, loadStats])

  const gettingStarted = stats !== null && stats.keys === 0 && stats.endpoints === 0

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PageHeader
        title="Integrations"
        description="Connect the other apps you use. The rest of this page is for developers — most businesses never need it."
        action={
          <Link href="/dashboard/integrations/docs">
            <Button variant="secondary"><BookOpen className="w-4 h-4" /> API docs</Button>
          </Link>
        }
      />

      <div className="animate-rise stagger-1">
        <Tabs tabs={TABS} active={tab} onChange={pickTab} />
      </div>

      {userId === null ? <SkeletonTiles count={4} /> : (
        <>
          <div className={cn('space-y-6', tab !== 'overview' && 'hidden')}>
            {statsError ? (
              <Banner tone="danger" icon={AlertTriangle}>
                Couldn’t load your integration activity — {statsError}. This is a display problem: nothing about
                your keys, endpoints or deliveries has changed.
              </Banner>
            ) : gettingStarted ? (
              <Card className="animate-rise stagger-2">
                <CardBody>
                  <EmptyState
                    icon={Plug}
                    title="No API activity yet"
                    description="This tab is for developers. An API key lets another tool read your data, a webhook endpoint pushes events out, and an inbound URL pipes leads in. The docs walk through Zapier and Make step by step."
                    action={{ label: 'Create an API key', onClick: () => pickTab('keys') }}
                  />
                </CardBody>
              </Card>
            ) : stats === null ? <SkeletonTiles count={4} /> : (
              <>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 animate-rise stagger-2">
                  <StatTile label="Live API keys" value={String(stats.keys)} icon={KeyRound} onClick={() => pickTab('keys')} />
                  <StatTile label="Active endpoints" value={String(stats.endpoints)} icon={Webhook} onClick={() => pickTab('webhooks')} />
                  <StatTile label="Deliveries (7d)" value={String(stats.deliveries7d)} icon={Activity} />
                  <StatTile
                    label="Delivery success"
                    value={stats.deliveries7d > 0 ? `${Math.round((stats.delivered7d / stats.deliveries7d) * 100)}%` : '—'}
                    tone={stats.deliveries7d > 0 && stats.delivered7d < stats.deliveries7d ? 'warn' : 'success'}
                    icon={Webhook}
                    onClick={() => pickTab('webhooks')}
                  />
                </div>
                <Card className="animate-rise stagger-3">
                  <CardHeader>
                    <h3 className="font-semibold text-ink">Recent events</h3>
                    <p className="text-[12px] text-ink-muted mt-0.5">Everything captured for your endpoints and the API event stream (kept 30 days).</p>
                  </CardHeader>
                  <CardBody className="space-y-1.5">
                    {stats.events.length === 0 ? (
                      <InlineEmpty icon={Activity}>
                        No events captured yet — they start flowing when quotes, jobs, invoices and payments change.
                      </InlineEmpty>
                    ) : stats.events.map((e) => (
                      <div key={e.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                        <code className="text-[12px] font-mono text-accent-text">{e.event}</code>
                        <span className="text-[12px] text-ink-muted truncate flex-1">
                          {String((e.payload as Record<string, unknown>).customer_name ?? (e.payload as Record<string, unknown>).name ?? e.entity_type)}
                        </span>
                        <span className="text-[11px] text-ink-faint tabular-nums">{formatDate(e.created_at)}</span>
                      </div>
                    ))}
                  </CardBody>
                </Card>
              </>
            )}
          </div>

          <div className={cn('animate-rise stagger-2', tab !== 'keys' && 'hidden')}>
            <ApiKeysManager userId={userId} />
          </div>
          <div className={cn('animate-rise stagger-2', tab !== 'webhooks' && 'hidden')}>
            <WebhooksManager userId={userId} />
          </div>
          <div className={cn('animate-rise stagger-2', tab !== 'inbound' && 'hidden')}>
            <InboundHooksManager userId={userId} />
          </div>
          <div className={cn('space-y-4 animate-rise stagger-2', tab !== 'apps' && 'hidden')}>
            {/* The accounts come first. The Zapier/Make note used to sit above them,
                so the owner-facing tab still opened with "API key" and "webhook URL"
                — the same wall, one tab further in. It is a footnote now. */}
            <ConnectionsManager userId={userId} />
            <p className="text-[12px] text-ink-faint">
              Using Zapier or Make? They need no separate connection here — give them an API key and an inbound
              URL from the developer tabs. The{' '}
              <Link href="/dashboard/integrations/docs#zapier" className="text-accent-text hover:underline">docs</Link>{' '}
              have the exact recipes.
            </p>
          </div>
        </>
      )}
    </div>
  )
}
