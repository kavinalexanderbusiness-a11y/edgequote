'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { cn, formatCurrency, localTodayISO } from '@/lib/utils'
import { Kbd } from '@/components/ui/Kbd'
import {
  Search, CornerDownLeft, ArrowUp, ArrowDown, Loader2, AlertTriangle, RotateCw,
  Users, FileText, Receipt, CalendarDays, MessageSquare, Navigation,
  Settings, LayoutDashboard, UserPlus, FilePlus2, ReceiptText, Send,
  Home, Eye, Phone, CalendarPlus, Sparkles, LifeBuoy, Store, BookOpen,
} from 'lucide-react'
import { useModules } from '@/hooks/useModules'
import { getPageCommands, subscribePageCommands, PageCommand } from '@/components/command/pageCommands'
import { phoneSearchDigits } from '@/lib/customers'
import {
  MIN_QUERY_LENGTH, SEARCH_LIMIT, toSearchRecords, KIND_LABEL,
  type SearchRow, type RecordKind,
} from '@/lib/globalSearch'
import type { FeeSettings } from '@/lib/invoiceTotals'

type Icon = typeof Users
interface Item { id: string; label: string; sub?: string; icon: Icon; run: () => void; kind?: RecordKind }
interface Section { title: string; items: Item[] }

// The record types the locator returns, and the icon each one wears. Kept beside
// KIND_LABEL so a row always says WHAT it is — a result you can't type-identify at
// a glance is a result you have to click to understand.
const KIND_ICONS: Record<RecordKind, Icon> = {
  customer: Users, property: Home, quote: FileText, invoice: Receipt, job: CalendarDays,
}

// ── Recents ───────────────────────────────────────────────────────────────────
// The empty palette used to look identical on visit 1 and visit 1,000 — a frequent
// user re-typed a customer's name every time to reach the same profile. Recents
// remembers the last few records you jumped to and offers them the instant ⌘K
// opens, turning a search box into a jump-list. localStorage-only: a nicety that
// must never throw (private mode / quota / another tab's garbage all fall back to
// "no recents"), and it stores only what the palette already shows — a label and a
// route, never anything sensitive the row didn't already display.
type RecentKind = 'customer' | 'property' | 'quote' | 'invoice'
interface RecentEntry { to: string; label: string; sub?: string; kind: RecentKind }
const RECENTS_KEY = 'eq:cmdk:recents'
const RECENTS_MAX = 6
const RECENT_KINDS: RecentKind[] = ['customer', 'property', 'quote', 'invoice']
const RECENT_ICONS: Record<RecentKind, Icon> = { customer: Users, property: Home, quote: FileText, invoice: Receipt }

function readRecents(): RecentEntry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter((r): r is RecentEntry =>
        !!r && typeof (r as RecentEntry).to === 'string' && typeof (r as RecentEntry).label === 'string'
        && ((r as RecentEntry).sub === undefined || typeof (r as RecentEntry).sub === 'string')
        && RECENT_KINDS.includes((r as RecentEntry).kind))
      .slice(0, RECENTS_MAX)
  } catch { return [] }
}

function pushRecent(e: RecentEntry) {
  try {
    // Most-recent-first, de-duplicated by route so re-visiting bumps instead of piling.
    const next = [e, ...readRecents().filter(x => x.to !== e.to)].slice(0, RECENTS_MAX)
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  } catch { /* private mode / quota — recents are a nicety, never load-bearing */ }
}

// Jump-to navigation (also filtered by the query).
// Module destinations come from THE feature-module registry (lib/modules) —
// same source and same per-business filtering as the sidebar, so the palette
// never disagrees with navigation. Only non-module destinations live here.
const EXTRA_NAV: { label: string; href: string; icon: Icon; keywords?: string }[] = [
  // Was "Marketplace" → /dashboard/marketplace: an app store for features that
  // are all included and all already on. It now points at the one surface that
  // manages them, named for what an owner would actually be after.
  { label: 'Turn features on or off', href: '/dashboard/settings#modules', icon: Store,
    keywords: 'modules marketplace features hide tidy menu install uninstall' },
  { label: 'API Docs', href: '/dashboard/integrations/docs', icon: BookOpen,
    keywords: 'developer rest webhook zapier make integrate' },
  { label: 'Routes', href: '/dashboard/routes', icon: Navigation, keywords: 'driving distance travel stops' },
  { label: 'Measurement Accuracy', href: '/dashboard/measurements', icon: Eye },
  { label: 'Help', href: '/dashboard/help', icon: LifeBuoy },
  { label: 'Settings', href: '/dashboard/settings', icon: Settings, keywords: 'services templates business pricing tax booking modules' },
]

