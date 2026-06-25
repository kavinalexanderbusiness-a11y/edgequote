'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { format, parseISO, addDays, nextFriday } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { formatCurrency, cn, localTodayISO } from '@/lib/utils'
import {
  ChevronDown, MapPin, Receipt, CalendarClock, DollarSign,
  MessageSquare, Mail, Phone, Plus, Loader2, Check,
} from 'lucide-react'

// The CRM cockpit at the top of a conversation: an auto-generated activity timeline
// + a one-click info panel, all derived from EXISTING records (quotes/jobs/invoices/
// payments/property) — always up to date. Plus "Follow up", which creates a normal
// schedule item (the scheduler's own table) rather than a separate reminder system.
interface Props { customerId: string }

interface Qte { id: string; quote_number: string | null; status: string; total: number | null; created_at: string; issued_date: string | null; service_type: string | null }
interface Jb { id: string; status: string; scheduled_date: string; service_type: string | null; title: string | null; completed_at: string | null }
interface Inv { id: string; invoice_number: string | null; status: string; amount: number | null; created_at: string; issued_date: string | null; paid_at: string | null }
interface Pay { amount: number | null; paid_at: string | null }
interface Info {
  customer: { id: string; name: string; phone: string | null; email: string | null; sms_opt_in: boolean; email_opt_in: boolean } | null
  property: { address: string | null; city: string | null; lawn_sqft: number | null } | null
  quotes: Qte[]; jobs: Jb[]; invoices: Inv[]; payments: Pay[]
}

interface TLEvent { at: string; emoji: string; label: string }

const FOLLOWUPS: { key: string; label: string; type: string; title: string; when: (today: string) => string }[] = [
  { key: 'call_tmrw', label: 'Call tomorrow', type: 'callback', title: 'Call customer', when: t => format(addDays(parseISO(t + 'T00:00:00'), 1), 'yyyy-MM-dd') },
  { key: 'quote_fri', label: 'Send quote Friday', type: 'task', title: 'Send quote', when: t => format(nextFriday(parseISO(t + 'T00:00:00')), 'yyyy-MM-dd') },
  { key: 'checkin_wk', label: 'Check in next week', type: 'reminder', title: 'Check in with customer', when: t => format(addDays(parseISO(t + 'T00:00:00'), 7), 'yyyy-MM-dd') },
]

