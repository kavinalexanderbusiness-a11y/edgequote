'use client'

import { PriceGuardrail, cadenceLabel } from '@/lib/priceGuardrails'
import { AlertTriangle } from 'lucide-react'

// Live, NEVER-BLOCK pricing heads-up. Shows the WHY for any cadence priced below
// its recommendation / below the crew-cost floor / isolated-and-underpriced.
export function PriceGuardrailNote({ guardrails }: { guardrails: PriceGuardrail[] }) {
  const warns = guardrails.filter(g => g.level === 'warn' && g.reasons.length > 0)
  if (warns.length === 0) return null
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 space-y-2">
      {warns.map((g, i) => (
        <div key={i}>
          <p className="text-xs font-semibold text-amber-400 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {cadenceLabel(g.cadence).replace(/^\w/, c => c.toUpperCase())} price — heads up (you can still save)
          </p>
          <ul className="mt-1 pl-5 space-y-0.5 list-disc">
            {g.reasons.map((r, j) => <li key={j} className="text-[11px] text-ink-muted">{r}</li>)}
          </ul>
        </div>
      ))}
    </div>
  )
}
