'use client'

import {
  Document, Page, Text, View, Image, StyleSheet, pdf,
} from '@react-pdf/renderer'
import type { Quote, QuoteService, QuoteOption, QuoteAddon, BusinessSettings } from '@/types'
import { serviceLineTotals } from '@/lib/quoteServices'
import { activeOption, hasOptions, sortedOptions } from '@/lib/quoteOptions'
import {
  ADDONS_CUSTOMER_NOTE, addonsSubtotal, isAddonEditableStatus, selectedAddons, sortedAddons,
} from '@/lib/quoteAddons'
import { pdfLogoUrl } from '@/lib/photos'

const COLORS = {
  green: '#00C896',
  dark: '#0D1420',
  ink: '#1A2333',
  muted: '#6B7A90',
  faint: '#9AA7BB',
  line: '#E2E8F0',
  bgSoft: '#F6F9FC',
}

const styles = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 60, paddingHorizontal: 44, fontSize: 10, color: COLORS.ink, fontFamily: 'Helvetica' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 },
  logo: { width: 130, height: 70, objectFit: 'contain' },
  companyBlock: { textAlign: 'right', maxWidth: 240 },
  companyName: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: COLORS.dark },
  companyLine: { fontSize: 9, color: COLORS.muted, marginTop: 2 },

  quoteBar: { backgroundColor: COLORS.dark, borderRadius: 6, padding: 16, flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  quoteBarLabel: { fontSize: 8, color: COLORS.green, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 },
  quoteBarValue: { fontSize: 13, color: '#FFFFFF', fontFamily: 'Helvetica-Bold' },

  sectionTitle: { fontSize: 8, color: COLORS.green, textTransform: 'uppercase', letterSpacing: 1, fontFamily: 'Helvetica-Bold', marginBottom: 6 },
  twoCol: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  col: { width: '48%' },
  bodyText: { fontSize: 10, color: COLORS.ink, marginBottom: 2, lineHeight: 1.4 },
  muted: { fontSize: 9, color: COLORS.muted },

  table: { marginBottom: 8, borderWidth: 1, borderColor: COLORS.line, borderRadius: 6, overflow: 'hidden' },
  tableHead: { flexDirection: 'row', backgroundColor: COLORS.bgSoft, paddingVertical: 8, paddingHorizontal: 12 },
  tableRow: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: COLORS.line },
  th: { fontSize: 8, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: 'Helvetica-Bold' },
  td: { fontSize: 10, color: COLORS.ink },
  cellDesc: { width: '55%' },
  cellQty: { width: '20%', textAlign: 'right' },
  cellAmt: { width: '25%', textAlign: 'right' },

  totals: { marginTop: 12, marginLeft: 'auto', width: '50%' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  totalLabel: { fontSize: 10, color: COLORS.muted },
  totalValue: { fontSize: 10, color: COLORS.ink },
  grandRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: COLORS.dark },
  grandLabel: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: COLORS.dark },
  grandValue: { fontSize: 16, fontFamily: 'Helvetica-Bold', color: COLORS.green },

  notesBox: { marginTop: 24, backgroundColor: COLORS.bgSoft, borderRadius: 6, padding: 14 },
  termsBox: { marginTop: 18 },
  termsText: { fontSize: 8, color: COLORS.muted, lineHeight: 1.5 },

  footer: { position: 'absolute', bottom: 28, left: 44, right: 44, borderTopWidth: 1, borderTopColor: COLORS.line, paddingTop: 10, flexDirection: 'row', justifyContent: 'space-between' },
  footerText: { fontSize: 8, color: COLORS.faint },
  // Its own line BELOW the footer row — appending it as a third child of that
  // row would shift the right-hand footer text to the centre, on single-page
  // quotes too (the render returns '', so the slot still exists). Positioning
  // only; the type comes from styles.footerText.
  pageNumber: { position: 'absolute', bottom: 14, left: 44, right: 44, textAlign: 'right' },
})

function money(n: number) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

