import { CrewInbox } from '@/components/crew/CrewInbox'

export const metadata = { title: 'Messages — EdgeQuote' }

// ── Messages ─────────────────────────────────────────────────────────────────
// Client-rendered on purpose, unlike Week: this list is the ONE crew surface
// whose whole job is to be current, and it shares the ref-counted inbox feed
// with the badge on the nav tab — one fetch, one refresh loop, two readers.
// Server-rendering it would produce a count that is stale the moment it paints
// and would still need the client feed underneath it.
export default function CrewMessagesPage() {
  return <CrewInbox />
}
