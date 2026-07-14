'use client'

import {
  Document, Page, Text, View, Image, StyleSheet, pdf,
} from '@react-pdf/renderer'
import type { Invoice, Payment, BusinessSettings } from '@/types'
import { paymentMethodLabel } from '@/types'
import { invoiceTotals } from '@/lib/invoiceTotals'
import { invoiceBalance, receiptNumberFor } from '@/lib/payments/ledger'

// ── Payment receipt PDF ──────────────────────────────────────────────────────────
// Same design language as InvoicePDF (one visual system: logo/company header, dark
// info bar, soft tables, green accents). Generated on demand from the payment +
// invoice rows — receipts are never stored, so they can't drift from the ledger.

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

  paidBox: { backgroundColor: COLORS.bgSoft, borderRadius: 6, padding: 16, marginBottom: 20, alignItems: 'center' },
  paidAmount: { fontSize: 26, fontFamily: 'Helvetica-Bold', color: COLORS.green },
  paidLabel: { fontSize: 8, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 4 },

  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  rowLabel: { fontSize: 10, color: COLORS.muted },
  rowValue: { fontSize: 10, color: COLORS.ink, fontFamily: 'Helvetica-Bold' },

  balanceRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: COLORS.dark },
  balanceLabel: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: COLORS.dark },
  balanceValue: { fontSize: 16, fontFamily: 'Helvetica-Bold' },

  footer: { position: 'absolute', bottom: 28, left: 44, right: 44, borderTopWidth: 1, borderTopColor: COLORS.line, paddingTop: 10, flexDirection: 'row', justifyContent: 'space-between' },
  footerText: { fontSize: 8, color: COLORS.faint },
})

function money(n: number) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)
}
function dateStr(s: string | null) {
  const d = s ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00' : s) : new Date()
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'long', day: 'numeric' }).format(d)
}

export interface ReceiptPDFProps {
  payment: Payment
  invoice: Invoice
  settings: BusinessSettings | null
}

export function ReceiptDocument({ payment, invoice, settings }: ReceiptPDFProps) {
  const company = settings?.company_name || 'Edge Property Services'
  const contactLines = [settings?.phone, settings?.email_secondary || settings?.email_primary, settings?.website].filter(Boolean) as string[]
  const totals = invoiceTotals(invoice.amount, settings, { type: invoice.discount_type, value: invoice.discount_value })
  const { balance } = invoiceBalance(invoice, settings)
  const owing = Math.max(0, balance)
  const receiptNo = receiptNumberFor(payment.id)
  // A negative ledger row is a refund — same document, refund vocabulary.
  const isRefund = Number(payment.amount) < 0

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow}>
          <View>
            {settings?.logo_url ? (
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

        <Text style={styles.title}>{isRefund ? 'Refund Receipt' : 'Payment Receipt'}</Text>

        <View style={styles.bar}>
          <View>
            <Text style={styles.barLabel}>Receipt Number</Text>
            <Text style={styles.barValue}>{receiptNo}</Text>
          </View>
          <View>
            <Text style={styles.barLabel}>Payment Date</Text>
            <Text style={styles.barValue}>{dateStr(payment.paid_at || payment.created_at)}</Text>
          </View>
          <View>
            <Text style={styles.barLabel}>Invoice</Text>
            <Text style={styles.barValue}>{invoice.invoice_number}</Text>
          </View>
        </View>

        <View style={styles.paidBox}>
          <Text style={{ ...styles.paidAmount, ...(isRefund ? { color: '#B4232F' } : {}) }}>{isRefund ? '−' : ''}{money(Math.abs(Number(payment.amount) || 0))}</Text>
          <Text style={styles.paidLabel}>{isRefund ? 'Refund issued' : `Payment received — ${paymentMethodLabel(payment.method || payment.provider)}`}</Text>
        </View>

        <View style={styles.twoCol}>
          <View style={styles.col}>
            <Text style={styles.sectionTitle}>{isRefund ? 'Refunded To' : 'Received From'}</Text>
            <Text style={[styles.bodyText, { fontFamily: 'Helvetica-Bold' }]}>{invoice.customer_name}</Text>
            {invoice.address ? <Text style={styles.muted}>{invoice.address}</Text> : null}
          </View>
          <View style={styles.col}>
            <Text style={styles.sectionTitle}>Payment Method</Text>
            <Text style={[styles.bodyText, { fontFamily: 'Helvetica-Bold' }]}>{paymentMethodLabel(payment.method || payment.provider)}</Text>
            {payment.notes ? <Text style={styles.muted}>{payment.notes}</Text> : null}
          </View>
        </View>

        <Text style={styles.sectionTitle}>Invoice Summary</Text>
        <View style={{ marginBottom: 8 }}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Subtotal</Text>
            <Text style={styles.rowValue}>{money(totals.subtotal)}</Text>
          </View>
          {totals.hasDiscount ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Discount{totals.discountLabel ? ` (${totals.discountLabel})` : ''}</Text>
              <Text style={styles.rowValue}>-{money(totals.discountAmount)}</Text>
            </View>
          ) : null}
          {totals.hasGst ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>GST ({totals.gstPercent}%)</Text>
              <Text style={styles.rowValue}>{money(totals.gstAmount)}</Text>
            </View>
          ) : null}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Invoice Total</Text>
            <Text style={styles.rowValue}>{money(totals.total)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Paid to Date</Text>
            <Text style={styles.rowValue}>{money(Number(invoice.amount_paid) || 0)}</Text>
          </View>
          <View style={styles.balanceRow}>
            <Text style={styles.balanceLabel}>{owing > 0.01 ? 'Balance Remaining' : 'Balance'}</Text>
            <Text style={[styles.balanceValue, { color: owing > 0.01 ? COLORS.dark : COLORS.green }]}>
              {owing > 0.01 ? money(owing) : 'PAID IN FULL'}
            </Text>
          </View>
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>{company}{contactLines.length ? '  ·  ' + contactLines.join('  ·  ') : ''}</Text>
          <Text style={styles.footerText}>Thank you for your business</Text>
        </View>
      </Page>
    </Document>
  )
}

// Render the receipt to a PDF blob (dynamic import at call sites — @react-pdf only
// loads when a receipt is actually generated).
export async function renderReceiptBlob(payment: Payment, invoice: Invoice, settings: BusinessSettings | null): Promise<Blob> {
  return pdf(<ReceiptDocument payment={payment} invoice={invoice} settings={settings} />).toBlob()
}
