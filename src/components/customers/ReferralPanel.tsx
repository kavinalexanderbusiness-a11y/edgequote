'use client'
import { toast } from '@/lib/toast'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { Customer, Referral } from '@/types'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Gift, Plus, Check, Trophy, ThumbsDown, Trash2, ExternalLink } from 'lucide-react'

const STATUS_META: Record<Referral['status'], { label: string; tone: string }> = {
  invited:  { label: 'Invited',  tone: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
  joined:   { label: 'Joined',   tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
  rewarded: { label: 'Rewarded', tone: 'text-accent-text border-accent/30 bg-accent/10' },
  declined: { label: 'Declined', tone: 'text-ink-faint border-border bg-bg-tertiary' },
}

// Per-customer referral tracker. The "joined" rows include relationships already
// captured via customers.referred_by_customer_id (bridged by a DB trigger in
// migration 2026-06-25h) — so this is the single place to see + manage who this
// customer brought in, with statuses and rewards. The referred person is linked
// by FK once they're a customer; never duplicated.
export function ReferralPanel({ customer, referrer, referredRevenue }: {
  customer: Customer
  referrer: { id: string; name: string } | null
  referredRevenue: number
}) {
  const supabase = useMemo(() => createClient(), [])
  const [uid, setUid] = useState<string | null>(null)
  const [rows, setRows] = useState<Referral[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ name: '', contact: '', reward: '' })

  async function load() {
    // Local session read — this panel renders on the customer profile; avoids a second
    // GoTrue round-trip in parallel with the page's own load.
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    setUid(user?.id || null)
    const { data } = await supabase.from('referrals').select('*').eq('referrer_customer_id', customer.id).order('created_at', { ascending: false })
    const list = (data as Referral[]) || []
    setRows(list)
    const ids = list.map(r => r.referred_customer_id).filter(Boolean) as string[]
    if (ids.length) {
      const { data: cs } = await supabase.from('customers').select('id, name').in('id', ids)
      const map: Record<string, string> = {}
      for (const c of (cs as { id: string; name: string }[]) || []) map[c.id] = c.name
      setNames(map)
    }
    setLoading(false)
  }
  useEffect(() => { load() }, [customer.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useRealtimeRefresh('referrals', `referrer_customer_id=eq.${customer.id}`, load)

  async function addReferral() {
    if (!form.name.trim() || !uid) return
    setBusy(true)
    const { error } = await supabase.from('referrals').insert({
      user_id: uid, referrer_customer_id: customer.id,
      referred_name: form.name.trim(),
      referred_contact: form.contact.trim() || null,
      reward: form.reward.trim() || null,
      status: 'invited',
    })
    setBusy(false)
    if (error) { toast.error('Could not save referral: ' + error.message); return }
    setForm({ name: '', contact: '', reward: '' }); setAdding(false); load()
  }

  async function patch(id: string, p: Partial<Referral>) {
    const { error } = await supabase.from('referrals').update(p).eq('id', id)
    if (error) { toast.error('Could not update: ' + error.message); return }
    load()
  }
  async function remove(id: string) {
    const { data: row } = await supabase.from('referrals').select('*').eq('id', id).maybeSingle()
    const { error } = await supabase.from('referrals').delete().eq('id', id)
    if (error) { toast.error('Could not remove: ' + error.message); return }
    load()
    if (row) toast.undo('Referral removed', async () => { await supabase.from('referrals').insert(row); load() })
  }

  const joined = rows.filter(r => r.status === 'joined' || r.status === 'rewarded').length
  const firstName = customer.name.split(' ')[0]

  return (
    <Card>
      <CardHeader className="flex items-center gap-2">
        <Gift className="w-4 h-4 text-accent-text" />
        <h2 className="text-sm font-semibold text-ink">Referrals</h2>
        <span className="ml-auto text-xs text-ink-muted">
          {joined} joined{referredRevenue > 0 ? <> · <span className="text-accent-text font-semibold">{formatCurrency(referredRevenue)}</span> generated</> : ''}
        </span>
      </CardHeader>
      <CardBody className="space-y-3">
        {/* "Referred by {name}" lives on the identity card at the top of the profile —
            repeating it here showed the same fact twice on one page. */}
        {loading ? (
          <div className="space-y-3 py-1" aria-hidden="true">
            {[0, 1].map(i => (
              <div key={i} className="flex items-start gap-3">
                <div className="min-w-0 flex-1"><Skeleton className="h-3.5 w-32" /><Skeleton className="h-2.5 w-44 mt-1.5" /></div>
                <Skeleton className="h-6 w-16" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <InlineEmpty icon={Gift}>No referrals tracked yet — record who {firstName} sends your way.</InlineEmpty>
        ) : (
          <ul className="divide-y divide-border -my-1">
            {rows.map(r => {
              const m = STATUS_META[r.status]
              const linkedName = r.referred_customer_id ? names[r.referred_customer_id] : null
              const who = linkedName || r.referred_name || 'Someone'
              return (
                <li key={r.id} className="py-2.5 flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {linkedName && r.referred_customer_id ? (
                        <Link href={`/dashboard/customers/${r.referred_customer_id}`} className="text-sm font-medium text-ink hover:text-accent-text flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                          {linkedName} <ExternalLink className="w-3 h-3 text-ink-faint" />
                        </Link>
                      ) : (
                        <span className="text-sm font-medium text-ink">{who}</span>
                      )}
                      <span className={`text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 border ${m.tone}`}>{m.label}</span>
                    </div>
                    <p className="text-xs text-ink-faint mt-0.5">
                      {[r.referred_contact, r.reward && `Reward: ${r.reward}`, r.joined_at && `joined ${formatDate(r.joined_at)}`].filter(Boolean).join(' · ') || `Added ${formatDate(r.created_at)}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    {r.status === 'invited' && (
                      <>
                        <button aria-label={`Mark ${who} as joined`} title="Mark joined" onClick={() => patch(r.id, { status: 'joined', joined_at: new Date().toISOString() })} className="p-2 rounded-lg text-ink-muted hover:text-emerald-400 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><Check className="w-4 h-4" /></button>
                        <button aria-label={`Mark ${who} as declined`} title="Mark declined" onClick={() => patch(r.id, { status: 'declined' })} className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><ThumbsDown className="w-4 h-4" /></button>
                      </>
                    )}
                    {r.status === 'joined' && (
                      <button aria-label={`Mark ${who} as rewarded`} title="Mark rewarded" onClick={() => patch(r.id, { status: 'rewarded', rewarded_at: new Date().toISOString() })} className="p-2 rounded-lg text-ink-muted hover:text-accent-text hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><Trophy className="w-4 h-4" /></button>
                    )}
                    <button aria-label={`Remove referral of ${who}`} title="Remove" onClick={() => remove(r.id)} className="p-2 rounded-lg text-ink-faint hover:text-red-400 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {adding ? (
          <div className="space-y-3 rounded-xl border border-border p-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="Referred name *" autoFocus value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Jane Smith" />
              <Input label="Phone or email" value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} placeholder="(403) 555-0100" />
            </div>
            <Input label="Reward" value={form.reward} onChange={e => setForm({ ...form, reward: e.target.value })} placeholder="e.g. “$25 credit”" />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={addReferral} loading={busy} disabled={!form.name.trim()}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setForm({ name: '', contact: '', reward: '' }) }}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}><Plus className="w-3.5 h-3.5" /> Record a referral</Button>
        )}
      </CardBody>
    </Card>
  )
}
