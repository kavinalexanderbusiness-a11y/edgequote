'use client'

import { useState } from 'react'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { ReconcileReport } from '@/lib/payments/reconcile'
import { Scale, AlertTriangle, CheckCircle2 } from 'lucide-react'

// Owner-facing half of the Stripe ↔ ledger reconciliation. Deliberately a BUTTON, not
// something that runs on load: the check costs real Stripe API calls, and the honest
// use is the owner asking a specific question ("did the webhook outage cost me
// anything?") rather than a page silently re-listing the account on every visit.
//
// Read-only, and the copy says so. Recording the money is the owner's call through
// the existing Record-payment flow — this panel's only job is to make invisible money
// visible.
export function ReconcilePanel() {
  const [report, setReport] = useState<ReconcileReport & { days?: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function check() {
    setBusy(true); setError(null); setReport(null)
    try {
      const res = await fetch('/api/payments/reconcile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 90 }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Could not check Stripe just now.'); return }
      setReport(d as ReconcileReport & { days: number })
    } catch { setError('Could not reach the server.') }
    finally { setBusy(false) }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink flex items-center gap-2">
              <Scale className="w-4 h-4 text-accent-text" /> Check Stripe against your books
            </p>
            <p className="text-xs text-ink-faint mt-0.5">
              Finds card payments Stripe took that never got recorded here — the kind a missed webhook leaves behind. Nothing is changed; it only looks.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={check} loading={busy} className="shrink-0">
            {report || error ? 'Check again' : 'Check last 90 days'}
          </Button>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        {/* An empty result is only good news if the check actually ran — reconcileStripe
            returns ok:false rather than an empty list when Stripe can't be read, so
            "all recorded" here always means we looked and found nothing. */}
        {report?.ok && report.unrecorded.length === 0 && (
          <p className="text-xs text-emerald-400 flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            All {report.checked} Stripe payment{report.checked !== 1 ? 's' : ''} from the last {report.days ?? 90} days {report.checked === 1 ? 'is' : 'are'} recorded in your books.
          </p>
        )}

        {report?.ok && report.unrecorded.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-amber-400 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                <strong>{formatCurrency(report.total)}</strong> across {report.unrecorded.length} payment{report.unrecorded.length !== 1 ? 's' : ''} reached
                Stripe but was never recorded here. The money is in your Stripe account — these invoices just don’t know it.
              </span>
            </p>
            <div className="rounded-lg border border-border bg-bg-secondary divide-y divide-border">
              {report.unrecorded.map(c => (
                <div key={c.paymentIntentId} className="flex items-center justify-between gap-3 px-2.5 py-2">
                  <div className="min-w-0">
                    <p className="text-xs text-ink">
                      <span className="font-semibold text-emerald-400">{formatCurrency(c.amount)}</span>
                      <span className="text-ink-faint"> · {formatDate(c.createdIso)}</span>
                    </p>
                    <p className="text-[10px] text-ink-faint truncate">
                      {c.orphaned
                        ? c.description || 'No invoice on this payment — check it in Stripe.'
                        : `For ${c.invoiceNumber}`}
                    </p>
                  </div>
                  {/* Two things this link has to respect, both easy to get wrong:
                      ?invoice= matches on invoice_NUMBER (not the id), and the page
                      reads it into state once at mount — so a client-side <Link> from
                      a panel living ON that page would change the URL and refocus
                      nothing. A plain anchor navigates for real. */}
                  {!c.orphaned && c.invoiceNumber && (
                    <a href={`/dashboard/invoices?invoice=${encodeURIComponent(c.invoiceNumber)}`}
                      className="text-[11px] font-medium text-accent-text hover:underline shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                      Open invoice
                    </a>
                  )}
                </div>
              ))}
            </div>
            <p className="text-[10px] text-ink-faint">
              Record each one on its invoice (Record payment → Card) so your balances match Stripe. Fixing the cause is worth doing too — a missing
              STRIPE_WEBHOOK_SECRET is the usual reason payments stop recording themselves.
            </p>
            {report.truncated && (
              <p className="text-[10px] text-amber-400">
                Stripe had more history than this check paged through — this is a partial list, not the full picture.
              </p>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
