'use client'

// Outbound webhooks — endpoints (create / pause / test / delete-with-undo)
// and the live delivery log (expandable payload + response, retry-now).
// The log updates in realtime; a test send goes through the REAL pipeline.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Pause, Play, Plus, RefreshCw, Send, Trash2, Webhook, Zap } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { toast } from '@/lib/toast'
import { cn, formatDate } from '@/lib/utils'
import type { WebhookDeliveryRow, WebhookEndpointRow } from '@/types'
import { INTEGRATION_EVENTS } from '@/lib/integrations/events'
import { MAX_ATTEMPTS } from '@/lib/integrations/retry'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Toggle } from '@/components/ui/Toggle'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import type { Tone } from '@/lib/tone'
import { CopyRow } from './CodeBlock'

const DELIVERY_TONE: Record<WebhookDeliveryRow['status'], Tone> = {
  pending: 'info', processing: 'warn', success: 'success', dead: 'danger',
}

export function WebhooksManager({ userId }: { userId: string }) {
  const supabase = createClient()
  const [endpoints, setEndpoints] = useState<WebhookEndpointRow[] | null>(null)
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRow[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [openSecretId, setOpenSecretId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [eps, dels] = await Promise.all([
      supabase.from('webhook_endpoints').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
      supabase.from('webhook_deliveries').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(30),
    ])
    setEndpoints((eps.data ?? []) as WebhookEndpointRow[])
    setDeliveries((dels.data ?? []) as WebhookDeliveryRow[])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  useEffect(() => { load() }, [load])
  useRealtimeRefresh('webhook_deliveries', `user_id=eq.${userId}`, load)

  const endpointById = useMemo(() => new Map((endpoints ?? []).map((e) => [e.id, e])), [endpoints])

  const setActive = async (ep: WebhookEndpointRow, active: boolean) => {
    const patch = active ? { active: true, disabled_reason: null, consecutive_failures: 0 } : { active: false }
    const { error } = await supabase.from('webhook_endpoints').update(patch).eq('id', ep.id)
    if (error) toast.error(error.message)
    else await load()
  }

  const remove = async (ep: WebhookEndpointRow) => {
    const { error } = await supabase.from('webhook_endpoints').delete().eq('id', ep.id)
    if (error) {
      toast.error(error.message)
      return
    }
    await load()
    toast.undo('Endpoint removed (its delivery log too).', async () => {
      // Re-insert keeps the same secret so the consumer's verification still works.
      await supabase.from('webhook_endpoints').insert({
        id: ep.id, user_id: userId, url: ep.url, description: ep.description,
        secret: ep.secret, events: ep.events, source: ep.source, active: ep.active,
      })
      await load()
    })
  }

  const sendTest = async (ep: WebhookEndpointRow) => {
    setTestingId(ep.id)
    try {
      const res = await fetch('/api/integrations/webhooks/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpointId: ep.id }),
      })
      const json = await res.json()
      if (!res.ok) toast.error(json.error ?? 'Test failed to queue.')
      else if (json.delivery?.status === 'success') toast.success(`Delivered — HTTP ${json.delivery.response_status} in ${json.delivery.duration_ms}ms.`)
      else if (json.queued) toast.info('Test queued — the worker will deliver it shortly.')
      else toast.warning(`Endpoint answered ${json.delivery?.response_status ?? '—'}: ${json.delivery?.last_error ?? 'not delivered yet'}. It will retry automatically.`)
      await load()
    } finally {
      setTestingId(null)
    }
  }

  const retryNow = async (d: WebhookDeliveryRow) => {
    const { error } = await supabase.from('webhook_deliveries')
      .update({ status: 'pending', next_attempt_at: new Date().toISOString() }).eq('id', d.id)
    if (error) {
      toast.error(error.message)
      return
    }
    await fetch('/api/integrations/deliver', { method: 'POST' })
    await load()
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-ink flex items-center gap-2"><Webhook className="w-4 h-4 text-accent-text" /> Endpoints</h3>
              <p className="text-[12px] text-ink-muted mt-0.5">We POST signed JSON to these URLs when events happen. Failures retry {MAX_ATTEMPTS} times with backoff.</p>
            </div>
            <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="w-3.5 h-3.5" /> Add endpoint</Button>
          </div>
        </CardHeader>
        <CardBody className="space-y-2">
          {endpoints === null ? <SkeletonRows count={2} /> : endpoints.length === 0 ? (
            <InlineEmpty icon={Webhook}>No endpoints yet. Add one — or subscribe from Zapier / Make and it shows up here.</InlineEmpty>
          ) : endpoints.map((ep) => (
            <div key={ep.id} className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[12px] text-ink truncate max-w-[26rem]">{ep.url}</span>
                    {ep.source !== 'manual' && <Badge tone="info" icon={Zap}>{ep.source}</Badge>}
                    {!ep.active && <Badge tone={ep.disabled_reason ? 'danger' : 'neutral'}>{ep.disabled_reason ? 'auto-paused' : 'paused'}</Badge>}
                    {ep.active && ep.consecutive_failures > 0 && <Badge tone="warn">{ep.consecutive_failures} failing</Badge>}
                  </div>
                  <div className="text-[11px] text-ink-faint mt-0.5">
                    {ep.events.includes('*') ? 'All events' : ep.events.join(', ')}
                    {ep.description ? ` · ${ep.description}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="sm" loading={testingId === ep.id} onClick={() => sendTest(ep)} disabled={!ep.active}>
                    <Send className="w-3.5 h-3.5" /> Test
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setActive(ep, !ep.active)} aria-label={ep.active ? 'Pause' : 'Resume'}>
                    {ep.active ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setOpenSecretId(openSecretId === ep.id ? null : ep.id)}>Secret</Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(ep)} aria-label="Remove endpoint"><Trash2 className="w-3.5 h-3.5" /></Button>
                </div>
              </div>
              {ep.disabled_reason && !ep.active && <Banner tone="danger">{ep.disabled_reason}</Banner>}
              {openSecretId === ep.id && (
                <CopyRow label="Signing secret (verify the x-edgequote-signature header with this)" value={ep.secret} masked />
              )}
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-ink">Delivery log</h3>
              <p className="text-[12px] text-ink-muted mt-0.5">Last 30 deliveries — updates live. Logs are kept for 30 days.</p>
            </div>
            <Button variant="ghost" size="sm" onClick={load} aria-label="Refresh"><RefreshCw className="w-3.5 h-3.5" /></Button>
          </div>
        </CardHeader>
        <CardBody className="space-y-1.5">
          {deliveries.length === 0 ? (
            <InlineEmpty icon={Send}>Nothing delivered yet. Use the Test button on an endpoint, or wait for real events.</InlineEmpty>
          ) : deliveries.map((d) => {
            const open = expandedId === d.id
            const ep = endpointById.get(d.endpoint_id)
            return (
              <div key={d.id} className="rounded-lg border border-border">
                <button type="button" onClick={() => setExpandedId(open ? null : d.id)} className="w-full flex items-center gap-2.5 p-2.5 text-left">
                  {open ? <ChevronDown className="w-3.5 h-3.5 text-ink-faint shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-ink-faint shrink-0" />}
                  <Badge tone={DELIVERY_TONE[d.status]}>{d.status}</Badge>
                  <span className="font-mono text-[12px] text-ink">{d.event}</span>
                  <span className="text-[11px] text-ink-faint truncate flex-1">{ep?.url ?? 'deleted endpoint'}</span>
                  <span className="text-[11px] text-ink-faint tabular-nums shrink-0">
                    {d.response_status ? `HTTP ${d.response_status} · ` : ''}{d.attempts}/{MAX_ATTEMPTS} · {formatDate(d.created_at)}
                  </span>
                </button>
                {open && (
                  <div className="border-t border-border p-3 space-y-2 text-[12px]">
                    {d.last_error && <div className="text-red-400">{d.last_error}{d.status === 'pending' ? ` — retries ${formatDate(d.next_attempt_at)}` : ''}</div>}
                    <div className="grid gap-2 sm:grid-cols-2">
                      <pre className="bg-bg-tertiary border border-border-strong rounded-lg p-2.5 text-[11px] font-mono text-ink-muted overflow-x-auto max-h-56">
                        {JSON.stringify({ id: d.event_id ?? d.id, event: d.event, created_at: d.created_at, data: d.payload }, null, 2)}
                      </pre>
                      <pre className={cn('bg-bg-tertiary border border-border-strong rounded-lg p-2.5 text-[11px] font-mono overflow-x-auto max-h-56', d.response_body ? 'text-ink-muted' : 'text-ink-faint')}>
                        {d.response_body || '(no response body)'}
                      </pre>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-ink-faint tabular-nums">{d.duration_ms != null ? `${d.duration_ms}ms` : ''}</span>
                      {(d.status === 'dead' || d.status === 'pending') && (
                        <Button variant="secondary" size="sm" onClick={() => retryNow(d)}><RefreshCw className="w-3.5 h-3.5" /> Retry now</Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </CardBody>
      </Card>

      <CreateEndpointModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={load} />
    </div>
  )
}

function CreateEndpointModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => Promise<void> }) {
  const [url, setUrl] = useState('')
  const [description, setDescription] = useState('')
  const [allEvents, setAllEvents] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)

  const close = () => {
    setUrl(''); setDescription(''); setAllEvents(true); setSelected([]); setSecret(null)
    onClose()
  }

  const create = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/integrations/webhooks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, description, events: allEvents ? ['*'] : selected }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error ?? 'Could not create the endpoint.')
        return
      }
      setSecret(json.secret)
      await onCreated()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={close} title={secret ? 'Endpoint created' : 'Add endpoint'} icon={Webhook} size="md" onSubmit={secret ? undefined : create}
      footer={secret ? <Button onClick={close}>Done</Button> : (
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button onClick={create} loading={saving} disabled={!url || (!allEvents && selected.length === 0)}>Create endpoint</Button>
        </>
      )}>
      {secret ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-muted">Deliveries start immediately. Verify each request with the signing secret (also available later via the Secret button).</p>
          <CopyRow label="Signing secret" value={secret} />
        </div>
      ) : (
        <div className="space-y-4">
          <Input label="Payload URL" placeholder="https://example.com/webhooks/edgequote" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Input label="Description (optional)" placeholder="e.g. Slack notifier" value={description} onChange={(e) => setDescription(e.target.value)} />
          <Toggle checked={allEvents} onChange={setAllEvents} label="Send all events" />
          {!allEvents && (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {INTEGRATION_EVENTS.map((ev) => (
                <label key={ev.key} className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-ink cursor-pointer hover:border-border-strong">
                  <input
                    type="checkbox"
                    className="accent-current"
                    checked={selected.includes(ev.key)}
                    onChange={(e) => setSelected((s) => e.target.checked ? [...s, ev.key] : s.filter((k) => k !== ev.key))}
                  />
                  <span className="font-mono">{ev.key}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
