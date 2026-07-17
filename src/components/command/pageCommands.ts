'use client'

import { useEffect } from 'react'
import type { LucideIcon } from 'lucide-react'

// ── Page commands ────────────────────────────────────────────────────────────
// The ONE command palette (Cmd/Ctrl+K) stays the only palette in the app —
// pages that have verbs of their own register them here and the palette grows
// a "This page" section while that page is mounted. No second palette, no
// second keybinding, no drift in look or behaviour.
//
// Register with usePageCommands(commands) — commands unregister on unmount.
// `keywords` extend query matching beyond the label.

export interface PageCommand {
  id: string
  label: string
  sub?: string
  icon: LucideIcon
  keywords?: string
  run: () => void
}

let current: PageCommand[] = []
const listeners = new Set<() => void>()

export function getPageCommands(): PageCommand[] {
  return current
}

export function subscribePageCommands(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function set(commands: PageCommand[]) {
  current = commands
  listeners.forEach(fn => fn())
}

export function usePageCommands(commands: PageCommand[]) {
  useEffect(() => {
    set(commands)
    return () => { if (current === commands) set([]) }
  }, [commands])
}
