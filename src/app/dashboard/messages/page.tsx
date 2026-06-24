'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/layout/PageHeader'
import { ConversationThread } from '@/components/messages/ConversationThread'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { Loader2, Inbox, User, ArrowLeft, MessageSquare, FileText } from 'lucide-react'

interface Convo {
  id: string; customer_id: string; last_message_at: string; last_preview: string | null
  last_direction: string | null; unread: number
  customers: { id: string; name: string; phone: string | null } | null
}

const timeAgo = (iso: string) => { try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) } catch { return '' } }

export default function MessagesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [convos, setConvos] = useState<Convo[]>([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState<Convo | null>(null)

  async function load() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setLoading(false); return }
    const { data } = await supabase.from('conversations')
      .select('id, customer_id, last_message_at, last_preview, last_direction, unread, customers(id, name, phone)')
      .eq('user_id', user.id).order('last_message_at', { ascending: false })
    setConvos((data as unknown as Convo[]) || [])
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Realtime: a new inbound SMS bumps its conversation (preview / unread / order)
  // or creates a brand-new one — refresh the list live. RLS scopes the stream
  // to this owner's conversations.
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null
    let active = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || !active) return
      channel = supabase
        .channel(`conv-list:${user.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations', filter: `user_id=eq.${user.id}` }, () => load())
        .subscribe()
    })()
    return () => { active = false; if (channel) supabase.removeChannel(channel) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader title="Messages" description="Two-way SMS + portal conversations with your customers." />

      <div className="grid lg:grid-cols-[320px_1fr] gap-4" style={{ minHeight: '62vh' }}>
        {/* Conversation list */}
        <div className={cn('rounded-card border border-border bg-bg-secondary overflow-hidden', sel && 'hidden lg:block')}>
          {loading ? (
            <div className="py-16 flex items-center justify-center text-ink-muted"><Loader2 className="w-4 h-4 animate-spin" /></div>
          ) : convos.length === 0 ? (
            <div className="py-16 text-center px-4">
              <Inbox className="w-9 h-9 text-ink-faint mx-auto mb-2" />
              <p className="text-sm font-medium text-ink">No conversations yet</p>
              <p className="text-xs text-ink-muted mt-1">Inbound texts and portal requests will appear here.</p>
            </div>
          ) : (
            <div className="divide-y divide-border max-h-[72vh] overflow-y-auto">
              {convos.map(c => (
                <button key={c.id} onClick={() => setSel(c)}
                  className={cn('w-full text-left px-4 py-3 hover:bg-surface/40 transition-colors flex items-start gap-3', sel?.id === c.id && 'bg-accent/5')}>
                  <div className="w-9 h-9 rounded-full bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0 text-xs font-bold text-accent">
                    {(c.customers?.name || '?').slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-ink truncate flex-1">{c.customers?.name || 'Unknown'}</p>
                      {c.unread > 0 && <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-black text-[10px] font-bold flex items-center justify-center">{c.unread > 9 ? '9+' : c.unread}</span>}
                    </div>
                    <p className={cn('text-xs truncate mt-0.5', c.unread > 0 ? 'text-ink font-medium' : 'text-ink-muted')}>
                      {c.last_direction === 'internal' ? 'Note: ' : c.last_direction && c.last_direction !== 'inbound' ? 'You: ' : ''}{c.last_preview || '…'}
                    </p>
                    <p className="text-[10px] text-ink-faint mt-0.5">{timeAgo(c.last_message_at)}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Thread */}
        <div className={cn('rounded-card border border-border bg-bg-secondary p-4 flex-col', sel ? 'flex' : 'hidden lg:flex')}>
          {sel ? (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-border pb-2 mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <button className="lg:hidden text-ink-muted hover:text-ink" onClick={() => setSel(null)} aria-label="Back"><ArrowLeft className="w-4 h-4" /></button>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-ink truncate">{sel.customers?.name || 'Unknown'}</p>
                    {sel.customers?.phone && <p className="text-[11px] text-ink-faint">{sel.customers.phone}</p>}
                  </div>
                </div>
                {sel.customer_id && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Link href={`/dashboard/quotes/new?customer=${sel.customer_id}`}><Button size="sm" variant="secondary"><FileText className="w-3.5 h-3.5" /> Quote</Button></Link>
                    <Link href={`/dashboard/customers/${sel.customer_id}`}><Button size="sm" variant="ghost"><User className="w-3.5 h-3.5" /> Profile</Button></Link>
                  </div>
                )}
              </div>
              <div className="flex-1 min-h-0">
                <ConversationThread customerId={sel.customer_id} onRead={load} />
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-sm text-ink-muted py-16">
              <MessageSquare className="w-8 h-8 text-ink-faint mb-2" /> Select a conversation
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
