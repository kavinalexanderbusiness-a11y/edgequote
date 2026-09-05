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
import { cn, formatCurrency, formatDate, localTodayISO } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { dueSoonLabel, invoiceDepositNote, invoiceDepositPaidNote, invoicePaymentNote, messageAboutDoc, NO_PROPERTY, quoteJourney, showDocFilters, type DocItem, type DocKind } from '../model'
import {
  DocActions, Empty, InvoiceStatusPill, JourneyRail, PortalSection,
  QuoteStatusPill, StatCard, fmtMoney, type PortalActions, type TabProps,
} from './shared'
import { PaymentsSection } from './PaymentsSection'
import { ChangeBreakdown, PendingChangeCard } from './ChangesCard'
// The acceptance engine's own words, so the customer's screen and the owner's
// screen describe the same act identically (Session 121).
import { TERMS_ACK_LABEL, acceptBlockedLabel } from '@/lib/quoteAcceptance'

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

      {/* ── Changes to approved work ──
          THE canonical record of the three figures: what was originally
          approved, what has been approved since, and what is still only asked.
          It lives here, in the money surface, and NOT on the visit rows — a
          visit says work, the record says money (see VisitsTab's note). A
          pending ask keeps its real buttons here too, so a customer who came
          to Billing to check the numbers can answer without hunting for Home. */}
      {view.changesByJob.size > 0 && (
        <div className="animate-rise stagger-3">
          <PortalSection title="Changes to your work"
            sub="Extra work agreed after the original approval. Your original approval is unchanged.">
            <div className="space-y-3">
              {[...view.changesByJob.values()].map(v => {
                const job = view.data.jobs.find(j => j.id === v.jobId)
                return (
                  <div key={v.jobId} className="space-y-2">
                    <p className="text-xs font-semibold text-ink">
                      {job?.service_type || job?.title || 'Your work'}
                      {job ? <span className="text-ink-faint font-normal"> · {job.scheduled_date}</span> : null}
                    </p>
                    <ChangeBreakdown v={v} />
                    {v.pending.map(co => (
                      <PendingChangeCard key={co.id} co={co} originalTotal={v.original} actions={actions}
                        deciding={actions.decidingChangeId}
                        onDecide={(c, d) => { void actions.respondToChange(c.id, d) }} />
                    ))}
                  </div>
                )
              })}
            </div>
          </PortalSection>
        </div>
      )}

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

  // Finding tools for a list you can already see whole are just more to read. Six
  // controls (a count, a "showing" tally, three category pills, a search box and a
  // sort toggle) stood over lists that hold 2.2 documents on average — 45 of the 46
  // customers with a portal have five or fewer. Above the threshold they all come
  // back, untouched. The deep-link category filter still works either way: it sets
  // `cat` directly, so ?quote=/?invoice= lands filtered whether the pills render.
  const showFilters = showDocFilters(docs.length)

  return (
    <div className="space-y-3">
      {showFilters && (
        <>
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
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search quotes and invoices…" aria-label="Search quotes and invoices"
                className="w-full h-10 pl-9 pr-3 rounded-xl bg-bg-tertiary border border-border-strong text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
            </div>
            <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setSort(s => s === 'newest' ? 'oldest' : 'newest')}>
              <ArrowUpDown className="w-4 h-4 text-ink-muted" /> {sort === 'newest' ? 'Newest' : 'Oldest'}
            </Button>
          </div>
        </>
      )}

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
              {g.items.map(d => <DocRow key={d.id} d={d} actions={actions} termsText={view.data.business?.terms_text ?? null} focus={!!focusDocId && d.rawId === focusDocId} />)}
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">{filtered.map(d => <DocRow key={d.id} d={d} actions={actions} termsText={view.data.business?.terms_text ?? null} focus={!!focusDocId && d.rawId === focusDocId} />)}</div>
      )}
    </div>
  )
}

