// Which recurring messages fire automatically. Stored on
// business_settings.automations (jsonb). Per-customer opt-in still gates every
// send — these only decide whether the automation is attempted at all.

export interface Automations {
  reminder: boolean         // day-before reminder (cron)
  job_complete: boolean     // sent when a visit is marked complete
  review: boolean           // review request after a completed visit (cron)
  marketing_draft: boolean  // prepare a marketing draft when a job has before+after photos (never publishes)
}

export const AUTOMATION_LABELS: Record<keyof Automations, string> = {
  reminder: 'Day-before reminder',
  job_complete: 'Job-complete message',
  review: 'Review request (day after)',
  marketing_draft: 'Auto-prepare marketing drafts (before/after jobs)',
}

// null / missing → ON (the owner asked for these); an explicit false turns one off.
export function resolveAutomations(raw: unknown): Automations {
  const a = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  return {
    reminder: a.reminder !== false,
    job_complete: a.job_complete !== false,
    review: a.review !== false,
    marketing_draft: a.marketing_draft !== false,
  }
}
