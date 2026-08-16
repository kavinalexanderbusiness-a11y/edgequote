'use client'

// The two quiet controls an EVENT item carries (derived items have neither —
// they resolve through their canonical door and disappear on their own).
//   Snooze  → notifications.snoozed_until = tomorrow 8am (the product's one
//             snooze vocabulary — same rule as the notifications page).
//   Dismiss → notifications.archived_at = now. Archiving IS the legitimate
//             state change for an event record: the fact stays on file, it just
//             stops asking. Never a delete.
// Source truth (the payment, the dispute) is untouched by both.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { Clock, X } from 'lucide-react'

// "Remind me later" → tomorrow at 8am local — the notifications page's rule.
function tomorrow8am(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  return d.toISOString()
}

export function EventItemActions({ notificationId }: { notificationId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState<'snooze' | 'dismiss' | null>(null)

  async function run(kind: 'snooze' | 'dismiss') {
    if (busy) return
    setBusy(kind)
    const supabase = createClient()
    const patch = kind === 'snooze'
      ? { snoozed_until: tomorrow8am() }
      : { archived_at: new Date().toISOString(), read: true, read_at: new Date().toISOString() }
    const { error } = await supabase.from('notifications').update(patch).eq('id', notificationId)
    setBusy(null)
    // The write is checked BEFORE the UI moves on — a failed snooze must not
    // look snoozed (the undo-contract rule: branch on the write's own error).
    if (error) {
      toast.error(kind === 'snooze'
        ? 'Couldn’t snooze this — please try again.'
        : 'Couldn’t dismiss this — please try again.')
      return
    }
    toast.success(kind === 'snooze' ? 'Snoozed until tomorrow morning.' : 'Dismissed.')
    router.refresh()
  }

  return (
    <span className="flex items-center gap-0.5 shrink-0" onClick={e => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => run('snooze')}
        disabled={busy != null}
        title="Snooze until tomorrow 8am"
        aria-label="Snooze until tomorrow 8am"
        className="tap-target p-2 rounded-lg text-ink-faint hover:text-ink hover:bg-surface-raised/60 disabled:opacity-50 transition-colors"
      >
        <Clock className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={() => run('dismiss')}
        disabled={busy != null}
        title="Dismiss"
        aria-label="Dismiss"
        className="tap-target p-2 rounded-lg text-ink-faint hover:text-ink hover:bg-surface-raised/60 disabled:opacity-50 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </span>
  )
}
