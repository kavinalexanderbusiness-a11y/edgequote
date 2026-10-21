import type { Job } from '../src/types'

// Fictional data only. No account, address or instruction comes from production.
export const longNote = `Customer supplies the mulch. No preparation is needed.

Use the side gate and keep it closed while working. Leave the gravel path clear for access.

Only spread mulch in the two marked beds. Do not cover the plant stems or the irrigation valves. Keep the existing edging in place.

Material reference: MULCH-${'REFERENCE'.repeat(18)}

Return unused bags to the covered area. Sweep the path and check that the gate latches before leaving.

FINAL ACCESS INSTRUCTION: Keep the rear gate closed. FINAL SCOPE INSTRUCTION: Do not work on the neighbour’s bed.`

export const fixtureJob = {
  id: 'notes-preview', created_at: '2026-10-21T08:00:00Z', updated_at: '2026-10-21T08:00:00Z',
  user_id: 'preview-only', customer_id: null, property_id: null, quote_id: null, recurrence_id: null,
  title: 'Example customer with a deliberately long display name', service_type: 'Mulch installation — front and side garden beds',
  scheduled_date: '2026-10-21', start_time: '10:00', end_time: null, duration_minutes: 60, crew_size: 1,
  status: 'scheduled', notes: longNote, price: 180, actual_minutes: null, started_at: null, completed_at: null,
  suggested_date: null, suggested_nearby_count: null, is_initial_visit: false,
  properties: { address: '123 Example Crescent SW, Unit 24 — access from the long side path', lat: null, lng: null },
} as Job

export const completedJob = {
  ...fixtureJob, id: 'completed-preview', title: 'Completed example visit', status: 'completed',
  notes: 'Work finished. Customer supplies the remaining bags.\nKeep the side gate closed for the next visit.',
  started_at: '2026-10-21T08:00:00Z', completed_at: '2026-10-21T09:00:00Z', actual_minutes: 60,
} as Job

export const typicalJob: Job = {
  ...fixtureJob, title: 'Example garden visit',
  notes: 'Customer supplies mulch. No preparation needed.\nUse the side gate and keep it closed.\nSpread mulch in the marked beds only; keep the path clear.',
}