// A leading verb turns the palette into a command: `call jane`, `text 5875550…`,
// `schedule`. Reuses the same customer index as search — no separate contacts store.
const VERB_RE = /^(call|phone|text|message|msg|sms|schedule|book)\b\s*(.*)$/i

// What the owner is told when the search never got an answer. Deliberately not a
// count and not the word "no": "No matches" is a FINDING — the book was read and
// holds nothing like this. A dropped connection is the absence of a finding, and
// saying the two the same way is how an owner concludes a record was deleted.
const FAILED_READ = 'Search didn’t finish — check your connection and try again.'

// Global command palette — universal search (customers, properties, quotes,
// invoices, jobs, messages, payments, photos, AI Vision) + quick actions + command
// verbs (call/message/schedule). Opens on Cmd/Ctrl+K or the `eq:command-open`
// event. Server-side ilike search scoped by user_id keeps it instant at scale.
export function CommandPalette() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const { visible: moduleNav } = useModules()
  const NAV = useMemo(
    // keywords ride along from THE registry, so typing an owner's word finds
    // the page: "jobs" or "visits" → Schedule, "payroll" → Workforce. Before this
    // the filter saw only the label, and "jobs" matched nothing at all.
    () => [...moduleNav.map(m => ({ label: m.label, href: m.href, icon: m.icon as Icon, keywords: m.keywords })), ...EXTRA_NAV],
    [moduleNav],
  )
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<Section[]>([])
  // A failed read is NOT an empty result. Null means "the search answered"; a
  // string means it never got to answer, and the UI must say so instead of
  // rendering the same "No matches" a genuinely empty book produces.
  const [error, setError] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)
  const [recents, setRecents] = useState<RecentEntry[]>([])
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)
  const reqRef = useRef(0)
  // Business fee/GST settings, needed by THE balance engine before an invoice
  // result may show money. Fetched once per session and cached — it changes about
  // once a year, and a search must not pay for it on every keystroke.
  const settingsRef = useRef<{ loaded: boolean; value: FeeSettings | null }>({ loaded: false, value: null })

  useEffect(() => { setMounted(true) }, [])

  const close = useCallback(() => { setOpen(false); setQ(''); setResults([]); setError(null); setSel(0) }, [])

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
  // Re-read on each open so a jump made in another tab (or last session) is current.
  useEffect(() => { if (open) setRecents(readRecents()) }, [open])

  const go = useCallback((href: string) => { close(); router.push(href) }, [close, router])
  const tel = useCallback((phone: string) => { close(); window.location.href = `tel:${phone.replace(/[^\d+]/g, '')}` }, [close])

  // Commands the CURRENT page registered (usePageCommands) — the palette grows
  // a "This page" section while such a page is mounted. Running one closes the
  // palette first, exactly like every other item.
  const [pageCmds, setPageCmds] = useState<PageCommand[]>(() => getPageCommands())
  useEffect(() => subscribePageCommands(() => setPageCmds(getPageCommands())), [])
  const pageSection = useCallback((query?: string): Section | null => {
    const ql = (query ?? '').toLowerCase()
    const items = pageCmds
      .filter(c => !ql || c.label.toLowerCase().includes(ql) || (c.keywords ?? '').toLowerCase().includes(ql))
      .map(c => ({ id: `pg-${c.id}`, label: c.label, sub: c.sub, icon: c.icon as Icon, run: () => { close(); c.run() } }))
    return items.length ? { title: 'This page', items } : null
  }, [pageCmds, close])

  // Quick actions + navigation when the box is empty.
  const baseSections = useMemo<Section[]>(() => [
    {
      title: 'Create',
      items: [
        { id: 'a-quote', label: 'New Quote', sub: 'Start a fresh quote', icon: FilePlus2, run: () => go('/dashboard/quotes/new') },
        { id: 'a-customer', label: 'New Customer', sub: 'Add a customer', icon: UserPlus, run: () => go('/dashboard/customers?new=1') },
        { id: 'a-job', label: 'Schedule a Job', sub: 'Open the calendar', icon: CalendarPlus, run: () => go('/dashboard/schedule') },
        { id: 'a-invoice', label: 'New Invoice', sub: 'Bill a customer directly', icon: ReceiptText, run: () => go('/dashboard/invoices?new=1') },
        { id: 'a-message', label: 'New Message', sub: 'Open the inbox', icon: Send, run: () => go('/dashboard/messages') },
        { id: 'a-studio', label: 'Marketing Studio', sub: 'AI posts from finished jobs', icon: Sparkles, run: () => go('/dashboard/grow/studio') },
      ],
    },
    { title: 'Go to', items: NAV.map(n => ({ id: `n-${n.href}`, label: n.label, icon: n.icon, keywords: n.keywords, run: () => go(n.href) })) },
  ], [go, NAV])
  const emptySections = useMemo<Section[]>(() => {
    const ps = pageSection()
    // Recent sits above Create/Go-to: on an empty box, "where I just was" beats
    // "what I could make". Hidden entirely until there's history to show.
    const recentSec: Section | null = recents.length
      ? { title: 'Recent', items: recents.map(r => ({ id: `r-${r.to}`, label: r.label, sub: r.sub, icon: RECENT_ICONS[r.kind], run: () => go(r.to) })) }
      : null
    return [ps, recentSec, ...baseSections].filter((s): s is Section => s !== null)
  }, [pageSection, baseSections, recents, go])

  // ── Debounced global search + command verbs ────────────────────────────────
  //
  // ONE request per settled query, and the newest answer always wins.
  //
  // THE RACE this is built to lose safely: type "Sarah", a slow request starts;
  // type " Brown", a fast request starts and returns; the "Sarah" request lands
  // afterwards. `reqRef` is bumped synchronously on every keystroke, so the stale
  // response finds its ticket number superseded and returns without touching a
  // single piece of state — not the results, not the spinner, not the error. The
  // AbortController on top of that stops the superseded request from finishing at
  // all, so it costs no bandwidth either; the ticket check remains the guarantee,
  // because an abort that loses its own race still must not paint.
  useEffect(() => {
    const query = q.trim()
    if (!query) { setResults([]); setError(null); setLoading(false); return }
    // Below the floor there is nothing worth asking the database — every record in
    // the book matches one character. Say so; don't spin, and don't call it empty.
    if (query.length < MIN_QUERY_LENGTH && !VERB_RE.test(query)) {
      setResults([]); setError(null); setLoading(false); return
    }
    setLoading(true)
    setError(null)
    const myReq = ++reqRef.current
    const ctrl = new AbortController()
    const handle = setTimeout(async () => {
      // Search-only dependency, loaded when someone actually searches: the full
      // help-article text is ~28 kB min that every dashboard page used to carry in
      // its layout bundle. The chunk fetches once (then cached) inside a path that
      // already awaits the session — same results, lighter every first paint.
      const { searchHelp, helpHref } = await import('@/lib/help/content')
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) { if (myReq === reqRef.current) setLoading(false); return }

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
        // "call 4038521443" has to find a number stored as 403-852-1443 — match the
        // canonical digits column, never the raw one (see phoneSearchDigits).
        const verbDigits = phoneSearchDigits(term)
        const verbOr = [`name.ilike.%${term}%`, verbDigits ? `phone_digits.ilike.%${verbDigits}%` : `phone.ilike.%${term}%`].join(',')
        const { data, error: verbErr } = await supabase.from('customers').select('id, name, phone')
          .eq('user_id', uid).is('archived_at', null)
          .or(verbOr).limit(8).abortSignal(ctrl.signal)
        if (myReq !== reqRef.current) return
        // A dropped read here used to become "no such customer", and the owner
        // concluded the number wasn't in the book.
        if (verbErr) { setError(FAILED_READ); setResults([]); setLoading(false); return }
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

      // ── The record locator ──
      // ONE call. It used to be nine parallel selects — customers, properties,
      // quotes, invoices, jobs, messages, payments, photos, AI vision — each with
      // its own copy of the tenant predicate and each with its error discarded by
      // `|| []`. Nine ways to half-fail and no way to say so.
      //
      // search_records does the finding AND the ranking server-side, scoped by
      // auth.uid(), which it reads itself and never accepts as an argument. It
      // returns records in one deterministic order: exact identifier, then exact
      // phone/email, then prefix, then partial. Rendering them as one ranked list
      // rather than per-type sections is the point — grouping by type would bury a
      // rank-0 invoice-number hit underneath every customer.
      const { data, error: rpcErr } = await supabase
        .rpc('search_records', { p_query: query, p_limit: SEARCH_LIMIT })
        .abortSignal(ctrl.signal)
      if (myReq !== reqRef.current) return   // a newer keystroke superseded this one

      if (rpcErr) {
        // The failure the whole session exists to prevent: a dropped read reported
        // as "No matches". "No matches" is an ANSWER — it means the book was read
        // and holds nothing like this. This is the absence of an answer, and it
        // gets a different sentence and a way to try again.
        setError(FAILED_READ); setResults([]); setSel(0); setLoading(false); return
      }

      // Fee/GST settings gate the money line on an invoice result. Fetched once,
      // and a failure is NOT fatal to the search — the records are still correct,
      // they just arrive without a balance rather than with a guessed one.
      if (!settingsRef.current.loaded) {
        const { data: s, error: sErr } = await supabase.from('business_settings')
          .select('payment_fee_strategy, fee_recovery_percent, gst_percent')
          .eq('user_id', uid).abortSignal(ctrl.signal).maybeSingle()
        if (myReq !== reqRef.current) return
        if (!sErr) settingsRef.current = { loaded: true, value: (s as FeeSettings) ?? {} }
      }

      const records = toSearchRecords((data as SearchRow[]) ?? [], {
        settings: settingsRef.current.value,
        todayISO: localTodayISO(),
        formatCurrency,
        settingsLoaded: settingsRef.current.loaded,
      })

      const sections: Section[] = []
      if (records.length) sections.push({
        title: 'Results',
        items: records.map(r => ({
          id: `${r.kind}-${r.id}`,
          label: r.label,
          sub: r.sub || undefined,
          icon: KIND_ICONS[r.kind],
          kind: r.kind,
          run: () => {
            if (RECENT_KINDS.includes(r.kind as RecentKind)) {
              pushRecent({ to: r.href, label: r.label, sub: r.sub || undefined, kind: r.kind as RecentKind })
            }
            go(r.href)
          },
        })),
      })

      // Not record search, but worth offering: the commands the CURRENT page
      // registered. Ranks below records — someone typing a customer's name wants
      // the customer. ("Go to" is filtered outside this effect; see navSection.)
      const ps = pageSection(query)
      if (ps) sections.push(ps)

      // ── Help ──
      // Last, and capped at 3: someone typing a customer's name wants the customer,
      // not an article that happens to mention "quote". But someone typing "why
      // didn't it send" has no record to find — only an answer — and this is the
      // one search box they'll try. Pure client-side (lib/help/content), so it costs
      // nothing and can't fail.
      const help = searchHelp(query).slice(0, 3)
      if (help.length) sections.push({
        title: 'Help', items: help.map(a => ({
          id: `h-${a.id}`, label: a.title, sub: a.summary, icon: LifeBuoy,
          run: () => go(helpHref(a.id)),
        })),
      })

      setResults(sections); setSel(0); setLoading(false)
    }, 180)
    // Clearing the timer cancels a query that never left; aborting cancels one
    // already in flight. Both matter: without the abort, holding a key down leaves
    // a queue of superseded requests competing with the one whose answer is wanted.
    return () => { clearTimeout(handle); ctrl.abort() }
  }, [q, supabase, go, tel, pageSection, retryTick])

  // "Go to" is a client-side filter over a list already in memory, so it belongs
  // OUTSIDE the search effect — and it has to be outside.
  //
  // useModules() rebuilds its `visible` array on every render, so NAV is a new
  // array on every render too. Naming it as a dependency of the debounced effect
  // made that effect re-run on every render: each run's cleanup aborted the
  // request the previous run had just started and restarted the 180ms timer, so
  // the search never fired at all and the palette sat on "No matches" forever.
  // Computing it here keeps the effect's dependencies stable and the two concerns
  // apart: one asks the server for records, this one filters a constant.
  const navSection = useMemo<Section | null>(() => {
    const ql = q.trim().toLowerCase()
    // Same floor as records. One letter matched ten destinations — "a" returned
    // Dashboard, Dispatch, Payments, Accounting, Messages, Automation — which
    // buried the "keep typing" hint under noise nobody asked for and made the
    // minimum query look like it wasn't there.
    if (ql.length < MIN_QUERY_LENGTH) return null
    const items = NAV.filter(n => n.label.toLowerCase().includes(ql))
      .map(n => ({ id: `n-${n.href}`, label: n.label, icon: n.icon as Icon, run: () => go(n.href) }))
    return items.length ? { title: 'Go to', items } : null
  }, [q, NAV, go])

  const sections = q.trim()
    ? (error ? results : [...results, ...(navSection ? [navSection] : [])])
    : emptySections
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
    <div className="fixed inset-0 z-menu flex items-start justify-center px-4 pt-[14vh] sm:pt-[12vh] animate-fade"
      onMouseDown={close}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />
      <div role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={e => e.stopPropagation()}
        className="relative w-full max-w-xl rounded-2xl border border-border bg-bg-secondary shadow-2xl overflow-hidden flex flex-col max-h-[70vh] animate-panel">
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
          {error ? (
            // Three states that used to render as one sentence now render as three.
            // This one says the search FAILED and offers the only useful next move.
            <div role="alert" className="py-8 px-6 text-center">
              <AlertTriangle className="w-5 h-5 mx-auto text-warning" aria-hidden />
              <p className="mt-2 text-xs text-ink">{error}</p>
              <button onClick={() => { setError(null); setRetryTick(t => t + 1) }}
                className="mt-3 inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-border bg-surface text-xs font-medium text-ink hover:border-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
                <RotateCw className="w-3.5 h-3.5" aria-hidden /> Try again
              </button>
            </div>
          ) : flat.length === 0 ? (
            <p className="py-10 text-center text-xs text-ink-muted">
              {!q.trim() ? 'Type to search — or a command like “call”, “text”, “schedule”.'
                : loading ? 'Searching…'
                // Under the floor this is not an empty result, it's an unasked
                // question — saying "no matches" would be a finding we never made.
                : q.trim().length < MIN_QUERY_LENGTH ? `Keep typing — ${MIN_QUERY_LENGTH} characters or more.`
                : 'No matches. Try a name, address, phone, or a quote/invoice number.'}
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
                      active ? 'bg-accent/10' : 'hover:bg-surface-raised')}>
                    <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border transition-colors',
                      active ? 'border-accent/30 bg-accent/10 text-accent-text' : 'border-border text-ink-muted')}>
                      <Icon className="w-3.5 h-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      {/* The type is stated, never inferred from an icon. One
                          ranked list means a Customer and an Invoice sit next to
                          each other, so the row has to say which it is. */}
                      {item.kind && (
                        <span className="block text-[10px] font-semibold uppercase tracking-wide text-ink-faint leading-tight">
                          {KIND_LABEL[item.kind]}
                        </span>
                      )}
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
          <span className="flex items-center gap-1"><Kbd>Esc</Kbd> close</span>
          <span className="ml-auto">Search &amp; commands</span>
        </div>
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}