// What the CUSTOMER should read for each internal status (portal vocabulary).
const CUSTOMER_STATUS: Record<string, string> = {
  draft: 'Awaiting approval', sent: 'Awaiting approval',
  accepted: 'Approved', scheduled: 'Approved',
  completed: 'Completed', paid: 'Paid', declined: 'Declined',
}
function dateStr(s: string | null) {
  // Date-only strings must anchor to LOCAL midnight or the PDF prints yesterday.
  const d = s ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00' : s) : new Date()
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'long', day: 'numeric' }).format(d)
}
// Valid-until = issued date + N days, anchored the same way so the window reads honestly.
function dateStrPlusDays(s: string | null, days: number) {
  const d = s ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00' : s) : new Date()
  d.setDate(d.getDate() + days)
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'long', day: 'numeric' }).format(d)
}

interface QuotePDFProps {
  quote: Quote
  settings: BusinessSettings | null
  // Multi-service breakdown (quote_services rows). Empty/absent = legacy single
  // service; quote.initial_price already holds the summed net either way.
  services?: QuoteService[]
  // ── Alternatives (quote_options) ─────────────────────────────────────────
  // Present only on a quote that offers a choice, and MUTUALLY EXCLUSIVE with
  // `services` — the database refuses a quote holding both, because one kind of
  // row adds up and the other replaces. Which one the customer took is
  // quote.selected_option_id; before they choose it is null and the document
  // leads with the recommended one.
  options?: QuoteOption[]
  // ── Optional extras (quote_addons) ────────────────────────────────────────
  // ⭐ ADDITIVE, and additive with everything above: a quote may carry these
  // alongside `services` OR alongside `options`, because an extra never claims
  // to BE the price. Only the ticked ones are inside quote.total.
  addons?: QuoteAddon[]
}

