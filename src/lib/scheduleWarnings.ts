// ── Manual scheduling guard (cadence + customer preferences) ──────────────────
// One entry point every hand-scheduling surface calls — calendar drag-drop, the
// Day Ops "Move to" picker, and the job-form date/time fields — so they all warn
// with the SAME rules the optimizer enforces. Composes the recurring-series
// cadence guard (lib/optimizer) with per-customer/property preferences
// (lib/preferences). Soft by design: it returns warnings, it never blocks a move.

import { manualCadenceCheck, CadenceVisit, CadenceRecs } from '@/lib/optimizer'
import { resolvePrefs, prefWarnings, PrefSource } from '@/lib/preferences'

export interface ScheduleMoveEval {
  warnings: string[]    // ordered, owner-facing; strongest first
  collision: boolean    // a same-day duplicate visit for this customer
  cadenceWarn: boolean  // lands inside the cadence floor of a neighbour visit
}

export const NO_MOVE_WARNINGS: ScheduleMoveEval = { warnings: [], collision: false, cadenceWarn: false }

export function evaluateScheduleMove(input: {
  move: { id: string; customerId: string | null; recurrence_id: string | null; serviceType?: string | null }
  toDate: string
  startTime?: string | null
  allVisits: CadenceVisit[]
  recs: CadenceRecs
  customerPrefs?: PrefSource | null
  propertyPrefs?: PrefSource | null
  customerName?: string | null
}): ScheduleMoveEval {
  const cadence = manualCadenceCheck(input.move, input.toDate, input.allVisits, input.recs)
  const prefs = resolvePrefs(input.customerPrefs, input.propertyPrefs)
  const prefMsgs = prefWarnings(prefs, input.toDate, input.startTime, input.customerName)

  const warnings: string[] = []
  if (cadence.message) warnings.push(cadence.message)   // cadence first — it's the integrity rule
  warnings.push(...prefMsgs)

  return {
    warnings,
    collision: cadence.status === 'collision',
    cadenceWarn: cadence.status === 'warn',
  }
}
