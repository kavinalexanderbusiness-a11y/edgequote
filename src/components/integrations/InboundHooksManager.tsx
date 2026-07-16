'use client'

// Inbound webhooks — receive-URL management + the receipts log (what arrived
// and what we did with it). The token IS the URL; a curl sample makes any
// hook testable in one paste.

import { useCallback, useEffect, useState } from 'react'
import { ArrowDownToLine, ChevronDown, ChevronRight, Pause, Play, Plus, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { toast } from '@/lib/toast'
import { formatDate } from '@/lib/utils'
import type { InboundEventRow, InboundWebhookRow } from '@/types'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Badge } from '@/components/ui/Badge'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { CodeBlock, CopyRow } from './CodeBlock'

const ACTION_LABEL: Record<InboundWebhookRow['action'], string> = {
  lead: 'Create lead (customer + service request)',
  customer: 'Create customer only',
}

export function InboundHooksManager({ userId }: { userId: string }) {
  const supabase = createClient()
  const [hooks, setHooks] = useState<InboundWebhookRow[] | null>(null)
  const [receipts, setReceipts] = useState<InboundEventRow[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [action, setAction] = useState<'lead' | 'customer'>('lead')
  const [saving, setSaving] = useState(false)
  const [openHookId, setOpenHookId] = useState<string | null>(null)
  const [expandedReceipt, setExpandedReceipt] = useState<string | null>(null)

  const base = typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_APP_URL || window.location.origin).replace(/\/$/, '')
    : ''

  const load = useCallback(async () => {
    const [h, r] = await Promise.all([
      supabase.from('inbound_webhooks').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
      supabase.from('inbound_events').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(15),
    ])
    setHooks((h.data ?? []) as InboundWebhookRow[])
    setReceipts((r.data ?? []) as InboundEventRow[])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  useEffect(() => { load() }, [load])
  useRealtimeRefresh('inbound_events', `user_id=eq.${userId}`, load)

  const create = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/integrations/inbound', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, action }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error ?? 'Could not create the webhook.')
        return
      }
      setCreateOpen(false)
      setName('')
      setOpenHookId(json.id)
      await load()
      toast.success('Inbound webhook created — copy its URL below.')
    } finally {
      setSaving(false)
    }
  }

  const setActive = async (h: InboundWebhookRow, active: boolean) => {
    const { error } = await supabase.from('inbound_webhooks').update({ active }).eq('id', h.id)
    if (error) toast.error(error.message)
    else await load()
  }

  const remove = async (h: InboundWebhookRow) => {
    const { error } = await supabase.from('inbound_webhooks').delete().eq('id', h.id)
    if (error) {
      toast.error(error.message)
      return
    }
    await load()
    toast.undo(`${h.name} removed — its URL stopped working.`, async () => {
      await supabase.from('inbound_webhooks').insert({
        id: h.id, user_id: userId, name: h.name, token: h.token, action: h.action, active: h.active,
      })
      await load()
    })
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-ink flex items-center gap-2"><ArrowDownToLine className="w-4 h-4 text-accent-text" /> Inbound webhooks</h3>
              <p className="text-[12px] text-ink-muted mt-0.5">URLs other tools POST to — Zapier/Make actions, form builders, custom code. New leads thread into Messages automatically.</p>
            </div>
            <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="w-3.5 h-3.5" /> New URL</Button>
          </div>
        </CardHeader>
        <CardBody className="space-y-2">
          {hooks === null ? <SkeletonRows count={2} /> : hooks.length === 0 ? (
            <InlineEmpty icon={ArrowDownToLine}>No inbound webhooks yet. Create one to pipe leads in from anywhere.</InlineEmpty>
          ) : hooks.map((h) => {
            const url = `${base}/api/hooks/in/${h.token}`
            const open = openHookId === h.id
            return (
              <div key={h.id} className="rounded-lg border border-border p-3 space-y-2">
                <div className="flex items-center gap-3">
                  <button type="button" onClick={() => setOpenHookId(open ? null : h.id)} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-ink">{h.name}</span>
                      <Badge tone={h.action === 'lead' ? 'accent' : 'info'}>{h.action}</Badge>
                      {!h.active && <Badge tone="neutral">paused</Badge>}
                    </div>
                    <div className="text-[11px] text-ink-faint mt-0.5 tabular-nums">
                      {h.received_count > 0 ? `${h.received_count} received · last ${formatDate(h.last_received_at!)}` : 'Nothing received yet'}
                    </div>
                  </button>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="sm" onClick={() => setActive(h, !h.active)} aria-label={h.active ? 'Pause' : 'Resume'}>
                      {h.active ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(h)} aria-label="Remove"><Trash2 className="w-3.5 h-3.5" /></Button>
                  </div>
                </div>
                {open && (
                  <div className="space-y-3 pt-1">
                    <CopyRow label={`Webhook URL — ${ACTION_LABEL[h.action]}`} value={url} />
                    <CodeBlock label="Test it" code={`curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -d '{"name":"Jordan Miller","phone":"403-555-0142","message":"Please quote weekly mowing."}'`} />
                  </div>
                )}
              </div>
            )
          })}
        </CardBody>
      </Card>

      {receipts.length > 0 && (
        <Card>
          <CardHeader>
            <h3 className="font-semibold text-ink">Recent receipts</h3>
            <p className="text-[12px] text-ink-muted mt-0.5">What arrived and what happened to it — updates live.</p>
          </CardHeader>
          <CardBody className="space-y-1.5">
            {receipts.map((r) => {
              const open = expandedReceipt === r.id
              return (
                <div key={r.id} className="rounded-lg border border-border">
                  <button type="button" onClick={() => setExpandedReceipt(open ? null : r.id)} className="w-full flex items-center gap-2.5 p-2.5 text-left">
                    {open ? <ChevronDown className="w-3.5 h-3.5 text-ink-faint shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-ink-faint shrink-0" />}
                    <Badge tone={r.ok ? 'success' : 'danger'}>{r.ok ? 'processed' : 'rejected'}</Badge>
                    <span className="text-[12px] text-ink truncate flex-1">{r.summary}</span>
                    <span className="text-[11px] text-ink-faint tabular-nums shrink-0">{formatDate(r.created_at)}</span>
                  </button>
                  {open && (
                    <pre className="border-t border-border bg-bg-tertiary rounded-b-lg p-2.5 text-[11px] font-mono text-ink-muted overflow-x-auto max-h-56">
                      {JSON.stringify(r.payload, null, 2)}
                    </pre>
                  )}
                </div>
              )
            })}
          </CardBody>
        </Card>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New inbound webhook" icon={ArrowDownToLine} size="sm" onSubmit={create}
        footer={<>
          <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button onClick={create} loading={saving}>Create</Button>
        </>}>
        <div className="space-y-4">
          <Input label="Name" placeholder="e.g. Facebook Lead Ads (via Zapier)" value={name} onChange={(e) => setName(e.target.value)} />
          <Select
            label="When a payload arrives"
            value={action}
            onChange={(e) => setAction(e.target.value as 'lead' | 'customer')}
            options={[
              { value: 'lead', label: ACTION_LABEL.lead },
              { value: 'customer', label: ACTION_LABEL.customer },
            ]}
          />
          <p className="text-[12px] text-ink-faint">Returning customers are matched by phone or email — the same rules as your website form.</p>
        </div>
      </Modal>
    </div>
  )
}
