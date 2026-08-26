'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { LogOut } from 'lucide-react'
import { count, clearAll as clearOutbox, flush } from '@/lib/offline/outbox'
import { clearCachedDays } from '@/lib/field/todayCache'
import { clearAllDrafts } from '@/lib/field/drafts'
import { toast } from '@/lib/toast'

// Work phones get shared and get lost. Signing out has to be one obvious tap,
// and it has to actually clear the session before we navigate — pushing first
// would race the cookie clear and land back on a still-authenticated /crew.
//
// ── What sign-out must take with it, and why ─────────────────────────────────
// ⭐ THE CACHED DAY AND THE DRAFTS. Both are readable-at-rest copies of one
// worker's work — customer names, addresses, access notes, unsent observations.
// A phone handed to the next shift must not still be holding them, and the
// device is exactly where we cannot rely on anything else to clean up.
//
// ⭐⭐ AND THE UNSENT QUEUE — but never silently, and never without asking.
// Two facts collide here:
//   · A queued write replays against WHOEVER IS SIGNED IN AT THE TIME. Leave one
//     op behind, let the next worker sign in on the same phone, and their
//     session performs the previous worker's write. The RPC re-checks the
//     assignment, so most of these fail — but two workers on the SAME crew are
//     assigned the same visits, so it would succeed and attribute one person's
//     day to another. That is not a cosmetic bug; it is the timesheet.
//   · Queued work is the worker's own unsent labour, and destroying it without
//     a word is the precise failure this session exists to prevent.
// So: try to drain it first, and if anything remains, SAY WHAT WILL BE LOST and
// make them choose. ⛔ Never a silent clear.
export function CrewSignOut() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(0)

  useEffect(() => { count().then(setPending).catch(() => {}) }, [])

  async function signOut() {
    setBusy(true)
    try {
      // One last attempt to land the work while the session is still valid — the
      // credentials these ops replay under are about to be revoked, so this is
      // the last moment they can possibly succeed.
      if (typeof navigator === 'undefined' || navigator.onLine !== false) {
        try {
          const { registerFieldHandlers } = await import('@/lib/field/handlers')
          registerFieldHandlers()
          await flush()
        } catch { /* fall through to the count below */ }
      }

      const left = await count()
      if (left > 0) {
        const ok = window.confirm(
          `${left} ${left === 1 ? 'change hasn’t' : 'changes haven’t'} reached the office yet, and signing out will discard ${left === 1 ? 'it' : 'them'}.\n\n` +
          'Get signal and wait for "Synced" if you want to keep it. Sign out anyway?',
        )
        if (!ok) { setBusy(false); return }
        await clearOutbox()
        toast(`Signed out — ${left} unsent ${left === 1 ? 'change was' : 'changes were'} discarded.`, { tone: 'warning', duration: 8000 })
      }

      // Order matters: clear the local copies BEFORE the session goes, so a
      // failure here still happens while we know who we are clearing for.
      await clearCachedDays()
      clearAllDrafts()

      // Scope named, not inherited — identical behaviour to the bare call it replaces.
      // See Sidebar.handleSignOut: the choice itself is an open product question.
      await createClient().auth.signOut({ scope: 'global' })
      router.replace('/login')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      {/* Said BEFORE the tap, not after — a warning that only appears in the
          confirm dialog arrives too late to do anything about. */}
      {pending > 0 && (
        <p className="text-[11px] text-amber-300" role="status">
          {pending} {pending === 1 ? 'change is' : 'changes are'} still waiting to sync. Signing out now discards {pending === 1 ? 'it' : 'them'}.
        </p>
      )}
      <Button
        variant="secondary"
        className="w-full tap-target h-12"
        loading={busy}
        onClick={signOut}
      >
        <LogOut className="w-4 h-4" aria-hidden /> Sign out
      </Button>
    </div>
  )
}
