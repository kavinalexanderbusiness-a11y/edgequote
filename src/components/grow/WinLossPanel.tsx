'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { loadWinLoss, recordQuoteOutcome, WinLossData, LostQuoteRow, LOSS_REASONS, LOSS_REASON_LABEL, LossReason } from '@/lib/winLoss'
import { formatCurrency, cn } from '@/lib/utils'
import { Trophy, Loader2, RefreshCw, Check } from 'lucide-react'

// ── Win/Loss (Growth) ───────────────────────────────────────────────────────────
// Decision-first: the win rate up top, then the ONE action — tag why each lost
// quote was lost, one tap. Those tags feed the Suggestions Center's pricing
// intelligence ("you keep losing on price in Queensland"). Read-only over quotes;
// writes only to quote_outcomes.
export function WinLossPanel() {
  const supabase = useMemo(() => createClient(), [])
  const [data, setData] = useState<WinLossData | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try { setData(await loadWinLoss(supabase)) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function tag(q: LostQuoteRow, reason: LossReason) {
    setSavingId(q.id)
    const res = await recordQuoteOutcome(supabase, q.id, reason)
    setSavingId(null)
    if (res.ok) {
      // optimistic: stamp the reason locally so the row collapses to its tag
      setData(d => d && { ...d, lostQuotes: d.lostQuotes.map(x => x.id === q.id ? { ...x, reason } : x) })
    }
  }

  if (loading) {
    return (
      <div className="rounded-card border border-border bg-bg-secondary p-5 flex items-center gap-2 text-sm text-ink-muted">
        <Loader2 className="w-4 h-4 animate-spin" /> Reading your quote outcomes…
      </div>
    )
  }
  if (!data || data.stats.decided === 0) return null // nothing decided yet → don't take space

  const { stats, lostQuotes } = data
  const winPct = Math.round(stats.winRate * 100)
  const topReasons = Object.entries(stats.reasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 3)
  const untagged = lostQuotes.filter(q => !q.reason)

  return (
    <div className="rounded-card border border-border bg-bg-secondary overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
            <Trophy className="w-4 h-4 text-accent" />
          </div>
          <div className="min-w-0">
            <p className="text-base font-bold text-ink">Win / Loss</p>
            <p className="text-xs text-ink-muted mt-0.5">
              {winPct}% win rate · {stats.won} won · {stats.lost} lost
              {untagged.length > 0 ? ` · ${untagged.length} to tag` : ''}
            </p>
          </div>
        </div>
        <button onClick={load} title="Refresh" className="h-8 w-8 rounded-lg border border-border text-ink-muted hover:text-ink flex items-center justify-center shrink-0">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Why you're losing — at a glance */}
      {topReasons.length > 0 && (
        <div className="px-5 py-2.5 border-b border-border flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-ink-faint">Top loss reasons</span>
          {topReasons.map(([r, n]) => (
            <span key={r} className="text-[11px] font-semibold rounded-full px-2 py-0.5 border border-border text-ink-muted">
              {LOSS_REASON_LABEL[r] || r} · {n}
            </span>
          ))}
        </div>
      )}

      {/* The action: tag each lost quote */}
      <div className="p-4 space-y-2">
        {lostQuotes.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-muted">No lost quotes — nice. 🎉</p>
        ) : (
          lostQuotes.slice(0, 12).map(q => (
            <div key={q.id} className="rounded-xl border border-border bg-bg-tertiary p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink truncate">{q.customer_name}</p>
                  <p className="text-xs text-ink-muted truncate">{q.address}{q.total ? ` · ${formatCurrency(Number(q.total))}` : ''}</p>
                </div>
                {q.reason && (
                  <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                    <Check className="w-3.5 h-3.5" /> {LOSS_REASON_LABEL[q.reason] || q.reason}
                  </span>
                )}
              </div>
              {!q.reason && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {LOSS_REASONS.map(r => (
                    <button key={r.key} onClick={() => tag(q, r.key)} disabled={savingId === q.id}
                      className={cn('text-[11px] font-medium rounded-full px-2.5 py-1 border border-border text-ink-muted hover:text-ink hover:border-accent/40 transition-colors disabled:opacity-50')}>
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
        {lostQuotes.length > 12 && (
          <p className="text-[11px] text-ink-faint text-center pt-1">Showing 12 of {lostQuotes.length} lost quotes</p>
        )}
      </div>
    </div>
  )
}
