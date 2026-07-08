'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { cn, formatCurrency } from '@/lib/utils'
import {
  Search, CornerDownLeft, ArrowUp, ArrowDown, Loader2,
  Users, FileText, Receipt, CalendarDays, MessageSquare, Navigation, Sprout,
  Settings, LayoutDashboard, UserPlus, FilePlus2, ReceiptText, Send,
  Home, Image as ImageIcon, CreditCard, Eye, Phone, CalendarPlus, Sparkles,
} from 'lucide-react'

type Icon = typeof Users
interface Item { id: string; label: string; sub?: string; icon: Icon; run: () => void }
interface Section { title: string; items: Item[] }

// Jump-to navigation (also filtered by the query).
const NAV: { label: string; href: string; icon: Icon }[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Schedule', href: '/dashboard/schedule', icon: CalendarDays },
  { label: 'Customers', href: '/dashboard/customers', icon: Users },
  { label: 'Properties', href: '/dashboard/properties', icon: Home },
  { label: 'Quotes', href: '/dashboard/quotes', icon: FileText },
  { label: 'Invoices', href: '/dashboard/invoices', icon: Receipt },
  { label: 'Messages', href: '/dashboard/messages', icon: MessageSquare },
  { label: 'Routes', href: '/dashboard/routes', icon: Navigation },
  { label: 'Grow', href: '/dashboard/grow', icon: Sprout },
  { label: 'AI Vision', href: '/dashboard/grow/vision', icon: Eye },
  { label: 'Settings', href: '/dashboard/settings', icon: Settings },
]

// A leading verb turns the palette into a command: `call jane`, `text 5875550…`,
// `schedule`. Reuses the same customer index as search — no separate contacts store.
const VERB_RE = /^(call|phone|text|message|msg|sms|schedule|book)\b\s*(.*)$/i

