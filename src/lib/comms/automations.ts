// Which recurring messages fire automatically. Stored on
// business_settings.automations (jsonb). Per-customer opt-in still gates every
// send — these only decide whether the automation is attempted at all.

export interface Automations {
  reminder: boolean         // day-before reminder (cron)
  job_complete: boolean     // sent when a visit is marked complete
  review: boolean           // review request after a completed visit (cron)
  marketing_draft: boolean  // prepare a marketing draft when a job has before+after photos (never publishes)
  quote_followup: boolean   // chase unanswered sent quotes (cron) — OPT-IN, see below
}

export const AUTOMATION_LABELS: Record<keyof Automations, string> = {
  reminder: 'Day-before reminder',
  job_complete: 'Job-complete message',
  review: 'Review request (day after)',
  marketing_draft: 'Auto-prepare marketing drafts (before/after jobs)',
  quote_followup: 'Quote follow-up',
}

// null / missing → ON (the owner asked for these); an explicit false turns one off.
//
// quote_followup is the one exception: it defaults OFF and needs an explicit true.
// The others are bounded to a single upcoming/just-finished visit, so switching
// them on can only ever affect tomorrow. Quote follow-up reaches BACKWARDS over
// every quote still sitting in 'sent' — turning it on with a stale book would
// text months-old prospects "just checking in regarding the quote we recently
// sent". That has to be a decision the owner makes on purpose, not a default
// that fires on deploy.
export function resolveAutomations(raw: unknown): Automations {
  const a = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  return {
    reminder: a.reminder !== false,
    job_complete: a.job_complete !== false,
    review: a.review !== false,
    marketing_draft: a.marketing_draft !== false,
    quote_followup: a.quote_followup === true,
  }
}
