'use client'

import {
  Document, Page, Text, View, Image, StyleSheet, pdf,
} from '@react-pdf/renderer'
import type { BusinessSettings } from '@/types'
import { formatCurrency, parseLocalDate } from '@/lib/utils'
import { PDF_COLORS, pdfLogoSize } from '@/lib/pdfTheme'

// ── Revenue & GST Summary PDF ────────────────────────────────────────────────
// The statement an owner hands to their accountant. Same visual system as the
// document PDFs (logo/company header, dark info bar, soft table, green accents)
// via the shared `@/lib/pdfTheme`.
//
// This is NOT a profit / P&L / net-income statement, and must never be dressed
// up as one: EdgeQuote has no expense table anywhere, so the cost side of the
// business is simply absent from the data. `crew_cost_per_hour` is an internal
// costing ASSUMPTION for pricing, not a record of money spent — synthesising
// "expenses" from it would hand an accountant a fabricated number. The document
// prints its own basis + scope disclosure so it can't be misread once it has
// been detached from the app.
//
// No figure is computed here. The page passes pre-computed rows; GST already
// came from the one `invoiceTotals(...)` engine. This file only lays them out.

const styles = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 72, paddingHorizontal: 44, fontSize: 10, color: PDF_COLORS.ink, fontFamily: 'Helvetica' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 },
  logo: { width: 130, height: 70, objectFit: 'contain' },
  companyBlock: { textAlign: 'right', maxWidth: 240 },
  companyName: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: PDF_COLORS.dark },
  companyLine: { fontSize: 9, color: PDF_COLORS.muted, marginTop: 2 },

  bar: { backgroundColor: PDF_COLORS.dark, borderRadius: 6, padding: 16, flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  barLabel: { fontSize: 8, color: PDF_COLORS.green, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 },
  barValue: { fontSize: 13, color: '#FFFFFF', fontFamily: 'Helvetica-Bold' },

  sectionTitle: { fontSize: 8, color: PDF_COLORS.green, textTransform: 'uppercase', letterSpacing: 1, fontFamily: 'Helvetica-Bold', marginBottom: 6 },
  bodyText: { fontSize: 10, color: PDF_COLORS.ink, marginBottom: 2, lineHeight: 1.4 },
  muted: { fontSize: 9, color: PDF_COLORS.muted },

  summaryBox: { backgroundColor: PDF_COLORS.bgSoft, borderRadius: 6, padding: 14, marginBottom: 24 },
  sumRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  sumLabel: { fontSize: 10, color: PDF_COLORS.muted },
  sumValue: { fontSize: 10, color: PDF_COLORS.ink },
  sumSubLabel: { fontSize: 9, color: PDF_COLORS.faint, paddingLeft: 10 },
  sumSubValue: { fontSize: 9, color: PDF_COLORS.muted },
  sumGrandRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: PDF_COLORS.dark },
  sumGrandLabel: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: PDF_COLORS.dark },
  sumGrandValue: { fontSize: 16, fontFamily: 'Helvetica-Bold', color: PDF_COLORS.green },

  table: { marginBottom: 8, borderWidth: 1, borderColor: PDF_COLORS.line, borderRadius: 6, overflow: 'hidden' },
  tableHead: { flexDirection: 'row', backgroundColor: PDF_COLORS.bgSoft, paddingVertical: 8, paddingHorizontal: 12 },
  tableRow: { flexDirection: 'row', paddingVertical: 7, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: PDF_COLORS.line },
  tableFootRow: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: PDF_COLORS.dark, backgroundColor: PDF_COLORS.bgSoft },
  th: { fontSize: 8, color: PDF_COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: 'Helvetica-Bold' },
  td: { fontSize: 9, color: PDF_COLORS.ink },
  tdBold: { fontSize: 9, color: PDF_COLORS.dark, fontFamily: 'Helvetica-Bold' },

  emptyLine: { fontSize: 10, color: PDF_COLORS.muted, marginBottom: 8 },

  disclosureBox: { marginTop: 20, borderTopWidth: 1, borderTopColor: PDF_COLORS.line, paddingTop: 10 },
  disclosureText: { fontSize: 8, color: PDF_COLORS.muted, lineHeight: 1.5 },

  footer: { position: 'absolute', bottom: 28, left: 44, right: 44, borderTopWidth: 1, borderTopColor: PDF_COLORS.line, paddingTop: 10, flexDirection: 'row', justifyContent: 'space-between' },
  footerText: { fontSize: 8, color: PDF_COLORS.faint },
})