// Global command palette — universal search (customers, properties, quotes,
// invoices, jobs, messages, payments, photos, AI Vision) + quick actions + command
// verbs (call/message/schedule). Opens on Cmd/Ctrl+K or the `eq:command-open`
// event. Server-side ilike search scoped by user_id keeps it instant at scale.
export function CommandPalette() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<Section[]>([])
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)
  const reqRef = useRef(0)

  useEffect(() => { setMounted(true) }, [])

  const close = useCallback(() => { setOpen(false); setQ(''); setResults([]); setSel(0) }, [])

  // Open via Cmd/Ctrl+K (and a custom event the sidebar button dispatches).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); setOpen(o => !o)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('eq:command-open', onOpen)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('eq:command-open', onOpen) }
  }, [])

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 30) }, [open])

  const go = useCallback((href: string) => { close(); router.push(href) }, [close, router])
  const tel = useCallback((phone: string) => { close(); window.location.href = `tel:${phone.replace(/[^\d+]/g, '')}` }, [close])

  // Quick actions + navigation when the box is empty.
  const baseSections = useMemo<Section[]>(() => [
    {
      title: 'Create',
      items: [
        { id: 'a-quote', label: 'New Quote', sub: 'Start a fresh quote', icon: FilePlus2, run: () => go('/dashboard/quotes/new') },
        { id: 'a-customer', label: 'New Customer', sub: 'Add a customer', icon: UserPlus, run: () => go('/dashboard/customers?new=1') },
        { id: 'a-job', label: 'Schedule a Job', sub: 'Open the calendar', icon: CalendarPlus, run: () => go('/dashboard/schedule') },
        { id: 'a-invoice', label: 'New Invoice', sub: 'Open invoices', icon: ReceiptText, run: () => go('/dashboard/invoices') },
        { id: 'a-message', label: 'New Message', sub: 'Open the inbox', icon: Send, run: () => go('/dashboard/messages') },
        { id: 'a-studio', label: 'Marketing Studio', sub: 'AI posts from finished jobs', icon: Sparkles, run: () => go('/dashboard/grow/studio') },
      ],
    },
    { title: 'Go to', items: NAV.map(n => ({ id: `n-${n.href}`, label: n.label, icon: n.icon, run: () => go(n.href) })) },
  ], [go])

  // Debounced universal search + command verbs.
  useEffect(() => {
    const query = q.trim()
    if (!query) { setResults([]); setLoading(false); return }
    setLoading(true)
    const myReq = ++reqRef.current
    const handle = setTimeout(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) { setLoading(false); return }

      // ── Command verbs: call / text / schedule ──
      const verb = query.match(VERB_RE)
      if (verb) {
        const kind = verb[1].toLowerCase()
        if (kind === 'schedule' || kind === 'book') {
          if (myReq !== reqRef.current) return
          setResults([{ title: 'Command', items: [{ id: 'v-schedule', label: 'Schedule a job', sub: 'Open the calendar', icon: CalendarPlus, run: () => go('/dashboard/schedule') }] }])
          setSel(0); setLoading(false); return
        }
        const term = verb[2].replace(/[,()*%]/g, ' ').trim()
        const isCall = kind === 'call' || kind === 'phone'
        if (!term) { if (myReq === reqRef.current) { setResults([]); setLoading(false) }; return }
        const { data } = await supabase.from('customers').select('id, name, phone').eq('user_id', uid).is('archived_at', null)
          .or(`name.ilike.%${term}%,phone.ilike.%${term}%`).limit(8)
        if (myReq !== reqRef.current) return
        const rows = ((data as { id: string; name: string | null; phone: string | null }[]) || []).filter(r => !isCall || r.phone)
        setResults(rows.length ? [{
          title: isCall ? 'Call' : 'Message',
          items: rows.map(r => ({
            id: `v-${r.id}`, label: `${isCall ? 'Call' : 'Message'} ${r.name || 'Customer'}`, sub: r.phone || undefined,
            icon: isCall ? Phone : MessageSquare,
            run: isCall ? () => tel(r.phone || '') : () => go(`/dashboard/customers/${r.id}`),
          })),
        }] : [])
        setSel(0); setLoading(false); return
      }

      // ── Universal search ──
      const safe = query.replace(/[,()*%]/g, ' ').trim()
      if (!safe) { setLoading(false); return }
      const like = `%${safe}%`
      const amt = Number(safe.replace(/[^\d.]/g, ''))
      const payAmt = Number.isFinite(amt) && amt > 0 ? `,amount.eq.${amt}` : ''
      const [cust, prop, quo, inv, job, msg, pay, photo, vision] = await Promise.all([
        supabase.from('customers').select('id, name, phone, city, email').eq('user_id', uid).is('archived_at', null)
          .or(`name.ilike.${like},email.ilike.${like},phone.ilike.${like},address.ilike.${like},city.ilike.${like},notes.ilike.${like}`).limit(6),
        supabase.from('properties').select('id, address, city, neighborhood, customer_id').eq('user_id', uid)
          .or(`address.ilike.${like},city.ilike.${like},neighborhood.ilike.${like},postal_code.ilike.${like},notes.ilike.${like}`).limit(5),
        supabase.from('quotes').select('id, quote_number, customer_name, service_type, total, status').eq('user_id', uid)
          .or(`quote_number.ilike.${like},customer_name.ilike.${like},service_type.ilike.${like},address.ilike.${like}`).order('created_at', { ascending: false }).limit(6),
        supabase.from('invoices').select('id, invoice_number, customer_name, amount, status').eq('user_id', uid)
          .or(`invoice_number.ilike.${like},customer_name.ilike.${like},service_type.ilike.${like}`).order('created_at', { ascending: false }).limit(6),
        supabase.from('jobs').select('id, title, service_type, scheduled_date, status').eq('user_id', uid)
          .or(`title.ilike.${like},service_type.ilike.${like}`).order('scheduled_date', { ascending: false }).limit(5),
        supabase.from('messages').select('id, customer_id, body, created_at, customers(name)').eq('user_id', uid)
          .ilike('body', like).order('created_at', { ascending: false }).limit(5),
        supabase.from('payments').select('id, amount, customer_id, status, method, notes').eq('user_id', uid)
          .or(`notes.ilike.${like},method.ilike.${like},provider.ilike.${like}${payAmt}`).order('created_at', { ascending: false }).limit(4),
        supabase.from('job_photos').select('id, caption, kind, customer_id').eq('user_id', uid).ilike('caption', like).limit(4),
        supabase.from('property_intelligence').select('id, summary, customer_id, mowing_difficulty').eq('user_id', uid).ilike('summary', like).limit(4),
      ])
      if (myReq !== reqRef.current) return  // a newer keystroke superseded this one

      const sections: Section[] = []
      const ql = safe.toLowerCase()
      const nav = NAV.filter(n => n.label.toLowerCase().includes(ql))
        .map(n => ({ id: `n-${n.href}`, label: n.label, icon: n.icon as Icon, run: () => go(n.href) }))
      if (nav.length) sections.push({ title: 'Go to', items: nav })

      const cRows = (cust.data as { id: string; name: string; phone: string | null; city: string | null; email: string | null }[]) || []
      if (cRows.length) sections.push({ title: 'Customers', items: cRows.map(c => ({
        id: `c-${c.id}`, label: c.name || 'Unnamed', sub: [c.phone, c.city || c.email].filter(Boolean).join(' · ') || undefined,
        icon: Users, run: () => go(`/dashboard/customers/${c.id}`),
      })) })

      const pRows = (prop.data as { id: string; address: string | null; city: string | null; neighborhood: string | null; customer_id: string | null }[]) || []
      if (pRows.length) sections.push({ title: 'Properties', items: pRows.map(p => ({
        id: `p-${p.id}`, label: p.address || 'Property', sub: [p.neighborhood, p.city].filter(Boolean).join(' · ') || undefined,
        icon: Home, run: () => go(p.customer_id ? `/dashboard/customers/${p.customer_id}` : '/dashboard/properties'),
      })) })

      const qRows = (quo.data as { id: string; quote_number: string | null; customer_name: string | null; service_type: string | null; total: number | null; status: string }[]) || []
      if (qRows.length) sections.push({ title: 'Quotes', items: qRows.map(qq => ({
        id: `q-${qq.id}`, label: `${qq.quote_number || 'Quote'} · ${qq.customer_name || 'Customer'}`,
        sub: [qq.service_type, qq.total != null ? formatCurrency(Number(qq.total)) : null, qq.status].filter(Boolean).join(' · ') || undefined,
        icon: FileText, run: () => go(`/dashboard/quotes/${qq.id}`),
      })) })

      const iRows = (inv.data as { id: string; invoice_number: string | null; customer_name: string | null; amount: number | null; status: string }[]) || []
      if (iRows.length) sections.push({ title: 'Invoices', items: iRows.map(ii => ({
        id: `i-${ii.id}`, label: `${ii.invoice_number || 'Invoice'} · ${ii.customer_name || 'Customer'}`,
        sub: [ii.amount != null ? formatCurrency(Number(ii.amount)) : null, ii.status].filter(Boolean).join(' · ') || undefined,
        icon: Receipt, run: () => go('/dashboard/invoices'),
      })) })

      const jRows = (job.data as { id: string; title: string | null; service_type: string | null; scheduled_date: string | null; status: string }[]) || []
      if (jRows.length) sections.push({ title: 'Jobs', items: jRows.map(j => ({
        id: `j-${j.id}`, label: j.title || j.service_type || 'Job',
        sub: [j.scheduled_date, j.status].filter(Boolean).join(' · ') || undefined,
        icon: CalendarDays, run: () => go('/dashboard/schedule'),
      })) })

      const payRows = (pay.data as { id: string; amount: number | null; customer_id: string | null; status: string | null; method: string | null; notes: string | null }[]) || []
      if (payRows.length) sections.push({ title: 'Payments', items: payRows.map(p => ({
        id: `pay-${p.id}`, label: `${p.amount != null ? formatCurrency(Number(p.amount)) : 'Payment'}${p.status ? ` · ${p.status}` : ''}`,
        sub: [p.method, p.notes].filter(Boolean).join(' · ') || undefined,
        icon: CreditCard, run: () => go(p.customer_id ? `/dashboard/customers/${p.customer_id}` : '/dashboard/invoices'),
      })) })

      const phRows = (photo.data as { id: string; caption: string | null; kind: string | null; customer_id: string | null }[]) || []
      if (phRows.length) sections.push({ title: 'Photos', items: phRows.map(ph => ({
        id: `ph-${ph.id}`, label: ph.caption || 'Photo', sub: ph.kind || undefined,
        icon: ImageIcon, run: () => go(ph.customer_id ? `/dashboard/customers/${ph.customer_id}` : '/dashboard/grow/studio'),
      })) })

      const vRows = (vision.data as { id: string; summary: string | null; customer_id: string | null; mowing_difficulty: string | null }[]) || []
      if (vRows.length) sections.push({ title: 'AI Vision', items: vRows.map(v => ({
        id: `v-${v.id}`, label: (v.summary || 'Property analysis').slice(0, 60), sub: v.mowing_difficulty ? `Difficulty: ${v.mowing_difficulty}` : undefined,
        icon: Eye, run: () => go('/dashboard/grow/vision'),
      })) })

      // Supabase types the joined `customers` row as object-or-array depending on
      // the relationship inference — normalise to a single name either way.
      const mRows = (msg.data as unknown as { id: string; body: string | null; customers: { name: string | null } | { name: string | null }[] | null }[]) || []
      if (mRows.length) sections.push({ title: 'Messages', items: mRows.map(m => {
        const cname = Array.isArray(m.customers) ? m.customers[0]?.name : m.customers?.name
        return {
          id: `m-${m.id}`, label: cname || 'Conversation', sub: (m.body || '').slice(0, 70) || undefined,
          icon: MessageSquare, run: () => go('/dashboard/messages'),
        }
      }) })

      setResults(sections); setSel(0); setLoading(false)
    }, 180)
    return () => clearTimeout(handle)
  }, [q, supabase, go, tel])

  const sections = q.trim() ? results : baseSections
  const flat = useMemo(() => sections.flatMap(s => s.items), [sections])

  // Reset the highlight whenever the query changes so it never points past the
  // (possibly shorter) new result set; keep it clamped in range otherwise.
  useEffect(() => { setSel(0) }, [q])
  useEffect(() => { if (sel > flat.length - 1) setSel(flat.length ? flat.length - 1 : 0) }, [flat.length, sel])
  // Keep the keyboard-selected row visible in a long list.
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }) }, [sel])

  // Keyboard navigation over the flat item list.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close() }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, flat.length - 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
      else if (e.key === 'Enter') { e.preventDefault(); flat[sel]?.run() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, flat, sel, close])

  if (!mounted || !open) return null

  let idx = -1   // running index so each row knows its position in `flat`
  const overlay = (
    <div className="fixed inset-0 z-[200] flex items-start justify-center px-4 pt-[14vh] sm:pt-[12vh] motion-safe:animate-[fadeIn_120ms_ease-out]"
      onMouseDown={close}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />
      <div role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={e => e.stopPropagation()}
        className="relative w-full max-w-xl rounded-2xl border border-border bg-bg-secondary shadow-2xl overflow-hidden flex flex-col max-h-[70vh] motion-safe:animate-[popIn_140ms_ease-out]">
        <div className="flex items-center gap-2.5 px-4 border-b border-border shrink-0">
          <Search className="w-4 h-4 text-ink-faint shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search anything, or type a command (call, text, schedule)…"
            aria-label="Search or run a command"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="cmdk-list"
            aria-activedescendant={flat.length ? `cmdk-opt-${sel}` : undefined}
            className="flex-1 bg-transparent py-3.5 text-sm text-ink placeholder:text-ink-faint outline-none"
          />
          {loading && <Loader2 className="w-4 h-4 text-ink-faint animate-spin shrink-0" />}
        </div>

        <div id="cmdk-list" role="listbox" aria-label="Results" className="flex-1 overflow-y-auto overscroll-contain py-2">
          {flat.length === 0 ? (
            <p className="py-10 text-center text-xs text-ink-muted">
              {q.trim() ? (loading ? 'Searching…' : 'No matches. Try a name, address, quote #, or “call Jane”.') : 'Type to search — or a command like “call”, “text”, “schedule”.'}
            </p>
          ) : sections.map(section => (
            <div key={section.title} className="px-2 pb-1">
              <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{section.title}</p>
              {section.items.map(item => {
                idx++
                const active = idx === sel
                const Icon = item.icon
                const myIdx = idx
                return (
                  <button
                    key={item.id}
                    id={`cmdk-opt-${myIdx}`}
                    role="option"
                    aria-selected={active}
                    ref={active ? activeRef : undefined}
                    onMouseMove={() => setSel(myIdx)}
                    onClick={item.run}
                    className={cn('w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left transition-colors',
                      active ? 'bg-accent/10' : 'hover:bg-surface/50')}>
                    <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border transition-colors',
                      active ? 'border-accent/30 bg-accent/10 text-accent' : 'border-border text-ink-muted')}>
                      <Icon className="w-3.5 h-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-sm truncate', active ? 'text-ink font-medium' : 'text-ink')}>{item.label}</span>
                      {item.sub && <span className="block text-[11px] text-ink-faint truncate">{item.sub}</span>}
                    </span>
                    {active && <CornerDownLeft className="w-3.5 h-3.5 text-ink-faint shrink-0" />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <div className="hidden sm:flex items-center gap-3 px-4 py-2 border-t border-border text-[10px] text-ink-faint shrink-0">
          <span className="flex items-center gap-1"><ArrowUp className="w-3 h-3" /><ArrowDown className="w-3 h-3" /> navigate</span>
          <span className="flex items-center gap-1"><CornerDownLeft className="w-3 h-3" /> open</span>
          <span className="flex items-center gap-1"><kbd className="px-1 rounded bg-surface border border-border">Esc</kbd> close</span>
          <span className="ml-auto">Search &amp; commands</span>
        </div>
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}
