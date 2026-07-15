'use client'

import { useState } from 'react'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { AssistButton } from '@/components/ai/AssistButton'
import { useAiAssist } from '@/hooks/useAiAssist'
import { Sparkles, RefreshCw } from 'lucide-react'

// ── AI customer brief (profile page) ─────────────────────────────────────────
// On demand, never automatic: one click streams a short owner-facing brief of
// this customer built server-side from their real history (visits, quotes,
// invoices, notes). Nothing is stored — it's a fresh read each time, so it can
// never go stale, and the card renders nothing at all when AI isn't configured.
export function CustomerAiSummary({ customerId }: { customerId: string }) {
  const ai = useAiAssist()
  const [text, setText] = useState('')
  const [ran, setRan] = useState(false)

  if (ai.enabled !== true) return null

  async function summarize() {
    setText('')
    setRan(true)
    ai.clearError()
    await ai.run(
      { task: 'customer_summary', customerId },
      { onDelta: d => setText(prev => prev + d) },
    )
  }

  return (
    <Card>
      <CardHeader className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-accent-text" />
        <h2 className="text-sm font-semibold text-ink">AI brief</h2>
        {ran && !ai.running && (
          <button type="button" onClick={summarize} title="Regenerate" aria-label="Regenerate brief"
            className="ml-auto h-7 w-7 rounded-lg border border-border text-ink-muted hover:text-ink hover:border-border-strong transition-colors flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        )}
      </CardHeader>
      <CardBody>
        {!ran ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-muted">A 30-second read on this customer — history, money, and a suggested next step.</p>
            <AssistButton label="Summarize" onClick={summarize} busy={ai.running} className="shrink-0" />
          </div>
        ) : (
          <>
            {text && <p className="text-sm text-ink whitespace-pre-wrap">{text}</p>}
            {ai.running && !text && <p className="text-sm text-ink-faint">Reading the history…</p>}
            {ai.error && <p className="text-xs text-amber-400 mt-2">{ai.error}</p>}
            {!ai.running && text && (
              <p className="text-[11px] text-ink-faint mt-3">Generated from this customer&rsquo;s records just now — verify anything important before acting on it.</p>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}
