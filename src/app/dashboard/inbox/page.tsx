import { createClient } from '@/lib/supabase/server'
import { loadOwnerInbox } from '@/lib/inboxData'
import { InboxNeedsYou } from '@/components/inbox/InboxNeedsYou'
import { InboxUpdates } from '@/components/inbox/InboxUpdates'
import { PageHeader } from '@/components/layout/PageHeader'
import { PageContainer } from '@/components/layout/PageContainer'
import { Banner } from '@/components/ui/Banner'
import { AlertTriangle } from 'lucide-react'

// ── Inbox — what genuinely needs you, and what happened ──────────────────────
// THE front door for owner attention. NEEDS YOU is composed from the canonical
// engines (the Session-13 queue, draft change orders, unread crew words, days
// that can't run as booked, the bell's action-tier events) — almost all of it
// derived from current state, so items resolve THEMSELVES when the work is
// done. UPDATES is recent news through the one notification organizer. The two
// are never mixed into one unread number.
//
// SERVER-RENDERED, one parallel batch (lib/inboxData), no spinner. Unlike the
// dashboard's all-or-throw, this page DEGRADES per source: four readable
// sources are four answers the owner should still get, and the banner names
// exactly what couldn't be read. A failed read never renders as a clean slate —
// "all caught up" requires every source to have actually answered.
export default async function InboxPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { result } = await loadOwnerInbox(supabase, user!.id)

  const n = result.counts.needsYou
  return (
    <PageContainer>
      <PageHeader
        title="Inbox"
        description={n > 0
          ? `${n} thing${n !== 1 ? 's' : ''} need${n === 1 ? 's' : ''} you`
          : result.failures.length > 0
            ? 'Some sources couldn’t be checked'
            : 'Nothing needs you right now'}
      />

      {result.failures.length > 0 && (
        // Honest degradation: name the missing sources rather than quietly
        // showing fewer items. "Couldn't load 2 sources" beats a false zero.
        <Banner tone="warn" icon={AlertTriangle} className="mb-5">
          Couldn’t check {result.failures.join(', ')} — this list may be missing items from{' '}
          {result.failures.length === 1 ? 'that source' : 'those sources'}. Refresh to try again.
        </Banner>
      )}

      <div className="grid gap-6 lg:grid-cols-3 items-start">
        <div className="lg:col-span-2 min-w-0">
          <InboxNeedsYou
            items={result.needsYou}
            snoozedEvents={result.snoozedEvents}
            allClear={result.allClear}
          />
        </div>
        <div className="min-w-0">
          <InboxUpdates groups={result.updates} />
        </div>
      </div>
    </PageContainer>
  )
}
