'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssistPayload } from '@/lib/ai/assist'
import { readNdjson, isNdjson } from '@/lib/ai/stream'

// ── Client side of /api/ai/assist ─────────────────────────────────────────────
// One hook for every AI-assist surface: capability check (so surfaces render
// nothing when no key is configured), NDJSON stream consumption with live
// deltas, and abort-on-unmount or on demand.
//
// The reader loop used to be copy-pasted here from the marketing composer (the
// comment on this line used to say exactly that); both now read through the one
// transport in lib/ai/stream.

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
      if (!isNdjson(res)) {
        let msg = 'Could not generate that right now.'
        try { const j = await res.json(); if (j?.error) msg = j.error } catch { /* ignore */ }
        setError(msg)
        return null
      }
      let full: string | null = null
      await readNdjson(res, evt => {
        if (evt.t === 'delta' && evt.text) handlers.onDelta?.(evt.text)
        else if (evt.t === 'done') {
          // An empty completion is a FAILURE, not a result. Every surface blanks
          // its field before streaming and restores the owner's text only on
          // null — so returning '' here wipes what they wrote and reports
          // success ("Replaced your message."). Resolve null and say what
          // happened; one seam, because all five surfaces already handle null.
          const text = evt.text ?? ''
          if (text.trim()) { full = text; handlers.onDone?.(text) }
          else setError('The AI came back empty. Nothing was changed — try again.')
        }
        else if (evt.t === 'error') setError(evt.error || 'Generation failed.')
      })
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
