'use client'

// API keys — create (shown once), revoke (undoable), delete. The plaintext
// key exists only in the create response; the list shows prefix + usage.

import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Plus, ShieldOff, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { formatDate } from '@/lib/utils'
import type { ApiKeyRow } from '@/types'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Toggle } from '@/components/ui/Toggle'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { CodeBlock } from './CodeBlock'

export function ApiKeysManager({ userId }: { userId: string }) {
  const supabase = createClient()
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [writeScope, setWriteScope] = useState(false)
  const [creating, setCreating] = useState(false)
  const [freshKey, setFreshKey] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from('api_keys')
      .select('id, created_at, user_id, name, prefix, scopes, last_used_at, usage_count, revoked_at')
      .eq('user_id', userId).order('created_at', { ascending: false })
    setKeys((data ?? []) as ApiKeyRow[])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  useEffect(() => { load() }, [load])

  const create = async () => {
    setCreating(true)
    try {
      const res = await fetch('/api/integrations/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || 'API key', scopes: writeScope ? ['read', 'write'] : ['read'] }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error ?? 'Could not create the key.')
        return
      }
      setFreshKey(json.key)
      setName('')
      setWriteScope(false)
      await load()
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (k: ApiKeyRow) => {
    const at = new Date().toISOString()
    const { error } = await supabase.from('api_keys').update({ revoked_at: at }).eq('id', k.id)
    if (error) {
      toast.error(error.message)
      return
    }
    await load()
    toast.undo(`${k.name} revoked — requests with it now fail.`, async () => {
      await supabase.from('api_keys').update({ revoked_at: null }).eq('id', k.id)
      await load()
    })
  }

  const remove = async (k: ApiKeyRow) => {
    const { error } = await supabase.from('api_keys').delete().eq('id', k.id)
    if (error) {
      toast.error(error.message)
      return
    }
    await load()
    toast.success(`${k.name} deleted.`)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-ink flex items-center gap-2"><KeyRound className="w-4 h-4 text-accent-text" /> API keys</h3>
            <p className="text-[12px] text-ink-muted mt-0.5">Authenticate requests to the REST API. Keys are shown once and stored hashed.</p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="w-3.5 h-3.5" /> New key</Button>
        </div>
      </CardHeader>
      <CardBody className="space-y-2">
        {keys === null ? <SkeletonRows count={2} /> : keys.length === 0 ? (
          <InlineEmpty icon={KeyRound}>No API keys yet. Create one to call the API or connect Zapier / Make.</InlineEmpty>
        ) : keys.map((k) => (
          <div key={k.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm text-ink">{k.name}</span>
                <code className="text-[11px] text-ink-faint font-mono">{k.prefix}…</code>
                {k.scopes.map((s) => <Badge key={s} tone={s === 'write' ? 'warn' : 'info'}>{s}</Badge>)}
                {k.revoked_at && <Badge tone="danger" icon={ShieldOff}>revoked</Badge>}
              </div>
              <div className="text-[11px] text-ink-faint mt-0.5 tabular-nums">
                Created {formatDate(k.created_at)}
                {k.last_used_at ? ` · last used ${formatDate(k.last_used_at)} · ${k.usage_count.toLocaleString()} requests` : ' · never used'}
              </div>
            </div>
            {!k.revoked_at ? (
              <Button variant="ghost" size="sm" onClick={() => revoke(k)}>Revoke</Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => remove(k)} aria-label="Delete key"><Trash2 className="w-3.5 h-3.5" /></Button>
            )}
          </div>
        ))}
      </CardBody>

      <Modal open={createOpen} onClose={() => { setCreateOpen(false); setFreshKey(null) }} title={freshKey ? 'Copy your key' : 'New API key'} icon={KeyRound} size="md"
        footer={freshKey ? (
          <Button onClick={() => { setCreateOpen(false); setFreshKey(null) }}>Done — I saved it</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={create} loading={creating}>Create key</Button>
          </>
        )}>
        {freshKey ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">This is the only time the full key is shown. Store it somewhere safe — we keep only a hash.</p>
            <CodeBlock code={freshKey} />
            <CodeBlock label="Try it" code={`curl ${typeof window !== 'undefined' ? window.location.origin : ''}/api/v1/me \\\n  -H "Authorization: Bearer ${freshKey}"`} />
          </div>
        ) : (
          <div className="space-y-4">
            <Input label="Name" placeholder="e.g. Zapier" value={name} onChange={(e) => setName(e.target.value)} />
            <Toggle checked={writeScope} onChange={setWriteScope} label="Allow writes (create customers, manage webhook subscriptions)" />
            <p className="text-[12px] text-ink-faint">Read scope covers customers, quotes, jobs, invoices and the event stream.</p>
          </div>
        )}
      </Modal>
    </Card>
  )
}