// ── One document row — behavior preserved wholly from the original, plus the
// journey rail on quote rows (model.quoteJourney: a DISPLAY of the stored
// status, never a second lifecycle engine; declined/expired answer null and
// get no rail — a rail promises forward motion those rows don't have). ───────

function DocRow({ d, actions, termsText, focus }: { d: DocItem; actions: PortalActions; termsText: string | null; focus?: boolean }) {
  const m = KIND_META[d.kind]
  // The one action each document actually needs, right on the row: a sent quote
  // can be accepted; an invoice with a balance can be paid.
  // `d.status` is the DISPLAY status, so an expired quote is not 'sent' and loses
  // its Accept button here without a second expiry test.
  const canAccept = d.kind === 'quote' && d.status === 'sent'
  // ── Alternatives ────────────────────────────────────────────────────────────
  const opts = d.options ?? []
  const hasOpts = opts.length > 0
  const chosen = d.selectedOptionId ? opts.find(o => o.id === d.selectedOptionId) ?? null : null
  // ⭐ NOTHING IS PRE-SELECTED, and the Recommended option is not an exception.
  // Approving is consent to a specific price, and a pre-ticked row turns "I read
  // three options and picked one" into "I tapped the big button" — the customer
  // would have agreed to a number chosen by the person selling it. The button
  // stays disabled, saying what to do, until they actually choose.
  const [picked, setPicked] = useState<string | null>(null)
  const pickedOpt = picked ? opts.find(o => o.id === picked) ?? null : null
  // A quote that offers alternatives is only approvable once one is named — the
  // same rule the database enforces (portal_accept_quote refuses an options quote
  // with no choice), stated here as a disabled button rather than a failed call.
  // ── The terms acknowledgement (Session 121) ────────────────────────────────
  // ⛔ NOT A SIGNATURE, and it must never grow into one — Sessions 74/83 own
  // those. It is a record that a specific block of text was shown and agreed to,
  // and the EXACT text is stored with the acceptance, because terms_text is a
  // single tenant-level field with no version: editing it in Settings tomorrow
  // would otherwise silently rewrite what every past customer appears to have
  // agreed to.
  //
  // Required exactly when the business HAS terms. Nothing to agree to is not the
  // same fact as agreeing to nothing, and the record distinguishes them.
  const needsTerms = !!(termsText ?? '').trim()
  const [termsAck, setTermsAck] = useState(false)
  const approveReady = (!hasOpts || !!pickedOpt) && (!needsTerms || termsAck)
  const isExpired = d.kind === 'quote' && d.status === 'expired'
  // `!actions.paymentPending`: while a just-completed checkout is still being
  // confirmed, this row's balance is the PRE-payment one and a second Pay tap
  // starts a second real charge. The confirming banner already says not to.
  const canPay = d.kind === 'invoice' && actions.paymentsEnabled && !actions.paymentPending && d.balance > 0 && d.status !== 'draft' && d.status !== 'cancelled'
  // The deposit ask (or null) — model-derived once, read by the headline AND the
  // Pay button's sub-line so the two can never quote different figures.
  const depAsk = invoiceDepositNote(d)
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
            {/* Not truncated: the title is what this document is FOR, and it is the
                only line on the row that says so. At 390px it clipped real invoices
                to "Weed removal dep…" — beside a $347.50 figure, that is a bill the
                customer cannot identify. Wrapping costs a line; clipping costs the
                answer. Kind, number and date beneath it are short and fixed. */}
            <p className="text-sm font-semibold text-ink tracking-tight">{d.title}</p>
            <p className="text-xs text-ink-muted">{m.label} · {d.number} · {formatDate(d.date)}</p>
            {/* When it's due — the row showed only the ISSUE date, so "am I late?" was
                unanswerable from the one screen built to answer it. Now a soon-due
                bill also says how soon (and raises its voice for today/tomorrow), so
                one due next week doesn't look the same as one due next month. */}
            {d.kind === 'invoice' && d.dueDate && d.balance > 0 && (() => {
              if (d.status === 'overdue') {
                return <p className="text-xs mt-0.5 text-red-400 font-medium">Was due {formatDate(d.dueDate)}</p>
              }
              const soon = dueSoonLabel(d.dueDate, localTodayISO())
              return (
                <p className={cn('text-xs mt-0.5', soon?.urgent ? 'text-amber-400 font-medium' : 'text-ink-muted')}>
                  Due {formatDate(d.dueDate)}{soon ? ` · ${soon.rel}` : ''}
                </p>
              )
            })()}
          </div>
        </div>
        <div className="text-right shrink-0">
          {/* On a partially-paid invoice the question is "what do I still owe?", so the
              BALANCE takes the headline and the total steps down to the sub-line. It
              used to be the other way round: the biggest, boldest, top-right number —
              exactly where the eye lands for "how much?" — was the one figure that
              wasn't the answer, with the real one at 11px beneath it. Same two values
              from the same verify-pinned helper; only which one shouts changed. */}
          {(() => {
            // A deposit ask OWNS the headline while it's what the Pay button
            // collects: the biggest number on the row must be the money wanted
            // NOW, with the total and the after-figure stepping down beside it —
            // never the reverse, where "$4,000" shouts over a $2,000 ask. All
            // four figures come off the DocItem the engine built; nothing here
            // does arithmetic.
            if (depAsk) return (
              <>
                <p className="text-sm font-bold text-amber-400 tabular-nums">{depAsk.dueNow}</p>
                <p className="text-[11px] text-ink-faint mt-0.5 tabular-nums">
                  {depAsk.percentLabel} of {depAsk.ofTotal} total · {depAsk.after} after{depAsk.paidSoFar ? ` · ${depAsk.paidSoFar} already paid` : ''}
                </p>
              </>
            )
            // Deposit satisfied, remainder open: say the deposit landed IN the
            // same breath as what's left — the post-payment pair the customer
            // came back to check ("Deposit paid: $2,000 · $2,000 remaining").
            const depPaid = invoiceDepositPaidNote(d)
            if (depPaid) return (
              <>
                <p className="text-sm font-bold text-amber-400 tabular-nums">{depPaid.remaining}</p>
                <p className="text-[11px] text-emerald-400 mt-0.5 tabular-nums flex items-center justify-end gap-1">
                  <Check className="w-3 h-3 shrink-0" aria-hidden /> Deposit paid · {depPaid.paid}
                </p>
                <p className="text-[11px] text-ink-faint mt-0.5 tabular-nums">remaining of {formatCurrency(d.amount)} total</p>
              </>
            )
            const pay = invoicePaymentNote(d)
            if (pay) return (
              <>
                <p className="text-sm font-bold text-amber-400 tabular-nums">{pay.due}</p>
                <p className="text-[11px] text-ink-faint mt-0.5 tabular-nums">still due · {formatCurrency(d.amount)} total, {pay.paid} paid</p>
              </>
            )
            // ⛔ A quote with an unmade choice has NO single price, and printing
            // one here — the biggest, boldest figure on the row — would assert
            // the recommended option as settled fact before the customer has read
            // the alternatives. Say how many there are; the prices belong beside
            // the names they buy, in the cards below.
            if (hasOpts && !chosen) return (
              <>
                <p className="text-sm font-bold text-ink">{opts.length} options</p>
                <p className="text-[11px] text-ink-faint mt-0.5">choose one below</p>
              </>
            )
            return (
              <>
                <p className="text-sm font-bold text-ink tabular-nums">{formatCurrency(d.amount)}</p>
                {d.amountNote ? <p className="text-[11px] text-ink-faint mt-0.5">{d.amountNote}</p> : null}
              </>
            )
          })()}
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
      {/* ── Choose one ────────────────────────────────────────────────────────
          ⭐ ALWAYS ONE COLUMN, at every width. Three desktop pricing cards
          squeezed side-by-side is how this pattern normally arrives on a phone,
          and at 375px it produces three 100px columns of clipped scope text —
          the exact information a customer needs to tell the options apart. A
          stacked list reads identically at 375, 390, 430 and on a desktop: name,
          price, what you get, in that order, one at a time.

          Restrained emphasis on Recommended: a hairline accent border and a small
          word. No colour-flooded "MOST POPULAR" banner, no crossed-out fake
          anchor price, no pre-tick, no countdown. The customer is choosing how to
          spend their own money and the honest job here is legibility. */}
      {hasOpts && (
        <div className="mt-3 pt-3 border-t border-border/60">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            {chosen ? 'What you chose' : 'Choose one option'}
          </p>
          <p className="text-[11px] text-ink-muted mt-0.5 mb-2">
            {chosen
              ? 'The other options are shown for your records — they weren’t ordered and won’t be charged.'
              : `${opts.length} versions of the same job. You pick one and pay for that one — they’re not added together.`}
          </p>
          <div className="space-y-2">
            {opts.map(o => {
              const isChosen = chosen?.id === o.id
              const notChosen = !!chosen && !isChosen
              const isPicked = !chosen && picked === o.id
              const selectable = canAccept && !chosen
              const Wrapper = selectable ? 'button' : 'div'
              return (
                <Wrapper
                  key={o.id}
                  {...(selectable
                    ? { type: 'button' as const, onClick: () => setPicked(o.id), 'aria-pressed': isPicked }
                    : {})}
                  className={cn(
                    'w-full text-left rounded-xl border p-3 transition-colors',
                    selectable && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                    isChosen ? 'border-emerald-500/40 bg-emerald-500/[0.07]'
                      : notChosen ? 'border-border bg-bg-tertiary/30 opacity-70'
                      : isPicked ? 'border-accent bg-accent/[0.08] ring-1 ring-accent/40'
                      : o.isRecommended ? 'border-accent/35 bg-accent/[0.03] hover:border-accent/60'
                      : 'border-border bg-bg-tertiary/40 hover:border-border-strong',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex items-start gap-2">
                      {selectable && (
                        // A real radio look, so "you are choosing ONE" is visible
                        // before anything is tapped rather than inferred after.
                        <span className={cn('mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center',
                          isPicked ? 'border-accent' : 'border-border-strong')} aria-hidden>
                          {isPicked && <span className="w-2 h-2 rounded-full bg-accent" />}
                        </span>
                      )}
                      {isChosen && <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" aria-hidden />}
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-ink">{o.name}</p>
                        {o.isRecommended && !chosen && (
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-accent-text">Recommended</span>
                        )}
                        {isChosen && (
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400">Your choice</span>
                        )}
                        {notChosen && (
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Not selected</span>
                        )}
                      </div>
                    </div>
                    <span className={cn('text-sm font-bold shrink-0 tabular-nums', notChosen ? 'text-ink-muted' : 'text-ink')}>
                      {formatCurrency(o.amount)}
                    </span>
                  </div>
                  {/* Not truncated: the scope text is the ONLY thing that explains
                      why one option costs more than another. Wrapping costs a
                      line; clipping costs the comparison. */}
                  {o.description && (
                    <p className="text-xs text-ink-muted mt-1.5 whitespace-pre-wrap leading-relaxed">{o.description}</p>
                  )}
                </Wrapper>
              )
            })}
          </div>
        </div>
      )}
      {/* The additive breakdown — these add up to the figure above. */}
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
      {/* Ongoing rates — a CHOICE between alternatives, not part of the total.
          These used to sit in the same unlabelled list as the breakdown above, so
          a $50 quote showed "$50" as its total and "Bi-weekly plan $50" beneath
          it, over rows that summed to $95. Same rows, but now they say what they
          are: a price list for later, one of which the customer picks with the
          owner. Deliberately NOT selectable — approving snapshots the quote
          total, never a cadence, and a tappable tile would promise otherwise. */}
      {d.planOptions && d.planOptions.length > 0 && (
        <div className="mt-3 pt-2.5 border-t border-border/60">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            If you’d like us back regularly
          </p>
          <p className="text-[11px] text-ink-muted mt-0.5 mb-1.5">
            Price per visit{d.planOptions.length > 1 ? ' — choose a schedule with us after you approve' : ' — set this up with us after you approve'}. Not included in the total above.
          </p>
          <div className="space-y-1">
            {d.planOptions.map((l, i) => (
              <div key={i} className="flex items-center justify-between gap-3 text-xs rounded-lg bg-bg-tertiary/50 px-2 py-1.5">
                <span className="text-ink-muted truncate">{l.label}</span>
                <span className="text-ink shrink-0 tabular-nums">{formatCurrency(l.amount)} <span className="text-ink-faint">/ visit</span></span>
              </div>
            ))}
          </div>
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
      {/* ── The scheduling deposit ─────────────────────────────────────────────
          Present only on an approved quote that requires one (model gates it).
          THE five states stay distinct here: the quote is APPROVED (pill above),
          the deposit is REQUIRED or RECEIVED (this panel — the ledger's answer,
          never a stored flag), the preferred date below is a REQUEST, and
          nothing says "scheduled" until a real visit exists. One obvious action:
          the outstanding figure and its Pay button, or the received check. */}
      {d.kind === 'quote' && d.schedulingDeposit && !d.schedulingDeposit.satisfied && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3.5 py-3">
          <p className="text-sm font-semibold text-ink flex items-center gap-1.5">
            <Wallet className="w-4 h-4 text-amber-400 shrink-0" />
            {/* ⛔ The figure only while its basis stands. On a superseded quote
                `outstanding` comes from the evidenced snapshot the sentence below
                has just disclaimed, so naming it here asserted an amount as owed
                on an authority the same card withdrew. Rule kept, figure dropped —
                and NOT re-derived from the current total, which would be the same
                substitution in the other direction. */}
            {d.schedulingDeposit.demandSettled
              ? `${formatCurrency(d.schedulingDeposit.outstanding)} deposit to secure scheduling`
              : 'Deposit to secure scheduling'}
          </p>
          {/* Partial honesty: what arrived, what's still required — a $1,000
              payment against $2,700 is progress, never satisfaction.
              ⚠️ What ARRIVED is always said. It is a ledger fact, not a demand
              derived from a stale basis, and dropping it with the ask would read
              as though the payment had vanished. Only the "of X — Y still
              required" half depends on a basis that may no longer stand. */}
          {d.schedulingDeposit.collected > 0 && (
            <p className="text-[11px] text-ink-muted mt-1 tabular-nums">
              {d.schedulingDeposit.demandSettled
                ? <>{formatCurrency(d.schedulingDeposit.collected)} of {formatCurrency(d.schedulingDeposit.required)} received — {formatCurrency(d.schedulingDeposit.outstanding)} still required.</>
                : <>{formatCurrency(d.schedulingDeposit.collected)} received so far — it stays on your account.</>}
            </p>
          )}
          {/* ⭐ The model's ONE gate-aware timing sentence. This panel used to
              write its own, which meant the quote card three inches above could
              promise "an invoice once the work is done" while this one asked for
              money now. Both strings now come out of lib/payments/paymentTiming. */}
          {/* Absent once the basis is unsettled — the model stops emitting it,
              because approvedTimingLine states the outstanding figure in words. */}
          {d.depositTimingLine && (
            <p className="text-[11px] text-ink-muted mt-1">
              Your quote is approved. {d.depositTimingLine}
            </p>
          )}
          {/* ⛔⛔ NO PAY BUTTON WITHOUT AN ACTOR-NAMED ACCEPTANCE. The charge route
              asks lib/quoteAcceptance the same question and refuses when nobody is
              named on the record, so rendering the button here would send this
              customer to a door we already know is shut. The deposit itself is
              still owed — the scheduling gate holds and an e-transfer still
              satisfies it — which is exactly what the sentence says. */}
          {!d.schedulingDeposit.payable ? (
            <p className="text-[11px] text-ink-muted mt-2">
              {d.depositBlockedLine}
            </p>
          ) : actions.paymentsEnabled && !actions.paymentPending ? (
            <>
              <Button className="w-full sm:w-auto mt-2.5"
                onClick={() => actions.payQuoteDeposit(d.rawId)}
                loading={actions.payingQuoteId === d.rawId}>
                <CreditCard className="w-4 h-4" /> Pay {formatCurrency(d.schedulingDeposit.outstanding)} deposit
              </Button>
              <p className="text-[11px] text-ink-faint mt-1.5 flex items-center gap-1">
                <ShieldCheck className="w-3 h-3 text-emerald-400 shrink-0" /> Secure checkout by Stripe — you&rsquo;ll confirm on the next screen.
              </p>
            </>
          ) : !actions.paymentPending && (
            // No online payments for this business — say how it actually works
            // instead of rendering a Pay button that can't. The owner records
            // e-transfer/cash through their ledger and this panel flips to
            // "received" the moment they do.
            <p className="text-[11px] text-ink-muted mt-2">
              Pay by e-transfer or cash — see <span className="font-medium text-ink">Ways to pay</span> below, or message us. We&rsquo;ll record it as soon as it arrives.
            </p>
          )}
        </div>
      )}
      {d.kind === 'quote' && d.schedulingDeposit?.satisfied && (
        <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] px-3.5 py-3">
          <p className="text-sm font-semibold text-emerald-400 flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 shrink-0" /> Deposit received — {formatCurrency(d.schedulingDeposit.collected)}
          </p>
          {/* Where the money WENT, not just that it arrived. recordDeposit holds
              the deposit as credit on the customer's account, so it comes off the
              final invoice — a customer who is only told "received" is left to
              wonder whether they have just paid above the quoted price. */}
          <p className="text-[11px] text-ink-muted mt-1">
            {d.status === 'scheduled'
              ? 'Your booking is secured — the visit is on your schedule.'
              : 'Ready to schedule — we’ll confirm the final date with you.'}{' '}
            It comes off your final invoice.
          </p>
        </div>
      )}
      {/* ── Preferred timing — a REQUEST, never a booking ─────────────────────
          Editable while the quote is 'accepted' (the RPC's own rule); once a
          real visit exists the schedule speaks and changes go through Messages.
          Deliberately available BEFORE the deposit is paid: telling us when
          suits them costs nothing and loses nothing if payment comes later. */}
      {d.kind === 'quote' && d.canEditPreference && (
        <PreferenceForm doc={d} actions={actions} />
      )}
      {d.kind === 'quote' && !d.canEditPreference && d.status === 'scheduled' && d.preference && (d.preference.date || d.preference.timing) && (
        <div className="mt-3 rounded-xl border border-border bg-bg-tertiary/40 px-3.5 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Your requested timing</p>
          <p className="text-xs text-ink-muted mt-1">
            {[
              d.preference.date ? formatDate(d.preference.date) : null,
              d.preference.date2 ? `or ${formatDate(d.preference.date2)}` : null,
              d.preference.timing === 'morning' ? 'mornings' : d.preference.timing === 'afternoon' ? 'afternoons' : null,
            ].filter(Boolean).join(' · ')}
          </p>
          <p className="text-[11px] text-ink-faint mt-1">Your visit is booked — check the schedule above. Need a different day? Send us a message below.</p>
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
              {/* The terms sit ABOVE the button, in full and scrollable — not
                  behind a link, and not summarised. The tick is the evidence, and
                  evidence of agreeing to something nobody could read on the way
                  past is not evidence of much. */}
              {needsTerms && (
                <div className="mb-3 rounded-xl border border-border bg-bg-tertiary/40 px-3.5 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Scope &amp; terms</p>
                  <p className="text-xs text-ink-muted whitespace-pre-wrap mt-1.5 max-h-40 overflow-y-auto">{termsText}</p>
                  <label className="flex items-start gap-2.5 mt-3 cursor-pointer min-h-[44px] items-center">
                    <input
                      type="checkbox"
                      checked={termsAck}
                      onChange={e => setTermsAck(e.target.checked)}
                      className="mt-0.5 w-4 h-4 accent-[var(--accent)] shrink-0"
                    />
                    <span className="text-xs text-ink">{TERMS_ACK_LABEL}</span>
                  </label>
                </div>
              )}
              {/* The button quotes the CHOSEN option's figure, which is the same
                  `option + travel` the approval RPC snapshots as accepted_price —
                  so what it says and what gets recorded are one number. Disabled
                  until a choice exists: the alternative is a button that names
                  somebody else's pick. */}
              <Button
                className="w-full sm:w-auto"
                disabled={!approveReady}
                onClick={() => actions.accept(d.rawId, picked ?? undefined, termsAck)}
                loading={actions.accepting === d.rawId}
              >
                <Check className="w-4 h-4" />
                {hasOpts
                  ? (pickedOpt ? `Accept ${pickedOpt.name} — ${formatCurrency(pickedOpt.amount)}` : 'Choose an option above')
                  : `Accept — ${formatCurrency(d.amount)}`}
              </Button>
              <p className="text-[11px] text-ink-faint mt-1.5">
                {hasOpts && !pickedOpt
                  ? 'Pick the option you want, then accept it.'
                  : needsTerms && !termsAck
                    ? acceptBlockedLabel('terms_not_acknowledged')
                    : 'You’ll confirm on the next step — we’ll then reach out to schedule.'}
              </p>
            </>
          )}
          {canPay && (
            <>
              {/* The button quotes payAmount — depositChargeAmount's answer, the
                  SAME engine call the pay route makes — so the figure on the
                  button and the figure on Stripe's checkout are one number by
                  construction. While a deposit is outstanding it says so
                  ("Pay $2,000 deposit"), and the sub-line finishes the story:
                  what remains, and that it isn't being charged today. */}
              <Button className="w-full sm:w-auto" onClick={() => actions.pay(d.rawId)} loading={actions.payingId === d.rawId}>
                <CreditCard className="w-4 h-4" /> Pay {formatCurrency(d.payAmount)}{d.payIsDeposit ? ' deposit' : ''}
              </Button>
              {depAsk && (
                <p className="text-[11px] text-ink-faint mt-1.5 tabular-nums">
                  This is the upfront deposit — the remaining {depAsk.after} is due after the work, not today.
                </p>
              )}
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

// ── Preferred-timing form ────────────────────────────────────────────────────
// A PREFERENCE, never self-booking — the copy says so twice and nothing here
// touches the schedule. Saves through the ONE token-scoped RPC; the echoed-back
// payload (a refetch inside savePreference) is the proof it kept, so the form
// seeds from what the server last held and "Saved" only follows a real write.
function PreferenceForm({ doc, actions }: { doc: DocItem; actions: PortalActions }) {
  const pref = doc.preference
  const today = localTodayISO()
  const [date, setDate] = useState(pref?.date ?? '')
  const [date2, setDate2] = useState(pref?.date2 ?? '')
  const [timing, setTiming] = useState<'morning' | 'afternoon' | ''>(
    pref?.timing === 'morning' || pref?.timing === 'afternoon' ? pref.timing : '')
  const [note, setNote] = useState(pref?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  // Open the editor only when there's nothing saved yet — a saved preference
  // shows as a quiet summary with an Edit affordance, not a form re-armed.
  const hasSaved = !!(pref?.date || pref?.timing || pref?.note)
  const [editing, setEditing] = useState(!hasSaved)

  async function submit() {
    setLocalError(null)
    // The server refuses past dates too (with a UTC-tolerant margin); this is
    // the friendly local check with the customer's own clock.
    if (date && date < today) { setLocalError('That first date is in the past — pick a day from today on.'); return }
    if (date2 && date2 < today) { setLocalError('That second date is in the past — pick a day from today on.'); return }
    if (date2 && !date) { setLocalError('Add your first-choice date before a second one.'); return }
    setBusy(true)
    const ok = await actions.savePreference(doc.rawId, {
      date: date || null, date2: date2 || null, timing: timing || null, note: note.trim() || null,
    })
    setBusy(false)
    if (ok) { setSaved(true); setEditing(false); setTimeout(() => setSaved(false), 4000) }
  }

  if (!editing) {
    return (
      <div className="mt-3 rounded-xl border border-border bg-bg-tertiary/40 px-3.5 py-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint flex items-center gap-1.5">
          Your preferred timing {saved && <span className="text-emerald-400 normal-case tracking-normal font-medium inline-flex items-center gap-1"><Check className="w-3 h-3" /> Saved</span>}
        </p>
        <p className="text-xs text-ink mt-1">
          {[
            pref?.date ? formatDate(pref.date) : null,
            pref?.date2 ? `or ${formatDate(pref.date2)}` : null,
            pref?.timing === 'morning' ? 'mornings' : pref?.timing === 'afternoon' ? 'afternoons' : null,
          ].filter(Boolean).join(' · ') || 'No preference given yet'}
        </p>
        {pref?.note && <p className="text-[11px] text-ink-muted mt-0.5 whitespace-pre-wrap">{pref.note}</p>}
        <p className="text-[11px] text-ink-faint mt-1">This is a request, not a booking — we&rsquo;ll confirm the final date with you.</p>
        <button type="button" onClick={() => setEditing(true)}
          className="mt-1.5 text-xs font-medium text-accent-text rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          Change preferred timing
        </button>
      </div>
    )
  }

  return (
    <div className="mt-3 rounded-xl border border-border bg-bg-tertiary/40 px-3.5 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">When would suit you?</p>
      <p className="text-[11px] text-ink-muted mt-0.5 mb-2.5">
        Optional — tell us your preferred timing and we&rsquo;ll aim for it. <span className="text-ink font-medium">We&rsquo;ll confirm the final date with you</span>; this doesn&rsquo;t book a visit by itself.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <label className="block">
          <span className="text-[11px] text-ink-muted">Preferred date</span>
          <input type="date" value={date} min={today} onChange={e => setDate(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-bg-secondary px-2.5 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 [color-scheme:dark]" />
        </label>
        <label className="block">
          <span className="text-[11px] text-ink-muted">Second choice <span className="text-ink-faint">(optional)</span></span>
          <input type="date" value={date2} min={date || today} onChange={e => setDate2(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-bg-secondary px-2.5 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 [color-scheme:dark]" />
        </label>
      </div>
      <div className="mt-2.5">
        <span className="text-[11px] text-ink-muted">Time of day</span>
        <div className="mt-1 grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Time of day preference">
          {([['', 'No preference'], ['morning', 'Morning'], ['afternoon', 'Afternoon']] as const).map(([v, label]) => (
            <button key={v || 'none'} type="button" role="radio" aria-checked={timing === v}
              onClick={() => setTiming(v)}
              className={cn('rounded-lg border px-2 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                timing === v ? 'border-accent bg-accent/[0.1] text-ink' : 'border-border bg-bg-secondary text-ink-muted hover:border-border-strong')}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <label className="block mt-2.5">
        <span className="text-[11px] text-ink-muted">Anything we should know? <span className="text-ink-faint">(optional)</span></span>
        <textarea value={note} maxLength={500} rows={2} onChange={e => setNote(e.target.value)}
          placeholder="e.g. any weekday after 1pm works"
          className="mt-1 w-full rounded-lg border border-border bg-bg-secondary px-2.5 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none" />
      </label>
      {localError && <p className="text-[11px] text-red-400 mt-1.5">{localError}</p>}
      <div className="mt-2.5 flex items-center gap-2">
        <Button size="sm" onClick={submit} loading={busy} disabled={busy}>
          <Check className="w-3.5 h-3.5" /> Save preference
        </Button>
        {hasSaved && (
          <button type="button" onClick={() => { setEditing(false); setLocalError(null) }}
            className="text-xs font-medium text-ink-muted rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