export function QuoteDocument({ quote, settings, services, options, addons }: QuotePDFProps) {
  // ⭐ THE rule this document must never break: a page that shows three prices
  // must not print a number equal to their sum, and must not let the reader
  // construct one. So when options exist the line-item table is REPLACED (not
  // joined) by the alternatives table, no subtotal row spans them, and the grand
  // total names the single option it is the total OF.
  const opts = sortedOptions(options)
  const isOptionsQuote = hasOptions(opts)
  const chosen = quote.selected_option_id
    ? opts.find(o => o.id === quote.selected_option_id) ?? null
    : null
  // Before any choice this is the recommended option (else the first) — the same
  // answer the one engine gives every other surface, so the paper and the portal
  // cannot disagree about which price the quote currently stands at.
  const leading = activeOption(opts, quote.selected_option_id)
  // ⛔ NEVER fall back to quotes.subtotal. That column is `generated always as
  // (hours * crew_size * rate)` — the exact fabrication RUN-2026-07-16e ripped out
  // of quotes.total after it reached real customers ("When no price was entered,
  // the DATABASE made one up… Four rows priced this way; TWO are completed").
  // It was removed from `total` and left alive here. On the live book it disagrees
  // with initial_price on 84 of 93 quotes, and 61 quotes carry a NON-ZERO value for
  // it — so the day a quote has hours but no price, this line prints an invented
  // number on the customer's document. A priceless quote is worth 0 here, which is
  // what it already renders today and what the send gate (quoteStatus.sendBlockedReason
  // → 'no_price') already refuses to send.
  const initialPrice = Number(quote.initial_price ?? 0)
  // ── The optional extras ──────────────────────────────────────────────────
  // `addonsDecided` is the DB's own sentence for "can these still change" —
  // before that they are an offer, after it they are the record of what was
  // taken, and the paper has to say which it is printing.
  const addonRows = sortedAddons(addons)
  const hasAddons = addonRows.length > 0
  const addonsDecided = !isAddonEditableStatus(quote.status)
  const takenAddons = selectedAddons(addonRows)
  const hasMaintenance = !!(quote.weekly_price || quote.biweekly_price || quote.monthly_price)
  const lines = services && services.length ? services : null
  // The builder's toggle promises 'Travel rolled into total on PDF' — and this
  // document ignored it, itemizing travel whenever a fee existed. Rolled-in
  // travel now folds into the FIRST-VISIT line's displayed amount (the fee is
  // already inside quote.total, so every displayed row still sums to the grand
  // total); an itemized travel row renders only when the owner opted to show it.
  const travelFee = Number(quote.travel_fee) || 0
  const shownTravel = quote.show_travel_separately ? travelFee : 0
  const rolledTravel = quote.show_travel_separately ? 0 : travelFee
  const company = settings?.company_name || 'Your service provider'
  const contactLines = [
    settings?.phone,
    settings?.email_secondary || settings?.email_primary,
    settings?.website,
  ].filter(Boolean) as string[]

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        {/* Header */}
        <View style={styles.headerRow}>
          <View>
            {settings?.logo_url ? (
              // Logo size honours the Branding setting (logo_scale %, capped for layout).
              // src goes through pdfLogoUrl — see InvoicePDF: the raw upload is drawn
              // at thumbnail size but embedded whole.
              <Image src={pdfLogoUrl(settings.logo_url)} style={{
                ...styles.logo,
                width: Math.min(200, 130 * (((settings.logo_scale && settings.logo_scale >= 50 ? settings.logo_scale : 100)) / 100)),
                height: Math.min(105, 70 * (((settings.logo_scale && settings.logo_scale >= 50 ? settings.logo_scale : 100)) / 100)),
              }} />
            ) : (
              // No logo: the identity is carried once by the right companyBlock —
              // don't reprint the name here or it prints twice.
              null
            )}
          </View>
          <View style={styles.companyBlock}>
            <Text style={styles.companyName}>{company}</Text>
            {settings?.base_address ? <Text style={styles.companyLine}>{settings.base_address}</Text> : null}
            {settings?.phone ? <Text style={styles.companyLine}>{settings.phone}</Text> : null}
            {(settings?.email_secondary || settings?.email_primary) ? (
              <Text style={styles.companyLine}>{settings?.email_secondary || settings?.email_primary}</Text>
            ) : null}
            {settings?.website ? <Text style={styles.companyLine}>{settings.website}</Text> : null}
          </View>
        </View>

        {/* Quote bar */}
        <View style={styles.quoteBar}>
          <View>
            <Text style={styles.quoteBarLabel}>Quote Number</Text>
            <Text style={styles.quoteBarValue}>{quote.quote_number}</Text>
          </View>
          <View>
            <Text style={styles.quoteBarLabel}>Date Issued</Text>
            <Text style={styles.quoteBarValue}>{dateStr(quote.issued_date || quote.created_at)}</Text>
          </View>
          <View>
            <Text style={styles.quoteBarLabel}>Valid Until</Text>
            {/* quotes.valid_until is THE stamped promise (set on send, extended by
                the owner) — the PDF used to compute issued+30 regardless, so an
                EXTENDED quote's re-rendered document still printed the original
                lapse date: the paper contradicted the portal about when the price
                stops standing. issued+30 remains only as the fallback for a PDF
                rendered before first send stamps the real date (same 30-day
                default markSentPatch will write). */}
            <Text style={styles.quoteBarValue}>{quote.valid_until ? dateStr(quote.valid_until) : dateStrPlusDays(quote.issued_date || quote.created_at, 30)}</Text>
          </View>
          <View>
            <Text style={styles.quoteBarLabel}>Status</Text>
            {/* Customer-facing vocabulary — never internal statuses like "Draft"
                (the PDF renders BEFORE the draft→sent flip on send). */}
            <Text style={styles.quoteBarValue}>{CUSTOMER_STATUS[quote.status] ?? 'Awaiting approval'}</Text>
          </View>
        </View>

        {/* Bill to + service */}
        <View style={styles.twoCol}>
          <View style={styles.col}>
            <Text style={styles.sectionTitle}>Prepared For</Text>
            <Text style={[styles.bodyText, { fontFamily: 'Helvetica-Bold' }]}>{quote.customer_name}</Text>
            <Text style={styles.muted}>{quote.address}</Text>
          </View>
          <View style={styles.col}>
            <Text style={styles.sectionTitle}>{lines && lines.length > 1 ? 'Services' : 'Service'}</Text>
            <Text style={[styles.bodyText, { fontFamily: 'Helvetica-Bold' }]}>
              {lines && lines.length > 1 ? `${quote.service_type} + ${lines.length - 1} more` : quote.service_type}
            </Text>
            {/* Say it at the TOP, before any price is read. A customer who skims
                to the table needs to already know these are alternatives. */}
            {isOptionsQuote ? (
              <Text style={styles.muted}>
                {chosen ? `${opts.length} options offered · ${chosen.name} chosen` : `${opts.length} options — choose one`}
              </Text>
            ) : null}
            {/* Crew/hours live in the table's Details column — not repeated here. */}
          </View>
        </View>

        {/* ── Alternatives ──────────────────────────────────────────────────
            A quote offering options prints THIS instead of the line-item table.
            The heading has to do the work a customer would otherwise do wrong:
            "Choose One Option" and the sentence under it say, before any number
            is read, that these are alternatives and only one is payable. */}
        {isOptionsQuote ? (
          <>
            <Text style={styles.sectionTitle}>{chosen ? 'Options Offered' : 'Choose One Option'}</Text>
            <Text style={[styles.muted, { marginBottom: 6 }]}>
              {chosen
                ? `You chose ${chosen.name}. The other options are shown for your records — they were not ordered and are not charged.`
                : 'These are alternative versions of the same job. Pick the one you want — you pay for that option only, not for all of them.'}
            </Text>
            <View style={styles.table}>
              <View style={styles.tableHead} fixed>
                <Text style={[styles.th, styles.cellDesc]}>Option</Text>
                <Text style={[styles.th, styles.cellQty]}>{chosen ? 'Status' : ''}</Text>
                <Text style={[styles.th, styles.cellAmt]}>Price</Text>
              </View>
              {opts.map(o => {
                const isChosen = chosen?.id === o.id
                const notChosen = !!chosen && !isChosen
                // ⭐ Each row states the figure the customer actually pays for
                // THAT option: its price plus travel, which is exactly what
                // quote_apply_option_choice snapshots as accepted_price and
                // exactly what the portal's Approve button says.
                //
                // ⚠️ `travelFee`, NOT `rolledTravel`. An owner who ticked "show
                // travel separately" would otherwise get option rows at $5,400
                // on the paper against $5,550 on the portal button and $5,550 in
                // the record — three surfaces, three numbers, for one decision.
                // The itemisation preference still governs the ordinary quote
                // above; on an options quote a lone $150 row beside three all-in
                // prices only invites adding it a second time.
                const rowAmount = Number(o.price) + travelFee
                return (
                  <View key={o.id} style={styles.tableRow} wrap={false}>
                    <View style={styles.cellDesc}>
                      <Text style={[styles.td, isChosen ? { fontFamily: 'Helvetica-Bold' } : {}]}>
                        {o.name}{o.is_recommended ? '  ★ Recommended' : ''}
                      </Text>
                      {o.description ? <Text style={styles.muted}>{o.description}</Text> : null}
                      {travelFee > 0 ? <Text style={styles.muted}>Includes {money(travelFee)} travel</Text> : null}
                    </View>
                    <Text style={[styles.td, styles.cellQty, notChosen ? { color: COLORS.faint } : {}]}>
                      {isChosen ? 'Your choice' : notChosen ? 'Not selected' : ''}
                    </Text>
                    <Text style={[styles.td, styles.cellAmt, notChosen ? { color: COLORS.faint } : {}]}>
                      {money(rowAmount)}
                    </Text>
                  </View>
                )
              })}
            </View>
          </>
        ) : (
        <>
        {/* Line items */}
        <Text style={styles.sectionTitle}>Quote Details</Text>
        <View style={styles.table}>
          <View style={styles.tableHead} fixed>
            <Text style={[styles.th, styles.cellDesc]}>Description</Text>
            <Text style={[styles.th, styles.cellQty]}>Details</Text>
            <Text style={[styles.th, styles.cellAmt]}>Amount</Text>
          </View>
          {lines ? (
            // Multi-service: one row per line, net of its own discount (the same
            // engine math as the app; quote.total already sums these + travel).
            // Rolled-in travel rides on the PRIMARY row (sort_order 0) so the
            // displayed rows still sum to the grand total.
            lines.map(s => {
              const t = serviceLineTotals(s)
              const qtyLabel = Number(s.quantity) > 1 ? `${s.quantity} ${s.unit && s.unit !== 'each' ? s.unit + ' ' : ''}× ${money(s.unit_price)}` : s.sort_order === 0 ? `${quote.crew_size} crew · ${quote.hours} hrs` : '—'
              const amount = t.net + (s.sort_order === 0 ? rolledTravel : 0)
              return (
                <View key={s.id} style={styles.tableRow} wrap={false}>
                  <View style={styles.cellDesc}>
                    {/* Materials are labelled as what they are — a customer reading
                        "Mulch" with no qualifier can't tell supply from labour. */}
                    <Text style={styles.td}>{s.service_type}{s.kind === 'material' ? '  (materials)' : ''}</Text>
                    {s.notes ? <Text style={styles.muted}>{s.notes}</Text> : s.sort_order === 0 ? <Text style={styles.muted}>First visit{rolledTravel > 0 ? ' · includes travel' : ''}</Text> : null}
                    {t.discountAmount > 0 ? <Text style={styles.muted}>Includes {money(t.discountAmount)} discount</Text> : null}
                  </View>
                  <Text style={[styles.td, styles.cellQty]}>{qtyLabel}</Text>
                  <Text style={[styles.td, styles.cellAmt]}>{money(amount)}</Text>
                </View>
              )
            })
          ) : (
            <View style={styles.tableRow} wrap={false}>
              <View style={styles.cellDesc}>
                <Text style={styles.td}>{quote.service_type}</Text>
                <Text style={styles.muted}>First visit{rolledTravel > 0 ? ' · includes travel' : ''}</Text>
              </View>
              <Text style={[styles.td, styles.cellQty]}>{quote.crew_size} crew · {quote.hours} hrs</Text>
              <Text style={[styles.td, styles.cellAmt]}>{money(initialPrice + rolledTravel)}</Text>
            </View>
          )}
          {shownTravel > 0 ? (
            <View style={styles.tableRow} wrap={false}>
              <View style={styles.cellDesc}>
                <Text style={styles.td}>Travel Fee</Text>
                <Text style={styles.muted}>Travel to job site</Text>
              </View>
              <Text style={[styles.td, styles.cellQty]}>—</Text>
              <Text style={[styles.td, styles.cellAmt]}>{money(shownTravel)}</Text>
            </View>
          ) : null}
        </View>
        </>
        )}

        {/* ── Optional extras ────────────────────────────────────────────────
            Prints in ADDITION to whichever table is above — an extra adds to a
            line-item quote and adds to whichever option is chosen, so it cannot
            replace either. The heading and the sentence under it do the work a
            customer would otherwise do wrong, in both directions: before a
            decision, that ticking is theirs and nothing here is compulsory;
            after one, that the untaken rows were not ordered and not charged.
            ⛔ NO subtotal row for this table. The only figure that sums extras
            is the grand total, and it sums exactly the taken ones. */}
        {hasAddons ? (
          <>
            <Text style={styles.sectionTitle}>{addonsDecided ? 'Optional Extras Offered' : 'Optional Extras'}</Text>
            <Text style={[styles.muted, { marginBottom: 6 }]}>
              {addonsDecided
                ? takenAddons.length
                  ? 'The extras marked Included are part of the total below. The others were not ordered and are not charged.'
                  : 'None of these was taken, so none is charged. The total below is for the work above only.'
                : ADDONS_CUSTOMER_NOTE}
            </Text>
            <View style={styles.table}>
              <View style={styles.tableHead} fixed>
                <Text style={[styles.th, styles.cellDesc]}>Extra</Text>
                <Text style={[styles.th, styles.cellQty]}>{addonsDecided ? 'Status' : ''}</Text>
                <Text style={[styles.th, styles.cellAmt]}>Adds</Text>
              </View>
              {addonRows.map(a => {
                const taken = !!a.is_selected
                return (
                  <View key={a.id} style={styles.tableRow} wrap={false}>
                    <View style={styles.cellDesc}>
                      <Text style={[styles.td, taken ? { fontFamily: 'Helvetica-Bold' } : {}]}>{a.name}</Text>
                      {a.description ? <Text style={styles.muted}>{a.description}</Text> : null}
                    </View>
                    <Text style={[styles.td, styles.cellQty, !taken ? { color: COLORS.faint } : {}]}>
                      {addonsDecided ? (taken ? 'Included' : 'Not taken') : (taken ? 'Suggested' : '')}
                    </Text>
                    <Text style={[styles.td, styles.cellAmt, !taken ? { color: COLORS.faint } : {}]}>
                      + {money(Number(a.price))}
                    </Text>
                  </View>
                )
              })}
            </View>
          </>
        ) : null}

        {/* Totals — the subtotal row only earns its place when it differs from
            the single line above it (multi-service or a travel fee); otherwise a
            one-service quote printed the same number three rows in a row. */}
        <View style={styles.totals} wrap={false}>
          {/* Subtotal/travel rows only when they'd differ from the grand total —
              and only ITEMIZED travel appears here; rolled-in travel is already
              inside the line amounts above, so a subtotal excluding it would
              contradict the very rows it claims to sum. */}
          {/* ⛔ Suppressed entirely on an options quote. "Services subtotal" over a
              list of alternatives is the exact sentence that would make three
              prices read as parts of one — and `initialPrice` here is ONE option's
              price, so the row would also be arithmetic nobody could follow. */}
          {!isOptionsQuote && ((lines && lines.length > 1) || shownTravel > 0) ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>{lines && lines.length > 1 ? 'Services subtotal' : 'First visit'}</Text>
              <Text style={styles.totalValue}>{money(initialPrice + rolledTravel)}</Text>
            </View>
          ) : null}
          {shownTravel > 0 && !isOptionsQuote ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Travel Fee</Text>
              <Text style={styles.totalValue}>{money(shownTravel)}</Text>
            </View>
          ) : null}
          {/* ⭐ The ONE row that sums extras, and it sums exactly the taken ones —
              from the same engine the portal's Approve button and the approval
              RPC use. Absent when nothing was taken: a "$0 extras" row invites
              the reader to wonder which $0. */}
          {takenAddons.length > 0 ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>
                {takenAddons.length === 1 ? 'Optional extra' : `Optional extras (${takenAddons.length})`}
              </Text>
              <Text style={styles.totalValue}>{money(addonsSubtotal(addonRows))}</Text>
            </View>
          ) : null}
          <View style={styles.grandRow}>
            {/* "Quote Total" unless maintenance options follow — then "First Visit
                Total" is the honest headline. Never "invoice" on a quote.
                On an options quote the label NAMES the option it totals, so the
                one large green number on the page can never be read as "all of
                them": "Approved — Premium" after a choice, "If you choose
                Standard" before one. */}
            <Text style={styles.grandLabel}>
              {isOptionsQuote
                ? (chosen ? `Approved — ${chosen.name}` : leading ? `If you choose ${leading.name}` : 'Quote Total')
                : hasMaintenance ? 'First Visit Total' : 'Quote Total'}
            </Text>
            <Text style={styles.grandValue}>{money(quote.total)}</Text>
          </View>
          {/* Said in words directly beneath the only big number on the page. */}
          {isOptionsQuote && !chosen ? (
            <Text style={[styles.muted, { textAlign: 'right', marginTop: 3 }]}>
              One option only — the total depends on which you pick.
            </Text>
          ) : null}
          {Number(settings?.gst_percent) > 0 ? (
            // The invoice adds GST on top of this total — say so on the quote, or
            // the first bill looks like a bait-and-switch.
            <Text style={[styles.muted, { textAlign: 'right', marginTop: 3 }]}>
              Plus GST ({Number(settings?.gst_percent)}%) — added on your invoice
            </Text>
          ) : null}
          <Text style={[styles.muted, { textAlign: 'right', marginTop: 6 }]}>
            {isOptionsQuote && !chosen
              ? 'To pick your option and approve it, open the secure link in your email.'
              : 'To approve this quote, open the secure link in your email.'}
          </Text>
        </View>

        {/* Ongoing maintenance options */}
        {hasMaintenance ? (
          <View style={{ marginTop: 20 }}>
            <Text style={styles.sectionTitle}>Ongoing Maintenance Options</Text>
            <View style={styles.table}>
              <View style={styles.tableHead}>
                <Text style={[styles.th, styles.cellDesc]}>Plan</Text>
                <Text style={[styles.th, styles.cellQty]}>Frequency</Text>
                <Text style={[styles.th, styles.cellAmt]}>Amount</Text>
              </View>
              {quote.weekly_price ? (
                <View style={styles.tableRow} wrap={false}>
                  <Text style={[styles.td, styles.cellDesc]}>Weekly visit</Text>
                  <Text style={[styles.td, styles.cellQty]}>per visit</Text>
                  <Text style={[styles.td, styles.cellAmt]}>{money(quote.weekly_price)}</Text>
                </View>
              ) : null}
              {quote.biweekly_price ? (
                <View style={styles.tableRow} wrap={false}>
                  <Text style={[styles.td, styles.cellDesc]}>Bi-weekly visit</Text>
                  <Text style={[styles.td, styles.cellQty]}>per visit</Text>
                  <Text style={[styles.td, styles.cellAmt]}>{money(quote.biweekly_price)}</Text>
                </View>
              ) : null}
              {quote.monthly_price ? (
                <View style={styles.tableRow} wrap={false}>
                  <Text style={[styles.td, styles.cellDesc]}>Monthly visit</Text>
                  <Text style={[styles.td, styles.cellQty]}>per visit</Text>
                  <Text style={[styles.td, styles.cellAmt]}>{money(quote.monthly_price)}</Text>
                </View>
              ) : null}
            </View>
          </View>
        ) : null}

        {/* Notes */}
        {quote.notes ? (
          <View style={styles.notesBox}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={styles.bodyText}>{quote.notes}</Text>
          </View>
        ) : null}

        {/* Terms */}
        {settings?.terms_text ? (
          <View style={styles.termsBox}>
            <Text style={styles.sectionTitle}>Terms &amp; Conditions</Text>
            <Text style={styles.termsText}>{settings.terms_text}</Text>
          </View>
        ) : null}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>{company}{contactLines.length ? '  ·  ' + contactLines.join('  ·  ') : ''}</Text>
          <Text style={styles.footerText}>We look forward to working with you</Text>
        </View>

        {/* Only once the quote actually spans pages — "Page 1 of 1" on a
            single-page customer document is noise. */}
        <Text
          style={[styles.footerText, styles.pageNumber]}
          fixed
          render={({ pageNumber, totalPages }) => (totalPages > 1 ? `Page ${pageNumber} of ${totalPages}` : '')}
        />
      </Page>
    </Document>
  )
}

// Render the quote to a PDF blob. Imported dynamically by the caller so the
// heavy @react-pdf library only loads when the user actually opens a PDF.
export async function renderQuoteBlob(
  quote: Quote, settings: BusinessSettings | null, services?: QuoteService[], options?: QuoteOption[],
  addons?: QuoteAddon[],
): Promise<Blob> {
  return pdf(<QuoteDocument quote={quote} settings={settings} services={services} options={options} addons={addons} />).toBlob()
}