export function ConversationInfo({ customerId }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [info, setInfo] = useState<Info | null>(null)
  const [open, setOpen] = useState(false)
  const [followOpen, setFollowOpen] = useState(false)
  const [followDone, setFollowDone] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) return
      const [cu, pr, qu, jo, iv, pa] = await Promise.all([
        supabase.from('customers').select('id, name, phone, email, sms_opt_in, email_opt_in').eq('id', customerId).maybeSingle(),
        supabase.from('properties').select('address, city, lawn_sqft').eq('customer_id', customerId).order('is_primary', { ascending: false }).limit(1),
        supabase.from('quotes').select('id, quote_number, status, total, created_at, issued_date, service_type').eq('customer_id', customerId).order('created_at', { ascending: false }),
        supabase.from('jobs').select('id, status, scheduled_date, service_type, title, completed_at').eq('customer_id', customerId).neq('status', 'cancelled').order('scheduled_date', { ascending: false }),
        supabase.from('invoices').select('id, invoice_number, status, amount, created_at, issued_date, paid_at').eq('customer_id', customerId).order('created_at', { ascending: false }),
        supabase.from('payments').select('amount, paid_at').eq('customer_id', customerId).eq('status', 'paid'),
      ])
      if (!active) return
      setInfo({
        customer: cu.data as Info['customer'],
        property: (pr.data as Info['property'][])?.[0] ?? null,
        quotes: (qu.data as Qte[]) || [], jobs: (jo.data as Jb[]) || [],
        invoices: (iv.data as Inv[]) || [], payments: (pa.data as Pay[]) || [],
      })
    })()
    return () => { active = false }
  }, [customerId, supabase])

  const derived = useMemo(() => {
    if (!info) return null
    const today = localTodayISO()
    const ev: TLEvent[] = []
    for (const q of info.quotes) {
      ev.push({ at: q.issued_date || q.created_at, emoji: '📄', label: 'Quote sent' })
      if (q.status === 'accepted') ev.push({ at: q.issued_date || q.created_at, emoji: '✅', label: 'Quote accepted' })
    }
    for (const j of info.jobs) {
      if (j.completed_at || j.status === 'completed') ev.push({ at: j.completed_at || j.scheduled_date, emoji: '🌱', label: `${j.service_type || 'Service'} completed` })
      else if (j.scheduled_date >= today) ev.push({ at: j.scheduled_date, emoji: '📅', label: `${j.service_type || 'Visit'} scheduled` })
    }
    for (const i of info.invoices) {
      ev.push({ at: i.issued_date || i.created_at, emoji: '🧾', label: `Invoice ${i.invoice_number || ''}`.trim() })
      if (i.status === 'paid' && i.paid_at) ev.push({ at: i.paid_at, emoji: '💵', label: 'Invoice paid' })
    }
    const timeline = ev.filter(e => e.at).sort((a, b) => a.at.localeCompare(b.at)).slice(-8)

    const activeQuotes = info.quotes.filter(q => q.status === 'sent' || q.status === 'draft')
    const upcoming = info.jobs.filter(j => j.scheduled_date >= today && j.status !== 'completed').sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
    const completed = info.jobs.filter(j => j.completed_at || j.status === 'completed').sort((a, b) => (b.completed_at || b.scheduled_date).localeCompare(a.completed_at || a.scheduled_date))
    const unpaid = info.invoices.filter(i => i.status === 'unpaid' || i.status === 'sent')
    const lifetime = info.payments.reduce((s, p) => s + Number(p.amount || 0), 0)
    return {
      timeline, activeQuotes, nextVisit: upcoming[0] || null, lastService: completed[0] || null,
      unpaid, unpaidTotal: unpaid.reduce((s, i) => s + Number(i.amount || 0), 0), lifetime,
      openJobs: info.jobs.filter(j => j.status !== 'completed').length,
    }
  }, [info])

  async function addFollowUp(f: typeof FOLLOWUPS[number]) {
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) return
    setBusy(f.key)
    const date = f.when(localTodayISO())
    await supabase.from('schedule_items').insert({
      user_id: uid, type: f.type, title: f.title, customer_id: customerId,
      scheduled_date: date, status: 'scheduled',
      due_at: (f.type === 'reminder' || f.type === 'task') ? new Date(date + 'T09:00:00').toISOString() : null,
    })
    setBusy(null); setFollowDone(f.key); setFollowOpen(false)
    setTimeout(() => setFollowDone(null), 2500)
  }

  if (!info || !derived) return <div className="py-3 flex justify-center"><Loader2 className="w-3.5 h-3.5 animate-spin text-ink-faint" /></div>
  const c = info.customer

  return (
    <div className="border-b border-border pb-2 mb-2 space-y-2">
      {/* Auto activity timeline (from existing records) */}
      {derived.timeline.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1 -mb-1">
          {derived.timeline.map((e, i) => (
            <span key={i} className="shrink-0 inline-flex items-center gap-1 text-[11px] rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-ink-muted" title={e.label}>
              <span>{e.emoji}</span> <span className="font-medium text-ink">{e.label}</span>
              <span className="text-ink-faint">{(() => { try { return format(parseISO(e.at.slice(0, 10) + 'T00:00:00'), 'MMM d') } catch { return '' } })()}</span>
            </span>
          ))}
        </div>
      )}

      {/* Quick row: follow-up + key facts + expand */}
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <div className="relative">
          <button onClick={() => setFollowOpen(o => !o)} className="h-7 px-2.5 rounded-lg border border-accent/30 bg-accent/10 text-accent font-medium flex items-center gap-1 hover:bg-accent/20">
            {followDone ? <><Check className="w-3 h-3" /> Added</> : <><Plus className="w-3 h-3" /> Follow up</>}
          </button>
          {followOpen && (
            <div className="absolute left-0 top-8 z-20 w-44 rounded-xl border border-border bg-bg-secondary shadow-xl overflow-hidden py-1">
              {FOLLOWUPS.map(f => (
                <button key={f.key} onClick={() => addFollowUp(f)} disabled={busy === f.key}
                  className="w-full text-left px-3 py-2 text-xs text-ink hover:bg-surface/60 flex items-center gap-2 disabled:opacity-50">
                  {busy === f.key ? <Loader2 className="w-3 h-3 animate-spin" /> : <CalendarClock className="w-3 h-3 text-ink-faint" />} {f.label}
                </button>
              ))}
              <p className="px-3 pt-1 text-[10px] text-ink-faint border-t border-border mt-1">Creates a schedule item</p>
            </div>
          )}
        </div>
        {derived.lifetime > 0 && <Fact icon={DollarSign} text={`${formatCurrency(derived.lifetime)} lifetime`} />}
        {derived.nextVisit && <Fact icon={CalendarClock} text={`Next ${format(parseISO(derived.nextVisit.scheduled_date + 'T00:00:00'), 'MMM d')}`} />}
        {derived.unpaid.length > 0 && <Fact icon={Receipt} text={`${formatCurrency(derived.unpaidTotal)} owing`} tone="text-amber-400" />}
        <button onClick={() => setOpen(o => !o)} className="ml-auto text-ink-faint hover:text-ink flex items-center gap-1">
          Info <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', open && 'rotate-180')} />
        </button>
      </div>

      {/* Expandable info panel */}
      {open && (
        <div className="rounded-xl border border-border bg-bg-tertiary p-3 grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-[11px]">
          <Cell label="Customer"><Link href={`/dashboard/customers/${c?.id}`} className="text-accent hover:underline font-medium">{c?.name}</Link></Cell>
          {info.property?.address && <Cell label="Property"><span className="flex items-center gap-1 text-ink"><MapPin className="w-3 h-3 text-ink-faint" /> {info.property.address}</span></Cell>}
          <Cell label="Consent">
            <span className="flex items-center gap-2">
              <span className={cn('flex items-center gap-0.5', c?.sms_opt_in ? 'text-emerald-400' : 'text-ink-faint')}><MessageSquare className="w-3 h-3" /> SMS</span>
              <span className={cn('flex items-center gap-0.5', c?.email_opt_in ? 'text-emerald-400' : 'text-ink-faint')}><Mail className="w-3 h-3" /> Email</span>
            </span>
          </Cell>
          <Cell label="Active quotes">{derived.activeQuotes.length ? <Link href={`/dashboard/quotes`} className="text-accent hover:underline">{derived.activeQuotes.length} open</Link> : <span className="text-ink-faint">None</span>}</Cell>
          <Cell label="Open jobs">{derived.openJobs ? <span className="text-ink">{derived.openJobs}</span> : <span className="text-ink-faint">None</span>}</Cell>
          <Cell label="Invoices owing">{derived.unpaid.length ? <Link href="/dashboard/invoices" className="text-amber-400 hover:underline">{formatCurrency(derived.unpaidTotal)}</Link> : <span className="text-ink-faint">Paid up</span>}</Cell>
          <Cell label="Last service">{derived.lastService ? <span className="text-ink">{derived.lastService.service_type || 'Service'} · {format(parseISO((derived.lastService.completed_at || derived.lastService.scheduled_date).slice(0, 10) + 'T00:00:00'), 'MMM d')}</span> : <span className="text-ink-faint">—</span>}</Cell>
          <Cell label="Next visit">{derived.nextVisit ? <span className="text-ink">{format(parseISO(derived.nextVisit.scheduled_date + 'T00:00:00'), 'EEE, MMM d')}</span> : <span className="text-ink-faint">Not scheduled</span>}</Cell>
          <Cell label="Lifetime revenue"><span className="text-ink font-semibold">{formatCurrency(derived.lifetime)}</span></Cell>
          {c?.phone && <Cell label="Phone"><a href={`tel:${c.phone}`} className="text-ink flex items-center gap-1"><Phone className="w-3 h-3 text-ink-faint" /> {c.phone}</a></Cell>}
        </div>
      )}
    </div>
  )
}

function Fact({ icon: Icon, text, tone }: { icon: typeof DollarSign; text: string; tone?: string }) {
  return <span className={cn('inline-flex items-center gap-1 text-[11px] text-ink-muted', tone)}><Icon className="w-3 h-3" /> {text}</span>
}
function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[9px] uppercase tracking-wide text-ink-faint">{label}</p>
      <div className="truncate mt-0.5">{children}</div>
    </div>
  )
}
