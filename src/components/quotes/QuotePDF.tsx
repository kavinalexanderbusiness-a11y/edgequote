'use client'

import {
  Document, Page, Text, View, Image, StyleSheet, pdf,
} from '@react-pdf/renderer'
import type { Quote, BusinessSettings } from '@/types'

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
})

function money(n: number) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)
}
function dateStr(s: string | null) {
  // Date-only strings must anchor to LOCAL midnight or the PDF prints yesterday.
  const d = s ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00' : s) : new Date()
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'long', day: 'numeric' }).format(d)
}

interface QuotePDFProps {
  quote: Quote
  settings: BusinessSettings | null
}

export function QuoteDocument({ quote, settings }: QuotePDFProps) {
  const initialPrice = quote.initial_price ?? quote.subtotal
  const hasMaintenance = !!(quote.weekly_price || quote.biweekly_price || quote.monthly_price)
  const company = settings?.company_name || 'Edge Property Services'
  const contactLines = [
    settings?.phone,
    settings?.email_secondary || settings?.email_primary,
    settings?.website,
  ].filter(Boolean) as string[]

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.headerRow}>
          <View>
            {settings?.logo_url ? (
              // Logo size honours the Branding setting (logo_scale %, capped for layout).
              <Image src={settings.logo_url} style={{
                ...styles.logo,
                width: Math.min(200, 130 * (((settings.logo_scale && settings.logo_scale >= 50 ? settings.logo_scale : 100)) / 100)),
                height: Math.min(105, 70 * (((settings.logo_scale && settings.logo_scale >= 50 ? settings.logo_scale : 100)) / 100)),
              }} />
            ) : (
              <Text style={styles.companyName}>{company}</Text>
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
            <Text style={styles.quoteBarLabel}>Status</Text>
            <Text style={styles.quoteBarValue}>{quote.status.charAt(0).toUpperCase() + quote.status.slice(1)}</Text>
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
            <Text style={styles.sectionTitle}>Service</Text>
            <Text style={[styles.bodyText, { fontFamily: 'Helvetica-Bold' }]}>{quote.service_type}</Text>
            <Text style={styles.muted}>Crew of {quote.crew_size} · {quote.hours} hrs estimated</Text>
          </View>
        </View>

        {/* Line items */}
        <Text style={styles.sectionTitle}>Quote Details</Text>
        <View style={styles.table}>
          <View style={styles.tableHead}>
            <Text style={[styles.th, styles.cellDesc]}>Description</Text>
            <Text style={[styles.th, styles.cellQty]}>Details</Text>
            <Text style={[styles.th, styles.cellAmt]}>Amount</Text>
          </View>
          <View style={styles.tableRow}>
            <View style={styles.cellDesc}>
              <Text style={styles.td}>{quote.service_type}</Text>
              <Text style={styles.muted}>Initial / first visit</Text>
            </View>
            <Text style={[styles.td, styles.cellQty]}>{quote.crew_size} crew · {quote.hours} hrs</Text>
            <Text style={[styles.td, styles.cellAmt]}>{money(initialPrice)}</Text>
          </View>
          {quote.travel_fee > 0 ? (
            <View style={styles.tableRow}>
              <View style={styles.cellDesc}>
                <Text style={styles.td}>Travel Fee</Text>
                <Text style={styles.muted}>Travel to job site</Text>
              </View>
              <Text style={[styles.td, styles.cellQty]}>—</Text>
              <Text style={[styles.td, styles.cellAmt]}>{money(quote.travel_fee)}</Text>
            </View>
          ) : null}
        </View>

        {/* Totals */}
        <View style={styles.totals}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Initial / first visit</Text>
            <Text style={styles.totalValue}>{money(initialPrice)}</Text>
          </View>
          {quote.travel_fee > 0 ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Travel Fee</Text>
              <Text style={styles.totalValue}>{money(quote.travel_fee)}</Text>
            </View>
          ) : null}
          <View style={styles.grandRow}>
            <Text style={styles.grandLabel}>First Invoice Total</Text>
            <Text style={styles.grandValue}>{money(quote.total)}</Text>
          </View>
        </View>

        {/* Ongoing maintenance options */}
        {hasMaintenance ? (
          <View style={{ marginTop: 20 }}>
            <Text style={styles.sectionTitle}>Ongoing Maintenance Options</Text>
            <View style={styles.table}>
              {quote.weekly_price ? (
                <View style={styles.tableRow}>
                  <Text style={[styles.td, styles.cellDesc]}>Weekly visit</Text>
                  <Text style={[styles.td, styles.cellQty]}>per visit</Text>
                  <Text style={[styles.td, styles.cellAmt]}>{money(quote.weekly_price)}</Text>
                </View>
              ) : null}
              {quote.biweekly_price ? (
                <View style={styles.tableRow}>
                  <Text style={[styles.td, styles.cellDesc]}>Bi-weekly visit</Text>
                  <Text style={[styles.td, styles.cellQty]}>per visit</Text>
                  <Text style={[styles.td, styles.cellAmt]}>{money(quote.biweekly_price)}</Text>
                </View>
              ) : null}
              {quote.monthly_price ? (
                <View style={styles.tableRow}>
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
          <Text style={styles.footerText}>Thank you for your business</Text>
        </View>
      </Page>
    </Document>
  )
}

// Render the quote to a PDF blob. Imported dynamically by the caller so the
// heavy @react-pdf library only loads when the user actually opens a PDF.
export async function renderQuoteBlob(quote: Quote, settings: BusinessSettings | null): Promise<Blob> {
  return pdf(<QuoteDocument quote={quote} settings={settings} />).toBlob()
}