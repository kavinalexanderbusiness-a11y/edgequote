// ── THE words for the work ───────────────────────────────────────────────────
// EdgeQuote called the same thing a job, a visit and a stop on adjacent screens
// — sometimes on the SAME screen. This file is the one place the three words are
// defined, so a future change can look them up instead of guessing.
//
// ⭐ THE MODEL, confirmed against the live database before any of this was
// written (231 job rows across 14 recurring series — ~14 rows per series):
//
//   `job_recurrences` row  = the ongoing arrangement  → the owner calls it a JOB
//   `jobs` row             = ONE scheduled occurrence → the owner calls it a VISIT
//   a visit's place in a day's route                  → a STOP
//
// ⚠️ THE TRAP, and the reason the copy drifted: the table named `jobs` holds
// VISITS. Creating a fortnightly arrangement inserts one `jobs` row per date.
// So code that says `job` is almost always holding a visit, and copy written
// straight off the variable name says the wrong word. ⛔ Do not rename the
// table — time_entries, invoices, job_photos, job_line_items, the crew RPCs and
// every payroll replay key off it.
//
//   Job    — the work you do for a customer. One-off, or an ongoing plan.
//            Lives on the CUSTOMER ("Current Service Plan", "Upcoming Work").
//            A quote becomes one.
//   Visit  — one scheduled occurrence of that job. What the SCHEDULE manages,
//            what gets completed, what gets invoiced.
//   Stop   — a visit's position in a day's route. DISPATCH and the day board
//            only. Never used for the work itself.
//
// ⭐ THE RULE, so the words stay teachable:
//   • CREATING or IDENTIFYING the work → "job"   (Add job, Job title, Edit job)
//   • ACTING ON ONE OCCURRENCE        → "visit"  (complete, move, reschedule,
//                                                 price, past-due, this-one-only)
//   • ROUTE POSITION                  → "stop"   (next stop, stops left, reorder)
//
// Said in one sentence to a new owner: *this customer has a job; it is scheduled
// as this visit; dispatch shows that visit as a stop on the route.*

/** One occurrence. Pluralised because "1 visits scheduled" is the tell of copy
 *  assembled from a count and a hard-coded noun. */
export function visits(n: number): string {
  return `${n} visit${n === 1 ? '' : 's'}`
}

/** A visit's place in a day's route — dispatch and the day board only. */
export function stops(n: number): string {
  return `${n} stop${n === 1 ? '' : 's'}`
}

/** The work itself: a one-off job, or an ongoing plan. Used where the owner is
 *  thinking about the ARRANGEMENT rather than a date on the calendar. */
export function jobs(n: number): string {
  return `${n} job${n === 1 ? '' : 's'}`
}

/**
 * What the Schedule page says it holds. It is the answer to "where do my jobs
 * live?", and it has to name BOTH words to teach the relationship — the page
 * used to say "231 jobs on the calendar" about 231 visits, which is precisely
 * the sentence that taught the wrong model.
 */
export function scheduleSubtitle(visitCount: number): string {
  return `${visits(visitCount)} on the calendar — every job you book lands here`
}