// Column widths. Two layouts: with GST, and without (not GST-registered — the
// GST column would otherwise be a stripe of $0.00).
const colGst = {
  num: { width: '12%' },
  date: { width: '18%' },
  cust: { width: '25%' },
  net: { width: '13%', textAlign: 'right' as const },
  gst: { width: '11%', textAlign: 'right' as const },
  total: { width: '13%', textAlign: 'right' as const },
  status: { width: '8%', textAlign: 'right' as const },
}
const colNoGst = {
  num: { width: '14%' },
  date: { width: '20%' },
  cust: { width: '30%' },
  net: { width: '14%', textAlign: 'right' as const },
  total: { width: '14%', textAlign: 'right' as const },
  status: { width: '8%', textAlign: 'right' as const },
}

// Long month, matching the document PDFs (`@/lib/utils`'s formatDate is
// month:'short' — using it here would make this PDF read as a different product).
function reportDate(s: string | null): string {
  if (!s) return '—'
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'long', day: 'numeric' }).format(parseLocalDate(s))
}

export interface RevenueGstRow {
  invoiceNumber: string
  issuedDate: string | null      // yyyy-MM-dd
  customerName: string
  net: number                    // revenue, pre-GST (invoice.amount, discount already applied)
  gst: number
  total: number
  paid: boolean
  balance: number
}

export interface RevenueGstReport {
  periodLabel: string            // e.g. '2026 · Q2 (Apr–Jun)'
  gstPercent: number
  rows: RevenueGstRow[]
  totals: { net: number; gst: number; total: number; paid: number; outstanding: number; count: number }
}

interface RevenueGstPDFProps {
  report: RevenueGstReport
  // Nullable like renderInvoiceBlob's: a brand-new account has no settings row yet,
  // and every read below is optional-chained with a fallback.
  settings: BusinessSettings | null
}

