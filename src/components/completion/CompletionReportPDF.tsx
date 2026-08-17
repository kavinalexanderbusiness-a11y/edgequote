'use client'

// ── The Job Completion Report as a customer-ready PDF ────────────────────────
// Renders lib/completionReport's composed view — this file draws and decides
// nothing about content. Same stack as every document in the app
// (@react-pdf/renderer, client-side, dynamically imported by its caller so the
// heavy library loads only when a report is actually generated).
//
// ⭐ Every image is BOUNDED at the source: the logo through pdfLogoUrl and each
// photo through thumbUrl — @react-pdf embeds whatever bytes the src resolves
// to, and the untreated path once produced 11.3 MB invoices from a 10.8 MB
// logo. A 20-photo report must stay a document, not a download incident.
//
// ⛔ Nothing internal renders here: the report object structurally cannot carry
// completion_issue, jobs.notes, crew free text or worked minutes (see
// lib/completionReport), so this file could not leak them even by accident.

import {
  Document, Page, Text, View, Image, StyleSheet, pdf,
} from '@react-pdf/renderer'
import { pdfLogoUrl, thumbUrl } from '@/lib/photos'
import {
  formatReportDay, workedDaysLine,
  type CompletionReport, type ReportChecklistItem,
} from '@/lib/completionReport'

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
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  logo: { width: 130, height: 70, objectFit: 'contain' },
  companyBlock: { textAlign: 'right', maxWidth: 240 },
  companyName: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: COLORS.dark },
  companyLine: { fontSize: 9, color: COLORS.muted, marginTop: 2 },

  titleBar: { backgroundColor: COLORS.dark, borderRadius: 6, padding: 16, marginBottom: 22 },
  titleLabel: { fontSize: 8, color: COLORS.green, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 },
  titleValue: { fontSize: 14, color: '#FFFFFF', fontFamily: 'Helvetica-Bold' },
  titleMeta: { fontSize: 9, color: '#C9D4E3', marginTop: 4 },

  sectionTitle: { fontSize: 8, color: COLORS.green, textTransform: 'uppercase', letterSpacing: 1, fontFamily: 'Helvetica-Bold', marginBottom: 6, marginTop: 4 },
  twoCol: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  col: { width: '48%' },
  bodyText: { fontSize: 10, color: COLORS.ink, marginBottom: 2, lineHeight: 1.4 },
  muted: { fontSize: 9, color: COLORS.muted },

  summaryBox: { backgroundColor: COLORS.bgSoft, borderRadius: 6, padding: 14, marginBottom: 20 },

  photoRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 10 },
  photoCell: { width: '31%', marginRight: '2%', marginBottom: 10 },
  photoImg: { width: '100%', height: 110, objectFit: 'cover', borderRadius: 4 },
  photoCaption: { fontSize: 8, color: COLORS.muted, marginTop: 3, lineHeight: 1.3 },

  checkTable: { marginBottom: 16, borderWidth: 1, borderColor: COLORS.line, borderRadius: 6, overflow: 'hidden' },
  checkHead: { flexDirection: 'row', backgroundColor: COLORS.bgSoft, paddingVertical: 7, paddingHorizontal: 12, justifyContent: 'space-between' },
  checkHeadText: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: COLORS.dark },
  checkRow: { flexDirection: 'row', paddingVertical: 6, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: COLORS.line, justifyContent: 'space-between' },
  checkLabel: { fontSize: 9.5, color: COLORS.ink, flexShrink: 1, paddingRight: 8 },
  checkState: { fontSize: 9.5, color: COLORS.green, fontFamily: 'Helvetica-Bold' },
  checkStateMuted: { fontSize: 9.5, color: COLORS.faint },

  payBox: { marginTop: 4, marginBottom: 18, borderWidth: 1, borderColor: COLORS.line, borderRadius: 6, padding: 14 },
  payRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  payLabel: { fontSize: 10, color: COLORS.muted },
  payValue: { fontSize: 10, color: COLORS.ink },
  payHead: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: COLORS.dark, marginBottom: 4 },
  payState: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: COLORS.green },
  payDue: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: '#B45309' },

  footer: { position: 'absolute', bottom: 28, left: 44, right: 44, borderTopWidth: 1, borderTopColor: COLORS.line, paddingTop: 10, flexDirection: 'row', justifyContent: 'space-between' },
  footerText: { fontSize: 8, color: COLORS.faint },
})

const money = (n: number) =>
  new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)

// Words, not glyphs: the base Helvetica fonts have no U+2713, and a missing
// glyph renders as a blank — a checklist of invisible ticks.
function stateCopy(item: ReportChecklistItem): { text: string; done: boolean } {
  switch (item.state) {
    case 'done': return { text: 'Done', done: true }
    case 'yes': return { text: 'Yes', done: true }
    case 'no': return { text: 'No', done: true }
    case 'photo': return { text: 'Photo added', done: true }
    case 'choice': return { text: item.choice ?? 'Recorded', done: true }
    case 'recorded': return { text: 'Recorded', done: true }
    default: return { text: '-', done: false }
  }
}

