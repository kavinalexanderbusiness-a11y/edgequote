'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { CHANNELS } from '@/lib/marketing/channels'
import { PROVIDERS } from '@/lib/marketing/providers'
import { listConnections, connectManual, disconnect, connectionsByPlatform } from '@/lib/marketing/connections'
import { cn } from '@/lib/utils'
import { Plus, X, Link2, Loader2, CheckCircle2, Clock } from 'lucide-react'
import type { MarketingChannel, SocialConnection } from '@/lib/marketing/types'

// Account connections — connect / disconnect / status. Manual (copy & paste) works for
// every platform today; direct API publishing lights up per-provider as integrations
// land (the provider abstraction is already in place).
export function ConnectionsManager({ userId }: { userId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [connections, setConnections] = useState<SocialConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState<MarketingChannel | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    listConnections(supabase, userId).then(c => { if (active) { setConnections(c); setLoading(false) } })
    return () => { active = false }
  }, [supabase, userId])

  const byPlatform = useMemo(() => connectionsByPlatform(connections), [connections])

  async function add(platform: MarketingChannel) {
    if (!name.trim() || busy) return
    setBusy(true); setErr(null)
    const created = await connectManual(supabase, userId, { platform, accountName: name, accountUrl: url })
    setBusy(false)
    if (created) { setConnections(prev => [...prev, created]); setAdding(null); setName(''); setUrl('') }
    else setErr('Couldn’t connect that account. Run the social-publishing migration if you haven’t.')
  }
  async function remove(c: SocialConnection) {
    await disconnect(supabase, c.id)
    setConnections(prev => prev.filter(x => x.id !== c.id))
  }

  if (loading) return <div className="h-32 flex items-center justify-center text-ink-faint"><Loader2 className="w-5 h-5 animate-spin" /></div>

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-muted">
        Connect the accounts you post to. Today everything publishes by <strong>copy &amp; paste</strong>; one-tap direct publishing turns on per platform as integrations land.
      </p>
      {err && <Banner tone="danger" onDismiss={() => setErr(null)}>{err}</Banner>}
      {CHANNELS.map(def => {
        const p = PROVIDERS[def.key]
        const accounts = byPlatform[def.key] || []
        const Icon = def.icon
        return (
          <div key={def.key} className="rounded-card border border-border bg-bg-secondary p-3">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-lg bg-surface border border-border flex items-center justify-center shrink-0"><Icon className="w-4 h-4 text-ink-muted" /></span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">{def.label}</p>
                <p className="text-[11px] text-ink-faint">
                  {p.apiStatus === 'unavailable'
                    ? 'No public posting API — copy & paste only'
                    : `Direct publishing via ${p.apiName} · coming soon`}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {p.apiStatus === 'planned' && (
                  <a href={`/api/marketing/connect/${def.key}`} className="text-[11px] text-accent hover:underline inline-flex items-center gap-1" title={`Connect via ${p.apiName}`}>
                    <Link2 className="w-3 h-3" /> Connect
                  </a>
                )}
                <Button size="sm" variant="secondary" onClick={() => { setAdding(adding === def.key ? null : def.key); setName(''); setUrl('') }}>
                  <Plus className="w-3.5 h-3.5" /> Add account
                </Button>
              </div>
            </div>

            {accounts.length > 0 && (
              <div className="mt-2.5 space-y-1.5">
                {accounts.map(a => (
                  <div key={a.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-ink truncate">{a.account_name}</p>
                      <p className="text-[10px] text-ink-faint">{a.mode === 'api' ? 'Connected · auto-publish' : 'Connected · copy & paste'}</p>
                    </div>
                    {a.account_url && <a href={a.account_url} target="_blank" rel="noreferrer" className="text-ink-faint hover:text-ink shrink-0"><Link2 className="w-3.5 h-3.5" /></a>}
                    <button onClick={() => remove(a)} className="text-ink-faint hover:text-red-400 shrink-0" title="Disconnect"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>
            )}

            {adding === def.key && (
              <div className="mt-2.5 space-y-2 rounded-lg border border-accent/30 bg-surface p-2.5">
                {p.apiStatus !== 'unavailable' && (
                  <p className="text-[11px] text-ink-faint inline-flex items-center gap-1"><Clock className="w-3 h-3" /> Direct {p.apiName} publishing is on the way — add the account now to schedule &amp; track; you’ll post by copy &amp; paste until then.</p>
                )}
                <input value={name} onChange={e => setName(e.target.value)} placeholder={`${def.label} account name (e.g. "${def.label} – your business")`}
                  className="w-full bg-bg-tertiary border border-border rounded-lg px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40" />
                <input value={url} onChange={e => setUrl(e.target.value)} placeholder="Profile/page URL (optional)"
                  className="w-full bg-bg-tertiary border border-border rounded-lg px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40" />
                <div className="flex gap-1.5">
                  <Button size="sm" onClick={() => add(def.key)} loading={busy} disabled={!name.trim()}>Connect</Button>
                  <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// A status chip reused by the panel + queue.
export function ConnStatusChip({ connection }: { connection: SocialConnection | null }) {
  if (!connection) return <span className="text-[11px] text-ink-faint">Manual · copy &amp; paste</span>
  return (
    <span className={cn('text-[11px] inline-flex items-center gap-1', connection.mode === 'api' ? 'text-emerald-400' : 'text-ink-muted')}>
      <CheckCircle2 className="w-3 h-3" /> {connection.account_name}
    </span>
  )
}
