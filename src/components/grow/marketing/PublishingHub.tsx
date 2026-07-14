'use client'

import { useState } from 'react'
import { Tabs } from '@/components/ui/Tabs'
import { Modal } from '@/components/ui/Modal'
import { ConnectionsManager } from './ConnectionsManager'
import { PublishingQueue } from './PublishingQueue'
import { Link2, ListChecks } from 'lucide-react'

// One modal for the whole publishing surface — Accounts (connect/disconnect) and the
// Queue (scheduled / publishing / published / failed with retry). Opened from the
// Calendar and the composer; no new top-level screen. Rendered through THE shared
// Modal (Escape, scroll-lock, aria-modal, one scrim).
export function PublishingHub({ userId, open, onClose, initialTab = 'accounts' }: {
  userId: string
  open: boolean
  onClose: () => void
  initialTab?: 'accounts' | 'queue'
}) {
  const [tab, setTab] = useState<'accounts' | 'queue'>(initialTab)
  return (
    <Modal open={open} onClose={onClose} title="Publishing" size="lg">
      <Tabs
        tabs={[{ key: 'accounts', label: 'Accounts', icon: Link2 }, { key: 'queue', label: 'Queue', icon: ListChecks }]}
        active={tab}
        onChange={k => setTab(k as 'accounts' | 'queue')}
      />
      <div className="pt-4">
        {tab === 'accounts' ? <ConnectionsManager userId={userId} /> : <PublishingQueue userId={userId} />}
      </div>
    </Modal>
  )
}
