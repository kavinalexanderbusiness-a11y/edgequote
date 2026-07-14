'use client'

import { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Tabs } from '@/components/ui/Tabs'
import { ConnectionsManager } from './ConnectionsManager'
import { PublishingQueue } from './PublishingQueue'
import { Link2, ListChecks } from 'lucide-react'

// One modal for the whole publishing surface — Accounts (connect/disconnect) and the
// Queue (scheduled / publishing / published / failed with retry). Opened from the
// Calendar and the composer; no new top-level screen. Hosted in the shared Modal
// (Esc, backdrop, scroll-lock, aria-modal) instead of a hand-rolled overlay.
export function PublishingHub({ userId, open, onClose, initialTab = 'accounts' }: {
  userId: string
  open: boolean
  onClose: () => void
  initialTab?: 'accounts' | 'queue'
}) {
  const [tab, setTab] = useState<'accounts' | 'queue'>(initialTab)
  return (
    <Modal open={open} onClose={onClose} title="Publishing" className="max-w-lg">
      <div className="space-y-3">
        <Tabs
          tabs={[{ key: 'accounts', label: 'Accounts', icon: Link2 }, { key: 'queue', label: 'Queue', icon: ListChecks }]}
          active={tab}
          onChange={k => setTab(k as 'accounts' | 'queue')}
        />
        {tab === 'accounts' ? <ConnectionsManager userId={userId} /> : <PublishingQueue userId={userId} />}
      </div>
    </Modal>
  )
}
