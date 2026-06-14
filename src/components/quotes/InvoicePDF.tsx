'use client'

import {
  Document, Page, Text, View, Image, StyleSheet, pdf,
} from '@react-pdf/renderer'
import type { Invoice, BusinessSettings } from '@/types'

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

  bar: { backgroundColor: COLORS.dark, borderRadius: 6, padding: 16, flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  barLabel: { fontSize: 8, color: COLORS.green, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 },
  barValue: { fontSize: 13, color: '#FFFFFF', fontFamily: 'Helvetica-Bold' },

  title: { fontSize: 22, fontFamily: 'Helvetica-Bold', color: COLORS.dark, marginBottom: 16 },
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
  cellDesc: { width: '70%' },
  cellAmt: { width: '30%', textAlign: 'right' },

  grandRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, marginLeft: 'auto', width: '50%', paddingTop: 8, borderTopWidth: 1, borderTopColor: COLORS.dark },
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

interface InvoicePDFProps {
  invoice: Invoice
  settings: BusinessSettings | null
}

export function InvoiceDocument({ invoice, settings }: InvoicePDFProps) {
  const company = settings?.company_name || 'Edge Property Services'
  const contactLines = [
    settings?.phone,
    settings?.email_secondary || settings?.email_primary,
    settings?.website,
  ].filter(Boolean) as string[]

  return (
    <Document>
      <Page size="A4" style={styles.page}>
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

        <Text style={styles.title}>Invoice</Text>

        <View style={styles.bar}>
          <View>
            <Text style={styles.barLabel}>Invoice Number</Text>
            <Text style={styles.barValue}>{invoice.invoice_number}</Text>
          </View>
          <View>
            <Text style={styles.barLabel}>Issued</Text>
            <Text style={styles.barValue}>{dateStr(invoice.issued_date || invoice.created_at)}</Text>
          </View>
          <View>
            <Text style={styles.barLabel}>Due</Text>
            <Text style={styles.barValue}>{invoice.due_date ? dateStr(invoice.due_date) : '—'}</Text>
          </View>
        </View>

        <View style={styles.twoCol}>
          <View style={styles.col}>
            <Text style={styles.sectionTitle}>Billed To</Text>
            <Text style={[styles.bodyText, { fontFamily: 'Helvetica-Bold' }]}>{invoice.customer_name}</Text>
            {invoice.address ? <Text style={styles.muted}>{invoice.address}</Text> : null}
          </View>
          <View style={styles.col}>
            <Text style={styles.sectionTitle}>Status</Text>
            <Text style={[styles.bodyText, { fontFamily: 'Helvetica-Bold' }]}>
              {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
            </Text>
          </View>
        </View>

        <Text style={styles.sectionTitle}>Details</Text>
        <View style={styles.table}>
          <View style={styles.tableHead}>
            <Text style={[styles.th, styles.cellDesc]}>Description</Text>
            <Text style={[styles.th, styles.cellAmt]}>Amount</Text>
          </View>
          {(invoice.line_items && invoice.line_items.length > 0
            ? invoice.line_items
            : [{ description: invoice.service_type || 'Services rendered', amount: Number(invoice.amount), kind: 'service' as const }]
          ).map((li, i) => (
            <View style={styles.tableRow} key={i}>
              <View style={styles.cellDesc}>
                <Text style={styles.td}>{li.description}</Text>
              </View>
              <Text style={[styles.td, styles.cellAmt]}>{money(Number(li.amount))}</Text>
            </View>
          ))}
        </View>

        <View style={styles.grandRow}>
          <Text style={styles.grandLabel}>Amount Due</Text>
          <Text style={styles.grandValue}>{money(Number(invoice.amount))}</Text>
        </View>

        {invoice.notes ? (
          <View style={styles.notesBox}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={styles.bodyText}>{invoice.notes}</Text>
          </View>
        ) : null}

        {settings?.terms_text ? (
          <View style={styles.termsBox}>
            <Text style={styles.sectionTitle}>Terms &amp; Conditions</Text>
            <Text style={styles.termsText}>{settings.terms_text}</Text>
          </View>
        ) : null}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>{company}{contactLines.length ? '  ·  ' + contactLines.join('  ·  ') : ''}</Text>
          <Text style={styles.footerText}>Thank you for your business</Text>
        </View>
      </Page>
    </Document>
  )
}

// Render the invoice to a PDF blob. Imported dynamically so @react-pdf only
// loads when the user actually opens an invoice.
export async function renderInvoiceBlob(invoice: Invoice, settings: BusinessSettings | null): Promise<Blob> {
  return pdf(<InvoiceDocument invoice={invoice} settings={settings} />).toBlob()
}