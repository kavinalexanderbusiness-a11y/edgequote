'use client'

import {
  Document, Page, Text, View, Image, StyleSheet, pdf,
} from '@react-pdf/renderer'
import type { Invoice, BusinessSettings } from '@/types'
import { invoiceTotals, gstRegistrationNumber } from '@/lib/invoiceTotals'

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
  // Narrower description only when a line actually carries qty/unit_price, so a
  // job- or quote-generated invoice keeps the exact 70/30 layout it has today.
  cellDescU: { width: '46%' },
  cellQty: { width: '12%', textAlign: 'right' },
  cellUnit: { width: '18%', textAlign: 'right' },

  grandRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, marginLeft: 'auto', width: '50%', paddingTop: 8, borderTopWidth: 1, borderTopColor: COLORS.dark },
  grandLabel: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: COLORS.dark },
  grandValue: { fontSize: 16, fontFamily: 'Helvetica-Bold', color: COLORS.green },

  notesBox: { marginTop: 24, backgroundColor: COLORS.bgSoft, borderRadius: 6, padding: 14 },
  termsBox: { marginTop: 18 },
  termsText: { fontSize: 8, color: COLORS.muted, lineHeight: 1.5 },

  footer: { position: 'absolute', bottom: 28, left: 44, right: 44, borderTopWidth: 1, borderTopColor: COLORS.line, paddingTop: 10, flexDirection: 'row', justifyContent: 'space-between' },
  footerText: { fontSize: 8, color: COLORS.faint },
  // Its own line BELOW the footer row. Appending it as a third child of that row
  // would push "Thank you for your business" from the right edge to the centre —
  // and since the render returns '' (not nothing) the empty slot would shift it
  // on single-page invoices too. Positioning is all this style adds; the type is
  // styles.footerText.
  pageNumber: { position: 'absolute', bottom: 14, left: 44, right: 44, textAlign: 'right' },
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
  const company = settings?.company_name || 'Your service provider'
  const contactLines = [
    settings?.phone,
    settings?.email_secondary || settings?.email_primary,
    settings?.website,
  ].filter(Boolean) as string[]
  // Printed only for a registrant. Without it the customer cannot claim an input
  // tax credit on this invoice (CRA requires it at $30+).
  const gstNumber = gstRegistrationNumber(settings)

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
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
            {gstNumber ? <Text style={styles.companyLine}>GST/HST #: {gstNumber}</Text> : null}
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
        {(() => {
          const rows = invoice.line_items && invoice.line_items.length > 0
            ? invoice.line_items
            : [{ description: invoice.service_type || 'Services rendered', amount: invoiceTotals(invoice.amount, settings, { type: invoice.discount_type, value: invoice.discount_value }).subtotal, kind: 'service' as const }]
          // Qty/Unit are a manual-invoice breakdown. Only grow the columns when a
          // line actually has them — an engine-priced invoice renders exactly as
          // it did before this existed.
          const showUnits = rows.some(li => li.qty != null && li.unit_price != null)
          const descStyle = showUnits ? styles.cellDescU : styles.cellDesc
          return (
            <View style={styles.table}>
              <View style={styles.tableHead} fixed>
                <Text style={[styles.th, descStyle]}>Description</Text>
                {showUnits && <Text style={[styles.th, styles.cellQty]}>Qty</Text>}
                {showUnits && <Text style={[styles.th, styles.cellUnit]}>Unit price</Text>}
                <Text style={[styles.th, styles.cellAmt]}>Amount</Text>
              </View>
              {rows.map((li, i) => (
                <View style={styles.tableRow} key={i} wrap={false}>
                  <View style={descStyle}>
                    <Text style={styles.td}>{li.description}</Text>
                  </View>
                  {showUnits && <Text style={[styles.td, styles.cellQty]}>{li.qty != null ? String(li.qty) : ''}</Text>}
                  {showUnits && <Text style={[styles.td, styles.cellUnit]}>{li.unit_price != null ? money(Number(li.unit_price)) : ''}</Text>}
                  <Text style={[styles.td, styles.cellAmt]}>{money(Number(li.amount))}</Text>
                </View>
              ))}
            </View>
          )
        })()}

        {(() => {
          const t = invoiceTotals(invoice.amount, settings, { type: invoice.discount_type, value: invoice.discount_value })
          // Money already received MUST show on the document (an accountant's
          // partial-payment invoice that still says the full total invites a
          // double payment). Balance = the one ledger definition.
          const paidToDate = Number(invoice.amount_paid) || 0
          const balanceDue = Math.max(0, Math.round((t.total - paidToDate) * 100) / 100)
          const paidRows = paidToDate > 0.005 ? (
            <View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginLeft: 'auto', width: '50%', marginTop: 2 }}>
                <Text style={styles.bodyText}>Paid to date</Text>
                <Text style={styles.bodyText}>-{money(paidToDate)}</Text>
              </View>
              <View style={styles.grandRow}>
                <Text style={styles.grandLabel}>Balance Due</Text>
                <Text style={styles.grandValue}>{money(balanceDue)}</Text>
              </View>
            </View>
          ) : null
          if (!t.hasGst && !t.hasDiscount && !paidRows) return (
            <View style={styles.grandRow} wrap={false}>
              <Text style={styles.grandLabel}>Amount Due</Text>
              <Text style={styles.grandValue}>{money(t.total)}</Text>
            </View>
          )
          if (!t.hasGst && !t.hasDiscount) return (
            <View wrap={false}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, marginLeft: 'auto', width: '50%' }}>
                <Text style={styles.bodyText}>Invoice Total</Text>
                <Text style={styles.bodyText}>{money(t.total)}</Text>
              </View>
              {paidRows}
            </View>
          )
          return (
            <View wrap={false}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, marginLeft: 'auto', width: '50%' }}>
                <Text style={styles.bodyText}>Subtotal</Text>
                <Text style={styles.bodyText}>{money(t.subtotal)}</Text>
              </View>
              {t.hasDiscount ? (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginLeft: 'auto', width: '50%', marginTop: 2 }}>
                  <Text style={styles.bodyText}>Discount{t.discountLabel ? ` (${t.discountLabel})` : ''}</Text>
                  <Text style={styles.bodyText}>-{money(t.discountAmount)}</Text>
                </View>
              ) : null}
              {t.hasGst ? (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginLeft: 'auto', width: '50%', marginTop: 2 }}>
                  <Text style={styles.bodyText}>GST ({t.gstPercent}%)</Text>
                  <Text style={styles.bodyText}>{money(t.gstAmount)}</Text>
                </View>
              ) : null}
              {/* `paidRows` was computed above and then never rendered on THIS branch —
                  the branch taken whenever GST or a discount applies, i.e. the default
                  path for every GST registrant. A part-paid invoice printed "Total Due"
                  at the FULL amount with no "Paid to date" and no "Balance Due": exactly
                  the double payment the comment above warns about. When money has been
                  received the pre-payment figure stops being the headline (it is not what
                  is due) and steps down to a plain line — the same vocabulary the
                  no-GST branch already uses — leaving "Balance Due" as the one grand
                  row, so there is never a second competing bold number to pay. */}
              {paidRows ? (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginLeft: 'auto', width: '50%', marginTop: 2 }}>
                  <Text style={styles.bodyText}>Invoice Total</Text>
                  <Text style={styles.bodyText}>{money(t.total)}</Text>
                </View>
              ) : (
                <View style={styles.grandRow}>
                  <Text style={styles.grandLabel}>Total Due</Text>
                  <Text style={styles.grandValue}>{money(t.total)}</Text>
                </View>
              )}
              {paidRows}
            </View>
          )
        })()}

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

        {/* Only once the invoice actually spans pages — "Page 1 of 1" on a
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

// Render the invoice to a PDF blob. Imported dynamically so @react-pdf only
// loads when the user actually opens an invoice.
export async function renderInvoiceBlob(invoice: Invoice, settings: BusinessSettings | null): Promise<Blob> {
  return pdf(<InvoiceDocument invoice={invoice} settings={settings} />).toBlob()
}