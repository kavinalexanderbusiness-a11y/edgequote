'use client'

import { useState } from 'react'
import { Tabs } from '@/components/ui/Tabs'
import { ConnectionsManager } from './ConnectionsManager'
import { PublishingQueue } from './PublishingQueue'
import { X, Link2, ListChecks } from 'lucide-react'

// One modal for the whole publishing surface — Accounts (connect/disconnect) and the
// Queue (scheduled / publishing / published / failed with retry). Opened from the
// Calendar and the composer; no new top-level screen.
export function PublishingHub({ userId, open, onClose, initialTab = 'accounts' }: {
  userId: string
  open: boolean
  onClose: () => void
  initialTab?: 'accounts' | 'queue'
}) {
  const [tab, setTab] = useState<'accounts' | 'queue'>(initialTab)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 bg-black/50 backdrop-blur-sm overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-lg bg-bg-secondary rounded-card border border-border-strong shadow-xl mt-6 mb-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-sm font-bold text-ink">Publishing</p>
          <button onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-4 pt-3">
          <Tabs
            tabs={[{ key: 'accounts', label: 'Accounts', icon: Link2 }, { key: 'queue', label: 'Queue', icon: ListChecks }]}
            active={tab}
            onChange={k => setTab(k as 'accounts' | 'queue')}
          />
        </div>
        <div className="p-4 max-h-[68vh] overflow-y-auto">
          {tab === 'accounts' ? <ConnectionsManager userId={userId} /> : <PublishingQueue userId={userId} />}
        </div>
      </div>
    </div>
  )
}
