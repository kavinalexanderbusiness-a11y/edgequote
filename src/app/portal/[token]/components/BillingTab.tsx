'use client'

// Billing — money at a glance, then every record, then payment history.
// Presentational only: DocItems arrive PREBUILT on view.docItems (../model
// builds them once, with the load-bearing property-identity + expiry rules
// already applied); this tab only filters, sorts, groups and renders. Every
// money figure comes from view.money or the DocItem itself — never recomputed.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpDown, Check, CheckCircle2, Clock, CreditCard, FileText, FolderOpen,
  MapPin, MessageSquare, Receipt, Search, ShieldCheck, Wallet,
} from 'lucide-react'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { messageAboutDoc, NO_PROPERTY, quoteJourney, type DocItem, type DocKind } from '../model'
import {
  DocActions, Empty, InvoiceStatusPill, JourneyRail, PortalSection,
  QuoteStatusPill, StatCard, fmtMoney, type PortalActions, type TabProps,
} from './shared'
import { PaymentsSection } from './PaymentsSection'

const KIND_META: Record<DocKind, { label: string; icon: typeof FileText; tone: string }> = {
  quote: { label: 'Quote', icon: FileText, tone: 'text-accent-text border-accent/25 bg-accent/10' },
  invoice: { label: 'Invoice', icon: Receipt, tone: 'text-sky-400 border-sky-500/25 bg-sky-500/10' },
}

