'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Bot, CheckCircle2, Clock3, LockKeyhole, Sparkles, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { FilterPill } from '@/components/ui/FilterPill'
import type { OperatorActionCard, OperatorAnswer, OperatorDashboardSnapshot } from '@/lib/operator/types'

const examples = [
  'Who genuinely needs a reply?',
  'Which quotes need follow-up?',
  'What money is outstanding?',
  'Which accepted jobs have no date?',
  'Which jobs are missing labour time?',
  'What should I do first today?',
]

function money(v: number | null) { return v == null ? null : new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(v) }

// How old the evidence is, said plainly. Formatted AFTER mount on purpose: the
// server and the viewer's browser can sit in different timezones, and a
// server-rendered local time would both mismatch on hydration and be the wrong
// clock. Until it mounts the slot is empty rather than wrong.
function EvidenceAge({ iso }: { iso: string }) {
  const [label, setLabel] = useState<string | null>(null)
  useEffect(() => {
    const render = () => {
      const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
      const when = new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      setLabel(mins < 1 ? `Evidence read just now (${when})`
        : mins < 60 ? `Evidence read ${mins} min ago (${when})`
        : `Evidence read at ${when} — reload for current data`)
    }
    render()
    const t = setInterval(render, 60_000)
    return () => clearInterval(t)
  }, [iso])
  return <span className="text-xs text-ink-faint">{label ?? ''}</span>
}

