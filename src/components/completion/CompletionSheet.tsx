'use client'

// ── The completion record, for both audiences ────────────────────────────────
// ONE editor for what a visit LEFT BEHIND, mounted by the worker's Today screen
// and by the owner's dispatch board. There is no crew copy and no owner copy:
// the two differ only in how the words travel to the database (a crew session
// has no table grants, so it goes through a typed RPC) and in which canonical
// photo uploader they hand in — both supplied by the caller.
//
// ⛔ THIS IS NOT A COMPLETION DOOR. Nothing here writes status, completed_at,
// actual_minutes, or an invoice. It never opens itself over a completion either:
// a routine mow is finished by ONE tap and this sheet is never in the way. The
// affordance sits on the card, available before, during and after the visit —
// which is also when the field actually discovers things ("that sprinkler head
// is leaking" is found mid-job, not typed at the end of a form).
//
// ⭐ THE VISIBILITY BOUNDARY IS SAID OUT LOUD, not just enforced. The two boxes
// carry their audience in the label, because a worker deciding where to type
// "customer was rude about the gate" must be able to see the answer without
// knowing anything about the schema. Enforcement is at the source anyway:
// completion_issue is not in get_portal_data's payload at all.
//
// HONESTY. Save reports the write, and the confirmation never widens to cover
// evidence it didn't handle: photos upload on their own path with their own
// per-shot states, so when one has failed this sheet says the note saved AND
// that a photo is still outstanding, rather than a single cheerful "Saved".

import { useEffect, useState } from 'react'
import { Camera, CheckCircle2, Eye, Lock } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Textarea'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  COMPLETION_ISSUE_MAX, COMPLETION_SUMMARY_MAX,
  completionRecordChanged, normalizeCompletionRecord,
  type CompletionRecord, type CompletionSaveResult,
} from '@/lib/completion'

export interface CompletionSheetJob {
  id: string
  title: string
  status: string
  completed_at?: string | null
  actual_minutes?: number | null
  completion_summary?: string | null
  completion_issue?: string | null
}

interface Props {
  open: boolean
  onClose: () => void
  job: CompletionSheetJob
  /** The audience's own transport. Owner: a direct RLS-scoped table write.
   *  Crew: the typed DEFINER RPC. Either way it writes ONLY these two fields. */
  onSave: (record: CompletionRecord) => Promise<CompletionSaveResult>
  /** Called after a save that actually landed, so the caller can refetch. */
  onSaved?: (record: CompletionRecord) => void
  /** The caller's CANONICAL photo uploader — lib/photos for the owner,
   *  /api/crew/photos for a crew session. ⛔ This component never uploads
   *  anything itself; a parallel upload path is exactly what must not exist. */
  photos?: React.ReactNode
  /** How many photos the slot above still hasn't landed. Non-zero makes the
   *  confirmation say so instead of implying every piece of evidence saved. */
  photosOutstanding?: number
  /**
   * ⭐ Optional DURABLE draft, supplied by callers who run where the network
   * fails mid-sentence (the crew's phone; lib/field/drafts). Without it the
   * sheet behaves exactly as before — the words survive a failed save because
   * they stay in the boxes, but not a killed tab.
   *
   * ⛔ Deliberately callbacks rather than a storage key: this component must not
   * learn where drafts live, or the owner's copy of it grows a dependency on the
   * field layer for a feature it does not use.
   *
   * The contract: `save` on every keystroke, `load` when the sheet opens (an
   * unsent draft OUTRANKS the row — it is newer, and it is the only copy), and
   * `clear` only once the server has confirmed.
   */
  draftStore?: {
    load: () => { summary: string; issue: string } | null
    save: (record: CompletionRecord) => void
    clear: () => void
  }
}

