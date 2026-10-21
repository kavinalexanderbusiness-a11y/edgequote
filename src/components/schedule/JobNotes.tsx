import { StickyNote } from 'lucide-react'

/** Read-only crew instructions. Keep every line visible: access and scope
 * details can be at the end of a note, and a title tooltip is not a phone UI.
 * Text scales with the user's font size; fixed padding preserves reading width. */
export function JobNotes({ notes }: { notes?: string | null }) {
  if (!notes?.trim()) return null

  return (
    <div data-job-notes className="min-w-0 rounded-lg border border-border-strong bg-bg-secondary p-[12px]">
      <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
        <StickyNote aria-hidden="true" className="h-4 w-4 shrink-0 text-accent-text" />
        Crew notes
      </p>
      <p className="max-w-prose whitespace-pre-wrap [overflow-wrap:anywhere] text-base leading-relaxed text-ink">
        {notes}
      </p>
    </div>
  )
}
