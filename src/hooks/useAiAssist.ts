'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssistPayload } from '@/lib/ai/assist'

// ── Client side of /api/ai/assist ─────────────────────────────────────────────
// One hook for every AI-assist surface: capability check (so surfaces render
// nothing when no key is configured), NDJSON stream consumption with live
// deltas, and abort-on-unmount. Same reader loop as the marketing composer.

// Capability is a deploy-time fact (env var), so check once per page load and
// share it across every mounted assist surface.
let capability: boolean | null = null
let capabilityPromise: Promise<boolean> | null = null
async function checkCapability(): Promise<boolean> {
  if (capability !== null) return capability
  if (!capabilityPromise) {
    capabilityPromise = fetch('/api/ai/assist')
      .then(r => r.json())
      .then(j => { capability = !!j?.aiEnabled; return capability })
      .catch(() => { capabilityPromise = null; return false })
  }
  return capabilityPromise
}

export function useAiAssist() {
  // null = unknown (checking); render nothing until we know.
  const [enabled, setEnabled] = useState<boolean | null>(capability)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let alive = true
    if (enabled === null) checkCapability().then(v => { if (alive) setEnabled(v) })
    return () => { alive = false; abortRef.current?.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = useCallback(async (
    payload: AssistPayload,
    handlers: { onDelta?: (text: string) => void; onDone?: (full: string) => void },
  ): Promise<string | null> => {
    setError(null)
    setRunning(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch('/api/ai/assist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const ct = res.headers.get('content-type') || ''
      if (!res.ok || !ct.includes('ndjson') || !res.body) {
        let msg = 'Could not generate that right now.'
        try { const j = await res.json(); if (j?.error) msg = j.error } catch { /* ignore */ }
        setError(msg)
        return null
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let full: string | null = null
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
          if (!line) continue
          let evt: { t: string; text?: string; error?: string }
          try { evt = JSON.parse(line) } catch { continue }
          if (evt.t === 'delta' && evt.text) handlers.onDelta?.(evt.text)
          else if (evt.t === 'done') { full = evt.text ?? ''; handlers.onDone?.(full) }
          else if (evt.t === 'error') setError(evt.error || 'Generation failed.')
        }
      }
      return full
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setError('Could not reach the AI service. Try again.')
      }
      return null
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }, [])

  const cancel = useCallback(() => abortRef.current?.abort(), [])

  return { enabled, running, error, run, cancel, clearError: () => setError(null) }
}
