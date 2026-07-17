import { Document, Page, Text, View, Image, StyleSheet, pdf } from '@react-pdf/renderer'
import type { JSX } from 'react'
import type { BusinessSettings } from '@/types'
import { PDF_COLORS, pdfLogoSize } from '@/lib/pdfTheme'
import type { ScheduledReport } from '@/lib/reports/schedule'
import { summarize } from '@/lib/reports/summary'

// ── Scheduled report PDF ─────────────────────────────────────────────────────
// The same branded header as the invoice/receipt/GST PDFs (PDF_COLORS +
// pdfLogoSize), and the same figures as the email and the screen — all three
// render `summarize(report)`, so the file an owner forwards to their accountant
// says exactly what the page said. No figure is computed in this component.

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, color: PDF_COLORS.ink, fontFamily: 'Helvetica' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  logo: { objectFit: 'contain' },
  companyBlock: { alignItems: 'flex-end' },
  companyName: { fontSize: 13, fontFamily: 'Helvetica-Bold', color: PDF_COLORS.ink },
  companyLine: { fontSize: 9, color: PDF_COLORS.muted, marginTop: 2 },
  title: { fontSize: 20, fontFamily: 'Helvetica-Bold', marginBottom: 2 },
  subtitle: { fontSize: 10, color: PDF_COLORS.muted, marginBottom: 20 },
  warn: { backgroundColor: '#fef3c7', padding: 8, borderRadius: 4, fontSize: 9, marginBottom: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: PDF_COLORS.line },
  label: { fontSize: 10, color: PDF_COLORS.muted },
  note: { fontSize: 8, color: PDF_COLORS.muted, marginTop: 2 },
  value: { fontSize: 11, fontFamily: 'Helvetica-Bold' },
  footer: { marginTop: 24, fontSize: 8, color: PDF_COLORS.muted },
})

export function ScheduledReportDoc({ report, settings }: { report: ScheduledReport; settings: BusinessSettings | null }): JSX.Element {
  const s = summarize(report)
  // Nullable settings on purpose, like the other PDFs: a brand-new account has no
  // settings row, and every read below falls back rather than throwing.
  const company = settings?.company_name || 'Your business'
  const logo = pdfLogoSize(settings?.logo_scale)

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.headerRow}>
          <View>
            {/* @react-pdf's Image renders into a PDF, not the DOM: it accepts no alt
                prop and there is no screen reader to serve. The a11y rule matches on
                the component NAME alone, so it fires on a false positive here. */}
            {settings?.logo_url
              // eslint-disable-next-line jsx-a11y/alt-text
              ? <Image src={settings.logo_url} style={{ ...styles.logo, ...logo }} />
              : <Text style={styles.companyName}>{company}</Text>}
          </View>
          <View style={styles.companyBlock}>
            <Text style={styles.companyName}>{company}</Text>
            {settings?.phone ? <Text style={styles.companyLine}>{settings.phone}</Text> : null}
            {(settings?.email_secondary || settings?.email_primary)
              ? <Text style={styles.companyLine}>{settings?.email_secondary || settings?.email_primary}</Text>
              : null}
          </View>
        </View>

        <Text style={styles.title}>{s.title}</Text>
        <Text style={styles.subtitle}>{s.subtitle}</Text>

        {s.warning ? <Text style={styles.warn}>{s.warning}</Text> : null}

        {s.lines.map(l => (
          <View key={l.label} style={styles.row} wrap={false}>
            <View>
              <Text style={styles.label}>{l.label}</Text>
              {l.note ? <Text style={styles.note}>{l.note}</Text> : null}
            </View>
            <Text style={styles.value}>{l.value}</Text>
          </View>
        ))}

        <Text style={styles.footer}>
          Covers {report.period.from} to {report.period.to}. Figures are cash-basis and match the
          Accounting statements for the same period.
        </Text>
      </Page>
    </Document>
  )
}

export async function renderReportBlob(report: ScheduledReport, settings: BusinessSettings | null): Promise<Blob> {
  return pdf(<ScheduledReportDoc report={report} settings={settings} />).toBlob()
}
