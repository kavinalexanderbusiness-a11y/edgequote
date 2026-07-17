'use client'
import { toast } from '@/lib/toast'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { Quote } from '@/types'
import type { ReachCustomer } from '@/lib/comms/reach'
import { QuoteList } from '@/components/quotes/QuoteList'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/layout/PageHeader'
import { Plus, AlertTriangle } from 'lucide-react'

export default function QuotesPage() {
  const [quotes, setQuotes] = useState<Quote[]>([])
  // Reach fields per customer id — lets the follow-up queue distinguish "chase this"
  // from "you have no way to chase this". Empty until loaded, which reads as
  // "no reason to think otherwise", never as "unreachable".
  const [reachById, setReachById] = useState<Record<string, ReachCustomer>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [uid, setUid] = useState<string | null>(null)

  const supabase = useMemo(() => createClient(), [])

  async function fetchQuotes() {
    // Local session read — no auth round-trip before the list query (RLS-scoped).
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (user) setUid(user.id)
    const [{ data, error }, custRes] = await Promise.all([
      supabase
        .from('quotes')
        .select('*')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false }),
      // Exactly the fields lib/comms/reach needs, so the follow-up queue can say
      // which chases are actually possible. Parallel — it never delays the list.
      supabase.from('customers').select('id, phone, email, sms_opt_in, email_opt_in, message_prefs').eq('user_id', user!.id),
    ])
    // A failed load must NEVER fall through to "No quotes yet" — telling an owner with
    // 200 quotes that they have none (and inviting them to start over) is a false
    // statement, not a missing reassurance.
    if (error) { setLoadError('Check your connection and try again — nothing has been lost.'); setLoading(false); return }
    setLoadError(null)
    // A failed customers read must not blank the queue's nudges — an empty map just
    // means the list behaves exactly as it did before reachability existed.
    const reach: Record<string, ReachCustomer> = {}
    for (const c of (custRes.data as (ReachCustomer & { id: string })[]) || []) reach[c.id] = c
    setReachById(reach)
    setQuotes(data || [])
    // Cache only the first screenful — enough for an instant revisit paint, without
    // JSON-serializing thousands of rows into sessionStorage on every fetch. The full
    // list arrives a beat later from the query above; realtime keeps it live.
    writeCache('quotes-list', (data || []).slice(0, 100))
    setLoading(false)
  }

  // Instant revisit: paint the cached list immediately (no skeleton), then revalidate in
  // the background — realtime (below) keeps it live. Reuses the shared clientCache SWR
  // module. The tab-return refetch is handled by useRealtimeRefresh (visibilitychange/online).
  useEffect(() => {
    const cached = readCache<Quote[]>('quotes-list', CACHE_TTL.short)
    if (cached) { setQuotes(cached); setLoading(false) }
    fetchQuotes()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Live: a quote accepted/scheduled/completed/deleted anywhere (portal, Stripe,
  // another tab) updates this list instantly — no refresh, no polling.
  useRealtimeRefresh('quotes', uid ? `user_id=eq.${uid}` : null, fetchQuotes)

  async function handleDelete(id: string) {
    const prev = quotes
    const { data: row } = await supabase.from('quotes').select('*').eq('id', id).maybeSingle()
    setQuotes(p => p.filter(q => q.id !== id))   // optimistic
    const { error } = await supabase.from('quotes').delete().eq('id', id)
    if (error) { setQuotes(prev); toast.error('Could not delete the quote: ' + error.message); return }
    if (row) {
      // Restore must OMIT the GENERATED columns (man_hours/subtotal/total) — re-inserting
      // them is rejected by Postgres, which would leave a dead "Undo" and lose the quote.
      const insertable = { ...(row as Record<string, unknown>) }
      delete insertable.man_hours; delete insertable.subtotal; delete insertable.total
      toast.undo('Quote deleted', async () => {
        const { error: rErr } = await supabase.from('quotes').insert(insertable)
        if (rErr) { toast.error('Could not restore the quote: ' + rErr.message); return }
        fetchQuotes()
      })
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Quotes"
        description={loading ? 'Loading your quotes…' : `${quotes.length} quote${quotes.length !== 1 ? 's' : ''} total`}
        action={
          <Link
            href="/dashboard/quotes/new"
            className="inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 bg-accent text-black hover:bg-accent-hover active:scale-[0.98] shadow-sm px-4 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <Plus className="w-4 h-4" /> New quote
          </Link>
        }
      />
      {loading ? (
        <SkeletonRows count={6} />
      ) : loadError && quotes.length === 0 ? (
        // Only when we have nothing real to show — a warm cache still beats an error.
        <EmptyState icon={AlertTriangle} title="Couldn't load your quotes" description={loadError}
          action={{ label: 'Retry', onClick: () => { setLoading(true); fetchQuotes() } }} />
      ) : (
        <QuoteList quotes={quotes} onDelete={handleDelete} reachById={reachById} />
      )}
    </div>
  )
}