export function BillingTab({ view, actions, initialCat, focusDocId }: TabProps & { initialCat?: 'all' | 'quote' | 'invoice'; focusDocId?: string | null }) {
  const { money } = view
  const business = view.data.business
  const gstPct = Number(business?.gst_percent) || 0

  return (
    <div className="space-y-6">
      {/* ── Money strip — the three numbers a homeowner actually asks about. ──
          All from view.money (moneySummary sums the SAME per-invoice figures
          the rows show) — never a second GST/balance computation here. */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3 animate-rise stagger-1">
        <StatCard label="Billed to date" value={fmtMoney(money.invoiced)} icon={Receipt} />
        <StatCard label="You've paid" value={fmtMoney(money.paid)} icon={CheckCircle2} />
        {/* Balance due gets the amber accent only when there IS one — a $0
            balance is calm news and should look like it. */}
        {money.due > 0 ? (
          <div className="rounded-card border border-amber-500/30 bg-amber-500/[0.06] p-3">
            <div className="flex items-center gap-1.5 text-[11px] text-amber-400"><Wallet className="w-3.5 h-3.5" /> Balance due</div>
            <div className="text-lg font-bold text-ink mt-0.5 tabular-nums">{fmtMoney(money.due)}</div>
            {money.owingCount > 1 && <p className="text-[10px] text-ink-faint mt-0.5">across {money.owingCount} invoices</p>}
          </div>
        ) : (
          <StatCard label="Balance due" value={fmtMoney(money.due)} icon={Wallet} />
        )}
      </div>

      {/* ── Records hub — every quote and invoice, filterable. ── */}
      <div className="animate-rise stagger-2">
        <PortalSection title="Quotes & invoices" sub="Every record we've sent you, in one place.">
          <RecordsHub view={view} actions={actions} initialCat={initialCat} focusDocId={focusDocId} />
          {/* Trust footer — quiet facts that make paying feel safe. GST line only
              when the business both charges GST and registered a number. */}
          {((!!business?.gst_number && gstPct > 0) || !!business?.terms_text) && (
            <div className="pt-1 space-y-2">
              {!!business?.gst_number && gstPct > 0 && (
                <p className="text-[11px] text-ink-faint">GST registrant · {business.gst_number}</p>
              )}
              {!!business?.terms_text && (
                <details className="rounded-card border border-border bg-bg-secondary/40 px-3.5 py-2.5 group">
                  <summary className="text-xs font-medium text-ink-muted cursor-pointer select-none list-none flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-ink-faint" /> Service terms
                  </summary>
                  <p className="text-xs text-ink-muted whitespace-pre-wrap mt-2">{business.terms_text}</p>
                </details>
              )}
            </div>
          )}
        </PortalSection>
      </div>

      {/* ── Payment history + saved card (built in ./PaymentsSection). ── */}
      <div className="animate-rise stagger-3">
        <PaymentsSection view={view} actions={actions} />
      </div>
    </div>
  )
}

// ── The records hub: category pills + search + sort + property grouping ─────
// Behavior preserved verbatim from the original DocumentsTab — only the data
// source changed (prebuilt view.docItems instead of building here).

function RecordsHub({ view, actions, initialCat, focusDocId }: TabProps & { initialCat?: 'all' | DocKind; focusDocId?: string | null }) {
  // Pre-filtered entry (the Home signpost lands on quotes, the balance path on
  // invoices) — the customer arrives looking at what they came for.
  const [cat, setCat] = useState<'all' | DocKind>(initialCat ?? 'all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')

  const docs = view.docItems
  // THE property lookup for this tab. A row names its own property or it names
  // none — there is no "close enough" here, because the nearest wrong answer
  // (the primary) is exactly the bug the property-identity work fixed.
  const { propsById, properties } = view

  const counts = { all: docs.length, quote: docs.filter(d => d.kind === 'quote').length, invoice: docs.filter(d => d.kind === 'invoice').length }

  const filtered = useMemo(() => {
    const ql = query.trim().toLowerCase()
    let list = cat === 'all' ? docs : docs.filter(d => d.kind === cat)
    if (ql) list = list.filter(d =>
      d.number.toLowerCase().includes(ql) || d.title.toLowerCase().includes(ql) ||
      d.status.toLowerCase().includes(ql) || KIND_META[d.kind].label.toLowerCase().includes(ql) ||
      // A landlord searches the way they think: "Elm St", not "Q-1043". The
      // RESOLVED address, so what they type matches what the heading shows them.
      (d.address || '').toLowerCase().includes(ql))
    return [...list].sort((a, b) => sort === 'newest' ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date))
  }, [docs, cat, query, sort])

  // Address as an anchor only earns its space when there's a choice to make. One
  // property (most customers) means every heading would repeat the address they
  // gave us — so they keep the flat list, unchanged. Two or more, and the list groups.
  const grouped = properties.length > 1
  // Built FROM `filtered`, so cat/query/sort are applied once and grouping composes
  // with them instead of forking them. Group order follows `properties` (primary
  // first — the RPC's own ordering), with the unknown bucket trailing; a group with
  // nothing left in it after filtering doesn't render a heading over empty space.
  const groups = useMemo(() => {
    if (!grouped) return null
    const byKey = new Map<string, DocItem[]>()
    for (const d of filtered) {
      const key = d.propertyId && propsById.has(d.propertyId) ? d.propertyId : NO_PROPERTY
      const bucket = byKey.get(key)
      if (bucket) bucket.push(d); else byKey.set(key, [d])
    }
    const out = properties.filter(p => byKey.has(p.id)).map(p => ({
      key: p.id, label: p.address?.trim() || 'Property', isPrimary: !!p.is_primary, items: byKey.get(p.id)!,
    }))
    const rest = byKey.get(NO_PROPERTY)
    // Neutral and LAST: these documents are unfiled, not misfiled. Naming them
    // after an address we couldn't confirm is the one thing the property-identity
    // change exists to stop.
    if (rest) out.push({ key: NO_PROPERTY, label: 'Other documents', isPrimary: false, items: rest })
    return out
  }, [grouped, filtered, properties, propsById])

  const CATS: { key: 'all' | DocKind; label: string; n: number }[] = [
    { key: 'all', label: 'All', n: counts.all },
    { key: 'quote', label: 'Quotes', n: counts.quote },
    { key: 'invoice', label: 'Invoices', n: counts.invoice },
  ]

  return (
    <div className="space-y-3">
      {/* Count + category filters */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">{docs.length} document{docs.length === 1 ? '' : 's'}</p>
        <p className="text-xs text-ink-faint">Showing {filtered.length}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {CATS.map(c => (
          <button key={c.key} onClick={() => setCat(c.key)} type="button"
            className={cn('text-xs font-medium rounded-full px-3 py-1.5 border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
              cat === c.key ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
            {c.label}{c.n > 0 && <span className="opacity-70 tabular-nums"> {c.n}</span>}
          </button>
        ))}
      </div>

      {/* Search + sort */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search documents…" aria-label="Search documents"
            className="w-full h-10 pl-9 pr-3 rounded-xl bg-bg-tertiary border border-border-strong text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
        </div>
        <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setSort(s => s === 'newest' ? 'oldest' : 'newest')}>
          <ArrowUpDown className="w-4 h-4 text-ink-muted" /> {sort === 'newest' ? 'Newest' : 'Oldest'}
        </Button>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        docs.length === 0
          ? <Empty icon={FolderOpen} text="Quotes and invoices will appear here." />
          : <Empty icon={Search} text="No documents match your search." />
      ) : groups ? (
        <div className="space-y-5">
          {groups.map(g => (
            <div key={g.key} className="space-y-3">
              {/* The heading carries the address; the rows keep saying what they always
                  said. Service + date + status stay the disambiguators, because a
                  customer can hold two quotes on one property that differ by nothing
                  else — address alone would render them as identical twins. */}
              <div className="flex items-center gap-1.5 px-0.5">
                <MapPin className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                <p className="text-xs font-semibold text-ink tracking-tight truncate">{g.label}</p>
                {g.isPrimary && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border border-border text-ink-faint shrink-0">
                    Primary
                  </span>
                )}
                <span className="text-xs text-ink-faint tabular-nums ml-auto shrink-0">{g.items.length}</span>
              </div>
              {g.items.map(d => <DocRow key={d.id} d={d} actions={actions} focus={!!focusDocId && d.rawId === focusDocId} />)}
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">{filtered.map(d => <DocRow key={d.id} d={d} actions={actions} focus={!!focusDocId && d.rawId === focusDocId} />)}</div>
      )}
    </div>
  )
}

// ── One document row — behavior preserved wholly from the original, plus the
// journey rail on quote rows (model.quoteJourney: a DISPLAY of the stored
// status, never a second lifecycle engine; declined/expired answer null and
// get no rail — a rail promises forward motion those rows don't have). ───────

function DocRow({ d, actions, focus }: { d: DocItem; actions: PortalActions; focus?: boolean }) {
  const m = KIND_META[d.kind]
  // The one action each document actually needs, right on the row: a sent quote
  // can be accepted; an invoice with a balance can be paid.
  // `d.status` is the DISPLAY status, so an expired quote is not 'sent' and loses
  // its Accept button here without a second expiry test.
  const canAccept = d.kind === 'quote' && d.status === 'sent'
  const isExpired = d.kind === 'quote' && d.status === 'expired'
  const canPay = d.kind === 'invoice' && actions.paymentsEnabled && d.balance > 0 && d.status !== 'draft' && d.status !== 'cancelled'
  // Invoices get NO rail — an invoice's pill already says everything it can do.
  const steps = d.kind === 'quote' ? quoteJourney(d.status) : null
  // A deep link (?invoice=/?quote=) landed the customer here to look at THIS row —
  // scroll it into view and glow it once, so a long list doesn't dump them at the
  // top to hunt for the bill the text told them to pay. One-shot: it never
  // re-fires on a manual return to Billing (the parent clears the id).
  const rowRef = useRef<HTMLDivElement>(null)
  const [glow, setGlow] = useState(false)
  useEffect(() => {
    if (!focus) return
    rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setGlow(true)
    const t = setTimeout(() => setGlow(false), 2200)
    return () => clearTimeout(t)
  }, [focus])
  return (
    <div ref={rowRef} className={cn('rounded-card border bg-bg-secondary p-4 card-lift scroll-mt-24 transition-shadow duration-500',
      glow ? 'border-accent ring-2 ring-accent/40' : 'border-border')}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3 min-w-0">
          <div className={cn('w-9 h-9 rounded-lg border flex items-center justify-center shrink-0', m.tone)}><m.icon className="w-4 h-4" /></div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink truncate tracking-tight">{d.title}</p>
            <p className="text-xs text-ink-muted">{m.label} · {d.number} · {formatDate(d.date)}</p>
            {/* When it's due — the row showed only the ISSUE date, so "am I late?" was
                unanswerable from the one screen built to answer it. */}
            {d.kind === 'invoice' && d.dueDate && d.balance > 0 && (
              <p className={cn('text-xs mt-0.5', d.status === 'overdue' ? 'text-red-400 font-medium' : 'text-ink-muted')}>
                {d.status === 'overdue' ? `Was due ${formatDate(d.dueDate)}` : `Due ${formatDate(d.dueDate)}`}
              </p>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-bold text-ink tabular-nums">{formatCurrency(d.amount)}</p>
          {d.amountNote && <p className="text-[11px] text-ink-faint mt-0.5">{d.amountNote}</p>}
          {/* How long the price stands, said while it still does — the row already
              explains a LAPSED price; the live one deserves its date too. Only on
              quotes that carry one (expiry stamping began 2026-07; older quotes
              never lapse and get no line). */}
          {canAccept && d.validUntil && <p className="text-[11px] text-ink-faint mt-0.5">Valid until {formatDate(d.validUntil)}</p>}
          {d.kind === 'quote' ? <QuoteStatusPill status={d.status} /> : <InvoiceStatusPill status={d.status} />}
        </div>
      </div>
      {/* Where this quote is on its way to being done — direct display of the
          stored status, between the header and the price breakdown. */}
      {steps !== null && <JourneyRail steps={steps} />}
      {d.lines && d.lines.length > 0 && (
        <div className="mt-3 pt-2.5 border-t border-border/60 space-y-1">
          {d.lines.map((l, i) => (
            <div key={i} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-ink-muted truncate">{l.label}</span>
              <span className="text-ink shrink-0 tabular-nums">{formatCurrency(l.amount)}</span>
            </div>
          ))}
        </div>
      )}
      {/* What's behind the number. Shown on the quote the customer is deciding on — a
          price with no reasoning is the thing people call to argue about. */}
      {d.explain && d.explain.length > 0 && canAccept && (
        <div className="mt-3 pt-3 border-t border-border/60">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-1.5">What&rsquo;s behind this price</p>
          <ul className="space-y-1">
            {d.explain.map((line, i) => (
              <li key={i} className="text-xs text-ink-muted flex items-start gap-1.5">
                <Check className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" /> {line}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* An expired quote takes the Accept button's place — the customer is told plainly
          that the price no longer stands, rather than being left to tap a button that
          would commit them to a number we can't honour. No extension is offered here:
          whether to stand by an old price is the owner's call, made on their side. */}
      {isExpired && (
        <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-3 flex items-start gap-2">
          <Clock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-ink-muted">
            <span className="text-ink font-medium">This quote has expired.</span> Please contact us for an updated quote.
            {d.expiredOn ? <span className="text-ink-faint"> It was valid until {formatDate(d.expiredOn)}.</span> : null}
          </p>
        </div>
      )}
      {(canAccept || canPay) && (
        <div className="mt-3">
          {canAccept && (
            <>
              <Button className="w-full sm:w-auto" onClick={() => actions.accept(d.rawId)} loading={actions.accepting === d.rawId}><Check className="w-4 h-4" /> Approve — {formatCurrency(d.amount)}</Button>
              <p className="text-[11px] text-ink-faint mt-1.5">You&rsquo;ll confirm on the next step — we&rsquo;ll then reach out to schedule.</p>
            </>
          )}
          {canPay && (
            <>
              <Button className="w-full sm:w-auto" onClick={() => actions.pay(d.rawId)} loading={actions.payingId === d.rawId}><CreditCard className="w-4 h-4" /> Pay {formatCurrency(d.balance)}</Button>
              <p className="text-[11px] text-ink-faint mt-1.5 flex items-center gap-1"><ShieldCheck className="w-3 h-3 text-emerald-400 shrink-0" /> Secure checkout by Stripe — you&rsquo;ll confirm on the next screen.</p>
            </>
          )}
        </div>
      )}
      {/* Start a message ABOUT this exact document — the composer opens pre-filled
          with its number, so the customer doesn't have to describe which one and
          the owner knows immediately what the question is about. */}
      <button
        type="button"
        onClick={() => actions.askAbout(messageAboutDoc(m.label, d.number, d.title))}
        className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-accent-text rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <MessageSquare className="w-3.5 h-3.5" /> Question about this {m.label.toLowerCase()}?
      </button>
      <DocActions filename={d.filename} getBlob={d.getBlob} />
    </div>
  )
}