export function RevenueGstDoc({ report, settings }: RevenueGstPDFProps): JSX.Element {
  const company = settings?.company_name || 'Your service provider'
  const contactLines = [
    settings?.phone,
    settings?.email_secondary || settings?.email_primary,
    settings?.website,
  ].filter(Boolean) as string[]

  const hasGst = Number(report.gstPercent) > 0
  const col = hasGst ? colGst : colNoGst
  const hasRows = report.rows.length > 0
  const logo = pdfLogoSize(settings?.logo_scale)

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.headerRow}>
          <View>
            {settings?.logo_url ? (
              // Logo size honours the Branding setting (logo_scale %, capped for layout).
              <Image src={settings.logo_url} style={{ ...styles.logo, ...logo }} />
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

        {/* Info bar */}
        <View style={styles.bar}>
          <View>
            <Text style={styles.barLabel}>Statement</Text>
            <Text style={styles.barValue}>Revenue &amp; GST Summary</Text>
          </View>
          <View>
            <Text style={styles.barLabel}>Period</Text>
            <Text style={styles.barValue}>{report.periodLabel}</Text>
          </View>
        </View>

        {/* Summary */}
        <Text style={styles.sectionTitle}>Summary</Text>
        <View style={styles.summaryBox}>
          <View style={styles.sumRow}>
            <Text style={styles.sumLabel}>Revenue (excluding GST)</Text>
            <Text style={styles.sumValue}>{formatCurrency(report.totals.net)}</Text>
          </View>
          {hasGst ? (
            <View style={styles.sumRow}>
              <Text style={styles.sumLabel}>GST charged ({report.gstPercent}%)</Text>
              <Text style={styles.sumValue}>{formatCurrency(report.totals.gst)}</Text>
            </View>
          ) : (
            <View style={styles.sumRow}>
              <Text style={styles.sumLabel}>GST</Text>
              <Text style={styles.sumValue}>Not GST-registered — no GST charged.</Text>
            </View>
          )}
          <View style={styles.sumGrandRow}>
            <Text style={styles.sumGrandLabel}>Total billed</Text>
            <Text style={styles.sumGrandValue}>{formatCurrency(report.totals.total)}</Text>
          </View>
          <View style={[styles.sumRow, { marginTop: 6 }]}>
            <Text style={styles.sumSubLabel}>of which paid</Text>
            <Text style={styles.sumSubValue}>{formatCurrency(report.totals.paid)}</Text>
          </View>
          <View style={styles.sumRow}>
            <Text style={styles.sumSubLabel}>of which outstanding</Text>
            <Text style={styles.sumSubValue}>{formatCurrency(report.totals.outstanding)}</Text>
          </View>
          <View style={styles.sumRow}>
            <Text style={styles.sumSubLabel}>Invoices issued</Text>
            <Text style={styles.sumSubValue}>{report.totals.count}</Text>
          </View>
        </View>

        {/* Invoices. When not GST-registered the GST column is absent rather
            than a stripe of $0.00 — the summary block above says why, once. */}
        <Text style={styles.sectionTitle}>Invoices Issued</Text>
        {!hasRows ? (
          <Text style={styles.emptyLine}>No invoices issued in this period.</Text>
        ) : (
          <View style={styles.table}>
            <View style={styles.tableHead}>
              <Text style={[styles.th, col.num]}>Invoice #</Text>
              <Text style={[styles.th, col.date]}>Date</Text>
              <Text style={[styles.th, col.cust]}>Customer</Text>
              <Text style={[styles.th, col.net]}>Revenue</Text>
              {hasGst ? <Text style={[styles.th, colGst.gst]}>GST</Text> : null}
              <Text style={[styles.th, col.total]}>Total</Text>
              <Text style={[styles.th, col.status]}>Status</Text>
            </View>
            {report.rows.map((r, i) => (
              <View style={styles.tableRow} key={`${r.invoiceNumber}-${i}`} wrap={false}>
                <Text style={[styles.td, col.num]}>{r.invoiceNumber}</Text>
                <Text style={[styles.td, col.date]}>{reportDate(r.issuedDate)}</Text>
                <Text style={[styles.td, col.cust]}>{r.customerName}</Text>
                <Text style={[styles.td, col.net]}>{formatCurrency(r.net)}</Text>
                {hasGst ? <Text style={[styles.td, colGst.gst]}>{formatCurrency(r.gst)}</Text> : null}
                <Text style={[styles.td, col.total]}>{formatCurrency(r.total)}</Text>
                <Text style={[styles.td, col.status]}>{r.paid ? 'Paid' : 'Outstanding'}</Text>
              </View>
            ))}
            {/* Column totals — an accountant foots the table; give them the sum. */}
            <View style={styles.tableFootRow}>
              <Text style={[styles.tdBold, col.num]}>Total</Text>
              <Text style={[styles.td, col.date]}> </Text>
              <Text style={[styles.td, col.cust]}> </Text>
              <Text style={[styles.tdBold, col.net]}>{formatCurrency(report.totals.net)}</Text>
              {hasGst ? <Text style={[styles.tdBold, colGst.gst]}>{formatCurrency(report.totals.gst)}</Text> : null}
              <Text style={[styles.tdBold, col.total]}>{formatCurrency(report.totals.total)}</Text>
              <Text style={[styles.td, col.status]}> </Text>
            </View>
          </View>
        )}

        {/* Basis + scope disclosure. This travels with the document once it
            leaves the app, so it states what the numbers ARE and what this
            statement is not. Do not soften or drop it. */}
        <View style={styles.disclosureBox}>
          <Text style={styles.sectionTitle}>Basis &amp; Scope</Text>
          <Text style={styles.disclosureText}>
            Based on invoices issued in this period. Excludes cancelled invoices. GST shown is charged on
            invoices, not a filing figure. This is a revenue summary, not a profit statement — business
            expenses are not tracked in EdgeQuote.
          </Text>
        </View>

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>{company}{contactLines.length ? '  ·  ' + contactLines.join('  ·  ') : ''}</Text>
          <Text style={styles.footerText}>Revenue &amp; GST Summary  ·  {report.periodLabel}</Text>
        </View>
      </Page>
    </Document>
  )
}

// Render the summary to a PDF blob. Imported dynamically by the caller so the
// heavy @react-pdf library only loads when the user actually opens a PDF.
export async function renderRevenueGstBlob(report: RevenueGstReport, settings: BusinessSettings | null): Promise<Blob> {
  return pdf(<RevenueGstDoc report={report} settings={settings} />).toBlob()
}
