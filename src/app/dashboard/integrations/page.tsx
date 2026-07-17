'use client'

// The Integrations workspace — ONE surface over the platform's four doors:
// API keys (REST), outbound webhooks, inbound webhooks, and the existing
// connected-apps framework (social_connections via ConnectionsManager —
// mounted here, not rebuilt). Zapier/Make ride the first three.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Activity, ArrowDownToLine, BookOpen, Boxes, KeyRound, LayoutDashboard, Plug, Webhook } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { cn, formatDate } from '@/lib/utils'
import type { IntegrationEventRow } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Tabs, type TabItem } from '@/components/ui/Tabs'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonTiles } from '@/components/ui/Skeleton'
import { ApiKeysManager } from '@/components/integrations/ApiKeysManager'
import { WebhooksManager } from '@/components/integrations/WebhooksManager'
import { InboundHooksManager } from '@/components/integrations/InboundHooksManager'
import { ConnectionsManager } from '@/components/grow/marketing/ConnectionsManager'

const TABS: TabItem[] = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'keys', label: 'API keys', icon: KeyRound },
  { key: 'webhooks', label: 'Webhooks', icon: Webhook },
  { key: 'inbound', label: 'Inbound', icon: ArrowDownToLine },
  { key: 'apps', label: 'Connected apps', icon: Boxes },
]
type Tab = (typeof TABS)[number]['key']

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
  const [tab, setTab] = useState<Tab>('overview')
  const [stats, setStats] = useState<OverviewStats | null>(null)

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
        description="Connect EdgeQuote to everything else — REST API, signed webhooks, Zapier, Make, and your other tools."
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
            {gettingStarted ? (
              <Card className="animate-rise stagger-2">
                <CardBody>
                  <EmptyState
                    icon={Plug}
                    title="Nothing connected yet"
                    description="Create an API key to let other tools read your data, add a webhook endpoint to push events out, or make an inbound URL to pipe leads in. The docs walk through Zapier and Make step by step."
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
            <Card>
              <CardHeader>
                <h3 className="font-semibold text-ink">Zapier &amp; Make</h3>
                <p className="text-[12px] text-ink-muted mt-0.5">
                  No separate connection needed: give Zapier or Make an API key (triggers + lookups) and an inbound
                  webhook URL (actions). The <Link href="/dashboard/integrations/docs#zapier" className="text-accent-text hover:underline">docs</Link> have
                  the exact recipes.
                </p>
              </CardHeader>
            </Card>
            <ConnectionsManager userId={userId} />
          </div>
        </>
      )}
    </div>
  )
}
