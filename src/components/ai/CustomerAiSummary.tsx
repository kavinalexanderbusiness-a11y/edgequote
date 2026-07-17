'use client'

import { useState } from 'react'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { AssistButton, AiStop, AiError, AiNote } from '@/components/ai/ui'
import { useAiAssist } from '@/hooks/useAiAssist'
import { Sparkles } from 'lucide-react'

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
        <div className="ml-auto flex items-center gap-1.5">
          {ai.running && <AiStop onClick={ai.cancel} />}
          {ran && !ai.running && <AssistButton label="Try again" onClick={summarize} />}
        </div>
      </CardHeader>
      <CardBody>
        {!ran ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-muted">A 30-second read on this customer — history, money, and a suggested next step.</p>
            <AssistButton label="Summarize" busyLabel="Reading…" onClick={summarize} busy={ai.running} className="shrink-0" />
          </div>
        ) : (
          <>
            {text && <p className="text-sm text-ink whitespace-pre-wrap">{text}</p>}
            {ai.running && !text && <p className="text-sm text-ink-faint">Reading the history…</p>}
            <AiError message={ai.error} className="mt-2" />
            {!ai.running && text && (
              <AiNote className="mt-3"
                explain="Read just now from their visits, quotes, invoices and messages. The suggested next step is the app's own priority order, not a guess."
                caution="Verify anything important before acting on it." />
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}