export function CompletionReportDocument({ report }: { report: CompletionReport }) {
  const biz = report.business
  const dateLine = workedDaysLine(report)
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.headerRow}>
          {biz?.logoUrl
            // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt
            ? <Image style={styles.logo} src={pdfLogoUrl(biz.logoUrl)} />
            : <View />}
          <View style={styles.companyBlock}>
            <Text style={styles.companyName}>{biz?.name ?? ''}</Text>
            {biz?.phone ? <Text style={styles.companyLine}>{biz.phone}</Text> : null}
            {biz?.email ? <Text style={styles.companyLine}>{biz.email}</Text> : null}
            {biz?.website ? <Text style={styles.companyLine}>{biz.website}</Text> : null}
          </View>
        </View>

        <View style={styles.titleBar}>
          <Text style={styles.titleLabel}>Job Completion Report</Text>
          <Text style={styles.titleValue}>{report.title}</Text>
          <Text style={styles.titleMeta}>
            {[dateLine ? `Completed ${dateLine}` : null, report.crewName ? `Crew: ${report.crewName}` : null]
              .filter(Boolean).join('   ·   ')}
          </Text>
        </View>

        <View style={styles.twoCol}>
          <View style={styles.col}>
            <Text style={styles.sectionTitle}>Prepared for</Text>
            {report.customerName ? <Text style={styles.bodyText}>{report.customerName}</Text> : null}
            {report.address ? <Text style={styles.bodyText}>{report.address}</Text> : null}
          </View>
          <View style={styles.col}>
            <Text style={styles.sectionTitle}>Service</Text>
            <Text style={styles.bodyText}>{report.serviceType ?? report.title}</Text>
            {report.completedAt ? (
              <Text style={styles.muted}>Completed {formatReportDay(report.completedAt.slice(0, 10))}</Text>
            ) : null}
          </View>
        </View>

        {report.summary ? (
          <View style={styles.summaryBox} wrap={false}>
            <Text style={styles.sectionTitle}>Work completed</Text>
            <Text style={styles.bodyText}>{report.summary}</Text>
          </View>
        ) : null}

        {report.checklists.map(list => (
          <View key={list.name} style={styles.checkTable} wrap={false}>
            <View style={styles.checkHead}>
              <Text style={styles.checkHeadText}>{list.name}</Text>
              <Text style={styles.checkHeadText}>{list.done} of {list.total}</Text>
            </View>
            {list.items.map((item, i) => {
              const s = stateCopy(item)
              return (
                <View key={i} style={styles.checkRow}>
                  <Text style={styles.checkLabel}>{item.label}</Text>
                  <Text style={s.done ? styles.checkState : styles.checkStateMuted}>{s.text}</Text>
                </View>
              )
            })}
          </View>
        ))}

        {report.photoGroups.map(group => (
          <View key={group.kind}>
            <Text style={styles.sectionTitle}>
              {group.label === 'Photo' ? 'Photos' : `${group.label} photos`}
            </Text>
            <View style={styles.photoRow}>
              {group.photos.map(p => (
                <View key={p.id} style={styles.photoCell} wrap={false}>
                  {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt */}
                  <Image style={styles.photoImg} src={thumbUrl(p.url, 640, 640)} />
                  {(p.checklistLabel || p.caption) ? (
                    <Text style={styles.photoCaption}>{p.checklistLabel ?? p.caption}</Text>
                  ) : null}
                </View>
              ))}
            </View>
          </View>
        ))}

        {report.payment ? (
          <View style={styles.payBox} wrap={false}>
            <Text style={styles.payHead}>Payment</Text>
            <View style={styles.payRow}>
              <Text style={styles.payLabel}>Invoice {report.payment.invoiceNumber}</Text>
              <Text style={styles.payValue}>{money(report.payment.total)}</Text>
            </View>
            {report.payment.state === 'paid' ? (
              <View style={styles.payRow}>
                <Text style={styles.payState}>Paid in full — thank you</Text>
              </View>
            ) : (
              <>
                {report.payment.paid > 0 ? (
                  <View style={styles.payRow}>
                    <Text style={styles.payLabel}>Received</Text>
                    <Text style={styles.payValue}>{money(report.payment.paid)}</Text>
                  </View>
                ) : null}
                <View style={styles.payRow}>
                  <Text style={report.payment.overdue ? styles.payDue : styles.payLabel}>
                    {report.payment.overdue ? 'Balance overdue' : 'Balance due'}
                  </Text>
                  <Text style={styles.payDue}>{money(report.payment.balance)}</Text>
                </View>
              </>
            )}
          </View>
        ) : null}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>{biz?.name ?? ''}</Text>
          <Text style={styles.footerText}>Job Completion Report</Text>
        </View>
      </Page>
    </Document>
  )
}

/** Render to a Blob. Imported dynamically by the caller so @react-pdf loads
 *  only when a report is actually generated. */
export async function renderCompletionReportBlob(report: CompletionReport): Promise<Blob> {
  return pdf(<CompletionReportDocument report={report} />).toBlob()
}
