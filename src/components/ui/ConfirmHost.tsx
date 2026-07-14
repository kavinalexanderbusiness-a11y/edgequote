'use client'

import { useSyncExternalStore, useState, useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { subscribeConfirm, getConfirm, settleConfirm } from '@/lib/confirm'
import { toast } from '@/lib/toast'
import { Modal } from './Modal'
import { Button } from './Button'

// Renders the shared confirmation dialog from the confirm store. Mounted once in
// the dashboard layout. One look + behaviour for every confirm in the app:
// shared <Modal> (Escape / backdrop = cancel, focus, scroll-lock), destructive
// styling on the action, async-aware (spinner while onConfirm runs), and
// Enter = confirm (the keyboard mirror of Escape = cancel).
export function ConfirmHost() {
  const req = useSyncExternalStore(subscribeConfirm, getConfirm, getConfirm)
  const [busy, setBusy] = useState(false)

  // Enter confirms — unless focus is on a button (native Enter already clicks
  // it, and double-firing would confirm a focused Cancel).
  useEffect(() => {
    if (!req) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Enter' || busy) return
      if (document.activeElement instanceof HTMLButtonElement) return
      e.preventDefault()
      onConfirm()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, busy])

  if (!req) return null

  const { opts } = req
  const Icon = opts.icon ?? AlertTriangle

  function cancel() { if (!busy) settleConfirm(false) }

  async function onConfirm() {
    if (opts.onConfirm) {
      setBusy(true)
      try {
        await opts.onConfirm()
      } catch {
        setBusy(false)
        toast.error('Something went wrong. Please try again.')
        return // keep the dialog open so the user can retry or cancel
      }
      setBusy(false)
    }
    settleConfirm(true)
  }

  return (
    <Modal open onClose={cancel} title={opts.title} icon={Icon} size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={cancel} disabled={busy}>{opts.cancelLabel ?? 'Cancel'}</Button>
          <Button variant={opts.destructive ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {opts.confirmLabel ?? (opts.destructive ? 'Delete' : 'Confirm')}
          </Button>
        </>
      }>
      {opts.message && <div className="text-sm text-ink-muted">{opts.message}</div>}
    </Modal>
  )
}
