import { CommsNav } from '@/components/messages/CommsNav'

// The Communications Center shell: one persistent rail above every messaging
// surface — Inbox (conversations), History (every templated/automated send),
// Scheduled (send-later queue), Templates (the owner's message library) — so all
// of messaging feels like one product. The Inbox page itself is unchanged; this
// layout only adds the spine.
export default function MessagesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <CommsNav />
      {children}
    </div>
  )
}