function ActionCard({ card }: { card: OperatorActionCard }) {
  const badge = card.priority === 'urgent' ? 'Urgent' : card.priority === 'high' ? 'High' : card.priority === 'normal' ? 'Review' : 'Low'
  return (
    <article className="rounded-2xl border border-border bg-surface p-4 sm:p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-xl border border-border bg-surface-raised p-2">
          {card.customer_contact_required ? <TriangleAlert className="h-4 w-4 text-amber-400" aria-hidden /> : <CheckCircle2 className="h-4 w-4 text-accent-text" aria-hidden />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">{badge} · {card.category.replace('_', ' ')}</span>
            {card.financial_value != null && <span className="text-xs font-semibold text-ink">{money(card.financial_value)}</span>}
          </div>
          <h3 className="mt-1 text-sm font-bold text-ink sm:text-base">{card.title}</h3>
          <p className="mt-1 text-sm leading-5 text-ink-muted">{card.summary}</p>
          <div className="mt-3 rounded-xl bg-surface-raised px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">Recommended next step</p>
            <p className="mt-1 text-xs leading-5 text-ink-muted">{card.recommended_action}</p>
          </div>
          {card.data_quality_warnings.length > 0 && (
            <p className="mt-2 text-xs leading-5 text-amber-400">{card.data_quality_warnings[0]}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {card.record_references.filter(r => r.href).slice(0, 3).map(r => (
              <Link key={`${r.type}:${r.id}`} href={r.href!} className="rounded text-xs font-semibold text-accent-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">Open {r.type.replace('_', ' ')}</Link>
            ))}
            {card.requires_approval && <span className="text-xs text-ink-faint">Human confirmation required</span>}
          </div>
        </div>
      </div>
    </article>
  )
}

export function OperatorClient({ initial }: { initial: OperatorDashboardSnapshot }) {
  const [question, setQuestion] = useState('')
  const [asked, setAsked] = useState<string | null>(null)
  const [answer, setAnswer] = useState<OperatorAnswer | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function ask(q = question) {
    const text = q.trim()
    if (!text || loading) return
    // A fresh id per ask: the server upserts runs on (user_id, idempotency_key)
    // with duplicates ignored, so a reused id would silently drop every question
    // after the first from run history. The id guards double-submits of ONE ask,
    // not the whole mount.
    const requestId = `operator:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
    setQuestion(text); setLoading(true); setError(null); setAsked(text)
    try {
      const res = await fetch('/api/operator', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: text, request_id: requestId }) })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error || 'Operator could not verify that request.')
      setAnswer(body as OperatorAnswer)
    } catch (e) { setError(e instanceof Error ? e.message : 'Operator could not verify that request.') }
    finally { setLoading(false) }
  }

  return (
    <div className="space-y-5 lg:space-y-6">
      <section className="overflow-hidden rounded-3xl border border-border bg-surface shadow-sm">
        <div className="border-b border-border bg-gradient-to-br from-accent/10 via-transparent to-transparent p-5 sm:p-7">
          <div className="flex items-center gap-2 text-xs font-semibold text-accent-text"><Sparkles className="h-4 w-4" aria-hidden /> Ask EdgeQuote</div>
          <h2 className="mt-2 max-w-2xl text-xl font-bold tracking-tight text-ink sm:text-2xl">What needs your attention?</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">Ask about replies, quotes, money, scheduling, costs, customers or automation health. Edge Operator reads the evidence and prepares a recommendation—it cannot execute actions in Phase 1.</p>
          <div className="mt-5 flex gap-2 rounded-2xl border border-border bg-bg p-2 focus-within:ring-2 focus-within:ring-accent/30">
            <input
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => {
                // isComposing: an IME confirm (Japanese/Chinese/Korean) arrives as
                // Enter and must select the candidate, not submit the question.
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); ask() }
              }}
              placeholder="Ask EdgeQuote…"
              className="min-w-0 flex-1 bg-transparent px-2 text-sm text-ink outline-none placeholder:text-ink-faint"
              aria-label="Ask EdgeQuote"
            />
            <Button onClick={() => ask()} disabled={!question.trim()} loading={loading} aria-busy={loading}>
              {loading ? 'Checking…' : 'Ask'} {!loading && <ArrowRight className="h-4 w-4" aria-hidden />}
            </Button>
          </div>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {examples.map(x => <FilterPill key={x} active={false} onClick={() => ask(x)} disabled={loading}>{x}</FilterPill>)}
          </div>
          {/* The answer region announces itself: an ask-and-wait surface that
              stays silent to a screen reader has not answered. */}
          <div aria-live="polite" role="status">
            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
            {answer && !error && (
              <div className="mt-4 rounded-2xl border border-border bg-surface/80 p-4">
                {asked && <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">{asked}</p>}
                <p className="mt-1 text-sm leading-6 text-ink">{answer.answer}</p>
                <p className="mt-2 text-[11px] text-ink-faint">Evidence check · {answer.tools_used.join(', ')} · read only · <EvidenceAge iso={answer.generated_at} /></p>
                {/* Answer evidence stays WITH the answer — it never replaces the
                    daily brief below, which keeps its own heading honest. */}
                {answer.cards.length > 0 && (
                  <div className="mt-3 grid gap-3 xl:grid-cols-2">{answer.cards.slice(0, 6).map(c => <ActionCard key={c.id} card={c} />)}</div>
                )}
                {answer.cards.length > 6 && <p className="mt-2 text-xs text-ink-faint">Showing 6 of {answer.cards.length} evidence cards for this answer.</p>}
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-border bg-surface p-5">
          <div className="flex items-center gap-2"><Clock3 className="h-4 w-4 text-accent-text" aria-hidden /><h2 className="text-sm font-bold text-ink">Morning brief</h2></div>
          <p className="mt-2 text-sm leading-6 text-ink-muted">{initial.morning}</p>
        </section>
        <section className="rounded-2xl border border-border bg-surface p-5">
          <div className="flex items-center gap-2"><Clock3 className="h-4 w-4 text-accent-text" aria-hidden /><h2 className="text-sm font-bold text-ink">Afternoon brief</h2></div>
          <p className="mt-2 text-sm leading-6 text-ink-muted">{initial.afternoon}</p>
        </section>
      </div>

      {initial.automationWarning && <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden /><div><p className="text-sm font-semibold text-ink">Automation health</p><p className="mt-1 text-xs leading-5 text-ink-muted">{initial.automationWarning}</p></div></div>}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">Needs you today</p>
            <h2 className="mt-1 text-lg font-bold text-ink">Evidence-backed actions</h2>
            <EvidenceAge iso={initial.generated_at} />
          </div>
          <span className="rounded-full border border-border px-2.5 py-1 text-xs text-ink-muted">
            {initial.totalCards > initial.cards.length ? `${initial.cards.length} of ${initial.totalCards} items` : `${initial.cards.length} items`}
          </span>
        </div>
        <div className="grid gap-3 xl:grid-cols-2">{initial.cards.length ? initial.cards.map(c => <ActionCard key={c.id} card={c} />) : <div className="rounded-2xl border border-dashed border-border p-6 text-sm text-ink-muted">No evidence-backed action cards are showing right now.</div>}</div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-border bg-surface p-5">
          <div className="flex items-center gap-2"><LockKeyhole className="h-4 w-4 text-ink-muted" aria-hidden /><h2 className="text-sm font-bold text-ink">Pending approvals</h2></div>
          <p className="mt-2 text-sm text-ink-muted">Approval-gated execution is not enabled in Phase 1. Proposed actions are previews only.</p>
          <div className="mt-4 rounded-xl bg-surface-raised px-3 py-3 text-xs text-ink-faint">No executable actions are exposed to the model.</div>
        </section>
        <section className="rounded-2xl border border-border bg-surface p-5">
          <div className="flex items-center gap-2"><Bot className="h-4 w-4 text-ink-muted" aria-hidden /><h2 className="text-sm font-bold text-ink">Recent operator runs</h2></div>
          {!initial.historyAvailable ? <p className="mt-2 text-sm text-ink-muted">Run history will appear after the Operator foundation migration is applied.</p> : initial.recentRuns.length === 0 ? <p className="mt-2 text-sm text-ink-muted">No operator runs recorded yet.</p> : <div className="mt-3 space-y-2">{initial.recentRuns.map(r => <div key={r.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface-raised px-3 py-2"><span className="truncate text-xs text-ink-muted">{r.question || 'Operator run'}</span><span className="text-[10px] uppercase text-ink-faint">{r.status}</span></div>)}</div>}
        </section>
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-raised px-3 py-2 text-xs text-ink-muted"><LockKeyhole className="h-3.5 w-3.5" aria-hidden /><span><strong className="text-ink">Phase 1 · Read only.</strong> No messages, quotes, jobs, payments, schedules, statuses, expenses or workforce records can be changed here.</span></div>
    </div>
  )
}
