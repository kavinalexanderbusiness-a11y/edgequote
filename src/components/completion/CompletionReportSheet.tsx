'use client'

// ── Owner preview of the Job Completion Report ───────────────────────────────
// Shows EXACTLY what the customer-facing report contains — nothing more. The
// composition lives in lib/completionReport (the one place that decides what a
// report may say); this sheet renders that object and offers the PDF. It writes
// nothing: a report is a READ of canonical evidence, and the durable
// save/share/version story is parked on the Session 74 document system.
//
// The internal half of a completed visit (completion_issue, the access note,
// crew free text, worked minutes) is not merely hidden here — it never enters
// the report object, so this component has nothing to accidentally show.

import { useCallback, useEffect, useState } from 'react'
import { FileText, Camera, ListChecks, AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/Modal'
import { thumbUrl } from '@/lib/photos'
import {
  loadCompletionReport, workedDaysLine,
  type CompletionReport, type ReportChecklistItem,
} from '@/lib/completionReport'

function itemStateCopy(item: ReportChecklistItem): string {
  switch (item.state) {
    case 'done': return 'Done'
    case 'yes': return 'Yes'
    case 'no': return 'No'
    case 'photo': return 'Photo added'
    case 'choice': return item.choice ?? 'Recorded'
    case 'recorded': return 'Recorded'
    default: return '—'
  }
}

export function CompletionReportSheet({ jobId, onClose }: {
  jobId: string
  onClose: () => void
}) {
  const supabase = createClient()
  const [report, setReport] = useState<CompletionReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pdfBusy, setPdfBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    loadCompletionReport(supabase, jobId).then(res => {
      if (cancelled) return
      setReport(res.report)
      setError(res.error)
      setLoading(false)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is stable
  }, [jobId])

  const downloadPdf = useCallback(async () => {
    if (!report || pdfBusy) return
    setPdfBusy(true)
    try {
      // Loaded on demand: @react-pdf/renderer is heavy (same rule as QuotePDF).
      const { renderCompletionReportBlob } = await import('@/components/completion/CompletionReportPDF')
      const blob = await renderCompletionReportBlob(report)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `completion-report-${report.title.replace(/[^\w-]+/g, '-').slice(0, 40)}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      setError('Could not generate the PDF — try again.')
    } finally {
      setPdfBusy(false)
    }
  }, [report, pdfBusy])

  return (
    <Modal
      open
      onClose={onClose}
      title="Completion report"
      icon={FileText}
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-2 w-full">
          <p className="text-[11px] text-ink-faint min-w-0">
            Everything shown here is what the customer sees. Saving and sharing
            a report arrives with the document system.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg text-sm text-ink-muted hover:text-ink tap-target-y"
            >
              Close
            </button>
            <button
              type="button"
              onClick={downloadPdf}
              disabled={!report?.completed || pdfBusy}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-accent text-white disabled:opacity-50 tap-target-y"
            >
              {pdfBusy ? 'Preparing…' : 'Download PDF'}
            </button>
          </div>
        </div>
      }
    >
      {loading ? (
        <p className="text-sm text-ink-muted py-6 text-center">Composing the report…</p>
      ) : error && !report ? (
        <p className="text-sm text-ink-muted py-6 text-center">{error}</p>
      ) : !report ? null : !report.completed ? (
        <p className="text-sm text-ink-muted py-6 text-center">
          This visit isn&apos;t completed yet — a completion report can only
          describe a finished visit.
        </p>
      ) : (
        <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
          {error && <p className="text-xs text-red-400">{error}</p>}

          {report.unavailable.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-400 mt-0.5" aria-hidden />
              <p className="text-xs text-ink-muted">
                Couldn&apos;t load: {report.unavailable.join(', ')}. The report
                says &ldquo;unavailable&rdquo; rather than pretending they&apos;re
                empty — reopen to retry.
              </p>
            </div>
          )}

          <div>
            <h3 className="text-sm font-semibold text-ink">{report.title}</h3>
            <p className="text-xs text-ink-muted mt-0.5">
              {[
                workedDaysLine(report),
                report.customerName,
                report.address,
                report.crewName ? `Crew: ${report.crewName}` : null,
              ].filter(Boolean).join(' · ')}
            </p>
          </div>

          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1">
              Work completed
            </h4>
            {report.summary ? (
              <p className="text-sm text-ink whitespace-pre-wrap">{report.summary}</p>
            ) : (
              <p className="text-xs text-ink-faint">
                No customer-facing summary recorded — add one via &ldquo;Record
                what was done&rdquo; and it becomes the heart of this report.
              </p>
            )}
          </section>

          {report.checklists.map(list => (
            <section key={list.name}>
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1 flex items-center gap-1.5">
                <ListChecks className="w-3.5 h-3.5" aria-hidden />
                {list.name}
                <span className="normal-case tracking-normal font-normal">
                  — {list.done} of {list.total}
                </span>
              </h4>
              <ul className="space-y-1">
                {list.items.map((item, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-ink min-w-0">{item.label}</span>
                    <span className={item.state === 'pending' ? 'text-ink-faint shrink-0' : 'text-emerald-400 font-medium shrink-0'}>
                      {itemStateCopy(item)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {report.photosKnown && report.photoGroups.map(group => (
            <section key={group.kind}>
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1 flex items-center gap-1.5">
                <Camera className="w-3.5 h-3.5" aria-hidden />
                {group.label === 'Photo' ? 'Photos' : `${group.label} photos`}
                <span className="normal-case tracking-normal font-normal">— {group.photos.length}</span>
              </h4>
              <div className="grid grid-cols-3 gap-2">
                {group.photos.map(p => (
                  <figure key={p.id} className="min-w-0">
                    {/* eslint-disable-next-line @next/next/no-img-element -- storage render URL, next/image adds nothing */}
                    <img
                      src={thumbUrl(p.url)}
                      alt={p.checklistLabel ?? p.caption ?? `${group.label} photo`}
                      loading="lazy"
                      className="w-full aspect-square object-cover rounded-lg border border-border"
                    />
                    {(p.checklistLabel || p.caption) && (
                      <figcaption className="text-[10px] text-ink-faint mt-0.5 truncate">
                        {p.checklistLabel ?? p.caption}
                      </figcaption>
                    )}
                  </figure>
                ))}
              </div>
            </section>
          ))}
          {report.photosKnown && report.photoCount === 0 && (
            <p className="text-xs text-ink-faint">No photos on this visit.</p>
          )}

          {report.payment && (
            <section className="rounded-lg border border-border px-3 py-2.5">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1">
                Payment
              </h4>
              {report.payment.state === 'paid' ? (
                <p className="text-sm text-emerald-400 font-medium">
                  Invoice {report.payment.invoiceNumber} — paid in full
                </p>
              ) : (
                <p className="text-sm text-ink">
                  Invoice {report.payment.invoiceNumber}:{' '}
                  <span className={report.payment.overdue ? 'text-amber-400 font-semibold' : 'font-semibold'}>
                    ${report.payment.balance.toFixed(2)} {report.payment.overdue ? 'overdue' : 'still due'}
                  </span>
                  {report.payment.paid > 0 && (
                    <span className="text-ink-faint"> · ${report.payment.paid.toFixed(2)} paid of ${report.payment.total.toFixed(2)}</span>
                  )}
                </p>
              )}
            </section>
          )}
        </div>
      )}
    </Modal>
  )
}