export function CompletionSheet({
  open, onClose, job, onSave, onSaved, photos, photosOutstanding = 0, draftStore,
}: Props) {
  const [summary, setSummary] = useState('')
  const [issue, setIssue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The boxes were filled from an UNSENT draft rather than the saved row. The
   *  worker is told, and offered the other option — ⛔ "do not silently resend
   *  forever": Retry (Save) and Discard are both a tap away, and neither happens
   *  on its own. */
  const [restored, setRestored] = useState(false)

  // Seed from the ROW every time the sheet opens, never from the last time it
  // was open: reopening on a visit whose note the office edited meanwhile must
  // show theirs, and saving a stale copy would silently overwrite it.
  useEffect(() => {
    if (!open) return
    // ⭐ An unsent DRAFT wins over the row. The row is what the server last
    // accepted; the draft is what this worker typed afterwards and the network
    // never took. Seeding from the row would silently discard it — which is
    // precisely the "long note eaten by a dead zone" this exists to prevent.
    const draft = draftStore?.load() ?? null
    setSummary(draft ? draft.summary : (job.completion_summary || ''))
    setIssue(draft ? draft.issue : (job.completion_issue || ''))
    setError(null)
    setRestored(!!draft)
    // draftStore is a fresh object each render for most callers; depending on it
    // would re-seed the boxes on every keystroke and fight the typist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, job.id, job.completion_summary, job.completion_issue])

  // Persist as they type. Synchronous and tiny (lib/field/drafts uses
  // localStorage for exactly this reason), so there is no window between the
  // words existing and the words being safe.
  useEffect(() => {
    if (!open || !draftStore) return
    draftStore.save({ completion_summary: summary || null, completion_issue: issue || null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, summary, issue])

  const finished = job.status === 'completed'
  const next = normalizeCompletionRecord({ summary, issue })
  const dirty = completionRecordChanged(job, next)

  async function save() {
    if (saving) return
    setSaving(true)
    setError(null)
    const res = await onSave(next)
    setSaving(false)
    if (!res.ok) {
      // The words stay in the boxes. A failed save that also clears the form is
      // how a day's worth of field notes gets lost in a dead zone.
      setError(res.error || 'That didn’t save. Try again.')
      return
    }
    // ⛔ The draft dies ONLY here — after the transport has accepted the words,
    // never on a failure and never on a timer.
    draftStore?.clear()
    setRestored(false)
    onSaved?.(next)
    // Say what is true and no more. When a photo is still outstanding the
    // sentence names it — "Saved" alone would be a claim about evidence this
    // save never touched. And a note held on the PHONE is not a note the office
    // can read: `pending` gets its own sentence rather than borrowing "Saved".
    if (res.pending) {
      toast(
        photosOutstanding > 0
          ? `Notes saved on your phone — they’ll sync, and ${photosOutstanding} photo${photosOutstanding === 1 ? '' : 's'} still to upload.`
          : 'Notes saved on your phone — they’ll sync when you have signal.',
        { tone: 'info', duration: 6000 },
      )
    } else {
      toast.success(
        photosOutstanding > 0
          ? `Note saved — ${photosOutstanding} photo${photosOutstanding === 1 ? '' : 's'} still to upload.`
          : res.unchanged ? 'Nothing to change.' : 'Saved to this visit.',
      )
    }
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={finished ? 'Proof of work' : 'Notes for this visit'}
      icon={CheckCircle2}
      size="sm"
      onSubmit={dirty ? save : undefined}
      footer={
        <div className="flex items-center justify-end gap-2">
          {/* Closing is always free — nothing here is required for the visit to
              be complete, and the button must not imply otherwise. */}
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {dirty ? 'Cancel' : 'Close'}
          </Button>
          <Button onClick={save} loading={saving} disabled={!dirty}>Save</Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* The canonical completion, restated — never re-derived and never
            editable here. This sheet reads the stamp; lib/jobStatus writes it. */}
        {finished && job.completed_at && (
          <p className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden />
            Completed {new Date(job.completed_at).toLocaleString(undefined, {
              month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            })}
            {job.actual_minutes != null && job.actual_minutes > 0 && (
              <span className="text-ink-faint">· {job.actual_minutes} min</span>
            )}
          </p>
        )}

        <Field
          tone="customer"
          label="What was done"
          note="Your customer reads this in their portal"
          icon={Eye}
        >
          <Textarea
            value={summary}
            onChange={e => setSummary(e.target.value)}
            maxLength={COMPLETION_SUMMARY_MAX}
            rows={3}
            placeholder="Mowed, trimmed and edged. Blew off the walks and driveway."
          />
        </Field>

        {photos && (
          <div>
            <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted uppercase tracking-wide">
              <Camera className="w-3.5 h-3.5 shrink-0" aria-hidden /> Photos
            </p>
            <p className="mt-0.5 text-[11px] text-ink-faint">
              Your customer sees these on the visit.
            </p>
            {photos}
          </div>
        )}

        <Field
          tone="internal"
          label="Needs attention"
          note="Office only — never shown to the customer"
          icon={Lock}
        >
          <Textarea
            value={issue}
            onChange={e => setIssue(e.target.value)}
            maxLength={COMPLETION_ISSUE_MAX}
            rows={2}
            placeholder="Sprinkler head by the driveway is leaking. They asked about hedge trimming."
          />
        </Field>

        {/* ⭐ Unsent words, restored. The worker is TOLD where these came from —
            silently repopulating a box is how somebody re-saves a note they had
            already decided against. Both exits are here: Save retries, Discard
            throws it away. Nothing resends on its own. */}
        {restored && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 flex items-start justify-between gap-2" role="status">
            <p className="text-[11px] text-ink-muted">
              These notes never reached the office — restored from this phone.
            </p>
            <button
              type="button"
              onClick={() => {
                draftStore?.clear()
                setSummary(job.completion_summary || '')
                setIssue(job.completion_issue || '')
                setRestored(false)
              }}
              className="shrink-0 text-[11px] font-medium text-ink-muted underline underline-offset-2 hover:text-ink"
            >
              Discard
            </button>
          </div>
        )}
        {error && (
          <p className="text-xs text-red-400" role="alert">{error}</p>
        )}
      </div>
    </Modal>
  )
}

// The audience of a box is part of the box, not a caption someone might skip.
// Colour carries it too (accent = they see it, neutral+lock = they don't), so
// the distinction survives a glance in the sun.
function Field({ tone, label, note, icon: Icon, children }: {
  tone: 'customer' | 'internal'
  label: string
  note: string
  icon: typeof Eye
  children: React.ReactNode
}) {
  return (
    <div>
      <p className={cn(
        'flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide',
        tone === 'customer' ? 'text-accent-text' : 'text-ink-muted',
      )}>
        <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden /> {label}
      </p>
      <p className="mt-0.5 mb-1.5 text-[11px] text-ink-faint">{note}</p>
      {children}
    </div>
  )
}
