// ── Verify: Past-due visits says only what its inputs can back ──────────────
//   npm run verify:missed-jobs-copy
//
// WHAT THIS GUARDS. MissedJobsCard's `jobs` prop is `isMissed`'s output —
// scheduled_date < today AND status in {scheduled, in_progress}. Date and
// status, nothing else. The card's copy used to say "so they were never
// billed and the customer is a cycle behind" for EVERY row — a claim about
// INVOICING (this component reads no invoice table) and about RECURRENCE
// (isMissed takes no recurrence_id, so a one-off, non-recurring visit has no
// "cycle" to be behind on at all). That sentence was true of nothing the
// predicate actually establishes; it was true only of some jobs, by
// coincidence, on some businesses.
//
// This guard is presentation-only and intentionally narrow:
//   1. the false billing/recurrence claim is GONE from the card,
//   2. a truthful, status-only replacement is present,
//   3. isMissed itself is UNCHANGED — still exactly date + status, no
//      billing/recurrence field added to make the old claim retroactively
//      true (the honest fix is the copy, never a quiet predicate widening),
//   4. the card's resolution handlers (bring-to-today / complete / open)
//      keep their exact prop signatures — this session touches copy only.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, c: boolean, d = '') => (c ? ok(n) : fail(n, d))
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// Comments stripped before any "this must be gone" assertion — the same trap
// verify-tenant-time.ts documents: a fix's own comment quoting the old text
// (which this file's header just did, deliberately, for readers) would make a
// naive grep match the explanation instead of the code. CRLF-safe: `[^\n\r]`
// for the line-comment tail, not `.` (which does not match `\r`).
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:"'`\\])\/\/[^\n\r]*/g, '$1')

const CARD = 'src/components/schedule/MissedJobsCard.tsx'
const card = code(CARD)

check('the false billing claim ("never billed") is gone',
  !/never billed/i.test(card))
check('the false recurrence claim ("cycle behind") is gone',
  !/cycle behind/i.test(card))
check('the replacement copy is present and status-only',
  /still open after their scheduled date/i.test(card))

// Scoped to the copy PARAGRAPH itself, not the whole file — `dayDelta` is
// legitimately imported `from '@/lib/recurrence'` a few lines up (the overdue
// day-count helper, untouched by this fix), and a whole-file word check would
// flag that unrelated import path as if it were the old claim reappearing.
const paragraphMatch = card.match(/px-3 py-2 text-xs text-ink-muted">([\s\S]*?)<\/div>/)
check('the copy paragraph is found (so the two checks below mean something)', !!paragraphMatch)
const paragraph = paragraphMatch ? paragraphMatch[1] : ''
// The replacement must not quietly reintroduce a different unbacked claim —
// this component has no invoice/billing/recurrence data to say anything about
// either topic.
check('…and doesn’t reach for billing or invoice words instead',
  !/\b(billed|billing|invoice)\b/i.test(paragraph))
check('…and doesn’t reach for recurrence words instead',
  !/\b(recurrence|recurring|cycle)\b/i.test(paragraph))

// ── isMissed itself: untouched ────────────────────────────────────────────
const PRIORITIES = 'src/lib/dashboard/priorities.ts'
const prioritiesSrc = read(PRIORITIES) // raw, not comment-stripped: pin the exact body text
const isMissedMatch = prioritiesSrc.match(/export function isMissed\([^{]*\{([\s\S]*?)\n\}/)
check('isMissed exists and is inspectable', !!isMissedMatch)
const isMissedBody = isMissedMatch ? isMissedMatch[1] : ''
check('isMissed is STILL exactly date + status — no billing field added',
  /scheduled_date/.test(isMissedBody) && /status/.test(isMissedBody)
  && !/invoice/i.test(isMissedBody) && !/billed|billing/i.test(isMissedBody))
check('isMissed is STILL exactly date + status — no recurrence field added',
  !/recurrence/i.test(isMissedBody))
check('MUTATION — the isMissed body actually contains its two real predicates',
  isMissedBody.includes('todayISO') && isMissedBody.includes("'scheduled'") && isMissedBody.includes("'in_progress'"),
  'if this fails the regex above stopped matching the real function and every isMissed check here is vacuous')

// ── The card's resolution handlers: unchanged wiring, copy-only session ──
check('handler props are untouched (bring-to-today / complete / open)',
  /onBringToToday:\s*\(job: Job\) => void/.test(card)
  && /onComplete:\s*\(job: Job\) => void/.test(card)
  && /onOpen:\s*\(job: Job\) => void/.test(card))
check('the three action buttons still call exactly those three handlers, nothing new',
  /onClick={\(\) => onBringToToday\(job\)}/.test(card)
  && /onClick={\(\) => onComplete\(job\)}/.test(card)
  && /onClick={\(\) => onOpen\(job\)}/.test(card))

console.log(failures === 0
  ? '\n✅ missed-jobs-copy: every check passed\n'
  : `\n❌ missed-jobs-copy: ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
