'use client'

// ── Shared confirmation store ────────────────────────────────────────────────
// ONE confirmation experience for the whole app, replacing scattered native
// window.confirm() and per-feature confirm modals. A tiny external store (mirrors
// lib/toast) consumed by <ConfirmHost/> (mounted once in the dashboard layout),
// which renders the shared <Modal>. Call `await confirm({...})` from anywhere:
//
//   if (await confirm({ title: 'Delete invoice?', message: '…', destructive: true }))
//     remove()
//
// Or hand it the async work and let the dialog drive the loading state:
//
//   confirm({ title: 'Delete invoice?', destructive: true, onConfirm: () => del() })
//
// Resolves true when confirmed (and any onConfirm succeeded), false on cancel /
// Escape / backdrop.
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface ConfirmOptions {
  title: string
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  icon?: LucideIcon
  // Optional async work run while the confirm button shows a spinner. On success
  // the dialog closes and confirm() resolves true; on throw it stays open and the
  // error is surfaced (so the user can retry or cancel).
  onConfirm?: () => void | Promise<void>
}

export interface ConfirmRequest {
  id: number
  opts: ConfirmOptions
  resolve: (ok: boolean) => void
}

let current: ConfirmRequest | null = null
let seq = 0
const listeners = new Set<() => void>()
function emit() { for (const l of Array.from(listeners)) l() }

export function subscribeConfirm(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } }
export function getConfirm(): ConfirmRequest | null { return current }

// Resolve + clear the active request (used by the host on confirm/cancel).
export function settleConfirm(ok: boolean) {
  const r = current
  if (!r) return
  current = null
  emit()
  r.resolve(ok)
}

export function confirm(opts: ConfirmOptions): Promise<boolean> {
  // If a confirm is somehow already open, cancel it first (one at a time).
  if (current) settleConfirm(false)
  return new Promise<boolean>(resolve => {
    current = { id: ++seq, opts, resolve }
    emit()
  })
}

// Hook form for ergonomic use in components; returns the stable imperative fn.
export function useConfirm() { return confirm }
